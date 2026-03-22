// ============================================================
// Video recording tools — screen recording via ADB screenrecord
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AndroidDriver } from "../drivers/android/index.js";

export function registerVideoTools(
  server: McpServer,
  getDriver: () => AndroidDriver,
): void {

  // ----------------------------------------------------------
  // record_screen
  // ----------------------------------------------------------
  server.registerTool(
    "record_screen",
    {
      title: "Record Device Screen",
      description:
        "Start recording the device screen as MP4 video. Android has a 3-minute " +
        "maximum per recording. Only one recording per device at a time. " +
        "Call stop_recording to finish and save the video.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        max_duration: z
          .number()
          .optional()
          .describe("Maximum recording duration in seconds (max 180)"),
        bit_rate: z
          .number()
          .optional()
          .describe("Video bit rate in bits/sec (default: 20Mbps)"),
        resolution: z
          .string()
          .optional()
          .describe("Video resolution WIDTHxHEIGHT (e.g., '1280x720')"),
      }),
    },
    async ({ device_id, max_duration, bit_rate, resolution }) => {
      try {
        const driver = getDriver();
        const result = await driver.startRecording(device_id, {
          maxDuration: max_duration,
          bitRate: bit_rate,
          resolution,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              recording: true,
              devicePath: result.devicePath,
              message: "Screen recording started. Call stop_recording to finish.",
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // stop_recording
  // ----------------------------------------------------------
  server.registerTool(
    "stop_recording",
    {
      title: "Stop Screen Recording",
      description:
        "Stop an active screen recording and save the MP4 video. " +
        "Optionally pull the recording file from the device to the host machine.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        pull_to_path: z
          .string()
          .optional()
          .describe("Local file path to save the recording (e.g., './recording.mp4')"),
      }),
    },
    async ({ device_id, pull_to_path }) => {
      try {
        const driver = getDriver();
        const result = await driver.stopRecording(device_id, pull_to_path);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              recording: false,
              devicePath: result.devicePath,
              localPath: result.localPath,
              durationMs: result.durationMs,
              durationSec: Math.round(result.durationMs / 1000),
              message: result.localPath
                ? `Recording saved to ${result.localPath}`
                : `Recording saved on device at ${result.devicePath}`,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    },
  );
}
