import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Persistent, bounded NDJSON client. Cancellation kills the helper to stop queued native input. */
export class ComputerNativeHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private buffer = "";
  private pending = new Map<number, Pending>();
  private readonly binary: string;
  private readonly stateDir: string;
  constructor(binary: string, stateDir: string) {
    this.binary = binary;
    this.stateDir = stateDir;
  }

  /** Fresh process: macOS permission preflight can be cached by a long-lived process.
   * This never interrupts the input helper, captures content, or requests consent. */
  async probePermissions(): Promise<unknown> {
    const { stdout } = await promisify(execFile)(this.binary, ["--hello"], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    child?.kill("SIGKILL");
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("Native computer use was stopped."));
    }
    this.pending.clear();
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.binary, ["--state-dir", this.stateDir], {
      windowsHide: true,
      stdio: "pipe",
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.buffer += chunk;
      if (this.buffer.length > 32 * 1024 * 1024) {
        this.stop();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const response = JSON.parse(line) as {
            id: number;
            ok: boolean;
            result?: unknown;
            error?: string;
          };
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          this.pending.delete(response.id);
          pending.cleanup();
          if (response.ok) pending.resolve(response.result);
          else pending.reject(new Error(response.error?.slice(0, 512) || "Native action failed."));
        } catch {
          this.stop();
          return;
        }
      }
    });
    // Drain diagnostics without logging application content or typed values.
    child.stderr.resume();
    child.on("error", () => {
      if (this.child === child) this.stop();
    });
    child.on("exit", () => {
      if (this.child === child) this.stop();
    });
    return child;
  }

  call(action: string, input: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error("Native request cancelled."));
    return new Promise((resolve, reject) => {
      const child = this.start();
      const id = ++this.nextId;
      const abort = () => this.stop();
      const timer = setTimeout(abort, 15_000);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(`${JSON.stringify({ id, action, input })}\n`, (error) => {
        if (error) this.stop();
      });
    });
  }
}
