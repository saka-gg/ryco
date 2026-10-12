/**
 * Backend startup signals and the restart policy that reads them.
 *
 * The backend reports its lifecycle as newline-delimited JSON frames on the
 * desktop telemetry pipe (fd 4). `http-serving` is the authoritative readiness
 * signal; the "Listening on" log line stays as a fallback for older backends
 * and the HTTP probe as a last resort.
 */
import {
  DESKTOP_BACKEND_FATAL_EXIT_CODE,
  type DesktopBackendLifecycleFrame,
} from "@ryco/shared/desktopResourceTelemetry";

import { ServerListeningDetector } from "./serverListeningDetector.ts";

export type BackendReadySource = "protocol" | "listening";

/** The backend serves a port the desktop did not assign (it missed its envelope). */
export class BackendPortMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendPortMismatchError";
  }
}

/** The backend reported a start failure that retrying cannot fix. */
export class BackendFatalStartupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BackendFatalStartupError";
    this.code = code;
  }
}

/**
 * Readiness of one backend child: resolves on the first trustworthy signal,
 * rejects when the child fails, reports a fatal error, or serves a port the
 * desktop did not assign (the renderer could never reach it).
 */
export class BackendReadinessTracker {
  readonly promise: Promise<BackendReadySource>;
  private readonly detector: ServerListeningDetector;
  private resolvePromise!: (source: BackendReadySource) => void;
  private rejectPromise!: (error: unknown) => void;
  private settledState = false;
  private readyState = false;
  private fatalFrame: { readonly code: string; readonly message: string } | null = null;
  private readonly expectedPort: number;

  constructor(expectedPort: number) {
    this.expectedPort = expectedPort;
    this.promise = new Promise<BackendReadySource>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
    // Callers observe failures through `promise`; never leave it unhandled.
    this.promise.catch(() => undefined);
    this.detector = new ServerListeningDetector({ expectedPort });
    this.detector.promise.then(
      () => this.settle("listening"),
      (error: unknown) =>
        this.fail(
          error instanceof Error && error.message.startsWith("backend is listening on port")
            ? new BackendPortMismatchError(error.message)
            : error,
        ),
    );
  }

  get settled(): boolean {
    return this.settledState;
  }

  /** Settled successfully: the backend is serving. */
  get ready(): boolean {
    return this.readyState;
  }

  get fatal(): { readonly code: string; readonly message: string } | null {
    return this.fatalFrame;
  }

  pushOutput(chunk: unknown): void {
    this.detector.push(chunk);
  }

  handleFrame(frame: DesktopBackendLifecycleFrame): void {
    if (frame.type === "fatal") {
      this.fatalFrame = { code: frame.code, message: frame.message };
      this.fail(new BackendFatalStartupError(frame.code, frame.message));
      return;
    }
    if (frame.type !== "http-serving") return;
    if (frame.port !== this.expectedPort) {
      this.fail(
        new BackendPortMismatchError(
          `backend is serving port ${frame.port}, expected ${this.expectedPort}`,
        ),
      );
      return;
    }
    this.settle("protocol");
  }

  fail(error: unknown): void {
    if (this.settledState) return;
    this.settledState = true;
    this.detector.fail(error);
    this.rejectPromise(error);
  }

  private settle(source: BackendReadySource): void {
    if (this.settledState) return;
    this.settledState = true;
    this.readyState = true;
    this.detector.fail(new Error("readiness already settled"));
    this.resolvePromise(source);
  }
}

/** Consecutive exits before readiness after which retrying stops. */
export const MAX_CONSECUTIVE_PRE_READY_BACKEND_FAILURES = 3;

export type BackendExitDecision =
  | { readonly action: "restart" }
  | {
      readonly action: "halt";
      readonly reason: "fatal" | "crash-loop";
      readonly consecutiveFailures: number;
    };

/**
 * When to stop restarting. A crash after readiness restarts with backoff as
 * before; a deterministic start failure (a database newer than this build, an
 * invalid configuration) must not spin the splash screen forever.
 */
export function createBackendFailurePolicy(
  maxConsecutivePreReadyFailures = MAX_CONSECUTIVE_PRE_READY_BACKEND_FAILURES,
) {
  let consecutivePreReadyFailures = 0;
  return {
    recordReady(): void {
      consecutivePreReadyFailures = 0;
    },
    reset(): void {
      consecutivePreReadyFailures = 0;
    },
    recordExit(input: {
      readonly reachedReady: boolean;
      readonly exitCode: number | null;
      readonly fatal: boolean;
    }): BackendExitDecision {
      if (input.fatal || input.exitCode === DESKTOP_BACKEND_FATAL_EXIT_CODE) {
        consecutivePreReadyFailures += input.reachedReady ? 0 : 1;
        return {
          action: "halt",
          reason: "fatal",
          consecutiveFailures: consecutivePreReadyFailures,
        };
      }
      if (input.reachedReady) {
        consecutivePreReadyFailures = 0;
        return { action: "restart" };
      }
      consecutivePreReadyFailures += 1;
      return consecutivePreReadyFailures >= maxConsecutivePreReadyFailures
        ? {
            action: "halt",
            reason: "crash-loop",
            consecutiveFailures: consecutivePreReadyFailures,
          }
        : { action: "restart" };
    },
  };
}

// Strip terminal colour codes from backend output shown to the user.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The last lines a backend printed, kept for the startup failure message. */
export class BackendOutputTail {
  private text = "";
  private readonly maxChars: number;

  constructor(maxChars = 4_000) {
    this.maxChars = maxChars;
  }

  push(chunk: Buffer | string): void {
    this.text = `${this.text}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`;
    if (this.text.length > this.maxChars) this.text = this.text.slice(-this.maxChars);
  }

  lines(maxLines = 8): string[] {
    return this.text
      .replace(ANSI_ESCAPE, "")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-maxLines);
  }
}
