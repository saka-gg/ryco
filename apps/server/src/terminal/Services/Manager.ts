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
  type TerminalCursor,
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
  /** The nonce in the shell's prompt and command marks (one per spawn); absent without them. */
  readonly markNonce?: string;
  /** What the shell's marks say, for a shell with them. */
  readonly shell?: {
    readonly promptSeen: boolean;
    readonly atPrompt: boolean;
    readonly inputSincePrompt: boolean;
    readonly lastEnd: { readonly exitCode: number | null; readonly sequence: number } | null;
  };
}

/** One chunk of a terminal's output as the shell printed it, Ryco's marks included. */
export interface TerminalAgentOutput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly data: string;
  readonly cursor: TerminalCursor;
  /** The session's mark nonce, null for a shell without marks. */
  readonly markNonce: string | null;
}

/** What an agent's write checks first, inside the thread's lock, before anything is typed. */
export interface TerminalAgentWriteChecks {
  /** The shell runs no command (`requireIdle`'s process-table read). */
  readonly idle?: boolean;
  /** A shell with marks drew its prompt, runs nothing and nobody typed at it since. */
  readonly prompt?: boolean;
  /** The tty does not hide input (echo off in line mode: a password prompt). */
  readonly visibleInput?: boolean;
}

export type TerminalAgentWriteRefusal =
  | "running"
  | "unverified"
  | "input-raced"
  | "starting"
  | "user-typing"
  | "hidden-input"
  | "input-mode-unknown"
  | "not-running";

export class TerminalAgentWriteRefused {
  readonly _tag = "TerminalAgentWriteRefused";
  readonly reason: TerminalAgentWriteRefusal;
  constructor(reason: TerminalAgentWriteRefusal) {
    this.reason = reason;
  }
}

export interface TerminalAgentWriteResult {
  /** False where the platform cannot read the tty's flags (Windows): only the screen tells. */
  readonly inputModeChecked: boolean;
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

  /**
   * The retained history after `sequence`: `none` for an unknown terminal, `null` when the
   * history no longer reaches back that far (trimmed, cleared, restarted).
   */
  readonly historySince?: (
    ref: TerminalRef,
    sequence: number,
  ) => Effect.Effect<Option.Option<string | null>>;

  /** Raw output, Ryco's shell marks included, for agent terminal mirrors only. */
  readonly subscribeAgentOutput?: (
    listener: (output: TerminalAgentOutput) => void,
  ) => Effect.Effect<() => void>;

  /** An agent's input, typed only when `checks` pass, all inside the thread's lock. */
  readonly agentWrite?: (input: {
    readonly ref: TerminalRef;
    readonly data: string;
    readonly checks: TerminalAgentWriteChecks;
  }) => Effect.Effect<TerminalAgentWriteResult, TerminalAgentWriteRefused>;
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<TerminalManager, TerminalManagerShape>()(
  "ryco/terminal/Services/Manager/TerminalManager",
) {}
