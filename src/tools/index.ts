// ============================================================
// Tool registration barrel — imports all tool modules and
// exposes a single registerAllTools() entry point.
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DeviceDriver } from "../types.js";
import type { AndroidDriver } from "../drivers/android/index.js";

import { registerDeviceTools } from "./device-tools.js";
import { registerScreenTools } from "./screen-tools.js";
import { registerInteractionTools } from "./interaction-tools.js";
import { registerAppTools } from "./app-tools.js";
import { registerLogTools } from "./log-tools.js";
import { registerAITools } from "./ai-tools.js";
import { registerFlutterTools } from "./flutter-tools.js";
import { registerVideoTools } from "./video-tools.js";
import { registerRecordingTools } from "./recording-tools.js";
import { registerIOSTools } from "./ios-tools.js";
import type { ScreenAnalyzer } from "../ai/analyzer.js";
import type { FlutterDriver } from "../drivers/flutter/index.js";
import type { ActionRecorder } from "../recording/recorder.js";
import type { IOSSimulatorDriver } from "../drivers/ios/index.js";

export {
  registerDeviceTools,
  registerScreenTools,
  registerInteractionTools,
  registerAppTools,
  registerLogTools,
  registerFlutterTools,
  registerVideoTools,
  registerRecordingTools,
  registerIOSTools,
};

// Tools that are part of the recording system itself — don't record these
const RECORDING_TOOLS = new Set([
  "start_test_recording",
  "stop_test_recording",
  "get_recorded_actions",
]);

/**
 * Create a proxy around McpServer that intercepts registerTool calls
 * to auto-record tool invocations when the ActionRecorder is active.
 */
function createRecordingProxy(server: McpServer, getRecorder: () => ActionRecorder): McpServer {
  const originalRegisterTool = server.registerTool.bind(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, config: any, cb: (...args: any[]) => any) => {
    if (RECORDING_TOOLS.has(name)) {
      return originalRegisterTool(name, config, cb as any);
    }

    const hasInputSchema = config.inputSchema != null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedCb = async (...args: any[]) => {
      const recorder = getRecorder();
      const startTime = Date.now();
      const result = await cb(...args);
      if (recorder.isRecording) {
        const params = hasInputSchema ? args[0] : {};
        const textContent = result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n") || "";
        recorder.recordAction(name, params as Record<string, unknown>, textContent, Date.now() - startTime);
      }
      return result;
    };

    return originalRegisterTool(name, config, wrappedCb as any);
  };

  return server;
}

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
  getAndroidDriver?: () => AndroidDriver,
  getRecorder?: () => ActionRecorder,
  getIOSDriver?: () => IOSSimulatorDriver | null,
): void {
  // Wrap server with recording proxy if recorder is available
  const registrationServer = getRecorder ? createRecordingProxy(server, getRecorder) : server;

  registerDeviceTools(registrationServer, getDriver);
  registerScreenTools(registrationServer, getDriver);
  registerInteractionTools(registrationServer, getDriver);
  registerAppTools(registrationServer, getDriver);
  registerLogTools(registrationServer, getDriver);
  registerAITools(registrationServer, getAnalyzer);
  registerFlutterTools(registrationServer, getFlutter);
  if (getAndroidDriver) {
    registerVideoTools(registrationServer, getAndroidDriver);
  }
  if (getRecorder) {
    registerRecordingTools(registrationServer, getRecorder);
  }
  if (getIOSDriver) {
    registerIOSTools(registrationServer, getIOSDriver);
  }
}
