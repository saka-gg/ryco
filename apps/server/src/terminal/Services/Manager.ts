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
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalSessionLookupError,
  TerminalSessionStatus,
  TerminalWriteInput,
} from "@ryco/contracts";
import type { PtyProcess } from "./PTY.ts";
import { Effect, Context } from "effect";

export {
  TerminalCwdError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalSessionLookupError,
};

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  pendingHistoryControlSequence: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  runtimeEnv: Record<string, string> | null;
}

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

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
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<TerminalManager, TerminalManagerShape>()(
  "ryco/terminal/Services/Manager/TerminalManager",
) {}
