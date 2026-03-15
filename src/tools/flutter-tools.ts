// ============================================================
// Flutter tools — widget tree inspection via Dart VM Service
//
// These tools connect to a running Flutter app in debug/profile
// mode and provide widget tree inspection, source code mapping,
// and debug tools that no other MCP server offers.
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FlutterDriver } from "../drivers/flutter/index.js";
import type { WidgetNode } from "../drivers/flutter/vm-service.js";

/**
 * Register Flutter-specific MCP tools.
 *
 * @param server     — The McpServer instance.
 * @param getFlutter — Factory that returns the FlutterDriver, or null if unavailable.
 */
export function registerFlutterTools(
  server: McpServer,
  getFlutter: () => FlutterDriver,
): void {

  // ----------------------------------------------------------
  // flutter_connect
  // ----------------------------------------------------------
  server.registerTool(
    "flutter_connect",
    {
      title: "Connect to Flutter App",
      description:
        "Discover and connect to a running Flutter app on the device via the Dart VM Service Protocol. " +
        "The app must be running in debug or profile mode. Returns connection details including the " +
        "isolate ID and app name. Call this before using other flutter_* tools. " +
        "Optionally pass vm_service_url from 'flutter run' output if auto-discovery fails.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        vm_service_url: z.string().optional().describe(
          "Optional: VM service URL from 'flutter run' output (e.g., http://127.0.0.1:PORT/TOKEN=/). " +
          "Pass this if auto-discovery fails (logcat rotated).",
        ),
      }),
    },
    async ({ device_id, vm_service_url }) => {
      try {
        const flutter = getFlutter();
        const conn = await flutter.connect(device_id, vm_service_url);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              connected: true,
              appName: conn.appName,
              isolateId: conn.isolateId,
              vmServiceUrl: conn.vmServiceUrl,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error connecting to Flutter app: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // flutter_disconnect
  // ----------------------------------------------------------
  server.registerTool(
    "flutter_disconnect",
    {
      title: "Disconnect from Flutter App",
      description: "Disconnect from the currently connected Flutter app and clean up resources.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const flutter = getFlutter();
        await flutter.disconnect();
        return {
          content: [{
            type: "text" as const,
            text: "Disconnected from Flutter app.",
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error disconnecting: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // flutter_get_widget_tree
  // ----------------------------------------------------------
  server.registerTool(
    "flutter_get_widget_tree",
    {
      title: "Get Flutter Widget Tree",
      description:
        "Get the widget tree from the connected Flutter app. By default returns the summary tree " +
        "(user-created widgets only), which maps directly to your source code. Each widget includes " +
        "its type, properties, source code location (file:line), and children. " +
        "Call flutter_connect first.",
      inputSchema: z.object({
        summary_only: z
          .boolean()
          .optional()
          .default(true)
          .describe("Only return user-created widgets (true) or full framework tree (false)"),
      }),
    },
    async ({ summary_only }) => {
      try {
        const flutter = getFlutter();
        const tree = await flutter.getWidgetTree({ summaryTree: summary_only });

        // Prune the tree to reduce payload size for the LLM
        const pruned = pruneWidgetTree(tree, 0, 10);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(pruned, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error getting widget tree: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // flutter_get_widget_details
  // ----------------------------------------------------------
  server.registerTool(
    "flutter_get_widget_details",
    {
      title: "Get Flutter Widget Details",
      description:
        "Get detailed information about a specific widget by its valueId (obtained from flutter_get_widget_tree). " +
        "Returns properties, children, render bounds, and source location.",
      inputSchema: z.object({
        value_id: z.string().describe("The valueId of the widget from the widget tree"),
        subtree_depth: z
          .number()
          .optional()
          .default(2)
          .describe("How many levels of children to include (default: 2)"),
      }),
    },
    async ({ value_id, subtree_depth }) => {
      try {
        const flutter = getFlutter();
        const details = await flutter.getWidgetDetails(value_id, subtree_depth);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(details, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error getting widget details: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // flutter_find_widget
  // ----------------------------------------------------------
  server.registerTool(
    "flutter_find_widget",
    {
      title: "Find Flutter Widget",
      description:
        "Search the widget tree for widgets matching a query. Searches by widget type name, " +
        "description, and text content. Example queries: 'ElevatedButton', 'Text', 'AppBar', " +
        "'Login'. Returns matching widgets with their source locations.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Widget type, text, or description to search for (e.g., 'ElevatedButton', 'Login')"),
        summary_only: z
          .boolean()
          .optional()
          .default(true)
          .describe("Search only user-created widgets (true) or full tree (false)"),
      }),
    },
    async ({ query, summary_only }) => {
      try {
        const flutter = getFlutter();
        const tree = await flutter.getWidgetTree({ summaryTree: summary_only });
        const result = flutter.findWidget(tree, query);

        // Include source locations for matches
        const matchesWithSource = result.matches.map(m => ({
          widget: m.widgetRuntimeType || m.description,
          description: m.description,
          textPreview: m.textPreview,
          valueId: m.valueId,
          source: m.creationLocation ? {
            file: m.creationLocation.file.replace(/^file:\/\/\//, ""),
            line: m.creationLocation.line,
            column: m.creationLocation.column,
          } : null,
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              found: result.found,
              matchCount: result.matches.length,
              query: result.query,
              matches: matchesWithSource,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error finding widget: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // flutter_get_source_map
  // ----------------------------------------------------------
  server.registerTool(
    "flutter_get_source_map",
    {
      title: "Get Flutter Source Map",
      description:
        "Map every user-created widget to its source code location (file:line:column). " +
        "This is the key tool for connecting what you see on screen to where it is in code. " +
        "Returns a list of {widget, file, line, column} entries.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const flutter = getFlutter();
        const tree = await flutter.getWidgetTree({ summaryTree: true });
        const sourceMap = flutter.getSourceMap(tree);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              widgetCount: sourceMap.length,
              widgets: sourceMap,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error getting source map: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // flutter_screenshot_widget
  // ----------------------------------------------------------
  server.registerTool(
    "flutter_screenshot_widget",
    {
      title: "Screenshot Flutter Widget",
      description:
        "Take a screenshot of a specific Flutter widget by its valueId. " +
        "Returns the widget rendered in isolation as a PNG image.",
      inputSchema: z.object({
        value_id: z.string().describe("The valueId of the widget to screenshot"),
        width: z.number().optional().default(300).describe("Screenshot width in pixels"),
        height: z.number().optional().default(600).describe("Screenshot height in pixels"),
      }),
    },
    async ({ value_id, width, height }) => {
      try {
        const flutter = getFlutter();
        const base64 = await flutter.screenshotWidget(value_id, width, height);

        return {
          content: [
            {
              type: "text" as const,
              text: `Widget screenshot (${width}x${height})`,
            },
            {
              type: "image" as const,
              data: base64,
              mimeType: "image/png" as const,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error screenshotting widget: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // flutter_debug_paint
  // ----------------------------------------------------------
  server.registerTool(
    "flutter_debug_paint",
    {
      title: "Toggle Flutter Debug Paint",
      description:
        "Toggle the debug paint overlay on the Flutter app. Shows widget boundaries, " +
        "padding, alignment guides, and construction lines. Useful for debugging layout issues.",
      inputSchema: z.object({
        enabled: z.boolean().describe("Enable (true) or disable (false) debug paint"),
      }),
    },
    async ({ enabled }) => {
      try {
        const flutter = getFlutter();
        await flutter.toggleDebugPaint(enabled);

        return {
          content: [{
            type: "text" as const,
            text: `Debug paint ${enabled ? "enabled" : "disabled"}.`,
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error toggling debug paint: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    },
  );
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Prune a widget tree to reduce payload size for the LLM.
 * Keeps essential fields, removes internal framework noise.
 */
function pruneWidgetTree(node: WidgetNode, depth: number, maxDepth: number): Record<string, unknown> {
  const pruned: Record<string, unknown> = {
    widget: node.widgetRuntimeType || node.description,
  };

  if (node.description !== node.widgetRuntimeType) {
    pruned.description = node.description;
  }

  if (node.textPreview) {
    pruned.text = node.textPreview;
  }

  if (node.valueId) {
    pruned.valueId = node.valueId;
  }

  if (node.creationLocation && node.createdByLocalProject) {
    pruned.source = {
      file: node.creationLocation.file.replace(/^file:\/\/\//, ""),
      line: node.creationLocation.line,
    };
  }

  if (node.children && node.children.length > 0 && depth < maxDepth) {
    pruned.children = node.children.map(c => pruneWidgetTree(c, depth + 1, maxDepth));
  } else if (node.hasChildren && depth >= maxDepth) {
    pruned.hasMoreChildren = true;
  }

  return pruned;
}
