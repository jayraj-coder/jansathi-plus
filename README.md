# JanSathi Plus
JanSathi Plus is a multilingual document-assistance platform that helps people understand official documents in English, Hindi, and Gujarati. It includes a web application, an Expo-based mobile application, and a shared FastAPI backend for document processing and AI-powered assistance.

## Start locally

Requirements: Python 3.11 or newer.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env   # only when you do not already have a local .env
uvicorn backend.main:app --reload
```

Open http://127.0.0.1:8000. API documentation is available at http://127.0.0.1:8000/docs and health status at `/api/health`. See [API.md](API.md) for endpoint contracts, session behavior, schemas, and the processing flow.

Run the backend contract tests with `pip install -r requirements-dev.txt` and `python -m pytest`.

## Live MVP

Production: [jansathi-plus.onrender.com](https://jansathi-plus.onrender.com). The health endpoint reports MongoDB, AI, and OCR configuration. On 22 November 2026 it reported MongoDB connected, Groq configured, and `eng`, `hin`, and `guj` OCR data available. A generated, non-sensitive public-notice image uploaded and retrieved successfully. Production files are stored on local service disk, which may be ephemeral across Render restarts or redeploys; Atlas stores extracted document records.

Hackathon presentation content and a truthful demo outline are collected in [IDEAFORGE_SUBMISSION.md](IDEAFORGE_SUBMISSION.md). This is preparation material; it is not a submitted entry.

## Configuration

The backend reads `.env` from the project root. Keep that file private; it is ignored by Git. `MONGODB_URI` and `MONGODB_DATABASE` configure Atlas. If Atlas is unavailable at startup, documents are kept in a process-local development store and will be lost when the server restarts. The API health response reports the active database connection state.

Set `GROQ_API_KEY` and `GROQ_MODEL` for the primary AI provider. Gemini is the configured fallback through `GEMINI_API_KEY` and `GEMINI_MODEL`. Keys are only read by Python and are never included in frontend assets. Email and account sign-in are not part of this initial build.

## Documents and privacy

Supported formats: PDF, TXT, DOCX, PNG, JPG, and JPEG. The upload size limit defaults to 20 MB. Files are stored under `data/uploads`. Text PDFs, TXT, and DOCX files are extracted locally. OCR for image-only PDFs and images needs Tesseract plus the Python `pytesseract` package; until configured, such items are marked `needs_ocr`, and the UI does not claim their text was read. Guest documents are scoped to a random browser session identifier; clearing browser storage loses that identifier. Production use should add authenticated sessions, durable storage, retention controls, HTTPS, and secret management.

## API

- `GET /api/health`
- `POST /api/documents` (multipart field `file`)
- `GET /api/documents` (optional `q` and `kind=pdf` filters)
- `GET /api/documents/{id}`
- `GET /api/documents/{id}/file`
- `DELETE /api/documents/{id}`
- `GET /api/profile`
- `PUT /api/profile` (`first_name`, `last_name`, `language`, `theme`)
- `POST /api/chat` (`message`, optional `document_id`, and `language`)

Document, profile, and chat endpoints require the browser's guest session header `X-Guest-Id`. Guest profiles store first and last name plus language and theme preferences in the `profiles` collection; guest email is read-only and unavailable until a verified account system exists. Profile data is isolated by guest session, but this guest identifier is not a replacement for authenticated production accounts. The current chat sends selected document text as bounded context and asks the provider not to invent facts or citations. Conversation persistence and streaming are not implemented yet.

## Current implementation limits

The UI includes landing, history, PDF Library, Ask JanSathi, language selector, persistent theme, upload, document overview, and a floating assistant. Language metadata is conservatively inferred from extracted text and may remain `und` when text is sparse or OCR is ambiguous; it is not a general-purpose language identifier. Email authentication, saved conversations, vector retrieval for long documents, and automatic OCR installation remain future work. Document Overview is an extractive summary, and AI explanations may be incomplete; users should verify deadlines and eligibility with the issuing authority. The application does not make official eligibility decisions or represent a government service.
# Mobile application

The separate Expo client lives in [mobile/README.md](mobile/README.md). It uses this API and the same MongoDB / AI provider configuration; keep server secrets in the root `.env`, never the mobile app's public `EXPO_PUBLIC_API_URL` value.


