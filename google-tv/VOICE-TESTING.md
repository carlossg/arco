# Testing Voice Commands During Development

## Overview

Voice commands on Google TV use the App Actions framework, which requires shortcuts to be indexed by Google's servers. This guide shows you how to test during development **without waiting** for server indexing.

**Note:** Google's Assistant plugin for Android Studio has been deprecated. This guide focuses on current, working methods.

## Method 1: ADB Commands (Recommended - Instant Testing)

Test deep links directly using ADB - no waiting, works immediately.

### Quick Single Query Test:

```bash
# Use the quick-test script
./quick-test.sh "best espresso machines"

# Or with specific device
./quick-test.sh "pour over recipes" emulator-5554
```

### Automated Batch Testing:

```bash
# Test 10 common queries automatically
./test-voice-queries.sh emulator-5554
```

This script will:
- ✅ Check device connection
- ✅ Verify app installation
- ✅ Test 10 different queries
- ✅ Confirm query extraction
- ✅ Verify URL loading
- ✅ Show success/failure for each

### Manual Custom Scheme Testing:

```bash
# Test with custom arco:// scheme
adb -s emulator-5554 shell am start \
  -a android.intent.action.VIEW \
  -d "arco://search?q=best+espresso+machines"

# Try different queries
adb -s emulator-5554 shell am start \
  -a android.intent.action.VIEW \
  -d "arco://search?q=pour+over+recipes"
```

### HTTPS Deep Link:

```bash
# With component name (always works)
adb -s emulator-5554 shell am start \
  -n com.arco.tv/.ui.DiscoveryActivity \
  -a android.intent.action.VIEW \
  -d "https://arco.coffee?q=cold+brew+recipes"
```

### Test Script:

**Using the provided scripts (Recommended):**

```bash
# Quick single test
./quick-test.sh "your query here"

# Batch test multiple queries
./test-voice-queries.sh emulator-5554
```

**Manual bash script for custom queries:**

```bash
#!/bin/bash
# Custom test script example
queries=("your+query+1" "your+query+2")
for query in "${queries[@]}"; do
  adb shell am start -a android.intent.action.VIEW \
    -d "arco://search?q=$query"
  sleep 2
done
```

**Provided Scripts:**
- `quick-test.sh` - Test a single query instantly
- `test-voice-queries.sh` - Automated testing of 10 common queries

## Method 3: App Actions Test Tool (Web-Based)

Google provides a web-based test tool for App Actions.

### Setup:

1. **Build and install your app**
   ```bash
   ./gradlew assembleDebug
   adb install app/build/outputs/apk/debug/app-debug.apk
   ```

2. **Access the Test Tool**
   - Go to: https://developers.google.com/assistant/app/test-tool
   - Sign in with your Google account
   - Connect your device via ADB

3. **Configure Testing**
   - Select your device
   - Choose "Arco" app
   - Select a capability (OPEN_APP_FEATURE or SEARCH)
   - Fill in test parameters

4. **Run Tests**
   - Enter query like "best espresso machines"
   - Click "Test" to send intent to your device
   - View results in real-time

**Note:** This requires your device to be connected and authorized via ADB.

## Method 4: Simulating Google Assistant Intents

You can manually craft the exact intents that Google Assistant would send:

```bash
# Simulate OPEN_APP_FEATURE action
adb shell am start \
  -a android.intent.action.VIEW \
  -c android.intent.category.DEFAULT \
  --es feature "best espresso machines" \
  --es q "best espresso machines" \
  com.arco.tv/.ui.DiscoveryActivity

# Simulate SEARCH action
adb shell am start \
  -a android.intent.action.VIEW \
  -c android.intent.category.DEFAULT \
  --es query "pour over recipes" \
  --es q "pour over recipes" \
  com.arco.tv/.ui.DiscoveryActivity
```

## Method 5: Actual Voice Testing (After Deployment)

Once deployed, test with real voice commands:

### On Emulator:

The Android TV emulator doesn't have real Google Assistant, so voice testing isn't possible. Use the methods above.

### On Real Google TV Device:

1. **Install the app**
   ```bash
   adb connect <TV_IP>
   adb install app-debug.apk
   ```

2. **Wait 24-48 hours** for shortcuts to index (first time only)

3. **Launch the app manually** at least once

4. **Clear Google app cache** (helps with indexing):
   - Settings → Apps → Google → Clear Cache

5. **Test voice commands**:
   - Hold Assistant button
   - Say: "best espresso machines on Arco"

## Debugging Voice Commands

### Check if Shortcuts are Registered:

```bash
# Check app links
adb shell pm get-app-links com.arco.tv

# Check installed packages
adb shell pm list packages | grep arco.tv

# Dump app info
adb shell dumpsys package com.arco.tv | grep -A 20 "shortcuts"
```

### View Logs While Testing:

```bash
# Clear logs and test
adb logcat -c
adb shell am start -a android.intent.action.VIEW -d "arco://search?q=test"

# View relevant logs
adb logcat -d | grep -E "DiscoveryActivity|Intent|Assistant"
```

### Check Intent Data:

Add logging to your `DiscoveryActivity.kt`:

```kotlin
private fun handleIntent(intent: Intent) {
    Log.d(TAG, "Intent action: ${intent.action}")
    Log.d(TAG, "Intent data: ${intent.data}")
    Log.d(TAG, "Intent extras: ${intent.extras?.keySet()?.joinToString()}")
    
    val uri = intent.data
    Log.d(TAG, "URI: $uri")
    
    // Rest of your code...
}
```

## Best Practices

1. ✅ **Always test with ADB first** - instant feedback, no setup required
2. ✅ **Create automated test scripts** - batch test multiple queries
3. ✅ **Test multiple query patterns** - ensure all variations work
4. ✅ **Check logs continuously** - verify parameters are extracted correctly
5. ✅ **Use the web-based test tool** - simulates real Google Assistant behavior
6. ✅ **Test on real device last** - final validation before release

## Common Issues

### Issue: "You don't have an app that can do this"
**Solution**: App not installed. Rebuild and reinstall.

### Issue: Query parameter not passed
**Solution**: Check `shortcuts.xml` parameter mapping and `handleIntent()` logic.

### Issue: Voice routes to YouTube
**Solution**: 
- Use "on Arco" in voice command
- Wait for shortcut indexing (24-48 hours)
- Use ADB for immediate testing

### Issue: onNewIntent not called
**Solution**: Add `android:launchMode="singleTop"` to manifest.

## Quick Test Commands

```bash
# Quick single query test
./quick-test.sh "your query here"

# Example queries
./quick-test.sh "best espresso machines"
./quick-test.sh "pour over recipes"
./quick-test.sh "cold brew recipes"

# Automated batch test
./test-voice-queries.sh emulator-5554

# Manual single test
adb shell am start -a android.intent.action.VIEW -d "arco://search?q=test"

# Quick test - with component
adb shell am start -n com.arco.tv/.ui.DiscoveryActivity \
  -a android.intent.action.VIEW -d "https://arco.coffee?q=test"

# Check if app is running
adb shell dumpsys window | grep -E 'mCurrentFocus.*arco.tv'

# View app logs
adb logcat -s DiscoveryActivity:D

# Force stop and restart
adb shell am force-stop com.arco.tv && \
adb shell am start -a android.intent.action.VIEW -d "arco://search?q=new+test"
```

## Resources

- [App Actions Documentation](https://developers.google.com/assistant/app)
- [Testing App Actions](https://developers.google.com/assistant/app/test-tool)
- [Android TV Deep Linking](https://developer.android.com/training/tv/start/navigation)
- [Built-in Intents Reference](https://developers.google.com/assistant/app/reference/built-in-intents)
