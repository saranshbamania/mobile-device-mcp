// ============================================================
// MCP Server factory — creates and wires up the server
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerConfig } from "./types.js";
import { AndroidDriver } from "./drivers/android/index.js";
import { FlutterDriver } from "./drivers/flutter/index.js";
import { registerAllTools } from "./tools/index.js";
import { AIClient } from "./ai/client.js";
import { ScreenAnalyzer } from "./ai/analyzer.js";

/** Server version — matches package.json */
const SERVER_VERSION = "0.1.0";

/**
 * Create a configured MCP server ready to start.
 *
 * Returns the server instance and a `start()` function that connects
 * a stdio transport (the MCP JSON-RPC channel).
 */
export function createServer(config: ServerConfig): {
  server: McpServer;
  start: () => Promise<void>;
} {
  const server = new McpServer({
    name: "mobile-device-mcp",
    version: SERVER_VERSION,
  });

  const driver = new AndroidDriver(config.adbPath);
  const flutterDriver = new FlutterDriver(config.adbPath);

  // Set up AI features if configured
  let analyzer: ScreenAnalyzer | null = null;
  if (config.ai && config.ai.apiKey) {
    const aiClient = new AIClient(config.ai);
    analyzer = new ScreenAnalyzer(aiClient, driver, config.ai, {
      format: config.screenshotFormat,
      quality: config.screenshotQuality,
      maxWidth: config.screenshotMaxWidth,
    });
  }

  registerAllTools(server, () => driver, () => analyzer, () => flutterDriver);

  async function start(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  return { server, start };
}
