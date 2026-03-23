# CLAUDE.md — Project Context for AI Assistants

This file is automatically loaded by Claude Code. It contains everything needed to resume work on this project from any machine.

## What This Is

A commercial MCP server product (`mobile-device-mcp`) that gives AI coding assistants the ability to see and interact with mobile devices. It bridges the gap between AI tools (Claude Code, Cursor, Windsurf) and mobile development — web devs have browser tools, mobile devs have nothing. This product fixes that.

**This is a product being built for sale, not a hobby project.** All technical decisions should be justified through a commercial lens.

## Current State (as of 2026-03-21)

### Completed
- **Phase 1: Android ADB Device Control** — 18 MCP tools, fully tested on Pixel 8 (Android 16, SDK 36), 13/13 tests passed
- **Phase 2: AI Visual Analysis Layer** — 8 AI-powered MCP tools, multi-provider support (Anthropic Claude + Google Gemini), all 9/9 tests passed on real device
- **Performance Optimization** — 3-tier element search (local → cached AI → fresh AI), TTL-based caching, parallel capture, alias mapping. Result: smart_tap 37x faster (7.6s → 205ms), find_element 7000x faster (7.1s → 1ms)
- **Screenshot Compression Pipeline** — Pure-JS JPEG encoding + bilinear resize (pngjs + jpeg-js). AI tools auto-compress to JPEG q=60, 400w. Result: ~28KB average screenshots (down from 251KB), zero AI quality loss.
- **Phase 3: Flutter Widget Tree** — 8 Flutter-specific MCP tools via Dart VM Service Protocol. Connects to running debug/profile apps, inspects widget tree, maps 93 widgets to source code file:line. Handles DDS redirect. 12/12 tests passed on real device (metroping app on Pixel 8).
- **Companion Android App** — AccessibilityService-based companion app that provides real-time UI tree via TCP socket (JSON-RPC on 127.0.0.1:18080). 23x faster than UIAutomator dump (105ms vs 2448ms). Built, installed, and tested on Pixel 8. Source in `companion-app/`.
- **Performance Fixes (2026-03-21)** — 6 targeted fixes based on live E2E testing:
  1. Stale cache threshold lowered 0.85→0.7 (eliminates redundant ADB dumps)
  2. Semantic-only hash in wait_for_settle (fixes 62% Flutter failure rate)
  3. New `wait_for_element` tool (faster than generic settle)
  4. Tiebreaker disambiguation for duplicate contentDescription matches
  5. Cache TTL 3s→5s (fewer cache misses)
  6. Interactive-only search first, full tree fallback (30-40% faster dumps)
- **GitHub repo**: https://github.com/saranshbamania/mobile-device-mcp
- **npm published**: v0.1.0 — `npx mobile-device-mcp`
- **Live tested** with Google Gemini 2.5 Flash on Pixel 8. Full E2E test on MetroPing: 14/14 smart_taps passed, 0 AI calls needed.
- **Flutter Hot Reload/Restart** — 2 new tools (`flutter_hot_reload`, `flutter_hot_restart`) via Dart VM Service extensions. Hot reload preserves state, hot restart re-discovers isolate automatically.
- **iOS Simulator Support** — `IOSSimulatorDriver` implementing full `DeviceDriver` interface via `xcrun simctl`. 4 iOS-specific tools + shared device tools. macOS only, auto-detected.
- **Video Recording** — 2 tools (`record_screen`, `stop_recording`) using `adb shell screenrecord`. Long-running process via `ADB.spawn()`, one recording per device, auto-cleanup.
- **Test Generation** — 3 tools (`start_test_recording`, `stop_test_recording`, `get_recorded_actions`). Records MCP tool calls and generates reproducible test scripts in TypeScript, Python, or JSON.
- **Companion App Auto-Install** — When companion app is not on device, auto-installs bundled APK, enables AccessibilityService, retries connection. Zero manual setup.
- **Total: 49 MCP tools** across Android, iOS, Flutter, AI vision, video, and test generation.
- **Full feature reference**: See `FEATURES.md` for complete feature documentation.

### Not Yet Done
- **Phase 4: iOS Support** — Simulators done (xcrun simctl, `IOSSimulatorDriver`). Physical devices still needed (idevice/pymobiledevice3). UI tree dump not yet implemented (needs XCTest or Accessibility Inspector integration). Apple frequently breaks device protocols — high maintenance.
- **Phase 5: Monetization** — License key gating implemented (BSL 1.1). Payment integration pending.

## Architecture Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Language | TypeScript / Node.js | npm distribution via `npx`, MCP SDK is TS-first |
| Build approach | From scratch | Full IP ownership, no upstream dependencies |
| AI providers | Multi-provider (Anthropic + Google) | Don't lock users to one provider |
| Default AI model | Gemini 2.5 Flash | Cheapest vision model (~$0.15/1M input tokens), good quality, free tier available |
| Screenshot format | Base64 inline | AI models consume images inline. File paths break in remote/cloud setups |
| UI tree format | Structured JSON (pruned from XML) | Raw XML is 50-200KB of noise. Parsed JSON saves tokens and money |
| State management | Stateless tools | Each MCP call independent. No session to manage = no session to break |
| Driver architecture | Modular (DeviceDriver interface) | Platform drivers (Android, iOS, Flutter) are swappable without changing tools |
| Element search | 4-tier: companion → local text → cached AI → fresh AI | Companion app is 23x faster than UIAutomator. Local search is free and instant (<1ms), AI only called for ambiguous queries |
| Screenshot compression | JPEG q=60, 400w via pure JS | ~28KB average, zero native deps for npx compat, AI quality unaffected |
| Companion app | AccessibilityService + TCP JSON-RPC | 105ms UI tree vs 2448ms UIAutomator. Works on Flutter release builds. Only reachable via ADB port forward (secure) |
| iOS support | xcrun simctl via IOSSimulatorDriver | Same DeviceDriver interface as Android, auto-detected on macOS |
| Video recording | ADB spawn + screenrecord | Long-running process management, SIGINT graceful stop |
| Test generation | ActionRecorder + TestGenerator | Records tool calls, generates MCP client scripts (TS/Python/JSON) |
| Companion auto-install | APK bundled in assets/ | Auto-installs, enables a11y service, retries connection silently |

## Performance Architecture

The system uses a 4-tier performance hierarchy for element finding:

0. **Tier 0 (Fastest)**: Companion app AccessibilityService via TCP
   - `CompanionClient` in `companion-client.ts` — JSON-RPC over TCP on 127.0.0.1:18080
   - 105ms for full UI tree (23x faster than UIAutomator)
   - Works on Flutter release builds (AccessibilityService sees Flutter semantics)
   - Auto-detected: MCP server connects if companion is installed + enabled

1. **Tier 1 (Instant, Free)**: Local text search on cached UI tree
   - `searchElementsLocally()` in `element-search.ts` — text, content description, resource ID, class name matching
   - Alias system maps common UI terms (AC→clear, delete→del, etc.)
   - Number word conversion (five→5, 7→seven)
   - Tiebreaker for duplicate matches: Button > View, larger > smaller, lower > higher
   - Returns in <1ms if confidence >= 0.7 (stale cache) or > 0.5 (fresh)

2. **Tier 2 (Fast, Costs Tokens)**: AI analysis with cached screenshot + UI tree
   - TTL-based cache (5s) avoids redundant ADB calls
   - Interactive-only search first, full tree fallback
   - Parallel capture of screenshot + UI tree via `Promise.all()`

3. **Tier 3 (Standard)**: Fresh device capture + AI analysis
   - Full ADB screenshot + uiautomator dump (~2.5s)
   - AI vision analysis (~3-10s depending on provider)

Cache invalidation after tap/type: only clears screenshot, keeps UI tree (button positions don't change after tap).

### UI Tree Retrieval Strategy (getUIElements)
4-strategy cascade in AndroidDriver:
- Strategy 0: Companion app (instant, complete tree via AccessibilityService TCP)
- Strategy 1: UIAutomator dump (standard ADB approach, ~800ms)
- Strategy 2: UIAutomator retry after 500ms (handles transient failures)
- Strategy 3: Accessibility dump fallback (parses `dumpsys accessibility`)

## Known Limitations

1. **Token bloat**: Base64 screenshots + JSON on every call. Mitigated with JPEG compression and image resizing.
2. **Flutter debug-only**: Dart VM Service Protocol stripped from Release builds. Use ADB accessibility tree for release apps.
3. **iOS maintenance**: Apple breaks idevice protocols with iOS updates. iOS simulators supported; physical devices pending.

## Tech Stack

- TypeScript 5.7+, Node.js 18+, ESM modules
- `@modelcontextprotocol/sdk` v1.27.1 — MCP server framework
- `@anthropic-ai/sdk` v0.39.0 — Claude API (AI vision)
- `@google/generative-ai` v0.24.1 — Gemini API (AI vision)
- `zod` v3.25 — Tool input schema validation
- `pngjs` — Pure-JS PNG decoding (for compression pipeline)
- `jpeg-js` — Pure-JS JPEG encoding (for compression pipeline)
- `ws` — WebSocket client (for Dart VM Service Protocol)
- ADB (Android Debug Bridge) for device communication

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run dev          # Run with tsx (hot reload)
npm start            # Run compiled version
npx tsc --noEmit     # Type-check without building
```

## Environment Variables

```bash
# AI Provider (pick one)
GOOGLE_API_KEY=xxx          # Google Gemini (recommended — cheapest)
GEMINI_API_KEY=xxx          # Alias for GOOGLE_API_KEY
ANTHROPIC_API_KEY=xxx       # Anthropic Claude

# Optional overrides
MCP_AI_PROVIDER=google      # Force provider (auto-detected from key)
MCP_AI_MODEL=gemini-2.5-flash  # Override model
MCP_ADB_PATH=/path/to/adb  # Custom ADB location
MCP_DEFAULT_DEVICE=xxx      # Skip device auto-detection
MCP_SCREENSHOT_FORMAT=jpeg  # jpeg or png (default: png)
MCP_SCREENSHOT_QUALITY=80   # JPEG quality 1-100
MCP_SCREENSHOT_MAX_WIDTH=720 # Resize screenshots for token savings
```

## File Structure

```
src/
├── index.ts              # CLI entry (#!/usr/bin/env node, auto-discovery)
├── server.ts             # MCP server factory
├── types.ts              # ALL shared interfaces (DeviceDriver, AIConfig, etc.)
├── drivers/android/
│   ├── adb.ts            # Low-level ADB wrapper (child_process.execFile)
│   ├── companion-client.ts # TCP client for companion app (JSON-RPC on 18080)
│   └── index.ts          # AndroidDriver implements DeviceDriver, 4-strategy getUIElements
├── tools/
│   ├── index.ts           # Barrel: registerAllTools()
│   ├── device-tools.ts    # list_devices, get_device_info, get_screen_size
│   ├── screen-tools.ts    # take_screenshot, get_ui_elements
│   ├── interaction-tools.ts # tap, double_tap, long_press, swipe, type_text, press_key
│   ├── app-tools.ts       # list_apps, get_current_app, launch_app, stop_app, install_app, uninstall_app
│   ├── log-tools.ts       # get_logs
│   ├── ai-tools.ts        # analyze_screen, find_element, smart_tap, smart_type, suggest_actions, visual_diff, extract_text, verify_screen, wait_for_settle, wait_for_element, handle_popup, fill_form
│   ├── flutter-tools.ts   # flutter_connect, flutter_disconnect, flutter_get_widget_tree, flutter_get_widget_details, flutter_find_widget, flutter_get_source_map, flutter_screenshot_widget, flutter_debug_paint, flutter_hot_reload, flutter_hot_restart
│   ├── ios-tools.ts       # ios_list_simulators, ios_boot_simulator, ios_shutdown_simulator, ios_screenshot
│   ├── video-tools.ts     # record_screen, stop_recording
│   └── recording-tools.ts # start_test_recording, stop_test_recording, get_recorded_actions
├── drivers/flutter/
│   ├── index.ts           # FlutterDriver: VM service discovery, widget inspection, source mapping, hot reload/restart
│   └── vm-service.ts      # VmServiceClient: JSON-RPC 2.0 over WebSocket, DDS redirect handling
├── drivers/ios/
│   ├── index.ts           # IOSSimulatorDriver: implements DeviceDriver via xcrun simctl
│   └── simctl.ts          # Low-level xcrun simctl command wrapper
├── recording/
│   ├── recorder.ts        # ActionRecorder: records MCP tool invocations for test generation
│   └── generator.ts       # TestGenerator: generates TypeScript/Python/JSON test scripts
├── ai/
│   ├── client.ts          # Multi-provider AI client (Anthropic + Google Gemini, retry with backoff)
│   ├── prompts.ts         # System prompts, user prompt builders, UI summarizer
│   ├── analyzer.ts        # ScreenAnalyzer: caching, parallel capture, local search fast path
│   └── element-search.ts  # Local element search: text/alias/number matching, no AI needed
└── utils/
    ├── discovery.ts       # Auto-find ADB, auto-detect device
    └── image.ts           # PNG parser, base64 helpers, JPEG compression pipeline (resize + encode)

companion-app/                # Android companion app (Kotlin, Gradle)
├── app/src/main/java/com/mobiledevicemcp/companion/
│   ├── CompanionAccessibilityService.kt  # Core service, starts TCP server, exposes getUITree()
│   ├── TreeSerializer.kt                 # Walks AccessibilityNodeInfo tree → JSON UIElement[]
│   ├── TcpServer.kt                      # JSON-RPC server on 127.0.0.1:18080
│   └── MainActivity.kt                   # Status display (green=active, red=inactive)
├── app/src/main/res/xml/accessibility_service_config.xml
├── app/build.gradle.kts                   # minSdk 21, targetSdk 35, compileSdk 35
└── build.gradle.kts                       # AGP 8.7.0, Kotlin 2.0.21

test-logs/                    # E2E test results and performance logs
└── e2e-metroping-2026-03-20.md
```

## Key Patterns

- All tools use `server.registerTool()` (not deprecated `server.tool()`)
- All tool handlers wrapped in try/catch — return error text, never throw
- All user-facing output to stderr (stdout reserved for MCP JSON-RPC)
- All local imports use `.js` extension (ESM requirement)
- AI tools gracefully degrade: return helpful error when no API key
- `getDriver()` / `getAnalyzer()` / `getFlutter()` lazy factory pattern for dependency injection
- Local element search tried before AI for `findElement`, `smartTap`, `smartType`
- Screenshot compression auto-applied for AI tools (JPEG q=60, 400w). Raw PNG available via take_screenshot tool params.
- Flutter VM service: DDS redirect-following in WebSocket connect, handles both object and JSON string responses
- Companion app auto-connects via ADB port forward (tcp:18080). Falls back to UIAutomator if not installed.
- `wait_for_settle` uses semantic-only hash (ignores bounds) for Flutter compatibility
- `wait_for_element` polls for specific element by description — faster than generic settle

## Resuming Work

When continuing on a new machine, tell Claude Code:

> Pull https://github.com/saranshbamania/mobile-device-mcp and resume where I left off. Read CLAUDE.md for full context. Check git log for recent changes.
