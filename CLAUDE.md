# CLAUDE.md — Project Context for AI Assistants

This file is automatically loaded by Claude Code. It contains everything needed to resume work on this project from any machine.

## What This Is

A commercial MCP server product (`mobile-device-mcp`) that gives AI coding assistants the ability to see and interact with mobile devices. It bridges the gap between AI tools (Claude Code, Cursor, Windsurf) and mobile development — web devs have browser tools, mobile devs have nothing. This product fixes that.

**This is a product being built for sale, not a hobby project.** All technical decisions should be justified through a commercial lens.

## Current State (as of 2026-03-15)

### Completed
- **Phase 1: Android ADB Device Control** — 18 MCP tools, fully tested on Pixel 8 (Android 16, SDK 36), 13/13 tests passed
- **Phase 2: AI Visual Analysis Layer** — 8 AI-powered MCP tools, multi-provider support (Anthropic Claude + Google Gemini), graceful degradation when no API key set
- **GitHub repo**: https://github.com/saranshbamania/mobile-device-mcp

### Not Yet Done
- **Phase 3: Flutter Widget Tree** — Connect to Dart VM Service Protocol for Flutter-specific widget inspection. Maps UI elements directly to source code file:line. Strongest technical moat. NOTE: Only works in Debug/Profile mode (VM service stripped from Release builds).
- **Phase 4: iOS Support** — Simulators first (xcrun simctl), physical devices later (idevice/pymobiledevice3). Apple frequently breaks device protocols — high maintenance.
- **Phase 5: Monetization** — License keys (Keygen.sh), usage analytics, free/paid tiers.
- **npm publish** — Not yet published. Run `npx mobile-device-mcp` should be the zero-config experience.
- **Screenshot compression** — Currently raw PNG. Need JPEG compression, thumbnail mode, and configurable quality to reduce token costs.
- **Live AI testing** — Phase 2 AI tools compile and handle errors correctly but haven't been tested with a real API key against a real device yet.

## Architecture Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Language | TypeScript / Node.js | npm distribution via `npx`, MCP SDK is TS-first, largest buyer market |
| Build approach | From scratch (Option D) | Full IP ownership, no upstream dependencies, free/paid boundary designed in |
| AI providers | Multi-provider (Anthropic + Google) | Don't lock customers to one provider, wider market reach |
| Screenshot format | Base64 inline | AI models consume images inline. File paths break in remote/cloud setups |
| UI tree format | Structured JSON (pruned from XML) | Raw XML is 50-200KB of noise. Parsed JSON saves tokens and money |
| State management | Stateless tools | Each MCP call independent. No session to manage = no session to break |
| Driver architecture | Modular (DeviceDriver interface) | Platform drivers (Android, iOS, Flutter) are swappable without changing tools |

## Known Risks

1. **Token bloat**: Base64 screenshots + JSON on every call. Mitigate with vision/tree mode toggle, image compression, thumbnail option.
2. **Flutter debug-only**: Dart VM Service Protocol stripped from Release builds. QA/enterprise features must use ADB accessibility tree.
3. **iOS maintenance**: Apple breaks idevice protocols with iOS updates. Ship Android first, iOS simulators before physical devices.
4. **Local license cracking**: MCP servers run locally, npm packages are crackable. Focus revenue on B2B/enterprise, accept some piracy on individual tier.
5. **Zero-friction GTM**: Biggest adoption hurdle is setup friction, not price. `npx` command must auto-find ADB, auto-discover devices, work instantly.

## Tech Stack

- TypeScript 5.7+, Node.js 18+, ESM modules
- `@modelcontextprotocol/sdk` v1.27.1 — MCP server framework
- `@anthropic-ai/sdk` v0.39.0 — Claude API (AI vision)
- `@google/generative-ai` v0.24.1 — Gemini API (AI vision)
- `zod` v3.25 — Tool input schema validation
- ADB (Android Debug Bridge) for device communication

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run dev          # Run with tsx (hot reload)
npm start            # Run compiled version
npx tsc --noEmit     # Type-check without building
```

## File Structure

```
src/
├── index.ts              # CLI entry (#!/usr/bin/env node, auto-discovery)
├── server.ts             # MCP server factory
├── types.ts              # ALL shared interfaces (DeviceDriver, AIConfig, etc.)
├── drivers/android/
│   ├── adb.ts            # Low-level ADB wrapper (child_process.execFile)
│   └── index.ts          # AndroidDriver implements DeviceDriver (765 lines)
├── tools/
│   ├── index.ts           # Barrel: registerAllTools()
│   ├── device-tools.ts    # list_devices, get_device_info, get_screen_size
│   ├── screen-tools.ts    # take_screenshot, get_ui_elements
│   ├── interaction-tools.ts # tap, double_tap, long_press, swipe, type_text, press_key
│   ├── app-tools.ts       # list_apps, get_current_app, launch_app, stop_app, install_app, uninstall_app
│   ├── log-tools.ts       # get_logs
│   └── ai-tools.ts        # analyze_screen, find_element, smart_tap, smart_type, suggest_actions, visual_diff, extract_text, verify_screen
├── ai/
│   ├── client.ts          # Multi-provider AI client (Anthropic + Google Gemini)
│   ├── prompts.ts         # System prompts, user prompt builders, UI summarizer
│   └── analyzer.ts        # ScreenAnalyzer: orchestrates screenshot + AI
└── utils/
    ├── discovery.ts       # Auto-find ADB, auto-detect device
    └── image.ts           # PNG parser, base64 helpers (currently unused - inline in driver)
```

## Key Patterns

- All tools use `server.registerTool()` (not deprecated `server.tool()`)
- All tool handlers wrapped in try/catch — return error text, never throw
- All user-facing output to stderr (stdout reserved for MCP JSON-RPC)
- All local imports use `.js` extension (ESM requirement)
- AI tools gracefully degrade: return helpful error when no API key
- `getDriver()` / `getAnalyzer()` lazy factory pattern for dependency injection

## Target Customers

1. **Individual mobile devs** ($15-30/mo) — using Claude Code, Cursor, Windsurf
2. **Mobile QA teams** ($50-200/seat/mo) — replacing brittle Appium/Detox scripts
3. **Enterprise** (custom) — CI/CD visual regression, multi-device orchestration

## Competitive Landscape

- `mobile-next/mobile-mcp` (3.9k stars) — most mature, but no AI visual analysis, no Flutter
- `appium/appium-mcp` (242 stars) — comprehensive but requires Appium server, complex setup
- `leancodepl/marionette_mcp` (190 stars) — Flutter-specific, no ADB device control
- **Our differentiation**: Unified device control + AI vision + multi-provider + zero-friction setup
