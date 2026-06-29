# Arco Coffee — Google TV App

This directory contains the source code for the Arco coffee discovery application for Google TV.

## Project Overview

The app is a lightweight WebView shell that loads the Arco Edge Delivery site in a **10-foot UI** experience, letting users discover and compare coffee gear by voice. Voice queries and deep links are forwarded to Arco's AI recommender as `?q=` searches.

### Key Features
- **Voice-Activated Intent**: Integrated with Google Assistant via `shortcuts.xml`; voice queries become `?q=` recommender searches.
- **AI Recommender**: Loads the Arco site, which generates personalized comparison pages from natural-language queries.
- **WebView Shell**: Renders the live Arco site, so the TV experience always matches the web.
- **Configurable Base URL**: Easy switching between development, preview, and production environments.

## Configuration

### Changing the Base URL

The app includes a built-in settings screen to configure which server to connect to.

**To Access Settings:**
1. Launch the Arco app on your TV
2. Press the **MENU** button on your remote
3. Select an environment or enter a custom URL
4. Press **Save** to apply changes

**Available Environments:**
- **Default (Preview)**: `https://main--arco--carlossg.aem.page/`
- **Custom URL**: Enter any valid HTTP/HTTPS URL

**Test Connection:**
Use the **Test** button to verify connectivity before saving. This will attempt to load the URL and show any connection issues.

### Default URL

If no custom URL is configured, the app defaults to:
```
https://main--arco--carlossg.aem.page/
```

### Programmatic Configuration

You can also set the URL via ADB for automated testing:

```bash
# Set a custom URL
adb shell "am broadcast -a com.arco.tv.SET_URL --es url 'http://192.168.1.100:3000/'"

# Set to localhost
adb shell "am broadcast -a com.arco.tv.SET_URL --es url 'http://localhost:3000/'"

# Reset to default
adb shell "am broadcast -a com.arco.tv.SET_URL --es url 'https://main--arco--carlossg.aem.page/'"
```

## Prerequisites

To build and deploy this application, you will need:
- **Android Studio** (Ladybug or later recommended)
- **JDK 17 or 21** (Required for Gradle 8.x/9.x compatibility)
- **Android SDK** (API 34+)
- **ADB (Android Debug Bridge)** installed and configured
- **Android Device or Emulator** (Phone/Tablet) or **Chromecast with Google TV**

## Build Instructions

1.  **Open in Android Studio**:
    - Select "Open an existing project" and choose the `google-tv` directory.
2.  **Build via CLI**:
    ```bash
    cd google-tv
    ./gradlew assembleDebug
    ```
    The generated APK will be located at `app/build/outputs/apk/debug/app-debug.apk`.

## Deployment

### 1. Enable Developer Options
- **Mobile**: Go to **Settings** > **About phone** > tap **Build number** 7 times.
- **TV**: Go to **Settings** > **System** > **About** > tap **Android TV OS build** 7 times.
- Enable **USB debugging** in Developer options.

### 2. Connect via ADB
For wireless debugging on TV:
```bash
adb connect <YOUR_DEVICE_IP_ADDRESS>
```

### 3. Install Application
```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

## Testing Deep Links

The app supports deep linking via custom URI scheme and HTTPS URLs.

### Method 1: Custom Scheme (Recommended for TV)
Use the `arco://` scheme for direct, reliable deep linking on Android TV:

```bash
# General query
adb shell am start -a android.intent.action.VIEW -d "arco://search?q=best+espresso+machines"

# Direct to specific page
adb shell am start -a android.intent.action.VIEW -d "arco://compare?product=a3500"
```

### Method 2: HTTPS URLs (Requires Component Name on TV)
Due to Android TV's browser disambiguation, HTTPS deep links require specifying the component:

```bash
# With explicit component (always works)
adb -s emulator-5554 shell am start -n com.arco.tv/.ui.DiscoveryActivity \
  -a android.intent.action.VIEW \
  -d "https://arco.coffee?q=best+espresso+machines"

# Without component (may show "no app available" on TV without verified App Links)
adb shell am start -a android.intent.action.VIEW -d "https://arco.coffee?q=best+espresso+machines"
```

### Query Parameters
The app extracts the query from the `q` parameter:
- `?q=best+espresso+machines` → searches for "best espresso machines"
- `?q=pour+over+recipes` → searches for "pour over recipes"

## Testing Voice Actions (Google TV)

**⚠️ Note:** Google's Assistant plugin for Android Studio has been deprecated. Use the testing scripts below instead.

**For detailed testing methods, see [VOICE-TESTING.md](./VOICE-TESTING.md)**

### Quick Testing Scripts

Two helper scripts are provided for instant testing:

```bash
# Quick single query test (recommended for development)
./quick-test.sh "best espresso machines"
./quick-test.sh "pour over recipes"

# Automated batch test (10 common queries)
./test-voice-queries.sh emulator-5554
```

### Manual ADB Testing

```bash
# Test any query instantly
adb -s emulator-5554 shell am start \
  -a android.intent.action.VIEW \
  -d "arco://search?q=your+query+here"
```

### Voice Commands (On Real Google TV Devices)

**Recommended Commands (with app name):**
- **"Hey Google, best espresso machines on Arco"**
- **"Hey Google, pour over recipes in Arco"**
- **"Hey Google, cold brew recipes using Arco"**
- **"Hey Google, search for best grinder on Arco"**

The key is to **always include "on Arco", "in Arco", or "using Arco"** at the end of your query.

### Why Voice Commands May Route to YouTube

Google Assistant on TV often defaults to YouTube for general queries. To ensure your app opens:

1. ✅ **Always include the app name** ("on Arco", "in Arco", "using Arco")
2. ✅ **Wait 24-48 hours** after installation for Google's servers to index the shortcuts
3. ✅ **Launch the app manually first** from the TV home screen at least once
4. ⚠️ **Google may still choose YouTube** if it thinks that's a better match for your query

### Testing Before Shortcuts Are Indexed

Use ADB commands to test immediately (no waiting required):

```bash
# Custom scheme (recommended)
adb shell am start -a android.intent.action.VIEW -d "arco://search?q=best+espresso+machines"

# With component name
adb shell am start -n com.arco.tv/.ui.DiscoveryActivity \
  -a android.intent.action.VIEW \
  -d "https://arco.coffee?q=best+espresso+machines"
```

### Troubleshooting Voice Commands

If voice commands still route to YouTube:
1. Try opening the app from the TV launcher first
2. Restart your TV/emulator
3. Clear Google app cache: Settings → Apps → Google → Clear Cache
4. Use the exact phrasing: "[your query] **on Arco**"

## Integration with Home Graph

To enable cross-device synchronization, ensure the `GOOGLE_CLOUD_PROJECT_ID` is correctly configured in your integration layer to connect with the Home Graph API.
