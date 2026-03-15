// ============================================================
// AI-powered tools — visual analysis, smart interactions,
// element finding, and screen verification via Claude vision.
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ScreenAnalyzer } from "../ai/analyzer.js";

/** Standard error payload when AI features are unavailable. */
const AI_UNAVAILABLE = {
  content: [
    {
      type: "text" as const,
      text: "AI features are not available. Set ANTHROPIC_API_KEY environment variable to enable AI-powered tools.",
    },
  ],
  isError: true,
};

/**
 * Format a value as a JSON text MCP response with 2-space indentation.
 */
function jsonResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

/**
 * Format an error as a text MCP response.
 */
function errorResponse(label: string, error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error in ${label}: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  };
}

/**
 * Register AI-powered MCP tools on the given server.
 *
 * @param server       — The McpServer instance to register tools on.
 * @param getAnalyzer  — Returns the active ScreenAnalyzer, or null if AI
 *                       features are not configured (missing API key).
 */
export function registerAITools(
  server: McpServer,
  getAnalyzer: () => ScreenAnalyzer | null,
): void {
  // ----------------------------------------------------------
  // analyze_screen
  // ----------------------------------------------------------
  server.registerTool(
    "analyze_screen",
    {
      title: "Analyze Screen (AI)",
      description:
        "Uses AI vision to analyze the current screen of a mobile device. Returns a structured analysis including app name, screen type, interactive elements with coordinates, visible text, and suggested next actions. This is the primary tool for understanding what is currently displayed on the device.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
      }),
    },
    async ({ device_id }) => {
      try {
        const analyzer = getAnalyzer();
        if (!analyzer) return AI_UNAVAILABLE;

        const analysis = await analyzer.analyzeScreen(device_id);
        return jsonResponse(analysis);
      } catch (error) {
        return errorResponse("analyze_screen", error);
      }
    },
  );

  // ----------------------------------------------------------
  // find_element
  // ----------------------------------------------------------
  server.registerTool(
    "find_element",
    {
      title: "Find Element by Description (AI)",
      description:
        "Uses AI vision to find a specific UI element by natural language description. Returns the element's coordinates, type, and confidence score. Use this when you need to locate a specific button, field, or other UI element. Example queries: 'the login button', 'email input field', 'the red error message'.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        query: z
          .string()
          .describe(
            "Natural language description of the element to find, e.g. 'the blue Submit button' or 'email input field'",
          ),
      }),
    },
    async ({ device_id, query }) => {
      try {
        const analyzer = getAnalyzer();
        if (!analyzer) return AI_UNAVAILABLE;

        const match = await analyzer.findElement(device_id, query);
        return jsonResponse(match);
      } catch (error) {
        return errorResponse("find_element", error);
      }
    },
  );

  // ----------------------------------------------------------
  // suggest_actions
  // ----------------------------------------------------------
  server.registerTool(
    "suggest_actions",
    {
      title: "Suggest Actions for Goal (AI)",
      description:
        "Uses AI to analyze the current screen and suggest a sequence of actions to achieve a specified goal. Returns step-by-step instructions with exact coordinates for each action. Example goals: 'log into the app', 'navigate to settings', 'add an item to cart'.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        goal: z
          .string()
          .describe(
            "What you want to accomplish, e.g. 'log into the app' or 'navigate to settings'",
          ),
      }),
    },
    async ({ device_id, goal }) => {
      try {
        const analyzer = getAnalyzer();
        if (!analyzer) return AI_UNAVAILABLE;

        const plan = await analyzer.suggestActions(device_id, goal);
        return jsonResponse(plan);
      } catch (error) {
        return errorResponse("suggest_actions", error);
      }
    },
  );

  // ----------------------------------------------------------
  // visual_diff
  // ----------------------------------------------------------
  server.registerTool(
    "visual_diff",
    {
      title: "Visual Diff (AI)",
      description:
        "Compares the current screen with a previous screenshot to identify what changed. Provide a base64 PNG screenshot as the 'before' image — the tool captures the current screen as the 'after' image. Returns a list of changes with descriptions and regions. Useful for verifying that an action had the expected effect.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        before_screenshot: z
          .string()
          .describe(
            "Base64-encoded PNG of the previous screen state to compare against",
          ),
      }),
    },
    async ({ device_id, before_screenshot }) => {
      try {
        const analyzer = getAnalyzer();
        if (!analyzer) return AI_UNAVAILABLE;

        const diff = await analyzer.compareScreenshots(
          device_id,
          before_screenshot,
        );
        return jsonResponse(diff);
      } catch (error) {
        return errorResponse("visual_diff", error);
      }
    },
  );

  // ----------------------------------------------------------
  // smart_tap
  // ----------------------------------------------------------
  server.registerTool(
    "smart_tap",
    {
      title: "Smart Tap (AI)",
      description:
        "Finds a UI element by natural language description and taps it. Combines element finding and tapping into a single action. Example: smart_tap('the Sign In button') will locate the button and tap its center coordinates. Returns whether the tap succeeded and which element was tapped.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        element_description: z
          .string()
          .describe(
            "Description of the element to tap, e.g. 'the Submit button' or 'the settings icon'",
          ),
      }),
    },
    async ({ device_id, element_description }) => {
      try {
        const analyzer = getAnalyzer();
        if (!analyzer) return AI_UNAVAILABLE;

        const result = await analyzer.smartTap(device_id, element_description);
        return jsonResponse(result);
      } catch (error) {
        return errorResponse("smart_tap", error);
      }
    },
  );

  // ----------------------------------------------------------
  // smart_type
  // ----------------------------------------------------------
  server.registerTool(
    "smart_type",
    {
      title: "Smart Type (AI)",
      description:
        "Finds an input field by natural language description, taps it to focus, and types the specified text. Example: smart_type('email field', 'user@example.com') will find the email input, tap it, and type the email address.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        field_description: z
          .string()
          .describe(
            "Description of the input field, e.g. 'email field' or 'search bar'",
          ),
        text: z.string().describe("Text to type into the field"),
      }),
    },
    async ({ device_id, field_description, text }) => {
      try {
        const analyzer = getAnalyzer();
        if (!analyzer) return AI_UNAVAILABLE;

        const result = await analyzer.smartType(
          device_id,
          field_description,
          text,
        );
        return jsonResponse(result);
      } catch (error) {
        return errorResponse("smart_type", error);
      }
    },
  );

  // ----------------------------------------------------------
  // extract_text
  // ----------------------------------------------------------
  server.registerTool(
    "extract_text",
    {
      title: "Extract Text from Screen (AI)",
      description:
        "Uses AI vision to extract all visible text from the current screen. Returns text in reading order (top to bottom, left to right). Useful for reading content, checking labels, or getting text that isn't in the accessibility tree.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
      }),
    },
    async ({ device_id }) => {
      try {
        const analyzer = getAnalyzer();
        if (!analyzer) return AI_UNAVAILABLE;

        const texts = await analyzer.extractText(device_id);
        return jsonResponse({ texts });
      } catch (error) {
        return errorResponse("extract_text", error);
      }
    },
  );

  // ----------------------------------------------------------
  // verify_screen
  // ----------------------------------------------------------
  server.registerTool(
    "verify_screen",
    {
      title: "Verify Screen State (AI)",
      description:
        "Uses AI to verify whether a specific assertion about the current screen is true. Returns a boolean result with confidence score and evidence. Example assertions: 'the login was successful', 'an error message is displayed', 'the cart has 3 items'.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        assertion: z
          .string()
          .describe(
            "What to verify about the current screen state, e.g. 'the login was successful' or 'an error message is showing'",
          ),
      }),
    },
    async ({ device_id, assertion }) => {
      try {
        const analyzer = getAnalyzer();
        if (!analyzer) return AI_UNAVAILABLE;

        const verification = await analyzer.verifyScreen(device_id, assertion);
        return jsonResponse(verification);
      } catch (error) {
        return errorResponse("verify_screen", error);
      }
    },
  );
}
