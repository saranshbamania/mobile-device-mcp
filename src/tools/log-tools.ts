// ============================================================
// Log tools — retrieve logcat entries
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DeviceDriver } from "../types.js";

export function registerLogTools(
  server: McpServer,
  getDriver: () => DeviceDriver,
): void {
  // ----------------------------------------------------------
  // get_logs
  // ----------------------------------------------------------
  server.registerTool(
    "get_logs",
    {
      title: "Get Logs",
      description:
        "Retrieve recent Android logcat entries from the device. You can filter by minimum log level (V=Verbose, D=Debug, I=Info, W=Warning, E=Error, F=Fatal) and/or by tag name. Returns structured JSON with timestamp, PID, TID, level, tag, and message for each entry.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        lines: z
          .coerce.number()
          .optional()
          .default(50)
          .describe("Number of recent log lines to retrieve"),
        level: z
          .enum(["V", "D", "I", "W", "E", "F"])
          .optional()
          .describe(
            "Minimum log level: V(erbose), D(ebug), I(nfo), W(arning), E(rror), F(atal)",
          ),
        filter: z
          .string()
          .optional()
          .describe("Filter by tag name (e.g. 'ActivityManager', 'System.err')"),
      }),
    },
    async ({ device_id, lines, level, filter }) => {
      try {
        const driver = getDriver();
        const logs = await driver.getLogs(device_id, {
          lines,
          level,
          filter,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: logs.length,
                  entries: logs,
                },
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
              text: `Error getting logs from "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
