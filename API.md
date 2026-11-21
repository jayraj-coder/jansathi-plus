# JanSathi HTTP API

Base URL for local development: `http://127.0.0.1:8000`. FastAPI serves interactive Swagger UI at `/docs`, ReDoc at `/redoc`, and the OpenAPI document at `/openapi.json`.

## Session and authorization

The browser creates a random UUID in `localStorage` under `js-guest-id` and sends it as `X-Guest-Id` on API requests. The backend requires a 36-character lowercase UUID-like value and scopes documents and profiles by that value. Missing or malformed values return `401`.

This is **guest-session scoping**, not authenticated identity: the server does not issue or cryptographically validate a session token. A person who obtains another browser's identifier can act as that guest. Use an authenticated, server-issued session before production use or before treating guest identity as sufficient for sensitive cross-device access. Never send the MongoDB URI or AI keys from a client.

## Common responses and errors

- JSON endpoints return `application/json`.
- File download/preview returns the stored file with its detected media type.
- Standard errors use `{"detail":"message"}`. Pydantic input validation returns HTTP `422` with FastAPI's validation detail array.
- Common statuses: `200` success, `401` missing/invalid guest header, `404` missing or not-owned document, `413` upload exceeds configured size, `415` unsupported type or mismatched file signature, `422` processing failure or invalid request, and `503` storage/AI unavailable.
- CORS allows configured `CORS_ORIGINS` and `GET`, `POST`, `PUT`, `DELETE`. Native mobile clients do not use browser CORS, but must send the session header.

## Endpoint index

| Method and path | Session header | Purpose |
|---|---:|---|
| `GET /api/health` | No | API, configured database state, AI configuration, upload limit |
| `POST /api/documents` | Yes | Validate, store, extract, and summarize one document |
| `GET /api/documents` | Yes | List this guest's documents; optional title/type filters |
| `GET /api/documents/{id}` | Yes | Return document metadata, overview, and extracted text |
| `GET /api/documents/{id}/file` | Yes | Open/download the original file |
| `DELETE /api/documents/{id}` | Yes | Delete an owned document and its stored file |
| `GET /api/profile` | Yes | Read this guest's profile/preferences |
| `PUT /api/profile` | Yes | Create/update guest name and preferences |
| `POST /api/chat` | Yes | Ask JanSathi, optionally against an owned document |
| `GET /docs`, `/redoc`, `/openapi.json` | No | Interactive or machine-readable API documentation |

## Schemas

### `GET /api/health`

No request body or session header.

```json
{
  "status": "ok",
  "database": "connected",
  "ai_primary": "groq",
  "ai_configured": true,
  "ocr_configured": true,
  "ocr_languages": ["eng", "hin", "guj"],
  "max_upload_bytes": 20971520
}
```

`database` reports `connected`, `not_configured`, or `unavailable: <exception type>`. `status: ok` is a liveness result; clients should inspect `database` before assuming durable persistence. `ai_configured` indicates that at least one key is set; it does not prove that a provider request will succeed.
`ocr_configured` indicates Tesseract can be invoked with at least one requested trained model. `ocr_languages` lists the available subset of `eng`, `hin`, and `guj`. Empty/missing trained data means image OCR cannot be claimed.

### `POST /api/documents`

Request: `multipart/form-data`, with one `file` field. Allowed extensions: `.pdf`, `.txt`, `.docx`, `.png`, `.jpg`, `.jpeg`. The size ceiling is `MAX_UPLOAD_BYTES` (defaults to 20 MiB). PDF, DOCX, PNG, and JPEG signatures are checked. TXT is decoded as UTF-8 with replacement for invalid byte sequences.

On successful extraction, a public document response has this shape (IDs and values are examples):

```json
{
  "id": "f4a5f61bbef340e4be646c55ed6e1649",
  "title": "notice.txt",
  "filename": "notice.txt",
  "file_type": "TXT",
  "mime_type": "text/plain",
  "size": 82,
  "created_at": "2026-11-21T12:00:00+00:00",
  "status": "completed",
  "language": "und",
  "extraction": "text",
  "overview": "Submit the form by the date printed on your notice."
}
```

`status` is `completed` when text was extracted, `needs_ocr` when the image/scanned-PDF OCR path could not extract text, and `no_text` for empty TXT/DOCX. `language` is currently `und` (undetermined); automatic language detection is not implemented. API response excludes the owner ID, storage path, and full extracted text.

### `GET /api/documents`

Optional query parameters: `q` (case-insensitive title substring) and `kind=pdf` (PDF-only filter). Returns a newest-first JSON array of the same public metadata schema as upload; limited to 500 records per guest.

### `GET /api/documents/{id}`

Returns the public metadata schema plus `text` (extracted text, capped at 500,000 characters) and `overview`. No owner ID or filesystem path is returned. A record owned by another guest returns the same `404` as a nonexistent record.

### `GET /api/documents/{id}/file`

Returns the original stored file with its media type and filename. A different guest cannot access it. Missing/deleted storage files return `404`.

### `DELETE /api/documents/{id}`

No request body. Deletes the metadata record first, then removes its file. A different guest receives `404`. Success:

```json
{"deleted": true}
```

### `GET /api/profile`

No request body. Example response:

```json
{
  "first_name": "Asha",
  "last_name": "Patel",
  "email": null,
  "language": "gu",
  "theme": "light",
  "has_profile": true
}
```

An unconfigured guest receives empty names, `email: null`, default `en`/`dark` preferences, and `has_profile: false`.

### `PUT /api/profile`

JSON request; fields are optional in the server schema and default as shown. Names are trimmed and limited to 60 characters. Language and theme are enumerated.

```json
{
  "first_name": "Asha",
  "last_name": "Patel",
  "language": "gu",
  "theme": "light"
}
```

`language`: `en | hi | gu`; `theme`: `dark | light`. Success returns the saved fields, `email: null`, and `has_profile: true`. Email changes are not accepted. Profiles are stored in MongoDB collection `profiles`, uniquely indexed by `owner_id`.

### `POST /api/chat`

JSON request. `message` is required (1–10,000 characters); whitespace-only messages return `400`. `document_id` is optional (maximum 64 characters). `language` defaults to `en` and accepts `en | hi | gu`.

```json
{
  "message": "What is the application deadline?",
  "document_id": "f4a5f61bbef340e4be646c55ed6e1649",
  "language": "en"
}
```

Success:

```json
{
  "answer": "The document says the deadline is ...",
  "provider": "groq",
  "sources": ["Uploaded document"]
}
```

If `document_id` is present, the document must belong to the guest. The backend sends up to 22,000 characters of extracted text as model context. A document not owned by the guest returns `404`; unavailable configured providers return `503`. `sources` currently signals document context only; it is not a page-level citation system.

## Document-processing workflow

1. The API streams the uploaded body to local `STORAGE_PATH` while enforcing the configured byte limit.
2. The extension is allow-listed; binary document signatures are checked before parsing.
3. TXT is decoded directly; PDF text is read with `pypdf`; DOCX paragraphs are read with `python-docx`; images use `pytesseract` plus the system Tesseract 5 binary and the configured `eng`, `hin`, and `guj` traineddata. If a PDF contains no text layer, pages are rendered and OCR is attempted on up to the first 20 pages.
4. Extracted text is capped at 500,000 characters. The overview is an extractive first-three-sentence summary capped at 950 characters; it is not an AI-generated analysis.
5. Metadata and extracted text are stored in MongoDB, while original files are stored on disk under `data/uploads` by default. The upload response is returned only after processing and metadata storage complete.
6. Without Tesseract or at least one configured language model, images and scanned PDFs do not claim successful extraction; their state is `needs_ocr`. Empty TXT/DOCX returns `no_text`.

### OCR server setup

Install Tesseract 5 on the API host, install the `eng`, `hin`, and `guj` traineddata files, and install the Python dependencies from `requirements.txt`. The backend defaults to `TESSERACT_LANGS=eng+hin+guj`, checks `TESSERACT_CMD` first, then common Windows install paths, then `PATH`; `TESSDATA_DIR` defaults to `data/tessdata` and is used when that folder exists. Set these in the server environment when paths differ. `GET /api/health` reports actual model availability. A setup helper downloads official fast models:

```powershell
.\scripts\setup_ocr.ps1
```

Restart the API process after installing or changing the engine or language files.

This implementation uses a single API process and local disk paths. A multi-instance deployment must replace those paths with shared object storage. If Atlas is unreachable at startup, the development fallback is process-local memory and is not durable.

## Integration constraints

The desktop frontend uses `X-Guest-Id` from browser local storage. The mobile client uses a randomly generated UUID stored in native secure storage. Both use the same API header and schemas; guest IDs are independent between installations. The header is not a production authentication mechanism. Before real multi-device/user production use, add authenticated server-issued sessions and shared file storage. Conversation history is currently held in the client and is not an API resource. See [mobile integration and testing notes](mobile/API_INTEGRATION.md).
