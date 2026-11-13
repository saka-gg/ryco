import { noteStorageActivity } from "../../storage/lifecycle.ts";
import * as SqlClient from "effect/sql/SqlClient";
import {
  storageLifecycleLock,
  storagePathBlocker,
  canonicalStoragePath,
} from "../../storage/lifecycle.ts";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { restoreChatFolder } from "../../project/chatFolderRestore.ts";

import {
  DEFAULT_TERMINAL_ID,
  PROJECT_RELOCATION_PENDING_MESSAGE,
  TerminalBusyError,
  TerminalInputRejectedError,
  type DiagnosticsTerminalProcess,
  type TerminalEvent,
  type TerminalCursor,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
} from "@ryco/contracts";
import { makeKeyedCoalescingWorker } from "@ryco/shared/KeyedCoalescingWorker";
import { latestStateQueuePolicy } from "@ryco/shared/QueuePolicy";
import { bracketedTerminalSnippet } from "@ryco/shared/terminalPaste";
import { isTerminalReportData } from "@ryco/shared/terminalReports";
import {
  Clock,
  Effect,
  Deferred,
  Equal,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Ref,
  Schema,
  Scope,
  Semaphore,
  SynchronizedRef,
} from "effect";
import { Base64Url } from "effect/encoding";

import { ServerConfig } from "../../config.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../../observability/Metrics.ts";
import {
  approximateTextBytes,
  isServerPerfProfileEnabled,
  recordServerPerf,
} from "../../observability/PerfInstrumentation.ts";
import { runProcess } from "../../processRunner.ts";
import {
  WorkspaceAccessPolicy,
  type WorkspaceAccessPolicyShape,
} from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import {
  TerminalCwdError,
  TerminalHistoryError,
  TerminalManager,
  TerminalNotRunningError,
  TerminalSessionLookupError,
  type TerminalManagerShape,
} from "../Services/Manager.ts";
import {
  type HistoryBufferLimits,
  type HistoryBufferState,
  appendTerminalHistoryChunk,
  countNewlines,
  emptyHistoryBufferState,
  historyBufferStateFrom,
  utf8ByteLength,
} from "../historyBuffer.ts";
import { TerminalHistoryCursorIndex } from "../historyCursorIndex.ts";
import { createTerminalSpawnEnv } from "../terminalSpawnEnv.ts";
import {
  defaultShellResolver,
  formatShellCandidate,
  resolveShellCandidates,
  type ShellCandidate,
} from "../terminalShell.ts";
import {
  PtyAdapter,
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
} from "../Services/PTY.ts";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Output persists at most once per window per session. A window appends the
 * output it collected to the history file; lifecycle changes (clear, restart,
 * close) and compaction rewrite the file with the retained history. Exit and
 * shutdown flush the pending window immediately.
 */
const DEFAULT_PERSIST_DEBOUNCE_MS = 1_000;
/**
 * The history file keeps growing by appends past the retained budgets, whose
 * head the session already trimmed in memory. Once it holds this many times
 * either budget, the next window rewrites it with the retained history, so
 * rewrites cost O(output) amortized and a cold open reads a bounded file.
 */
const HISTORY_FILE_COMPACTION_FACTOR = 1.5;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
/**
 * Process-table cadence once no terminal has had input (or a start, or an
 * activity change) for this long. Subprocesses start after a command line, so
 * recent input keeps the fast cadence; idle shells and continuous output still
 * get a periodic check for silent changes such as background jobs ending.
 */
const DEFAULT_SUBPROCESS_IDLE_POLL_INTERVAL_MS = 5_000;
/**
 * Once nothing (input, a start, an activity change, or output) has happened for this long,
 * the idle cadence lengthens to the deep-idle interval. Input, a start or an activity change
 * restores the fast cadence on the next tick; output restores the regular idle cadence. A
 * terminal left open and untouched then costs one check per deep-idle interval.
 */
const DEFAULT_SUBPROCESS_DEEP_IDLE_AFTER_MS = 60_000;
const DEFAULT_SUBPROCESS_DEEP_IDLE_POLL_INTERVAL_MS = 30_000;
/**
 * Output alone does not keep the fast cadence: a command producing output
 * already shows as running, and its end shows as output going quiet after the
 * next prompt. One check runs on the first tick after output has been quiet
 * this long (capped at a quarter of the tick interval).
 */
const DEFAULT_SUBPROCESS_OUTPUT_QUIET_MS = 250;
/**
 * A `requireIdle` write refuses a shell that received input this recently: a command line
 * submitted just before may not have forked its command yet, so the process table cannot
 * vouch for it.
 */
const REQUIRE_IDLE_INPUT_SETTLE_MS = 500;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_MAX_PENDING_PROCESS_EVENTS = 2_048;
const DEFAULT_MAX_PENDING_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
/**
 * PTY output of one process is coalesced for up to this long before it becomes one output
 * event, so progress bars and full-screen redraws do not cost one WebSocket message (and one
 * relay encryption) per PTY read. The leading chunk after a quiet window and the echo of typed
 * input leave at once; only the chunks that follow inside the window wait.
 */
export const DEFAULT_TERMINAL_OUTPUT_COALESCE_MS = 16;
/** Held output leaves at once at this size, and a drained backlog merges up to it. */
const OUTPUT_COALESCE_MAX_BYTES = 64 * 1024;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;

class TerminalSubprocessCheckError extends Schema.TaggedError<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    command: Schema.Literals(["powershell", "ps", "procfs"]),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    timedOut: Schema.optional(Schema.Boolean),
    stdoutTruncated: Schema.optional(Schema.Boolean),
  },
) {}

class TerminalProcessSignalError extends Schema.TaggedError<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
  },
) {}

export interface TerminalProcessTableSnapshot {
  readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>;
}

export interface TerminalProcessTableSnapshotter {
  /** `shellPids` are the running terminals' shells; a snapshot may cover only them. */
  (
    shellPids: ReadonlyArray<number>,
  ): Effect.Effect<TerminalProcessTableSnapshot, TerminalSubprocessCheckError | Error>;
}

interface TerminalStartInput {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath?: string | null;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

interface TerminalSessionState {
  inputEpoch: string;
  hasReceivedInput: boolean;
  /**
   * Clock time of the last input that could start a command, null when none came since the
   * shell started. Focus reports and query replies the emulator sends on its own do not count.
   */
  lastInputAtMs: number | null;
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  /** Retained scrollback, byte- and line-bounded. Trimmed from the head. */
  historyState: HistoryBufferState;
  /** Positions of output cursors in `historyState`, for delta opens. */
  historyIndex: TerminalHistoryCursorIndex;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  pendingProcessOutputBytes: number;
  processEventDrainRunning: boolean;
  /**
   * PTY output of the running process held for the current coalescing window, in arrival
   * order; it is not in `pendingProcessEvents` yet and has no cursor.
   */
  heldOutput: Array<string>;
  heldOutputBytes: number;
  /** Clock time output last left the coalescer; a chunk a full window later leaves at once. */
  lastOutputReleaseAtMs: number;
  /** Set by committed input: the next chunk, its echo, leaves at once with anything held. */
  releaseNextOutput: boolean;
  /** Ends the current window. Cleared whenever held output leaves or is dropped. */
  outputReleaseTimer: OutputReleaseTimer | null;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cursor: TerminalCursor;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  /**
   * The foreground process name the PTY reported while the process table showed the shell
   * without children: what the shell goes by when idle. Null until seen, and for each new PTY.
   */
  idleForegroundName: string | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  runtimeEnv: Record<string, string> | null;
  /** History characters appended since the last persist was enqueued. */
  unpersistedHistoryChars: number;
  /** The history file as of the last enqueued persist; null forces a rewrite. */
  persistedHistoryFile: PersistedHistoryFile | null;
}

/**
 * One rewrite of a history file and the appends that extend it. When any of
 * its writes fails, the file's content is unknown: its remaining appends are
 * skipped and the session's next persist rewrites the file.
 */
interface HistoryFileEpoch {
  failed: boolean;
}

interface PersistedHistoryFile {
  readonly epoch: HistoryFileEpoch;
  readonly bytes: number;
  readonly newlines: number;
}

type PersistHistoryRequest =
  | {
      readonly type: "write";
      readonly session: TerminalSessionState;
      readonly epoch: HistoryFileEpoch;
      readonly history: string;
    }
  | {
      readonly type: "append";
      readonly session: TerminalSessionState;
      readonly epoch: HistoryFileEpoch;
      readonly data: string;
    };

/**
 * Coalesces queued persists of one file. Appends always extend the epoch of
 * the write enqueued before them, so they concatenate onto it.
 */
function mergePersistHistoryRequests(
  current: PersistHistoryRequest,
  next: PersistHistoryRequest,
): PersistHistoryRequest {
  if (next.type === "write") return next;
  if (current.type === "write") return { ...current, history: current.history + next.data };
  return { ...current, data: current.data + next.data };
}

interface ScheduledHistoryPersist {
  readonly session: TerminalSessionState;
}

interface OutputReleaseTimer {
  fiber: Fiber.Fiber<void> | null;
}

type PendingProcessEvent =
  | { type: "output"; data: string; byteLength: number }
  | { type: "exit"; event: PtyExitEvent };

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      threadId: string;
      terminalId: string;
      cursor: TerminalCursor;
      persistHistory: boolean;
      data: string;
    }
  | {
      type: "exit";
      process: PtyProcess | null;
      cursor: TerminalCursor;
      threadId: string;
      terminalId: string;
      exitCode: number | null;
      exitSignal: number | null;
    };

interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyProcess, Fiber.Fiber<void, never>>;
}

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    inputEpoch: session.inputEpoch,
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: session.historyState.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    updatedAt: session.updatedAt,
    cursor: session.cursor,
  };
}

/**
 * `terminal.open`'s answer: only the history after `sinceCursor` when the session's history
 * still covers it exactly (same generation, no reset since, not trimmed away), otherwise the
 * full snapshot.
 */
function openSnapshot(
  session: TerminalSessionState,
  sinceCursor: TerminalCursor | undefined,
): TerminalSessionSnapshot {
  const full = snapshot(session);
  if (
    !sinceCursor ||
    sinceCursor.generation !== session.cursor.generation ||
    sinceCursor.sequence > session.cursor.sequence
  ) {
    return full;
  }
  const delta = session.historyIndex.since(sinceCursor.sequence, session.historyState.history);
  return delta === null ? full : { ...full, history: delta, historySince: sinceCursor };
}

/** Replaces the retained history; cursors from before no longer resolve to a delta. */
function replaceHistory(session: TerminalSessionState, state: HistoryBufferState): void {
  session.historyState = state;
  // The file no longer extends to this history; the next persist rewrites it.
  session.unpersistedHistoryChars = 0;
  session.persistedHistoryFile = null;
  session.pendingHistoryControlSequence = "";
  session.historyIndex.reset(session.cursor.sequence + 1, state.history.length);
}

function diagnosticsSnapshot(session: TerminalSessionState): DiagnosticsTerminalProcess {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    hasRunningSubprocess: session.hasRunningSubprocess,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    updatedAt: session.updatedAt,
  };
}

/**
 * Detaches the PTY callbacks. Output still held for the coalescing window moves into the
 * pending queue first, without starting a drain: close drains that queue itself so the accepted
 * tail survives, and stop and restart clear it right after.
 */
function cleanupProcessHandles(
  session: TerminalSessionState,
  limits: PendingProcessEventLimits,
): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
  if (session.pid !== null) releaseHeldOutput(session, session.pid, null, limits);
  cancelOutputReleaseTimer(session);
}

/** Whether the PTY reported its exit and the drain has yet to apply it. */
function hasPendingExit(session: TerminalSessionState): boolean {
  for (
    let index = session.pendingProcessEventIndex;
    index < session.pendingProcessEvents.length;
    index++
  ) {
    if (session.pendingProcessEvents[index]?.type === "exit") return true;
  }
  return false;
}

interface PendingProcessEventLimits {
  readonly maxPendingProcessEvents: number;
  readonly maxPendingProcessOutputBytes: number;
}

/** Empties the pending queue; held output stays (see {@link clearPendingProcessEvents}). */
function resetPendingProcessEventQueue(session: TerminalSessionState): void {
  session.pendingProcessEvents = [];
  session.pendingProcessEventIndex = 0;
  session.pendingProcessOutputBytes = 0;
  session.processEventDrainRunning = false;
}

/** Drops every process event not published yet: the pending queue and held output. */
function clearPendingProcessEvents(session: TerminalSessionState): void {
  resetPendingProcessEventQueue(session);
  dropHeldOutput(session);
}

function cancelOutputReleaseTimer(session: TerminalSessionState): void {
  const timer = session.outputReleaseTimer;
  if (timer === null) return;
  session.outputReleaseTimer = null;
  timer.fiber?.interruptUnsafe();
}

function dropHeldOutput(session: TerminalSessionState): void {
  cancelOutputReleaseTimer(session);
  session.heldOutput = [];
  session.heldOutputBytes = 0;
  session.lastOutputReleaseAtMs = Number.NEGATIVE_INFINITY;
  session.releaseNextOutput = false;
}

/**
 * Moves held output into the pending queue as one output event and ends its window. Returns
 * whether the caller must start a drain, as {@link enqueueProcessEvent} does.
 */
function releaseHeldOutput(
  session: TerminalSessionState,
  expectedPid: number,
  nowMs: number | null,
  limits: PendingProcessEventLimits,
): boolean {
  cancelOutputReleaseTimer(session);
  if (session.heldOutput.length === 0) return false;
  const data =
    session.heldOutput.length === 1 ? session.heldOutput[0]! : session.heldOutput.join("");
  const byteLength = session.heldOutputBytes;
  session.heldOutput = [];
  session.heldOutputBytes = 0;
  if (nowMs !== null) session.lastOutputReleaseAtMs = nowMs;
  return enqueueProcessEvent(session, expectedPid, { type: "output", data, byteLength }, limits);
}

/** Whether output of `expectedPid` may still be accepted: it runs and has not exited. */
function acceptsProcessOutput(session: TerminalSessionState, expectedPid: number): boolean {
  return (
    session.process !== null &&
    session.status === "running" &&
    session.pid === expectedPid &&
    !session.pendingProcessEvents.some((pendingEvent) => pendingEvent.type === "exit")
  );
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
  limits: PendingProcessEventLimits,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  if (event.type === "output" && !acceptsProcessOutput(session, expectedPid)) {
    return false;
  }

  compactPendingProcessEvents(session);
  session.pendingProcessEvents.push(event);
  if (event.type === "output") {
    session.pendingProcessOutputBytes += event.byteLength;
  }
  enforcePendingProcessEventLimits(session, limits);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}

function compactPendingProcessEvents(session: TerminalSessionState): void {
  if (session.pendingProcessEventIndex <= 0) {
    return;
  }

  session.pendingProcessEvents = session.pendingProcessEvents.slice(
    session.pendingProcessEventIndex,
  );
  session.pendingProcessEventIndex = 0;
}

function coalesceOldestPendingOutputPair(session: TerminalSessionState): boolean {
  for (let index = 0; index < session.pendingProcessEvents.length - 1; index += 1) {
    const current = session.pendingProcessEvents[index];
    const next = session.pendingProcessEvents[index + 1];
    if (current?.type !== "output" || next?.type !== "output") {
      continue;
    }

    session.pendingProcessEvents.splice(index, 2, {
      type: "output",
      data: `${current.data}${next.data}`,
      byteLength: current.byteLength + next.byteLength,
    });
    return true;
  }
  return false;
}

function trimOutputDataToApproxBytes(
  data: string,
  maxBytes: number,
): { data: string; byteLength: number } {
  if (maxBytes <= 0 || data.length === 0) {
    return { data: "", byteLength: 0 };
  }

  let nextData = data;
  let byteLength = approximateTextBytes(nextData);
  while (byteLength > maxBytes && nextData.length > 0) {
    const excessBytes = byteLength - maxBytes;
    const sliceStart = Math.min(nextData.length, Math.max(1, excessBytes));
    nextData = nextData.slice(sliceStart);
    byteLength = approximateTextBytes(nextData);
  }
  return { data: nextData, byteLength };
}

function trimPendingOutputBytesToLimit(
  session: TerminalSessionState,
  maxPendingProcessOutputBytes: number,
): void {
  if (session.pendingProcessOutputBytes <= maxPendingProcessOutputBytes) {
    return;
  }

  for (let index = 0; index < session.pendingProcessEvents.length; index += 1) {
    if (session.pendingProcessOutputBytes <= maxPendingProcessOutputBytes) {
      return;
    }

    const event = session.pendingProcessEvents[index];
    if (event?.type !== "output") {
      continue;
    }

    const targetEventBytes = Math.max(
      0,
      event.byteLength - (session.pendingProcessOutputBytes - maxPendingProcessOutputBytes),
    );
    if (targetEventBytes <= 0) {
      session.pendingProcessEvents.splice(index, 1);
      session.pendingProcessOutputBytes = Math.max(
        0,
        session.pendingProcessOutputBytes - event.byteLength,
      );
      index -= 1;
      continue;
    }

    const trimmed = trimOutputDataToApproxBytes(event.data, targetEventBytes);
    session.pendingProcessEvents[index] = {
      type: "output",
      data: trimmed.data,
      byteLength: trimmed.byteLength,
    };
    session.pendingProcessOutputBytes = Math.max(
      0,
      session.pendingProcessOutputBytes - (event.byteLength - trimmed.byteLength),
    );
  }
}

function enforcePendingProcessEventLimits(
  session: TerminalSessionState,
  limits: PendingProcessEventLimits,
): void {
  while (
    session.pendingProcessEvents.length > limits.maxPendingProcessEvents &&
    coalesceOldestPendingOutputPair(session)
  ) {
    // Keep event count bounded without losing bytes when adjacent output can be merged.
  }
  trimPendingOutputBytesToLimit(session, limits.maxPendingProcessOutputBytes);
}

function isRetryableShellSpawnError(error: PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause) {
        queue.push(current.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

function parsePosixProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s|$)/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  return { childrenByParent };
}

function parseWindowsProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/g)) {
    const [pidRaw, parentPidRaw] = line.trim().split("|", 2);
    const pid = Number(pidRaw);
    const parentPid = Number(parentPidRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  return { childrenByParent };
}

const POSIX_PS_ABSOLUTE_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

const resolvePosixPsCommand = Effect.fn("terminal.resolvePosixPsCommand")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of POSIX_PS_ABSOLUTE_PATHS) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return "ps";
});

const snapshotPosixProcessTable = Effect.fn("terminal.snapshotPosixProcessTable")(function* (
  psCommand: string,
): Effect.fn.Return<TerminalProcessTableSnapshot, TerminalSubprocessCheckError> {
  const result = yield* Effect.tryPromise({
    try: () =>
      runProcess(psCommand, ["-eo", "pid=,ppid="], {
        timeoutMs: 1_000,
        allowNonZeroExit: true,
        maxBufferBytes: 524_288,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new TerminalSubprocessCheckError({
        message: "Failed to snapshot POSIX processes.",
        cause,
        command: "ps",
      }),
  });

  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    return yield* new TerminalSubprocessCheckError({
      message: "POSIX process snapshot was incomplete.",
      command: "ps",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  const table = parsePosixProcessTable(result.stdout);
  // A real table lists at least `ps` itself; an empty one would read every shell as idle.
  if (table.childrenByParent.size === 0) {
    return yield* new TerminalSubprocessCheckError({
      message: "POSIX process snapshot listed no processes.",
      command: "ps",
    });
  }
  return table;
});

const snapshotWindowsProcessTable = Effect.fn("terminal.snapshotWindowsProcessTable")(
  function* (): Effect.fn.Return<TerminalProcessTableSnapshot, TerminalSubprocessCheckError> {
    const command = [
      "$processes = Get-CimInstance Win32_Process -ErrorAction Stop",
      'foreach ($process in $processes) { Write-Output "$($process.ProcessId)|$($process.ParentProcessId)" }',
    ].join("; ");
    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
          timeoutMs: 1_500,
          allowNonZeroExit: true,
          maxBufferBytes: 524_288,
          outputMode: "truncate",
        }),
      catch: (cause) =>
        new TerminalSubprocessCheckError({
          message: "Failed to snapshot Windows processes.",
          cause,
          command: "powershell",
        }),
    });

    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
      return yield* new TerminalSubprocessCheckError({
        message: "Windows process snapshot was incomplete.",
        command: "powershell",
        exitCode: result.code,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
      });
    }
    const table = parseWindowsProcessTable(result.stdout);
    // A real table lists at least PowerShell itself; an empty one would read every shell as idle.
    if (table.childrenByParent.size === 0) {
      return yield* new TerminalSubprocessCheckError({
        message: "Windows process snapshot listed no processes.",
        command: "powershell",
      });
    }
    return table;
  },
);

/**
 * Reads the running shells' direct children from procfs
 * (`/proc/<pid>/task/<tid>/children`, Linux 3.5+ with CONFIG_PROC_CHILDREN):
 * the same answer as a process table, without spawning `ps` or enumerating
 * every process on the host.
 */
export const makeProcfsProcessTableSnapshotter =
  (fileSystem: FileSystem.FileSystem, procRoot = "/proc"): TerminalProcessTableSnapshotter =>
  (shellPids) => {
    // A shell or thread that exited between listing and reading has no children.
    const orWhenGone = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>, fallback: A) =>
      effect.pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(fallback),
        ),
      );
    const readChildren = (pid: number) =>
      Effect.gen(function* () {
        const taskDir = path.join(procRoot, String(pid), "task");
        const tasks = yield* orWhenGone(fileSystem.readDirectory(taskDir), []);
        const children: number[] = [];
        for (const task of tasks) {
          const text = yield* orWhenGone(
            fileSystem.readFileString(path.join(taskDir, task, "children")),
            "",
          );
          for (const token of text.split(/\s+/)) {
            const child = Number(token);
            if (token.length > 0 && Number.isInteger(child)) children.push(child);
          }
        }
        return [pid, children] as const;
      });
    return Effect.forEach(shellPids, readChildren, { concurrency: "unbounded" }).pipe(
      Effect.map((entries) => ({
        childrenByParent: new Map(entries.filter(([, children]) => children.length > 0)),
      })),
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            message: "Failed to read terminal subprocesses from procfs.",
            cause,
            command: "procfs",
          }),
      ),
    );
  };

const procfsChildrenAvailable = (fileSystem: FileSystem.FileSystem) =>
  fileSystem
    .exists(`/proc/${process.pid}/task/${process.pid}/children`)
    .pipe(Effect.orElseSucceed(() => false));

/** Uses `primary` until it fails once, then `fallback` for good. */
function withSnapshotterFallback(
  primary: TerminalProcessTableSnapshotter,
  fallback: TerminalProcessTableSnapshotter,
): TerminalProcessTableSnapshotter {
  let current = primary;
  return (shellPids) =>
    current === fallback
      ? fallback(shellPids)
      : primary(shellPids).pipe(
          Effect.catch((reason) =>
            Effect.logWarning("terminal subprocess polling falls back to the process table", {
              reason,
            }).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  current = fallback;
                  return fallback(shellPids);
                }),
              ),
            ),
          ),
        );
}

interface SubprocessReading {
  readonly session: TerminalSessionState;
  readonly terminalPid: number;
  readonly hasRunningSubprocess: boolean;
  /** Set when the process table found the shell idle: the name it went by. */
  readonly idleForegroundName: string | undefined;
}

/**
 * The PTY's foreground process name, or undefined when it cannot say. A throwing adapter
 * reads as one that cannot say: polling must outlive any single session's PTY.
 */
function readForegroundName(session: TerminalSessionState): string | undefined {
  try {
    return session.process?.foregroundProcessName?.();
  } catch {
    return undefined;
  }
}

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

// The rules below follow the parser of xterm.js, the terminal every Ryco client replays history
// into. Its parser reads decoded code points, so U+0080-U+009F are C1 controls there.

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

// CAN and SUB cancel an unfinished sequence.
function isControlSequenceCancel(codePoint: number): boolean {
  return codePoint === 0x18 || codePoint === 0x1a;
}

// C0 controls run even in the middle of an escape or control sequence, as they would in plain
// text, so they never join the sequence's parameters.
function isExecutedControl(codePoint: number): boolean {
  return codePoint < 0x20 && codePoint !== 0x1b && !isControlSequenceCancel(codePoint);
}

// ESC and C1 controls abandon an unfinished escape or control sequence: the abandoned part has
// no effect and parsing starts again at them.
function abandonsSequence(codePoint: number): boolean {
  return codePoint === 0x1b || (codePoint >= 0x80 && codePoint <= 0x9f);
}

function executedControlsIn(value: string): string {
  // oxlint-disable-next-line no-control-regex -- keeps exactly the controls that run
  return value.replace(/[^\u0000-\u0017\u0019\u001c-\u001f]/g, "");
}

// Parameters may use ":" as well as ";" as a separator.
function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9:;?]*$/.test(body)) {
    return true;
  }
  // Primary (c, ?c), secondary (>c) and tertiary (=c) Device Attributes.
  if (finalByte === "c" && /^[>=0-9:;?]*$/.test(body)) {
    return true;
  }
  // DECRQM mode queries (…$p) and DECRPM replies (…$y): replaying a stored
  // query makes the terminal answer again, and the shell echoes the answer as
  // junk at the prompt. The `$` guard keeps setters like DECSTR (!p) and
  // DECSCL ("p) intact.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9:;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9:;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ($r / +r):
// pure request/response traffic with no visual value, and replaying a stored
// query triggers a fresh reply. The terminal answers DECRQSS whatever its
// parameters, and ignores controls and DEL in the header (everything up to the
// final byte).
function shouldStripDcsSequence(content: string): boolean {
  let header = "";
  for (let index = 0; index < content.length; index += 1) {
    const codePoint = content.charCodeAt(index);
    if (codePoint < 0x20 || codePoint === 0x7f) continue;
    header += content[index];
    if (codePoint >= 0x40) break;
  }
  return /^[0-9:;]*[$+][qr]$/.test(header);
}

// OSC 10/11/12 color queries and replies. Controls in OSC data are ignored; DEL is data.
function shouldStripOscSequence(content: string): boolean {
  let data = "";
  for (let index = 0; index < content.length && data.length < 7; index += 1) {
    if (content.charCodeAt(index) >= 0x20) {
      data += content[index];
    }
  }
  return /^(10|11|12);(?:\?|rgb:)/.test(data);
}

interface StringSequenceEnd {
  /** Past the terminator, or at the ESC or C1 control that ended the string without one. */
  readonly end: number;
  /**
   * What a kept string needs appended to end on replay as it did live, since the ESC or C1
   * control that ended it starts the next sequence, which may be stripped. An ESC that does
   * not start ST makes the terminal dispatch the string, as ST does; a C1 control makes it
   * drop the string, as CAN does.
   */
  readonly closing: "" | "\u001b\\" | "\u0018";
}

// ST (ESC \ or 0x9C) ends every string sequence; BEL ends only OSC and is payload inside DCS,
// PM and APC. CAN and SUB cancel the string. Any other ESC or C1 control ends it too and starts
// the next sequence. Null means the input ends first.
function findStringSequenceEnd(
  input: string,
  start: number,
  isOsc: boolean,
): StringSequenceEnd | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x9c || (isOsc && codePoint === 0x07) || isControlSequenceCancel(codePoint)) {
      return { end: index + 1, closing: "" };
    }
    if (codePoint === 0x1b) {
      if (index + 1 >= input.length) return null;
      return input.charCodeAt(index + 1) === 0x5c
        ? { end: index + 2, closing: "" }
        : { end: index, closing: "\u001b\\" };
    }
    if (abandonsSequence(codePoint)) {
      return { end: index, closing: "\u0018" };
    }
  }
  return null;
}

interface ControlSequenceScan {
  /** Past the final byte, CAN/SUB or rejected code point; at an abandoning ESC or C1 control. */
  readonly end: number;
  /** dropped: an ESC or C1 control abandoned it, or the parser rejected a code point in it. */
  readonly outcome: "dispatched" | "cancelled" | "dropped";
  /** Parameters and intermediates, without the controls the terminal ran on the way. */
  readonly body: string;
  readonly executedControls: string;
}

// Scans a CSI from its first parameter byte. Null means the input ends first.
function scanControlSequence(input: string, start: number): ControlSequenceScan | null {
  let executedControls = "";
  let sawControlOrDelete = false;
  // A parameter after an intermediate, or a private marker after a parameter, makes the parser
  // ignore the rest of the sequence up to its final byte, non-ASCII included. Otherwise it
  // rejects a non-ASCII code point, dropping it with the sequence.
  let sawParameter = false;
  let sawIntermediate = false;
  let ignoring = false;
  for (let cursor = start; cursor < input.length; cursor += 1) {
    const codePoint = input.charCodeAt(cursor);
    let outcome: ControlSequenceScan["outcome"] | null = null;
    let end = cursor + 1;
    if (isCsiFinalByte(codePoint)) {
      outcome = "dispatched";
    } else if (isControlSequenceCancel(codePoint)) {
      outcome = "cancelled";
    } else if (abandonsSequence(codePoint)) {
      outcome = "dropped";
      end = cursor;
    } else if (codePoint >= 0xa0 && !ignoring) {
      outcome = "dropped";
      // A high surrogate: the rejected code point takes two code units.
      if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
        if (end >= input.length) return null;
        end += 1;
      }
    }
    if (outcome !== null) {
      const body = input.slice(start, cursor);
      return {
        end,
        outcome,
        // oxlint-disable-next-line no-control-regex -- drops the controls the terminal skipped
        body: sawControlOrDelete ? body.replace(/[\u0000-\u001f\u007f]/g, "") : body,
        executedControls,
      };
    }
    if (isExecutedControl(codePoint) || codePoint === 0x7f) {
      sawControlOrDelete = true;
      if (codePoint !== 0x7f) executedControls += input[cursor];
    } else if (codePoint <= 0x2f) {
      sawIntermediate = true;
    } else if (codePoint <= 0x3f) {
      if (sawIntermediate || (codePoint >= 0x3c && sawParameter)) ignoring = true;
      sawParameter = true;
    }
  }
  return null;
}

// ESC, or an 8-bit CSI, OSC, DCS, PM or APC introducer: each of those stands for ESC and its
// code point minus 0x40.
// oxlint-disable-next-line no-control-regex -- every sequence starts with ESC or a C1 control
const SEQUENCE_START = /[\u001b\u0090\u009b\u009d-\u009f]/g;

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  while (index < input.length) {
    // One slice per run of text: every chunk of coloured output passes through here.
    SEQUENCE_START.lastIndex = index;
    const sequenceStart = SEQUENCE_START.exec(input)?.index ?? input.length;
    visibleText += input.slice(index, sequenceStart);
    index = sequenceStart;
    if (index >= input.length) break;

    const codePoint = input.charCodeAt(index);
    let introducerIndex = index;
    if (codePoint === 0x1b) {
      // Controls between ESC and the byte that names the sequence run as they arrive.
      introducerIndex += 1;
      while (introducerIndex < input.length) {
        const introducerCodePoint = input.charCodeAt(introducerIndex);
        if (!isExecutedControl(introducerCodePoint) && introducerCodePoint !== 0x7f) break;
        introducerIndex += 1;
      }
      if (introducerIndex >= input.length) break;
    }
    const introducer = codePoint === 0x1b ? input.charCodeAt(introducerIndex) : codePoint - 0x40;
    // A stripped or abandoned sequence leaves only the controls the terminal ran inside it.
    let output =
      introducerIndex > index + 1
        ? executedControlsIn(input.slice(index + 1, introducerIndex))
        : "";
    let end: number | null = null;

    if (abandonsSequence(introducer)) {
      end = introducerIndex;
    } else if (introducer === 0x5b) {
      const scan = scanControlSequence(input, introducerIndex + 1);
      if (scan !== null) {
        end = scan.end;
        const keep =
          scan.outcome === "cancelled" ||
          (scan.outcome === "dispatched" &&
            !shouldStripCsiSequence(scan.body, input.charAt(end - 1)));
        output = keep ? input.slice(index, end) : output + scan.executedControls;
      }
    } else if (
      // OSC, DCS, PM, APC.
      introducer === 0x5d ||
      introducer === 0x50 ||
      introducer === 0x5e ||
      introducer === 0x5f
    ) {
      const stringEnd = findStringSequenceEnd(input, introducerIndex + 1, introducer === 0x5d);
      if (stringEnd !== null) {
        end = stringEnd.end;
        // Both checks read only the start of the string, before any terminator.
        const content = input.slice(introducerIndex + 1, end);
        const strip =
          (introducer === 0x5d && shouldStripOscSequence(content)) ||
          (introducer === 0x50 && shouldStripDcsSequence(content));
        if (!strip) output = input.slice(index, end) + stringEnd.closing;
      }
    } else if (introducer === 0x5a) {
      // ESC Z (DECID) is the legacy primary Device Attributes query.
      end = introducerIndex + 1;
    } else {
      // A plain escape: intermediates (0x20-0x2F, with controls that run and DEL) and a final
      // byte (0x30-0x7E). CAN and SUB cancel it; a byte the parser rejects ends it unconsumed.
      let cursor = introducerIndex;
      while (cursor < input.length) {
        const cursorCodePoint = input.charCodeAt(cursor);
        if (
          (cursorCodePoint < 0x20 || cursorCodePoint > 0x2f) &&
          !isExecutedControl(cursorCodePoint) &&
          cursorCodePoint !== 0x7f
        )
          break;
        cursor += 1;
      }
      if (cursor < input.length) {
        const finalCodePoint = input.charCodeAt(cursor);
        if (abandonsSequence(finalCodePoint)) {
          end = cursor;
          output += executedControlsIn(input.slice(introducerIndex, end));
        } else {
          end =
            (finalCodePoint >= 0x30 && finalCodePoint <= 0x7e) ||
            isControlSequenceCancel(finalCodePoint)
              ? cursor + 1
              : cursor;
          output = input.slice(index, end);
        }
      }
    }

    // The input ends before the sequence does: keep it pending for the next chunk.
    if (end === null) break;
    visibleText += output;
    index = end;
  }

  return { visibleText, pendingControlSequence: input.slice(index) };
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Base64Url.encode(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Base64Url.encode(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  /** Scrollback byte ceiling per session; trimmed from the head on rollover. */
  maxHistoryBytes?: number;
  ptyAdapter: PtyAdapterShape;
  shellResolver?: () => string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  processTableSnapshotter?: TerminalProcessTableSnapshotter;
  subprocessPollIntervalMs?: number;
  /** Process-table cadence while no terminal has recent input; see the default's note. */
  subprocessIdlePollIntervalMs?: number;
  /** Trailing window for persisting output history; see the default's note. */
  historyPersistDebounceMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  maxPendingProcessEvents?: number;
  maxPendingProcessOutputBytes?: number;
  /**
   * Coalescing window for PTY output, in ms; defaults to
   * {@link DEFAULT_TERMINAL_OUTPUT_COALESCE_MS}. `0` publishes one event per PTY read.
   */
  outputCoalesceMs?: number;
  workspaceAccessPolicy?: WorkspaceAccessPolicyShape;
}

const makeTerminalManager = Effect.fn("makeTerminalManager")(function* () {
  const { terminalLogsDir } = yield* ServerConfig;
  const ptyAdapter = yield* PtyAdapter;
  const workspaceAccessPolicy = yield* WorkspaceAccessPolicy;
  return yield* makeTerminalManagerWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    workspaceAccessPolicy,
  });
});

export const makeTerminalManagerWithOptions = Effect.fn("makeTerminalManagerWithOptions")(
  function* (options: TerminalManagerOptions) {
    const fileSystem = yield* FileSystem.FileSystem;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);

    const storageSql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const logsDir = options.logsDir;
    const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    const maxHistoryBytes = Math.max(1, options.maxHistoryBytes ?? DEFAULT_HISTORY_MAX_BYTES);
    const historyLimits: HistoryBufferLimits = {
      maxBytes: maxHistoryBytes,
      maxLines: historyLineLimit,
    };
    const platform = options.platform ?? process.platform;
    const baseEnv = options.env ?? process.env;
    const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
    const posixPsCommand =
      options.processTableSnapshotter === undefined && platform !== "win32"
        ? yield* resolvePosixPsCommand()
        : null;
    const snapshotPosixTable: TerminalProcessTableSnapshotter = () =>
      snapshotPosixProcessTable(posixPsCommand ?? "ps");
    const processTableSnapshotter: TerminalProcessTableSnapshotter =
      options.processTableSnapshotter ??
      (platform === "win32"
        ? () => snapshotWindowsProcessTable()
        : platform === "linux" && (yield* procfsChildrenAvailable(fileSystem))
          ? withSnapshotterFallback(
              makeProcfsProcessTableSnapshotter(fileSystem),
              snapshotPosixTable,
            )
          : snapshotPosixTable);
    const subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
    const subprocessIdlePollTicks = Math.max(
      1,
      Math.round(
        (options.subprocessIdlePollIntervalMs ?? DEFAULT_SUBPROCESS_IDLE_POLL_INTERVAL_MS) /
          Math.max(1, subprocessPollIntervalMs),
      ),
    );
    const subprocessDeepIdleAfterTicks = Math.max(
      subprocessIdlePollTicks,
      Math.ceil(DEFAULT_SUBPROCESS_DEEP_IDLE_AFTER_MS / Math.max(1, subprocessPollIntervalMs)),
    );
    const subprocessDeepIdlePollTicks = Math.max(
      subprocessIdlePollTicks,
      Math.round(
        DEFAULT_SUBPROCESS_DEEP_IDLE_POLL_INTERVAL_MS / Math.max(1, subprocessPollIntervalMs),
      ),
    );
    const subprocessOutputQuietMs = Math.min(
      DEFAULT_SUBPROCESS_OUTPUT_QUIET_MS,
      subprocessPollIntervalMs / 4,
    );
    const historyPersistDebounceMs = Math.max(
      0,
      options.historyPersistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS,
    );
    const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    const maxRetainedInactiveSessions =
      options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
    const maxPendingProcessEvents = Math.max(
      1,
      options.maxPendingProcessEvents ?? DEFAULT_MAX_PENDING_PROCESS_EVENTS,
    );
    const maxPendingProcessOutputBytes = Math.max(
      1,
      options.maxPendingProcessOutputBytes ?? DEFAULT_MAX_PENDING_PROCESS_OUTPUT_BYTES,
    );
    const pendingProcessEventLimits: PendingProcessEventLimits = {
      maxPendingProcessEvents,
      maxPendingProcessOutputBytes,
    };
    const outputCoalesceMs = Math.max(
      0,
      options.outputCoalesceMs ?? DEFAULT_TERMINAL_OUTPUT_COALESCE_MS,
    );
    // PTY callbacks are plain JS; they read the manager's clock directly (a TestClock in tests).
    const clock = yield* Clock.Clock;

    yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

    const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
      sessions: new Map(),
      killFibers: new Map(),
    });
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const initialRunningSessionSignal = yield* Deferred.make<void>();
    const runningSessionSignalRef = yield* Ref.make(initialRunningSessionSignal);
    const generation = randomUUID();
    let sequence = 0;
    const nextCursor = (): TerminalCursor => ({ generation, sequence: ++sequence });
    const advanceCursor = (session: TerminalSessionState): TerminalCursor => {
      session.cursor = nextCursor();
      return session.cursor;
    };
    /**
     * Bumped by PTY starts, input and subprocess activity changes, the moments
     * a subprocess is likely to start or stop; drives the fast poll cadence.
     */
    let terminalIoRevision = 0;
    const noteTerminalIo = () => {
      terminalIoRevision += 1;
    };
    /** Bumped by output, which only arms one check once it goes quiet. */
    let terminalOutputRevision = 0;
    let lastTerminalOutputAtMs = 0;
    const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
    const workerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

    const publishEvent = (event: TerminalEvent) =>
      Effect.gen(function* () {
        recordServerPerf("server.terminal.events");
        if (event.type === "output" && isServerPerfProfileEnabled()) {
          recordServerPerf("server.terminal.output", {
            bytes: approximateTextBytes(event.data),
          });
        }
        for (const listener of terminalEventListeners) {
          yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
        }
      });

    const historyPath = (threadId: string, terminalId: string) => {
      const threadPart = toSafeThreadId(threadId);
      if (terminalId === DEFAULT_TERMINAL_ID) {
        return path.join(logsDir, `${threadPart}.log`);
      }
      return path.join(logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
    };

    const legacyHistoryPath = (threadId: string) =>
      path.join(logsDir, `${legacySafeThreadId(threadId)}.log`);

    const toTerminalHistoryError =
      (operation: "read" | "truncate" | "migrate", threadId: string, terminalId: string) =>
      (cause: unknown) =>
        new TerminalHistoryError({
          operation,
          threadId,
          terminalId,
          cause,
        });

    const readManagerState = SynchronizedRef.get(managerStateRef);

    const modifyManagerState = <A>(
      f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
    ) => SynchronizedRef.modify(managerStateRef, f);

    const hasRunningSessions = readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].some((session) => session.status === "running"),
      ),
    );

    const signalRunningSession = Effect.gen(function* () {
      const nextSignal = yield* Deferred.make<void>();
      const currentSignal = yield* Ref.getAndSet(runningSessionSignalRef, nextSignal);
      yield* Deferred.succeed(currentSignal, undefined).pipe(Effect.ignore);
    });

    const waitForRunningSession = Effect.gen(function* () {
      while (!(yield* hasRunningSessions)) {
        const signal = yield* Ref.get(runningSessionSignalRef);
        if (yield* hasRunningSessions) {
          return;
        }
        yield* Deferred.await(signal);
      }
    });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(
      threadId: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
      process: PtyProcess | null,
    ) {
      if (!process) return;
      const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
        Option.Option<Fiber.Fiber<void, never>>
      >((state) => {
        const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
          state.killFibers.get(process),
        );
        if (Option.isNone(existing)) {
          return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
        }
        const killFibers = new Map(state.killFibers);
        killFibers.delete(process);
        return [existing, { ...state, killFibers }] as const;
      });
      if (Option.isSome(fiber)) {
        yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
      }
    });

    const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
      process: PtyProcess,
      fiber: Fiber.Fiber<void, never>,
    ) {
      yield* modifyManagerState((state) => {
        const killFibers = new Map(state.killFibers);
        killFibers.set(process, fiber);
        return [undefined, { ...state, killFibers }] as const;
      });
    });

    const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
      process: PtyProcess,
      threadId: string,
      terminalId: string,
    ) {
      const terminated = yield* Effect.try({
        try: () => process.kill("SIGTERM"),
        catch: (cause) =>
          new TerminalProcessSignalError({
            message: "Failed to send SIGTERM to terminal process.",
            cause,
            signal: "SIGTERM",
          }),
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("failed to kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGTERM",
            error: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!terminated) {
        return;
      }

      yield* Effect.sleep(processKillGraceMs);

      yield* Effect.try({
        try: () => process.kill("SIGKILL"),
        catch: (cause) =>
          new TerminalProcessSignalError({
            message: "Failed to send SIGKILL to terminal process.",
            cause,
            signal: "SIGKILL",
          }),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to force-kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGKILL",
            error: error.message,
          }),
        ),
      );
    });

    const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
      process: PtyProcess,
      threadId: string,
      terminalId: string,
    ) {
      const fiber = yield* runKillEscalation(process, threadId, terminalId).pipe(
        Effect.ensuring(
          modifyManagerState((state) => {
            if (!state.killFibers.has(process)) {
              return [undefined, state] as const;
            }
            const killFibers = new Map(state.killFibers);
            killFibers.delete(process);
            return [undefined, { ...state, killFibers }] as const;
          }),
        ),
        Effect.forkIn(workerScope),
      );

      yield* registerKillFiber(process, fiber);
    });

    const persistWorker = yield* makeKeyedCoalescingWorker<
      string,
      PersistHistoryRequest,
      never,
      never
    >({
      policy: latestStateQueuePolicy({
        component: "TerminalManager.persistHistory",
        capacity: 256,
      }),
      merge: mergePersistHistoryRequests,
      process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
        const [threadId, terminalId] = sessionKey.split("\u0000");
        if (!threadId || !terminalId) {
          return;
        }
        // An earlier write of this epoch failed: appending would leave a gap.
        if (request.epoch.failed) return;

        const filePath = historyPath(threadId, terminalId);
        yield* (
          request.type === "write"
            ? fileSystem.writeFileString(filePath, request.history)
            : fileSystem.writeFileString(filePath, request.data, { flag: "a" })
        ).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              request.epoch.failed = true;
              if (request.session.persistedHistoryFile?.epoch === request.epoch) {
                request.session.persistedHistoryFile = null;
              }
            }).pipe(
              Effect.andThen(
                Effect.logWarning("failed to persist terminal history", {
                  threadId,
                  terminalId,
                  error,
                }),
              ),
            ),
          ),
        );
      }),
    });

    const historyFileCompactionBytes = maxHistoryBytes * HISTORY_FILE_COMPACTION_FACTOR;
    const historyFileCompactionLines = historyLineLimit * HISTORY_FILE_COMPACTION_FACTOR;

    /** A rewrite of the file with the session's retained history. */
    const historyRewriteRequest = (session: TerminalSessionState): PersistHistoryRequest => {
      const history = session.historyState.history;
      const epoch: HistoryFileEpoch = { failed: false };
      session.unpersistedHistoryChars = 0;
      session.persistedHistoryFile = {
        epoch,
        bytes: session.historyState.approxBytes,
        newlines: session.historyState.newlineCount,
      };
      return { type: "write", session, epoch, history };
    };

    /**
     * The write that brings the file up to the session's history: the output
     * appended since the last persist, or a rewrite when the file's content is
     * unknown, the appended text is no longer retained whole, or the file
     * reached its compaction bound.
     */
    const historyPersistRequest = (session: TerminalSessionState): PersistHistoryRequest | null => {
      const file = session.persistedHistoryFile;
      const history = session.historyState.history;
      const appendedChars = session.unpersistedHistoryChars;
      if (file === null || file.epoch.failed || appendedChars > history.length) {
        return historyRewriteRequest(session);
      }
      if (appendedChars === 0) return null;
      const data = history.slice(history.length - appendedChars);
      const bytes = file.bytes + utf8ByteLength(data);
      const newlines = file.newlines + countNewlines(data);
      if (bytes > historyFileCompactionBytes || newlines > historyFileCompactionLines) {
        return historyRewriteRequest(session);
      }
      session.unpersistedHistoryChars = 0;
      session.persistedHistoryFile = { epoch: file.epoch, bytes, newlines };
      return { type: "append", session, epoch: file.epoch, data };
    };

    const enqueueHistoryPersist = (sessionKey: string, session: TerminalSessionState) =>
      Effect.suspend(() => {
        const request = historyPersistRequest(session);
        return request === null ? Effect.void : persistWorker.enqueue(sessionKey, request);
      });

    // The worker writes immediately; output batching happens here. One pending
    // window per session appends what the session retained meanwhile when it
    // ends, so the steady state is one append per window rather than one per
    // chunk, and no window rewrites the whole history.
    const scheduledPersists = new Map<string, ScheduledHistoryPersist>();

    const queuePersist = Effect.fn("terminal.queuePersist")(function* (
      session: TerminalSessionState,
    ) {
      const sessionKey = toSessionKey(session.threadId, session.terminalId);
      if (scheduledPersists.has(sessionKey)) return;
      const scheduled: ScheduledHistoryPersist = { session };
      scheduledPersists.set(sessionKey, scheduled);
      yield* Effect.sleep(historyPersistDebounceMs).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            // Superseded by an immediate write (clear, restart, close, exit).
            if (scheduledPersists.get(sessionKey) !== scheduled) return Effect.void;
            scheduledPersists.delete(sessionKey);
            return enqueueHistoryPersist(sessionKey, scheduled.session);
          }),
        ),
        Effect.forkIn(workerScope),
      );
    });

    /** Starts any pending output write now, without waiting for it. */
    const flushScheduledPersist = (sessionKey: string) =>
      Effect.suspend(() => {
        const scheduled = scheduledPersists.get(sessionKey);
        if (!scheduled) return Effect.void;
        scheduledPersists.delete(sessionKey);
        return enqueueHistoryPersist(sessionKey, scheduled.session);
      });

    const flushPersist = Effect.fn("terminal.flushPersist")(function* (
      threadId: string,
      terminalId: string,
    ) {
      const sessionKey = toSessionKey(threadId, terminalId);
      yield* flushScheduledPersist(sessionKey);
      yield* persistWorker.drainKey(sessionKey);
    });

    /** Rewrites the session's history file now and waits for the write. */
    const persistHistory = Effect.fn("terminal.persistHistory")(function* (
      session: TerminalSessionState,
    ) {
      const sessionKey = toSessionKey(session.threadId, session.terminalId);
      scheduledPersists.delete(sessionKey);
      yield* persistWorker.enqueue(sessionKey, historyRewriteRequest(session));
      yield* persistWorker.drainKey(sessionKey);
    });

    // Runs before the persist worker is torn down: a pending window must not
    // lose the last second of output when the server stops.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const sessionKeys = [...scheduledPersists.keys()];
        yield* Effect.forEach(sessionKeys, flushScheduledPersist, { discard: true });
        yield* Effect.forEach(sessionKeys, (sessionKey) => persistWorker.drainKey(sessionKey), {
          discard: true,
        });
      }).pipe(Effect.timeoutOption(5_000), Effect.ignoreCause({ log: true })),
    );

    const readHistory = Effect.fn("terminal.readHistory")(function* (
      threadId: string,
      terminalId: string,
    ) {
      const nextPath = historyPath(threadId, terminalId);
      // One read instead of exists + read. An over-limit file is capped in
      // memory only; the session's next persist rewrites it at the cap.
      const stored = yield* fileSystem.readFileString(nextPath).pipe(
        Effect.map(Option.some),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(Option.none<string>()),
        ),
        Effect.mapError(toTerminalHistoryError("read", threadId, terminalId)),
      );
      if (Option.isSome(stored)) {
        return capHistory(stored.value, historyLineLimit);
      }

      if (terminalId !== DEFAULT_TERMINAL_ID) {
        return "";
      }

      const legacyPath = legacyHistoryPath(threadId);
      if (
        !(yield* fileSystem
          .exists(legacyPath)
          .pipe(Effect.mapError(toTerminalHistoryError("migrate", threadId, terminalId))))
      ) {
        return "";
      }

      const raw = yield* fileSystem
        .readFileString(legacyPath)
        .pipe(Effect.mapError(toTerminalHistoryError("migrate", threadId, terminalId)));
      const capped = capHistory(raw, historyLineLimit);
      yield* fileSystem
        .writeFileString(nextPath, capped)
        .pipe(Effect.mapError(toTerminalHistoryError("migrate", threadId, terminalId)));
      yield* fileSystem.remove(legacyPath, { force: true }).pipe(
        Effect.catch((cleanupError) =>
          Effect.logWarning("failed to remove legacy terminal history", {
            threadId,
            error: cleanupError,
          }),
        ),
      );
      return capped;
    });

    const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
      threadId: string,
      terminalId: string,
    ) {
      yield* fileSystem.remove(historyPath(threadId, terminalId), { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to delete terminal history", {
            threadId,
            terminalId,
            error,
          }),
        ),
      );
      if (terminalId === DEFAULT_TERMINAL_ID) {
        yield* fileSystem.remove(legacyHistoryPath(threadId), { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        );
      }
    });

    const deleteAllHistoryForThread = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
      threadId: string,
    ) {
      const threadPrefix = `${toSafeThreadId(threadId)}_`;
      const entries = yield* fileSystem
        .readDirectory(logsDir, { recursive: false })
        .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
      yield* Effect.forEach(
        entries.filter(
          (name) =>
            name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix),
        ),
        (name) =>
          fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to delete terminal histories for thread", {
                threadId,
                error,
              }),
            ),
          ),
        { discard: true },
      );
    });

    const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
      const authorizedCwd = options.workspaceAccessPolicy
        ? yield* options.workspaceAccessPolicy
            .assertExistingPath({
              path: cwd,
              operation: "terminal cwd",
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TerminalCwdError({
                    cwd,
                    reason: "outsideWorkspace",
                    cause,
                  }),
              ),
            )
        : cwd;
      if (Option.isSome(storageSql)) {
        const canonical = yield* Effect.tryPromise(() => canonicalStoragePath(authorizedCwd)).pipe(
          Effect.mapError((cause) => new TerminalCwdError({ cwd, reason: "statFailed", cause })),
        );
        const blocker = yield* storagePathBlocker(storageSql.value, canonical).pipe(
          Effect.mapError((cause) => new TerminalCwdError({ cwd, reason: "statFailed", cause })),
        );
        if (blocker !== null)
          return yield* blocker === "project-relocation"
            ? // Retryable, unlike a checkout's cleanup. An existing reason, so every client decodes
              // it, and the message says to try again.
              new TerminalCwdError({
                cwd,
                reason: "statFailed",
                cause: new Error(PROJECT_RELOCATION_PENDING_MESSAGE),
              })
            : new TerminalCwdError({ cwd, reason: "cleanupPending" });
      }
      const stats = yield* fileSystem.stat(authorizedCwd).pipe(
        Effect.mapError(
          (cause) =>
            new TerminalCwdError({
              cwd,
              reason: cause.reason._tag === "NotFound" ? "notFound" : "statFailed",
              cause,
            }),
        ),
      );
      if (stats.type !== "Directory") {
        return yield* new TerminalCwdError({
          cwd,
          reason: "notDirectory",
        });
      }
    });

    /**
     * Storage admission: the only part of an open, restart or guarded write that
     * holds the node-wide lifecycle lock, which orchestration takes for every
     * command. The path check and `commit` share one short critical section;
     * spawning, history I/O and kill escalation run under the thread lock only.
     */
    const withStorageAdmission = <A, E, R>(cwd: string, commit: Effect.Effect<A, E, R>) =>
      storageLifecycleLock.withPermit(
        // Inside the lock empty-folder cleanup also takes, so a chat's recreated folder stays.
        (Option.isSome(storageSql) ? restoreChatFolder(storageSql.value, cwd) : Effect.void).pipe(
          Effect.andThen(assertValidCwd(cwd)),
          Effect.andThen(commit),
        ),
      );

    /**
     * Admits a PTY start in `target.cwd` and, in the same critical section,
     * publishes the session there as `starting` (registering a new one). A
     * lifecycle owner that fences or vacates the path afterwards sees a live,
     * busy terminal and refuses or waits for it; one that fenced it first makes
     * this fail before anything changed. The session stays `starting` until
     * its PTY runs or the start fails.
     */
    const admitPtyStart = (
      session: TerminalSessionState,
      target: { readonly cwd: string; readonly worktreePath: string | null },
      register: boolean,
    ) =>
      withStorageAdmission(
        target.cwd,
        modifyManagerState((state) => {
          session.status = "starting";
          session.cwd = target.cwd;
          session.worktreePath = target.worktreePath;
          session.updatedAt = new Date().toISOString();
          if (!register) return [undefined, state] as const;
          const sessions = new Map(state.sessions);
          sessions.set(toSessionKey(session.threadId, session.terminalId), session);
          return [undefined, { ...state, sessions }] as const;
        }),
      );

    const getSession = Effect.fn("terminal.getSession")(function* (
      threadId: string,
      terminalId: string,
    ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
      return yield* Effect.map(readManagerState, (state) =>
        Option.fromNullishOr(state.sessions.get(toSessionKey(threadId, terminalId))),
      );
    });

    const requireSession = Effect.fn("terminal.requireSession")(function* (
      threadId: string,
      terminalId: string,
    ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
      return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
        Option.match(session, {
          onNone: () =>
            Effect.fail(
              new TerminalSessionLookupError({
                threadId,
                terminalId,
              }),
            ),
          onSome: Effect.succeed,
        }),
      );
    });

    const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
      return yield* readManagerState.pipe(
        Effect.map((state) =>
          [...state.sessions.values()].filter((session) => session.threadId === threadId),
        ),
      );
    });

    const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
      function* () {
        yield* modifyManagerState((state) => {
          const inactiveSessions = [...state.sessions.values()].filter(
            (session) => session.status !== "running",
          );
          if (inactiveSessions.length <= maxRetainedInactiveSessions) {
            return [undefined, state] as const;
          }

          inactiveSessions.sort(
            (left, right) =>
              left.updatedAt.localeCompare(right.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          );

          const sessions = new Map(state.sessions);

          const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
          for (const session of inactiveSessions.slice(0, toEvict)) {
            const key = toSessionKey(session.threadId, session.terminalId);
            sessions.delete(key);
          }

          return [undefined, { ...state, sessions }] as const;
        });
      },
    );

    // Caller owns the thread permit. Used by the live drain and by close after
    // detaching PTY callbacks, so close can preserve its already-accepted tail.
    const drainNextProcessEvent = Effect.fn("terminal.drainNextProcessEvent")(function* (
      session: TerminalSessionState,
      expectedPid: number,
    ) {
      const action: DrainProcessEventAction = yield* Effect.sync(() => {
        // A drain from the replaced PTY must not clear the new PTY's queue.
        if (session.pid !== expectedPid) return { type: "idle" } as const;
        if (!session.process || session.status !== "running") {
          clearPendingProcessEvents(session);
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          // Output held for the coalescing window stays; its timer queues it.
          resetPendingProcessEventQueue(session);
          return { type: "idle" } as const;
        }

        session.pendingProcessEventIndex += 1;
        let outputData = nextEvent.type === "output" ? nextEvent.data : "";
        let outputBytes = nextEvent.type === "output" ? nextEvent.byteLength : 0;
        if (nextEvent.type === "output" && outputCoalesceMs > 0) {
          // A backlog leaves as one event rather than one per queued chunk.
          let following = session.pendingProcessEvents[session.pendingProcessEventIndex];
          if (following?.type === "output") {
            const parts = [outputData];
            while (
              following?.type === "output" &&
              outputBytes + following.byteLength <= OUTPUT_COALESCE_MAX_BYTES
            ) {
              parts.push(following.data);
              outputBytes += following.byteLength;
              session.pendingProcessEventIndex += 1;
              following = session.pendingProcessEvents[session.pendingProcessEventIndex];
            }
            outputData = parts.join("");
          }
        }
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          session.pendingProcessOutputBytes = Math.max(
            0,
            session.pendingProcessOutputBytes - outputBytes,
          );
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            outputData,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.visibleText.length > 0) {
            // Appending re-enforces both the byte and line budgets; only a
            // budget overflow touches the retained history, so the
            // steady-state cost of a chunk is proportional to the chunk.
            session.historyState = appendTerminalHistoryChunk(
              session.historyState,
              sanitized.visibleText,
              historyLimits,
            );
            session.unpersistedHistoryChars += sanitized.visibleText.length;
          }
          session.updatedAt = new Date().toISOString();
          terminalOutputRevision += 1;
          const cursor = advanceCursor(session);
          if (sanitized.visibleText.length > 0) {
            session.historyIndex.append(
              cursor.sequence,
              sanitized.visibleText.length,
              session.historyState.history.length,
            );
          }

          return {
            type: "output",
            threadId: session.threadId,
            terminalId: session.terminalId,
            cursor,
            persistHistory: sanitized.visibleText.length > 0,
            data: outputData,
          } as const;
        }

        const process = session.process;
        cleanupProcessHandles(session, pendingProcessEventLimits);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        clearPendingProcessEvents(session);
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        session.updatedAt = new Date().toISOString();

        return {
          type: "exit",
          cursor: advanceCursor(session),
          process,
          threadId: session.threadId,
          terminalId: session.terminalId,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        } as const;
      });

      if (action.type === "idle") {
        return false;
      }

      if (action.type === "output") {
        lastTerminalOutputAtMs = yield* Clock.currentTimeMillis;
        if (action.persistHistory) {
          yield* queuePersist(session);
        }

        yield* publishEvent({
          type: "output",
          threadId: action.threadId,
          terminalId: action.terminalId,
          createdAt: new Date().toISOString(),
          data: action.data,
          cursor: action.cursor,
        });
        return true;
      }

      yield* clearKillFiber(action.process);
      // The history is final now; do not leave its last output to the window.
      yield* flushScheduledPersist(toSessionKey(action.threadId, action.terminalId));
      yield* publishEvent({
        type: "exited",
        threadId: action.threadId,
        terminalId: action.terminalId,
        createdAt: new Date().toISOString(),
        cursor: action.cursor,
        exitCode: action.exitCode,
        exitSignal: action.exitSignal,
      });
      yield* evictInactiveSessionsIfNeeded();
      return false;
    });

    const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
      session: TerminalSessionState,
      expectedPid: number,
    ) {
      while (yield* withThreadLock(session.threadId, drainNextProcessEvent(session, expectedPid))) {
        // Releasing a semaphore alone can let this fiber reacquire it before a
        // waiting lifecycle command runs. Give that command a turn between chunks.
        yield* Effect.yieldNow;
      }
    });

    /** Ends the window of output held for `expectedPid`; see {@link acceptCoalescedOutput}. */
    const scheduleOutputRelease = (
      session: TerminalSessionState,
      expectedPid: number,
      delayMs: number,
    ) => {
      const timer: OutputReleaseTimer = { fiber: null };
      session.outputReleaseTimer = timer;
      // Interruptible until it fires; firing is one synchronous step that only forks the drain,
      // so interrupting it can never strand `processEventDrainRunning`.
      timer.fiber = runFork(
        Effect.sleep(delayMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (session.outputReleaseTimer !== timer) return;
              session.outputReleaseTimer = null;
              if (session.pid !== expectedPid) return;
              if (
                releaseHeldOutput(
                  session,
                  expectedPid,
                  clock.currentTimeMillisUnsafe(),
                  pendingProcessEventLimits,
                )
              ) {
                runFork(drainProcessEvents(session, expectedPid));
              }
            }),
          ),
        ),
      );
    };

    /**
     * Coalesces PTY output: a chunk leaves at once when no output left within the last window,
     * when it answers input (its echo), or when the held bytes reach
     * {@link OUTPUT_COALESCE_MAX_BYTES}; otherwise it is held until the window ends. Held output
     * leaves as one pending output event; cursors are still assigned when the drain publishes.
     */
    const acceptCoalescedOutput = (
      session: TerminalSessionState,
      expectedPid: number,
      data: string,
    ) => {
      if (!acceptsProcessOutput(session, expectedPid)) return;
      session.heldOutput.push(data);
      session.heldOutputBytes += approximateTextBytes(data);
      const nowMs = clock.currentTimeMillisUnsafe();
      const windowEndsAtMs = session.lastOutputReleaseAtMs + outputCoalesceMs;
      if (
        session.releaseNextOutput ||
        nowMs >= windowEndsAtMs ||
        session.heldOutputBytes >= OUTPUT_COALESCE_MAX_BYTES
      ) {
        session.releaseNextOutput = false;
        if (releaseHeldOutput(session, expectedPid, nowMs, pendingProcessEventLimits)) {
          runFork(drainProcessEvents(session, expectedPid));
        }
        return;
      }
      if (session.outputReleaseTimer === null) {
        scheduleOutputRelease(session, expectedPid, windowEndsAtMs - nowMs);
      }
    };

    /**
     * `nextStatus: "starting"` is for a session whose relaunch storage admission already
     * published it as starting: it must never look ended (and its path free) in between.
     */
    const stopProcess = Effect.fn("terminal.stopProcess")(function* (
      session: TerminalSessionState,
      nextStatus: "exited" | "starting" = "exited",
    ) {
      const process = session.process;
      if (!process) return;

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session, pendingProcessEventLimits);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.status = nextStatus;
        session.pendingHistoryControlSequence = "";
        clearPendingProcessEvents(session);
        session.updatedAt = new Date().toISOString();
        return [undefined, state] as const;
      });

      yield* clearKillFiber(process);
      yield* startKillEscalation(process, session.threadId, session.terminalId);
      yield* evictInactiveSessionsIfNeeded();
    });

    const trySpawn = Effect.fn("terminal.trySpawn")(function* (
      shellCandidates: ReadonlyArray<ShellCandidate>,
      spawnEnv: NodeJS.ProcessEnv,
      session: TerminalSessionState,
      index = 0,
      lastError: PtySpawnError | null = null,
    ): Effect.fn.Return<{ process: PtyProcess; shellLabel: string }, PtySpawnError> {
      if (index >= shellCandidates.length) {
        const detail = lastError?.message ?? "Failed to spawn PTY process";
        const tried =
          shellCandidates.length > 0
            ? ` Tried shells: ${shellCandidates.map((candidate) => formatShellCandidate(candidate)).join(", ")}.`
            : "";
        return yield* new PtySpawnError({
          adapter: "terminal-manager",
          message: `${detail}.${tried}`.trim(),
          ...(lastError ? { cause: lastError } : {}),
        });
      }

      const candidate = shellCandidates[index];
      if (!candidate) {
        return yield* (
          lastError ??
            new PtySpawnError({
              adapter: "terminal-manager",
              message: "No shell candidate available for PTY spawn.",
            })
        );
      }

      const attempt = yield* Effect.result(
        options.ptyAdapter.spawn({
          shell: candidate.shell,
          ...(candidate.args ? { args: candidate.args } : {}),
          cwd: session.cwd,
          cols: session.cols,
          rows: session.rows,
          env: spawnEnv,
        }),
      );

      if (attempt._tag === "Success") {
        return {
          process: attempt.success,
          shellLabel: formatShellCandidate(candidate),
        };
      }

      const spawnError = attempt.failure;
      if (!isRetryableShellSpawnError(spawnError)) {
        return yield* spawnError;
      }

      return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
    });

    /** Caller owns the thread permit and has passed {@link admitPtyStart} for `input.cwd`. */
    const startSession = Effect.fn("terminal.startSession")(function* (
      session: TerminalSessionState,
      input: TerminalStartInput,
      eventType: "started" | "restarted",
    ) {
      yield* stopProcess(session, "starting");
      yield* Effect.annotateCurrentSpan({
        "terminal.thread_id": session.threadId,
        "terminal.id": session.terminalId,
        "terminal.event_type": eventType,
        "terminal.cwd": input.cwd,
      });

      yield* modifyManagerState((state) => {
        session.status = "starting";
        session.inputEpoch = randomUUID();
        session.hasReceivedInput = false;
        session.lastInputAtMs = null;
        session.cwd = input.cwd;
        session.worktreePath = input.worktreePath ?? null;
        session.cols = input.cols;
        session.rows = input.rows;
        session.exitCode = null;
        session.exitSignal = null;
        session.hasRunningSubprocess = false;
        clearPendingProcessEvents(session);
        session.updatedAt = new Date().toISOString();
        return [undefined, state] as const;
      });

      let ptyProcess: PtyProcess | null = null;
      let startedShell: string | null = null;

      const startResult = yield* Effect.result(
        increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const shellCandidates = resolveShellCandidates(shellResolver, platform, baseEnv);
              // The shell and every job it starts carry the thread's id, so the servers it starts
              // stay listed under this thread (`localServers/threadAttributionEnv.ts`).
              const terminalEnv = createTerminalSpawnEnv(
                baseEnv,
                session.runtimeEnv,
                session.threadId,
              );
              const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
              ptyProcess = spawnResult.process;
              startedShell = spawnResult.shellLabel;

              const processPid = ptyProcess.pid;
              const unsubscribeData = ptyProcess.onData((data) => {
                if (outputCoalesceMs > 0) {
                  acceptCoalescedOutput(session, processPid, data);
                  return;
                }
                if (
                  !enqueueProcessEvent(
                    session,
                    processPid,
                    {
                      type: "output",
                      data,
                      byteLength: approximateTextBytes(data),
                    },
                    pendingProcessEventLimits,
                  )
                ) {
                  return;
                }
                runFork(drainProcessEvents(session, processPid));
              });
              const unsubscribeExit = ptyProcess.onExit((event) => {
                // Held output was produced before the exit: it is queued, and published, first.
                const drainForOutput =
                  session.pid === processPid &&
                  releaseHeldOutput(
                    session,
                    processPid,
                    clock.currentTimeMillisUnsafe(),
                    pendingProcessEventLimits,
                  );
                const drainForExit = enqueueProcessEvent(
                  session,
                  processPid,
                  { type: "exit", event },
                  pendingProcessEventLimits,
                );
                if (!drainForOutput && !drainForExit) {
                  return;
                }
                runFork(drainProcessEvents(session, processPid));
              });

              yield* modifyManagerState((state) => {
                session.process = ptyProcess;
                session.idleForegroundName = null;
                session.pid = processPid;
                session.status = "running";
                advanceCursor(session);
                session.updatedAt = new Date().toISOString();
                session.unsubscribeData = unsubscribeData;
                session.unsubscribeExit = unsubscribeExit;
                return [undefined, state] as const;
              });
              noteTerminalIo();

              yield* signalRunningSession;

              yield* publishEvent({
                type: eventType,
                threadId: session.threadId,
                terminalId: session.terminalId,
                createdAt: new Date().toISOString(),
                cursor: session.cursor,
                snapshot: snapshot(session),
              });
            }),
          ),
        ),
      );

      if (startResult._tag === "Success") {
        return;
      }

      {
        const error = startResult.failure;
        if (ptyProcess) {
          yield* startKillEscalation(ptyProcess, session.threadId, session.terminalId);
        }

        yield* modifyManagerState((state) => {
          session.status = "error";
          advanceCursor(session);
          session.pid = null;
          session.process = null;
          session.unsubscribeData = null;
          session.unsubscribeExit = null;
          session.hasRunningSubprocess = false;
          clearPendingProcessEvents(session);
          session.updatedAt = new Date().toISOString();
          return [undefined, state] as const;
        });

        yield* evictInactiveSessionsIfNeeded();

        const message = error.message;
        yield* publishEvent({
          type: "error",
          threadId: session.threadId,
          terminalId: session.terminalId,
          createdAt: new Date().toISOString(),
          message,
          cursor: session.cursor,
        });
        yield* Effect.logError("failed to start terminal", {
          threadId: session.threadId,
          terminalId: session.terminalId,
          error: message,
          ...(startedShell ? { shell: startedShell } : {}),
        });
      }
    });

    const closeSession = Effect.fn("terminal.closeSession")(function* (
      threadId: string,
      terminalId: string,
      deleteHistoryOnClose: boolean,
    ) {
      const key = toSessionKey(threadId, terminalId);
      const session = yield* getSession(threadId, terminalId);

      if (Option.isSome(session)) {
        const pid = session.value.pid;
        cleanupProcessHandles(session.value, pendingProcessEventLimits);
        // The detached producer cannot extend this bounded queue while closing.
        if (pid !== null) {
          while (yield* drainNextProcessEvent(session.value, pid)) {
            /* drain accepted output */
          }
        }
        yield* stopProcess(session.value);
        yield* persistHistory(session.value);
      }

      yield* flushPersist(threadId, terminalId);

      yield* modifyManagerState((state) => {
        if (!state.sessions.has(key)) {
          return [undefined, state] as const;
        }
        const sessions = new Map(state.sessions);
        sessions.delete(key);
        return [undefined, { ...state, sessions }] as const;
      });

      noteStorageActivity();
      if (deleteHistoryOnClose) {
        yield* deleteHistory(threadId, terminalId);
      }
    });

    let processTableSnapshotFailing = false;
    /**
     * Returns whether any terminal's subprocess activity changed. With `trustForeground`, a PTY
     * whose foreground process is evidently a command, not the shell, reads as running without
     * a process table; every other reading comes from the table.
     */
    const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* (
      trustForeground: boolean,
    ) {
      const state = yield* readManagerState;
      const runningSessions = [...state.sessions.values()].filter(
        (session): session is TerminalSessionState & { pid: number } =>
          session.status === "running" && Number.isInteger(session.pid),
      );

      if (runningSessions.length === 0) {
        return false;
      }

      // The foreground name is evidence only in one direction. A name other than the
      // one the shell showed while idle means a command runs. The shell's own name
      // says nothing: a background job, a nested shell and a script run by the
      // shell's own interpreter all leave it in the foreground, and some shells
      // go by a different name than the one they were started as. Those readings,
      // and every reading from a PTY that cannot name its foreground, share one
      // process-table enumeration per tick: spawning pgrep/ps per session scales
      // with terminal count and can create enough short-lived processes to
      // exhaust host PID capacity.
      const readings: SubprocessReading[] = [];
      const tableSessions: Array<{
        readonly session: TerminalSessionState;
        readonly terminalPid: number;
        readonly foreground: string | undefined;
      }> = [];
      for (const session of runningSessions) {
        const terminalPid = session.pid;
        const foreground = readForegroundName(session);
        if (
          trustForeground &&
          foreground !== undefined &&
          session.idleForegroundName !== null &&
          foreground !== session.idleForegroundName
        ) {
          readings.push({
            session,
            terminalPid,
            hasRunningSubprocess: true,
            idleForegroundName: undefined,
          });
        } else {
          tableSessions.push({ session, terminalPid, foreground });
        }
      }

      if (tableSessions.length > 0) {
        const processTable = yield* processTableSnapshotter(
          tableSessions.map(({ terminalPid }) => terminalPid),
        ).pipe(
          Effect.map(Option.some),
          Effect.catch((reason) => {
            // A persistent failure (e.g. a process table larger than the output
            // cap) would otherwise log on every tick; log once per failure streak.
            if (processTableSnapshotFailing) return Effect.succeed(Option.none());
            processTableSnapshotFailing = true;
            return Effect.logWarning(
              "failed to snapshot processes for terminal subprocess polling",
              { reason },
            ).pipe(Effect.as(Option.none<TerminalProcessTableSnapshot>()));
          }),
        );

        // A failed or partial snapshot is not authoritative. Keep the last
        // known state rather than incorrectly marking every terminal idle.
        if (Option.isSome(processTable)) {
          processTableSnapshotFailing = false;
          for (const { session, terminalPid, foreground } of tableSessions) {
            const hasRunningSubprocess =
              (processTable.value.childrenByParent.get(terminalPid)?.length ?? 0) > 0;
            readings.push({
              session,
              terminalPid,
              hasRunningSubprocess,
              // The shell's own name, when the table found it idle and the name held
              // still across the snapshot (a command that started and ended meanwhile
              // would change it).
              idleForegroundName:
                !hasRunningSubprocess &&
                foreground !== undefined &&
                readForegroundName(session) === foreground
                  ? foreground
                  : undefined,
            });
          }
        }
      }
      let changed = false;

      const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
        reading: SubprocessReading,
      ) {
        const { session, terminalPid, hasRunningSubprocess, idleForegroundName } = reading;

        const event = yield* modifyManagerState((state) => {
          const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
            state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
          );
          if (
            Option.isNone(liveSession) ||
            liveSession.value.status !== "running" ||
            liveSession.value.pid !== terminalPid
          ) {
            return [Option.none(), state] as const;
          }
          if (idleForegroundName !== undefined) {
            liveSession.value.idleForegroundName = idleForegroundName;
          }
          if (liveSession.value.hasRunningSubprocess === hasRunningSubprocess) {
            return [Option.none(), state] as const;
          }

          liveSession.value.hasRunningSubprocess = hasRunningSubprocess;
          liveSession.value.updatedAt = new Date().toISOString();

          return [
            Option.some({
              type: "activity" as const,
              threadId: liveSession.value.threadId,
              terminalId: liveSession.value.terminalId,
              createdAt: new Date().toISOString(),
              hasRunningSubprocess,
              cursor: advanceCursor(liveSession.value),
            }),
            state,
          ] as const;
        });

        if (Option.isSome(event)) {
          changed = true;
          yield* publishEvent(event.value);
        }
      });

      yield* Effect.forEach(readings, checkSubprocessActivity, {
        concurrency: "unbounded",
        discard: true,
      });
      return changed;
    });

    // Ticks every `subprocessPollIntervalMs`, but checks subprocess activity
    // only: on every tick while a terminal had input (or a start, or an
    // activity change) within the idle interval; once on the first tick after
    // output went quiet, which is when a command that printed its way to the
    // next prompt has ended; and otherwise once per idle interval. Continuous
    // output (a dev server, a watcher) thus costs the idle cadence, not a
    // check per tick. When neither input nor output has happened for the
    // deep-idle window, the idle interval lengthens to the deep-idle interval.
    // Only the fast cadence takes a command's word for it (a foreground process
    // other than the shell); the idle cadence always asks the process table, so a
    // shell that replaced itself cannot read as running for long.
    let observedIoRevision = -1;
    let observedOutputRevision = 0;
    let ticksSinceIo = 0;
    let ticksSincePoll = 0;
    let outputSincePoll = false;
    const subprocessPollTick = Effect.gen(function* () {
      if (terminalIoRevision !== observedIoRevision) {
        observedIoRevision = terminalIoRevision;
        ticksSinceIo = 0;
      } else {
        ticksSinceIo += 1;
      }
      if (terminalOutputRevision !== observedOutputRevision) {
        observedOutputRevision = terminalOutputRevision;
        outputSincePoll = true;
      }
      ticksSincePoll += 1;
      const sinceOutputMs = (yield* Clock.currentTimeMillis) - lastTerminalOutputAtMs;
      const outputWentQuiet = outputSincePoll && sinceOutputMs >= subprocessOutputQuietMs;
      const deepIdle =
        ticksSinceIo >= subprocessDeepIdleAfterTicks &&
        sinceOutputMs >= DEFAULT_SUBPROCESS_DEEP_IDLE_AFTER_MS;
      if (
        ticksSinceIo >= subprocessIdlePollTicks &&
        ticksSincePoll < (deepIdle ? subprocessDeepIdlePollTicks : subprocessIdlePollTicks) &&
        !outputWentQuiet
      ) {
        return;
      }
      ticksSincePoll = 0;
      outputSincePoll = false;
      if (yield* pollSubprocessActivity(ticksSinceIo < subprocessIdlePollTicks)) noteTerminalIo();
    });

    yield* Effect.forever(
      waitForRunningSession.pipe(
        Effect.flatMap(() => subprocessPollTick),
        Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs)),
      ),
    ).pipe(Effect.forkIn(workerScope));

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const sessions = yield* modifyManagerState(
          (state) =>
            [
              [...state.sessions.values()],
              {
                ...state,
                sessions: new Map(),
              },
            ] as const,
        );

        const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
          session: TerminalSessionState,
        ) {
          cleanupProcessHandles(session, pendingProcessEventLimits);
          if (!session.process) return;
          yield* clearKillFiber(session.process);
          yield* runKillEscalation(session.process, session.threadId, session.terminalId);
        });

        yield* Effect.forEach(sessions, cleanupSession, {
          concurrency: "unbounded",
          discard: true,
        });
      }).pipe(Effect.ignoreCause({ log: true })),
    );

    const open: TerminalManagerShape["open"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
          const existing = yield* getSession(input.threadId, terminalId);
          if (Option.isNone(existing)) {
            yield* flushPersist(input.threadId, terminalId);
            const history = yield* readHistory(input.threadId, terminalId);
            const cols = input.cols ?? DEFAULT_OPEN_COLS;
            const rows = input.rows ?? DEFAULT_OPEN_ROWS;
            const historyState = historyBufferStateFrom(history, historyLimits);
            const cursor = nextCursor();
            const session: TerminalSessionState = {
              inputEpoch: randomUUID(),
              hasReceivedInput: false,
              lastInputAtMs: null,
              threadId: input.threadId,
              terminalId,
              cwd: input.cwd,
              worktreePath: input.worktreePath ?? null,
              status: "starting",
              pid: null,
              historyState,
              historyIndex: new TerminalHistoryCursorIndex(
                cursor.sequence + 1,
                historyState.history.length,
              ),
              pendingHistoryControlSequence: "",
              pendingProcessEvents: [],
              pendingProcessEventIndex: 0,
              pendingProcessOutputBytes: 0,
              processEventDrainRunning: false,
              heldOutput: [],
              heldOutputBytes: 0,
              lastOutputReleaseAtMs: Number.NEGATIVE_INFINITY,
              releaseNextOutput: false,
              outputReleaseTimer: null,
              exitCode: null,
              exitSignal: null,
              updatedAt: new Date().toISOString(),
              cursor,
              cols,
              rows,
              process: null,
              idleForegroundName: null,
              unsubscribeData: null,
              unsubscribeExit: null,
              hasRunningSubprocess: false,
              runtimeEnv: normalizedRuntimeEnv(input.env),
              unpersistedHistoryChars: 0,
              persistedHistoryFile: null,
            };

            // Once admitted, the start runs to its end: an interrupted one would leave the
            // session `starting` (busy to every lifecycle owner) or a spawned PTY unattached.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* admitPtyStart(
                  session,
                  { cwd: input.cwd, worktreePath: input.worktreePath ?? null },
                  true,
                );
                yield* evictInactiveSessionsIfNeeded();
                yield* startSession(
                  session,
                  {
                    threadId: input.threadId,
                    terminalId,
                    cwd: input.cwd,
                    ...(input.worktreePath !== undefined
                      ? { worktreePath: input.worktreePath }
                      : {}),
                    cols,
                    rows,
                    ...(input.env ? { env: input.env } : {}),
                  },
                  "started",
                );
              }),
            );
            return openSnapshot(session, input.sinceCursor);
          }

          const liveSession = existing.value;
          const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
          const targetCols = input.cols ?? liveSession.cols;
          const targetRows = input.rows ?? liveSession.rows;
          // Another cwd or environment relaunches the shell; an ended one restarts. Both
          // start over with empty history.
          const relaunch =
            liveSession.cwd !== input.cwd ||
            !Equal.equals(liveSession.runtimeEnv, nextRuntimeEnv) ||
            liveSession.status === "exited" ||
            liveSession.status === "error";

          if (!relaunch && liveSession.process) {
            // Reattach: nothing starts, so admission only checks the path.
            yield* withStorageAdmission(input.cwd, Effect.void);
            if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
              liveSession.cols = targetCols;
              liveSession.rows = targetRows;
              liveSession.updatedAt = new Date().toISOString();
              liveSession.process.resize(targetCols, targetRows);
            }
            return openSnapshot(liveSession, input.sinceCursor);
          }

          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* admitPtyStart(
                liveSession,
                {
                  cwd: input.cwd,
                  worktreePath: relaunch ? (input.worktreePath ?? null) : liveSession.worktreePath,
                },
                false,
              );
              if (relaunch) {
                yield* stopProcess(liveSession, "starting");
                liveSession.runtimeEnv = nextRuntimeEnv;
                replaceHistory(liveSession, emptyHistoryBufferState());
                clearPendingProcessEvents(liveSession);
                yield* persistHistory(liveSession);
              }
              yield* startSession(
                liveSession,
                {
                  threadId: input.threadId,
                  terminalId,
                  cwd: input.cwd,
                  worktreePath: liveSession.worktreePath,
                  cols: targetCols,
                  rows: targetRows,
                  ...(input.env ? { env: input.env } : {}),
                },
                "started",
              );
            }),
          );
          return openSnapshot(liveSession, input.sinceCursor);
        }),
      );

    /**
     * Fails with {@link TerminalBusyError} unless the shell is idle now; the caller holds the
     * thread lock. A shell without input that could start a command since it started runs only
     * its startup files, as a fresh terminal does. Any other shell needs a process-table read
     * requested now: every input to the thread takes the same lock, so none can land between
     * the read and the write, and input from just before may not show in the read yet, so it
     * is refused.
     */
    const verifySessionIdle = Effect.fn("terminal.verifySessionIdle")(function* (
      session: TerminalSessionState,
    ) {
      const busy = (reason: TerminalBusyError["reason"]) =>
        new TerminalBusyError({
          threadId: session.threadId,
          terminalId: session.terminalId,
          reason,
        });
      const pid = session.pid;
      if (
        session.status !== "running" ||
        session.process === null ||
        pid === null ||
        hasPendingExit(session)
      ) {
        return yield* busy("unverified");
      }
      const lastInputAtMs = session.lastInputAtMs;
      if (lastInputAtMs === null) return;
      const checkStartedAtMs = yield* Clock.currentTimeMillis;
      if (checkStartedAtMs - lastInputAtMs < REQUIRE_IDLE_INPUT_SETTLE_MS) {
        return yield* busy("inputRaced");
      }
      // A foreground process other than the one the shell showed while idle is a command.
      // This also catches `exec vim`, which leaves no child for the table to find.
      const foreground = readForegroundName(session);
      if (
        foreground !== undefined &&
        session.idleForegroundName !== null &&
        foreground !== session.idleForegroundName
      ) {
        return yield* busy("running");
      }
      // Unlike activity polling, a failed read is no evidence of an idle shell.
      const processTable = yield* processTableSnapshotter([pid]).pipe(
        Effect.catch((reason) =>
          Effect.logWarning("failed to snapshot processes to verify an idle terminal", {
            reason,
          }).pipe(Effect.andThen(Effect.fail(busy("unverified")))),
        ),
      );
      // An exit the PTY reported during the read is still queued: its drain waits on the lock.
      if (session.pid !== pid || hasPendingExit(session)) {
        return yield* busy("unverified");
      }
      if ((processTable.childrenByParent.get(pid)?.length ?? 0) > 0) {
        return yield* busy("running");
      }
    });

    const write: TerminalManagerShape["write"] = Effect.fn("terminal.write")((input, canCommit) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
          const session = yield* requireSession(input.threadId, terminalId);
          if (input.requireIdle) yield* verifySessionIdle(session);
          const guardIsCurrent = () =>
            !input.guard ||
            ((canCommit?.() ?? false) &&
              session.inputEpoch === input.guard.inputEpoch &&
              session.cwd === input.guard.cwd &&
              session.worktreePath === input.guard.worktreePath &&
              session.status === "running" &&
              !session.hasRunningSubprocess &&
              !session.hasReceivedInput &&
              session.cursor.generation === input.guard.outputCursor.generation &&
              session.cursor.sequence === input.guard.outputCursor.sequence &&
              session.pendingProcessEvents.length === session.pendingProcessEventIndex &&
              session.heldOutput.length === 0);
          if (input.guard) {
            const validPaste = yield* Effect.try({
              try: () => input.data === bracketedTerminalSnippet(input.data.slice(6, -6)),
              catch: () =>
                new TerminalInputRejectedError({
                  message:
                    "Safe insertion requires a complete bracketed paste without terminal controls or an Enter outside the paste.",
                }),
            });
            if (!validPaste)
              return yield* new TerminalInputRejectedError({
                message:
                  "Safe insertion requires bracketed paste without an Enter outside the paste.",
              });
            if (!guardIsCurrent())
              return yield* new TerminalInputRejectedError({
                message: "Terminal changed. Insert the snippet again in the current workspace.",
              });
          }
          const inputAtMs = yield* Clock.currentTimeMillis;
          // Admission may yield for filesystem IO. Recheck output/session/input
          // evidence and write synchronously afterward; a guarded write does both
          // inside its storage admission, after the path check.
          const commit = Effect.suspend(
            (): Effect.Effect<void, TerminalInputRejectedError | TerminalNotRunningError> => {
              if (!guardIsCurrent()) {
                return Effect.fail(
                  new TerminalInputRejectedError({
                    message: "Terminal changed. Insert the snippet again in the current workspace.",
                  }),
                );
              }
              const process = session.process;
              if (!process || session.status !== "running") {
                if (session.status === "exited") return Effect.void;
                return Effect.fail(
                  new TerminalNotRunningError({ threadId: input.threadId, terminalId }),
                );
              }
              session.hasReceivedInput = true;
              // Focusing a terminal or answering its queries starts nothing. A script run moves
              // focus right before its write, so counting those reports would refuse that write.
              if (!isTerminalReportData(input.data)) {
                session.lastInputAtMs = inputAtMs;
                // Its echo should not wait for the output coalescing window.
                session.releaseNextOutput = true;
              }
              process.write(input.data);
              noteTerminalIo();
              return Effect.void;
            },
          );
          yield* input.guard ? withStorageAdmission(input.guard.cwd, commit) : commit;
        }),
      ),
    );

    const resize: TerminalManagerShape["resize"] = Effect.fn("terminal.resize")(function* (input) {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const session = yield* requireSession(input.threadId, terminalId);
      const process = session.process;
      if (!process || session.status !== "running") {
        return yield* new TerminalNotRunningError({
          threadId: input.threadId,
          terminalId,
        });
      }
      session.cols = input.cols;
      session.rows = input.rows;
      session.updatedAt = new Date().toISOString();
      yield* Effect.sync(() => process.resize(input.cols, input.rows));
    });

    const clear: TerminalManagerShape["clear"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
          const session = yield* requireSession(input.threadId, terminalId);
          replaceHistory(session, emptyHistoryBufferState());
          clearPendingProcessEvents(session);
          session.updatedAt = new Date().toISOString();
          const cursor = advanceCursor(session);
          yield* persistHistory(session);
          yield* publishEvent({
            type: "cleared",
            cursor,
            threadId: input.threadId,
            terminalId,
            createdAt: new Date().toISOString(),
          });
        }),
      );

    const restart: TerminalManagerShape["restart"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          yield* increment(terminalRestartsTotal, { scope: "thread" });
          const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
          const target = { cwd: input.cwd, worktreePath: input.worktreePath ?? null };
          const existingSession = yield* getSession(input.threadId, terminalId);
          // Once admitted, the restart runs to its end; see `open`.
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              let session: TerminalSessionState;
              if (Option.isNone(existingSession)) {
                const cursor = nextCursor();
                session = {
                  inputEpoch: randomUUID(),
                  hasReceivedInput: false,
                  lastInputAtMs: null,
                  threadId: input.threadId,
                  terminalId,
                  cwd: input.cwd,
                  worktreePath: target.worktreePath,
                  status: "starting",
                  pid: null,
                  historyState: emptyHistoryBufferState(),
                  historyIndex: new TerminalHistoryCursorIndex(cursor.sequence + 1, 0),
                  pendingHistoryControlSequence: "",
                  pendingProcessEvents: [],
                  pendingProcessEventIndex: 0,
                  pendingProcessOutputBytes: 0,
                  processEventDrainRunning: false,
                  heldOutput: [],
                  heldOutputBytes: 0,
                  lastOutputReleaseAtMs: Number.NEGATIVE_INFINITY,
                  releaseNextOutput: false,
                  outputReleaseTimer: null,
                  exitCode: null,
                  exitSignal: null,
                  updatedAt: new Date().toISOString(),
                  cursor,
                  cols: input.cols,
                  rows: input.rows,
                  process: null,
                  idleForegroundName: null,
                  unsubscribeData: null,
                  unsubscribeExit: null,
                  hasRunningSubprocess: false,
                  runtimeEnv: normalizedRuntimeEnv(input.env),
                  unpersistedHistoryChars: 0,
                  persistedHistoryFile: null,
                };
                yield* admitPtyStart(session, target, true);
                yield* evictInactiveSessionsIfNeeded();
              } else {
                session = existingSession.value;
                yield* admitPtyStart(session, target, false);
                yield* stopProcess(session, "starting");
                session.runtimeEnv = normalizedRuntimeEnv(input.env);
              }

              replaceHistory(session, emptyHistoryBufferState());
              clearPendingProcessEvents(session);
              yield* persistHistory(session);
              yield* startSession(
                session,
                {
                  threadId: input.threadId,
                  terminalId,
                  cwd: input.cwd,
                  ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
                  cols: input.cols,
                  rows: input.rows,
                  ...(input.env ? { env: input.env } : {}),
                },
                "restarted",
              );
              return snapshot(session);
            }),
          );
        }),
      );

    const close: TerminalManagerShape["close"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.terminalId) {
            yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
            return;
          }

          const threadSessions = yield* sessionsForThread(input.threadId);
          yield* Effect.forEach(
            threadSessions,
            (session) => closeSession(input.threadId, session.terminalId, false),
            { discard: true },
          );

          if (input.deleteHistory) {
            yield* deleteAllHistoryForThread(input.threadId);
          }
        }),
      );

    const listSessions: TerminalManagerShape["listSessions"] = SynchronizedRef.get(
      managerStateRef,
    ).pipe(
      Effect.map((state) =>
        [...state.sessions.values()]
          .map(snapshot)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      ),
    );

    return {
      open,
      write,
      resize,
      clear,
      restart,
      close,
      listDiagnostics: SynchronizedRef.get(managerStateRef).pipe(
        Effect.map((state) =>
          [...state.sessions.values()]
            .map(diagnosticsSnapshot)
            .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        ),
      ),
      listSessions,
      subscribe: (listener) =>
        Effect.sync(() => {
          terminalEventListeners.add(listener);
          return () => {
            terminalEventListeners.delete(listener);
          };
        }),
    } satisfies TerminalManagerShape;
  },
);

export const TerminalManagerLive = Layer.effect(TerminalManager, makeTerminalManager());
