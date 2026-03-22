# mobile-device-mcp — Feature Guide

Complete reference of every feature, how it's implemented, and what makes it unique.

---

## Platform Support

### Android Device Control (18 tools)
Full ADB-powered device interaction for any connected Android device or emulator.

**Implementation:** `AndroidDriver` in `src/drivers/android/index.ts` wraps the ADB binary via `src/drivers/android/adb.ts` (uses `child_process.execFile`). Every method takes a `deviceId` and passes `-s <deviceId>` to ADB for multi-device support.

| Tool | What it does | Implementation detail |
|------|-------------|----------------------|
| `list_devices` | List all connected Android devices/emulators | `adb devices -l`, parses model/product/device fields |
| `get_device_info` | Device model, manufacturer, Android version, SDK, screen size | `adb shell getprop`, parses `[key]: [value]` format |
| `get_screen_size` | Screen resolution in pixels | `adb shell wm size`, prefers override size |
| `take_screenshot` | Capture screen as PNG or JPEG | `adb exec-out screencap -p` → pure-JS compression pipeline |
| `get_ui_elements` | Get all UI elements with bounds, text, properties | 4-strategy cascade (see Performance section) |
| `tap` | Tap at coordinates | `adb shell input tap x y` |
| `double_tap` | Double tap at coordinates | Two taps with 50ms delay |
| `long_press` | Long press at coordinates | `adb shell input swipe x y x y duration` (swipe to same point) |
| `swipe` | Swipe between two points | `adb shell input swipe x1 y1 x2 y2 duration` |
| `type_text` | Type text into focused field | `adb shell input text`, with shell metacharacter escaping |
| `press_key` | Press a hardware/soft key | `adb shell input keyevent KEYCODE` |
| `list_apps` | List installed apps | `adb shell pm list packages` (-3 for third-party) |
| `get_current_app` | Get foreground app and activity | Parses `dumpsys activity activities` for ResumedActivity |
| `launch_app` | Launch an app by package name | `adb shell monkey -p <pkg> -c LAUNCHER 1` |
| `stop_app` | Force-stop an app | `adb shell am force-stop <pkg>` |
| `install_app` | Install APK on device | `adb install <path>` |
| `uninstall_app` | Uninstall app by package name | `adb uninstall <pkg>` |
| `get_logs` | Get device logcat logs | `adb shell logcat -d -v time`, parsed into structured entries |

### iOS Simulator Support (4 + shared tools)
Control iOS simulators via `xcrun simctl`. Available on macOS only.

**Implementation:** `IOSSimulatorDriver` in `src/drivers/ios/index.ts` implements the same `DeviceDriver` interface as Android, backed by `Simctl` wrapper in `src/drivers/ios/simctl.ts`. Platform detection via `process.platform === "darwin"` in `server.ts`.

| Tool | What it does | Implementation detail |
|------|-------------|----------------------|
| `ios_list_simulators` | List all simulators with status/UDID/iOS version | `xcrun simctl list devices --json` |
| `ios_boot_simulator` | Boot a simulator by UDID | `xcrun simctl boot <udid>` |
| `ios_shutdown_simulator` | Shutdown a running simulator | `xcrun simctl shutdown <udid>` |
| `ios_screenshot` | Take simulator screenshot | `xcrun simctl io <udid> screenshot --type=png -` (stdout) |

The iOS driver also supports all shared `DeviceDriver` methods:
- **Tap/Swipe/Type**: `xcrun simctl io <udid> tap/swipe/type`
- **App management**: `xcrun simctl launch/terminate/install/uninstall`
- **Logs**: `xcrun simctl spawn <udid> log show`

**Limitations:** No UI tree dump (would require XCTest/Accessibility Inspector integration). AI vision tools still work via screenshots.

---

## AI Visual Analysis (12 tools)

Multi-provider AI vision that turns screenshots into actionable intelligence. No other Flutter/mobile MCP server has this.

**Implementation:** `ScreenAnalyzer` in `src/ai/analyzer.ts` orchestrates parallel screenshot + UI tree capture, caches results with TTL (5s), and routes through `AIClient` in `src/ai/client.ts` which supports both Anthropic Claude and Google Gemini with retry + exponential backoff.

| Tool | What it does | Unique aspect |
|------|-------------|---------------|
| `analyze_screen` | Full screen analysis: app name, screen type, elements, suggestions | Returns structured `ScreenAnalysis` JSON |
| `find_element` | Find a specific UI element by description | 4-tier search: companion → local → cached AI → fresh AI |
| `smart_tap` | Tap an element by description (no coordinates needed) | Local search first (<1ms), AI only if needed |
| `smart_type` | Type into a field identified by description | Finds field via `find_element`, taps it, types text |
| `suggest_actions` | Get AI-suggested next actions | Contextual suggestions based on screen state |
| `visual_diff` | Compare two screenshots for changes | Returns structured diff with change regions |
| `extract_text` | OCR-like text extraction via AI | All visible text from screenshot |
| `verify_screen` | Verify screen matches expected state | Boolean verification with confidence score |
| `wait_for_settle` | Wait for screen to stop changing | Semantic-only hash comparison (ignores bounds for Flutter) |
| `wait_for_element` | Wait for specific element to appear | Polls for element by description, faster than generic settle |
| `handle_popup` | Detect and dismiss popups/dialogs | AI identifies popup and suggests dismiss action |
| `fill_form` | Fill multiple form fields in sequence | Finds each field, taps, types — all via AI |

### Screenshot Compression Pipeline
AI tools auto-compress screenshots to minimize token usage and cost.

**Implementation:** `src/utils/image.ts` — Pure-JS pipeline using `pngjs` (decode) + `jpeg-js` (encode) with bilinear resize. No native dependencies (critical for `npx` compatibility).

- **Default:** JPEG quality 60, max width 400px
- **Result:** ~28KB average (down from 251KB raw PNG)
- **AI quality:** Zero degradation — tested extensively with Gemini 2.5 Flash

### 4-Tier Element Search
The fastest element-finding pipeline in any mobile MCP server.

**Implementation:** `src/ai/element-search.ts` (local search) + `src/ai/analyzer.ts` (AI search)

1. **Tier 0 — Companion app** (105ms): AccessibilityService via TCP JSON-RPC. 23x faster than UIAutomator.
2. **Tier 1 — Local text search** (<1ms): Searches cached UI tree for text, content description, resource ID, class name. Includes alias mapping (AC→clear, delete→del) and number word conversion (five→5). Tiebreaker for duplicates: Button > View, larger > smaller, lower > higher.
3. **Tier 2 — Cached AI** (~0.5s): Uses TTL-cached screenshot + UI tree. Avoids redundant ADB calls.
4. **Tier 3 — Fresh AI** (~3-10s): Full device capture + AI vision analysis.

**Result:** `smart_tap` is 37x faster (7.6s → 205ms). `find_element` is 7000x faster (7.1s → 1ms) when local search hits.

---

## Flutter Widget Tree Inspection (10 tools)

Deep integration with Flutter's Dart VM Service Protocol. Connect to any debug/profile Flutter app and inspect the widget tree, source code locations, and render objects.

**Implementation:** `FlutterDriver` in `src/drivers/flutter/index.ts` + `VmServiceClient` in `src/drivers/flutter/vm-service.ts`. Connects via WebSocket to the Dart VM Service, handles DDS (Dart Development Service) redirects automatically. Discovers VM service URL from ADB logcat or probes existing port forwards.

| Tool | What it does | Implementation detail |
|------|-------------|----------------------|
| `flutter_connect` | Connect to running Flutter app | Scans logcat for VM service URL, forwards port, finds Flutter isolate |
| `flutter_disconnect` | Disconnect and clean up | Disposes inspector group, closes WebSocket |
| `flutter_get_widget_tree` | Get full widget tree (summary or full) | `ext.flutter.inspector.getRootWidgetSummaryTree`, pruned to reduce payload |
| `flutter_get_widget_details` | Get detailed widget subtree by valueId | `ext.flutter.inspector.getDetailsSubtree` with configurable depth |
| `flutter_find_widget` | Search widgets by type/text/description | Local tree walking with case-insensitive matching |
| `flutter_get_source_map` | Map all widgets to source code file:line | Extracts `creationLocation` from widgets with `createdByLocalProject` |
| `flutter_screenshot_widget` | Screenshot a specific widget in isolation | `ext.flutter.inspector.screenshot` with configurable dimensions |
| `flutter_debug_paint` | Toggle debug paint overlay | `ext.flutter.debugPaint` extension |
| `flutter_hot_reload` | Push code changes without losing state | `ext.flutter.reassemble` — preserves variables, navigation, scroll positions |
| `flutter_hot_restart` | Full restart with all code changes applied | `ext.flutter.hotRestart` — resets state, re-discovers isolate automatically |

### Widget-to-Tap Pipeline
When `smart_tap` detects a connected Flutter app, it uses the widget tree for coordinate resolution instead of AI vision.

**Implementation:** `FlutterDriver.findWidgetForTap()` — searches widget tree locally, selects the widget via inspector API, evaluates Dart code to get `RenderBox.localToGlobal()` bounds, converts logical → physical pixels using device pixel ratio.

**Result:** ~200ms total vs ~10s with AI vision. Zero API cost.

### Hot Reload & Hot Restart
**No other Flutter MCP server has this without requiring app modifications.**

- `flutter_hot_reload`: Calls `ext.flutter.reassemble` via VM Service. Clears cached library IDs since they may change.
- `flutter_hot_restart`: Calls `ext.flutter.hotRestart`, resets all caches (library ID, DPR, evaluate availability), and automatically re-discovers the Flutter isolate since hot restart creates a new one.

---

## Companion Android App

A custom AccessibilityService-based app that provides a 23x faster UI tree than UIAutomator.

**Implementation:** Kotlin app in `companion-app/`. Key components:
- `CompanionAccessibilityService.kt` — walks `AccessibilityNodeInfo` tree
- `TreeSerializer.kt` — serializes tree to JSON matching `UIElement[]` format
- `TcpServer.kt` — JSON-RPC server on `127.0.0.1:18080`
- `CompanionClient` in `src/drivers/android/companion-client.ts` — TCP client with port forwarding

### Auto-Install
When the companion app is not found on the device, the MCP server automatically:
1. Locates the bundled APK (checks `assets/companion-app.apk` and build output)
2. Installs via `adb install -r -g`
3. Enables the AccessibilityService via `adb shell settings put`
4. Waits 2 seconds for the service to start
5. Retries the TCP connection

**Implementation:** `AndroidDriver.getCompanionClient()` in `src/drivers/android/index.ts` + `findCompanionApk()` for APK path resolution using `import.meta.url`.

**Security:** The TCP server only binds to `127.0.0.1` (localhost). Only reachable through ADB port forwarding, which requires USB debugging authorization.

---

## Video Recording (2 tools)

Record the device screen as MP4 video using Android's native `screenrecord`.

**Implementation:** `AndroidDriver.startRecording()` / `stopRecording()` in `src/drivers/android/index.ts`. Uses `ADB.spawn()` (added in `src/drivers/android/adb.ts`) to start a long-running `adb shell screenrecord` process without blocking. Recordings are tracked in a `Map<deviceId, {process, devicePath, startTime}>`.

| Tool | What it does | Implementation detail |
|------|-------------|----------------------|
| `record_screen` | Start recording screen (max 3 min) | Spawns `adb shell screenrecord` with optional bitRate/resolution/maxDuration |
| `stop_recording` | Stop recording and optionally pull to host | Sends SIGINT, waits for finalization, optional `adb pull` |

**Constraints:** One recording per device at a time (Android limitation). 3-minute max per recording (Android OS limit). Timestamped filenames prevent conflicts.

---

## Test Generation (3 tools)

Record MCP tool interactions and generate reproducible test scripts in TypeScript, Python, or JSON.

**Implementation:**
- `ActionRecorder` in `src/recording/recorder.ts` — records tool name, params, result (truncated to 500 chars), and duration for each invocation.
- `TestGenerator` in `src/recording/generator.ts` — generates MCP client code with proper imports, settle delays between interaction tools, and sanitized test names.

| Tool | What it does | Output format |
|------|-------------|---------------|
| `start_test_recording` | Begin recording tool calls | N/A — starts the recorder |
| `stop_test_recording` | Stop and generate test script | TypeScript, Python, or JSON |
| `get_recorded_actions` | View recorded actions without stopping | JSON summary |

**Generated test scripts include:**
- MCP client SDK setup (TypeScript: `@modelcontextprotocol/sdk`, Python: `mcp`)
- Step-by-step tool calls matching the recorded sequence
- 1-second settle delays between interaction actions
- Console/print output for each step result

---

## Multi-Device Support

All tools accept a `device_id` parameter for targeting specific devices. The `list_devices` tool returns all connected devices (Android) and simulators (iOS, macOS only).

**Implementation:** `DeviceDriver` interface in `src/types.ts` requires `deviceId` on every method. `AndroidDriver` passes `-s <deviceId>` to all ADB commands. Server auto-discovers a default device at startup via `getDefaultDevice()` in `src/utils/discovery.ts`.

---

## Multi-Provider AI

Supports both Anthropic Claude and Google Gemini for AI vision analysis. Provider is auto-detected from which API key is set.

**Implementation:** `AIClient` in `src/ai/client.ts` abstracts provider differences. Retry with exponential backoff on transient failures. Provider selection logic in `src/index.ts`.

| Provider | Default Model | Cost | Notes |
|----------|--------------|------|-------|
| Google Gemini | gemini-2.5-flash | ~$0.15/1M input tokens | Cheapest vision model, free tier available |
| Anthropic Claude | claude-sonnet-4-20250514 | ~$3/1M input tokens | Higher quality for complex analysis |

---

## Architecture Summary

```
                    ┌──────────────────────────────────┐
                    │         MCP JSON-RPC              │
                    │         (stdio transport)         │
                    └──────────┬───────────────────────┘
                               │
                    ┌──────────▼───────────────────────┐
                    │         McpServer                 │
                    │     (38+ registered tools)        │
                    └──────────┬───────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────────────┐
         │                     │                             │
  ┌──────▼──────┐    ┌────────▼────────┐          ┌─────────▼────────┐
  │ AndroidDriver│    │  FlutterDriver  │          │ IOSSimulatorDriver│
  │   (ADB)      │    │  (VM Service)   │          │   (simctl)        │
  └──────┬──────┘    └────────┬────────┘          └──────────────────┘
         │                     │
  ┌──────▼──────┐    ┌────────▼────────┐
  │ CompanionApp │    │ VmServiceClient │
  │ (TCP 18080)  │    │ (WebSocket)     │
  └─────────────┘    └─────────────────┘
         │
  ┌──────▼──────┐
  │ScreenAnalyzer│──→ AIClient (Anthropic / Gemini)
  │ (4-tier cache)│
  └─────────────┘
```

## Tool Count Summary

| Category | Tools | Platform |
|----------|-------|----------|
| Device management | 3 | Android |
| Screenshots & UI | 2 | Android |
| Interaction | 6 | Android |
| App management | 6 | Android |
| Logs | 1 | Android |
| AI visual analysis | 12 | Android (AI-powered) |
| Flutter widget tree | 10 | Android (debug/profile) |
| Video recording | 2 | Android |
| Test generation | 3 | Cross-platform |
| iOS simulator | 4 | macOS only |
| **Total** | **49** | |

---

## What Makes This Better Than Competitors

| Feature | mobile-device-mcp | Marionette MCP | mcp_flutter | Official Flutter MCP |
|---------|-------------------|---------------|-------------|---------------------|
| No app modification needed | **Yes** | No (requires package) | No (debug only) | N/A |
| AI vision analysis | **12 tools** | None | None | None |
| ADB device control | **18 tools** | None | None | None |
| Flutter widget tree | **10 tools** | 8 tools | 3 tools | N/A (code analysis only) |
| Hot reload/restart | **Yes** | Yes | No | N/A |
| iOS support | **Simulator** | Debug mode | Untested | N/A |
| Video recording | **Yes** | No | No | No |
| Test generation | **Yes** | No | No | No |
| Companion app (23x faster) | **Yes** | No | No | No |
| Auto-install companion | **Yes** | N/A | N/A | N/A |
| Multi-AI provider | **Gemini + Claude** | None | None | None |
| Screenshot compression | **28KB avg** | Raw only | Raw only | N/A |
| Local element search | **<1ms** | By key only | None | N/A |
| Multi-device | **Yes** | Single app | Single app | N/A |
| Zero-config setup | **npx** | dart pub + code | pip + code | dart SDK |
| Total tools | **49** | 8 | 3 | Code analysis only |
