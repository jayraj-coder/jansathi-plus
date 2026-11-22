from __future__ import annotations

import logging
import os
import shutil
import shlex
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import main as api


@pytest.fixture(autouse=True)
def reset_ocr_process_caches():
    api._TESSERACT_CACHE = None
    api._OCR_LANGUAGE_CACHE.clear()
    yield
    api._TESSERACT_CACHE = None
    api._OCR_LANGUAGE_CACHE.clear()


def _write_models(directory: Path, *languages: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for language in languages:
        (directory / f"{language}.traineddata").write_bytes(b"test model")
    return directory


def test_executable_discovery_accepts_windows_path_with_spaces(tmp_path, monkeypatch):
    binary = tmp_path / "Program Files" / "Tesseract-OCR" / "tesseract.exe"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"test executable")
    monkeypatch.setenv("TESSERACT_CMD", str(binary))
    monkeypatch.setattr(api.shutil, "which", lambda command: None)

    assert api._tesseract_candidates()[0] == str(binary)


def test_executable_discovery_accepts_linux_path(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "ROOT", tmp_path)
    monkeypatch.delenv("TESSERACT_CMD", raising=False)
    monkeypatch.setattr(
        api.shutil,
        "which",
        lambda command: "/usr/bin/tesseract" if command in {"tesseract", "/usr/bin/tesseract"} else None,
    )

    assert "/usr/bin/tesseract" in api._tesseract_candidates()


def test_configure_tesseract_validates_candidate_and_discovers_local_models(tmp_path, monkeypatch):
    binary = tmp_path / "tesseract.exe"
    binary.write_bytes(b"test executable")
    model_dir = _write_models(tmp_path / "data" / "tessdata", "eng", "hin", "guj")
    monkeypatch.setattr(api, "_tesseract_candidates", lambda: [str(binary)])
    monkeypatch.setattr(api, "_tessdata_candidates", lambda executable=None: [model_dir])
    monkeypatch.setattr(
        api.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "tesseract 5.4.0", ""),
    )

    pytesseract = api.configure_tesseract()

    assert pytesseract is not None
    assert pytesseract.pytesseract.tesseract_cmd == str(binary)
    assert api._OCR_TESSDATA_DIR == model_dir


def test_valid_explicit_tessdata_directory_is_preserved(tmp_path, monkeypatch):
    explicit = _write_models(tmp_path / "explicit", "eng", "hin")
    local = _write_models(tmp_path / "local", "eng", "hin", "guj")
    monkeypatch.setattr(api, "TESSDATA_DIR", local)
    monkeypatch.setattr(api, "SYSTEM_TESSDATA_DIRS", ())
    monkeypatch.setenv("TESSDATA_DIR", str(explicit))
    monkeypatch.delenv("TESSDATA_PREFIX", raising=False)

    assert api._tessdata_candidates()[0] == explicit


def test_system_tessdata_directory_is_discovered(tmp_path, monkeypatch):
    system = _write_models(tmp_path / "usr" / "share" / "tesseract-ocr" / "5" / "tessdata", "eng", "hin", "guj")
    monkeypatch.setattr(api, "TESSDATA_DIR", tmp_path / "missing-local")
    monkeypatch.setattr(api, "SYSTEM_TESSDATA_DIRS", (system,))
    monkeypatch.delenv("TESSDATA_DIR", raising=False)
    monkeypatch.delenv("TESSDATA_PREFIX", raising=False)

    assert api._tessdata_candidates()[0] == system


def test_configure_tesseract_returns_none_when_binary_is_missing(monkeypatch, caplog):
    monkeypatch.setattr(api, "_tesseract_candidates", lambda: [])
    caplog.set_level(logging.WARNING, logger=api.__name__)

    assert api.configure_tesseract() is None
    assert "no runnable Tesseract executable" in caplog.text


def test_language_discovery_reports_only_languages_actually_available(monkeypatch):
    seen = {}

    def get_languages(config=""):
        seen["config"] = config
        return ["eng", "guj"]

    monkeypatch.setattr(api, "configure_tesseract", lambda: SimpleNamespace(get_languages=get_languages))
    monkeypatch.setattr(api, "_OCR_TESSDATA_DIR", None)
    monkeypatch.setattr(api, "OCR_LANGS", ["eng", "hin", "guj"])

    assert api.get_ocr_languages() == ["eng", "guj"]
    assert seen["config"] == ""


def test_language_discovery_reports_english_hindi_and_gujarati(monkeypatch):
    monkeypatch.setattr(
        api,
        "configure_tesseract",
        lambda: SimpleNamespace(get_languages=lambda config="": ["eng", "hin", "guj", "osd"]),
    )
    monkeypatch.setattr(api, "_OCR_TESSDATA_DIR", None)
    monkeypatch.setattr(api, "OCR_LANGS", ["eng", "hin", "guj"])

    assert api.get_ocr_languages() == ["eng", "hin", "guj"]


def test_language_config_uses_detected_directory_and_available_subset(monkeypatch, tmp_path):
    data_dir = _write_models(tmp_path / "models with spaces", "eng", "hin")
    monkeypatch.setattr(api, "_OCR_TESSDATA_DIR", data_dir)
    monkeypatch.setattr(api, "OCR_LANGS", ["eng", "hin", "guj"])
    pytesseract = SimpleNamespace(get_languages=lambda config="": ["eng", "hin"])

    config = api.ocr_language_config(pytesseract)

    assert "-l eng+hin" in config
    assert "--tessdata-dir" in config
    assert data_dir.as_posix() in config
    assert "guj" not in config
    assert shlex.split(config)[-1] == data_dir.as_posix()


def test_local_complete_models_are_preferred_and_invalid_paths_are_ignored(tmp_path, monkeypatch):
    local = _write_models(tmp_path / "local", "eng", "hin", "guj")
    system = _write_models(tmp_path / "system", "eng")
    monkeypatch.setattr(api, "ROOT", tmp_path)
    monkeypatch.setattr(api, "TESSDATA_DIR", local)
    monkeypatch.setattr(api, "SYSTEM_TESSDATA_DIRS", (system,))
    monkeypatch.setenv("TESSDATA_DIR", str(tmp_path / "missing"))
    monkeypatch.delenv("TESSDATA_PREFIX", raising=False)

    candidates = api._tessdata_candidates()

    assert candidates[0] == local
    assert all(path.exists() for path in candidates)


def test_invalid_tessdata_prefix_falls_back_without_mutating_process_env(tmp_path, monkeypatch):
    binary = tmp_path / "tesseract.exe"
    binary.write_bytes(b"test executable")
    default_data = _write_models(tmp_path / "compiled-default" / "tessdata", "eng", "hin", "guj")
    invalid_prefix = tmp_path / "missing-prefix"
    monkeypatch.setenv("TESSDATA_PREFIX", str(invalid_prefix))
    monkeypatch.delenv("TESSDATA_DIR", raising=False)
    monkeypatch.setattr(api, "_tesseract_candidates", lambda: [str(binary)])
    monkeypatch.setattr(api, "_tessdata_candidates", lambda executable=None: [])

    import pytesseract

    monkeypatch.setattr(pytesseract.pytesseract, "tesseract_cmd", "tesseract")
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        if command[-1] == "--version":
            return subprocess.CompletedProcess(command, 0, "tesseract 5.4.0", "")
        assert command[-1] == "--list-langs"
        assert "TESSDATA_PREFIX" not in kwargs["env"]
        stdout = f'List of available languages in "{default_data.as_posix()}/" (3):\neng\nhin\nguj\n'
        return subprocess.CompletedProcess(command, 0, stdout, "")

    monkeypatch.setattr(api.subprocess, "run", fake_run)

    assert api.configure_tesseract() is pytesseract
    assert api._OCR_TESSDATA_DIR == default_data
    assert api.os.environ["TESSDATA_PREFIX"] == str(invalid_prefix)
    assert len(calls) == 2


def test_missing_language_directory_returns_no_fallback(tmp_path, monkeypatch):
    monkeypatch.delenv("TESSDATA_PREFIX", raising=False)
    command = ["tesseract", "--list-langs"]
    error = subprocess.CalledProcessError(1, command, stderr="Error opening data file")
    monkeypatch.setattr(api.subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(error))

    assert api._probe_default_tessdata("tesseract") is None


def test_language_discovery_returns_empty_when_tesseract_is_missing(monkeypatch):
    monkeypatch.setattr(api, "configure_tesseract", lambda: None)

    assert api.get_ocr_languages() == []


def test_scanned_pdf_ocr_falls_back_cleanly_when_tesseract_is_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(api, "configure_tesseract", lambda: None)

    assert api.extract_scanned_pdf(tmp_path / "scan.pdf") == ("", "ocr_unavailable")


def test_health_response_shape_is_unchanged(monkeypatch):
    monkeypatch.setattr(api, "get_ocr_languages", lambda: ["eng"])
    response = TestClient(api.app).get("/api/health")

    assert response.status_code == 200
    assert set(response.json()) == {
        "status",
        "database",
        "ai_primary",
        "ai_configured",
        "ocr_configured",
        "ocr_languages",
        "max_upload_bytes",
    }
    assert response.json()["ocr_configured"] is True
    assert response.json()["ocr_languages"] == ["eng"]

from types import SimpleNamespace
from PIL import Image

from backend import main as api


def _make_image(mode="RGB", size=(100, 50), color=(255, 255, 255)):
    return Image.new(mode, size, color)


def _mock_pytesseract(psm_text_conf):
    """psm_text_conf: {psm: (text, confidence)}"""
    m = SimpleNamespace()

    def image_to_data(image, config="", output_type=None, timeout=None):
        for psm, (text, conf) in psm_text_conf.items():
            if f"--psm {psm}" in config:
                words = text.split()
                return {"text": words, "conf": [str(conf)] * len(words),
                        "page_num": ["1"] * len(words), "block_num": ["1"] * len(words),
                        "par_num": ["1"] * len(words),
                        "line_num": ["1"] * len(words)}
        return {"text": [], "conf": [], "page_num": [], "block_num": [],
                "par_num": [], "line_num": []}

    m.Output = SimpleNamespace(DICT="dict")
    m.image_to_data = image_to_data
    m.get_languages = lambda config="": ["eng", "hin", "guj", "osd"]
    return m


# ---------------- CER / WER measurement ----------------

def test_cer_identical_text_is_zero():
    assert api.cer("MAN SEEKS PEACE", "MAN SEEKS PEACE") == 0.0


def test_cer_empty_reference_with_hypothesis_is_one():
    assert api.cer("", "ABC") == 1.0


def test_cer_substitution_cost():
    assert abs(api.cer("CAT", "BAT") - (1.0 / 3.0)) < 1e-9


def test_wer_identical_text_is_zero():
    assert api.wer("THE CAT SAT", "THE CAT SAT") == 0.0


def test_wer_word_substitution():
    assert abs(api.wer("THE CAT", "THE BAT") - 0.5) < 1e-9


def test_wer_empty_reference():
    assert api.wer("", "WORD") == 1.0


def test_cer_wer_bug_example_is_measurable():
    # Ground truth from the real decorative-text test image.
    reference = "MAN SEEKS PEACE, YET AT THE SAME TIME YEARNING FOR WAR"
    hypothesis = "MAN SEEKS P IMB INKING OF P HILST 05085"
    c = api.cer(reference, hypothesis)
    w = api.wer(reference, hypothesis)
    assert 0.0 < c <= 1.0
    assert 0.0 < w <= 1.0
    # The garbled hypothesis should register as clearly inaccurate.
    assert c > 0.5
    assert w > 0.5


# ---------------- preprocessing variants ----------------

def test_pil_variants_include_all_strategies_and_preserve_original():
    img = _make_image()
    variants = api._pil_variants(img)
    names = [name for name, _ in variants]
    assert "original" in names
    assert "enhanced_grayscale" in names
    assert "otsu" in names
    assert "adaptive" in names
    by_name = dict(variants)
    original = by_name["original"]
    assert original.mode == img.mode
    assert original.size == img.size


def test_low_resolution_image_uses_restrained_upscale_in_enhanced_variant():
    img = _make_image(size=(100, 50))
    variants = dict(api._pil_variants(img))
    enhanced = variants["enhanced_grayscale"]
    assert enhanced.size == (150, 75)
    assert enhanced.mode == "L"


def test_otsu_threshold_produces_binary_image():
    img = Image.new("L", (10, 10), 240)
    img.putpixel((5, 5), 30)
    out = api._otsu_threshold(img)
    assert out.mode == "L"
    assert out.size == (10, 10)
    values = {out.getpixel((x, y)) for y in range(out.height) for x in range(out.width)}
    assert values <= {0, 255}


def test_adaptive_threshold_produces_binary_image():
    img = Image.new("L", (20, 20), 240)
    out = api._adaptive_threshold(img)
    assert out.mode == "L"
    assert out.size == (20, 20)
    values = {out.getpixel((x, y)) for y in range(out.height) for x in range(out.width)}
    assert values <= {0, 255}


def test_normalize_collapses_whitespace_and_preserves_punctuation():
    assert api._normalize_ocr_text("MAN   SEEKS\tPEACE.") == "MAN SEEKS PEACE."
    assert api._normalize_ocr_text("WHILST?") == "WHILST?"
    assert api._normalize_ocr_text("a\n\n\nb") == "a\n\nb"
    assert api._normalize_ocr_text("") == ""
    assert api._normalize_ocr_text("   ") == ""


def test_document_language_inference_for_supported_and_mixed_scripts():
    assert api.detect_document_language("Submit the public form by the due date.") == "en"
    assert api.detect_document_language("सरकारी सूचना नागरिकों के लिए है।") == "hi"
    assert api.detect_document_language("જાહેર સૂચના નાગરિકો માટે છે.") == "gu"
    assert api.detect_document_language("The public notice सरकारी नागरिकों के लिए है.") == "en+hi"
    noisy_hindi = (
        "\u0ab8\u0abe\u0ab0\u0acd\u0a96\u0aa8\u0a9c\u0abf \u0938\u0942\u091a\u0928\u093e "
        "\u0938\u0935\u0938\u0925\u094d\u092f \u0936\u0935\u093f\u0930\u093f "
        "\u0906\u0935\u0947\u0926\u0928 \u0915\u0940 \u0905\u0902\u0924\u092e\u093f "
        "\u0aa4\u0aa5\u0abe 30 \u091c\u0942\u0928 2027"
    )
    assert api.detect_document_language(noisy_hindi) == "hi"
    assert api.detect_document_language("123 !!!") == "und"
    assert api.detect_document_language("bonjour tout le monde") == "und"


# ---------------- OCR selection / fallback ----------------

def _install_mock_pytesseract(monkeypatch, psm_text_conf):
    m = _mock_pytesseract(psm_text_conf)
    monkeypatch.setattr(api, "configure_tesseract", lambda: m)
    monkeypatch.setattr(api, "_OCR_TESSDATA_DIR", None)


def test_extract_image_ocr_selects_high_confidence_psm6(tmp_path, monkeypatch):
    img = _make_image(size=(200, 100))
    img.save(tmp_path / "doc.png")
    _install_mock_pytesseract(monkeypatch, {6: ("MAN SEEKS PEACE", 95)})
    text, label = api.extract_image_ocr(tmp_path / "doc.png")
    assert label == "ocr"
    assert text == "MAN SEEKS PEACE"


def test_extract_image_ocr_falls_back_to_sparse_psm_when_confidence_low(tmp_path, monkeypatch):
    img = _make_image(size=(200, 100))
    img.save(tmp_path / "doc.png")
    _install_mock_pytesseract(
        monkeypatch, {6: ("MAN SEEKS P", 20), 11: ("MAN SEEKS PEACE", 90)}
    )
    text, label = api.extract_image_ocr(tmp_path / "doc.png")
    assert label == "ocr"
    assert text == "MAN SEEKS PEACE"


def test_subprocess_timeout_during_psm_fallback_stops_all_later_passes(tmp_path, monkeypatch):
    image_path = tmp_path / "timeout-fallback.png"
    _make_image(size=(300, 120)).save(image_path)
    mock = _mock_pytesseract({6: ("", 0)})
    monkeypatch.setattr(api, "configure_tesseract", lambda: mock)
    monkeypatch.setattr(api, "_OCR_TESSDATA_DIR", None)
    calls = []

    def run_ocr(_pytesseract, _image, config, **kwargs):
        calls.append((config, kwargs.get("purpose")))
        if "--psm 6" in config:
            return "mixed placeholder", 20
        raise api.OCRProcessingTimeout("fallback child process timed out")

    monkeypatch.setattr(api, "_run_ocr", run_ocr)
    with pytest.raises(api.OCRProcessingTimeout):
        api.extract_image_ocr(image_path)
    assert calls == [
        ("-l eng+hin+guj --psm 6", "primary_psm6"),
        ("-l eng+hin+guj --psm 11", "low_confidence_psm11"),
    ]


def test_extract_image_ocr_rechecks_strong_indic_script_mixture(tmp_path, monkeypatch):
    image_path = tmp_path / "indic.png"
    _make_image(size=(300, 120)).save(image_path)
    mock = _mock_pytesseract({6: ("placeholder", 80)})
    monkeypatch.setattr(api, "configure_tesseract", lambda: mock)
    monkeypatch.setattr(api, "_OCR_TESSDATA_DIR", None)
    combined = (
        "\u0ab8\u0abe\u0ab0\u0acd\u0a96\u0aa8\u0a9c\u0abf "
        "\u0938\u0942\u091a\u0928\u093e \u0938\u094d\u0935\u093e\u0938\u094d\u0925\u094d\u092f "
        "\u0936\u093f\u0935\u093f\u0930 \u0906\u0935\u0947\u0926\u0928 \u0915\u0940 "
        "\u0905\u0902\u0924\u093f\u092e \u0aa4\u0aa5\u0abe 30 \u091c\u0942\u0928 2027"
    )
    hindi = (
        "\u0938\u093e\u0930\u094d\u0935\u091c\u0928\u093f\u0915 \u0938\u0942\u091a\u0928\u093e "
        "\u0938\u094d\u0935\u093e\u0938\u094d\u0925\u094d\u092f \u0936\u093f\u0935\u093f\u0930 "
        "\u0906\u0935\u0947\u0926\u0928 \u0915\u0940 \u0905\u0902\u0924\u093f\u092e "
        "\u0924\u093f\u0925\u093f 30 \u091c\u0942\u0928 2027"
    )
    seen = []

    def run_ocr(_mock, _image, config, **_kwargs):
        seen.append(config)
        return (combined, 80) if "-l eng+hin+guj" in config else (hindi, 75)

    monkeypatch.setattr(api, "_run_ocr", run_ocr)
    text, label = api.extract_image_ocr(image_path)
    assert label == "ocr"
    assert text == hindi
    assert seen == ["-l eng+hin+guj --psm 6", "-l hin --psm 6"]


def test_single_tsv_pass_provides_text_and_numeric_confidence(monkeypatch):
    mock = _mock_pytesseract({6: ("JANSAATHI PLUS", 83)})
    monkeypatch.setattr(api, "OCR_SUBPROCESS_TIMEOUT", 1)
    text, confidence = api._run_ocr(mock, _make_image(), "-l eng --psm 6")
    assert text == "JANSAATHI PLUS"
    assert confidence == 83


def test_ocr_subprocess_timeout_is_capped_by_document_deadline():
    mock = _mock_pytesseract({6: ("PUBLIC NOTICE", 90)})
    seen = {}
    original = mock.image_to_data

    def record_timeout(image, config="", output_type=None, timeout=None):
        seen["timeout"] = timeout
        return original(image, config=config, output_type=output_type, timeout=timeout)

    mock.image_to_data = record_timeout
    token = api._OCR_DEADLINE.set(time.perf_counter() + 0.4)
    try:
        api._run_ocr(mock, _make_image(), "-l eng --psm 6")
    finally:
        api._OCR_DEADLINE.reset(token)
    assert 0 < seen["timeout"] <= 0.4


def test_scanned_pdf_starts_with_one_preprocessed_psm6_pass(tmp_path, monkeypatch):
    import sys

    class Bitmap:
        width, height = 240, 120

        def to_pil(self):
            class ImageContext:
                def __enter__(self):
                    return Image.new("RGB", (240, 120), "white")

                def __exit__(self, *_):
                    return False

            return ImageContext()

        def close(self):
            pass

    class Page:
        def render(self, scale=1):
            assert scale == 2
            return Bitmap()

        def close(self):
            pass

    class Pdf:
        def __init__(self, path):
            self.path = path

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def __len__(self):
            return 1

        def __getitem__(self, index):
            assert index == 0
            return Page()

    monkeypatch.setitem(sys.modules, "pypdfium2", SimpleNamespace(PdfDocument=Pdf))
    monkeypatch.setattr(api, "configure_tesseract", lambda: SimpleNamespace())
    monkeypatch.setattr(api, "ocr_language_config", lambda _: "-l eng")
    calls = []

    def run_ocr(_pytesseract, _image, config):
        calls.append(config)
        return "PUBLIC NOTICE", 90

    monkeypatch.setattr(api, "_run_ocr", run_ocr)
    result = api.extract_scanned_pdf(tmp_path / "scan.pdf")
    assert result == ("PUBLIC NOTICE", "pdf_ocr")
    assert calls == ["-l eng --psm 6"]


def test_real_tesseract_subprocess_timeout_terminates_process_and_cleans_temp_files(tmp_path, monkeypatch):
    import pytesseract
    import tempfile

    pid_file = tmp_path / "child.pid"
    compiler = shutil.which("gcc")
    if not compiler:
        pytest.skip("gcc is required to build the test Tesseract executable")
    source = tmp_path / "slow_tesseract.c"
    source.write_text(r'''#include <stdio.h>
#include <stdlib.h>
#ifdef _WIN32
#include <windows.h>
#define CURRENT_PID GetCurrentProcessId
#define WAIT_FOREVER() Sleep(30000)
#else
#include <unistd.h>
#define CURRENT_PID getpid
#define WAIT_FOREVER() sleep(30)
#endif
int main(void) {
  FILE *file = fopen(getenv("OCR_TEST_PID_FILE"), "w");
  fprintf(file, "%ld", (long) CURRENT_PID());
  fclose(file);
  WAIT_FOREVER();
  return 0;
}
''')
    executable = tmp_path / ("slow-tesseract.exe" if os.name == "nt" else "slow-tesseract")
    try:
        subprocess.run([compiler, str(source), "-o", str(executable)], check=True,
                       capture_output=True, text=True)
    except subprocess.CalledProcessError:
        pytest.skip("gcc is installed but cannot link the test executable on this host")
    monkeypatch.setattr(pytesseract.pytesseract, "tesseract_cmd", str(executable))
    monkeypatch.setattr(api, "OCR_SUBPROCESS_TIMEOUT", 0.5)
    monkeypatch.setenv("OCR_TEST_PID_FILE", str(pid_file))
    image = Image.new("RGB", (20, 20), "white")
    temp_dir = Path(tempfile.gettempdir())
    temp_before = {p.name for p in temp_dir.glob("tess_*")}

    started = time.monotonic()
    with pytest.raises(RuntimeError, match="timeout"):
        api._run_ocr(pytesseract, image, "-l eng --psm 6")
    assert time.monotonic() - started < 5
    pid = int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    assert {p.name for p in temp_dir.glob("tess_*")} == temp_before


def test_real_child_process_is_killed_by_pytesseract_timeout_manager():
    import sys
    import pytesseract

    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    with pytest.raises(RuntimeError, match="timeout"):
        with pytesseract.pytesseract.timeout_manager(process, 0.4):
            pass
    assert process.poll() is not None


def test_ocr_language_config_reports_english_hindi_gujarati(monkeypatch):
    m = _mock_pytesseract({6: ("text", 95)})
    monkeypatch.setattr(api, "_OCR_TESSDATA_DIR", None)
    config = api.ocr_language_config(m)
    assert config == "-l eng+hin+guj"


def test_extract_image_ocr_missing_tesseract_returns_unavailable(tmp_path, monkeypatch):
    img = _make_image(size=(200, 100))
    img.save(tmp_path / "doc.png")
    monkeypatch.setattr(api, "configure_tesseract", lambda: None)
    text, label = api.extract_image_ocr(tmp_path / "doc.png")
    assert text == ""
    assert label == "ocr_unavailable"


def test_extract_image_ocr_corrupt_image_returns_unavailable(tmp_path, monkeypatch):
    corrupt = tmp_path / "corrupt.png"
    corrupt.write_bytes(b"not an image")
    _install_mock_pytesseract(monkeypatch, {6: ("", 0)})
    text, label = api.extract_image_ocr(corrupt)
    assert text == ""
    assert label == "ocr_unavailable"


def test_extract_scanned_pdf_missing_tesseract_returns_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "configure_tesseract", lambda: None)
    text, label = api.extract_scanned_pdf(tmp_path / "scan.pdf")
    assert text == ""
    assert label == "ocr_unavailable"


# ---------------- language preservation ----------------

def test_get_ocr_languages_reports_english_hindi_gujarati(monkeypatch):
    monkeypatch.setattr(
        api,
        "configure_tesseract",
        lambda: SimpleNamespace(
            get_languages=lambda config="": ["eng", "hin", "guj", "osd"]
        ),
    )
    monkeypatch.setattr(api, "_OCR_TESSDATA_DIR", None)
    assert api.get_ocr_languages() == ["eng", "hin", "guj"]


def test_get_ocr_languages_empty_when_tesseract_missing(monkeypatch):
    monkeypatch.setattr(api, "configure_tesseract", lambda: None)
    assert api.get_ocr_languages() == []

import asyncio


# ---------------- upload endpoint regression tests ----------------

GUEST = {"X-Guest-Id": "12345678-1234-1234-1234-1234567890ab"}


def _fake_extract_text(monkeypatch, text="extracted content", label="ocr"):
    def fake(path, suffix):
        return text, label

    monkeypatch.setattr(api, "extract_text", fake)


def _make_upload_file(tmp_path, name, content_bytes):
    p = tmp_path / name
    p.write_bytes(content_bytes)
    return p


def test_upload_jpg_returns_valid_json(tmp_path, monkeypatch):
    _fake_extract_text(monkeypatch, "JPG extracted text", "ocr")
    client = TestClient(api.app)
    img = _make_upload_file(tmp_path, "doc.jpg", b"\xff\xd8\xff\xe0fake jpg")
    with open(img, "rb") as f:
        r = client.post("/api/documents", files={"file": ("doc.jpg", f, "image/jpeg")}, headers=GUEST)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["id"]
    assert data["file_type"] == "JPG"
    assert data["status"] == "completed"


def test_upload_png_returns_valid_json(tmp_path, monkeypatch):
    _fake_extract_text(monkeypatch, "PNG extracted text", "ocr")
    client = TestClient(api.app)
    img = _make_upload_file(tmp_path, "doc.png", b"\x89PNG\r\n\x1a\nfake png")
    with open(img, "rb") as f:
        r = client.post("/api/documents", files={"file": ("doc.png", f, "image/png")}, headers=GUEST)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["file_type"] == "PNG"
    assert data["status"] == "completed"


def test_upload_pdf_returns_valid_json(tmp_path, monkeypatch):
    _fake_extract_text(monkeypatch, "PDF extracted text", "pdf_ocr")
    client = TestClient(api.app)
    pdf = _make_upload_file(tmp_path, "doc.pdf", b"%PDF-1.4 fake pdf")
    with open(pdf, "rb") as f:
        r = client.post("/api/documents", files={"file": ("doc.pdf", f, "application/pdf")}, headers=GUEST)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["file_type"] == "PDF"
    assert data["status"] == "completed"


def test_upload_docx_extracts_paragraph_text(tmp_path):
    from docx import Document

    path = tmp_path / "notice.docx"
    document = Document()
    document.add_paragraph("Submit the public form by 30 June.")
    document.save(path)
    client = TestClient(api.app)
    with path.open("rb") as stream:
        response = client.post("/api/documents", files={"file": (path.name, stream, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}, headers=GUEST)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "completed"
    assert response.json()["language"] == "en"


def test_upload_txt_returns_valid_json(tmp_path, monkeypatch):
    _fake_extract_text(monkeypatch, "TXT extracted text", "text")
    client = TestClient(api.app)
    txt = _make_upload_file(tmp_path, "doc.txt", b"plain text content")
    with open(txt, "rb") as f:
        r = client.post("/api/documents", files={"file": ("doc.txt", f, "text/plain")}, headers=GUEST)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["file_type"] == "TXT"
    assert data["status"] == "completed"


def test_upload_invalid_extension_returns_415(tmp_path, monkeypatch):
    client = TestClient(api.app)
    bad = _make_upload_file(tmp_path, "doc.xyz", b"not supported")
    with open(bad, "rb") as f:
        r = client.post("/api/documents", files={"file": ("doc.xyz", f, "application/octet-stream")}, headers=GUEST)
    assert r.status_code == 415, r.text


def test_upload_ocr_timeout_returns_504(tmp_path, monkeypatch):
    client = TestClient(api.app)

    async def _raise_timeout(awaitable, timeout=None):
        try:
            await awaitable
        except Exception:
            pass
        raise asyncio.TimeoutError()

    monkeypatch.setattr(api.asyncio, "wait_for", _raise_timeout)
    img = _make_upload_file(tmp_path, "doc.jpg", b"\xff\xd8\xff\xe0fake jpg")
    with open(img, "rb") as f:
        r = client.post("/api/documents", files={"file": ("doc.jpg", f, "image/jpeg")}, headers=GUEST)
    assert r.status_code == 504, r.text
    assert "timed out" in r.json()["detail"].lower()


def test_upload_ocr_subprocess_deadline_returns_504(tmp_path, monkeypatch):
    def timeout(path, suffix):
        raise api.OCRProcessingTimeout("Tesseract process timeout")

    monkeypatch.setattr(api, "extract_text", timeout)
    client = TestClient(api.app)
    img = _make_upload_file(tmp_path, "doc.jpg", b"\xff\xd8\xff\xe0fake jpg")
    with open(img, "rb") as f:
        response = client.post("/api/documents", files={"file": ("doc.jpg", f, "image/jpeg")}, headers=GUEST)
    assert response.status_code == 504
    assert "OCR timed out" in response.json()["detail"]


def test_upload_response_includes_measured_server_timing_stages(tmp_path, monkeypatch):
    def timed_extract(path, suffix):
        api._ocr_log("image_preprocessing", 0.012)
        api._ocr_log("tesseract_subprocess", 0.34)
        api._ocr_log("total_ocr_execution", 0.37)
        return "PUBLIC NOTICE", "ocr"

    monkeypatch.setattr(api, "extract_text", timed_extract)
    client = TestClient(api.app)
    image = _make_upload_file(tmp_path, "notice.jpg", b"\xff\xd8\xff\xe0fake jpg")
    with image.open("rb") as stream:
        response = client.post("/api/documents", files={"file": (image.name, stream, "image/jpeg")}, headers=GUEST)
    assert response.status_code == 200
    timing = response.headers["server-timing"]
    assert "ocr-image-preprocessing;dur=12.0" in timing
    assert "ocr-tesseract-subprocess;dur=340.0" in timing
    assert "ocr-total-ocr-execution;dur=370.0" in timing


def test_upload_ocr_subprocess_failure_returns_422(tmp_path, monkeypatch):
    def _boom(path, suffix):
        raise RuntimeError("tesseract crashed")

    monkeypatch.setattr(api, "extract_text", _boom)
    client = TestClient(api.app)
    img = _make_upload_file(tmp_path, "doc.jpg", b"\xff\xd8\xff\xe0fake jpg")
    with open(img, "rb") as f:
        r = client.post("/api/documents", files={"file": ("doc.jpg", f, "image/jpeg")}, headers=GUEST)
    assert r.status_code == 422, r.text


def test_upload_tesseract_missing_still_succeeds(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "configure_tesseract", lambda: None)
    client = TestClient(api.app)
    img = _make_upload_file(tmp_path, "doc.jpg", b"\xff\xd8\xff\xe0fake jpg")
    with open(img, "rb") as f:
        r = client.post("/api/documents", files={"file": ("doc.jpg", f, "image/jpeg")}, headers=GUEST)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == "needs_ocr"


def test_upload_large_image_bounded(tmp_path, monkeypatch):
    _fake_extract_text(monkeypatch, "large image text", "ocr")
    from PIL import Image as PILImage
    big = tmp_path / "big.jpg"
    PILImage.new("RGB", (3000, 3000), (255, 255, 255)).save(big, format="JPEG")
    client = TestClient(api.app)
    with open(big, "rb") as f:
        r = client.post("/api/documents", files={"file": ("big.jpg", f, "image/jpeg")}, headers=GUEST)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == "completed"


def test_upload_sequential_uploads_get_unique_ids(tmp_path, monkeypatch):
    _fake_extract_text(monkeypatch, "text", "ocr")
    client = TestClient(api.app)
    ids = []
    for i in range(2):
        img = _make_upload_file(tmp_path, f"doc{i}.jpg", b"\xff\xd8\xff\xe0fake jpg")
        with open(img, "rb") as f:
            r = client.post("/api/documents", files={"file": (f"doc{i}.jpg", f, "image/jpeg")}, headers=GUEST)
        assert r.status_code == 200, r.text
        ids.append(r.json()["id"])
    assert ids[0] != ids[1]


def test_concurrent_uploads_and_list_keep_event_loop_responsive(tmp_path, monkeypatch):
    import asyncio
    import time
    import httpx

    def slow_extract(path, suffix):
        time.sleep(0.25)
        return "concurrent OCR", "ocr"

    monkeypatch.setattr(api, "extract_text", slow_extract)

    async def exercise():
        transport = httpx.ASGITransport(app=api.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            async def upload(name):
                return await client.post("/api/documents", headers=GUEST,
                                         files={"file": (name, b"\xff\xd8\xffimage", "image/jpeg")})
            first = asyncio.create_task(upload("first.jpg"))
            second = asyncio.create_task(upload("second.jpg"))
            await asyncio.sleep(0.05)
            response = await client.get("/api/documents", headers=GUEST)
            assert response.status_code == 200
            a, b = await asyncio.gather(first, second)
            assert a.status_code == b.status_code == 200
            assert a.json()["id"] != b.json()["id"]

    asyncio.run(exercise())


def test_upload_response_preserves_full_text(tmp_path, monkeypatch):
    long_text = "word " * 10000
    _fake_extract_text(monkeypatch, long_text, "ocr")
    client = TestClient(api.app)
    img = _make_upload_file(tmp_path, "doc.jpg", b"\xff\xd8\xff\xe0fake jpg")
    with open(img, "rb") as f:
        r = client.post("/api/documents", files={"file": ("doc.jpg", f, "image/jpeg")}, headers=GUEST)
    assert r.status_code == 200, r.text
    data = r.json()
    doc_id = data["id"]
    detail = client.get(f"/api/documents/{doc_id}", headers=GUEST)
    assert detail.status_code == 200, detail.text
    assert detail.json()["text"] == long_text[:500_000]
