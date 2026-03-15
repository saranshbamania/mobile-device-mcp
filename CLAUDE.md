# CLAUDE.md — Project Context for AI Assistants

This file is automatically loaded by Claude Code. It contains everything needed to resume work on this project from any machine.

## What This Is

A commercial MCP server product (`mobile-device-mcp`) that gives AI coding assistants the ability to see and interact with mobile devices. It bridges the gap between AI tools (Claude Code, Cursor, Windsurf) and mobile development — web devs have browser tools, mobile devs have nothing. This product fixes that.

**This is a product being built for sale, not a hobby project.** All technical decisions should be justified through a commercial lens.

## Current State (as of 2026-03-16)

### Completed
- **Phase 1: Android ADB Device Control** — 18 MCP tools, fully tested on Pixel 8 (Android 16, SDK 36), 13/13 tests passed
- **Phase 2: AI Visual Analysis Layer** — 8 AI-powered MCP tools, multi-provider support (Anthropic Claude + Google Gemini), all 9/9 tests passed on real device
- **Performance Optimization** — 3-tier element search (local → cached AI → fresh AI), TTL-based caching, parallel capture, alias mapping. Result: smart_tap 37x faster (7.6s → 205ms), find_element 7000x faster (7.1s → 1ms)
- **GitHub repo**: https://github.com/saranshbamania/mobile-device-mcp
- **Screenshot Compression Pipeline** — Pure-JS JPEG encoding + bilinear resize (pngjs + jpeg-js). AI tools auto-compress to JPEG q=80, 720w. Result: 251KB→88KB (65% reduction), zero AI quality loss. All 32 tests pass (22 Phase 1 + 10 Phase 2).
- **Live tested** with Google Gemini 2.5 Flash on Pixel 8

### Not Yet Done
- **Phase 3: Flutter Widget Tree** — Connect to Dart VM Service Protocol for Flutter-specific widget inspection. Maps UI elements directly to source code file:line. Strongest technical moat. NOTE: Only works in Debug/Profile mode (VM service stripped from Release builds).
- **Phase 4: iOS Support** — Simulators first (xcrun simctl), physical devices later (idevice/pymobiledevice3). Apple frequently breaks device protocols — high maintenance.
- **Phase 5: Monetization** — License keys (Keygen.sh), usage analytics, free/paid tiers.
- **npm publish** — Not yet published. Run `npx mobile-device-mcp` should be the zero-config experience.

## Architecture Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Language | TypeScript / Node.js | npm distribution via `npx`, MCP SDK is TS-first, largest buyer market |
| Build approach | From scratch (Option D) | Full IP ownership, no upstream dependencies, free/paid boundary designed in |
| AI providers | Multi-provider (Anthropic + Google) | Don't lock customers to one provider, wider market reach |
| Default AI model | Gemini 2.5 Flash | Cheapest vision model (~$0.15/1M input tokens), good quality, free tier available |
| Screenshot format | Base64 inline | AI models consume images inline. File paths break in remote/cloud setups |
| UI tree format | Structured JSON (pruned from XML) | Raw XML is 50-200KB of noise. Parsed JSON saves tokens and money |
| State management | Stateless tools | Each MCP call independent. No session to manage = no session to break |
| Driver architecture | Modular (DeviceDriver interface) | Platform drivers (Android, iOS, Flutter) are swappable without changing tools |
| Element search | 3-tier: local text → cached AI → fresh AI | Local search is free and instant (<1ms), AI only called for ambiguous queries |
| Screenshot compression | JPEG q=80, 720w via pure JS | 65% size reduction, zero native deps for npx compat, AI quality unaffected |

## Performance Architecture

The system uses a 3-tier performance hierarchy for element finding:

1. **Tier 1 (Instant, Free)**: Local text search on cached UI tree
   - `searchElementsLocally()` in `element-search.ts` — text, content description, resource ID, class name matching
   - Alias system maps common UI terms (AC→clear, delete→del, etc.)
   - Number word conversion (five→5, 7→seven)
   - Returns in <1ms if confidence > 0.5

2. **Tier 2 (Fast, Costs Tokens)**: AI analysis with cached screenshot + UI tree
   - TTL-based cache (3s) avoids redundant ADB calls
   - Parallel capture of screenshot + UI tree via `Promise.all()`

3. **Tier 3 (Standard)**: Fresh device capture + AI analysis
   - Full ADB screenshot + uiautomator dump (~2.5s)
   - AI vision analysis (~3-10s depending on provider)

Cache invalidation after tap/type: only clears screenshot, keeps UI tree (button positions don't change after tap).

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
- `pngjs` — Pure-JS PNG decoding (for compression pipeline)
- `jpeg-js` — Pure-JS JPEG encoding (for compression pipeline)
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
│   ├── client.ts          # Multi-provider AI client (Anthropic + Google Gemini, retry with backoff)
│   ├── prompts.ts         # System prompts, user prompt builders, UI summarizer
│   ├── analyzer.ts        # ScreenAnalyzer: caching, parallel capture, local search fast path
│   └── element-search.ts  # Local element search: text/alias/number matching, no AI needed
└── utils/
    ├── discovery.ts       # Auto-find ADB, auto-detect device
    └── image.ts           # PNG parser, base64 helpers, JPEG compression pipeline (resize + encode)
```

## Key Patterns

- All tools use `server.registerTool()` (not deprecated `server.tool()`)
- All tool handlers wrapped in try/catch — return error text, never throw
- All user-facing output to stderr (stdout reserved for MCP JSON-RPC)
- All local imports use `.js` extension (ESM requirement)
- AI tools gracefully degrade: return helpful error when no API key
- `getDriver()` / `getAnalyzer()` lazy factory pattern for dependency injection
- Local element search tried before AI for `findElement`, `smartTap`, `smartType`
- Screenshot compression auto-applied for AI tools (JPEG q=80, 720w). Raw PNG available via take_screenshot tool params.

## Target Customers

1. **Individual mobile devs** ($15-30/mo) — using Claude Code, Cursor, Windsurf
2. **Mobile QA teams** ($50-200/seat/mo) — replacing brittle Appium/Detox scripts
3. **Enterprise** (custom) — CI/CD visual regression, multi-device orchestration

## Competitive Landscape

- `mobile-next/mobile-mcp` (3.9k stars) — most mature, but no AI visual analysis, no Flutter
- `appium/appium-mcp` (242 stars) — comprehensive but requires Appium server, complex setup
- `leancodepl/marionette_mcp` (190 stars) — Flutter-specific, no ADB device control
- **Our differentiation**: Unified device control + AI vision + multi-provider + zero-friction setup + performance optimization (local element search)

## Resuming Work

When continuing on a new machine, tell Claude Code:

> Pull https://github.com/saranshbamania/mobile-device-mcp and resume where I left off. Read CLAUDE.md for full context. Current status: Phase 1 (Android) and Phase 2 (AI vision) are complete and tested. Performance optimization is done. Next priorities are Phase 3 (Flutter widget tree) or npm publish. Check git log for recent changes.
