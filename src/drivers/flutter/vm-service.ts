// ============================================================
// Dart VM Service Client — JSON-RPC 2.0 over WebSocket
//
// Connects to a running Flutter app's VM service and provides
// typed methods for widget inspection, render tree, and more.
// ============================================================

import WebSocket from "ws";

/** Pending RPC call awaiting response. */
interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Event listener callback. */
type EventListener = (event: VmServiceEvent) => void;

/** VM Service event from streamNotify. */
export interface VmServiceEvent {
  kind: string;
  isolate?: { type: string; id: string; name: string };
  extensionRPC?: string;
  [key: string]: unknown;
}

/** Per-request timeout (30s). */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Low-level JSON-RPC 2.0 client for the Dart VM Service Protocol.
 *
 * Usage:
 *   const client = new VmServiceClient(wsUrl);
 *   await client.connect();
 *   const vm = await client.call('getVM');
 *   client.close();
 */
export class VmServiceClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private eventListeners = new Map<string, Set<EventListener>>();
  private _connected = false;
  private wsUrl: string;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  /** Whether the WebSocket connection is open. */
  get connected(): boolean {
    return this._connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Get the final WebSocket URL (may differ from constructor URL after redirects). */
  getUrl(): string {
    return this.wsUrl;
  }

  /**
   * Open the WebSocket connection to the VM service.
   *
   * Handles 302 redirects from DDS (Dart Development Service).
   * When `flutter run` or an IDE is connected, DDS wraps the raw
   * VM service and redirects direct connections to its proxy URL.
   */
  connect(maxRedirects: number = 3): Promise<void> {
    return new Promise((resolve, reject) => {
      const attemptConnect = (url: string, redirectsLeft: number) => {
        let redirecting = false;
        const ws = new WebSocket(url);

        ws.on("open", () => {
          this.ws = ws;
          this.wsUrl = url;
          this._connected = true;
          this.attachListeners(ws);
          resolve();
        });

        ws.on("error", (err) => {
          // Ignore errors from a WebSocket we already abandoned for a redirect
          if (redirecting) return;
          if (!this._connected) {
            reject(new Error(`WebSocket connection failed: ${err.message}`));
          }
        });

        // DDS returns 302 redirect — follow it
        ws.on("unexpected-response", (_req, res) => {
          if (res.statusCode === 302 && res.headers.location && redirectsLeft > 0) {
            redirecting = true;
            ws.close();
            const redirectUrl = res.headers.location
              .replace(/^http/, "ws")
              .replace(/\/$/, "") + "/ws";
            attemptConnect(redirectUrl, redirectsLeft - 1);
          } else {
            ws.close();
            reject(new Error(
              `VM service returned ${res.statusCode}` +
              (res.headers.location ? ` (redirect: ${res.headers.location})` : ""),
            ));
          }
        });
      };

      attemptConnect(this.wsUrl, maxRedirects);
    });
  }

  /** Attach message/close listeners to the active WebSocket. */
  private attachListeners(ws: WebSocket): void {
    ws.on("message", (data) => {
      this.handleMessage(data.toString());
    });

    ws.on("close", () => {
      this._connected = false;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("WebSocket connection closed"));
      }
      this.pending.clear();
    });
  }

  /**
   * Send a JSON-RPC call and await the response.
   */
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected) {
      throw new Error("VM service not connected");
    }

    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`VM service call "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      this.ws!.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }));
    });
  }

  /**
   * Register a listener for VM service events on a specific stream.
   * Automatically calls streamListen if this is the first listener.
   */
  async onEvent(streamId: string, listener: EventListener): Promise<void> {
    if (!this.eventListeners.has(streamId)) {
      this.eventListeners.set(streamId, new Set());
      await this.call("streamListen", { streamId });
    }
    this.eventListeners.get(streamId)!.add(listener);
  }

  /**
   * Remove an event listener.
   */
  removeEventListener(streamId: string, listener: EventListener): void {
    const listeners = this.eventListeners.get(streamId);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * Close the WebSocket connection and clean up.
   */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this.pending.clear();
    this.eventListeners.clear();
  }

  // ----------------------------------------------------------------
  // Convenience methods for common VM service calls
  // ----------------------------------------------------------------

  /** Get the top-level VM information including isolate list. */
  async getVM(): Promise<VmInfo> {
    return await this.call("getVM") as VmInfo;
  }

  /** Get full isolate details including registered extensions. */
  async getIsolate(isolateId: string): Promise<IsolateInfo> {
    return await this.call("getIsolate", { isolateId }) as IsolateInfo;
  }

  /** Call a Flutter service extension. */
  async callExtension(
    method: string,
    isolateId: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await this.call(method, { isolateId, ...args });
  }

  /**
   * Evaluate a Dart expression in the context of a library or object.
   * Used to run Dart code remotely for coordinate resolution.
   */
  async evaluate(
    isolateId: string,
    targetId: string,
    expression: string,
  ): Promise<EvalResult> {
    return await this.call("evaluate", {
      isolateId,
      targetId,
      expression,
    }) as EvalResult;
  }

  // ----------------------------------------------------------------
  // Private
  // ----------------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // Ignore malformed messages
    }

    // Response to a pending call
    // DDS (via json_rpc_2) may return IDs as strings even if we sent integers
    const msgId = typeof msg["id"] === "string" ? parseInt(msg["id"], 10) : msg["id"];
    if (typeof msgId === "number" && !isNaN(msgId)) {
      const pending = this.pending.get(msgId);
      if (pending) {
        this.pending.delete(msgId);
        clearTimeout(pending.timer);

        if (msg["error"]) {
          const err = msg["error"] as { message?: string; data?: { details?: string } };
          pending.reject(
            new Error(`VM service error: ${err.message || JSON.stringify(err)}${err.data?.details ? ` — ${err.data.details}` : ""}`),
          );
        } else {
          pending.resolve(msg["result"]);
        }
      }
      return;
    }

    // Stream event notification
    if (msg["method"] === "streamNotify") {
      const params = msg["params"] as { streamId?: string; event?: VmServiceEvent } | undefined;
      if (params?.streamId && params.event) {
        const listeners = this.eventListeners.get(params.streamId);
        if (listeners) {
          for (const listener of listeners) {
            listener(params.event);
          }
        }
      }
    }
  }
}

// ----------------------------------------------------------------
// Response types
// ----------------------------------------------------------------

export interface VmInfo {
  type: string;
  name: string;
  architectureBits: number;
  operatingSystem: string;
  version: string;
  pid: number;
  isolates: IsolateRef[];
  isolateGroups: unknown[];
  systemIsolates: IsolateRef[];
}

export interface IsolateRef {
  type: string;
  id: string;
  name: string;
  number: string;
  isSystemIsolate: boolean;
}

export interface IsolateInfo {
  type: string;
  id: string;
  name: string;
  number: string;
  isSystemIsolate: boolean;
  extensionRPCs?: string[];
  libraries: unknown[];
  [key: string]: unknown;
}

/** A node in the Flutter widget tree (from inspector extensions). */
export interface WidgetNode {
  description: string;
  type: string;
  style?: string;
  hasChildren: boolean;
  objectId?: string;
  valueId?: string;
  widgetRuntimeType: string;
  children?: WidgetNode[];
  properties?: PropertyNode[];
  creationLocation?: SourceLocation;
  createdByLocalProject?: boolean;
  summaryTree?: boolean;
  textPreview?: string;
}

export interface PropertyNode {
  description: string;
  type: string;
  name: string;
  style?: string;
  propertyType?: string;
  value?: unknown;
}

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  name?: string;
  parameterLocations?: Array<{
    file: string | null;
    line: number;
    column: number;
    name: string;
  }>;
}

export interface EvalResult {
  type: string;
  valueAsString?: string;
  valueAsStringIsTruncated?: boolean;
  kind?: string;
  id?: string;
}
