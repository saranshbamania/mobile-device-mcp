// ============================================================
// ADB auto-discovery & device detection
// Zero-friction setup: find ADB and connected devices automatically.
// ============================================================

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

const execFile = promisify(execFileCb);

/** Timeout for verification commands (ms). */
const VERIFY_TIMEOUT_MS = 10_000;

// ------------------------------------------------------------------
// findAdbPath
// ------------------------------------------------------------------

/**
 * Locate a working ADB binary.
 *
 * Search order:
 *   1. ADB_PATH env var
 *   2. ANDROID_HOME/platform-tools/adb
 *   3. ANDROID_SDK_ROOT/platform-tools/adb
 *   4. "adb" on PATH
 *   5. Common OS-specific install locations
 *
 * Each candidate is verified by running `adb version`.
 * Returns the first working path or throws with installation help.
 */
export async function findAdbPath(): Promise<string> {
  const isWin = platform() === "win32";
  const ext = isWin ? ".exe" : "";
  const binaryName = `adb${ext}`;

  const candidates: string[] = [];

  // 1. Explicit env var
  const envAdbPath = process.env["ADB_PATH"];
  if (envAdbPath) {
    candidates.push(envAdbPath);
  }

  // 2. ANDROID_HOME
  const androidHome = process.env["ANDROID_HOME"];
  if (androidHome) {
    candidates.push(join(androidHome, "platform-tools", binaryName));
  }

  // 3. ANDROID_SDK_ROOT
  const androidSdkRoot = process.env["ANDROID_SDK_ROOT"];
  if (androidSdkRoot) {
    candidates.push(join(androidSdkRoot, "platform-tools", binaryName));
  }

  // 4. Bare "adb" — rely on PATH
  candidates.push("adb");

  // 5. Common install locations
  const home = homedir();
  if (isWin) {
    // Windows-specific paths
    candidates.push(
      join(home, "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe"),
      "C:\\Android\\sdk\\platform-tools\\adb.exe",
    );
  } else if (platform() === "darwin") {
    // macOS
    candidates.push(
      join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
    );
  } else {
    // Linux
    candidates.push(
      join(home, "Android", "Sdk", "platform-tools", "adb"),
      "/usr/lib/android-sdk/platform-tools/adb",
    );
  }

  // De-duplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of candidates) {
    if (!seen.has(c)) {
      seen.add(c);
      unique.push(c);
    }
  }

  // Try each candidate
  for (const candidate of unique) {
    // For absolute paths, skip if file doesn't exist (except bare "adb" which relies on PATH)
    if (candidate !== "adb" && !isAbsoluteOrRelativeBinary(candidate)) {
      continue;
    }

    if (await verifyAdb(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    [
      "Could not find a working ADB installation.",
      "",
      "To fix this, do ONE of the following:",
      "  1. Install Android SDK Platform Tools:",
      "     https://developer.android.com/tools/releases/platform-tools",
      "  2. Set the ADB_PATH environment variable to the full path of your adb binary.",
      "  3. Set ANDROID_HOME or ANDROID_SDK_ROOT to your SDK directory.",
      "  4. Add the platform-tools directory to your system PATH.",
    ].join("\n"),
  );
}

/**
 * Check whether a candidate path looks like it could be a binary
 * (exists on disk, or is a bare name to be found on PATH).
 */
function isAbsoluteOrRelativeBinary(candidate: string): boolean {
  // Bare command names like "adb" are handled separately
  if (!candidate.includes("/") && !candidate.includes("\\")) {
    return true; // bare name — will be resolved by PATH
  }
  return existsSync(candidate);
}

/**
 * Verify that `adb version` runs successfully with the given path.
 */
async function verifyAdb(adbPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFile(adbPath, ["version"], {
      timeout: VERIFY_TIMEOUT_MS,
      windowsHide: true,
    });
    // Sanity-check output contains expected text
    return stdout.toLowerCase().includes("android debug bridge");
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// getDefaultDevice
// ------------------------------------------------------------------

/**
 * If exactly one device is connected, return its serial ID.
 * Returns `undefined` when zero or multiple devices are present.
 */
export async function getDefaultDevice(
  adbPath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFile(adbPath, ["devices"], {
      timeout: VERIFY_TIMEOUT_MS,
      windowsHide: true,
    });

    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("List of"));

    // Each line is "SERIAL\tSTATUS"
    const devices: string[] = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && parts[1] === "device") {
        devices.push(parts[0]!);
      }
    }

    if (devices.length === 1) {
      return devices[0];
    }

    return undefined;
  } catch {
    return undefined;
  }
}
