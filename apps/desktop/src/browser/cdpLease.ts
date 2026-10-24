import type { WebContents } from "electron";

/** Holders of a page's debugger session. "picker" is browser-picker's element picker. */
export type CdpHolder = "agent" | "picker";
/** A command on one attachment; given to ready steps. */
export type CdpSend = (method: string, params?: object) => Promise<unknown>;
export interface CdpSendOptions {
  /** Reject with "Browser command timed out." after this long; waiting for ready steps counts. */
  readonly timeoutMs?: number;
  /** Do not wait for the ready steps (event handlers and fire-and-forget clears). Still requires a session. */
  readonly skipReady?: boolean;
}

type ReadyStep = (send: CdpSend) => Promise<void>;
type EventListener = (method: string, params: unknown, sessionId?: string) => void;
type DetachListener = (reason: string) => void;

/** One debugger session, from attach (or adoption) to its end. */
interface Attachment {
  ready: Promise<void> | null;
}

const NOT_ATTACHED = "Browser debugger is not attached.";

/**
 * One shared `webContents.debugger` session per page, held by named holders.
 *
 * - The first `acquire` attaches ("1.3"); the last `release` detaches. Nothing else attaches or
 *   detaches this page's debugger.
 * - Ready steps run once per attachment, in registration order, before the first command any holder
 *   sends on it, whoever attached. A failed run rejects its callers and is retried by the next call.
 * - Domain ownership (browser-groundwork spec 4.6): a unit enables, disables, sets or clears only the
 *   domains it owns and never relies on another unit's enable.
 * - Never touches the debugger once the contents are destroyed (Electron's wrapper throws).
 */
export class CdpLease {
  private readonly contents: Pick<WebContents, "debugger" | "isDestroyed">;
  private readonly holders = new Set<CdpHolder>();
  private attachment: Attachment | null = null;
  // Entries are wrapped so one function can be registered twice and unregistered once.
  private readonly readySteps = new Set<{ readonly step: ReadyStep }>();
  private readonly eventListeners = new Set<{ readonly listener: EventListener }>();
  private readonly detachListeners = new Set<{ readonly listener: DetachListener }>();
  private disposed = false;

  constructor(contents: Pick<WebContents, "debugger" | "isDestroyed">) {
    this.contents = contents;
    contents.debugger.on("message", this.onMessage);
    contents.debugger.on("detach", this.onElectronDetach);
  }

  /** Opens the session when nobody holds it. True when `holder` did not hold it before. Throws "Browser tab closed." after dispose or destruction. */
  acquire(holder: CdpHolder): boolean {
    if (this.disposed || this.contents.isDestroyed()) throw new Error("Browser tab closed.");
    if (!this.attachment) {
      const api = this.contents.debugger;
      if (!api.isAttached()) api.attach("1.3");
      this.attachment = { ready: null };
    }
    const first = !this.holders.has(holder);
    this.holders.add(holder);
    return first;
  }

  /** Drops `holder` (no-op for a non-holder). The last holder detaches and notifies onDetach("released"). */
  release(holder: CdpHolder): void {
    if (!this.holders.delete(holder)) return;
    if (this.holders.size === 0 && this.attachment) this.end("released", true);
  }

  holds(holder: CdpHolder): boolean {
    return this.holders.has(holder);
  }

  /** A session is open (at least one holder). */
  isAttached(): boolean {
    return this.attachment !== null;
  }

  /** Registers a ready step; returns its unregister function. A step added while an attachment is ready runs from the next attachment on. */
  onReady(step: ReadyStep): () => void {
    if (this.disposed) return () => undefined;
    const entry = { step };
    this.readySteps.add(entry);
    return () => {
      this.readySteps.delete(entry);
    };
  }

  /** Runs (or joins) this attachment's ready steps. Rejects "Browser debugger is not attached." without a session. */
  ready(): Promise<void> {
    const attachment = this.attachment;
    if (!attachment || this.contents.isDestroyed()) return Promise.reject(new Error(NOT_ATTACHED));
    return this.readyFor(attachment);
  }

  /** One command on the open session, after the ready steps unless `skipReady`. Never attaches. */
  send(method: string, params: object = {}, options: CdpSendOptions = {}): Promise<unknown> {
    const command = this.command(method, params, options.skipReady === true);
    const { timeoutMs } = options;
    if (timeoutMs === undefined) return command;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      command,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Browser command timed out.")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** Fan-out of the debugger "message" event (one Electron listener per page). */
  onEvent(listener: EventListener): () => void {
    if (this.disposed) return () => undefined;
    const entry = { listener };
    this.eventListeners.add(entry);
    return () => {
      this.eventListeners.delete(entry);
    };
  }

  /**
   * Fires once per session end, holders already cleared: the last release ("released") and Electron's
   * own "detach" (DevTools opened, target closed; Electron's reason string). An Electron "detach" that
   * follows the lease's own detach is ignored, whether or not Electron emits one.
   */
  onDetach(listener: DetachListener): () => void {
    if (this.disposed) return () => undefined;
    const entry = { listener };
    this.detachListeners.add(entry);
    return () => {
      this.detachListeners.delete(entry);
    };
  }

  /** Page teardown: drops listeners and steps, detaches if a session is open and the contents live. Notifies nobody. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const open = this.attachment !== null;
    this.attachment = null;
    this.holders.clear();
    this.readySteps.clear();
    this.eventListeners.clear();
    this.detachListeners.clear();
    if (this.contents.isDestroyed()) return;
    const api = this.contents.debugger;
    api.removeListener("message", this.onMessage);
    api.removeListener("detach", this.onElectronDetach);
    if (open && api.isAttached()) api.detach();
  }

  private async command(method: string, params: object, skipReady: boolean): Promise<unknown> {
    const attachment = this.attachment;
    if (!attachment || this.contents.isDestroyed()) throw new Error(NOT_ATTACHED);
    if (!skipReady) await this.readyFor(attachment);
    // The session may have ended while the ready steps ran; never reach a later one.
    if (attachment !== this.attachment || this.contents.isDestroyed())
      throw new Error(NOT_ATTACHED);
    return this.contents.debugger.sendCommand(method, params);
  }

  private readyFor(attachment: Attachment): Promise<void> {
    if (attachment.ready) return attachment.ready;
    const steps = [...this.readySteps];
    // Bound to this attachment: a step that outlives its session never reaches the next one.
    const send: CdpSend = (method, params = {}) =>
      attachment !== this.attachment || this.contents.isDestroyed()
        ? Promise.reject(new Error(NOT_ATTACHED))
        : this.contents.debugger.sendCommand(method, params);
    const ready = (async () => {
      for (const { step } of steps) await step(send);
    })();
    attachment.ready = ready;
    // A failed run rejects its callers; the next caller on this attachment runs the steps again.
    ready.catch(() => {
      if (attachment.ready === ready) attachment.ready = null;
    });
    return ready;
  }

  private end(reason: string, detach: boolean): void {
    // Clear first: Electron may emit "detach" synchronously from inside detach(), and that
    // notification must be ignored so listeners see this session end exactly once.
    this.attachment = null;
    this.holders.clear();
    try {
      if (detach && !this.contents.isDestroyed()) {
        const api = this.contents.debugger;
        if (api.isAttached()) api.detach();
      }
    } finally {
      // A snapshot: a listener that subscribes during the notification waits for the next one.
      for (const { listener } of Array.from(this.detachListeners)) {
        try {
          listener(reason);
        } catch {
          // Listeners own their errors; one must not starve the rest.
        }
      }
    }
  }

  private readonly onMessage = (
    _event: Electron.Event,
    method: string,
    params: unknown,
    sessionId?: string,
  ): void => {
    for (const { listener } of Array.from(this.eventListeners)) {
      try {
        listener(method, params, sessionId);
      } catch {
        // Listeners own their errors; never throw into Electron's emitter.
      }
    }
  };

  private readonly onElectronDetach = (_event: Electron.Event, reason: string): void => {
    if (this.attachment) this.end(reason, false);
  };
}
