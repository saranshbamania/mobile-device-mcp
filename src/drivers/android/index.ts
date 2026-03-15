// ============================================================
// AndroidDriver — DeviceDriver implementation backed by ADB
// ============================================================

import { ADB } from "./adb.js";
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
 * Parse the PNG IHDR chunk to extract width and height.
 * PNG layout:
 *   bytes  0- 7: signature (89 50 4E 47 0D 0A 1A 0A)
 *   bytes  8-11: IHDR length (always 13)
 *   bytes 12-15: "IHDR"
 *   bytes 16-19: width  (big-endian uint32)
 *   bytes 20-23: height (big-endian uint32)
 */
function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) {
    throw new Error("Buffer too small to be a valid PNG image");
  }

  // Validate PNG signature
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Buffer does not contain a valid PNG signature");
  }

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);

  if (width === 0 || height === 0) {
    throw new Error("Invalid PNG dimensions: width or height is 0");
  }

  return { width, height };
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

  constructor(adbPath: string = "adb") {
    this.adb = new ADB(adbPath);
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
    const timestamp = Date.now();

    const pngBuffer = await this.adb.executeBuffer(["exec-out", "screencap", "-p"], deviceId);

    if (pngBuffer.length === 0) {
      throw new Error(`Screenshot returned empty buffer for device ${deviceId}`);
    }

    const { width, height } = parsePngDimensions(pngBuffer);

    const base64 = pngBuffer.toString("base64");

    return {
      base64,
      width,
      height,
      format: options?.format ?? "png",
      timestamp,
      sizeBytes: pngBuffer.length,
    };
  }

  async getUIElements(deviceId: string, options?: UIElementOptions): Promise<UIElement[]> {
    // uiautomator dump outputs XML to the given path. Using /dev/tty with
    // exec-out gives us the XML directly on stdout.
    const result = await this.adb.execute(
      ["exec-out", "uiautomator", "dump", "/dev/tty"],
      deviceId,
    );

    // uiautomator may return exit code 0 but also print
    // "UI hierchary dumped to: /dev/tty" — we just need the XML.
    const output = result.stdout;

    if (!output || !output.includes("<node")) {
      // Fallback: try the file-based approach
      const dumpResult = await this.adb.execute(
        ["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"],
        deviceId,
      );
      if (dumpResult.exitCode !== 0) {
        throw new Error(`Failed to dump UI hierarchy for ${deviceId}: ${dumpResult.stderr}`);
      }

      const catResult = await this.adb.execute(
        ["shell", "cat", "/sdcard/window_dump.xml"],
        deviceId,
      );
      if (catResult.exitCode !== 0 || !catResult.stdout.includes("<node")) {
        throw new Error(`Failed to read UI dump for ${deviceId}: ${catResult.stderr}`);
      }

      return this.parseUIHierarchy(catResult.stdout, options);
    }

    return this.parseUIHierarchy(output, options);
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
      // Look for: mResumedActivity: ActivityRecord{... com.package/.ActivityName ...}
      const resumedMatch = result.stdout.match(
        /mResumedActivity:.*?([a-zA-Z][a-zA-Z0-9_.]*[a-zA-Z0-9])\/([a-zA-Z0-9_.]+)/,
      );
      if (resumedMatch) {
        return {
          packageName: resumedMatch[1],
          activityName: resumedMatch[2],
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
