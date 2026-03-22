// ============================================================
// App management tools — list, launch, stop, install, uninstall
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DeviceDriver } from "../types.js";

export function registerAppTools(
  server: McpServer,
  getDriver: () => DeviceDriver,
): void {
  // ----------------------------------------------------------
  // list_apps
  // ----------------------------------------------------------
  server.registerTool(
    "list_apps",
    {
      title: "List Apps",
      description:
        "List all installed applications on the device. By default only user-installed (non-system) apps are returned. Set include_system to true to also include system apps. Each entry contains the package name, display name, version, and whether it is a system app.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        include_system: z
          .preprocess((v) => v === "true" || v === true, z.boolean())
          .optional()
          .default(false)
          .describe("Include system apps in the listing"),
      }),
    },
    async ({ device_id, include_system }) => {
      try {
        const driver = getDriver();
        const apps = await driver.listApps(device_id, include_system);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(apps, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing apps on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // get_current_app
  // ----------------------------------------------------------
  server.registerTool(
    "get_current_app",
    {
      title: "Get Current App",
      description:
        "Get the package name and activity name of the app that is currently in the foreground on the device. Useful for determining what the user is currently looking at.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
      }),
    },
    async ({ device_id }) => {
      try {
        const driver = getDriver();
        const current = await driver.getCurrentApp(device_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(current, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting current app on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // launch_app
  // ----------------------------------------------------------
  server.registerTool(
    "launch_app",
    {
      title: "Launch App",
      description:
        "Launch an installed application by its package name (e.g. 'com.android.chrome'). The app will be started with its default/main activity. Use list_apps to discover available package names.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        package_name: z
          .string()
          .describe("Android package name (e.g. 'com.android.chrome')"),
      }),
    },
    async ({ device_id, package_name }) => {
      try {
        const driver = getDriver();
        const result = await driver.launchApp(device_id, package_name);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...result, packageName: package_name },
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
              text: `Error launching "${package_name}" on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // stop_app
  // ----------------------------------------------------------
  server.registerTool(
    "stop_app",
    {
      title: "Stop App",
      description:
        "Force-stop a running application by its package name. This immediately terminates the app process. Useful for resetting app state or freeing resources.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        package_name: z
          .string()
          .describe("Android package name to force-stop"),
      }),
    },
    async ({ device_id, package_name }) => {
      try {
        const driver = getDriver();
        const result = await driver.stopApp(device_id, package_name);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...result, packageName: package_name },
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
              text: `Error stopping "${package_name}" on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // install_app
  // ----------------------------------------------------------
  server.registerTool(
    "install_app",
    {
      title: "Install App",
      description:
        "Install an Android application from an APK file on the host machine. Provide the full path to the .apk file. The APK will be pushed to the device and installed.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        apk_path: z
          .string()
          .describe("Path to the APK file on the host machine"),
      }),
    },
    async ({ device_id, apk_path }) => {
      try {
        const driver = getDriver();
        const result = await driver.installApp(device_id, apk_path);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...result, apkPath: apk_path },
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
              text: `Error installing APK "${apk_path}" on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ----------------------------------------------------------
  // uninstall_app
  // ----------------------------------------------------------
  server.registerTool(
    "uninstall_app",
    {
      title: "Uninstall App",
      description:
        "Uninstall an application from the device by its package name. This removes the app and all its data. System apps cannot be uninstalled without root access.",
      inputSchema: z.object({
        device_id: z.string().describe("Device serial ID"),
        package_name: z
          .string()
          .describe("Android package name to uninstall"),
      }),
    },
    async ({ device_id, package_name }) => {
      try {
        const driver = getDriver();
        const result = await driver.uninstallApp(device_id, package_name);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...result, packageName: package_name },
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
              text: `Error uninstalling "${package_name}" on "${device_id}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
