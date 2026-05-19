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

## Fresh Setup To Build Successful

Use these steps when setting up the Android app on a new Windows machine.

### 1. Install Android Studio

Download and install Android Studio from the official Android developer site.

During first launch, allow Android Studio to install the default Android SDK. After setup, open:

```text
File > Settings > Languages & Frameworks > Android SDK
```

In **SDK Platforms**, install:

```text
Android 15.0 / API 35
```

In **SDK Tools**, install or confirm these are checked:

```text
Android SDK Platform-Tools
Android SDK Build-Tools
NDK
CMake 3.22.1 or newer
```

Click **Apply** and let Android Studio download the packages.

### 2. Open The Android Project

Open this folder in Android Studio:

```text
C:\Users\User\sub-stream\android
```

Do not open the repository root for Android development. The Android Gradle project starts inside the `android/` folder.

### 3. Wait For Gradle Sync

Android Studio will start syncing the project. The first sync can take several minutes because it downloads Gradle, Kotlin, Android Gradle Plugin, Compose, and native build dependencies.

The sync is healthy when the Build tool window ends with:

```text
BUILD SUCCESSFUL
```

Ignore these non-blocking prompts for now:

```text
Kotlin version is available
Project update recommended
Migrate to Gradle Daemon toolchain
```

They are upgrade suggestions, not required to run the current app.

### 4. If Gradle Sync Fails With C/C++

If the Build tool window shows an error like:

```text
:app:debug:arm64-v8a failed to configure C/C++
java.lang.NoSuchMethodError: org.gradle.process.ExecResult org.gradle.api.Project.exec(...)
```

check this file:

```text
android/gradle/wrapper/gradle-wrapper.properties
```

The wrapper should use Gradle `8.10.2`:

```text
distributionUrl=https\://services.gradle.org/distributions/gradle-8.10.2-bin.zip
```

Gradle `9.0.0` is not compatible with the current Android Gradle Plugin setup in this checkout.

After changing the wrapper, run:

```text
File > Sync Project with Gradle Files
```

### 5. Confirm Gradle JDK

Open:

```text
File > Settings > Build, Execution, Deployment > Build Tools > Gradle
```

For **Gradle JDK**, use Android Studio's bundled JDK:

```text
GRADLE_LOCAL_JAVA_HOME JetBrains Runtime
```

or the path:

```text
C:\Program Files\Android\Android Studio\jbr
```

Click **Apply**, then **OK**, then sync again.

### 6. Build Success Checkpoint

Once sync finishes successfully, the left Project panel should show the Android app structure:

```text
app
manifests
kotlin+java
cpp
assets
res
Gradle Scripts
```

The top toolbar should show:

```text
app
```

as the run configuration.

If the device dropdown still says:

```text
No Devices
```

that is expected until a physical Android phone is connected or an emulator is configured.

## Build

Open the `android/` folder in Android Studio and run the `app` configuration on a physical Android 10+ device.

The app has `minSdk = 29` because `AudioPlaybackCapture` starts on Android 10.

## Run On A Physical Phone

Use a physical Android 10+ phone for best testing because this app needs playback audio capture and overlay behavior.

On the phone:

1. Enable **Developer Options**.
2. Enable **USB debugging**.
3. Connect the phone to the PC through USB.
4. Accept the **Allow USB debugging?** prompt.
5. If Android Studio still shows **No Devices**, change the phone USB mode to **File Transfer / MTP** and reconnect.

In Android Studio:

1. Select the phone from the device dropdown.
2. Keep the run configuration as **app**.
3. Click the green **Run** button.

After the app opens on the phone, grant microphone, overlay, and screen/audio capture permissions when prompted.

## Backend For Cloud Mode

Run the backend on your PC and bind to all interfaces:

```powershell
cd C:\Users\User\sub-stream
$env:KAMI_HOST="0.0.0.0"
$env:SUBSTREAM_MOBILE_TOKEN="substream-test-12345"
python backend/server.py
```

Find the PC's LAN IP:

```powershell
ipconfig
```

Use the IPv4 address under Wi-Fi or Ethernet.

In the Android app, set:

```text
Backend URL: ws://<your-pc-lan-ip>:8765/ws
Mobile token: substream-test-12345
```

Example:

```text
Backend URL: ws://192.168.1.25:8765/ws
Mobile token: substream-test-12345
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
