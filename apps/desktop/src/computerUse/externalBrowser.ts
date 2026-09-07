import type { WebSocket } from "ws";
import type { BrowserTab, BrowserTransport } from "./browser.ts";
import { record, textArg } from "./native.ts";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Each authenticated connection represents one explicitly paired browser profile. */
export class ExternalComputerBrowser implements BrowserTransport {
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private readonly socket: WebSocket;
  private readonly onClose: () => void;
  constructor(socket: WebSocket, onClose: () => void) {
    this.socket = socket;
    this.onClose = onClose;
    socket.on("message", (bytes) => {
      try {
        const payload = record(JSON.parse(bytes.toString()));
        if (payload.type === "heartbeat") {
          socket.send(JSON.stringify({ type: "heartbeat" }));
          return;
        }
        const pending = this.pending.get(Number(payload.id));
        if (!pending) return;
        this.pending.delete(Number(payload.id));
        pending.cleanup();
        if (payload.error)
          pending.reject(
            new Error("Browser action failed or the target disconnected. Observe it again."),
          );
        else pending.resolve(payload.result);
      } catch {
        this.stop();
      }
    });
    socket.on("close", () => this.stop());
    socket.on("error", () => this.stop());
  }
  private call(
    action: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted || this.closed)
      return Promise.reject(new Error("Browser connection is unavailable."));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const abort = () => this.stop();
      const timeout = setTimeout(abort, 15_000);
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      this.socket.send(JSON.stringify({ id, action, ...params }), (error) => {
        if (error) this.stop();
      });
    });
  }
  private tab(raw: unknown): BrowserTab {
    const value = record(raw);
    return {
      id: String(value.id),
      title: textArg(value, "title", 4096),
      url: textArg(value, "url", 8192),
    };
  }
  async tabs(signal: AbortSignal): Promise<BrowserTab[]> {
    const values = await this.call("tabs", {}, signal);
    if (!Array.isArray(values)) throw new Error("Invalid browser tabs.");
    return values.slice(0, 500).map((value) => this.tab(value));
  }
  async open(url: string, visible: boolean, signal: AbortSignal): Promise<BrowserTab> {
    return this.tab(await this.call("open", { url, visible }, signal));
  }
  async show(tab: string, signal: AbortSignal): Promise<void> {
    await this.call("show", { tab }, signal);
  }
  async close(tab: string, signal: AbortSignal): Promise<void> {
    await this.call("close", { tab }, signal);
  }
  send(
    tab: string,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.call("cdp", { tab, method, params }, signal);
  }
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("Browser disconnected or control stopped."));
    }
    this.pending.clear();
    this.onClose();
  }
}
