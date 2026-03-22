// ============================================================
// iOS Simulator tools — boot, shutdown, and simulator management
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IOSSimulatorDriver } from "../drivers/ios/index.js";

export function registerIOSTools(
  server: McpServer,
  getIOSDriver: () => IOSSimulatorDriver | null,
): void {

  // ----------------------------------------------------------
  // ios_list_simulators
  // ----------------------------------------------------------
  server.registerTool(
    "ios_list_simulators",
    {
      title: "List iOS Simulators",
      description:
        "List all available iOS simulators with their status (Booted/Shutdown), " +
        "UDID, name, and iOS version. Works on macOS only.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const driver = getIOSDriver();
        if (!driver) {
          return {
            content: [{ type: "text" as const, text: "iOS simulator support is only available on macOS." }],
          };
        }
        const devices = await driver.listDevices();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(devices, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // ios_boot_simulator
  // ----------------------------------------------------------
  server.registerTool(
    "ios_boot_simulator",
    {
      title: "Boot iOS Simulator",
      description: "Boot an iOS simulator by its UDID. Get the UDID from ios_list_simulators.",
      inputSchema: z.object({
        device_id: z.string().describe("Simulator UDID"),
      }),
    },
    async ({ device_id }) => {
      try {
        const driver = getIOSDriver();
        if (!driver) {
          return {
            content: [{ type: "text" as const, text: "iOS simulator support is only available on macOS." }],
          };
        }
        const result = await driver.bootSimulator(device_id);
        return {
          content: [{ type: "text" as const, text: result.success ? `Simulator ${device_id} booted.` : "Failed to boot simulator." }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // ios_shutdown_simulator
  // ----------------------------------------------------------
  server.registerTool(
    "ios_shutdown_simulator",
    {
      title: "Shutdown iOS Simulator",
      description: "Shutdown a running iOS simulator by its UDID.",
      inputSchema: z.object({
        device_id: z.string().describe("Simulator UDID"),
      }),
    },
    async ({ device_id }) => {
      try {
        const driver = getIOSDriver();
        if (!driver) {
          return {
            content: [{ type: "text" as const, text: "iOS simulator support is only available on macOS." }],
          };
        }
        const result = await driver.shutdownSimulator(device_id);
        return {
          content: [{ type: "text" as const, text: result.success ? `Simulator ${device_id} shut down.` : "Failed to shutdown simulator." }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // ios_screenshot
  // ----------------------------------------------------------
  server.registerTool(
    "ios_screenshot",
    {
      title: "iOS Simulator Screenshot",
      description: "Take a screenshot of a running iOS simulator. Returns the image as base64.",
      inputSchema: z.object({
        device_id: z.string().describe("Simulator UDID"),
        format: z.enum(["png", "jpeg"]).optional().default("png").describe("Image format"),
      }),
    },
    async ({ device_id, format }) => {
      try {
        const driver = getIOSDriver();
        if (!driver) {
          return {
            content: [{ type: "text" as const, text: "iOS simulator support is only available on macOS." }],
          };
        }
        const screenshot = await driver.takeScreenshot(device_id, { format });
        return {
          content: [
            { type: "text" as const, text: `Screenshot: ${screenshot.width}x${screenshot.height} ${screenshot.format}` },
            { type: "image" as const, data: screenshot.base64, mimeType: format === "jpeg" ? "image/jpeg" as const : "image/png" as const },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    },
  );
}
