// ============================================================
// Device management tools — list, info, screen size
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DeviceDriver } from "../types.js";

export function registerDeviceTools(
  server: McpServer,
  getDriver: () => DeviceDriver,
): void {
  // ----------------------------------------------------------
  // list_devices
  // ----------------------------------------------------------
  server.registerTool(
    "list_devices",
    {
      title: "List Devices",
      description:
        "List all connected Android devices and emulators. Returns an array of DeviceInfo objects including id, model, manufacturer, Android version, connection status, and whether the device is an emulator.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const driver = getDriver();
        const devices = await driver.listDevices();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(devices, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing devices: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // get_device_info
  // ----------------------------------------------------------
  server.registerTool(
    "get_device_info",
    {
      title: "Get Device Info",
      description:
        "Get detailed information about a specific Android device, including model, manufacturer, Android version, SDK version, connection status, screen size, and whether it is an emulator.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
      }),
    },
    async ({ device_id }) => {
      try {
        const driver = getDriver();
        const info = await driver.getDeviceInfo(device_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(info, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting device info for "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // get_screen_size
  // ----------------------------------------------------------
  server.registerTool(
    "get_screen_size",
    {
      title: "Get Screen Size",
      description:
        "Get the screen resolution of a connected Android device. Returns the width and height in pixels.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
      }),
    },
    async ({ device_id }) => {
      try {
        const driver = getDriver();
        const size = await driver.getScreenSize(device_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(size, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting screen size for "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
