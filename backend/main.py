from __future__ import annotations

import os
import re
import shutil
import shlex
import subprocess
import uuid
import logging
import contextvars
from contextlib import contextmanager
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

import asyncio
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile, Request, Response
from starlette.concurrency import run_in_threadpool
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
_OCR_UPLOAD_ID = contextvars.ContextVar("ocr_upload_id", default="unknown")
_OCR_DEADLINE = contextvars.ContextVar("ocr_deadline", default=None)
_OCR_TIMINGS = contextvars.ContextVar("ocr_timings", default=None)
_TESSERACT_LOCK = threading.Lock()
_OCR_LANGUAGE_LOCK = threading.Lock()
_TESSERACT_CACHE = None
_OCR_LANGUAGE_CACHE: dict[str, list[str]] = {}
OCR_SUBPROCESS_TIMEOUT = float(os.getenv("OCR_SUBPROCESS_TIMEOUT", "25"))
OCR_DOCUMENT_TIMEOUT = float(os.getenv("OCR_DOCUMENT_TIMEOUT", "90"))
OCR_MAX_CONCURRENT = max(1, int(os.getenv("OCR_MAX_CONCURRENT", "1")))
OCR_QUEUE_TIMEOUT = float(os.getenv("OCR_QUEUE_TIMEOUT", "10"))
_OCR_SEMAPHORE = threading.BoundedSemaphore(OCR_MAX_CONCURRENT)
_DOCUMENT_EXECUTOR = ThreadPoolExecutor(
    max_workers=max(4, min(8, OCR_MAX_CONCURRENT + 2)),
    thread_name_prefix="document-extract",
)
# Tesseract can start several OpenMP workers per invocation.  The upload
# semaphore already controls process concurrency, so make the per-process CPU
# budget deterministic even if the host image exports a larger value.
os.environ["OMP_THREAD_LIMIT"] = "1"


def _ocr_log(stage: str, duration: float | None = None, level: int = logging.INFO, **fields):
    timings = _OCR_TIMINGS.get()
    if duration is not None and timings is not None:
        timings[stage] = timings.get(stage, 0.0) + duration * 1000
    details = " ".join(f"{key}={value}" for key, value in fields.items())
    elapsed = f" duration_ms={duration * 1000:.1f}" if duration is not None else ""
    logger.log(level, "OCR upload_id=%s stage=%s%s%s", _OCR_UPLOAD_ID.get(), stage, elapsed,
               f" {details}" if details else "")


@contextmanager
def _ocr_process_slot():
    queued = time.perf_counter()
    acquired = _OCR_SEMAPHORE.acquire(timeout=OCR_QUEUE_TIMEOUT)
    _ocr_log("subprocess_queue", time.perf_counter() - queued,
             result="acquired" if acquired else "timeout")
    if not acquired:
        raise OCRProcessingTimeout("OCR concurrency queue timed out")
    try:
        yield
    finally:
        _OCR_SEMAPHORE.release()

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


def _terminate_and_reap(process: subprocess.Popen, code: int = -1) -> None:
    """Terminate a timed-out Tesseract child and always wait for its exit."""
    try:
        process.terminate()
    except (OSError, ProcessLookupError):
        pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except (OSError, ProcessLookupError):
            pass
        process.wait()


def _install_tesseract_timeout_cleanup(pytesseract) -> None:
    # pytesseract 0.3.13 can call Popen.kill() without waiting after terminate
    # times out; reap explicitly to avoid leaving a zombie child on Linux.
    module = getattr(pytesseract, "pytesseract", None)
    if module is not None and getattr(module, "kill", None) is not _terminate_and_reap:
        module.kill = _terminate_and_reap


def configure_tesseract():
    global _OCR_TESSDATA_DIR, _TESSERACT_CACHE
    try:
        import pytesseract
    except ImportError as exc:
        logger.warning("OCR unavailable: pytesseract could not be imported (%s).", type(exc).__name__)
        return None
    _install_tesseract_timeout_cleanup(pytesseract)

    if _TESSERACT_CACHE is not None:
        pytesseract.pytesseract.tesseract_cmd, _OCR_TESSDATA_DIR = _TESSERACT_CACHE
        _ocr_log("tesseract_discovery", 0, cache="hit")
        return pytesseract

    with _TESSERACT_LOCK:
        if _TESSERACT_CACHE is not None:
            pytesseract.pytesseract.tesseract_cmd, _OCR_TESSDATA_DIR = _TESSERACT_CACHE
            _ocr_log("tesseract_discovery", 0, cache="hit")
            return pytesseract
        started = time.perf_counter()
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
            _ocr_log("tesseract_discovery", time.perf_counter() - started, level=logging.WARNING, result="missing")
            logger.warning("OCR unavailable: no runnable Tesseract executable was found.")
            return None

        data_dirs = _tessdata_candidates(candidate)
        _OCR_TESSDATA_DIR = data_dirs[0] if data_dirs else _probe_default_tessdata(candidate)
        _TESSERACT_CACHE = (candidate, _OCR_TESSDATA_DIR)
        _ocr_log("tesseract_discovery", time.perf_counter() - started, executable=candidate,
                 tessdata=str(_OCR_TESSDATA_DIR or "default"))
        logger.info(
            "Tesseract ready (%s); language data directory: %s.",
            (result.stdout or result.stderr).splitlines()[0] if (result.stdout or result.stderr) else "version unknown",
            str(_OCR_TESSDATA_DIR) if _OCR_TESSDATA_DIR else "Tesseract default search path",
        )
        return pytesseract

# OCR accuracy tuning knobs. PSM 6 is the primary multilingual pass; any extra
# work is gated by low measured confidence or a strong mixed-script imbalance.
UPSCALE_SMALL_IMAGE = True
UPSCALE_SCALE = 1.5
MIN_LONG_SIDE_FOR_UPSCALE = 900
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
    confs = []
    for value in data.get("conf", []):
        try:
            confidence = float(value)
        except (TypeError, ValueError):
            continue
        if confidence >= 0:
            confs.append(confidence)
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


MAX_OCR_DIMENSION = 1600
MAX_OCR_PIXELS = 40_000_000
# Keep the request deadline close to the extraction deadline and below the
# browser's 100 second XHR deadline. Tesseract itself remains bounded per child.
UPLOAD_OCR_TIMEOUT = min(95.0, OCR_DOCUMENT_TIMEOUT + 5.0)


def _bound_dimensions(image: Image.Image) -> Image.Image:
    """Downscale oversized images so OCR stays bounded in CPU and memory."""
    w, h = image.size
    if max(w, h) > MAX_OCR_DIMENSION:
        scale = MAX_OCR_DIMENSION / float(max(w, h))
        return image.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    return image


def _validate_image_dimensions(path: Path, suffix: str) -> None:
    """Reject oversized raster headers before Pillow decodes their pixel data."""
    if suffix not in {".png", ".jpg", ".jpeg"}:
        return
    try:
        with Image.open(path) as image:
            width, height = image.size
    except (OSError, Image.DecompressionBombError) as exc:
        raise HTTPException(422, "The image is invalid or could not be decoded.") from exc
    if width <= 0 or height <= 0 or width * height > MAX_OCR_PIXELS:
        raise HTTPException(413, "Image dimensions exceed the OCR processing limit.")


def _pil_variants(image: Image.Image, include_fallbacks: bool = True, *,
                  upscale: bool = True, denoise: bool = True, contrast: float = 2.0):
    """Return (name, PIL image) preprocessing variants.

    The original image is preserved unchanged. A restrained 1.5x upscale and
    contrast pass retains small glyph detail without quadrupling the pixel
    count as a 2x resize would. Keeping the variant count small bounds the
    number of Tesseract subprocesses per upload.
    """
    variants = [("original", image.copy())]

    try:
        grayscale = image.convert("L")
    except Exception:
        grayscale = image

    w, h = grayscale.size
    base = grayscale
    if upscale and UPSCALE_SMALL_IMAGE and max(w, h) < MIN_LONG_SIDE_FOR_UPSCALE:
        base = grayscale.resize((round(w * UPSCALE_SCALE), round(h * UPSCALE_SCALE)), Image.LANCZOS)

    try:
        contrasted = ImageEnhance.Contrast(base).enhance(contrast)
    except Exception:
        contrasted = base

    denoised = contrasted
    if denoise:
        try:
            denoised = contrasted.filter(ImageFilter.MedianFilter(size=3))
        except Exception:
            pass

    if not include_fallbacks:
        return [("enhanced_grayscale", denoised)]

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


class OCRProcessingTimeout(TimeoutError):
    """Raised when an OCR child process reaches its enforced deadline."""


def _run_ocr(pytesseract, image: Image.Image, config: str, purpose: str = "primary"):
    """Run one bounded Tesseract subprocess and derive both text and confidence."""
    started = time.perf_counter()
    deadline = _OCR_DEADLINE.get()
    timeout = OCR_SUBPROCESS_TIMEOUT
    if deadline is not None:
        timeout = min(timeout, deadline - time.perf_counter())
    if timeout <= 0:
        raise OCRProcessingTimeout("OCR document deadline exceeded")
    try:
        data = pytesseract.image_to_data(
            image, config=config, output_type=pytesseract.Output.DICT,
            timeout=timeout,
        )
    except OCRProcessingTimeout:
        raise
    except Exception as exc:
        _ocr_log("tesseract_subprocess", time.perf_counter() - started,
                 level=logging.ERROR, purpose=purpose, config=shlex.quote(config),
                 timeout_s=timeout, result=type(exc).__name__)
        if isinstance(exc, RuntimeError) and "process timeout" in str(exc).lower():
            raise OCRProcessingTimeout("Tesseract subprocess timed out") from exc
        raise
    _ocr_log("tesseract_subprocess", time.perf_counter() - started, purpose=purpose,
             config=shlex.quote(config),
             timeout_s=timeout, result="ok")
    confidence = _mean_confidence(data)
    # image_to_data is a single Tesseract pass. Reconstruct normalized lines from
    # the returned words so text and confidence describe the same recognition run.
    grouped: dict[tuple[str, str, str, str], list[str]] = {}
    order: list[tuple[str, str, str, str]] = []
    for i, word in enumerate(data.get("text", [])):
        word = str(word).strip()
        if not word:
            continue
        key = tuple(str(data.get(field, [""] * (i + 1))[i]) for field in
                    ("page_num", "block_num", "par_num", "line_num"))
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append(word)
    return "\n".join(" ".join(grouped[key]) for key in order), confidence


def _normalize_ocr_text(text: str) -> str:
    """Safely normalize OCR output without correcting or guessing words."""
    if not text:
        return ""
    text = text.replace("\f", "\n").replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t\u00a0]+", " ", line).strip() for line in text.split("\n")]
    cleaned = "\n".join(lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _indic_script_counts(text: str) -> dict[str, int]:
    letters = [character for character in text
               if unicodedata.category(character).startswith("L")]
    return {
        "hin": sum("\u0900" <= character <= "\u097f" for character in letters),
        "guj": sum("\u0a80" <= character <= "\u0aff" for character in letters),
    }


def _dominant_indic_language(text: str) -> str | None:
    counts = _indic_script_counts(text)
    if not all(counts.values()):
        return None
    dominant, minority = sorted(counts.values(), reverse=True)
    if dominant >= minority * 2.5:
        return "hin" if counts["hin"] == dominant else "guj"
    return None


def _language_specific_config(base_config: str, language: str) -> str:
    parts = shlex.split(base_config)
    try:
        parts[parts.index("-l") + 1] = language
    except (ValueError, IndexError):
        return base_config
    return shlex.join(parts)


def ocr_language_config(pytesseract) -> str:
    # Serialize first-time discovery so concurrent uploads do not launch a
    # burst of identical --list-langs subprocesses.
    with _OCR_LANGUAGE_LOCK:
        return _ocr_language_config_locked(pytesseract)


def _ocr_language_config_locked(pytesseract) -> str:
    started = time.perf_counter()
    command = getattr(getattr(pytesseract, "pytesseract", None), "tesseract_cmd", "mock")
    cache_key = f"{command}|{_tessdata_config()}|{'+'.join(OCR_LANGS)}"
    if cache_key in _OCR_LANGUAGE_CACHE:
        languages = _OCR_LANGUAGE_CACHE[cache_key]
        _ocr_log("language_initialization", 0, cache="hit",
                 languages="+".join(languages) if languages else "none")
        data_config = _tessdata_config()
        return "-l " + "+".join(languages) + (" " + data_config if data_config else "") if languages else ""
    try:
        if command != "mock":
            argv = [command, "--list-langs"]
            if _OCR_TESSDATA_DIR:
                argv.extend(("--tessdata-dir", str(_OCR_TESSDATA_DIR)))
            result = subprocess.run(argv, capture_output=True, text=True,
                                    timeout=10, check=True)
            available = set((result.stdout or "").splitlines()[1:])
        else:
            available = set(pytesseract.get_languages(config=_tessdata_config()))
    except Exception as exc:
        _ocr_log("language_initialization", time.perf_counter() - started,
                 level=logging.WARNING, result=type(exc).__name__)
        logger.warning("Tesseract language discovery failed (%s).", type(exc).__name__)
        return ""
    languages = [lang for lang in OCR_LANGS if lang in available]
    _OCR_LANGUAGE_CACHE[cache_key] = languages
    _ocr_log("language_initialization", time.perf_counter() - started,
             languages="+".join(languages) if languages else "none")
    if not languages:
        return ""
    data_config = _tessdata_config()
    return "-l " + "+".join(languages) + (" " + data_config if data_config else "")


def extract_image_ocr(path: Path) -> tuple[str, str]:
    total_started = time.perf_counter()
    pytesseract = configure_tesseract()
    if not pytesseract:
        _ocr_log("total_ocr_execution", time.perf_counter() - total_started, result="unavailable")
        logger.warning("OCR unavailable: tesseract not configured")
        return "", "ocr_unavailable"
    base_config = ocr_language_config(pytesseract)
    if not base_config:
        _ocr_log("total_ocr_execution", time.perf_counter() - total_started,
                 result="missing_language_data")
        logger.warning("OCR unavailable: no language models configured")
        return "", "ocr_unavailable"
    try:
        loading_started = time.perf_counter()
        with Image.open(path) as source:
            original_size = source.size
            image = ImageOps.exif_transpose(source).convert("RGB")
            image = _bound_dimensions(image)
        _ocr_log("image_loading", time.perf_counter() - loading_started,
                 original_size=f"{original_size[0]}x{original_size[1]}",
                 size=f"{image.width}x{image.height}")
        preprocessing_started = time.perf_counter()
        # The first pass uses the camera's native pixels. Avoid a blind resize
        # and median filter: both add work and can erase fine print at this size.
        variants = _pil_variants(image, include_fallbacks=False,
                                 upscale=False, denoise=False, contrast=1.45)
        _ocr_log("image_preprocessing", time.perf_counter() - preprocessing_started,
                 variant=variants[0][0], size=f"{variants[0][1].width}x{variants[0][1].height}")
        with _ocr_process_slot():
            best_text = ""
            best_confidence = -1.0
            _name, variant = variants[0]
            psm_started = time.perf_counter()
            try:
                text, confidence = _run_ocr(
                    pytesseract, variant, _psm_config(base_config, 6), purpose="primary_psm6"
                )
                logger.info("OCR upload_id=%s stage=psm_execution mode=6 confidence=%.1f chars=%d",
                            _OCR_UPLOAD_ID.get(), confidence, len(text))
                best_text, best_confidence = text, confidence
            except Exception as exc:
                _ocr_log("psm_execution", level=logging.WARNING, mode=6,
                         result=type(exc).__name__)
                raise
            finally:
                _ocr_log("psm_execution", time.perf_counter() - psm_started, mode=6)

            # Sparse layout recognition is justified only when measured confidence is weak.
            if best_confidence < CONFIDENCE_FLOOR:
                fallback_started = time.perf_counter()
                try:
                    fallback_preprocess_started = time.perf_counter()
                    fallback_variants = _pil_variants(
                        image, include_fallbacks=False, upscale=True,
                        denoise=True, contrast=1.8,
                    )
                    _ocr_log("image_preprocessing", time.perf_counter() - fallback_preprocess_started,
                             variant="low_confidence_enhanced",
                             size=f"{fallback_variants[0][1].width}x{fallback_variants[0][1].height}")
                    text, confidence = _run_ocr(pytesseract, fallback_variants[0][1],
                                                _psm_config(base_config, 11), purpose="low_confidence_psm11")
                    logger.info("OCR upload_id=%s stage=psm_execution mode=11 confidence=%.1f chars=%d",
                                _OCR_UPLOAD_ID.get(), confidence, len(text))
                    if confidence > best_confidence or (
                        confidence == best_confidence and len(text) > len(best_text)
                    ):
                        best_text = text
                        best_confidence = confidence
                except OCRProcessingTimeout:
                    raise
                except Exception as exc:
                    _ocr_log("psm_execution", level=logging.WARNING, mode=11,
                             result=type(exc).__name__)
                finally:
                    _ocr_log("psm_execution", time.perf_counter() - fallback_started, mode=11)

            # Combined Indic models can occasionally confuse a few characters
            # between Devanagari and Gujarati. Re-run only when the recognized
            # output itself shows a strong script imbalance, then keep the
            # candidate only if confidence and text coverage remain comparable.
            target_language = _dominant_indic_language(best_text)
            if target_language:
                language_started = time.perf_counter()
                try:
                    candidate_text, candidate_confidence = _run_ocr(
                        pytesseract, variant,
                        _psm_config(_language_specific_config(base_config, target_language), 6),
                        purpose=f"script_disambiguation_{target_language}",
                    )
                    original_words = len(best_text.split())
                    candidate_words = len(candidate_text.split())
                    if (candidate_text and candidate_words >= max(3, int(original_words * 0.6))
                            and candidate_confidence >= best_confidence - 15):
                        best_text, best_confidence = candidate_text, candidate_confidence
                        selected = "language_specific"
                    else:
                        selected = "combined"
                    _ocr_log("language_disambiguation", time.perf_counter() - language_started,
                             target=target_language, selected=selected,
                             confidence=f"{candidate_confidence:.1f}", words=candidate_words)
                except OCRProcessingTimeout:
                    raise
                except Exception as exc:
                    _ocr_log("language_disambiguation", time.perf_counter() - language_started,
                             level=logging.WARNING, target=target_language,
                             result=type(exc).__name__)

            normalization_started = time.perf_counter()
            normalized = _normalize_ocr_text(best_text)
            _ocr_log("text_normalization", time.perf_counter() - normalization_started,
                     chars=len(normalized))
            _ocr_log("total_ocr_execution", time.perf_counter() - total_started,
                     confidence=f"{best_confidence:.1f}", chars=len(normalized))
            return normalized, "ocr"
    except OCRProcessingTimeout:
        _ocr_log("total_ocr_execution", time.perf_counter() - total_started,
                 level=logging.ERROR, result="timeout")
        raise
    except Exception as exc:
        _ocr_log("total_ocr_execution", time.perf_counter() - total_started,
                 level=logging.ERROR, result=type(exc).__name__)
        logger.warning("Image OCR failed (%s).", type(exc).__name__)
        return "", "ocr_unavailable"


def extract_scanned_pdf(path: Path) -> tuple[str, str]:
    total_started = time.perf_counter()
    pytesseract = configure_tesseract()
    if not pytesseract:
        logger.warning("OCR unavailable: tesseract not configured")
        return "", "ocr_unavailable"
    base_config = ocr_language_config(pytesseract)
    if not base_config:
        logger.warning("OCR unavailable: no language models configured")
        return "", "ocr_unavailable"
    try:
        import pypdfium2 as pdfium
        pages = []
        with pdfium.PdfDocument(str(path)) as pdf:
            for index in range(len(pdf)):
                if _OCR_DEADLINE.get() is not None and time.perf_counter() >= _OCR_DEADLINE.get():
                    raise OCRProcessingTimeout("OCR document deadline exceeded")
                page_started = time.perf_counter()
                loading_started = time.perf_counter()
                page = pdf[index]
                page_width, page_height = page.get_size()
                page_scale = min(2.0, MAX_OCR_DIMENSION / max(page_width, page_height, 1))
                bitmap = page.render(scale=page_scale)
                _ocr_log("image_loading", time.perf_counter() - loading_started,
                         pdf_page=index + 1, size=f"{bitmap.width}x{bitmap.height}",
                         render_scale=f"{page_scale:.3f}")
                try:
                    with bitmap.to_pil() as image:
                        image = image.convert("RGB")
                        image = _bound_dimensions(image)
                        preprocessing_started = time.perf_counter()
                        variants = _pil_variants(image, include_fallbacks=False)
                        _ocr_log("image_preprocessing", time.perf_counter() - preprocessing_started,
                                 pdf_page=index + 1, variant=variants[0][0],
                                 size=f"{variants[0][1].width}x{variants[0][1].height}")
                        variant = variants[0][1]
                        best_text = ""
                        best_confidence = -1.0
                        with _ocr_process_slot():
                            psm_started = time.perf_counter()
                            try:
                                text, confidence = _run_ocr(
                                    pytesseract, variant, _psm_config(base_config, 6),
                                    purpose=f"pdf_page_{index + 1}_psm6",
                                )
                            finally:
                                _ocr_log("psm_execution", time.perf_counter() - psm_started,
                                         pdf_page=index + 1, mode=6)
                            best_text, best_confidence = text, confidence
                            if confidence < CONFIDENCE_FLOOR:
                                fallback_started = time.perf_counter()
                                try:
                                    fallback_text, fallback_confidence = _run_ocr(
                                        pytesseract, variant, _psm_config(base_config, 11),
                                        purpose=f"pdf_page_{index + 1}_low_confidence_psm11",
                                    )
                                    if fallback_confidence > best_confidence or (
                                        fallback_confidence == best_confidence and len(fallback_text) > len(best_text)
                                    ):
                                        best_text, best_confidence = fallback_text, fallback_confidence
                                except OCRProcessingTimeout:
                                    raise
                                except Exception as exc:
                                    _ocr_log("psm_execution", level=logging.WARNING,
                                             pdf_page=index + 1, mode=11, result=type(exc).__name__)
                                finally:
                                    _ocr_log("psm_execution", time.perf_counter() - fallback_started,
                                             pdf_page=index + 1, mode=11)
                            target_language = _dominant_indic_language(best_text)
                            if target_language:
                                language_started = time.perf_counter()
                                try:
                                    candidate_text, candidate_confidence = _run_ocr(
                                        pytesseract, variant,
                                        _psm_config(_language_specific_config(base_config, target_language), 6),
                                    )
                                    if (candidate_text
                                            and len(candidate_text.split()) >= max(3, int(len(best_text.split()) * 0.6))
                                            and candidate_confidence >= best_confidence - 15):
                                        best_text, best_confidence = candidate_text, candidate_confidence
                                        selected = "language_specific"
                                    else:
                                        selected = "combined"
                                    _ocr_log("language_disambiguation", time.perf_counter() - language_started,
                                             pdf_page=index + 1, target=target_language,
                                             selected=selected, confidence=f"{candidate_confidence:.1f}")
                                except OCRProcessingTimeout:
                                    raise
                                except Exception as exc:
                                    _ocr_log("language_disambiguation", time.perf_counter() - language_started,
                                             level=logging.WARNING, pdf_page=index + 1,
                                             target=target_language, result=type(exc).__name__)
                        normalization_started = time.perf_counter()
                        normalized_page = _normalize_ocr_text(best_text)
                        _ocr_log("text_normalization", time.perf_counter() - normalization_started,
                                 pdf_page=index + 1, chars=len(normalized_page))
                        pages.append(normalized_page)
                        _ocr_log("pdf_page_ocr", time.perf_counter() - page_started,
                                 pdf_page=index + 1, chars=len(best_text),
                                 confidence=f"{best_confidence:.1f}")
                finally:
                    bitmap.close()
                    page.close()
        _ocr_log("total_ocr_execution", time.perf_counter() - total_started,
                 pdf_pages=len(pages), result="ok")
        return "\n".join(pages), "pdf_ocr"
    except OCRProcessingTimeout:
        _ocr_log("total_ocr_execution", time.perf_counter() - total_started,
                 level=logging.ERROR, result="timeout")
        raise
    except Exception as exc:
        _ocr_log("total_ocr_execution", time.perf_counter() - total_started,
                 level=logging.ERROR, result=type(exc).__name__)
        logger.warning("Scanned PDF OCR failed (%s).", type(exc).__name__)
        return "", "ocr_unavailable"


def get_ocr_languages() -> list[str]:
    pytesseract = configure_tesseract()
    if not pytesseract:
        return []
    config = ocr_language_config(pytesseract)
    if not config:
        return []
    parts = shlex.split(config)
    try:
        languages = parts[parts.index("-l") + 1].split("+")
    except (ValueError, IndexError):
        return []
    logger.info("Available OCR languages: %s.", ", ".join(languages) if languages else "none")
    return languages


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


_ENGLISH_MARKERS = {
    "a", "about", "after", "all", "and", "are", "as", "at", "by", "can", "community",
    "date", "for", "from", "government", "health", "in", "is", "may", "must", "notice",
    "of", "on", "or", "public", "shall", "submit", "the", "this", "to", "with", "your",
}


def detect_document_language(text: str) -> str:
    """Infer supported languages from script and conservative English markers.

    Indic scripts identify Hindi and Gujarati directly. Latin script alone does
    not prove English, so English also needs recognizable common vocabulary.
    Mixed documents return a stable `en+hi`, `en+gu`, `hi+gu`, or `en+hi+gu` tag.
    """
    letters = [character for character in text if unicodedata.category(character).startswith("L")]
    if not letters:
        return "und"
    counts = {
        "en": sum(character.isascii() and character.isalpha() for character in letters),
        "hi": sum("\u0900" <= character <= "\u097f" for character in letters),
        "gu": sum("\u0a80" <= character <= "\u0aff" for character in letters),
    }
    total = len(letters)
    words = re.findall(r"[A-Za-z]+", text.lower())
    english_markers = sum(word in _ENGLISH_MARKERS for word in words)
    present = []
    if counts["en"] >= 3 and counts["en"] / total >= 0.22 and english_markers >= 2:
        present.append("en")
    if counts["hi"] >= 3 and counts["hi"] / total >= 0.22:
        present.append("hi")
    if counts["gu"] >= 3 and counts["gu"] / total >= 0.22:
        present.append("gu")
    if len(present) > 1:
        dominant_count = max(counts[language] for language in present)
        # OCR can substitute a few glyphs into a neighboring Indic script.
        # Call a document mixed only when both scripts have comparable evidence.
        present = [language for language in present
                   if counts[language] >= dominant_count * 0.5]
    return "+".join(present) if present else "und"

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
async def upload_document(request: Request, response: Response, file: UploadFile = File(...)):
    owner_id = owner(request)
    name = Path(file.filename or "document").name
    suffix = Path(name).suffix.lower()
    if suffix not in ALLOWED:
        raise HTTPException(415, "Supported formats: PDF, TXT, DOCX, PNG, JPG, JPEG.")
    doc_id = uuid.uuid4().hex
    safe_name = re.sub(r"[^\w. -]", "_", name).strip(" .") or "document"
    target = STORAGE / f"{doc_id}{suffix}"
    size = 0
    defer_file_cleanup = False
    try:
        with target.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise HTTPException(413, f"File exceeds the {MAX_BYTES / (1024 * 1024):g} MB upload limit.")
                out.write(chunk)
        if not validate_signature(target, suffix):
            raise HTTPException(415, "The file content does not match its extension.")
        await run_in_threadpool(_validate_image_dimensions, target, suffix)
        logger.info("Upload %s: starting text extraction (%s bytes)", doc_id, size)
        upload_context = _OCR_UPLOAD_ID.set(doc_id)
        deadline_context = _OCR_DEADLINE.set(time.perf_counter() + OCR_DOCUMENT_TIMEOUT)
        timings: dict[str, float] = {}
        timings_context = _OCR_TIMINGS.set(timings)
        extraction_context = contextvars.copy_context()
        extraction_future = _DOCUMENT_EXECUTOR.submit(
            extraction_context.run, extract_text, target, suffix
        )
        try:
            text, extraction = await asyncio.wait_for(
                asyncio.wrap_future(extraction_future), timeout=UPLOAD_OCR_TIMEOUT
            )
        except OCRProcessingTimeout as exc:
            target.unlink(missing_ok=True)
            logger.error("Upload %s: OCR subprocess deadline reached (%s)", doc_id, type(exc).__name__)
            raise HTTPException(504, "Document OCR timed out. Please try a smaller or simpler file.")
        except asyncio.TimeoutError:
            defer_file_cleanup = True
            def cleanup_timed_out_extraction(_future) -> None:
                target.unlink(missing_ok=True)

            extraction_future.add_done_callback(cleanup_timed_out_extraction)
            logger.error("Upload %s: OCR/text extraction request deadline reached after %ss",
                         doc_id, UPLOAD_OCR_TIMEOUT)
            raise HTTPException(504, "Document processing timed out. Please try a smaller or simpler file.")
        finally:
            _OCR_UPLOAD_ID.reset(upload_context)
            _OCR_DEADLINE.reset(deadline_context)
            _OCR_TIMINGS.reset(timings_context)
        logger.info("Upload %s: extraction done (extraction=%s chars=%d)", doc_id, extraction, len(text))
        status = "completed" if text.strip() else "needs_ocr" if extraction in {"pdf_text", "ocr_unavailable", "ocr", "pdf_ocr"} else "no_text"
        record = {
            "id": doc_id, "owner_id": owner_id, "title": safe_name, "filename": safe_name,
            "file_type": suffix[1:].upper(), "mime_type": MIME[suffix], "size": size,
            "created_at": datetime.now(timezone.utc).isoformat(), "status": status,
            "ocr_status": status, "language": detect_document_language(text),
            "extraction": extraction, "text": text, "overview": simple_summary(text),
            "ai_summary": None,
            "processing_metadata": {
                "timings_ms": {stage: round(duration_ms, 1) for stage, duration_ms in timings.items()},
            },
            "path": str(target),
        }
        save_doc(record)
        logger.info("Upload %s: saved (status=%s)", doc_id, status)
        if timings:
            response.headers["Server-Timing"] = ", ".join(
                f"ocr-{stage.replace('_', '-')};dur={duration_ms:.1f}"
                for stage, duration_ms in sorted(timings.items())
            )
        return public_document(record)
    except HTTPException:
        if not defer_file_cleanup:
            target.unlink(missing_ok=True)
        raise
    except PyMongoError as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(503, "Document storage is currently unavailable.") from exc
    except Exception as exc:
        if not defer_file_cleanup:
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
