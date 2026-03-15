// ============================================================
// FlutterDriver — Connects to a running Flutter app via the
// Dart VM Service Protocol for widget tree inspection.
//
// Only works in Debug/Profile mode (VM service stripped from
// Release builds).
// ============================================================

import { ADB } from "../android/adb.js";
import {
  VmServiceClient,
  type WidgetNode,
  type SourceLocation,
  type IsolateRef,
} from "./vm-service.js";

/** Pattern matching VM service URL in ADB logcat output. */
const VM_SERVICE_PATTERN =
  /(Observatory listening on |The Dart VM service is listening on |An Observatory debugger and profiler on\s.+\sis available at: )((http|\/\/)[a-zA-Z0-9:/=_\-.[\]]+)/;

/** How long to scan logcat for a VM service URL. */
const DISCOVERY_TIMEOUT_MS = 10_000;

/** Group name for inspector object references. */
const INSPECTOR_GROUP = "mcp-inspector";

export interface FlutterConnection {
  vmServiceUrl: string;
  wsUrl: string;
  isolateId: string;
  appName: string;
}

export interface WidgetTreeOptions {
  /** Only return user-created widgets (default: true). */
  summaryTree?: boolean;
  /** Include full property details (default: false — reduces payload). */
  fullDetails?: boolean;
}

export interface WidgetSearchResult {
  found: boolean;
  widget?: WidgetNode;
  matches: WidgetNode[];
  query: string;
}

/**
 * FlutterDriver connects to a running Flutter app's Dart VM Service
 * and provides widget tree inspection, source mapping, and debug tools.
 */
export class FlutterDriver {
  private adb: ADB;
  private client: VmServiceClient | null = null;
  private isolateId: string | null = null;
  private connection: FlutterConnection | null = null;

  constructor(adbPath: string = "adb") {
    this.adb = new ADB(adbPath);
  }

  /** Whether we're connected to a Flutter app. */
  get isConnected(): boolean {
    return this.client?.connected === true && this.isolateId !== null;
  }

  /** Get current connection info, or null if not connected. */
  getConnection(): FlutterConnection | null {
    return this.connection;
  }

  // ================================================================
  // Connection lifecycle
  // ================================================================

  /**
   * Discover and connect to a running Flutter app on the device.
   *
   * Flow:
   *   1. Scan ADB logcat for VM service URL
   *   2. Forward port via ADB
   *   3. Connect WebSocket
   *   4. Find Flutter isolate with inspector extensions
   */
  async connect(deviceId: string, vmServiceUrl?: string): Promise<FlutterConnection> {
    // If already connected, disconnect first
    if (this.isConnected) {
      await this.disconnect();
    }

    // Step 1: Discover or use provided VM service URL
    const resolvedUrl = vmServiceUrl || await this.discoverVmServiceUrl(deviceId);

    // Step 2: Parse URL and forward port (only for device-local URLs)
    const url = new URL(resolvedUrl);
    const port = parseInt(url.port, 10);
    if (!vmServiceUrl) {
      // Only forward when we discovered from logcat (device-local URL)
      await this.forwardPort(deviceId, port);
    }

    // Step 3: Convert to WebSocket URL
    const wsUrl = resolvedUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";

    // Step 4: Connect WebSocket (follows DDS 302 redirects automatically)
    this.client = new VmServiceClient(wsUrl);
    await this.client.connect();

    // Step 5: Find Flutter isolate
    const { isolateId, appName } = await this.findFlutterIsolate();
    this.isolateId = isolateId;

    this.connection = {
      vmServiceUrl: resolvedUrl,
      wsUrl: this.client.getUrl(),
      isolateId,
      appName,
    };

    return this.connection;
  }

  /**
   * Disconnect from the Flutter app and clean up.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      // Dispose our inspector group to free memory
      try {
        if (this.isolateId) {
          await this.client.callExtension(
            "ext.flutter.inspector.disposeGroup",
            this.isolateId,
            { objectGroup: INSPECTOR_GROUP },
          );
        }
      } catch {
        // Ignore disposal errors on disconnect
      }

      this.client.close();
      this.client = null;
    }
    this.isolateId = null;
    this.connection = null;
  }

  // ================================================================
  // Widget tree inspection
  // ================================================================

  /**
   * Get the widget tree from the connected Flutter app.
   *
   * By default returns the summary tree (user-created widgets only),
   * which is lighter and more relevant than the full framework tree.
   */
  async getWidgetTree(options?: WidgetTreeOptions): Promise<WidgetNode> {
    this.assertConnected();

    const summaryTree = options?.summaryTree ?? true;

    // Check if widget tree is ready
    const ready = await this.client!.callExtension(
      "ext.flutter.inspector.isWidgetTreeReady",
      this.isolateId!,
    ) as { result?: boolean };

    if (ready.result === false) {
      throw new Error("Widget tree is not ready — the Flutter app may still be loading");
    }

    // Get the widget tree
    const result = await this.client!.callExtension(
      summaryTree
        ? "ext.flutter.inspector.getRootWidgetSummaryTree"
        : "ext.flutter.inspector.getRootWidget",
      this.isolateId!,
      { objectGroup: INSPECTOR_GROUP },
    ) as { result?: string | WidgetNode };

    if (!result.result) {
      throw new Error("Failed to get widget tree — empty response from VM service");
    }

    // DDS returns parsed objects; raw VM service may return JSON strings
    return (typeof result.result === "string"
      ? JSON.parse(result.result)
      : result.result) as WidgetNode;
  }

  /**
   * Get detailed subtree for a specific widget by its valueId.
   */
  async getWidgetDetails(valueId: string, subtreeDepth: number = 2): Promise<WidgetNode> {
    this.assertConnected();

    const result = await this.client!.callExtension(
      "ext.flutter.inspector.getDetailsSubtree",
      this.isolateId!,
      {
        objectGroup: INSPECTOR_GROUP,
        arg: valueId,
        subtreeDepth,
      },
    ) as { result?: string | WidgetNode };

    if (!result.result) {
      throw new Error(`No widget found with valueId "${valueId}"`);
    }

    return (typeof result.result === "string"
      ? JSON.parse(result.result)
      : result.result) as WidgetNode;
  }

  /**
   * Find widgets matching a query (by type, text, or description).
   */
  findWidget(tree: WidgetNode, query: string): WidgetSearchResult {
    const matches: WidgetNode[] = [];
    const lowerQuery = query.toLowerCase();

    this.walkTree(tree, (node) => {
      const type = (node.widgetRuntimeType || "").toLowerCase();
      const desc = (node.description || "").toLowerCase();
      const text = (node.textPreview || "").toLowerCase();

      if (
        type.includes(lowerQuery) ||
        desc.includes(lowerQuery) ||
        text.includes(lowerQuery)
      ) {
        matches.push(node);
      }
    });

    return {
      found: matches.length > 0,
      widget: matches[0] || undefined,
      matches,
      query,
    };
  }

  /**
   * Get source code location (file:line) for a widget.
   * Returns null if creation tracking is disabled.
   */
  getSourceLocation(widget: WidgetNode): SourceLocation | null {
    return widget.creationLocation ?? null;
  }

  /**
   * Collect all widgets with their source locations from the tree.
   * Useful for mapping the entire UI to source code.
   */
  getSourceMap(tree: WidgetNode): Array<{
    widget: string;
    file: string;
    line: number;
    column: number;
  }> {
    const entries: Array<{
      widget: string;
      file: string;
      line: number;
      column: number;
    }> = [];

    this.walkTree(tree, (node) => {
      if (node.creationLocation && node.createdByLocalProject) {
        entries.push({
          widget: node.widgetRuntimeType || node.description,
          file: node.creationLocation.file.replace(/^file:\/\/\//, ""),
          line: node.creationLocation.line,
          column: node.creationLocation.column,
        });
      }
    });

    return entries;
  }

  // ================================================================
  // Debug tools
  // ================================================================

  /**
   * Take a screenshot of a specific widget by its valueId.
   * Returns base64-encoded PNG image.
   */
  async screenshotWidget(
    valueId: string,
    width: number = 300,
    height: number = 600,
  ): Promise<string> {
    this.assertConnected();

    const result = await this.client!.callExtension(
      "ext.flutter.inspector.screenshot",
      this.isolateId!,
      {
        id: valueId,
        width: width.toString(),
        height: height.toString(),
        maxPixelRatio: "2.0",
      },
    ) as { result?: string };

    if (!result.result) {
      throw new Error(`Failed to screenshot widget "${valueId}"`);
    }

    return result.result;
  }

  /**
   * Toggle the debug paint overlay on the device.
   *
   * Uses the rendering extension `ext.flutter.debugPaint` which is
   * registered by RendererBinding via registerBoolServiceExtension.
   * The VM service layer converts all param values to strings, so we
   * send booleans here (matching what Flutter DevTools sends) and let
   * the protocol handle serialisation.
   *
   * If the isolate has become stale (e.g. after a hot restart) we
   * attempt to re-discover the Flutter isolate and retry once.
   */
  async toggleDebugPaint(enabled: boolean): Promise<void> {
    this.assertConnected();

    // Validate the extension is registered before calling it.
    // After a hot restart the old isolate may be gone and a new one
    // will have re-registered its extensions.
    const isolateId = await this.ensureValidIsolate();

    await this.client!.callExtension(
      "ext.flutter.debugPaint",
      isolateId,
      { enabled },
    );
  }

  /**
   * Dump the render tree as a string (for debugging).
   */
  async dumpRenderTree(): Promise<string> {
    this.assertConnected();

    const isolateId = await this.ensureValidIsolate();
    const result = await this.client!.callExtension(
      "ext.flutter.debugDumpRenderTree",
      isolateId,
    ) as { result?: string };

    return result.result || "";
  }

  /**
   * Dump the widget tree as a string (for debugging).
   */
  async dumpWidgetTree(): Promise<string> {
    this.assertConnected();

    const isolateId = await this.ensureValidIsolate();
    const result = await this.client!.callExtension(
      "ext.flutter.debugDumpApp",
      isolateId,
    ) as { result?: string };

    return result.result || "";
  }

  /**
   * Check whether widget creation location tracking is enabled.
   */
  async isCreationTrackingEnabled(): Promise<boolean> {
    this.assertConnected();

    const result = await this.client!.callExtension(
      "ext.flutter.inspector.isWidgetCreationTracked",
      this.isolateId!,
    ) as { result?: boolean };

    return result.result === true;
  }

  // ================================================================
  // Private helpers
  // ================================================================

  /**
   * Verify the stored isolate is still alive and has Flutter extensions.
   * If the isolate has been collected (e.g. after hot restart), re-discover
   * the Flutter isolate and update our stored reference.
   *
   * Returns the (possibly refreshed) isolate ID.
   */
  private async ensureValidIsolate(): Promise<string> {
    try {
      const isolate = await this.client!.getIsolate(this.isolateId!);

      // Check the response isn't a Sentinel (DDS returns these for collected isolates)
      if (
        (isolate as Record<string, unknown>)["type"] === "Sentinel" ||
        !isolate.extensionRPCs?.some(ext => ext.startsWith("ext.flutter."))
      ) {
        // Isolate gone or lost extensions — re-discover
        const { isolateId } = await this.findFlutterIsolate();
        this.isolateId = isolateId;
        if (this.connection) {
          this.connection.isolateId = isolateId;
        }
      }
    } catch {
      // getIsolate failed — isolate probably gone, try re-discovery
      const { isolateId } = await this.findFlutterIsolate();
      this.isolateId = isolateId;
      if (this.connection) {
        this.connection.isolateId = isolateId;
      }
    }

    return this.isolateId!;
  }

  /**
   * Scan ADB logcat for the Dart VM service URL.
   */
  private async discoverVmServiceUrl(deviceId: string): Promise<string> {
    // First try existing logcat (device might already have the URL logged)
    const existing = await this.adb.execute(
      ["logcat", "-d", "-s", "flutter", "dart", "Observatory"],
      deviceId,
    );

    const existingMatch = existing.stdout.match(VM_SERVICE_PATTERN);
    if (existingMatch) {
      return existingMatch[2];
    }

    // Also try broader logcat search
    const broader = await this.adb.execute(
      ["logcat", "-d"],
      deviceId,
    );

    const broaderMatch = broader.stdout.match(VM_SERVICE_PATTERN);
    if (broaderMatch) {
      return broaderMatch[2];
    }

    // Fallback: Probe existing ADB port forwards for a live DDS/VM service
    const probed = await this.probePortForwards(deviceId);
    if (probed) {
      return probed;
    }

    throw new Error(
      "Could not find Dart VM service URL. Make sure a Flutter app is running in debug or profile mode on the device. " +
      "If the app has been running for a while, the logcat URL may have rotated out — " +
      "pass the VM service URL directly from 'flutter run' output.",
    );
  }

  /**
   * Probe existing ADB port forwards for a live Dart VM/DDS service.
   * Useful when logcat has rotated and the original URL is lost.
   */
  private async probePortForwards(deviceId: string): Promise<string | null> {
    const result = await this.adb.execute(["forward", "--list"], deviceId);
    if (result.exitCode !== 0) return null;

    // Parse forward list: "serial tcp:HOST tcp:DEVICE"
    const ports: number[] = [];
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/tcp:(\d+)\s+tcp:\d+/);
      if (match) ports.push(parseInt(match[1], 10));
    }

    // Also check common DDS port range on localhost
    // DDS typically runs on ports 50000-60000
    const http = await import("http");

    for (const port of ports) {
      try {
        const isDartService = await new Promise<boolean>((resolve) => {
          const req = http.get(
            `http://127.0.0.1:${port}/`,
            { timeout: 1500 },
            (res) => {
              // 403 = Dart VM service requiring auth token
              // 200 = Possibly DevTools or other service
              resolve(res.statusCode === 403);
              res.resume();
            },
          );
          req.on("error", () => resolve(false));
          req.on("timeout", () => { req.destroy(); resolve(false); });
        });

        if (isDartService) {
          return `http://127.0.0.1:${port}/`;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Forward a TCP port from the device to localhost.
   */
  private async forwardPort(deviceId: string, port: number): Promise<void> {
    const result = await this.adb.execute(
      ["forward", `tcp:${port}`, `tcp:${port}`],
      deviceId,
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to forward port ${port}: ${result.stderr}`);
    }
  }

  /**
   * Find the Flutter isolate that has inspector extensions registered.
   */
  private async findFlutterIsolate(): Promise<{ isolateId: string; appName: string }> {
    const vm = await this.client!.getVM();

    // Check non-system isolates for Flutter extensions
    for (const ref of vm.isolates) {
      if (ref.isSystemIsolate) continue;

      const isolate = await this.client!.getIsolate(ref.id);

      if (isolate.extensionRPCs?.some(ext => ext.startsWith("ext.flutter."))) {
        return {
          isolateId: ref.id,
          appName: ref.name || "Flutter App",
        };
      }
    }

    // Extensions might not be registered yet — wait briefly
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.client!.removeEventListener("Isolate", listener);
        reject(new Error(
          "Timed out waiting for Flutter inspector extensions. " +
          "Make sure the app is running in debug mode and has finished loading.",
        ));
      }, DISCOVERY_TIMEOUT_MS);

      const listener = (event: { kind: string; extensionRPC?: string; isolate?: { id: string; name: string } }) => {
        if (
          event.kind === "ServiceExtensionAdded" &&
          event.extensionRPC?.startsWith("ext.flutter.inspector.")
        ) {
          clearTimeout(timeout);
          this.client!.removeEventListener("Isolate", listener);
          resolve({
            isolateId: event.isolate?.id || "",
            appName: event.isolate?.name || "Flutter App",
          });
        }
      };

      this.client!.onEvent("Isolate", listener).catch(reject);
    });
  }

  /**
   * Walk the widget tree recursively, calling the visitor for each node.
   */
  private walkTree(node: WidgetNode, visitor: (node: WidgetNode) => void): void {
    visitor(node);
    if (node.children) {
      for (const child of node.children) {
        this.walkTree(child, visitor);
      }
    }
  }

  private assertConnected(): void {
    if (!this.isConnected) {
      throw new Error(
        "Not connected to a Flutter app. Call flutter_connect first.",
      );
    }
  }
}
