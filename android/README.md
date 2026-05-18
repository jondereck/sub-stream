# Sub Stream AI Android

Android app scaffold for phone/tablet subtitles. It is separate from the Chrome extension because Android cannot run the desktop extension APIs used by the browser version: `tabCapture`, `offscreen`, and `nativeMessaging`.

## What Works In This App

- Cloud Realtime mode streams captured app audio to the existing Sub Stream AI backend WebSocket.
- Local Whisper mode uses `whisper.cpp` through Android NDK/JNI with `tiny` as the default model and `base` as the quality option.
- A foreground `MediaProjection` service captures playback audio from apps that allow Android playback capture.
- A system overlay displays subtitles above other apps.
- Optional `SUBSTREAM_MOBILE_TOKEN` protects Android WebSocket config and `/translate` calls.

## Required Tooling

Install Android Studio first, then install these SDK packages from SDK Manager:

- Android SDK Platform 35
- Android SDK Build-Tools 35.x
- Android SDK Platform-Tools
- Android NDK
- CMake 3.22.1 or newer

This checkout currently cannot be built from the terminal until `gradle`/Android Studio and `adb` are installed and on PATH.

## Build

Open the `android/` folder in Android Studio and run the `app` configuration on a physical Android 10+ device.

The app has `minSdk = 29` because `AudioPlaybackCapture` starts on Android 10.

## Backend For Cloud Mode

Run the backend on your PC and bind to all interfaces:

```powershell
$env:KAMI_HOST="0.0.0.0"
$env:SUBSTREAM_MOBILE_TOKEN="choose-a-local-token"
python backend/server.py
```

In the Android app, set:

```text
Backend URL: ws://<your-pc-lan-ip>:8765/ws
Mobile token: choose-a-local-token
```

Keep `OPENAI_API_KEY` only on the backend machine. Do not put it in the APK.

## Local Whisper Mode

Local mode downloads a whisper.cpp ggml model on first use:

- `tiny`: default, fastest, best for phones
- `base`: higher quality, more latency and battery use

Offline local translation is limited to Whisper translate-to-English. For non-English target languages, the app transcribes locally and calls the backend `/translate` endpoint when a backend URL is configured.

## Android Capture Limits

Some apps return silence even with permissions granted:

- DRM/protected playback can block capture.
- Apps can opt out of playback capture.
- Some audio usages are not eligible for `AudioPlaybackCapture`.

The overlay reports `No capturable audio` when the stream is paused, silent, or blocked.
