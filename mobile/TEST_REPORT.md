# JanSathi Mobile Verification

Verification date: 2026-11-21. This report distinguishes API/bundle checks from native device checks.

## PASS

- TypeScript: `npm run typecheck`.
- Lint: `npm run lint`.
- Expo project diagnostics: `npx expo-doctor` — 20/20 checks.
- Android JavaScript bundle: `npx expo export --platform android` — exported successfully. This is not an APK or a native device build.
- Dependency audit: `npm audit` — 0 vulnerabilities after pinning the affected Expo fingerprint dependency's `minimatch` to a patched compatible release; no Expo SDK downgrade.
- Backend Python compile and test suite: `python -m py_compile backend/main.py`; `python -m pytest -q` — 9 passed; `python -m pip check` — no broken requirements.
- Live backend health: Atlas `connected`, Groq configured as primary, OCR configured for `eng`, `hin`, and `guj`.
- Real OCR through the running API: English, Hindi, and Gujarati PNG notices and an image-only/scanned PDF each uploaded, extracted text returned on detail, and processing status was `completed`.
- Live document-scoped `/api/chat`: the same test guest/document received non-empty responses in English, Hindi, and Gujarati; the provider returned `groq` for each.
- MongoDB test data: all temporary integration documents were deleted after the checks.
- Mobile source credential scan: no MongoDB URI, Groq key, or Gemini key found.
- Existing backend access-isolation and contract suite: 9/9 tests passed; frontend source was not changed.

## BLOCKED — requires a native device or emulator

- Installing and opening the app on Android/iOS.
- Native document picker interaction and platform-specific file preview behavior.
- Camera permission prompt, live scanner capture, flash control, edge detection, crop/perspective correction, rotate, multi-page scan, retake, and post-scan review.
- Physical-device connection to a development computer over Wi-Fi.

This workspace has no Android SDK, `adb`, emulator, physical test device, or Xcode/macOS. The native scanner uses Expo Camera's system document scanner API (Android ML Kit / iOS VisionKit); the JavaScript bundle compiles, but scanner behavior is not represented as physically verified.

## NOT TESTED on a running native UI

- On-device language picker interaction and SecureStore persistence for language/theme/session UUID.
- Visual layout, keyboard resizing/scroll behavior, animations/reduced-motion setting, and light/dark/system theme rendering on device.
- Native upload progress events, error display/retry controls, and in-app rotate interaction.
- Full mobile UI workflow from picker/scanner through workspace and chat. API calls were verified independently against the same live service.

## Current backend/mobile readiness

The shared backend is ready for **development mobile integration**: the current API process runs on `127.0.0.1:8000`, Atlas is connected, Groq chat works, guest-scoped upload/detail/chat contracts were exercised, and English/Hindi/Gujarati OCR is configured and verified.

For an Android emulator, use `http://10.0.2.2:8000`; for an iOS simulator use `http://127.0.0.1:8000`; for a physical phone configure `EXPO_PUBLIC_API_URL` to the computer's LAN address and bind Uvicorn to `0.0.0.0`. Before production or cross-device sensitive use, add authenticated server-issued sessions, HTTPS, and shared object storage. See [API_INTEGRATION.md](API_INTEGRATION.md) and the repository's [API.md](../API.md).
