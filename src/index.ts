#!/usr/bin/env node
// ============================================================
// CLI entry point for mobile-device-mcp
//
// All user-facing output goes to stderr.
// stdout is reserved for the MCP JSON-RPC protocol.
// ============================================================

import { createServer } from "./server.js";
import { findAdbPath, getDefaultDevice } from "./utils/discovery.js";
import { DEFAULT_CONFIG, DEFAULT_AI_CONFIG } from "./types.js";
import type { ServerConfig } from "./types.js";

const PREFIX = "[mobile-device-mcp]";

/** Write a message to stderr (never stdout). */
function log(message: string): void {
  process.stderr.write(`${PREFIX} ${message}\n`);
}

/** Parse an env var as a positive integer, or return undefined. */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function main(): Promise<void> {
  log("Starting...");

  // 1. Discover ADB
  let adbPath: string;
  const envAdbPath = process.env["MCP_ADB_PATH"];
  if (envAdbPath) {
    adbPath = envAdbPath;
    log(`Using ADB from MCP_ADB_PATH: ${adbPath}`);
  } else {
    adbPath = await findAdbPath();
    log(`Found ADB: ${adbPath}`);
  }

  // 2. Discover default device
  let defaultDevice: string | undefined = process.env["MCP_DEFAULT_DEVICE"];
  if (!defaultDevice) {
    defaultDevice = await getDefaultDevice(adbPath);
  }
  if (defaultDevice) {
    log(`Default device: ${defaultDevice}`);
  }

  // 3. Build config from defaults + env overrides
  const screenshotFormat = process.env["MCP_SCREENSHOT_FORMAT"];
  const config: ServerConfig = {
    adbPath,
    defaultDevice,
    screenshotFormat:
      screenshotFormat === "jpeg" || screenshotFormat === "png"
        ? screenshotFormat
        : DEFAULT_CONFIG.screenshotFormat,
    screenshotQuality:
      envInt("MCP_SCREENSHOT_QUALITY") ?? DEFAULT_CONFIG.screenshotQuality,
    screenshotMaxWidth:
      envInt("MCP_SCREENSHOT_MAX_WIDTH") ?? DEFAULT_CONFIG.screenshotMaxWidth,
  };

  // 3b. AI configuration — supports Anthropic and Google Gemini
  const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
  const googleKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
  const apiKey = anthropicKey || googleKey || process.env.MCP_AI_API_KEY || "";

  if (apiKey) {
    // Auto-detect provider from which key is set; env var can override.
    const envProvider = process.env.MCP_AI_PROVIDER;
    let provider: "anthropic" | "google";
    if (envProvider === "anthropic" || envProvider === "google") {
      provider = envProvider;
    } else if (googleKey && !anthropicKey) {
      provider = "google";
    } else {
      provider = "anthropic";
    }

    // Default model depends on provider.
    const defaultModel =
      provider === "google" ? "gemini-2.5-flash" : "claude-sonnet-4-20250514";

    config.ai = {
      provider,
      apiKey,
      model: process.env.MCP_AI_MODEL || defaultModel,
      maxTokens: parseInt(process.env.MCP_AI_MAX_TOKENS || String(DEFAULT_AI_CONFIG.maxTokens)),
      analyzeWithScreenshot: process.env.MCP_AI_SCREENSHOT !== "false",
      analyzeWithUITree: process.env.MCP_AI_UITREE !== "false",
    };
    log(`AI features enabled (provider: ${provider}, model: ${config.ai.model})`);
  } else {
    log("AI features disabled (set ANTHROPIC_API_KEY or GOOGLE_API_KEY to enable)");
  }

  // 4. Create and start the server
  const { start } = createServer(config);
  await start();

  log("Server running on stdio");
}

// ------------------------------------------------------------------
// Graceful shutdown
// ------------------------------------------------------------------

function shutdown(signal: string): void {
  log(`Received ${signal}, shutting down...`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ------------------------------------------------------------------
// Error handling
// ------------------------------------------------------------------

process.on("uncaughtException", (error: Error) => {
  log(`Fatal error: ${error.message}`);
  if (error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  const message =
    reason instanceof Error ? reason.message : String(reason);
  log(`Unhandled rejection: ${message}`);
  if (reason instanceof Error && reason.stack) {
    process.stderr.write(`${reason.stack}\n`);
  }
  process.exit(1);
});

// ------------------------------------------------------------------
// Run
// ------------------------------------------------------------------

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error);
  log(`Failed to start: ${message}`);
  if (error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});
