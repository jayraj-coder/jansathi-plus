from __future__ import annotations

import logging
import shlex
import subprocess
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from backend import main as api


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
