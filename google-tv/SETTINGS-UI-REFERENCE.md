# Settings Screen Visual Reference

This document provides a visual reference for the Arco Android TV Settings screen.

## Screen Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│                             Settings                                  │
│                                                                       │
│                     Select Environment                                │
│                                                                       │
│         ⦿  Production (AEM Cloud)                                    │
│         ○  Preview (HLX Page)                                        │
│         ○  Live (HLX Live)                                           │
│         ○  Localhost (Development)                                   │
│         ○  Custom URL                                                │
│                                                                       │
│                      Custom URL                                       │
│    ┌─────────────────────────────────────────────────────────┐     │
│    │ https://main--arco--carlossg.aem.live/       │     │
│    └─────────────────────────────────────────────────────────┘     │
│                                                                       │
│          ┌────────┐    ┌─────────────┐    ┌──────────┐             │
│          │  Save  │    │ Test Connection  │    │  Cancel  │             │
│          └────────┘    └─────────────┘    └──────────┘             │
│                                                                       │
│   Select an environment or enter a custom URL. Use the Test          │
│   button to verify connectivity before saving. Press MENU            │
│   button to access settings.                                         │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Environment Selection States

### State 1: Production Selected (Default)

```
⦿  Production (AEM Cloud)           ← Selected (filled circle)
○  Preview (HLX Page)
○  Live (HLX Live)
○  Localhost (Development)
○  Custom URL

URL Field: https://main--arco--carlossg.aem.live/
           [Disabled - grayed out]
```

### State 2: Custom URL Selected

```
○  Production (AEM Cloud)
○  Preview (HLX Page)
○  Live (HLX Live)
○  Localhost (Development)
⦿  Custom URL                       ← Selected

URL Field: [Enter custom URL here]
           [Enabled - white background, cursor visible]
```

### State 3: Localhost Selected

```
○  Production (AEM Cloud)
○  Preview (HLX Page)
○  Live (HLX Live)
⦿  Localhost (Development)          ← Selected
○  Custom URL

URL Field: http://localhost:3000/
           [Disabled - grayed out]
```

## Button States

### Normal State
```
┌────────┐
│  Save  │  [Purple background, white text]
└────────┘
```

### Focused State (D-Pad navigation)
```
┏━━━━━━━━┓
┃  Save  ┃  [Purple background, white text, thick border]
┗━━━━━━━━┛
```

### Disabled State
```
┌────────┐
│  Save  │  [Gray background, gray text]
└────────┘
```

## Button Colors

| Button | Background Color | Text Color | Purpose |
|--------|-----------------|------------|---------|
| Save | Purple (#6200EE) | White | Save settings |
| Test Connection | Teal (#03DAC5) | Black | Test URL |
| Cancel | Dark Gray | White | Discard changes |

## Remote Control Navigation

```
                    [▲]
                     ↑
                Navigate Up
                     
    [◄]  ←──────────────────→  [►]
Navigate Left              Navigate Right

                     ↓
                Navigate Down
                    [▼]

                  [OK/SELECT]
                  Press to Select
                  
                   [MENU]
                Open Settings
                  
                   [BACK]
                Close Settings
```

## Navigation Flow

```
Settings Screen
    ↓
[Radio Buttons]
    ↓ (D-Pad Down)
[URL Field]
    ↓ (D-Pad Down)
[Save Button] → [Test Button] → [Cancel Button]
    ↑__________________|_________________|
         (D-Pad Left/Right to navigate between buttons)
```

## User Journey: Changing to Localhost

```
1. User presses MENU button
   → Settings screen opens

2. User presses D-Pad Down to navigate radio buttons
   → Focus moves to "Localhost (Development)"

3. User presses OK/SELECT
   ⦿ Localhost (Development) [Selected]
   URL field updates to: http://localhost:3000/

4. User presses D-Pad Down twice
   → Focus moves to "Test Connection" button

5. User presses OK/SELECT
   → App loads URL in WebView
   → Shows "Testing connection..." toast
   → If successful, returns to focus on buttons

6. User presses D-Pad Left
   → Focus moves to "Save" button

7. User presses OK/SELECT
   → Shows "URL saved successfully" toast
   → Settings screen closes
   → Returns to DiscoveryActivity with new URL
```

## User Journey: Custom URL Entry

```
1. User presses MENU button
   → Settings screen opens

2. User navigates to "Custom URL" radio button
   
3. User presses OK/SELECT
   ⦿ Custom URL [Selected]
   URL field becomes enabled and focused

4. On-screen keyboard appears
   User types: http://192.168.1.100:3000/

5. User dismisses keyboard
   
6. User navigates to "Test Connection" button
   
7. User presses OK/SELECT
   → Connection test runs
   → Success or error message shown

8. User navigates to "Save"
   
9. User presses OK/SELECT
   → Settings saved
   → Screen closes
```

## Error States

### Invalid URL Error

```
┌─────────────────────────────────────────────┐
│ ⚠️  Invalid URL                              │
│                                              │
│ Please enter a valid URL starting with      │
│ http:// or https://                          │
└─────────────────────────────────────────────┘
```

### Connection Test Failed

```
┌─────────────────────────────────────────────┐
│ ❌  Connection Failed                        │
│                                              │
│ Could not connect to the specified URL.     │
│ Please check the URL and try again.         │
└─────────────────────────────────────────────┘
```

### Success Message

```
┌─────────────────────────────────────────────┐
│ ✓  URL saved successfully                    │
└─────────────────────────────────────────────┘
```

## Text Sizes (Optimized for TV)

| Element | Size | Notes |
|---------|------|-------|
| Title | 32sp | "Settings" |
| Section Labels | 20sp | "Select Environment", "Custom URL" |
| Radio Button Text | 18sp | Environment options |
| Button Text | 18sp | Save, Test, Cancel |
| URL Field | 16sp | Input text |
| Help Text | 14sp | Bottom instructions |

## Color Scheme

| Element | Background | Foreground |
|---------|-----------|-----------|
| Screen | Black (#000000) | - |
| Title Text | Transparent | White |
| Radio Button (unselected) | Transparent | White |
| Radio Button (selected) | Transparent | Purple |
| URL Field (disabled) | Dark Gray | White (dim) |
| URL Field (enabled) | Dark Gray | White (bright) |
| Save Button | Purple (#6200EE) | White |
| Test Button | Teal (#03DAC5) | Black |
| Cancel Button | Dark Gray | White |
| Help Text | Transparent | Gray |

## Accessibility Features

1. **Focus Indicators**: All focusable elements have visible focus states
2. **Large Touch Targets**: All buttons minimum 150dp wide
3. **High Contrast**: White text on dark background
4. **Clear Labels**: Descriptive radio button labels
5. **Help Text**: Instructions at bottom of screen
6. **Logical Tab Order**: nextFocus attributes for smooth navigation

## Testing Scenarios

### Scenario 1: First Time User
- Default: Production selected
- URL field shows production URL
- Save enabled

### Scenario 2: Returning User
- Previously saved setting loads
- Appropriate radio button selected
- URL field shows saved URL

### Scenario 3: Development Testing
- Select Localhost
- URL auto-fills
- Test Connection works (if dev server running)
- Save persists setting

### Scenario 4: Custom URL
- Select Custom URL
- URL field becomes editable
- Enter custom URL
- Validation runs on Save
- Error shown if invalid

## Responsive Behavior

The Settings screen is wrapped in a `ScrollView` to handle:
- Long URL text that doesn't fit
- Future additional settings
- Different TV screen sizes
- Accessibility zoom levels

## Integration Points

```
DiscoveryActivity
    ↓
  [MENU key press]
    ↓
SettingsActivity
    ↓
  [Save button]
    ↓
SharedPreferences.edit()
.putString("arco_url", newUrl)
.apply()
    ↓
DiscoveryActivity.onResume()
    ↓
Read arco_url
    ↓
Use in URL construction
```

## Next Steps for Enhancement

Future UI improvements could include:

1. **Recent URLs Dropdown**: Show last 5 used URLs
2. **QR Code Scanner**: Scan QR code to set URL
3. **Connection Speed Test**: Show ping time/latency
4. **Environment Icons**: Add visual icons for each environment
5. **Advanced Settings**: Collapsed section for power users
6. **Profile Management**: Save multiple configurations
7. **Dark/Light Theme Toggle**: User preference
8. **Font Size Adjustment**: Accessibility option
