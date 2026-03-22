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
        "Capture a screenshot of the device screen. Returns the image with metadata (width, height, file size). Supports PNG (lossless, larger) and JPEG (compressed, smaller). Use format='jpeg' with quality and max_width to reduce image size for AI analysis.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        format: z
          .enum(["png", "jpeg"])
          .optional()
          .describe("Image format: 'png' (lossless, default) or 'jpeg' (compressed)"),
        quality: z
          .coerce.number()
          .min(1)
          .max(100)
          .optional()
          .describe("JPEG quality 1-100 (default: 80). Only used when format is 'jpeg'"),
        max_width: z
          .coerce.number()
          .min(100)
          .optional()
          .describe("Resize to this max width in pixels, maintaining aspect ratio. Reduces file size significantly"),
      }),
    },
    async ({ device_id, format, quality, max_width }) => {
      try {
        const driver = getDriver();
        const result = await driver.takeScreenshot(device_id, {
          format,
          quality,
          maxWidth: max_width,
        });
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
              mimeType: `image/${result.format}` as `image/png` | `image/jpeg`,
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
          .preprocess((v) => v === "true" || v === true, z.boolean())
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
