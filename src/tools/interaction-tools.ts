// ============================================================
// Interaction tools — tap, swipe, type, key press
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DeviceDriver } from "../types.js";

/**
 * Map of human-friendly key names to Android KEYCODE numeric values.
 * Consumers can pass either a friendly name ("home") or a raw numeric
 * code ("3") — both are accepted by the press_key tool.
 */
const KEY_MAP: Record<string, number> = {
  home: 3,
  back: 4,
  call: 5,
  endcall: 6,
  "0": 7,
  "1": 8,
  "2": 9,
  "3": 10,
  "4": 11,
  "5": 12,
  "6": 13,
  "7": 14,
  "8": 15,
  "9": 16,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
  dpad_center: 23,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  camera: 27,
  clear: 28,
  tab: 61,
  space: 62,
  enter: 66,
  del: 67,
  delete: 67,
  menu: 82,
  search: 84,
  media_play_pause: 85,
  media_stop: 86,
  media_next: 87,
  media_previous: 88,
  page_up: 92,
  page_down: 93,
  escape: 111,
  forward_del: 112,
  app_switch: 187,
  wakeup: 224,
  sleep: 223,
  brightness_up: 221,
  brightness_down: 220,
};

/**
 * Resolve a key name or numeric string to an Android keycode string
 * (e.g. "KEYCODE_HOME" or "KEYCODE_3").
 */
function resolveKeycode(key: string): string {
  const normalized = key.toLowerCase().trim();

  // Check the friendly-name map first
  if (normalized in KEY_MAP) {
    return String(KEY_MAP[normalized]);
  }

  // If the input is already numeric, pass it through directly
  if (/^\d+$/.test(normalized)) {
    return normalized;
  }

  // If the user passed something like "KEYCODE_HOME", strip the prefix
  // and try the map again, then fall back to the raw value.
  const withoutPrefix = normalized.replace(/^keycode_/, "");
  if (withoutPrefix in KEY_MAP) {
    return String(KEY_MAP[withoutPrefix]);
  }

  // Last resort — pass as-is and let ADB figure it out
  return key;
}

export function registerInteractionTools(
  server: McpServer,
  getDriver: () => DeviceDriver,
): void {
  // ----------------------------------------------------------
  // tap
  // ----------------------------------------------------------
  server.registerTool(
    "tap",
    {
      title: "Tap",
      description:
        "Perform a single tap at the given (x, y) screen coordinates. Use get_ui_elements first to find the centerX/centerY of the element you want to tap.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        x: z.number().describe("X coordinate in pixels"),
        y: z.number().describe("Y coordinate in pixels"),
      }),
    },
    async ({ device_id, x, y }) => {
      try {
        const driver = getDriver();
        const result = await driver.tap(device_id, x, y);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error tapping at (${x}, ${y}) on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // double_tap
  // ----------------------------------------------------------
  server.registerTool(
    "double_tap",
    {
      title: "Double Tap",
      description:
        "Perform a double tap at the given (x, y) screen coordinates. Useful for zooming into maps/images or selecting text.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        x: z.number().describe("X coordinate in pixels"),
        y: z.number().describe("Y coordinate in pixels"),
      }),
    },
    async ({ device_id, x, y }) => {
      try {
        const driver = getDriver();
        const result = await driver.doubleTap(device_id, x, y);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error double-tapping at (${x}, ${y}) on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // long_press
  // ----------------------------------------------------------
  server.registerTool(
    "long_press",
    {
      title: "Long Press",
      description:
        "Perform a long press (touch and hold) at the given (x, y) screen coordinates. Commonly used to open context menus, start drag operations, or trigger secondary actions.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        x: z.number().describe("X coordinate in pixels"),
        y: z.number().describe("Y coordinate in pixels"),
        duration: z
          .number()
          .optional()
          .default(1000)
          .describe("Duration of the long press in milliseconds"),
      }),
    },
    async ({ device_id, x, y, duration }) => {
      try {
        const driver = getDriver();
        const result = await driver.longPress(device_id, x, y, duration);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error long-pressing at (${x}, ${y}) on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // swipe
  // ----------------------------------------------------------
  server.registerTool(
    "swipe",
    {
      title: "Swipe",
      description:
        "Perform a swipe gesture from (start_x, start_y) to (end_x, end_y). Use this to scroll through lists, dismiss notifications, navigate between pages, or pull down the notification shade. A shorter duration makes the swipe faster (flick), while a longer duration makes it slower (drag).",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        start_x: z.number().describe("Starting X coordinate in pixels"),
        start_y: z.number().describe("Starting Y coordinate in pixels"),
        end_x: z.number().describe("Ending X coordinate in pixels"),
        end_y: z.number().describe("Ending Y coordinate in pixels"),
        duration: z
          .number()
          .optional()
          .default(300)
          .describe("Swipe duration in milliseconds (lower = faster)"),
      }),
    },
    async ({ device_id, start_x, start_y, end_x, end_y, duration }) => {
      try {
        const driver = getDriver();
        const result = await driver.swipe(
          device_id,
          start_x,
          start_y,
          end_x,
          end_y,
          duration,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error swiping on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // type_text
  // ----------------------------------------------------------
  server.registerTool(
    "type_text",
    {
      title: "Type Text",
      description:
        "Type text into the currently focused input field on the device. Make sure an input field is focused first (tap on it). Special characters and Unicode are supported.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        text: z.string().describe("Text to type on the device"),
      }),
    },
    async ({ device_id, text }) => {
      try {
        const driver = getDriver();
        const result = await driver.typeText(device_id, text);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error typing text on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // press_key
  // ----------------------------------------------------------
  server.registerTool(
    "press_key",
    {
      title: "Press Key",
      description:
        "Press a hardware or system key on the device. Accepts friendly key names such as 'home', 'back', 'enter', 'volume_up', 'volume_down', 'power', 'tab', 'delete', 'menu', 'search', 'app_switch', 'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right', 'camera', 'escape', 'space', 'media_play_pause', 'media_next', 'media_previous'. You may also pass a raw Android keycode number as a string (e.g. '3' for HOME).",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        key: z
          .string()
          .describe(
            "Android keycode name like 'home', 'back', 'enter', 'volume_up', 'power', 'tab', 'delete', 'menu', or a numeric keycode",
          ),
      }),
    },
    async ({ device_id, key }) => {
      try {
        const driver = getDriver();
        const keycode = resolveKeycode(key);
        const result = await driver.pressKey(device_id, keycode);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...result, key, resolvedKeycode: keycode },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error pressing key "${key}" on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
