# mobile-device-mcp

MCP server that gives AI coding assistants (Claude Code, Cursor, Windsurf) the ability to **see and interact with mobile devices**. 34 tools for screenshots, UI inspection, touch interaction, AI-powered visual analysis, and Flutter widget tree inspection.

> AI assistants can read your code but can't see your phone. This fixes that.

## The Problem

Web developers have browser DevTools, Playwright, and Puppeteer — AI assistants can click around, take screenshots, and verify fixes. Mobile developers? They're stuck manually screenshotting, copying logs, and describing what's on screen. They're **human middleware** between the AI and the device.

## What This Does

```
Developer: "The login button doesn't work"

Without this tool:                    With this tool:
  1. Manually screenshot              1. AI calls take_screenshot → sees the screen
  2. Paste into AI chat               2. AI calls smart_tap("login button") → taps it
  3. AI guesses what's wrong          3. AI calls verify_screen("error message shown") → sees result
  4. Apply fix, rebuild               4. AI calls visual_diff → confirms fix worked
  5. Repeat 4-5 times                 5. Done.
```

## Quick Start

### Prerequisites
- Node.js 18+
- Android device/emulator connected via ADB
- ADB installed (Android SDK Platform Tools)

### Setup (One-time, 30 seconds)

1. **Get a Google AI key** (free tier available): [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

2. **Add `.mcp.json` to your project root:**

```json
{
  "mcpServers": {
    "mobile-device": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mobile-device-mcp"],
      "env": {
        "GOOGLE_API_KEY": "your-google-api-key"
      }
    }
  }
}
```

3. **Open your AI coding assistant** from that directory. That's it.

The server starts and stops automatically — you never run it manually. Your AI assistant manages it as a background process via the MCP protocol.

### Verify It Works

**Claude Code:** type `/mcp` — you should see `mobile-device: Connected`

**Cursor:** check MCP panel in settings

Then just talk to your phone:

```
You: "Open my app, tap the login button, type test@email.com in the email field"
AI:  [takes screenshot → sees the screen → smart_tap("login button") → smart_type("email field", "test@email.com")]

You: "Find all the bugs on this screen"
AI:  [analyze_screen → inspects layout, checks for overflow, missing labels, broken states]

You: "Navigate to settings and verify dark mode works"
AI:  [smart_tap("settings") → take_screenshot → smart_tap("dark mode toggle") → visual_diff → reports result]
```

No test scripts. No manual screenshots. Just describe what you want in plain English.

### Works with Any AI Coding Assistant

| Tool | Config file | Docs |
|------|------------|------|
| **Claude Code** | `.mcp.json` in project root | [claude.ai/docs](https://claude.ai/docs) |
| **Cursor** | `.cursor/mcp.json` | [cursor.com/docs](https://cursor.com/docs) |
| **VS Code + Copilot** | MCP settings | [code.visualstudio.com](https://code.visualstudio.com) |
| **Windsurf** | MCP settings | [windsurf.com](https://windsurf.com) |

All use the same JSON config — just put it in the right file for your editor.

### Drop Into Any Project

Copy `.mcp.json` into any mobile project — Flutter, React Native, Kotlin, Swift — and your AI assistant gets device superpowers in that directory. No global install needed.

## Tools (34 total)

### Phase 1 — Device Control (18 tools)

| Tool | What it does |
|------|-------------|
| `list_devices` | List all connected Android devices/emulators |
| `get_device_info` | Model, manufacturer, Android version, SDK level |
| `get_screen_size` | Screen resolution in pixels |
| `take_screenshot` | Capture screenshot (PNG or JPEG, configurable quality & resize) |
| `get_ui_elements` | Get the accessibility/UI element tree as structured JSON |
| `tap` | Tap at coordinates |
| `double_tap` | Double tap at coordinates |
| `long_press` | Long press at coordinates |
| `swipe` | Swipe between two points |
| `type_text` | Type text into the focused field |
| `press_key` | Press a key (home, back, enter, volume, etc.) |
| `list_apps` | List installed apps |
| `get_current_app` | Get the foreground app |
| `launch_app` | Launch an app by package name |
| `stop_app` | Force stop an app |
| `install_app` | Install an APK |
| `uninstall_app` | Uninstall an app |
| `get_logs` | Get logcat entries with filtering |

### Phase 2 — AI Visual Analysis (8 tools)

These tools use AI vision (Claude or Gemini) to understand what's on screen. Requires `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY`.

| Tool | What it does |
|------|-------------|
| `analyze_screen` | AI describes the screen: app name, screen type, interactive elements, visible text, suggestions |
| `find_element` | Find a UI element by description: *"the login button"*, *"email input field"* |
| `smart_tap` | Find an element by description and tap it in one step |
| `smart_type` | Find an input field by description, focus it, and type text |
| `suggest_actions` | Plan actions to achieve a goal: *"log into the app"*, *"add item to cart"* |
| `visual_diff` | Compare current screen with a previous screenshot — what changed? |
| `extract_text` | Extract all visible text from the screen (AI-powered OCR) |
| `verify_screen` | Verify an assertion: *"the login was successful"*, *"error message is showing"* |

### Phase 3 — Flutter Widget Tree (8 tools)

These tools connect to a running Flutter app in debug/profile mode via the Dart VM Service Protocol. Maps every widget to its source code location (`file:line`).

| Tool | What it does |
|------|-------------|
| `flutter_connect` | Discover and connect to a running Flutter app on the device |
| `flutter_disconnect` | Disconnect from the Flutter app and clean up resources |
| `flutter_get_widget_tree` | Get the full widget tree (summary or detailed) |
| `flutter_get_widget_details` | Get detailed properties of a specific widget by ID |
| `flutter_find_widget` | Search the widget tree by type, text, or description |
| `flutter_get_source_map` | Map every widget to its source code location (file:line:column) |
| `flutter_screenshot_widget` | Screenshot a specific widget in isolation |
| `flutter_debug_paint` | Toggle debug paint overlay (shows widget boundaries & padding) |

## Performance

The server is optimized to minimize latency and AI token costs:

- **3-tier element search**: local text match (<1ms) → cached AI → fresh AI. `smart_tap` is 37x faster than naive AI calls.
- **Screenshot compression**: AI tools auto-compress to JPEG q=80, 720w — **65% smaller** (251KB → 88KB) with zero quality loss. Saves ~55K tokens per screenshot.
- **Parallel capture**: Screenshot + UI tree fetched simultaneously via `Promise.all()`.
- **TTL caching**: 3-second cache avoids redundant ADB calls for rapid-fire tool usage.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude vision | — |
| `GOOGLE_API_KEY` or `GEMINI_API_KEY` | Google API key for Gemini vision (recommended — cheapest) | — |
| `MCP_AI_PROVIDER` | Force AI provider: `"anthropic"` or `"google"` | Auto-detected |
| `MCP_AI_MODEL` | Override AI model | `gemini-2.5-flash` / `claude-sonnet-4-20250514` |
| `MCP_ADB_PATH` | Custom ADB binary path | Auto-discovered |
| `MCP_DEFAULT_DEVICE` | Default device serial | Auto-discovered |
| `MCP_SCREENSHOT_FORMAT` | `"png"` or `"jpeg"` | `jpeg` |
| `MCP_SCREENSHOT_QUALITY` | JPEG quality (1-100) | `80` |
| `MCP_SCREENSHOT_MAX_WIDTH` | Resize screenshots to this max width | `720` |
| `MCP_AI_SCREENSHOT` | Send screenshots to AI (`"true"`/`"false"`) | `true` |
| `MCP_AI_UITREE` | Send UI tree to AI (`"true"`/`"false"`) | `true` |

## Architecture

```
src/
├── index.ts              # CLI entry point (auto-discovery, env config)
├── server.ts             # MCP server factory
├── types.ts              # Shared interfaces
├── drivers/android/      # ADB driver (DeviceDriver implementation)
│   ├── adb.ts            # Low-level ADB command wrapper
│   └── index.ts          # AndroidDriver class
├── tools/                # MCP tool registrations
│   ├── device-tools.ts   # Device management
│   ├── screen-tools.ts   # Screenshots & UI inspection
│   ├── interaction-tools.ts # Touch, type, keys
│   ├── app-tools.ts      # App management
│   ├── log-tools.ts      # Logcat
│   ├── ai-tools.ts       # AI-powered tools
│   └── flutter-tools.ts  # Flutter widget inspection tools
├── drivers/flutter/      # Dart VM Service driver
│   ├── index.ts          # FlutterDriver (discovery, inspection, source mapping)
│   └── vm-service.ts     # JSON-RPC 2.0 WebSocket client (DDS redirect handling)
├── ai/                   # AI visual analysis engine
│   ├── client.ts         # Multi-provider client (Anthropic + Google)
│   ├── prompts.ts        # System prompts & UI element summarizer
│   ├── analyzer.ts       # ScreenAnalyzer orchestrator
│   └── element-search.ts # Local element search (no AI needed)
└── utils/
    ├── discovery.ts       # ADB auto-discovery
    └── image.ts           # PNG parsing, JPEG compression, bilinear resize
```

## Roadmap

- [x] Phase 1: Android ADB device control (18 tools)
- [x] Phase 2: AI visual analysis layer (8 tools)
- [x] Multi-provider AI (Anthropic Claude + Google Gemini)
- [x] Performance optimization (3-tier search, caching, parallel capture)
- [x] Screenshot compression pipeline (JPEG, resize, configurable quality)
- [x] npm publish (`npx mobile-device-mcp`)
- [x] Phase 3: Flutter widget tree integration (8 tools, Dart VM Service Protocol)
- [ ] Phase 4: iOS support (simulators via xcrun simctl, devices via idevice)
- [ ] Phase 5: Monetization (license keys, usage analytics)
- [ ] Multi-device orchestration

## Tested On

- Pixel 8, Android 16, SDK 36 — 44/44 tests passed (22 device + 10 AI + 12 Flutter)
- Flutter 3.41.3, metroping app (debug mode)
- Google Gemini 2.5 Flash
- Windows 11 + wireless ADB

## License

MIT
