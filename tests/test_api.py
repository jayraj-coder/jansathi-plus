"""FastAPI contract tests using isolated in-memory storage and temporary files.

The separate manual smoke check exercises the configured Atlas and live Groq provider.
"""

import uuid

import pytest
from fastapi.testclient import TestClient

from backend import main as api


@pytest.fixture
def app_client(monkeypatch, tmp_path):
    monkeypatch.setattr(api, "documents", None)
    monkeypatch.setattr(api, "profiles", None)
    monkeypatch.setattr(api, "memory_docs", {})
    monkeypatch.setattr(api, "memory_profiles", {})
    monkeypatch.setattr(api, "STORAGE", tmp_path)
    return TestClient(api.app)


def guest_headers():
    return {"X-Guest-Id": str(uuid.uuid4())}


def test_upload_extracts_lists_and_opens_text_file(app_client):
    headers = guest_headers()
    upload = app_client.post(
        "/api/documents",
        headers=headers,
        files={"file": ("notice.txt", b"Submit the form by 20 August.", "text/plain")},
    )
    assert upload.status_code == 200
    record = upload.json()
    assert record["status"] == "completed"
    assert "20 August" in record["overview"]
    assert record["language"] == "en"
    assert "owner_id" not in record
    assert len(app_client.get("/api/documents", headers=headers).json()) == 1
    assert app_client.get(f"/api/documents/{record['id']}/file", headers=headers).content == b"Submit the form by 20 August."


def test_document_access_and_delete_are_guest_scoped(app_client):
    owner = guest_headers()
    other_guest = guest_headers()
    record = app_client.post(
        "/api/documents",
        headers=owner,
        files={"file": ("private.txt", b"Private content.", "text/plain")},
    ).json()
    path = api.memory_docs[record["id"]]["path"]
    detail = app_client.get(f"/api/documents/{record['id']}", headers=owner)
    assert detail.status_code == 200
    assert "owner_id" not in detail.json()
    assert detail.json()["text"] == "Private content."
    assert app_client.get(f"/api/documents/{record['id']}", headers=other_guest).status_code == 404
    assert app_client.delete(f"/api/documents/{record['id']}", headers=other_guest).status_code == 404
    assert app_client.delete(f"/api/documents/{record['id']}", headers=owner).json() == {"deleted": True}
    assert app_client.get(f"/api/documents/{record['id']}", headers=owner).status_code == 404
    assert not api.Path(path).exists()


def test_profile_update_persists_and_validates(app_client):
    owner = guest_headers()
    other_guest = guest_headers()
    payload = {"first_name": "Asha", "last_name": "Patel", "language": "gu", "theme": "light"}
    assert app_client.put("/api/profile", headers=owner, json=payload).status_code == 200
    assert app_client.get("/api/profile", headers=owner).json()["first_name"] == "Asha"
    isolated = app_client.get("/api/profile", headers=other_guest).json()
    assert isolated["first_name"] == ""
    assert isolated["email"] is None
    assert app_client.put("/api/profile", headers=owner, json={**payload, "language": "fr"}).status_code == 422


def test_chat_uses_owned_document_context(app_client, monkeypatch):
    headers = guest_headers()
    record = app_client.post(
        "/api/documents",
        headers=headers,
        files={"file": ("terms.txt", b"The unique code is PLUM-6042.", "text/plain")},
    ).json()
    seen = {}

    async def fake_ai(provider, question, context, language):
        seen.update(provider=provider, question=question, context=context, language=language)
        return "The document says PLUM-6042."

    monkeypatch.setattr(api, "call_ai", fake_ai)
    response = app_client.post(
        "/api/chat",
        headers=headers,
        json={"message": "What is the unique code?", "document_id": record["id"], "language": "en"},
    )
    assert response.status_code == 200
    assert "owner_id" not in response.json()
    assert "PLUM-6042" in seen["context"]
    assert response.json()["answer"] == "The document says PLUM-6042."


def test_upload_rejects_unsupported_file(app_client):
    response = app_client.post(
        "/api/documents",
        headers=guest_headers(),
        files={"file": ("payload.exe", b"not supported", "application/octet-stream")},
    )
    assert response.status_code == 415


def test_upload_rejects_mismatched_file_signature(app_client):
    response = app_client.post(
        "/api/documents",
        headers=guest_headers(),
        files={"file": ("not-a-pdf.pdf", b"plain text, not a PDF", "application/pdf")},
    )
    assert response.status_code == 415
    assert response.json()["detail"] == "The file content does not match its extension."


def test_upload_enforces_configured_size_limit(app_client, monkeypatch):
    monkeypatch.setattr(api, "MAX_BYTES", 8)
    response = app_client.post(
        "/api/documents",
        headers=guest_headers(),
        files={"file": ("large.txt", b"more than eight bytes", "text/plain")},
    )
    assert response.status_code == 413


def test_database_insert_failure_returns_503_and_removes_uploaded_file(app_client, monkeypatch):
    class FailingCollection:
        def insert_one(self, record):
            raise api.PyMongoError("insert failed")

    monkeypatch.setattr(api, "documents", FailingCollection())
    response = app_client.post(
        "/api/documents",
        headers=guest_headers(),
        files={"file": ("notice.txt", b"A public notice with an application date.", "text/plain")},
    )
    assert response.status_code == 503
    assert list(api.STORAGE.iterdir()) == []


def test_empty_text_file_is_not_reported_as_ocr_needed(app_client):
    response = app_client.post(
        "/api/documents",
        headers=guest_headers(),
        files={"file": ("empty.txt", b"", "text/plain")},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "no_text"


def test_chat_rejects_unsupported_language(app_client):
    response = app_client.post(
        "/api/chat",
        headers=guest_headers(),
        json={"message": "A question", "language": "fr"},
    )
    assert response.status_code == 422
