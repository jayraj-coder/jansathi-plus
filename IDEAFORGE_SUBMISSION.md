# IDEA//FORGE 2026 Submission Preparation

**Track:** Track 1 — Civic Pulse, Digital Governance & Public Information  
**Project:** JanSathi Plus  
**MVP:** https://jansathi-plus.onrender.com  
**Repository:** https://github.com/jayraj-coder/jansathi-plus

## Project summary

**Tagline:** Government documents, in your language.

**Problem statement:** Citizens who need to act on government notices, welfare scheme documents, and public information often face dense official language and language barriers. This makes deadlines, requested actions, and important details harder to find and understand.

**Target users:** People reading public notices, welfare scheme documents, and other official information, especially readers who prefer English, Hindi, or Gujarati.

**Why it matters:** Missing a date or misunderstanding a requirement can make it harder for someone to follow up on public services or understand their options. JanSathi Plus helps make the uploaded document easier to read; it does not provide government approval or replace official advice.

**Solution:** JanSathi Plus accepts PDF, scanned PDF, image, TXT, and DOCX documents. It extracts text locally, presents an extractive overview, and lets users ask an AI assistant questions grounded in the selected document. The web app supports English, Hindi, and Gujarati UI preferences; OCR uses the installed English, Hindi, and Gujarati Tesseract models.

## Features

- Upload and process PDF, scanned PDF, JPG, PNG, TXT, and DOCX files.
- Extract text from selectable PDFs and office documents; use Tesseract OCR for images and scanned pages.
- Show document history, a short overview, and document-grounded question answering.
- Keep records scoped to a browser guest-session ID.
- Use Groq as the configured primary AI provider and Gemini as the configured fallback path when available.

## AI use

OCR turns document images into text. The AI assistant receives the user's question and, when a document is selected, up to a bounded portion of that document as context. Its instructions ask it to distinguish uncertainty, avoid inventing citations, and say when the answer is absent from the document. The overview itself is an extractive summary, not an AI eligibility decision. AI answers can still be wrong and should be checked against the issuing authority for important deadlines and eligibility.

## Technology

Python 3.12, FastAPI, MongoDB Atlas, Groq API, Gemini API fallback, pytesseract, Tesseract OCR, Pillow, pypdf, pypdfium2, python-docx, HTML, CSS, JavaScript, Docker, and Render.

## Differentiation

JanSathi Plus combines multilingual document intake, OCR for scanned material, an immediate short overview, and a document-grounded question flow in one lightweight web application. It is designed to explain what an uploaded document says, while clearly leaving official decisions to the relevant authority.

## Demo plan

1. Open the production MVP and select a safe public notice.
2. Upload it and show the extracted overview.
3. Ask a question about a date or requested action and point to the document context.
4. Switch the interface language and explain that OCR text extraction and AI explanation are separate steps.
5. State the limitations: OCR can make mistakes, AI can be incomplete, and official eligibility decisions remain with the issuing authority.

**Demo video:** Not recorded. Add a public video link only if the actual Challazo form requires one.

## Credits

The project uses open-source Python and frontend libraries listed in `requirements.txt`, Tesseract OCR and its English/Hindi/Gujarati traineddata packages, MongoDB Atlas, Groq, Google Gemini, Docker, and Render. Follow each upstream project's license and attribution requirements when redistributing or presenting the project.

## Limitations to disclose

- OCR accuracy depends on image quality, typography, layout, and the language models; this project has no validated accuracy percentage.
- Language metadata is inferred from extracted scripts and a small English vocabulary check and may be `und` or reflect OCR errors.
- The overview is extractive; the AI response is assistance, not an official determination.
- Browser guest IDs are not authenticated accounts.
- Uploaded originals are on Render local disk and may not survive service restart or redeploy; extracted records are stored in MongoDB Atlas.

## Submission status

This file is preparation material, not a submitted entry. The [IDEA//FORGE participation guide](https://docs.google.com/document/d/1dHVb7Yq5GC5QG3crKq1v24FYWGdItNaSrXNty01Lj2o/edit) says to register on [Challazo](https://challazo.in), select “NxtWave Academy Online” as the college, run the Readiness Check if available, and submit by 22 November 2026 at 11:59 PM IST. The provided short link currently redirects to the guide document itself. Challazo's public landing page currently says there are no open hackathons, so the event's actual authenticated submission form and required fields could not be verified publicly. Confirm registration and the form in the participant's signed-in Challazo account before submitting.
