# Mobile API contract

The app calls the existing FastAPI service. It does not connect to MongoDB or Groq directly. Full schemas and backend constraints are in [../API.md](../API.md); OpenAPI is available from the running server at `/openapi.json`.

## Session behavior

Every endpoint except `GET /api/health` and the public documentation routes uses `X-Guest-Id`. Mobile generates a UUID with Expo Crypto and persists it in SecureStore. The backend checks only a UUID-shaped string and uses it as a data scope; it is not authentication or a server-issued token. A stolen guest ID is replayable. Mobile installs are isolated because each installation creates its own value. No MongoDB URI, Groq key, or Gemini key is present in the app bundle.

## Existing endpoints

| Method / path | Request | Response | Mobile use |
|---|---|---|---|
| `GET /api/health` | No header/body | `{status,database,ai_primary,ai_configured,ocr_configured,ocr_languages,max_upload_bytes}` | Connectivity and server capability check; no session |
| `POST /api/documents` | `X-Guest-Id`; multipart `file` | Public document metadata plus `status`, `language`, `extraction`, and `overview`; no text/path/owner | Upload, synchronous extraction, persistence |
| `GET /api/documents` | Header; optional `q`, `kind=pdf` | Array of public document metadata | Existing API; mobile intentionally has no History/library screen |
| `GET /api/documents/{id}` | Header, path ID | Public metadata plus extracted `text` and `overview` | Fetch document context/overview after upload |
| `GET /api/documents/{id}/file` | Header, path ID | Original file bytes with media type and filename | Existing API; mobile does not currently request a download |
| `DELETE /api/documents/{id}` | Header, path ID | `{"deleted":true}` | Existing API; no delete control in current workspace |
| `GET /api/profile` | Header | `{first_name,last_name,email,language,theme,has_profile}` | Existing API; mobile intentionally has no profile |
| `PUT /api/profile` | Header; JSON `{first_name?,last_name?,language?,theme?}` | Saved fields plus `email:null,has_profile:true` | Existing API; mobile stores language/theme locally |
| `POST /api/chat` | Header; JSON `{message,document_id?,language?}` | `{answer,provider,sources}` | AI overview and document-scoped chat; backend uses Groq then Gemini fallback |
| `GET /docs`, `GET /redoc`, `GET /openapi.json` | No header | HTML / JSON API documentation | Public server docs |

### Mobile request details

`POST /api/documents` accepts `multipart/form-data` with one field named `file`. Accepted extensions: PDF, TXT, DOCX, PNG, JPG, JPEG. Maximum size currently 20 MiB. Upload is performed by `XMLHttpRequest`; displayed transfer percentage is only shown when the platform reports a computable byte total. When transfer completes, the API still performs synchronous extraction and storage before returning.

`POST /api/chat` sends JSON:

```json
{
  "message": "What date is listed as the deadline?",
  "document_id": "document-id-from-upload",
  "language": "gu"
}
```

`language` must be `en`, `hi`, or `gu`; message length is 1–10,000 characters. When a document ID is present, the API checks that the guest owns it and supplies up to 22,000 characters of extracted text to the model. `provider` identifies the provider that answered; it is not a citation. `sources` only identifies uploaded-document context.

The app makes a second real `/api/chat` request after extraction to generate a short overview in the selected language. The prompt asks the model to mention only dates/actions/requirements that appear in extracted text. On AI failure it falls back to the API's extractive, first-three-sentence overview; that fallback may remain in the document's original language. Chat messages stay in mobile memory and are not persisted.

## Errors

The API commonly returns `401` for a missing/malformed guest header, `404` for missing or non-owned documents, `413` for a too-large upload, `415` for unsupported type or content mismatch, `422` for invalid input/processing failure, and `503` for unavailable database/AI services. JSON errors normally use `{ "detail": "..." }`. Upload and chat expose retry actions; no client-side ownership check substitutes for server checks.

## Processing workflow

1. Native picker or camera scanner creates a local file. The native scanner captures pages, edge-detects, crops/perspective-corrects, and asks for review; app requires a separate upload confirmation.
2. App sends one multipart upload to the shared API with the per-install guest ID.
3. API streams to its configured local file storage while enforcing the size ceiling and signature checks.
4. API extracts TXT/PDF/DOCX text; images and scanned PDF pages use Tesseract if the engine and configured language data are available. Scanned PDFs OCR at most 20 pages.
5. API caps extracted text at 500,000 characters, creates an extractive overview, stores metadata/text in MongoDB, and returns. A mobile `/api/chat` call creates the localized overview; document-scoped chat uses the same stored text and shared Groq/Gemini server integration.

The existing API uses local disk for originals and one API process. The mobile client shares the database and service, but files are not available across multiple API hosts without shared object storage. Atlas connectivity is reported by health; an in-memory backend fallback is not durable.

## Known limits

- The guest ID is a replayable anonymous scope, not authentication. The API has no session-issuance or account endpoint.
- The backend's summary is extractive; localized overview and chat rely on configured AI provider calls and can fail.
- Server `language` metadata remains `und`; OCR is configured for English, Hindi, and Gujarati but does not classify language.
- The app has no conversation-history endpoint, History, PDF library, profile, or login.
- Physical camera verification requires an Android/iOS device. The source was bundled, but no Android SDK/emulator or macOS/Xcode is installed in this workspace.
