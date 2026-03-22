// ============================================================
// IOSSimulatorDriver — DeviceDriver implementation for iOS Simulators
// Uses xcrun simctl for all device interaction.
// Only available on macOS.
// ============================================================

import { Simctl } from "./simctl.js";
import { processScreenshot } from "../../utils/image.js";
import type {
  ADBResult,
  AppInfo,
  DeviceDriver,
  DeviceInfo,
  LogEntry,
  LogOptions,
  ScreenshotOptions,
  ScreenshotResult,
  SwipeResult,
  TapResult,
  UIElement,
  UIElementOptions,
} from "../../types.js";

export class IOSSimulatorDriver implements DeviceDriver {
  private readonly simctl: Simctl;

  constructor() {
    this.simctl = new Simctl();
  }

  // ================================================================
  // Device management
  // ================================================================

  async listDevices(): Promise<DeviceInfo[]> {
    const result = await this.simctl.execute(["list", "devices", "--json"]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to list simulators: ${result.stderr}`);
    }

    const data = JSON.parse(result.stdout) as {
      devices: Record<string, Array<{
        udid: string;
        name: string;
        state: string;
        deviceTypeIdentifier?: string;
        isAvailable?: boolean;
      }>>;
    };

    const devices: DeviceInfo[] = [];
    for (const [runtime, sims] of Object.entries(data.devices)) {
      const iosVersion = runtime.match(/iOS[- ](\d+[\d.]*)/)?.[1] ||
                          runtime.match(/(\d+[\d.]*)/)?.[1] || "";
      for (const sim of sims) {
        if (sim.state !== "Booted" && sim.state !== "Shutdown") continue;
        devices.push({
          id: sim.udid,
          name: sim.name,
          model: sim.name,
          manufacturer: "Apple",
          androidVersion: "",
          sdkVersion: "",
          status: sim.state === "Booted" ? "device" : "offline",
          isEmulator: true,
          platform: "ios",
          osVersion: iosVersion,
        });
      }
    }

    return devices;
  }

  async getDeviceInfo(deviceId: string): Promise<DeviceInfo> {
    const devices = await this.listDevices();
    const device = devices.find(d => d.id === deviceId);
    if (!device) throw new Error(`Simulator ${deviceId} not found`);
    return device;
  }

  async getScreenSize(deviceId: string): Promise<{ width: number; height: number }> {
    // Take a screenshot and read dimensions from the image
    const screenshot = await this.takeScreenshot(deviceId, { format: "png" });
    return { width: screenshot.width, height: screenshot.height };
  }

  // ================================================================
  // Screenshots & UI
  // ================================================================

  async takeScreenshot(deviceId: string, options?: ScreenshotOptions): Promise<ScreenshotResult> {
    const t0 = Date.now();
    const pngBuffer = await this.simctl.executeBuffer(["io", deviceId, "screenshot", "--type=png", "-"]);

    if (pngBuffer.length === 0) {
      throw new Error(`Screenshot returned empty buffer for simulator ${deviceId}`);
    }

    const processed = processScreenshot(pngBuffer, options);
    console.error(`[iOS takeScreenshot] ${Date.now() - t0}ms | ${processed.width}x${processed.height} ${processed.format}`);

    return {
      base64: processed.base64,
      width: processed.width,
      height: processed.height,
      format: processed.format,
      timestamp: t0,
      sizeBytes: processed.sizeBytes,
    };
  }

  async getUIElements(_deviceId: string, _options?: UIElementOptions): Promise<UIElement[]> {
    // iOS simulators don't have a built-in UI hierarchy dump like Android's UIAutomator.
    // This would require XCTest framework or Accessibility Inspector integration.
    // For now, return empty array — AI vision tools can still identify elements via screenshots.
    return [];
  }

  // ================================================================
  // Interaction
  // ================================================================

  async tap(deviceId: string, x: number, y: number): Promise<TapResult> {
    // simctl supports tap since Xcode 15+
    const result = await this.simctl.execute([
      "io", deviceId, "tap", String(Math.round(x)), String(Math.round(y)),
    ]);
    return { success: result.exitCode === 0, x: Math.round(x), y: Math.round(y) };
  }

  async doubleTap(deviceId: string, x: number, y: number): Promise<TapResult> {
    const rx = Math.round(x);
    const ry = Math.round(y);
    await this.simctl.execute(["io", deviceId, "tap", String(rx), String(ry)]);
    await new Promise(r => setTimeout(r, 50));
    const r2 = await this.simctl.execute(["io", deviceId, "tap", String(rx), String(ry)]);
    return { success: r2.exitCode === 0, x: rx, y: ry };
  }

  async longPress(deviceId: string, x: number, y: number, duration: number = 1000): Promise<TapResult> {
    const rx = Math.round(x);
    const ry = Math.round(y);
    // Simulate long press via swipe from point to same point
    const result = await this.simctl.execute([
      "io", deviceId, "swipe",
      String(rx), String(ry), String(rx), String(ry),
      "--duration", String(duration / 1000),
    ]);
    return { success: result.exitCode === 0, x: rx, y: ry };
  }

  async swipe(
    deviceId: string,
    startX: number, startY: number,
    endX: number, endY: number,
    duration: number = 300,
  ): Promise<SwipeResult> {
    const sx = Math.round(startX), sy = Math.round(startY);
    const ex = Math.round(endX), ey = Math.round(endY);
    const result = await this.simctl.execute([
      "io", deviceId, "swipe",
      String(sx), String(sy), String(ex), String(ey),
      "--duration", String(duration / 1000),
    ]);
    return { success: result.exitCode === 0, startX: sx, startY: sy, endX: ex, endY: ey, duration };
  }

  async typeText(deviceId: string, text: string): Promise<{ success: boolean }> {
    const result = await this.simctl.execute(["io", deviceId, "type", text]);
    return { success: result.exitCode === 0 };
  }

  async pressKey(deviceId: string, keycode: string): Promise<{ success: boolean }> {
    // Map common keycodes to simctl equivalents
    const keyMap: Record<string, string> = {
      "KEYCODE_HOME": "home",
      "home": "home",
      "KEYCODE_ENTER": "return",
      "enter": "return",
      "return": "return",
    };
    const mapped = keyMap[keycode] || keycode;

    if (mapped === "home") {
      const result = await this.simctl.execute(["io", deviceId, "keyevent", "home"]);
      return { success: result.exitCode === 0 };
    }

    // For other keys, use keyboard input
    const result = await this.simctl.execute(["io", deviceId, "type", mapped]);
    return { success: result.exitCode === 0 };
  }

  // ================================================================
  // App management
  // ================================================================

  async listApps(deviceId: string, _includeSystem: boolean = false): Promise<AppInfo[]> {
    const result = await this.simctl.execute(["listapps", deviceId]);
    if (result.exitCode !== 0) return [];

    // Parse plist-style output for bundle IDs
    const apps: AppInfo[] = [];
    const bundleIdMatches = result.stdout.matchAll(/CFBundleIdentifier\s*=\s*"?([^";\n]+)"?/g);
    for (const match of bundleIdMatches) {
      apps.push({ packageName: match[1].trim(), isSystemApp: false });
    }
    return apps;
  }

  async getCurrentApp(_deviceId: string): Promise<{ packageName: string; activityName: string }> {
    // No direct equivalent in simctl — return foreground app info if possible
    return { packageName: "unknown", activityName: "unknown" };
  }

  async launchApp(deviceId: string, packageName: string): Promise<{ success: boolean }> {
    const result = await this.simctl.execute(["launch", deviceId, packageName]);
    return { success: result.exitCode === 0 };
  }

  async stopApp(deviceId: string, packageName: string): Promise<{ success: boolean }> {
    const result = await this.simctl.execute(["terminate", deviceId, packageName]);
    return { success: result.exitCode === 0 };
  }

  async installApp(deviceId: string, appPath: string): Promise<{ success: boolean }> {
    const result = await this.simctl.execute(["install", deviceId, appPath]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to install ${appPath}: ${result.stderr}`);
    }
    return { success: true };
  }

  async uninstallApp(deviceId: string, packageName: string): Promise<{ success: boolean }> {
    const result = await this.simctl.execute(["uninstall", deviceId, packageName]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to uninstall ${packageName}: ${result.stderr}`);
    }
    return { success: true };
  }

  // ================================================================
  // Logs
  // ================================================================

  async getLogs(deviceId: string, options?: LogOptions): Promise<LogEntry[]> {
    const args = ["spawn", deviceId, "log", "show", "--style", "compact", "--last", "1m"];

    if (options?.filter) {
      args.push("--predicate", options.filter);
    }

    const result = await this.simctl.execute(args);
    if (result.exitCode !== 0) return [];

    const entries: LogEntry[] = [];
    const lines = result.stdout.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      // Simplified parsing for iOS log format
      const match = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+\S+\s+(\S+)\s+(\S+)\s+(.*)/);
      if (match) {
        entries.push({
          timestamp: match[1],
          pid: 0,
          tid: 0,
          level: "I",
          tag: match[3],
          message: match[4],
        });
      }
    }

    const limit = options?.lines ?? entries.length;
    return entries.slice(-limit);
  }

  // ================================================================
  // Raw shell
  // ================================================================

  async shell(deviceId: string, command: string): Promise<ADBResult> {
    const result = await this.simctl.execute(["spawn", deviceId, ...command.split(" ")]);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  // ================================================================
  // iOS-specific methods
  // ================================================================

  async bootSimulator(deviceId: string): Promise<{ success: boolean }> {
    const result = await this.simctl.execute(["boot", deviceId]);
    return { success: result.exitCode === 0 };
  }

  async shutdownSimulator(deviceId: string): Promise<{ success: boolean }> {
    const result = await this.simctl.execute(["shutdown", deviceId]);
    return { success: result.exitCode === 0 };
  }
}
