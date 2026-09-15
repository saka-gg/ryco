import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_TERMINAL_ID,
  type DiagnosticsTerminalProcess,
  type TerminalEvent,
  type TerminalCursor,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
} from "@ryco/contracts";
import { makeKeyedCoalescingWorker } from "@ryco/shared/KeyedCoalescingWorker";
import { latestStateQueuePolicy } from "@ryco/shared/QueuePolicy";
import {
  Effect,
  Deferred,
  Encoding,
  Equal,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
  SynchronizedRef,
} from "effect";

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
  emptyHistoryBufferState,
  historyBufferStateFrom,
} from "../historyBuffer.ts";
import {
  PtyAdapter,
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
} from "../Services/PTY.ts";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_MAX_PENDING_PROCESS_EVENTS = 2_048;
const DEFAULT_MAX_PENDING_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);

class TerminalSubprocessCheckError extends Schema.TaggedError<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    command: Schema.Literals(["powershell", "ps"]),
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

interface TerminalProcessTableSnapshot {
  readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>;
}

interface TerminalProcessTableSnapshotter {
  (): Effect.Effect<TerminalProcessTableSnapshot, TerminalSubprocessCheckError | Error>;
}

interface ShellCandidate {
  shell: string;
  args?: string[];
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
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  /** Retained scrollback, byte- and line-bounded. Trimmed from the head. */
  historyState: HistoryBufferState;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  pendingProcessOutputBytes: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cursor: TerminalCursor;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  runtimeEnv: Record<string, string> | null;
}

interface PersistHistoryRequest {
  history: string;
  immediate: boolean;
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
      history: string | null;
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

function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

function clearPendingProcessEvents(session: TerminalSessionState): void {
  session.pendingProcessEvents = [];
  session.pendingProcessEventIndex = 0;
  session.pendingProcessOutputBytes = 0;
  session.processEventDrainRunning = false;
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
  limits: {
    readonly maxPendingProcessEvents: number;
    readonly maxPendingProcessOutputBytes: number;
  },
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  if (
    event.type === "output" &&
    session.pendingProcessEvents.some((pendingEvent) => pendingEvent.type === "exit")
  ) {
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
  limits: {
    readonly maxPendingProcessEvents: number;
    readonly maxPendingProcessOutputBytes: number;
  },
): void {
  while (
    session.pendingProcessEvents.length > limits.maxPendingProcessEvents &&
    coalesceOldestPendingOutputPair(session)
  ) {
    // Keep event count bounded without losing bytes when adjacent output can be merged.
  }
  trimPendingOutputBytesToLimit(session, limits.maxPendingProcessOutputBytes);
}

function defaultShellResolver(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform = process.platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName =
    platform === "win32"
      ? path.win32.basename(command).toLowerCase()
      : path.basename(command).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return path.win32.join(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return path.win32.join(windowsSystemRoot(env), "System32", "cmd.exe");
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(env.SHELL, platform), platform),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
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
  return parsePosixProcessTable(result.stdout);
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
    return parseWindowsProcessTable(result.stdout);
  },
);

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

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  return false;
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        if (nextCodePoint !== 0x5d || !shouldStripOscSequence(content)) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      if (codePoint !== 0x9d || !shouldStripOscSequence(content)) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "" };
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("RYCO_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return spawnEnv;
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
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  maxPendingProcessEvents?: number;
  maxPendingProcessOutputBytes?: number;
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
    const processTableSnapshotter =
      options.processTableSnapshotter ??
      (platform === "win32"
        ? snapshotWindowsProcessTable
        : () => snapshotPosixProcessTable(posixPsCommand ?? "ps"));
    const subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
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
    const pendingProcessEventLimits = {
      maxPendingProcessEvents,
      maxPendingProcessOutputBytes,
    } as const;

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
      merge: (current, next) => ({
        history: next.history,
        immediate: current.immediate || next.immediate,
      }),
      process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
        if (!request.immediate) {
          yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
        }

        const [threadId, terminalId] = sessionKey.split("\u0000");
        if (!threadId || !terminalId) {
          return;
        }

        yield* fileSystem.writeFileString(historyPath(threadId, terminalId), request.history).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to persist terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        );
      }),
    });

    const queuePersist = Effect.fn("terminal.queuePersist")(function* (
      threadId: string,
      terminalId: string,
      history: string,
    ) {
      yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
        history,
        immediate: false,
      });
    });

    const flushPersist = Effect.fn("terminal.flushPersist")(function* (
      threadId: string,
      terminalId: string,
    ) {
      yield* persistWorker.drainKey(toSessionKey(threadId, terminalId));
    });

    const persistHistory = Effect.fn("terminal.persistHistory")(function* (
      threadId: string,
      terminalId: string,
      history: string,
    ) {
      yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
        history,
        immediate: true,
      });
      yield* flushPersist(threadId, terminalId);
    });

    const readHistory = Effect.fn("terminal.readHistory")(function* (
      threadId: string,
      terminalId: string,
    ) {
      const nextPath = historyPath(threadId, terminalId);
      if (
        yield* fileSystem
          .exists(nextPath)
          .pipe(Effect.mapError(toTerminalHistoryError("read", threadId, terminalId)))
      ) {
        const raw = yield* fileSystem
          .readFileString(nextPath)
          .pipe(Effect.mapError(toTerminalHistoryError("read", threadId, terminalId)));
        const capped = capHistory(raw, historyLineLimit);
        if (capped !== raw) {
          yield* fileSystem
            .writeFileString(nextPath, capped)
            .pipe(Effect.mapError(toTerminalHistoryError("truncate", threadId, terminalId)));
        }
        return capped;
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
          clearPendingProcessEvents(session);
          return { type: "idle" } as const;
        }

        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          session.pendingProcessOutputBytes = Math.max(
            0,
            session.pendingProcessOutputBytes - nextEvent.byteLength,
          );
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            nextEvent.data,
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
          }
          session.updatedAt = new Date().toISOString();

          return {
            type: "output",
            threadId: session.threadId,
            terminalId: session.terminalId,
            cursor: advanceCursor(session),
            history: sanitized.visibleText.length > 0 ? session.historyState.history : null,
            data: nextEvent.data,
          } as const;
        }

        const process = session.process;
        cleanupProcessHandles(session);
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
        if (action.history !== null) {
          yield* queuePersist(action.threadId, action.terminalId, action.history);
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

    const stopProcess = Effect.fn("terminal.stopProcess")(function* (
      session: TerminalSessionState,
    ) {
      const process = session.process;
      if (!process) return;

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.status = "exited";
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

    const startSession = Effect.fn("terminal.startSession")(function* (
      session: TerminalSessionState,
      input: TerminalStartInput,
      eventType: "started" | "restarted",
    ) {
      yield* stopProcess(session);
      yield* Effect.annotateCurrentSpan({
        "terminal.thread_id": session.threadId,
        "terminal.id": session.terminalId,
        "terminal.event_type": eventType,
        "terminal.cwd": input.cwd,
      });

      yield* modifyManagerState((state) => {
        session.status = "starting";
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
              const terminalEnv = createTerminalSpawnEnv(baseEnv, session.runtimeEnv);
              const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
              ptyProcess = spawnResult.process;
              startedShell = spawnResult.shellLabel;

              const processPid = ptyProcess.pid;
              const unsubscribeData = ptyProcess.onData((data) => {
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
                if (
                  !enqueueProcessEvent(
                    session,
                    processPid,
                    { type: "exit", event },
                    pendingProcessEventLimits,
                  )
                ) {
                  return;
                }
                runFork(drainProcessEvents(session, processPid));
              });

              yield* modifyManagerState((state) => {
                session.process = ptyProcess;
                session.pid = processPid;
                session.status = "running";
                advanceCursor(session);
                session.updatedAt = new Date().toISOString();
                session.unsubscribeData = unsubscribeData;
                session.unsubscribeExit = unsubscribeExit;
                return [undefined, state] as const;
              });

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
        cleanupProcessHandles(session.value);
        // The detached producer cannot extend this bounded queue while closing.
        if (pid !== null) {
          while (yield* drainNextProcessEvent(session.value, pid)) {
            /* drain accepted output */
          }
        }
        yield* stopProcess(session.value);
        yield* persistHistory(threadId, terminalId, session.value.historyState.history);
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

      if (deleteHistoryOnClose) {
        yield* deleteHistory(threadId, terminalId);
      }
    });

    const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
      const state = yield* readManagerState;
      const runningSessions = [...state.sessions.values()].filter(
        (session): session is TerminalSessionState & { pid: number } =>
          session.status === "running" && Number.isInteger(session.pid),
      );

      if (runningSessions.length === 0) {
        return;
      }

      // One process-table enumeration serves every running terminal in this
      // tick. Spawning pgrep/ps per session scales with terminal count and can
      // create enough short-lived processes to exhaust host PID capacity.
      const processTable = yield* processTableSnapshotter().pipe(
        Effect.map(Option.some),
        Effect.catch((reason) =>
          Effect.logWarning("failed to snapshot processes for terminal subprocess polling", {
            reason,
          }).pipe(Effect.as(Option.none<TerminalProcessTableSnapshot>())),
        ),
      );

      // A failed or partial snapshot is not authoritative. Keep the last
      // known state rather than incorrectly marking every terminal idle.
      if (Option.isNone(processTable)) {
        return;
      }

      const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
        session: TerminalSessionState & { pid: number },
      ) {
        const terminalPid = session.pid;
        const hasRunningSubprocess =
          (processTable.value.childrenByParent.get(terminalPid)?.length ?? 0) > 0;

        const event = yield* modifyManagerState((state) => {
          const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
            state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
          );
          if (
            Option.isNone(liveSession) ||
            liveSession.value.status !== "running" ||
            liveSession.value.pid !== terminalPid ||
            liveSession.value.hasRunningSubprocess === hasRunningSubprocess
          ) {
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
          yield* publishEvent(event.value);
        }
      });

      yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
        concurrency: "unbounded",
        discard: true,
      });
    });

    yield* Effect.forever(
      waitForRunningSession.pipe(
        Effect.flatMap(() => pollSubprocessActivity()),
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
          cleanupProcessHandles(session);
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
          yield* assertValidCwd(input.cwd);

          const sessionKey = toSessionKey(input.threadId, terminalId);
          const existing = yield* getSession(input.threadId, terminalId);
          if (Option.isNone(existing)) {
            yield* flushPersist(input.threadId, terminalId);
            const history = yield* readHistory(input.threadId, terminalId);
            const cols = input.cols ?? DEFAULT_OPEN_COLS;
            const rows = input.rows ?? DEFAULT_OPEN_ROWS;
            const session: TerminalSessionState = {
              threadId: input.threadId,
              terminalId,
              cwd: input.cwd,
              worktreePath: input.worktreePath ?? null,
              status: "starting",
              pid: null,
              historyState: historyBufferStateFrom(history, historyLimits),
              pendingHistoryControlSequence: "",
              pendingProcessEvents: [],
              pendingProcessEventIndex: 0,
              pendingProcessOutputBytes: 0,
              processEventDrainRunning: false,
              exitCode: null,
              exitSignal: null,
              updatedAt: new Date().toISOString(),
              cursor: nextCursor(),
              cols,
              rows,
              process: null,
              unsubscribeData: null,
              unsubscribeExit: null,
              hasRunningSubprocess: false,
              runtimeEnv: normalizedRuntimeEnv(input.env),
            };

            const createdSession = session;
            yield* modifyManagerState((state) => {
              const sessions = new Map(state.sessions);
              sessions.set(sessionKey, createdSession);
              return [undefined, { ...state, sessions }] as const;
            });

            yield* evictInactiveSessionsIfNeeded();
            yield* startSession(
              session,
              {
                threadId: input.threadId,
                terminalId,
                cwd: input.cwd,
                ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
                cols,
                rows,
                ...(input.env ? { env: input.env } : {}),
              },
              "started",
            );
            return snapshot(session);
          }

          const liveSession = existing.value;
          const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
          const currentRuntimeEnv = liveSession.runtimeEnv;
          const targetCols = input.cols ?? liveSession.cols;
          const targetRows = input.rows ?? liveSession.rows;
          const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);

          if (liveSession.cwd !== input.cwd || runtimeEnvChanged) {
            yield* stopProcess(liveSession);
            liveSession.cwd = input.cwd;
            liveSession.worktreePath = input.worktreePath ?? null;
            liveSession.runtimeEnv = nextRuntimeEnv;
            liveSession.historyState = emptyHistoryBufferState();
            liveSession.pendingHistoryControlSequence = "";
            clearPendingProcessEvents(liveSession);
            yield* persistHistory(
              liveSession.threadId,
              liveSession.terminalId,
              liveSession.historyState.history,
            );
          } else if (liveSession.status === "exited" || liveSession.status === "error") {
            liveSession.runtimeEnv = nextRuntimeEnv;
            liveSession.worktreePath = input.worktreePath ?? null;
            liveSession.historyState = emptyHistoryBufferState();
            liveSession.pendingHistoryControlSequence = "";
            clearPendingProcessEvents(liveSession);
            yield* persistHistory(
              liveSession.threadId,
              liveSession.terminalId,
              liveSession.historyState.history,
            );
          }

          if (!liveSession.process) {
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
            return snapshot(liveSession);
          }

          if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
            liveSession.cols = targetCols;
            liveSession.rows = targetRows;
            liveSession.updatedAt = new Date().toISOString();
            liveSession.process.resize(targetCols, targetRows);
          }

          return snapshot(liveSession);
        }),
      );

    const write: TerminalManagerShape["write"] = Effect.fn("terminal.write")(function* (input) {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const session = yield* requireSession(input.threadId, terminalId);
      const process = session.process;
      if (!process || session.status !== "running") {
        if (session.status === "exited") return;
        return yield* new TerminalNotRunningError({
          threadId: input.threadId,
          terminalId,
        });
      }
      yield* Effect.sync(() => process.write(input.data));
    });

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
          session.historyState = emptyHistoryBufferState();
          session.pendingHistoryControlSequence = "";
          clearPendingProcessEvents(session);
          session.updatedAt = new Date().toISOString();
          const cursor = advanceCursor(session);
          yield* persistHistory(input.threadId, terminalId, session.historyState.history);
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
          yield* assertValidCwd(input.cwd);

          const sessionKey = toSessionKey(input.threadId, terminalId);
          const existingSession = yield* getSession(input.threadId, terminalId);
          let session: TerminalSessionState;
          if (Option.isNone(existingSession)) {
            const cols = input.cols ?? DEFAULT_OPEN_COLS;
            const rows = input.rows ?? DEFAULT_OPEN_ROWS;
            session = {
              threadId: input.threadId,
              terminalId,
              cwd: input.cwd,
              worktreePath: input.worktreePath ?? null,
              status: "starting",
              pid: null,
              historyState: emptyHistoryBufferState(),
              pendingHistoryControlSequence: "",
              pendingProcessEvents: [],
              pendingProcessEventIndex: 0,
              pendingProcessOutputBytes: 0,
              processEventDrainRunning: false,
              exitCode: null,
              exitSignal: null,
              updatedAt: new Date().toISOString(),
              cursor: nextCursor(),
              cols,
              rows,
              process: null,
              unsubscribeData: null,
              unsubscribeExit: null,
              hasRunningSubprocess: false,
              runtimeEnv: normalizedRuntimeEnv(input.env),
            };
            const createdSession = session;
            yield* modifyManagerState((state) => {
              const sessions = new Map(state.sessions);
              sessions.set(sessionKey, createdSession);
              return [undefined, { ...state, sessions }] as const;
            });
            yield* evictInactiveSessionsIfNeeded();
          } else {
            session = existingSession.value;
            yield* stopProcess(session);
            session.cwd = input.cwd;
            session.worktreePath = input.worktreePath ?? null;
            session.runtimeEnv = normalizedRuntimeEnv(input.env);
          }

          const cols = input.cols ?? session.cols;
          const rows = input.rows ?? session.rows;

          session.historyState = emptyHistoryBufferState();
          session.pendingHistoryControlSequence = "";
          clearPendingProcessEvents(session);
          yield* persistHistory(input.threadId, terminalId, session.historyState.history);
          yield* startSession(
            session,
            {
              threadId: input.threadId,
              terminalId,
              cwd: input.cwd,
              ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
              cols,
              rows,
              ...(input.env ? { env: input.env } : {}),
            },
            "restarted",
          );
          return snapshot(session);
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
