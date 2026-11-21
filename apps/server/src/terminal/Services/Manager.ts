/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import {
  type DiagnosticsTerminalProcess,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalCwdError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalOpenInput,
  type TerminalRef,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalSessionLookupError,
  TerminalWriteInput,
} from "@ryco/contracts";
import { Effect, Context, type Option } from "effect";

import type { PtyInputMode } from "./PTY.ts";

/** One session as agent terminal tools read it; nothing here starts or changes it. */
export interface TerminalSessionInspection {
  /** With the retained (sanitized) history. */
  readonly snapshot: TerminalSessionSnapshot;
  readonly hasRunningSubprocess: boolean;
  readonly cols: number;
  readonly rows: number;
  /** The tty's foreground process name where the platform tells it cheaply (macOS node-pty). */
  readonly foregroundProcessName?: string;
  /** What the foreground process is called while the shell is idle, once seen. */
  readonly idleForegroundName?: string;
  /** The nonce in the shell's prompt and command marks; absent for a shell without them. */
  readonly markNonce?: string;
}

export {
  TerminalCwdError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalSessionLookupError,
};

/**
 * TerminalManagerShape - Service API for terminal session lifecycle operations.
 */
export interface TerminalManagerShape {
  /**
   * Open or attach to a terminal session.
   *
   * Reuses an existing session for the same thread/terminal id and restores
   * persisted history on first open.
   */
  readonly open: (
    input: TerminalOpenInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Write input bytes to a terminal session.
   */
  readonly write: (
    input: TerminalWriteInput,
    canCommit?: () => boolean,
  ) => Effect.Effect<void, TerminalError>;

  /**
   * Resize the PTY backing a terminal session.
   */
  readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

  /**
   * Clear terminal output history.
   */
  readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

  /**
   * Restart a terminal session in place.
   *
   * Always resets history before spawning the new process.
   */
  readonly restart: (
    input: TerminalRestartInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Close an active terminal session.
   *
   * When `terminalId` is omitted, closes all sessions for the thread.
   */
  readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

  /**
   * Subscribe to terminal runtime events with a direct callback.
   *
   * Returns an unsubscribe function.
   */
  readonly subscribe: (
    listener: (event: TerminalEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;

  /**
   * Read terminal process/session summaries for diagnostics. History and
   * runtime environment values are intentionally omitted.
   */
  readonly listDiagnostics: Effect.Effect<ReadonlyArray<DiagnosticsTerminalProcess>>;

  /**
   * Read terminal session snapshots, including retained history. Used by
   * reconnecting event streams to catch clients up to the current terminal
   * state before live events continue.
   */
  readonly listSessions: Effect.Effect<ReadonlyArray<TerminalSessionSnapshot>>;

  /** One session with its history and process state; `none` for an unknown terminal. */
  readonly inspect?: (ref: TerminalRef) => Effect.Effect<Option.Option<TerminalSessionInspection>>;

  /**
   * Whether the shell is idle at this moment (no command running), by the same fresh
   * process-table read a `requireIdle` write makes; false when busy or it cannot tell.
   */
  readonly verifyIdle?: (ref: TerminalRef) => Effect.Effect<boolean>;

  /** The tty's echo and line-mode flags now, when the PTY adapter can read them. */
  readonly readInputMode?: (ref: TerminalRef) => Effect.Effect<Option.Option<PtyInputMode>>;
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<TerminalManager, TerminalManagerShape>()(
  "ryco/terminal/Services/Manager/TerminalManager",
) {}
