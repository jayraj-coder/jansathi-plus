# JanSathi Plus Mobile

Separate React Native application using Expo SDK 58, React Native 0.88, and the existing JanSathi FastAPI service. Desktop source is untouched. This app has only document intake, a document workspace, and a document-scoped Ask JanSathi screen; it does not add login, profile, history, or a PDF library.

## Requirements and setup

- Node.js 22 (the workspace was verified with 22.23.1) and npm.
- The existing FastAPI service and Atlas configuration. Do not put MongoDB credentials or AI keys in the app.
- For local OCR, install Tesseract 5 and the `eng`, `hin`, and `guj` trained data. See the repository-level API docs for server configuration.
- Android Studio with Android SDK / emulator, or a physical Android device. iOS native builds require macOS and Xcode.

```powershell
cd mobile
npm install
Copy-Item .env.example .env
# Set EXPO_PUBLIC_API_URL to a backend address reachable from this target.
npx expo install --check
npm run typecheck
npm run lint
npx expo-doctor
npx expo start
```

Use `npm run android` for an available Android emulator, or scan the Expo QR code with a compatible Expo Go app. To build and launch a local Android development client with the configured native permissions/plugins, install Android Studio and its SDK, then run `npx expo prebuild --platform android` and `npx expo run:android`. The OS document scanner launches its own native capture/review UI (Android ML Kit / iOS VisionKit): live camera preview, edge detection, crop/perspective correction, rotate and multi-page capture are handled there. The app shows a preview and asks for confirmation before sending the resulting PDF to the server. A single image can also be rotated in-app.

`npm run ios` works only on macOS with Xcode. For a local iOS development build, run `npx expo prebuild --platform ios` and `npx expo run:ios` on macOS. For cloud native builds, configure EAS and build in your own Expo account; this repository does not publish or deploy anything.

## API address

Set `EXPO_PUBLIC_API_URL` in `mobile/.env` (the value is public configuration, never a secret). Defaults support Android emulator (`http://10.0.2.2:8000`) and iOS simulator (`http://127.0.0.1:8000`). On a physical device, use the computer's LAN IP, make sure both devices can reach each other, and bind the development API to the LAN interface. Release builds must use HTTPS. `usesCleartextTraffic` is enabled for this development MVP; remove it and use HTTPS for a production build.

## Session and privacy

The app creates a cryptographically random UUID and stores it in `expo-secure-store`, then sends `X-Guest-Id` to the existing API. This is an anonymous guest scope, not authentication: anyone who obtains the ID can impersonate that guest. Reinstall behavior differs by OS (Android storage is removed; iOS Keychain data may survive reinstall), so this is not a secure account or guaranteed cross-device identity. No API keys, MongoDB URI, or AI credentials are included in the mobile bundle. Chat turns are held in app memory only and are not persisted by the backend.

Theme (`system`, `light`, `dark`) and language (`en`, `hi`, `gu`) are stored locally. Every chat request sends the chosen language. A real `/api/chat` call produces the selected-language document overview; if AI is unavailable, the app falls back to the server's extractive overview and the chat displays an error/retry.

## Supported file types

PDF, TXT, DOCX, PNG, JPG, JPEG, limited by the backend's current 20 MiB upload ceiling. Upload is multipart `file`; progress comes from native `XMLHttpRequest` transfer events. Backend extraction is synchronous. Images and scanned PDFs use server-side Tesseract; the API response indicates when no text could be extracted. Scanned PDF OCR currently covers the first 20 pages.

## Checks

```powershell
npm run typecheck
npm run lint
npx expo export --platform android
npx expo-doctor
```

Device testing still requires an Android/iOS device or emulator with camera hardware/permissions; a Metro bundle or web run does not verify camera behavior.
