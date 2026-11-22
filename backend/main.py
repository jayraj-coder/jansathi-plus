from __future__ import annotations

import os
import re
import shutil
import shlex
import subprocess
import uuid
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pymongo import MongoClient, DESCENDING
from pymongo.errors import PyMongoError

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
STORAGE = Path(os.getenv("STORAGE_PATH", ROOT / "data" / "uploads"))
STORAGE.mkdir(parents=True, exist_ok=True)
MAX_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))
ALLOWED = {".pdf", ".txt", ".docx", ".png", ".jpg", ".jpeg"}
MIME = {".pdf": "application/pdf", ".txt": "text/plain", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
OCR_LANGS = [language.strip() for language in os.getenv("TESSERACT_LANGS", "eng+hin+guj").split("+") if language.strip()]
TESSDATA_DIR = Path(os.getenv("TESSDATA_DIR", ROOT / "data" / "tessdata"))
if not TESSDATA_DIR.is_absolute():
    TESSDATA_DIR = ROOT / TESSDATA_DIR
logger = logging.getLogger(__name__)
_OCR_TESSDATA_DIR: Path | None = None
SYSTEM_TESSDATA_DIRS = (
    Path("/usr/share/tesseract-ocr/5/tessdata"),
    Path("/usr/share/tesseract-ocr/4.00/tessdata"),
    Path("/usr/share/tesseract-ocr/tessdata"),
    Path("/usr/share/tessdata"),
)

app = FastAPI(title="JanSathi API", version="1.0.0", description="Private document understanding and citizen information API")
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000").split(","), allow_credentials=False, allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["*"])

client = None
documents = None
profiles = None
db_status = "not_configured"
try:
    uri = os.getenv("MONGODB_URI", "")
    if uri:
        client = MongoClient(uri, serverSelectionTimeoutMS=2500, connectTimeoutMS=2500)
        client.admin.command("ping")
        database = client[os.getenv("MONGODB_DATABASE", "jansathi")]
        documents = database.documents
        profiles = database.profiles
        documents.create_index([("created_at", DESCENDING)])
        documents.create_index([("owner_id", 1), ("created_at", DESCENDING)])
        profiles.create_index("owner_id", unique=True)
        db_status = "connected"
except Exception as exc:
    db_status = f"unavailable: {type(exc).__name__}"

# A process-local fallback keeps development usable when Atlas is unreachable.
memory_docs: dict[str, dict[str, Any]] = {}
memory_profiles: dict[str, dict[str, Any]] = {}

def serial(doc: dict[str, Any]) -> dict[str, Any]:
    doc = dict(doc)
    doc.pop("_id", None)
    return doc

def public_document(doc: dict[str, Any], include_text: bool = False) -> dict[str, Any]:
    hidden = {"_id", "owner_id", "path"}
    if not include_text:
        hidden.add("text")
    return {key: value for key, value in doc.items() if key not in hidden}

def save_doc(doc: dict[str, Any]) -> None:
    if documents is not None:
        documents.insert_one(dict(doc))
    else:
        memory_docs[doc["id"]] = doc

def get_doc(doc_id: str, owner_id: str) -> dict[str, Any] | None:
    if documents is not None:
        try:
            found = documents.find_one({"id": doc_id, "owner_id": owner_id})
        except PyMongoError as exc:
            raise HTTPException(503, "Document storage is currently unavailable.") from exc
        return serial(found) if found else None
    found = memory_docs.get(doc_id)
    return found if found and found.get("owner_id") == owner_id else None

def list_docs(owner_id: str) -> list[dict[str, Any]]:
    if documents is not None:
        try:
            return [serial(d) for d in documents.find({"owner_id": owner_id}).sort("created_at", DESCENDING).limit(500)]
        except PyMongoError as exc:
            raise HTTPException(503, "Document storage is currently unavailable.") from exc
    return sorted((d for d in memory_docs.values() if d.get("owner_id") == owner_id), key=lambda d: d["created_at"], reverse=True)

def delete_doc(doc_id: str, owner_id: str) -> bool:
    if documents is not None:
        try:
            return documents.delete_one({"id": doc_id, "owner_id": owner_id}).deleted_count > 0
        except Exception:
            return False
    found = memory_docs.get(doc_id)
    return memory_docs.pop(doc_id, None) is not None if found and found.get("owner_id") == owner_id else False

def owner(request: Request) -> str:
    value = request.headers.get("x-guest-id", "")
    if not re.fullmatch(r"[a-f0-9-]{36}", value):
        raise HTTPException(401, "Guest session is missing or invalid. Refresh the page to start a session.")
    return value

def extract_text(path: Path, suffix: str) -> tuple[str, str]:
    if suffix == ".txt":
        return path.read_text(encoding="utf-8", errors="replace"), "text"
    if suffix == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        content = "\n".join(page.extract_text() or "" for page in reader.pages)
        if content.strip():
            return content, "pdf_text"
        return extract_scanned_pdf(path)
    if suffix == ".docx":
        from docx import Document
        doc = Document(str(path))
        return "\n".join(p.text for p in doc.paragraphs), "docx_text"
    return extract_image_ocr(path)

def _tessdata_candidates(executable: str | None = None) -> list[Path]:
    explicit: list[Path] = []

    configured = os.getenv("TESSDATA_DIR", "").strip()
    if configured:
        configured_path = Path(configured)
        explicit.append(configured_path if configured_path.is_absolute() else ROOT / configured_path)

    # Tesseract builds vary in whether TESSDATA_PREFIX denotes the data folder itself
    # or its parent, so accept either form when it contains one of our requested models.
    prefix = os.getenv("TESSDATA_PREFIX", "").strip()
    if prefix:
        prefix_path = Path(prefix)
        explicit.extend((prefix_path, prefix_path / "tessdata"))

    candidates = explicit + [TESSDATA_DIR]

    if executable:
        executable_path = Path(executable)
        candidates.append(executable_path.parent / "tessdata")

    program_files = os.getenv("ProgramFiles", r"C:\Program Files")
    candidates.append(Path(program_files) / "Tesseract-OCR" / "tessdata")
    candidates.extend(SYSTEM_TESSDATA_DIRS)

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = os.path.normcase(str(candidate))
        if key not in seen:
            seen.add(key)
            unique.append(candidate)

    def available_count(path: Path) -> int:
        return sum((path / f"{language}.traineddata").is_file() for language in OCR_LANGS)

    # Valid explicit configuration always wins. Prefer a complete local model set next;
    # among system directories, prefer the one with the most requested languages.
    valid = [path for path in unique if path.is_dir() and available_count(path)]
    explicit_valid = [path for path in valid if path in explicit]
    local = TESSDATA_DIR if TESSDATA_DIR in valid else None
    remainder = [path for path in valid if path not in explicit_valid and path != local]
    remainder.sort(key=available_count, reverse=True)
    ordered = explicit_valid
    if local is not None and available_count(local) == len(OCR_LANGS):
        ordered.append(local)
    ordered.extend(path for path in remainder if path not in ordered)
    if local is not None and local not in ordered:
        ordered.append(local)
    return ordered


def _tesseract_candidates() -> list[str]:
    candidates = [
        os.getenv("TESSERACT_CMD", "").strip(),
        str(ROOT / "tools" / "tesseract" / "tesseract.exe"),
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        shutil.which("tesseract") or "",
    ]
    resolved: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate:
            continue
        found = shutil.which(candidate) or (candidate if Path(candidate).is_file() else "")
        key = os.path.normcase(found)
        if found and key not in seen:
            seen.add(key)
            resolved.append(found)
    return resolved


def _tessdata_config() -> str:
    if _OCR_TESSDATA_DIR is None:
        return ""
    return "--tessdata-dir " + shlex.quote(_OCR_TESSDATA_DIR.as_posix())


def _probe_default_tessdata(executable: str) -> Path | None:
    """Ask Tesseract for its compiled-in data path without inheriting a bad override."""
    child_env = os.environ.copy()
    child_env.pop("TESSDATA_PREFIX", None)
    prefix = os.getenv("TESSDATA_PREFIX", "").strip()
    if prefix:
        logger.warning(
            "TESSDATA_PREFIX did not resolve to requested language files; testing Tesseract's default path without changing the process environment."
        )
    try:
        result = subprocess.run(
            [executable, "--list-langs"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
            env=child_env,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("Default Tesseract language-data discovery failed (%s).", type(exc).__name__)
        return None

    match = re.search(r'List of available languages in ["\']?(.+?)["\']? \(\d+\):', result.stdout)
    if not match:
        logger.warning("Tesseract did not report its default language-data directory.")
        return None
    directory = Path(match.group(1).strip().strip("\"'"))
    if directory.is_dir() and any((directory / f"{language}.traineddata").is_file() for language in OCR_LANGS):
        return directory
    logger.warning("Tesseract's default data directory has no requested language models.")
    return None


def configure_tesseract():
    global _OCR_TESSDATA_DIR
    try:
        import pytesseract
    except ImportError as exc:
        logger.warning("OCR unavailable: pytesseract could not be imported (%s).", type(exc).__name__)
        return None

    for candidate in _tesseract_candidates():
        try:
            result = subprocess.run(
                [candidate, "--version"], capture_output=True, text=True, timeout=5, check=True
            )
        except (OSError, subprocess.SubprocessError) as exc:
            logger.warning("Tesseract candidate failed its version check (%s).", type(exc).__name__)
            continue
        pytesseract.pytesseract.tesseract_cmd = candidate
        break
    else:
        _OCR_TESSDATA_DIR = None
        logger.warning("OCR unavailable: no runnable Tesseract executable was found.")
        return None

    data_dirs = _tessdata_candidates(candidate)
    _OCR_TESSDATA_DIR = data_dirs[0] if data_dirs else _probe_default_tessdata(candidate)
    logger.info(
        "Tesseract ready (%s); language data directory: %s.",
        (result.stdout or result.stderr).splitlines()[0] if (result.stdout or result.stderr) else "version unknown",
        str(_OCR_TESSDATA_DIR) if _OCR_TESSDATA_DIR else "Tesseract default search path",
    )
    return pytesseract

# OCR accuracy tuning knobs. Document upload is not on the hot request path, so
# spending a few extra tesseract passes to pick the best result is acceptable.
UPSCALE_SMALL_IMAGE = True
UPSCALE_SCALE = 2
MIN_LONG_SIDE_FOR_UPSCALE = 1200
CONFIDENCE_FLOOR = 45.0
PSM_MODES = (6, 11, 12)  # 6: uniform block, 11: sparse text, 12: sparse text + OSD


def _levenshtein_distance(a: str, b: str) -> int:
    """Levenshtein edit distance (unit cost) for CER/WER measurement."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            current[j] = min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + cost,
            )
        previous = current
    return previous[-1]


def cer(reference: str, hypothesis: str) -> float:
    """Character Error Rate = edit distance / reference character count."""
    reference = reference or ""
    hypothesis = hypothesis or ""
    if not reference:
        return 0.0 if not hypothesis else 1.0
    return _levenshtein_distance(reference, hypothesis) / len(reference)


def wer(reference: str, hypothesis: str) -> float:
    """Word Error Rate = edit distance on word tokens / reference word count."""
    ref_words = (reference or "").split()
    hyp_words = (hypothesis or "").split()
    if not ref_words:
        return 0.0 if not hyp_words else 1.0
    return _levenshtein_distance(ref_words, hyp_words) / len(ref_words)


def _mean_confidence(data: dict) -> float:
    confs = [c for c in data.get("conf", []) if isinstance(c, (int, float)) and c >= 0]
    if not confs:
        return 0.0
    return sum(confs) / len(confs)


def _otsu_threshold(image: Image.Image) -> Image.Image:
    """Binarize using Otsu's method; separates text from complex backgrounds."""
    arr = np.array(image.convert("L"), dtype=np.uint8)
    hist, _ = np.histogram(arr, bins=256, range=(0, 256))
    total = int(arr.size)
    sum_total = int(np.dot(np.arange(256, dtype=np.int64), hist))
    sum_b = 0
    w_b = 0
    best_t = 0
    max_var = -1.0
    for t in range(256):
        w_b += int(hist[t])
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * int(hist[t])
        m_b = sum_b / w_b
        m_f = (sum_total - sum_b) / w_f
        var_between = float(w_b) * float(w_f) * float((m_b - m_f) ** 2)
        if var_between > max_var:
            max_var = var_between
            best_t = t
    binary = ((arr > best_t).astype(np.uint8)) * 255
    return Image.fromarray(binary, mode="L")


def _adaptive_threshold(image: Image.Image, block_size: int = 15, offset: float = 10.0) -> Image.Image:
    """Binarize using a local-mean approximation (BoxBlur) as adaptive threshold."""
    gray = image.convert("L")
    local_mean = np.array(gray.filter(ImageFilter.BoxBlur(block_size // 2)), dtype=np.float32)
    arr = np.array(gray, dtype=np.float32)
    binary = ((arr < (local_mean - offset)).astype(np.uint8)) * 255
    return Image.fromarray(binary, mode="L")


def _pil_variants(image: Image.Image):
    """Return (name, PIL image) preprocessing variants.

    The original image is preserved unchanged. Each variant targets a different
    failure mode: low resolution, low contrast, or text over a complex background.
    """
    variants = [("original", image.copy())]

    try:
        grayscale = image.convert("L")
    except Exception:
        grayscale = image

    w, h = grayscale.size
    if UPSCALE_SMALL_IMAGE and max(w, h) < MIN_LONG_SIDE_FOR_UPSCALE:
        base = grayscale.resize((w * UPSCALE_SCALE, h * UPSCALE_SCALE), Image.LANCZOS)
    else:
        base = grayscale

    try:
        contrasted = ImageEnhance.Contrast(base).enhance(2.0)
    except Exception:
        contrasted = base

    try:
        denoised = contrasted.filter(ImageFilter.MedianFilter(size=3))
    except Exception:
        denoised = contrasted

    variants.append(("enhanced_grayscale", denoised))

    try:
        variants.append(("otsu", _otsu_threshold(denoised)))
    except Exception:
        pass
    try:
        variants.append(("adaptive", _adaptive_threshold(denoised)))
    except Exception:
        pass

    return variants


def _psm_config(base_config: str, psm: int) -> str:
    return base_config + f" --psm {psm}"


def _run_ocr(pytesseract, image: Image.Image, config: str):
    """Run one OCR pass; return (text, mean_confidence)."""
    text = pytesseract.image_to_string(image, config=config)
    try:
        data = pytesseract.image_to_data(
            image, config=config, output_type=pytesseract.Output.DICT
        )
        confidence = _mean_confidence(data)
    except Exception:
        confidence = 0.0
    return text, confidence


def _normalize_ocr_text(text: str) -> str:
    """Safely normalize OCR output without correcting or guessing words."""
    if not text:
        return ""
    text = text.replace("\f", "\n").replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t\u00a0]+", " ", line).strip() for line in text.split("\n")]
    cleaned = "\n".join(lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def ocr_language_config(pytesseract) -> str:
    try:
        available = set(pytesseract.get_languages(config=_tessdata_config()))
    except Exception as exc:
        logger.warning("Tesseract language discovery failed (%s).", type(exc).__name__)
        return ""
    languages = [lang for lang in OCR_LANGS if lang in available]
    if not languages:
        return ""
    data_config = _tessdata_config()
    return "-l " + "+".join(languages) + (" " + data_config if data_config else "")


def extract_image_ocr(path: Path) -> tuple[str, str]:
    pytesseract = configure_tesseract()
    if not pytesseract:
        return "", "ocr_unavailable"
    base_config = ocr_language_config(pytesseract)
    if not base_config:
        return "", "ocr_unavailable"
    try:
        with Image.open(path) as image:
            image = image.convert("RGB")
            best_text = ""
            best_confidence = -1.0
            variants = _pil_variants(image)

            # Primary pass: uniform block mode (PSM 6) across all variants.
            for _name, variant in variants:
                try:
                    text, confidence = _run_ocr(
                        pytesseract, variant, _psm_config(base_config, 6)
                    )
                    if confidence > best_confidence or (
                        confidence == best_confidence and len(text) > len(best_text)
                    ):
                        best_text = text
                        best_confidence = confidence
                except Exception:
                    continue

            # If confidence is weak, evaluate sparse-text modes (PSM 11/12).
            if best_confidence < CONFIDENCE_FLOOR and variants:
                _, fallback_variant = variants[0]
                for psm in PSM_MODES:
                    if psm == 6:
                        continue
                    try:
                        text, confidence = _run_ocr(
                            pytesseract, fallback_variant, _psm_config(base_config, psm)
                        )
                        if confidence > best_confidence or (
                            confidence == best_confidence and len(text) > len(best_text)
                        ):
                            best_text = text
                            best_confidence = confidence
                    except Exception:
                        continue

            return _normalize_ocr_text(best_text), "ocr"
    except Exception as exc:
        logger.warning("Image OCR failed (%s).", type(exc).__name__)
        return "", "ocr_unavailable"


def extract_scanned_pdf(path: Path) -> tuple[str, str]:
    pytesseract = configure_tesseract()
    if not pytesseract:
        return "", "ocr_unavailable"
    base_config = ocr_language_config(pytesseract)
    if not base_config:
        return "", "ocr_unavailable"
    try:
        import pypdfium2 as pdfium
        pages = []
        with pdfium.PdfDocument(str(path)) as pdf:
            for index in range(min(len(pdf), 20)):
                page = pdf[index]
                bitmap = page.render(scale=2)
                try:
                    with bitmap.to_pil() as image:
                        image = image.convert("RGB")
                        best_text = ""
                        best_confidence = -1.0
                        for _name, variant in _pil_variants(image):
                            try:
                                text, confidence = _run_ocr(
                                    pytesseract, variant, _psm_config(base_config, 6)
                                )
                                if confidence > best_confidence or (
                                    confidence == best_confidence and len(text) > len(best_text)
                                ):
                                    best_text = text
                                    best_confidence = confidence
                            except Exception:
                                continue
                        pages.append(_normalize_ocr_text(best_text))
                finally:
                    bitmap.close()
                    page.close()
        return "\n".join(pages), "pdf_ocr"
    except Exception as exc:
        logger.warning("Scanned PDF OCR failed (%s).", type(exc).__name__)
        return "", "ocr_unavailable"


def get_ocr_languages() -> list[str]:
    pytesseract = configure_tesseract()
    if not pytesseract:
        return []
    try:
        available = set(pytesseract.get_languages(config=_tessdata_config()))
        languages = [lang for lang in OCR_LANGS if lang in available]
        logger.info("Available OCR languages: %s.", ", ".join(languages) if languages else "none")
        return languages
    except Exception as exc:
        logger.warning("Tesseract language detection failed (%s).", type(exc).__name__)
        return []


def validate_signature(path: Path, suffix: str) -> bool:
    with path.open("rb") as stream:
        header = stream.read(8)
    signatures = {".pdf": header.startswith(b"%PDF-"), ".png": header.startswith(b"\x89PNG\r\n\x1a\n"), ".jpg": header.startswith(b"\xff\xd8\xff"), ".jpeg": header.startswith(b"\xff\xd8\xff"), ".docx": header.startswith(b"PK\x03\x04")}
    return signatures.get(suffix, True)

def simple_summary(text: str) -> str:
    clean = re.sub(r"\s+", " ", text).strip()
    if not clean:
        return "Text extraction returned no readable content. This may be a scanned document; OCR is not configured on this server."
    snippets = re.split(r"(?<=[.!?।])\s+", clean)
    return " ".join(snippets[:3])[:950]

@app.get("/api/health")
def health():
    ocr_languages = get_ocr_languages()
    return {"status": "ok", "database": db_status, "ai_primary": os.getenv("AI_PRIMARY_PROVIDER", "groq"), "ai_configured": bool(os.getenv("GROQ_API_KEY") or os.getenv("GEMINI_API_KEY")), "ocr_configured": bool(ocr_languages), "ocr_languages": ocr_languages, "max_upload_bytes": MAX_BYTES}

class ProfileUpdate(BaseModel):
    first_name: str = Field(default="", max_length=60)
    last_name: str = Field(default="", max_length=60)
    language: str = Field(default="en", pattern="^(en|hi|gu)$")
    theme: str = Field(default="dark", pattern="^(dark|light)$")

@app.get("/api/profile")
def profile_get(request: Request):
    guest_id = owner(request)
    if profiles is not None:
        try:
            found = profiles.find_one({"owner_id": guest_id}, {"_id": 0, "owner_id": 0})
        except PyMongoError as exc:
            raise HTTPException(503, "Profile storage is currently unavailable.") from exc
    else:
        found = memory_profiles.get(guest_id)
    return {"first_name": "", "last_name": "", "email": None, "language": "en", "theme": "dark", "has_profile": bool(found), **(found or {})}

@app.put("/api/profile")
def profile_update(body: ProfileUpdate, request: Request):
    guest_id = owner(request)
    values = body.model_dump()
    values["first_name"] = values["first_name"].strip()
    values["last_name"] = values["last_name"].strip()
    if profiles is not None:
        try:
            profiles.update_one({"owner_id": guest_id}, {"$set": {**values, "owner_id": guest_id, "updated_at": datetime.now(timezone.utc).isoformat()}}, upsert=True)
        except PyMongoError as exc:
            raise HTTPException(503, "Profile could not be saved. Please try again.") from exc
    else:
        memory_profiles[guest_id] = values
    return {"first_name": values["first_name"], "last_name": values["last_name"], "email": None, "language": values["language"], "theme": values["theme"], "has_profile": True}

@app.post("/api/documents")
async def upload_document(request: Request, file: UploadFile = File(...)):
    owner_id = owner(request)
    name = Path(file.filename or "document").name
    suffix = Path(name).suffix.lower()
    if suffix not in ALLOWED:
        raise HTTPException(415, "Supported formats: PDF, TXT, DOCX, PNG, JPG, JPEG.")
    doc_id = uuid.uuid4().hex
    safe_name = re.sub(r"[^\w. -]", "_", name).strip(" .") or "document"
    target = STORAGE / f"{doc_id}{suffix}"
    size = 0
    try:
        with target.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise HTTPException(413, f"File exceeds the {MAX_BYTES / (1024 * 1024):g} MB upload limit.")
                out.write(chunk)
        if not validate_signature(target, suffix):
            raise HTTPException(415, "The file content does not match its extension.")
        text, extraction = extract_text(target, suffix)
        text = text[:500_000]
        status = "completed" if text.strip() else "needs_ocr" if extraction in {"pdf_text", "ocr_unavailable", "ocr", "pdf_ocr"} else "no_text"
        record = {"id": doc_id, "owner_id": owner_id, "title": safe_name, "filename": safe_name, "file_type": suffix[1:].upper(), "mime_type": MIME[suffix], "size": size, "created_at": datetime.now(timezone.utc).isoformat(), "status": status, "language": "und", "extraction": extraction, "text": text, "overview": simple_summary(text), "path": str(target)}
        save_doc(record)
        return public_document(record)
    except HTTPException:
        target.unlink(missing_ok=True)
        raise
    except PyMongoError as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(503, "Document storage is currently unavailable.") from exc
    except Exception as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(422, f"Document processing failed: {type(exc).__name__}.") from exc

@app.get("/api/documents")
def documents_list(request: Request, q: str = "", kind: str = ""):
    items = list_docs(owner(request))
    if q:
        items = [d for d in items if q.casefold() in d.get("title", "").casefold()]
    if kind == "pdf":
        items = [d for d in items if d.get("file_type") == "PDF"]
    return [public_document(d) for d in items]

@app.get("/api/documents/{doc_id}")
def document_detail(doc_id: str, request: Request):
    doc = get_doc(doc_id, owner(request))
    if not doc:
        raise HTTPException(404, "Document not found.")
    return public_document(doc, include_text=True)

@app.get("/api/documents/{doc_id}/file")
def document_file(doc_id: str, request: Request):
    doc = get_doc(doc_id, owner(request))
    if not doc or not Path(doc.get("path", "")).is_file():
        raise HTTPException(404, "Document file is unavailable.")
    return FileResponse(doc["path"], media_type=doc["mime_type"], filename=doc["filename"])

@app.delete("/api/documents/{doc_id}")
def document_delete(doc_id: str, request: Request):
    owner_id = owner(request)
    doc = get_doc(doc_id, owner_id)
    if not doc:
        raise HTTPException(404, "Document not found.")
    try:
        if not delete_doc(doc_id, owner_id):
            raise HTTPException(503, "Document could not be deleted. Please try again.")
    except PyMongoError as exc:
        raise HTTPException(503, "Document could not be deleted. Please try again.") from exc
    Path(doc.get("path", "")).unlink(missing_ok=True)
    return {"deleted": True}

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=10_000)
    document_id: str | None = Field(default=None, max_length=64)
    language: str = Field(default="en", pattern="^(en|hi|gu)$")

@app.post("/api/chat")
async def chat(body: ChatRequest, request: Request):
    if not body.message.strip():
        raise HTTPException(400, "Enter a question first.")
    context = ""
    if body.document_id:
        doc = get_doc(body.document_id, owner(request))
        if not doc:
            raise HTTPException(404, "Selected document was not found.")
        context = doc.get("text", "")[:22000]
    provider = os.getenv("AI_PRIMARY_PROVIDER", "groq").lower()
    providers = [provider, os.getenv("AI_FALLBACK_PROVIDER", "gemini").lower()]
    for current in dict.fromkeys(providers):
        try:
            answer = await call_ai(current, body.message, context, body.language)
            return {"answer": answer, "provider": current, "sources": ["Uploaded document"] if context else []}
        except Exception:
            continue
    raise HTTPException(503, "AI services are unavailable. Check server API keys and provider status.")

async def call_ai(provider: str, question: str, context: str, language: str) -> str:
    if provider == "groq":
        key = os.getenv("GROQ_API_KEY")
        if not key: raise RuntimeError("Groq key missing")
        model = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
        url = "https://api.groq.com/openai/v1/chat/completions"
        headers = {"Authorization": f"Bearer {key}"}
        payload = {"model": model, "temperature": 0.2, "messages": [{"role": "system", "content": system_prompt(language, context)}, {"role": "user", "content": question}]}
    elif provider == "gemini":
        key = os.getenv("GEMINI_API_KEY")
        if not key: raise RuntimeError("Gemini key missing")
        model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
        headers = {}
        payload = {"system_instruction": {"parts": [{"text": system_prompt(language, context)}]}, "contents": [{"role": "user", "parts": [{"text": question}]}]}
    else: raise RuntimeError("Unknown provider")
    async with httpx.AsyncClient(timeout=45) as client_http:
        response = await client_http.post(url, headers=headers, json=payload)
        response.raise_for_status()
        result = response.json()
    if provider == "groq": return result["choices"][0]["message"]["content"]
    return result["candidates"][0]["content"]["parts"][0]["text"]

def system_prompt(language: str, context: str) -> str:
    lang = {"hi": "Hindi", "gu": "Gujarati", "en": "English"}.get(language, "English")
    doc = f"\nUse this document as the source. Clearly say when it does not contain the answer. Do not invent citations.\nDOCUMENT:\n{context}" if context else "\nFor public information, avoid inventing rules, deadlines, eligibility, or citations. Say when current official confirmation is needed."
    return f"You are JanSathi, a careful public information assistant. Answer in {lang}, simply and accurately. Distinguish facts from uncertainty.{doc}"

app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
