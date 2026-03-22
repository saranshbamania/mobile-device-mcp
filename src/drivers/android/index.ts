// ============================================================
// AndroidDriver — DeviceDriver implementation backed by ADB
// ============================================================

import { ADB } from "./adb.js";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { CompanionClient } from "./companion-client.js";
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
import { processScreenshot } from "../../utils/image.js";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Small async sleep utility. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Escape text for use inside `adb shell input text`. */
function escapeForAdbInput(text: string): string {
  // `input text` treats spaces specially — use %s instead.
  // Shell metacharacters need to be escaped with backslash.
  return text
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "%s")
    .replace(/(["`$!&|;()<>{}[\]*?#~^])/g, "\\$1")
    .replace(/'/g, "\\'");
}

/**
 * Parse a bounds string like "[0,72][1080,1920]" into structured bounds.
 */
function parseBounds(boundsStr: string): UIElement["bounds"] {
  const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    return { left: 0, top: 0, right: 0, bottom: 0, centerX: 0, centerY: 0 };
  }

  const left = parseInt(match[1], 10);
  const top = parseInt(match[2], 10);
  const right = parseInt(match[3], 10);
  const bottom = parseInt(match[4], 10);

  return {
    left,
    top,
    right,
    bottom,
    centerX: Math.round((left + right) / 2),
    centerY: Math.round((top + bottom) / 2),
  };
}

/**
 * Extract a single XML attribute value from a tag string.
 * Returns empty string if not found.
 */
function getAttr(nodeStr: string, name: string): string {
  // Match name="value" — value may contain escaped quotes
  const pattern = new RegExp(`${name}="([^"]*)"`, "i");
  const match = nodeStr.match(pattern);
  return match ? match[1] : "";
}

/**
 * Parse a single `<node .../>` or `<node ...>` element from uiautomator XML
 * into a UIElement.
 */
function parseNodeElement(nodeStr: string, index: number): UIElement {
  return {
    index,
    text: getAttr(nodeStr, "text"),
    contentDescription: getAttr(nodeStr, "content-desc"),
    className: getAttr(nodeStr, "class"),
    packageName: getAttr(nodeStr, "package"),
    resourceId: getAttr(nodeStr, "resource-id"),
    bounds: parseBounds(getAttr(nodeStr, "bounds")),
    clickable: getAttr(nodeStr, "clickable") === "true",
    scrollable: getAttr(nodeStr, "scrollable") === "true",
    focusable: getAttr(nodeStr, "focusable") === "true",
    enabled: getAttr(nodeStr, "enabled") === "true",
    selected: getAttr(nodeStr, "selected") === "true",
    checked: getAttr(nodeStr, "checked") === "true",
  };
}

// ------------------------------------------------------------------
// AndroidDriver
// ------------------------------------------------------------------

export class AndroidDriver implements DeviceDriver {
  private readonly adb: ADB;

  /** Per-device companion app clients (cached). */
  private companionClients = new Map<string, CompanionClient>();
  /** Devices where companion connection already failed (avoid repeated latency). */
  private companionUnavailable = new Set<string>();

  /** Active screen recordings per device. */
  private recordings = new Map<string, { process: ChildProcess; devicePath: string; startTime: number }>();

  constructor(adbPath: string = "adb") {
    this.adb = new ADB(adbPath);
  }

  /**
   * Try to get a connected CompanionClient for the given device.
   * Returns null if the companion app is not installed or not reachable.
   * Caches the result to avoid repeated connection attempts.
   */
  private async getCompanionClient(deviceId: string): Promise<CompanionClient | null> {
    // Return existing connected client
    const existing = this.companionClients.get(deviceId);
    if (existing?.isConnected) return existing;

    // Don't retry if we already know it's unavailable
    if (this.companionUnavailable.has(deviceId)) return null;

    // Try to connect
    const client = new CompanionClient(this.adb, deviceId);
    const connected = await client.connect();

    if (connected) {
      this.companionClients.set(deviceId, client);
      return client;
    }

    // Connection failed — try auto-installing the companion app
    const installed = await client.isInstalled();
    if (!installed) {
      const apkPath = this.findCompanionApk();
      if (apkPath) {
        console.error(`[mobile-device-mcp] Auto-installing companion app on ${deviceId}...`);
        const installOk = await client.install(apkPath);
        if (installOk) {
          console.error(`[mobile-device-mcp] Companion app installed. Enabling accessibility service...`);
          await client.enableService();
          // Wait for the service to start
          await sleep(2000);
          // Retry connection
          const retryConnected = await client.connect();
          if (retryConnected) {
            console.error(`[mobile-device-mcp] Companion app connected successfully.`);
            this.companionClients.set(deviceId, client);
            return client;
          }
          console.error(`[mobile-device-mcp] Companion app installed but could not connect. User may need to enable the accessibility service manually in Settings.`);
        }
      }
    }

    // Mark as unavailable so we don't retry on every getUIElements call
    this.companionUnavailable.add(deviceId);
    return null;
  }

  /**
   * Find the companion APK bundled with the package.
   * Checks several possible locations relative to the module.
   */
  private findCompanionApk(): string | null {
    try {
      const thisFile = fileURLToPath(import.meta.url);
      const packageRoot = dirname(dirname(dirname(thisFile))); // up from drivers/android/ to root

      const candidates = [
        join(packageRoot, "assets", "companion-app.apk"),
        join(packageRoot, "companion-app", "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
        join(packageRoot, "..", "assets", "companion-app.apk"),
        join(packageRoot, "..", "companion-app", "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
      ];

      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {
      // import.meta.url resolution may fail in some environments
    }
    return null;
  }

  /**
   * Reset companion availability for a device.
   * Call this to force a reconnection attempt (e.g., after installing the companion app).
   */
  resetCompanion(deviceId: string): void {
    this.companionUnavailable.delete(deviceId);
    const existing = this.companionClients.get(deviceId);
    if (existing) {
      existing.disconnect().catch(() => {});
      this.companionClients.delete(deviceId);
    }
  }

  // ================================================================
  // Device management
  // ================================================================

  async listDevices(): Promise<DeviceInfo[]> {
    const result = await this.adb.execute(["devices", "-l"]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list devices: ${result.stderr}`);
    }

    const lines = result.stdout.split("\n");
    const devices: DeviceInfo[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip header and blank lines
      if (!trimmed || trimmed.startsWith("List of devices") || trimmed === "* daemon") {
        continue;
      }

      // Expected format: SERIAL  STATUS product:X model:Y device:Z transport_id:N
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;

      const id = parts[0];
      const status = this.parseDeviceStatus(parts[1]);

      // Extract key:value pairs
      const model = this.extractField(parts, "model") || id;
      const product = this.extractField(parts, "product") || "";
      const deviceName = this.extractField(parts, "device") || "";

      const isEmulator = id.startsWith("emulator-") || id.includes(":");

      devices.push({
        id,
        name: deviceName || product || model,
        model: model.replace(/_/g, " "),
        manufacturer: "",
        androidVersion: "",
        sdkVersion: "",
        status,
        isEmulator,
      });
    }

    return devices;
  }

  async getDeviceInfo(deviceId: string): Promise<DeviceInfo> {
    const result = await this.adb.execute(["shell", "getprop"], deviceId);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get device info for ${deviceId}: ${result.stderr}`);
    }

    const props = this.parseGetprop(result.stdout);

    const model = props.get("ro.product.model") || deviceId;
    const manufacturer = props.get("ro.product.manufacturer") || "";
    const androidVersion = props.get("ro.build.version.release") || "";
    const sdkVersion = props.get("ro.build.version.sdk") || "";
    const name = props.get("ro.product.name") || model;

    const isEmulator = deviceId.startsWith("emulator-") || deviceId.includes(":");

    let screenSize: { width: number; height: number } | undefined;
    try {
      screenSize = await this.getScreenSize(deviceId);
    } catch {
      // Screen size is optional — swallow errors
    }

    return {
      id: deviceId,
      name,
      model,
      manufacturer,
      androidVersion,
      sdkVersion,
      status: "device",
      isEmulator,
      screenSize,
    };
  }

  async getScreenSize(deviceId: string): Promise<{ width: number; height: number }> {
    const result = await this.adb.execute(["shell", "wm", "size"], deviceId);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get screen size for ${deviceId}: ${result.stderr}`);
    }

    // Output: "Physical size: 1080x1920" (may also have "Override size: ...")
    // Prefer override size if present, fall back to physical.
    const output = result.stdout;

    const overrideMatch = output.match(/Override size:\s*(\d+)x(\d+)/);
    if (overrideMatch) {
      return {
        width: parseInt(overrideMatch[1], 10),
        height: parseInt(overrideMatch[2], 10),
      };
    }

    const physicalMatch = output.match(/Physical size:\s*(\d+)x(\d+)/);
    if (physicalMatch) {
      return {
        width: parseInt(physicalMatch[1], 10),
        height: parseInt(physicalMatch[2], 10),
      };
    }

    throw new Error(`Unable to parse screen size from output: ${output.trim()}`);
  }

  // ================================================================
  // Screenshots & UI
  // ================================================================

  async takeScreenshot(deviceId: string, options?: ScreenshotOptions): Promise<ScreenshotResult> {
    const t0 = Date.now();

    const pngBuffer = await this.adb.executeBuffer(["exec-out", "screencap", "-p"], deviceId);
    const captureMs = Date.now() - t0;

    if (pngBuffer.length === 0) {
      throw new Error(`Screenshot returned empty buffer for device ${deviceId}`);
    }

    const t1 = Date.now();
    const processed = processScreenshot(pngBuffer, options);
    const processMs = Date.now() - t1;

    console.error(`[takeScreenshot] capture=${captureMs}ms process=${processMs}ms total=${Date.now() - t0}ms | ${processed.width}x${processed.height} ${processed.format} ${(processed.sizeBytes / 1024).toFixed(1)}KB`);

    return {
      base64: processed.base64,
      width: processed.width,
      height: processed.height,
      format: processed.format,
      timestamp: t0,
      sizeBytes: processed.sizeBytes,
    };
  }

  async getUIElements(deviceId: string, options?: UIElementOptions): Promise<UIElement[]> {
    const t0 = Date.now();

    // Strategy 0: Companion app (instant, complete tree via AccessibilityService)
    const companion = await this.getCompanionClient(deviceId);
    if (companion) {
      try {
        const t = Date.now();
        const elements = await companion.getTree(options?.interactiveOnly ?? false);
        if (elements.length > 0) {
          console.error(`[getUIElements] Strategy 0 (companion): ${elements.length} elements in ${Date.now() - t}ms (total ${Date.now() - t0}ms)`);
          return elements;
        }
        console.error(`[getUIElements] Strategy 0 (companion): empty in ${Date.now() - t}ms`);
      } catch {
        console.error(`[getUIElements] Strategy 0 (companion): failed in ${Date.now() - t0}ms`);
      }
    }

    // Strategy 1: UIAutomator dump (fast path)
    let t1 = Date.now();
    let dump = await this.tryUIAutomatorDump(deviceId, options);
    if (dump.elements.length > 0) {
      console.error(`[getUIElements] Strategy 1 (uiautomator): ${dump.elements.length} elements in ${Date.now() - t1}ms (total ${Date.now() - t0}ms)`);
      return dump.elements;
    }
    console.error(`[getUIElements] Strategy 1 (uiautomator): empty in ${Date.now() - t1}ms`);

    // Strategy 2: Retry after delay — but only if UIAutomator executed successfully
    // (empty result = rendering lag, retry helps; command failed = retry won't help)
    if (dump.executed) {
      await sleep(500);
      t1 = Date.now();
      dump = await this.tryUIAutomatorDump(deviceId, options);
      if (dump.elements.length > 0) {
        console.error(`[getUIElements] Strategy 2 (uiautomator retry): ${dump.elements.length} elements in ${Date.now() - t1}ms (total ${Date.now() - t0}ms)`);
        return dump.elements;
      }
      console.error(`[getUIElements] Strategy 2 (uiautomator retry): empty in ${Date.now() - t1}ms`);
    } else {
      console.error(`[getUIElements] Strategy 1 failed (not empty), skipping 500ms retry`);
    }

    // Strategy 3: Accessibility dump fallback
    t1 = Date.now();
    const a11yElements = await this.tryAccessibilityDump(deviceId, options);
    console.error(`[getUIElements] Strategy 3 (a11y dump): ${a11yElements.length} elements in ${Date.now() - t1}ms (total ${Date.now() - t0}ms)`);
    return a11yElements;
  }

  // ================================================================
  // Interaction
  // ================================================================

  async tap(deviceId: string, x: number, y: number): Promise<TapResult> {
    const result = await this.adb.execute(
      ["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))],
      deviceId,
    );

    return {
      success: result.exitCode === 0,
      x: Math.round(x),
      y: Math.round(y),
    };
  }

  async doubleTap(deviceId: string, x: number, y: number): Promise<TapResult> {
    const rx = Math.round(x);
    const ry = Math.round(y);

    const r1 = await this.adb.execute(["shell", "input", "tap", String(rx), String(ry)], deviceId);
    await sleep(50);
    const r2 = await this.adb.execute(["shell", "input", "tap", String(rx), String(ry)], deviceId);

    return {
      success: r1.exitCode === 0 && r2.exitCode === 0,
      x: rx,
      y: ry,
    };
  }

  async longPress(deviceId: string, x: number, y: number, duration: number = 1000): Promise<TapResult> {
    const rx = Math.round(x);
    const ry = Math.round(y);

    // A swipe from point to same point = long press
    const result = await this.adb.execute(
      ["shell", "input", "swipe", String(rx), String(ry), String(rx), String(ry), String(duration)],
      deviceId,
    );

    return {
      success: result.exitCode === 0,
      x: rx,
      y: ry,
    };
  }

  async swipe(
    deviceId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration: number = 300,
  ): Promise<SwipeResult> {
    const sx = Math.round(startX);
    const sy = Math.round(startY);
    const ex = Math.round(endX);
    const ey = Math.round(endY);

    const result = await this.adb.execute(
      ["shell", "input", "swipe", String(sx), String(sy), String(ex), String(ey), String(duration)],
      deviceId,
    );

    return {
      success: result.exitCode === 0,
      startX: sx,
      startY: sy,
      endX: ex,
      endY: ey,
      duration,
    };
  }

  async typeText(deviceId: string, text: string): Promise<{ success: boolean }> {
    const escaped = escapeForAdbInput(text);

    const result = await this.adb.execute(
      ["shell", "input", "text", escaped],
      deviceId,
    );

    return { success: result.exitCode === 0 };
  }

  async pressKey(deviceId: string, keycode: string): Promise<{ success: boolean }> {
    const result = await this.adb.execute(
      ["shell", "input", "keyevent", keycode],
      deviceId,
    );

    return { success: result.exitCode === 0 };
  }

  // ================================================================
  // App management
  // ================================================================

  async listApps(deviceId: string, includeSystem: boolean = false): Promise<AppInfo[]> {
    // -3 = third-party only; no flag (or -s for system only)
    const args = includeSystem
      ? ["shell", "pm", "list", "packages"]
      : ["shell", "pm", "list", "packages", "-3"];

    const result = await this.adb.execute(args, deviceId);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list apps on ${deviceId}: ${result.stderr}`);
    }

    // When includeSystem is true, fetch the third-party list once
    // to avoid N+1 ADB calls (one per package).
    let thirdPartyPackages: Set<string> | undefined;
    if (includeSystem) {
      const tpResult = await this.adb.execute(
        ["shell", "pm", "list", "packages", "-3"],
        deviceId,
      );
      if (tpResult.exitCode === 0) {
        thirdPartyPackages = new Set(
          tpResult.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.startsWith("package:"))
            .map((l) => l.substring("package:".length).trim()),
        );
      }
    }

    const apps: AppInfo[] = [];
    const lines = result.stdout.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      // Lines look like: "package:com.example.app"
      if (!trimmed.startsWith("package:")) continue;

      const packageName = trimmed.substring("package:".length).trim();
      if (!packageName) continue;

      apps.push({
        packageName,
        isSystemApp: includeSystem
          ? !(thirdPartyPackages?.has(packageName) ?? false)
          : false,
      });
    }

    return apps;
  }

  async getCurrentApp(deviceId: string): Promise<{ packageName: string; activityName: string }> {
    // Try mResumedActivity first (Android 8+)
    const result = await this.adb.execute(
      ["shell", "dumpsys", "activity", "activities"],
      deviceId,
    );

    if (result.exitCode === 0) {
      // Android 16+: "ResumedActivity:" or "Resumed:"
      // Android 8-15: "mResumedActivity:"
      const resumedMatch = result.stdout.match(
        /(?:m?ResumedActivity|Resumed):.*?([a-zA-Z][a-zA-Z0-9_.]*[a-zA-Z0-9])\/([a-zA-Z0-9_.]+)/,
      );
      if (resumedMatch) {
        return {
          packageName: resumedMatch[1],
          activityName: resumedMatch[2],
        };
      }

      // Also try mFocusedApp (works on all versions)
      const focusedApp = result.stdout.match(
        /mFocusedApp=.*?([a-zA-Z][a-zA-Z0-9_.]*[a-zA-Z0-9])\/([a-zA-Z0-9_.]+)/,
      );
      if (focusedApp) {
        return {
          packageName: focusedApp[1],
          activityName: focusedApp[2],
        };
      }
    }

    // Fallback: dumpsys window
    const windowResult = await this.adb.execute(
      ["shell", "dumpsys", "window"],
      deviceId,
    );

    if (windowResult.exitCode === 0) {
      // mCurrentFocus=Window{... com.package/com.package.Activity ...}
      const focusMatch = windowResult.stdout.match(
        /mCurrentFocus=.*?([a-zA-Z][a-zA-Z0-9_.]*[a-zA-Z0-9])\/([a-zA-Z0-9_.]+)/,
      );
      if (focusMatch) {
        return {
          packageName: focusMatch[1],
          activityName: focusMatch[2],
        };
      }
    }

    throw new Error(`Unable to determine current app on device ${deviceId}`);
  }

  async launchApp(deviceId: string, packageName: string): Promise<{ success: boolean }> {
    const result = await this.adb.execute(
      ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
      deviceId,
    );

    // monkey prints "Events injected: 1" on success
    const success = result.exitCode === 0 && !result.stdout.includes("No activities found");

    return { success };
  }

  async stopApp(deviceId: string, packageName: string): Promise<{ success: boolean }> {
    const result = await this.adb.execute(
      ["shell", "am", "force-stop", packageName],
      deviceId,
    );

    return { success: result.exitCode === 0 };
  }

  async installApp(deviceId: string, apkPath: string): Promise<{ success: boolean }> {
    const result = await this.adb.execute(
      ["install", apkPath],
      deviceId,
    );

    const success = result.exitCode === 0 && result.stdout.includes("Success");

    if (!success) {
      throw new Error(
        `Failed to install ${apkPath} on ${deviceId}: ${result.stderr || result.stdout}`,
      );
    }

    return { success: true };
  }

  async uninstallApp(deviceId: string, packageName: string): Promise<{ success: boolean }> {
    const result = await this.adb.execute(
      ["uninstall", packageName],
      deviceId,
    );

    const success = result.exitCode === 0 && result.stdout.includes("Success");

    if (!success) {
      throw new Error(
        `Failed to uninstall ${packageName} from ${deviceId}: ${result.stderr || result.stdout}`,
      );
    }

    return { success: true };
  }

  // ================================================================
  // Logs
  // ================================================================

  async getLogs(deviceId: string, options?: LogOptions): Promise<LogEntry[]> {
    const args = ["shell", "logcat", "-d", "-v", "time"];

    if (options?.lines) {
      args.push("-t", String(options.lines));
    }

    if (options?.level) {
      args.push(`*:${options.level}`);
    }

    if (options?.filter) {
      args.push(options.filter);
    }

    if (options?.pid) {
      args.push("--pid", String(options.pid));
    }

    if (options?.since) {
      args.push("-T", options.since);
    }

    const result = await this.adb.execute(args, deviceId);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get logs from ${deviceId}: ${result.stderr}`);
    }

    return this.parseLogcatOutput(result.stdout);
  }

  // ================================================================
  // Raw shell
  // ================================================================

  async shell(deviceId: string, command: string): Promise<ADBResult> {
    return this.adb.execute(["shell", command], deviceId);
  }

  // ================================================================
  // Video recording
  // ================================================================

  /**
   * Start recording the device screen.
   * Only one recording per device at a time. Android limit: 3 minutes max.
   */
  async startRecording(
    deviceId: string,
    options?: { maxDuration?: number; bitRate?: number; resolution?: string },
  ): Promise<{ success: boolean; devicePath: string }> {
    if (this.recordings.has(deviceId)) {
      throw new Error(`Already recording on device ${deviceId}. Stop the current recording first.`);
    }

    const timestamp = Date.now();
    const devicePath = `/sdcard/mcp-recording-${timestamp}.mp4`;

    const args = ["shell", "screenrecord"];
    if (options?.maxDuration) {
      args.push("--time-limit", String(Math.min(options.maxDuration, 180)));
    }
    if (options?.bitRate) {
      args.push("--bit-rate", String(options.bitRate));
    }
    if (options?.resolution) {
      args.push("--size", options.resolution);
    }
    args.push(devicePath);

    const child = this.adb.spawn(args, deviceId);
    this.recordings.set(deviceId, { process: child, devicePath, startTime: timestamp });

    // Auto-cleanup when process exits
    child.on("exit", () => {
      this.recordings.delete(deviceId);
    });

    return { success: true, devicePath };
  }

  /**
   * Stop an active screen recording and optionally pull the file to host.
   */
  async stopRecording(
    deviceId: string,
    pullToPath?: string,
  ): Promise<{ success: boolean; devicePath: string; localPath?: string; durationMs: number }> {
    const recording = this.recordings.get(deviceId);
    if (!recording) {
      throw new Error(`No active recording on device ${deviceId}.`);
    }

    const durationMs = Date.now() - recording.startTime;
    const devicePath = recording.devicePath;

    // Send SIGINT to stop recording gracefully
    recording.process.kill("SIGINT");

    // Wait for the process to finish writing
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        recording.process.kill("SIGKILL");
        resolve();
      }, 5000);

      recording.process.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.recordings.delete(deviceId);

    // Brief delay for file to be finalized on device
    await new Promise(r => setTimeout(r, 500));

    let localPath: string | undefined;
    if (pullToPath) {
      const pullResult = await this.adb.execute(["pull", devicePath, pullToPath], deviceId);
      if (pullResult.exitCode === 0) {
        localPath = pullToPath;
      }
    }

    return { success: true, devicePath, localPath, durationMs };
  }

  // ================================================================
  // Private helpers
  // ================================================================

  private parseDeviceStatus(status: string): DeviceInfo["status"] {
    switch (status) {
      case "device":
        return "device";
      case "offline":
        return "offline";
      case "unauthorized":
        return "unauthorized";
      default:
        return "unknown";
    }
  }

  /**
   * Extract a field like "model:Pixel_6" from an array of parts.
   */
  private extractField(parts: string[], key: string): string {
    for (const part of parts) {
      if (part.startsWith(`${key}:`)) {
        return part.substring(key.length + 1);
      }
    }
    return "";
  }

  /**
   * Parse the output of `adb shell getprop` into a Map.
   * Lines look like: [ro.product.model]: [Pixel 6]
   */
  private parseGetprop(output: string): Map<string, string> {
    const props = new Map<string, string>();
    const lines = output.split("\n");

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const match = line.match(/^\[(.+?)\]:\s*\[(.*)?\]$/);
      if (match) {
        props.set(match[1], match[2] ?? "");
      }
    }

    return props;
  }

  // ----------------------------------------------------------
  // Multi-strategy UI element capture
  // ----------------------------------------------------------

  /**
   * Try UIAutomator dump via two approaches:
   * 1. exec-out to /dev/tty (fast, single command)
   * 2. File-based dump to /sdcard + cat (slower, more compatible)
   * Returns empty array if both fail (instead of throwing).
   */
  private async tryUIAutomatorDump(deviceId: string, options?: UIElementOptions): Promise<{ elements: UIElement[]; executed: boolean }> {
    // Approach 1: exec-out to /dev/tty (fast, direct stdout)
    const result = await this.adb.execute(
      ["exec-out", "uiautomator", "dump", "/dev/tty"],
      deviceId,
    );

    if (result.stdout && result.stdout.includes("<node")) {
      return { elements: this.parseUIHierarchy(result.stdout, options), executed: true };
    }

    // Approach 2: file-based fallback
    const dumpResult = await this.adb.execute(
      ["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"],
      deviceId,
    );
    if (dumpResult.exitCode !== 0) {
      return { elements: [], executed: false };
    }

    const catResult = await this.adb.execute(
      ["shell", "cat", "/sdcard/window_dump.xml"],
      deviceId,
    );
    if (catResult.exitCode === 0 && catResult.stdout.includes("<node")) {
      return { elements: this.parseUIHierarchy(catResult.stdout, options), executed: true };
    }

    return { elements: [], executed: true };
  }

  /**
   * Try capturing UI elements via `dumpsys accessibility`.
   * This uses the system's accessibility framework directly, which can
   * see elements that UIAutomator misses (Flutter semantics nodes,
   * custom views with accessibility annotations, WebView content).
   *
   * The output format uses semicolon-separated key-value pairs per node
   * from AccessibilityNodeInfo.toString().
   */
  private async tryAccessibilityDump(deviceId: string, options?: UIElementOptions): Promise<UIElement[]> {
    const result = await this.adb.execute(
      ["shell", "dumpsys", "accessibility"],
      deviceId,
    );

    if (result.exitCode !== 0 || !result.stdout) {
      return [];
    }

    return this.parseAccessibilityDump(result.stdout, options);
  }

  /**
   * Parse `dumpsys accessibility` output into UIElement[].
   *
   * AccessibilityNodeInfo.toString() produces lines like:
   *   android.widget.Button@1a2b3c4; boundsInScreen: Rect(100, 200 - 300, 248);
   *   packageName: com.example; className: android.widget.Button; text: Submit;
   *   clickable: true; focusable: true; enabled: true; ...
   *
   * We extract nodes by matching boundsInScreen patterns, then pull out
   * key-value pairs from the semicolon-delimited fields.
   */
  private parseAccessibilityDump(output: string, options?: UIElementOptions): UIElement[] {
    const elements: UIElement[] = [];
    let index = 0;

    const lines = output.split("\n");

    for (const line of lines) {
      // Only process lines that contain screen bounds — these are node descriptions
      const boundsMatch = line.match(
        /boundsInScreen:\s*Rect\((\d+),\s*(\d+)\s*-\s*(\d+),\s*(\d+)\)/,
      );
      if (!boundsMatch) continue;

      const left = parseInt(boundsMatch[1], 10);
      const top = parseInt(boundsMatch[2], 10);
      const right = parseInt(boundsMatch[3], 10);
      const bottom = parseInt(boundsMatch[4], 10);

      // Skip zero-area nodes
      if (left >= right || top >= bottom) continue;

      // Extract key-value fields from semicolon-separated format
      const text = this.extractA11yField(line, "text");
      const contentDescription = this.extractA11yField(line, "contentDescription");
      const className = this.extractA11yField(line, "className")
        || this.extractA11yClassName(line);
      const packageName = this.extractA11yField(line, "packageName");
      const resourceId = this.extractA11yField(line, "viewIdResName")
        || this.extractA11yField(line, "resourceName");

      const clickable = this.extractA11yBool(line, "clickable");
      const focusable = this.extractA11yBool(line, "focusable");
      const scrollable = this.extractA11yBool(line, "scrollable");
      const enabled = this.extractA11yBoolDefault(line, "enabled", true);
      const selected = this.extractA11yBool(line, "selected");
      const checked = this.extractA11yBool(line, "checked");

      // Apply interactive filter
      if (options?.interactiveOnly && !clickable && !focusable && !scrollable) {
        continue;
      }

      elements.push({
        index: index++,
        text,
        contentDescription,
        className,
        packageName,
        resourceId,
        bounds: {
          left,
          top,
          right,
          bottom,
          centerX: Math.round((left + right) / 2),
          centerY: Math.round((top + bottom) / 2),
        },
        clickable,
        scrollable,
        focusable,
        enabled,
        selected,
        checked,
      });
    }

    return elements;
  }

  /**
   * Extract a string field from an accessibility node line.
   * Matches patterns like `fieldName: value;` or `fieldName: value\n`.
   * Returns empty string if "null" or not found.
   */
  private extractA11yField(line: string, field: string): string {
    const match = line.match(new RegExp(`${field}:\\s*([^;\\n]*)`));
    if (!match) return "";
    const value = match[1].trim();
    return value === "null" ? "" : value;
  }

  /**
   * Extract a boolean field from an accessibility node line.
   * Matches `fieldName: true` or `fieldName: false`.
   */
  private extractA11yBool(line: string, field: string): boolean {
    const match = line.match(new RegExp(`${field}:\\s*(true|false)`));
    return match ? match[1] === "true" : false;
  }

  /**
   * Extract a boolean with a default value if not found.
   */
  private extractA11yBoolDefault(line: string, field: string, defaultValue: boolean): boolean {
    const match = line.match(new RegExp(`${field}:\\s*(true|false)`));
    return match ? match[1] === "true" : defaultValue;
  }

  /**
   * Extract class name from the beginning of an accessibility node line.
   * Matches patterns like `android.widget.Button@1a2b3c4` at the start.
   */
  private extractA11yClassName(line: string): string {
    const trimmed = line.trim();
    const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_.]+?)(?:@[\da-f]+|\(\d+\)|;)/);
    return match ? match[1] : "";
  }

  // ----------------------------------------------------------
  // XML parsing
  // ----------------------------------------------------------

  /**
   * Parse uiautomator XML dump into an array of UIElement.
   * No XML library used — regex-based extraction of `<node ... />` elements.
   */
  private parseUIHierarchy(xml: string, options?: UIElementOptions): UIElement[] {
    const elements: UIElement[] = [];
    let index = 0;

    // Match all <node ... > or <node ... /> tags
    const nodeRegex = /<node\s+[^>]*?(?:\/>|>)/g;
    let match: RegExpExecArray | null;

    while ((match = nodeRegex.exec(xml)) !== null) {
      const nodeStr = match[0];
      const element = parseNodeElement(nodeStr, index);

      // Apply interactiveOnly filter
      if (options?.interactiveOnly) {
        if (!element.clickable && !element.focusable && !element.scrollable) {
          continue;
        }
      }

      elements.push(element);
      index++;
    }

    return elements;
  }

  /**
   * Parse logcat output lines into structured LogEntry objects.
   * Expected format: "MM-DD HH:MM:SS.mmm  PID  TID LEVEL/TAG: MESSAGE"
   * The `-v time` format is: "MM-DD HH:MM:SS.mmm LEVEL/TAG(  PID): MESSAGE"
   */
  private parseLogcatOutput(output: string): LogEntry[] {
    const entries: LogEntry[] = [];
    const lines = output.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // `-v time` format: "03-15 12:34:56.789 V/TagName( 1234): The message text"
      const timeFormatMatch = trimmed.match(
        /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+([VDIWEF])\/(.+?)\(\s*(\d+)\):\s*(.*)/,
      );

      if (timeFormatMatch) {
        const level = timeFormatMatch[2] as LogEntry["level"];
        entries.push({
          timestamp: timeFormatMatch[1],
          pid: parseInt(timeFormatMatch[4], 10),
          tid: 0, // -v time format doesn't include TID
          level,
          tag: timeFormatMatch[3].trim(),
          message: timeFormatMatch[5],
        });
        continue;
      }

      // Alternative format sometimes seen:
      // "03-15 12:34:56.789  1234  5678 I TagName: The message text"
      const altMatch = trimmed.match(
        /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.+?):\s*(.*)/,
      );

      if (altMatch) {
        const level = altMatch[4] as LogEntry["level"];
        entries.push({
          timestamp: altMatch[1],
          pid: parseInt(altMatch[2], 10),
          tid: parseInt(altMatch[3], 10),
          level,
          tag: altMatch[5].trim(),
          message: altMatch[6],
        });
        continue;
      }

      // Lines that don't match a known format are skipped (e.g., "--------- beginning of main")
    }

    return entries;
  }

  /**
   * Check whether a package is a third-party (non-system) app.
   * Used when includeSystem=true to tag apps correctly.
   */
  private async isThirdPartyApp(deviceId: string, packageName: string): Promise<boolean> {
    const result = await this.adb.execute(
      ["shell", "pm", "list", "packages", "-3"],
      deviceId,
    );

    if (result.exitCode !== 0) return false;

    return result.stdout.includes(`package:${packageName}`);
  }
}

export default AndroidDriver;
