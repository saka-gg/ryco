/**
 * AgentTerminals - what `ryco_terminal` knows about the terminals agents use: a rendered mirror
 * of each one (`mirror.ts`), the command running in it and the last one, and where each thread
 * last read it.
 *
 * Only terminals an agent touches get a mirror: it starts from the terminal's retained history
 * and then follows its output events. The terminal manager's output path does not change; for
 * every other terminal its event costs one map lookup here. A mirror parses off that path, in
 * slices, and is dropped after {@link MIRROR_IDLE_MS} without use (at most
 * {@link MAX_MIRRORS} at once).
 *
 * Commands end when the shell marks it (OSC 133;D, with the exit code), or, in a shell without
 * marks, when the output went quiet at a shell prompt and the process table shows the shell
 * idle again (exit code unknown).
 *
 * Loaded with the `ryco_terminal` tool, never at boot.
 *
 * @module terminal/agent/AgentTerminals
 */
import type { TerminalEvent, TerminalRef } from "@ryco/contracts";
import { Effect, Option } from "effect";

import type { TerminalManagerShape, TerminalSessionInspection } from "../Services/Manager.ts";
import {
  assessActivity,
  looksLikeShellPrompt,
  type Activity,
  type TtyInputMode,
} from "./activity.ts";
import { TerminalMirror, type Mark, type Region } from "./mirror.ts";

/** A mirror unused this long is dropped (and rebuilt from history on next use). */
export const MIRROR_IDLE_MS = 15 * 60_000;
export const MAX_MIRRORS = 16;
/** Scrollback of a mirror: the lines the terminal manager retains by default. */
export const MIRROR_SCROLLBACK = 5_000;
/** Output quiet this long at a shell prompt ends a command in a shell without marks. */
const FALLBACK_QUIET_MS = 500;
/** A wait re-checks at least this often without a wake. */
const WAIT_POLL_MS = 250;

export interface Execution {
  readonly id: number;
  /** What the agent ran; `undefined` for a command the user typed. */
  readonly commandLine: string | undefined;
  readonly startedBy: "agent" | "user";
  readonly startedAt: number;
  /** Where the screen was when it started: its output when the shell marks no start. */
  readonly startMark: Mark;
  region: Region | undefined;
  ended: boolean;
  endedAt: number | undefined;
  exitCode: number | undefined;
  /** How the end is known: the shell's mark, a guess, or the shell exited. */
  endedBy: "mark" | "guess" | "exit" | undefined;
}

export interface TrackedTerminal {
  readonly ref: TerminalRef;
  readonly key: string;
  readonly mirror: TerminalMirror;
  /** Hydrating: history is being parsed; live events wait in `pending`. */
  state: "hydrating" | "live" | "disposed";
  pending: Array<TerminalEvent>;
  /** Output events at or before this cursor sequence are already in the replayed history. */
  baseSequence: number;
  current: Execution | undefined;
  last: Execution | undefined;
  /** Where each thread last read this terminal: `new` output is what follows. */
  readonly marks: Map<string, Mark>;
  /** The last execution each thread was told has ended. */
  readonly reportedEnd: Map<string, number>;
  lastUsedAt: number;
  exited: boolean;
  hasRunningSubprocess: boolean;
  readonly wakers: Set<() => void>;
}

export interface AgentTerminalsDeps {
  readonly terminals: Pick<
    TerminalManagerShape,
    "subscribe" | "inspect" | "verifyIdle" | "readInputMode"
  >;
  readonly now?: () => number;
}

const keyOf = (ref: TerminalRef) => `${ref.threadId}\u0000${ref.terminalId}`;

export interface OutputLines {
  readonly lines: ReadonlyArray<string>;
  readonly startLost: boolean;
}

export type AgentTerminals = Effect.Success<ReturnType<typeof makeAgentTerminals>>;

export const makeAgentTerminals = (deps: AgentTerminalsDeps) =>
  Effect.gen(function* () {
    const now = deps.now ?? Date.now;
    const tracked = new Map<string, TrackedTerminal>();
    let nextExecutionId = 1;

    const wake = (t: TrackedTerminal) => {
      for (const waker of t.wakers) waker();
    };

    const endExecution = (
      t: TrackedTerminal,
      execution: Execution,
      exitCode: number | undefined,
      endedBy: NonNullable<Execution["endedBy"]>,
    ) => {
      if (execution.ended) return;
      execution.ended = true;
      execution.endedAt = now();
      execution.exitCode = exitCode;
      execution.endedBy = endedBy;
      if (t.current === execution) {
        t.current = undefined;
        t.last = execution;
      }
      wake(t);
    };

    const handleEvent = (t: TrackedTerminal, event: TerminalEvent) => {
      switch (event.type) {
        case "output":
          if (event.cursor !== undefined && event.cursor.sequence <= t.baseSequence) return;
          t.mirror.write(event.data);
          return;
        case "started":
        case "restarted":
          if (t.current !== undefined) endExecution(t, t.current, undefined, "exit");
          t.exited = false;
          t.mirror.reset();
          t.marks.clear();
          if (event.snapshot.history.length > 0) t.mirror.replay(event.snapshot.history, false);
          t.baseSequence = event.snapshot.cursor?.sequence ?? event.cursor?.sequence ?? 0;
          wake(t);
          return;
        case "cleared":
          t.mirror.reset();
          t.marks.clear();
          if (t.current !== undefined) t.current.region = undefined;
          wake(t);
          return;
        case "exited":
          t.exited = true;
          t.hasRunningSubprocess = false;
          if (t.current !== undefined)
            endExecution(t, t.current, event.exitCode ?? undefined, "exit");
          t.mirror.closeOpenRegion();
          wake(t);
          return;
        case "activity":
          t.hasRunningSubprocess = event.hasRunningSubprocess;
          wake(t);
          return;
        case "error":
          wake(t);
          return;
      }
    };

    const unsubscribe = yield* deps.terminals.subscribe((event) =>
      Effect.sync(() => {
        const t = tracked.get(keyOf(event));
        if (t === undefined) return;
        if (t.state === "hydrating") {
          t.pending.push(event);
          return;
        }
        if (t.state === "live") handleEvent(t, event);
      }),
    );
    const close = () => {
      unsubscribe();
      for (const t of tracked.values()) dispose(t);
      tracked.clear();
    };

    const dispose = (t: TrackedTerminal) => {
      t.state = "disposed";
      t.mirror.dispose();
      wake(t);
      t.wakers.clear();
    };

    const sweep = () => {
      const at = now();
      for (const [key, t] of tracked) {
        const busy = t.current !== undefined && !t.current.ended;
        if (!busy && at - t.lastUsedAt > MIRROR_IDLE_MS) {
          tracked.delete(key);
          dispose(t);
        }
      }
      if (tracked.size <= MAX_MIRRORS) return;
      const byAge = [...tracked.values()].toSorted((a, b) => a.lastUsedAt - b.lastUsedAt);
      for (const t of byAge.slice(0, tracked.size - MAX_MIRRORS)) {
        tracked.delete(t.key);
        dispose(t);
      }
    };

    const inspect = (ref: TerminalRef): Effect.Effect<Option.Option<TerminalSessionInspection>> =>
      deps.terminals.inspect === undefined
        ? Effect.succeed(Option.none())
        : deps.terminals.inspect(ref);

    /**
     * The terminal's mirror, built from its retained history on first use; `none` for a terminal
     * the manager does not know.
     */
    const track = (ref: TerminalRef): Effect.Effect<Option.Option<TrackedTerminal>> =>
      Effect.gen(function* () {
        const key = keyOf(ref);
        const existing = tracked.get(key);
        if (existing !== undefined && existing.state !== "disposed") {
          existing.lastUsedAt = now();
          // The user may have resized the terminal since; output after a resize wraps anew.
          const current = yield* inspect(ref);
          if (Option.isSome(current)) {
            existing.mirror.resize(current.value.cols, current.value.rows);
            existing.hasRunningSubprocess = current.value.hasRunningSubprocess;
          }
          yield* Effect.promise(() => existing.mirror.flush());
          return Option.some(existing);
        }
        const inspection = yield* inspect(ref);
        if (Option.isNone(inspection)) return Option.none();
        const { snapshot } = inspection.value;
        const t: TrackedTerminal = {
          ref,
          key,
          mirror: new TerminalMirror({
            cols: inspection.value.cols,
            rows: inspection.value.rows,
            scrollback: MIRROR_SCROLLBACK,
            now,
          }),
          state: "hydrating",
          pending: [],
          baseSequence: snapshot.cursor?.sequence ?? 0,
          current: undefined,
          last: undefined,
          marks: new Map(),
          reportedEnd: new Map(),
          lastUsedAt: now(),
          exited: snapshot.status === "exited" || snapshot.status === "error",
          hasRunningSubprocess: inspection.value.hasRunningSubprocess,
          wakers: new Set(),
        };
        // Registered before the history is read back, so no event falls between the two.
        tracked.set(key, t);
        t.mirror.listen({
          onRegionStart: (region) => {
            if (t.state !== "live") return;
            const current = t.current;
            if (current !== undefined && !current.ended) {
              if (current.startedBy === "agent" && current.region === undefined)
                current.region = region;
              return;
            }
            t.current = {
              id: nextExecutionId++,
              commandLine: region.commandLine,
              startedBy: "user",
              startedAt: now(),
              startMark: t.mirror.mark(),
              region,
              ended: false,
              endedAt: undefined,
              exitCode: undefined,
              endedBy: undefined,
            };
            wake(t);
          },
          onCommandEnd: (exitCode, region) => {
            if (t.state !== "live") return;
            const current = t.current;
            if (current === undefined || current.ended) return;
            if (region !== undefined && current.region !== undefined && current.region !== region)
              return;
            endExecution(t, current, exitCode, "mark");
          },
          onParsed: () => wake(t),
        });
        // Fresh, so the inspection's history matches its cursor.
        const fresh = yield* inspect(ref);
        const history = Option.isSome(fresh) ? fresh.value.snapshot.history : snapshot.history;
        t.baseSequence = Option.isSome(fresh)
          ? (fresh.value.snapshot.cursor?.sequence ?? t.baseSequence)
          : t.baseSequence;
        if (history.length > 0) t.mirror.replay(history, false);
        yield* Effect.promise(() => t.mirror.flush());
        // A command open at the end of the history (a mark without its end) is the user's, or
        // ended without a mark the history kept: only a running subprocess says which.
        const open = t.mirror.currentRegion;
        if (open !== undefined && !open.ended) {
          if (t.hasRunningSubprocess) {
            t.current = {
              id: nextExecutionId++,
              commandLine: open.commandLine,
              startedBy: "user",
              startedAt: now(),
              startMark: t.mirror.mark(),
              region: open,
              ended: false,
              endedAt: undefined,
              exitCode: undefined,
              endedBy: undefined,
            };
          } else {
            t.mirror.closeOpenRegion();
          }
        }
        t.state = "live";
        const pending = t.pending;
        t.pending = [];
        for (const event of pending) handleEvent(t, event);
        yield* Effect.promise(() => t.mirror.flush());
        sweep();
        return Option.some(t);
      });

    /** Wakes when `t` changes (parsed output, a command's end, process activity). */
    const changed = (t: TrackedTerminal) =>
      Effect.callback<void>((resume) => {
        const waker = () => resume(Effect.void);
        t.wakers.add(waker);
        return Effect.sync(() => {
          t.wakers.delete(waker);
        });
      });

    /** Runs `check` on every change and at least every {@link WAIT_POLL_MS} until true or timeout. */
    const waitUntil = <E, R>(
      t: TrackedTerminal,
      check: Effect.Effect<boolean, E, R>,
      timeoutMs: number,
    ): Effect.Effect<boolean, E, R> =>
      Effect.gen(function* () {
        const deadline = now() + Math.max(0, timeoutMs);
        while (true) {
          if (t.state === "disposed") return false;
          yield* Effect.promise(() => t.mirror.flush());
          if (yield* check) return true;
          const left = deadline - now();
          if (left <= 0) return false;
          yield* Effect.raceFirst(Effect.sleep(Math.min(WAIT_POLL_MS, left)), changed(t));
        }
      });

    const isRunning = (t: TrackedTerminal) =>
      (t.current !== undefined && !t.current.ended) ||
      (!t.mirror.shellIntegration && t.hasRunningSubprocess);

    const quietMs = (t: TrackedTerminal) => now() - t.mirror.lastWriteAt;

    const readInputMode = (t: TrackedTerminal): Effect.Effect<TtyInputMode | undefined> =>
      deps.terminals.readInputMode === undefined
        ? Effect.succeed(undefined)
        : deps.terminals.readInputMode(t.ref).pipe(Effect.map(Option.getOrUndefined));

    /** What the running command does now; reads the tty's flags only once output paused. */
    const activityOf = (t: TrackedTerminal): Effect.Effect<Activity> =>
      Effect.gen(function* () {
        const running = isRunning(t);
        const quiet = quietMs(t);
        const inputMode = running && quiet >= 300 ? yield* readInputMode(t) : undefined;
        const { beforeCursor, afterCursor } = t.mirror.cursorLine();
        const execution = t.current;
        return assessActivity({
          running,
          quietMs: quiet,
          beforeCursor,
          afterCursor,
          tail: t.mirror.tail(8),
          alternate: t.mirror.alternate,
          outputSinceStart: execution === undefined || t.mirror.lastWriteAt >= execution.startedAt,
          inputMode,
        });
      });

    /** In a shell without marks: is it back at its prompt, with nothing running? */
    const fallbackEnded = (t: TrackedTerminal, execution: Execution) =>
      Effect.gen(function* () {
        if (t.mirror.shellIntegration || execution.ended) return execution.ended;
        if (quietMs(t) < FALLBACK_QUIET_MS || t.mirror.alternate) return false;
        const { beforeCursor, afterCursor } = t.mirror.cursorLine();
        if (!looksLikeShellPrompt(beforeCursor, afterCursor)) return false;
        const idle =
          deps.terminals.verifyIdle === undefined
            ? !t.hasRunningSubprocess
            : yield* deps.terminals.verifyIdle(t.ref);
        if (idle) endExecution(t, execution, undefined, "guess");
        return idle;
      });

    /** Starts tracking an agent command typed now. */
    const beginExecution = (t: TrackedTerminal, commandLine: string): Execution => {
      const execution: Execution = {
        id: nextExecutionId++,
        commandLine,
        startedBy: "agent",
        startedAt: now(),
        startMark: t.mirror.mark({ exact: true }),
        region: undefined,
        ended: false,
        endedAt: undefined,
        exitCode: undefined,
        endedBy: undefined,
      };
      if (t.current !== undefined && !t.current.ended)
        endExecution(t, t.current, undefined, "guess");
      t.current = execution;
      return execution;
    };

    /** Withdraws an execution whose command never reached the shell. */
    const abandonExecution = (t: TrackedTerminal, execution: Execution) => {
      if (t.current === execution) t.current = undefined;
    };

    const outputOf = (t: TrackedTerminal, execution: Execution): OutputLines =>
      execution.region !== undefined
        ? t.mirror.regionLines(execution.region)
        : t.mirror.linesSince(execution.startMark);

    const readNew = (t: TrackedTerminal, threadId: string): OutputLines => {
      const result = t.mirror.linesSince(t.marks.get(threadId));
      t.marks.set(threadId, t.mirror.mark());
      return result;
    };

    /** After a thread read an execution's output: what follows it is new. */
    const markRead = (t: TrackedTerminal, threadId: string, execution: Execution | undefined) => {
      t.marks.set(
        threadId,
        execution?.ended === true && execution.region !== undefined
          ? t.mirror.markAfter(execution.region)
          : t.mirror.mark(),
      );
    };

    /** A finished execution `threadId` has not been told about; claims it. */
    const takeUnreportedEnd = (t: TrackedTerminal, threadId: string): Execution | undefined => {
      const last = t.last;
      if (last === undefined || !last.ended || t.reportedEnd.get(threadId) === last.id)
        return undefined;
      t.reportedEnd.set(threadId, last.id);
      return last;
    };

    const noteReported = (t: TrackedTerminal, threadId: string, execution: Execution) => {
      if (execution.ended) t.reportedEnd.set(threadId, execution.id);
    };

    const find = (ref: TerminalRef): TrackedTerminal | undefined => {
      const t = tracked.get(keyOf(ref));
      return t?.state === "live" ? t : undefined;
    };

    /** Drops a terminal's mirror (its session closed). */
    const forget = (ref: TerminalRef) => {
      const t = tracked.get(keyOf(ref));
      if (t === undefined) return;
      tracked.delete(t.key);
      dispose(t);
    };

    return {
      track,
      find,
      forget,
      waitUntil,
      isRunning,
      quietMs,
      activityOf,
      fallbackEnded,
      beginExecution,
      abandonExecution,
      endExecution,
      outputOf,
      readNew,
      markRead,
      takeUnreportedEnd,
      noteReported,
      inspect,
      close,
      mirrorCount: () => tracked.size,
    };
  });
