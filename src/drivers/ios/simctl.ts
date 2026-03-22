// ============================================================
// Low-level xcrun simctl command execution wrapper
// ============================================================

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 50 * 1024 * 1024;

export interface SimctlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class Simctl {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  async execute(args: string[]): Promise<SimctlResult> {
    try {
      const { stdout, stderr } = await execFile("xcrun", ["simctl", ...args], {
        timeout: this.timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      });
      return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null) {
        const err = error as Record<string, unknown>;
        return {
          stdout: typeof err["stdout"] === "string" ? err["stdout"] : "",
          stderr: typeof err["stderr"] === "string" ? err["stderr"] : String(err["message"] ?? ""),
          exitCode: typeof err["code"] === "number" ? err["code"] : 1,
        };
      }
      return { stdout: "", stderr: String(error), exitCode: 1 };
    }
  }

  async executeBuffer(args: string[]): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      execFileCb(
        "xcrun",
        ["simctl", ...args],
        {
          timeout: this.timeoutMs,
          maxBuffer: MAX_BUFFER,
          encoding: "buffer" as unknown as string,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            reject(new Error(`simctl command failed: ${error.message}`));
            return;
          }
          const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as unknown as string, "binary");
          resolve(buf);
        },
      );
    });
  }
}
