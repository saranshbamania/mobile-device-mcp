// ============================================================
// Test recording tools — record actions and generate test scripts
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActionRecorder } from "../recording/recorder.js";
import { generateTestScript } from "../recording/generator.js";

export function registerRecordingTools(
  server: McpServer,
  getRecorder: () => ActionRecorder,
): void {

  // ----------------------------------------------------------
  // start_test_recording
  // ----------------------------------------------------------
  server.registerTool(
    "start_test_recording",
    {
      title: "Start Test Recording",
      description:
        "Start recording all MCP tool calls to generate a reproducible test script. " +
        "All subsequent tool calls will be logged until stop_test_recording is called.",
      inputSchema: z.object({
        test_name: z
          .string()
          .optional()
          .describe("Name for the test (used in generated code)"),
      }),
    },
    async ({ test_name }) => {
      try {
        const recorder = getRecorder();
        if (recorder.isRecording) {
          return {
            content: [{
              type: "text" as const,
              text: "Already recording. Call stop_test_recording first.",
            }],
          };
        }
        recorder.startRecording(test_name);
        return {
          content: [{
            type: "text" as const,
            text: `Test recording started${test_name ? `: "${test_name}"` : ""}. All tool calls will be recorded.`,
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
  // stop_test_recording
  // ----------------------------------------------------------
  server.registerTool(
    "stop_test_recording",
    {
      title: "Stop Test Recording",
      description:
        "Stop recording and generate a test script from the recorded actions. " +
        "Supports TypeScript, Python, and JSON output formats.",
      inputSchema: z.object({
        format: z
          .enum(["typescript", "python", "json"])
          .optional()
          .default("typescript")
          .describe("Output format for the generated test"),
      }),
    },
    async ({ format }) => {
      try {
        const recorder = getRecorder();
        if (!recorder.isRecording) {
          return {
            content: [{
              type: "text" as const,
              text: "No active recording. Call start_test_recording first.",
            }],
          };
        }
        const actions = recorder.stopRecording();
        if (actions.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No actions were recorded.",
            }],
          };
        }

        const script = generateTestScript(actions, recorder.getTestName(), format);
        return {
          content: [{
            type: "text" as const,
            text: `Generated ${format} test with ${actions.length} steps:\n\n\`\`\`${format === "json" ? "json" : format === "python" ? "python" : "typescript"}\n${script}\n\`\`\``,
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
  // get_recorded_actions
  // ----------------------------------------------------------
  server.registerTool(
    "get_recorded_actions",
    {
      title: "Get Recorded Actions",
      description:
        "View the actions recorded so far without stopping the recording. " +
        "Useful for inspecting what has been captured.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const recorder = getRecorder();
        const actions = recorder.getActions();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              isRecording: recorder.isRecording,
              testName: recorder.getTestName(),
              actionCount: actions.length,
              actions: actions.map((a, i) => ({
                step: i + 1,
                tool: a.tool,
                params: a.params,
                durationMs: a.durationMs,
              })),
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
