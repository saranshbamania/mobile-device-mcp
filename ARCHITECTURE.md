# mobile-device-mcp Architecture

> Generated 2026-03-15 | **Version 0.1.0** | Total source lines: **3,822**

## Build Status

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | PASS (0 errors) |
| All imports resolve | PASS |
| Circular dependencies | None detected |

---

## File Tree

```
E:\mcp\
├── package.json               # Project manifest (name: mobile-device-mcp)
├── tsconfig.json              # TypeScript config (ES2022, Node16 modules, strict)
├── .gitignore                 # Ignores node_modules/, dist/, .env, logs
│
└── src/                       # 17 source files, 3,822 lines total
    ├── index.ts           (135 lines)  CLI entry point; discovers ADB, builds config, starts server on stdio
    ├── server.ts           (55 lines)  Server factory; creates McpServer, wires driver + AI analyzer + tools
    ├── types.ts           (261 lines)  All shared TypeScript interfaces, enums, and default configs
    │
    ├── drivers/
    │   └── android/
    │       ├── adb.ts     (156 lines)  Low-level ADB binary wrapper (execute, executeBuffer)
    │       └── index.ts   (765 lines)  AndroidDriver: full DeviceDriver implementation over ADB
    │
    ├── tools/
    │   ├── index.ts        (46 lines)  Barrel; imports all tool modules, exports registerAllTools()
    │   ├── device-tools.ts(124 lines)  Device management tools (list, info, screen size)
    │   ├── screen-tools.ts(103 lines)  Screenshot and UI element inspection tools
    │   ├── interaction-tools.ts (358 lines) Touch/gesture/keyboard tools (tap, swipe, type, key press)
    │   ├── app-tools.ts   (273 lines)  App lifecycle tools (list, launch, stop, install, uninstall)
    │   ├── log-tools.ts    (76 lines)  Logcat retrieval tool
    │   └── ai-tools.ts    (305 lines)  AI-powered tool registrations (Phase 2)
    │
    ├── ai/
    │   ├── client.ts      (254 lines)  Anthropic SDK wrapper; retry logic, JSON parsing
    │   ├── prompts.ts     (197 lines)  System prompts, user prompt builders, UI element summarizer
    │   └── analyzer.ts    (454 lines)  ScreenAnalyzer: orchestrates screenshots + AI for smart features
    │
    └── utils/
        ├── discovery.ts   (186 lines)  Auto-discovers ADB path and default device
        └── image.ts        (74 lines)  PNG dimension parser, base64/size helpers
```

---

## Complete Tool Inventory

### Phase 1 -- Device Control (15 tools)

| # | Tool Name | Category | Parameters | Description |
|---|-----------|----------|------------|-------------|
| 1 | `list_devices` | Device | _(none)_ | List all connected Android devices and emulators |
| 2 | `get_device_info` | Device | `device_id: string` | Get detailed info for a specific device (model, version, screen size) |
| 3 | `get_screen_size` | Device | `device_id: string` | Get screen resolution in pixels |
| 4 | `take_screenshot` | Screen | `device_id: string` | Capture a PNG screenshot of the device screen |
| 5 | `get_ui_elements` | Screen | `device_id: string`, `interactive_only?: bool` | Retrieve the UI element accessibility tree |
| 6 | `tap` | Interaction | `device_id: string`, `x: number`, `y: number` | Single tap at coordinates |
| 7 | `double_tap` | Interaction | `device_id: string`, `x: number`, `y: number` | Double tap at coordinates |
| 8 | `long_press` | Interaction | `device_id: string`, `x: number`, `y: number`, `duration?: number` | Touch-and-hold at coordinates |
| 9 | `swipe` | Interaction | `device_id: string`, `start_x`, `start_y`, `end_x`, `end_y: number`, `duration?: number` | Swipe gesture between two points |
| 10 | `type_text` | Interaction | `device_id: string`, `text: string` | Type text into the focused input field |
| 11 | `press_key` | Interaction | `device_id: string`, `key: string` | Press a hardware/system key (home, back, enter, etc.) |
| 12 | `list_apps` | App | `device_id: string`, `include_system?: bool` | List installed applications |
| 13 | `get_current_app` | App | `device_id: string` | Get the foreground app's package and activity name |
| 14 | `launch_app` | App | `device_id: string`, `package_name: string` | Launch an app by package name |
| 15 | `stop_app` | App | `device_id: string`, `package_name: string` | Force-stop a running app |
| 16 | `install_app` | App | `device_id: string`, `apk_path: string` | Install an APK from the host machine |
| 17 | `uninstall_app` | App | `device_id: string`, `package_name: string` | Uninstall an app by package name |
| 18 | `get_logs` | Logs | `device_id: string`, `lines?: number`, `level?: enum`, `filter?: string` | Retrieve logcat entries with optional filtering |

### Phase 2 -- AI-Powered Visual Analysis (8 tools)

| # | Tool Name | Category | Parameters | Description |
|---|-----------|----------|------------|-------------|
| 19 | `analyze_screen` | AI | `device_id: string` | AI vision analysis of current screen (elements, text, screen type, suggestions) |
| 20 | `find_element` | AI | `device_id: string`, `query: string` | Find a UI element by natural language description |
| 21 | `suggest_actions` | AI | `device_id: string`, `goal: string` | AI-generated step-by-step action plan to achieve a goal |
| 22 | `visual_diff` | AI | `device_id: string`, `before_screenshot: string` | Compare current screen with a previous screenshot |
| 23 | `smart_tap` | AI | `device_id: string`, `element_description: string` | Find element by description and tap it in one step |
| 24 | `smart_type` | AI | `device_id: string`, `field_description: string`, `text: string` | Find input field by description, focus it, and type text |
| 25 | `extract_text` | AI | `device_id: string` | OCR -- extract all visible text from the screen |
| 26 | `verify_screen` | AI | `device_id: string`, `assertion: string` | Verify whether an assertion about the screen state is true |

**Total: 26 MCP tools** (18 Phase 1 + 8 Phase 2)

---

## Dependency Graph

Arrows read as "imports from". No circular dependencies exist.

```
src/index.ts
  ├── src/server.ts
  ├── src/utils/discovery.ts
  └── src/types.ts

src/server.ts
  ├── @modelcontextprotocol/sdk  (McpServer, StdioServerTransport)
  ├── src/types.ts
  ├── src/drivers/android/index.ts
  ├── src/tools/index.ts
  ├── src/ai/client.ts
  └── src/ai/analyzer.ts

src/types.ts
  └── (no local imports -- leaf module)

src/tools/index.ts
  ├── @modelcontextprotocol/sdk  (McpServer type)
  ├── src/types.ts
  ├── src/tools/device-tools.ts
  ├── src/tools/screen-tools.ts
  ├── src/tools/interaction-tools.ts
  ├── src/tools/app-tools.ts
  ├── src/tools/log-tools.ts
  ├── src/tools/ai-tools.ts
  └── src/ai/analyzer.ts  (type only)

src/tools/device-tools.ts
  ├── @modelcontextprotocol/sdk  (McpServer type)
  ├── zod
  └── src/types.ts

src/tools/screen-tools.ts
  ├── @modelcontextprotocol/sdk  (McpServer type)
  ├── zod
  └── src/types.ts

src/tools/interaction-tools.ts
  ├── @modelcontextprotocol/sdk  (McpServer type)
  ├── zod
  └── src/types.ts

src/tools/app-tools.ts
  ├── @modelcontextprotocol/sdk  (McpServer type)
  ├── zod
  └── src/types.ts

src/tools/log-tools.ts
  ├── @modelcontextprotocol/sdk  (McpServer type)
  ├── zod
  └── src/types.ts

src/tools/ai-tools.ts
  ├── @modelcontextprotocol/sdk  (McpServer type)
  ├── zod
  └── src/ai/analyzer.ts  (type only)

src/drivers/android/adb.ts
  ├── node:child_process
  ├── node:util
  └── src/types.ts

src/drivers/android/index.ts
  ├── src/drivers/android/adb.ts
  └── src/types.ts

src/utils/discovery.ts
  ├── node:child_process
  ├── node:util
  ├── node:fs
  ├── node:path
  └── node:os

src/utils/image.ts
  └── (no local imports -- leaf module)

src/ai/client.ts
  ├── @anthropic-ai/sdk
  └── src/types.ts

src/ai/prompts.ts
  └── src/types.ts  (UIElement type)

src/ai/analyzer.ts
  ├── @anthropic-ai/sdk
  ├── src/types.ts
  ├── src/ai/client.ts
  └── src/ai/prompts.ts
```

### Dependency Summary

| Module | Depended on by |
|--------|---------------|
| `src/types.ts` | 12 files (most-imported module) |
| `src/ai/analyzer.ts` | 2 files (server.ts, tools/index.ts) |
| `src/ai/client.ts` | 2 files (server.ts, ai/analyzer.ts) |
| `src/ai/prompts.ts` | 1 file (ai/analyzer.ts) |
| `src/drivers/android/adb.ts` | 1 file (drivers/android/index.ts) |
| `src/drivers/android/index.ts` | 1 file (server.ts) |
| `src/utils/discovery.ts` | 1 file (index.ts) |
| `src/utils/image.ts` | 0 files (unused -- utility module available for future use) |

---

## External Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.12.1 | MCP server framework (McpServer, StdioServerTransport) |
| `@anthropic-ai/sdk` | ^0.39.0 | Claude API client for AI vision features |
| `zod` | ^3.25.0 | Runtime schema validation for tool input parameters |
| `typescript` | ^5.7.0 | (dev) TypeScript compiler |
| `tsx` | ^4.0.0 | (dev) TypeScript execution for development |
| `@types/node` | ^22.0.0 | (dev) Node.js type definitions |

---

## Architecture Notes

1. **Layered design**: Entry point (`index.ts`) -> Server factory (`server.ts`) -> Tool registrations (`tools/`) -> Driver (`drivers/android/`) -> ADB binary.

2. **AI features are opt-in**: When `ANTHROPIC_API_KEY` is not set, the `ScreenAnalyzer` is `null` and all 8 AI tools return a clear "not available" message without crashing.

3. **Driver abstraction**: The `DeviceDriver` interface in `types.ts` allows future platform drivers (iOS, etc.) to be swapped in without changing tool code.

4. **All output on stderr**: The CLI entry point routes all diagnostic/log output to stderr, keeping stdout clean for the MCP JSON-RPC protocol.

5. **`src/utils/image.ts` is currently unused** by any source file. The `parsePngDimensions` function is instead defined inline in `src/drivers/android/index.ts`. This is a candidate for deduplication in a future cleanup.
