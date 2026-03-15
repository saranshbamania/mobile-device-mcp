// ============================================================
// Low-level ADB command execution wrapper
// Handles all communication with the `adb` binary.
// ============================================================

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { ADBResult } from "../../types.js";

const execFile = promisify(execFileCb);

/** Default command timeout in milliseconds (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum stdout/stderr buffer size (50 MB — large enough for screenshots). */
const MAX_BUFFER = 50 * 1024 * 1024;

export class ADB {
  private readonly adbPath: string;
  private readonly timeoutMs: number;

  constructor(adbPath: string = "adb", timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.adbPath = adbPath;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Execute an ADB command and return structured result.
   * If `deviceId` is provided, `-s deviceId` is prepended to args.
   */
  async execute(args: string[], deviceId?: string): Promise<ADBResult> {
    const fullArgs = this.buildArgs(args, deviceId);

    try {
      const { stdout, stderr } = await execFile(this.adbPath, fullArgs, {
        timeout: this.timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      });

      return {
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        exitCode: 0,
      };
    } catch (error: unknown) {
      return this.handleExecError(error);
    }
  }

  /**
   * Execute an ADB command and return raw stdout as a Buffer.
   * Useful for binary data such as screenshots (screencap -p).
   * Throws on non-zero exit code.
   */
  async executeBuffer(args: string[], deviceId?: string): Promise<Buffer> {
    const fullArgs = this.buildArgs(args, deviceId);

    return new Promise<Buffer>((resolve, reject) => {
      const child = execFileCb(
        this.adbPath,
        fullArgs,
        {
          timeout: this.timeoutMs,
          maxBuffer: MAX_BUFFER,
          encoding: "buffer" as unknown as string, // force Buffer output
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            const stderrStr =
              stderr instanceof Buffer ? stderr.toString("utf-8") : String(stderr ?? "");
            const code = (error as NodeJS.ErrnoException).code;

            if (code === "ETIMEDOUT") {
              reject(new Error(`ADB command timed out after ${this.timeoutMs}ms: adb ${fullArgs.join(" ")}`));
              return;
            }
            if (code === "ENOENT") {
              reject(new Error(`ADB binary not found at "${this.adbPath}". Is ADB installed and on PATH?`));
              return;
            }

            reject(
              new Error(
                `ADB command failed (exit ${(error as any).code ?? "unknown"}): ${stderrStr || error.message}`,
              ),
            );
            return;
          }

          // stdout may be a Buffer or string depending on Node internals
          const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as unknown as string, "binary");
          resolve(buf);
        },
      );

      // Safety: kill child if it somehow exceeds timeout without being caught
      child.on("error", (err) => {
        reject(err);
      });
    });
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private buildArgs(args: string[], deviceId?: string): string[] {
    if (deviceId) {
      return ["-s", deviceId, ...args];
    }
    return args;
  }

  private handleExecError(error: unknown): ADBResult {
    if (typeof error === "object" && error !== null) {
      const err = error as Record<string, unknown>;

      // Node child_process error with code field
      const nodeCode = typeof err["code"] === "string" ? err["code"] : undefined;

      if (nodeCode === "ETIMEDOUT") {
        return {
          stdout: "",
          stderr: `ADB command timed out after ${this.timeoutMs}ms`,
          exitCode: -1,
        };
      }

      if (nodeCode === "ENOENT") {
        return {
          stdout: "",
          stderr: `ADB binary not found at "${this.adbPath}". Is ADB installed and on PATH?`,
          exitCode: -1,
        };
      }

      const message = typeof err["message"] === "string" ? err["message"] : "Unknown ADB error";

      return {
        stdout: typeof err["stdout"] === "string" ? err["stdout"] : "",
        stderr: typeof err["stderr"] === "string" ? err["stderr"] : message,
        exitCode: typeof err["code"] === "number" ? err["code"] : 1,
      };
    }

    return {
      stdout: "",
      stderr: String(error),
      exitCode: 1,
    };
  }
}

export default ADB;
