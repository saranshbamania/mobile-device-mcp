# mobile-device-mcp

MCP server that gives AI coding assistants (Claude Code, Cursor, Windsurf) the ability to **see and interact with mobile devices**. 26 tools for screenshots, UI inspection, touch interaction, and AI-powered visual analysis.

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

### Install & Run

```bash
# Clone and build
git clone https://github.com/saranshbamania/mobile-device-mcp.git
cd mobile-device-mcp
npm install
npm run build

# Run (auto-discovers ADB and connected devices)
node dist/index.js
```

### Configure with Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "mobile-device": {
      "command": "node",
      "args": ["/path/to/mobile-device-mcp/dist/index.js"],
      "env": {
        "GOOGLE_API_KEY": "your-google-api-key",
        "ANTHROPIC_API_KEY": "your-anthropic-api-key"
      }
    }
  }
}
```

### Configure with Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mobile-device": {
      "command": "node",
      "args": ["/path/to/mobile-device-mcp/dist/index.js"],
      "env": {
        "GOOGLE_API_KEY": "your-google-api-key"
      }
    }
  }
}
```

## Tools (26 total)

### Phase 1 — Device Control (18 tools)

| Tool | What it does |
|------|-------------|
| `list_devices` | List all connected Android devices/emulators |
| `get_device_info` | Model, manufacturer, Android version, SDK level |
| `get_screen_size` | Screen resolution in pixels |
| `take_screenshot` | Capture PNG screenshot (returned as base64 image) |
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

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude vision | — |
| `GOOGLE_API_KEY` or `GEMINI_API_KEY` | Google API key for Gemini vision | — |
| `MCP_AI_PROVIDER` | Force AI provider: `"anthropic"` or `"google"` | Auto-detected |
| `MCP_AI_MODEL` | Override AI model | `claude-sonnet-4-20250514` / `gemini-2.0-flash` |
| `MCP_ADB_PATH` | Custom ADB binary path | Auto-discovered |
| `MCP_DEFAULT_DEVICE` | Default device serial | Auto-discovered |
| `MCP_SCREENSHOT_FORMAT` | `"png"` or `"jpeg"` | `png` |
| `MCP_SCREENSHOT_QUALITY` | JPEG quality (1-100) | `80` |
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
│   └── ai-tools.ts       # AI-powered tools
├── ai/                   # AI visual analysis engine
│   ├── client.ts         # Multi-provider client (Anthropic + Google)
│   ├── prompts.ts        # System prompts & UI element summarizer
│   └── analyzer.ts       # ScreenAnalyzer orchestrator
└── utils/
    ├── discovery.ts       # ADB auto-discovery
    └── image.ts           # PNG parsing utilities
```

## Roadmap

- [x] Phase 1: Android ADB device control (18 tools)
- [x] Phase 2: AI visual analysis layer (8 tools)
- [x] Multi-provider AI (Anthropic Claude + Google Gemini)
- [ ] Phase 3: Flutter widget tree integration (Dart VM Service Protocol)
- [ ] Phase 4: iOS support (simulators via xcrun simctl, devices via idevice)
- [ ] Phase 5: Monetization (license keys, usage analytics)
- [ ] npm publish (`npx mobile-device-mcp`)
- [ ] Screenshot compression pipeline (JPEG, thumbnail mode)
- [ ] Multi-device orchestration

## Tested On

- Pixel 8, Android 16, SDK 36 — 13/13 device tests passed
- Windows 11 + ADB over TCP

## License

MIT
