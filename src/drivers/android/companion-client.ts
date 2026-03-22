// ============================================================
// CompanionClient — TCP client for the on-device companion app.
//
// Communicates with the CompanionAccessibilityService via a
// JSON-RPC protocol over a TCP socket (ADB port-forwarded).
//
// Protocol: newline-delimited JSON messages.
//   Request:  {"id": 1, "method": "getTree", "params": {...}}\n
//   Response: {"id": 1, "result": {...}}\n
// ============================================================

import { Socket } from "node:net";
import type { ADB } from "./adb.js";
import type { UIElement } from "../../types.js";

const COMPANION_PORT = 18080;
const COMPANION_PACKAGE = "com.mobiledevicemcp.companion";
const COMPANION_SERVICE = `${COMPANION_PACKAGE}/.CompanionAccessibilityService`;
const REQUEST_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 2000;

export interface CompanionInfo {
  version: string;
  apiLevel: number;
  serviceEnabled: boolean;
  port: number;
}

export class CompanionClient {
  private socket: Socket | null = null;
  private connected = false;
  private requestId = 0;
  private buffer = "";
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly adb: ADB,
    private readonly deviceId: string,
  ) {}

  get isConnected(): boolean {
    return this.connected;
  }

  // ================================================================
  // Connection lifecycle
  // ================================================================

  /**
   * Forward the companion port via ADB and connect over TCP.
   * Returns true if connection was successful.
   */
  async connect(): Promise<boolean> {
    // Set up ADB port forward
    try {
      await this.adb.execute(
        ["forward", `tcp:${COMPANION_PORT}`, `tcp:${COMPANION_PORT}`],
        this.deviceId,
      );
    } catch {
      return false;
    }

    // Connect TCP socket
    return new Promise<boolean>((resolve) => {
      const socket = new Socket();

      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, CONNECT_TIMEOUT_MS);

      socket.connect(COMPANION_PORT, "127.0.0.1", () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.connected = true;
        this.setupSocketHandlers();
        resolve(true);
      });

      socket.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  /**
   * Disconnect from the companion app and remove port forward.
   */
  async disconnect(): Promise<void> {
    this.connected = false;

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Disconnected"));
    }
    this.pendingRequests.clear();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    // Remove port forward (best effort)
    await this.adb
      .execute(["forward", "--remove", `tcp:${COMPANION_PORT}`], this.deviceId)
      .catch(() => {});
  }

  // ================================================================
  // RPC methods
  // ================================================================

  /**
   * Get the full UI tree from the companion's AccessibilityService.
   * Returns UIElement[] matching the same format as UIAutomator dump.
   */
  async getTree(interactiveOnly: boolean = false): Promise<UIElement[]> {
    const result = (await this.request("getTree", { interactiveOnly })) as {
      elements?: unknown[];
      timestamp?: number;
      count?: number;
    };

    if (!result?.elements || !Array.isArray(result.elements)) {
      return [];
    }

    // The companion app returns elements in the exact UIElement format
    return result.elements as UIElement[];
  }

  /**
   * Get companion app info (version, API level, service status).
   */
  async getInfo(): Promise<CompanionInfo | null> {
    try {
      return (await this.request("getInfo", {})) as CompanionInfo;
    } catch {
      return null;
    }
  }

  // ================================================================
  // Installation & setup helpers
  // ================================================================

  /**
   * Check if the companion APK is installed on the device.
   */
  async isInstalled(): Promise<boolean> {
    const result = await this.adb.execute(
      ["shell", "pm", "list", "packages", COMPANION_PACKAGE],
      this.deviceId,
    );
    return result.stdout.includes(COMPANION_PACKAGE);
  }

  /**
   * Install the companion APK on the device.
   * Uses -r (replace) and -g (grant permissions) flags.
   */
  async install(apkPath: string): Promise<boolean> {
    const result = await this.adb.execute(
      ["install", "-r", "-g", apkPath],
      this.deviceId,
    );
    return result.exitCode === 0 && result.stdout.includes("Success");
  }

  /**
   * Enable the companion's AccessibilityService via ADB.
   * This avoids the user having to navigate to Settings manually.
   *
   * Note: On Android 10+ with locked-down security, this may
   * require the user to confirm in Settings. On most dev devices
   * with USB debugging enabled, it works without interaction.
   */
  async enableService(): Promise<boolean> {
    // Read current enabled services
    const current = await this.adb.execute(
      ["shell", "settings", "get", "secure", "enabled_accessibility_services"],
      this.deviceId,
    );

    const existing = current.stdout.trim();
    if (existing.includes(COMPANION_SERVICE)) {
      // Already enabled
      await this.ensureAccessibilityEnabled();
      return true;
    }

    // Append our service to the list
    const newValue =
      existing && existing !== "null"
        ? `${existing}:${COMPANION_SERVICE}`
        : COMPANION_SERVICE;

    await this.adb.execute(
      [
        "shell",
        "settings",
        "put",
        "secure",
        "enabled_accessibility_services",
        newValue,
      ],
      this.deviceId,
    );

    await this.ensureAccessibilityEnabled();
    return true;
  }

  // ================================================================
  // Private
  // ================================================================

  private async ensureAccessibilityEnabled(): Promise<void> {
    await this.adb.execute(
      ["shell", "settings", "put", "secure", "accessibility_enabled", "1"],
      this.deviceId,
    );
  }

  private setupSocketHandlers(): void {
    if (!this.socket) return;

    this.socket.on("data", (data: Buffer) => {
      this.buffer += data.toString("utf-8");
      this.processBuffer();
    });

    this.socket.on("close", () => {
      this.connected = false;
      this.socket = null;
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Connection closed"));
      }
      this.pendingRequests.clear();
    });

    this.socket.on("error", () => {
      this.connected = false;
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // Keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };

        if (msg.id != null && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          clearTimeout(pending.timer);

          if (msg.error) {
            pending.reject(new Error(msg.error.message ?? "Companion error"));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Ignore malformed lines
      }
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error("Not connected to companion app"));
        return;
      }

      const id = ++this.requestId;
      const msg = JSON.stringify({ id, method, params }) + "\n";

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.socket.write(msg);
    });
  }
}
