// ============================================================
// Tool registration barrel — imports all tool modules and
// exposes a single registerAllTools() entry point.
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DeviceDriver } from "../types.js";

import { registerDeviceTools } from "./device-tools.js";
import { registerScreenTools } from "./screen-tools.js";
import { registerInteractionTools } from "./interaction-tools.js";
import { registerAppTools } from "./app-tools.js";
import { registerLogTools } from "./log-tools.js";
import { registerAITools } from "./ai-tools.js";
import { registerFlutterTools } from "./flutter-tools.js";
import type { ScreenAnalyzer } from "../ai/analyzer.js";
import type { FlutterDriver } from "../drivers/flutter/index.js";

export {
  registerDeviceTools,
  registerScreenTools,
  registerInteractionTools,
  registerAppTools,
  registerLogTools,
  registerFlutterTools,
};

/**
 * Register every MCP tool with the server.
 *
 * @param server      — The McpServer instance to register tools on.
 * @param getDriver   — A factory/getter that returns the active DeviceDriver.
 *                      Called lazily at tool-invocation time so the driver
 *                      does not need to exist when tools are registered.
 * @param getAnalyzer — A factory/getter that returns the ScreenAnalyzer, or null
 *                      if AI features are disabled.
 * @param getFlutter  — A factory/getter that returns the FlutterDriver.
 */
export function registerAllTools(
  server: McpServer,
  getDriver: () => DeviceDriver,
  getAnalyzer: () => ScreenAnalyzer | null,
  getFlutter: () => FlutterDriver,
): void {
  registerDeviceTools(server, getDriver);
  registerScreenTools(server, getDriver);
  registerInteractionTools(server, getDriver);
  registerAppTools(server, getDriver);
  registerLogTools(server, getDriver);
  registerAITools(server, getAnalyzer);
  registerFlutterTools(server, getFlutter);
}
