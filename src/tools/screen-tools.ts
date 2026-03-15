// ============================================================
// Screen tools — screenshots and UI element inspection
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DeviceDriver } from "../types.js";

export function registerScreenTools(
  server: McpServer,
  getDriver: () => DeviceDriver,
): void {
  // ----------------------------------------------------------
  // take_screenshot
  // ----------------------------------------------------------
  server.registerTool(
    "take_screenshot",
    {
      title: "Take Screenshot",
      description:
        "Capture a screenshot of the device screen. Returns the image as a PNG along with metadata (width, height, file size). Use this to visually inspect what is currently displayed on the device.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
      }),
    },
    async ({ device_id }) => {
      try {
        const driver = getDriver();
        const result = await driver.takeScreenshot(device_id);
        const sizeKB = (result.sizeBytes / 1024).toFixed(1);
        return {
          content: [
            {
              type: "text" as const,
              text: `Screenshot captured: ${result.width}x${result.height} ${result.format.toUpperCase()}, ${sizeKB} KB`,
            },
            {
              type: "image" as const,
              data: result.base64,
              mimeType: `image/${result.format}` as const,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error taking screenshot on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // get_ui_elements
  // ----------------------------------------------------------
  server.registerTool(
    "get_ui_elements",
    {
      title: "Get UI Elements",
      description:
        "Retrieve the current UI element tree from the device screen. Each element includes its index, text, content description, class name, resource ID, bounding box with center coordinates (useful for tap targets), and boolean states (clickable, scrollable, focusable, enabled, selected, checked). By default only interactive elements are returned. Set interactive_only to false to get all elements. This is the primary tool for understanding what is on screen and deciding where to tap.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        interactive_only: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Only return interactive elements (clickable, focusable, scrollable)",
          ),
      }),
    },
    async ({ device_id, interactive_only }) => {
      try {
        const driver = getDriver();
        const elements = await driver.getUIElements(device_id, {
          interactiveOnly: interactive_only,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(elements, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting UI elements on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
