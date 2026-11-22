/**
 * AgentTerminals - what `ryco_terminal` knows about the terminals agents use: a rendered mirror
 * of each one (`mirror.ts`), the command running in it and the last one, and where each thread
 * last read it.
 *
 * Only terminals an agent touches get a mirror: it starts from the terminal's retained history
 * and then follows its raw output (Ryco's shell marks included, which clients and the history
 * never get). For every other terminal an output chunk costs one map lookup here. A mirror parses
 * off the output path, in slices, and is dropped after {@link MIRROR_IDLE_MS} without use (at
 * most {@link MAX_MIRRORS} at once), never while a wait or a hand-off holds it.
 *
 * What a thread read last and the agent's commands are kept as output cursor positions, outside
 * the mirror: a mirror rebuilt from the history puts them back at the same output, so `new`
 * output and a command's output survive the rebuild.
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

import type {
  TerminalAgentOutput,
  TerminalManagerShape,
  TerminalSessionInspection,
} from "../Services/Manager.ts";
import {
  assessActivity,
  looksLikeShellPrompt,
  type Activity,
  type TtyInputMode,
} from "./activity.ts";
import { TerminalMirror, type Mark, type Region } from "./mirror.ts";

/**
 * A mirror the agent has not used this long is dropped, also while a command runs (it would
 * otherwise parse that command's output for good); the next call rebuilds it from the history.
 */
export const MIRROR_IDLE_MS = 10 * 60_000;
export const MAX_MIRRORS = 8;
/** How often idle mirrors are looked for, besides on every use. */
const SWEEP_EVERY_MS = 60_000;
/**
 * Scrollback of a mirror. The terminal manager keeps more history (5,000 lines); paging a
 * longer output says its start is gone. About 4 MB per busy 120-column mirror, 7.4 MB at most.
 */
export const MIRROR_SCROLLBACK = 2_000;
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
  /** The output cursor when it started: where its output begins, also after a rebuild. */
  readonly startSequence: number;
  /** Where the screen was when it started: its output when the shell marks no start. */
  startMark: Mark;
  /** Its start is not in the mirror (it began before the history the mirror holds). */
  startLost: boolean;
  region: Region | undefined;
  ended: boolean;
  endedAt: number | undefined;
  exitCode: number | undefined;
  /** How the end is known: the shell's mark, a guess, or the shell exited. */
  endedBy: "mark" | "guess" | "exit" | undefined;
  /** The output cursor when it ended. */
  endSequence: number | undefined;
  endMark: Mark | undefined;
}

/** What outlives a mirror: commands and read positions as output cursors. */
interface TerminalRecord {
  current: Execution | undefined;
  last: Execution | undefined;
  /** Each thread's read position, as the output cursor it had read up to. */
  readonly readSequences: Map<string, number>;
  /** The last execution each thread was told has ended. */
  readonly reportedEnd: Map<string, number>;
  /** Waits and hand-offs holding the mirror: it is never dropped while held. */
  pins: number;
}

export interface TrackedTerminal {
  readonly ref: TerminalRef;
  readonly key: string;
  readonly mirror: TerminalMirror;
  /** Hydrating: history is being parsed; live input waits in `pending`. */
  state: "hydrating" | "live" | "disposed";
  pending: Array<PendingInput>;
  /** Output at or before this cursor sequence is already in the replayed history. */
  baseSequence: number;
  /** The cursor of the last output the mirror got. */
  lastSequence: number;
  readonly record: TerminalRecord;
  /** The record's running command and last one (they outlive the mirror). */
  readonly current: Execution | undefined;
  readonly last: Execution | undefined;
  /** Where each thread last read this terminal in this mirror: `new` output is what follows. */
  readonly marks: Map<string, Mark>;
  lastUsedAt: number;
  exited: boolean;
  hasRunningSubprocess: boolean;
  readonly wakers: Set<() => void>;
}

type PendingInput =
  | { readonly kind: "event"; readonly event: TerminalEvent }
  | { readonly kind: "output"; readonly output: TerminalAgentOutput };

/** The mirror limit is reached and every mirror is held by a wait or a hand-off. */
export class MirrorLimitError {
  readonly _tag = "MirrorLimitError";
  readonly held: ReadonlyArray<string>;
  constructor(held: ReadonlyArray<string>) {
    this.held = held;
  }
}

export interface AgentTerminalsDeps {
  readonly terminals: Pick<
    TerminalManagerShape,
    | "subscribe"
    | "inspect"
    | "verifyIdle"
    | "readInputMode"
    | "historySince"
    | "subscribeAgentOutput"
  >;
  readonly now?: () => number;
}

const keyOf = (ref: TerminalRef) => `${ref.threadId}\u0000${ref.terminalId}`;
/** Records of terminals without a mirror kept at once (commands and read positions). */
const MAX_RECORDS = 256;

export interface OutputLines {
  readonly lines: ReadonlyArray<string>;
  readonly startLost: boolean;
}

export type AgentTerminals = Effect.Success<ReturnType<typeof makeAgentTerminals>>;

export const makeAgentTerminals = (deps: AgentTerminalsDeps) =>
  Effect.gen(function* () {
    const now = deps.now ?? Date.now;
    const tracked = new Map<string, TrackedTerminal>();
    const records = new Map<string, TerminalRecord>();
    let nextExecutionId = 1;
    const rawOutput = deps.terminals.subscribeAgentOutput !== undefined;

    const recordFor = (key: string): TerminalRecord => {
      let record = records.get(key);
      if (record === undefined) {
        record = {
          current: undefined,
          last: undefined,
          readSequences: new Map(),
          reportedEnd: new Map(),
          pins: 0,
        };
      } else {
        records.delete(key);
      }
      // Re-inserted so the map's order is least recently used first.
      records.set(key, record);
      while (records.size > MAX_RECORDS) {
        const oldest = [...records].find(
          ([candidate, entry]) => entry.pins === 0 && !tracked.has(candidate),
        );
        if (oldest === undefined) break;
        records.delete(oldest[0]);
      }
      return record;
    };

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
      execution.endSequence = t.lastSequence;
      execution.endMark = t.mirror.mark({ exact: true });
      if (t.record.current === execution) {
        t.record.current = undefined;
        t.record.last = execution;
      }
      wake(t);
    };

    const writeOutput = (t: TrackedTerminal, output: TerminalAgentOutput) => {
      if (output.cursor.sequence <= t.baseSequence) return;
      // A restarted shell marks with its new spawn's nonce.
      t.mirror.setMarkNonce(output.markNonce ?? undefined);
      t.mirror.write(output.data);
      t.lastSequence = output.cursor.sequence;
    };

    const handleEvent = (t: TrackedTerminal, event: TerminalEvent) => {
      switch (event.type) {
        case "output":
          // Without the raw channel (older managers, tests), events carry the output.
          if (rawOutput) return;
          if (event.cursor !== undefined && event.cursor.sequence <= t.baseSequence) return;
          t.mirror.write(event.data);
          if (event.cursor !== undefined) t.lastSequence = event.cursor.sequence;
          return;
        case "started":
        case "restarted":
          if (t.record.current !== undefined) {
            endExecution(t, t.record.current, undefined, "exit");
          }
          t.exited = false;
          t.mirror.reset();
          t.marks.clear();
          t.record.readSequences.clear();
          if (event.snapshot.history.length > 0) t.mirror.replay(event.snapshot.history, false);
          t.baseSequence = event.snapshot.cursor?.sequence ?? event.cursor?.sequence ?? 0;
          t.lastSequence = t.baseSequence;
          wake(t);
          return;
        case "cleared":
          t.mirror.reset();
          t.marks.clear();
          if (t.record.current !== undefined) t.record.current.region = undefined;
          wake(t);
          return;
        case "exited":
          t.exited = true;
          t.hasRunningSubprocess = false;
          if (t.record.current !== undefined) {
            endExecution(t, t.record.current, event.exitCode ?? undefined, "exit");
          }
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

    const route = (key: string, input: PendingInput) => {
      const t = tracked.get(key);
      if (t === undefined) return;
      if (t.state === "hydrating") {
        t.pending.push(input);
        return;
      }
      if (t.state !== "live") return;
      if (input.kind === "output") writeOutput(t, input.output);
      else handleEvent(t, input.event);
    };

    const unsubscribe = yield* deps.terminals.subscribe((event) =>
      Effect.sync(() => route(keyOf(event), { kind: "event", event })),
    );
    const unsubscribeOutput =
      deps.terminals.subscribeAgentOutput === undefined
        ? () => undefined
        : yield* deps.terminals.subscribeAgentOutput((output) =>
            route(keyOf(output), { kind: "output", output }),
          );
    const sweepTimer = setInterval(() => sweep(), SWEEP_EVERY_MS);
    sweepTimer.unref?.();

    const close = () => {
      clearInterval(sweepTimer);
      unsubscribe();
      unsubscribeOutput();
      for (const t of tracked.values()) dispose(t);
      tracked.clear();
    };

    const dispose = (t: TrackedTerminal) => {
      t.state = "disposed";
      t.mirror.dispose();
      wake(t);
      t.wakers.clear();
    };

    const evict = (t: TrackedTerminal) => {
      tracked.delete(t.key);
      dispose(t);
    };

    /** Drops mirrors unused for a while; never one a wait or hand-off holds. */
    const sweep = () => {
      const at = now();
      for (const t of [...tracked.values()]) {
        if (t.record.pins === 0 && at - t.lastUsedAt > MIRROR_IDLE_MS) evict(t);
      }
    };

    /** Room for one more mirror: the least recently used free one goes, or the limit holds. */
    const makeRoom = (): Effect.Effect<void, MirrorLimitError> =>
      Effect.suspend(() => {
        if (tracked.size < MAX_MIRRORS) return Effect.void;
        const free = [...tracked.values()]
          .filter((t) => t.record.pins === 0)
          .toSorted((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
        if (free !== undefined) {
          evict(free);
          return Effect.void;
        }
        return Effect.fail(
          new MirrorLimitError([...tracked.values()].map((t) => t.ref.terminalId)),
        );
      });

    const inspect = (ref: TerminalRef): Effect.Effect<Option.Option<TerminalSessionInspection>> =>
      deps.terminals.inspect === undefined
        ? Effect.succeed(Option.none())
        : deps.terminals.inspect(ref);

    /** Where output cursor `sequence` falls in `history` (a character offset); undefined when lost. */
    const offsetOf = (ref: TerminalRef, history: string, sequence: number) =>
      Effect.gen(function* () {
        if (deps.terminals.historySince === undefined) return undefined;
        const since = yield* deps.terminals.historySince(ref, sequence);
        if (Option.isNone(since) || since.value === null) return undefined;
        const offset = history.length - since.value.length;
        return offset >= 0 && history.endsWith(since.value) ? offset : undefined;
      });

    /**
     * The terminal's mirror, built from its retained history on first use (or after it was
     * dropped, with the record's read positions and commands put back); `none` for a terminal
     * the manager does not know.
     */
    const track = (
      ref: TerminalRef,
    ): Effect.Effect<Option.Option<TrackedTerminal>, MirrorLimitError> =>
      Effect.gen(function* () {
        const key = keyOf(ref);
        const existing = tracked.get(key);
        if (existing !== undefined && existing.state !== "disposed") {
          existing.lastUsedAt = now();
          sweep();
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
        sweep();
        yield* makeRoom();
        const { snapshot } = inspection.value;
        const record = recordFor(key);
        const t: TrackedTerminal = {
          ref,
          key,
          mirror: new TerminalMirror({
            cols: inspection.value.cols,
            rows: inspection.value.rows,
            scrollback: MIRROR_SCROLLBACK,
            now,
            markNonce: inspection.value.markNonce,
          }),
          state: "hydrating",
          pending: [],
          baseSequence: snapshot.cursor?.sequence ?? 0,
          lastSequence: snapshot.cursor?.sequence ?? 0,
          record,
          get current() {
            return record.current;
          },
          get last() {
            return record.last;
          },
          marks: new Map(),
          lastUsedAt: now(),
          exited: snapshot.status === "exited" || snapshot.status === "error",
          hasRunningSubprocess: inspection.value.hasRunningSubprocess,
          wakers: new Set(),
        };
        // Registered before the history is read back, so no output falls between the two.
        tracked.set(key, t);
        t.mirror.listen({
          onRegionStart: (region) => {
            if (t.state !== "live") return;
            const current = t.record.current;
            if (current !== undefined && !current.ended) {
              if (current.startedBy === "agent" && current.region === undefined) {
                current.region = region;
              }
              return;
            }
            t.record.current = newExecution(t, undefined, "user", region);
            wake(t);
          },
          onCommandEnd: (exitCode, region) => {
            if (t.state !== "live") return;
            const current = t.record.current;
            if (current === undefined || current.ended) return;
            // A region this execution never took started before it: the end of the command
            // before, not of this one.
            if (region !== undefined && current.region !== region) return;
            endExecution(t, current, exitCode, "mark");
          },
          onParsed: () => wake(t),
        });
        // Fresh, so the history matches its cursor. Ryco's marks are not in it (the manager
        // never stores them): what ran while there was no mirror comes from the shell's state.
        const fresh = Option.getOrElse(yield* inspect(ref), () => inspection.value);
        const history = fresh.snapshot.history;
        t.baseSequence = fresh.snapshot.cursor?.sequence ?? t.baseSequence;
        t.lastSequence = t.baseSequence;
        yield* replayWithPositions(t, history);
        restoreCommands(t, fresh);
        t.state = "live";
        const pending = t.pending;
        t.pending = [];
        for (const input of pending) {
          if (input.kind === "output") writeOutput(t, input.output);
          else handleEvent(t, input.event);
        }
        yield* Effect.promise(() => t.mirror.flush());
        return Option.some(t);
      });

    /**
     * Replays `history` into a new mirror, putting a mark at every output cursor the record
     * needs (each thread's read position, the commands' starts and ends).
     */
    const replayWithPositions = (t: TrackedTerminal, history: string) =>
      Effect.gen(function* () {
        const record = t.record;
        const wanted = new Set<number>();
        for (const sequence of record.readSequences.values()) wanted.add(sequence);
        for (const execution of [record.current, record.last]) {
          if (execution === undefined) continue;
          wanted.add(execution.startSequence);
          if (execution.endSequence !== undefined) wanted.add(execution.endSequence);
        }
        const offsets = new Map<number, number>();
        for (const sequence of wanted) {
          const offset = yield* offsetOf(t.ref, history, sequence);
          if (offset !== undefined) offsets.set(sequence, offset);
        }
        const marksAt = new Map<number, Mark>();
        let at = 0;
        for (const offset of [...new Set(offsets.values())].toSorted((a, b) => a - b)) {
          if (offset > at) t.mirror.replay(history.slice(at, offset), false);
          at = offset;
          yield* Effect.promise(() => t.mirror.flush());
          marksAt.set(offset, t.mirror.mark({ exact: true }));
        }
        if (at < history.length) t.mirror.replay(history.slice(at), false);
        yield* Effect.promise(() => t.mirror.flush());
        const markOf = (sequence: number): Mark | undefined => {
          const offset = offsets.get(sequence);
          return offset === undefined ? undefined : marksAt.get(offset);
        };
        for (const [threadId, sequence] of record.readSequences) {
          // A position the history no longer reaches: everything shown counts as new, its
          // start reported lost.
          t.marks.set(threadId, markOf(sequence) ?? LOST_MARK);
        }
        for (const execution of [record.current, record.last]) {
          if (execution === undefined) continue;
          const start = markOf(execution.startSequence);
          execution.startMark = start ?? LOST_MARK;
          execution.startLost = execution.startLost || start === undefined;
          execution.region = undefined;
          if (execution.endSequence !== undefined) {
            execution.endMark = markOf(execution.endSequence);
          }
        }
      });

    /** After a rebuild: how the record's command fared meanwhile, from the shell's marks. */
    const restoreCommands = (t: TrackedTerminal, inspection: TerminalSessionInspection) => {
      const shell = inspection.shell;
      const current = t.record.current;
      if (current !== undefined && !current.ended && shell !== undefined) {
        if (shell.lastEnd !== null && shell.lastEnd.sequence > current.startSequence) {
          endExecution(t, current, shell.lastEnd.exitCode ?? undefined, "mark");
          current.endSequence = shell.lastEnd.sequence;
        } else if (shell.atPrompt) {
          endExecution(t, current, undefined, "mark");
        }
      }
      // A command the user started before this mirror: its start is not here.
      if (
        t.record.current === undefined &&
        shell !== undefined &&
        shell.promptSeen &&
        !shell.atPrompt
      ) {
        const execution = newExecution(t, undefined, "user", undefined);
        execution.startLost = true;
        t.record.current = execution;
      }
    };

    const newExecution = (
      t: TrackedTerminal,
      commandLine: string | undefined,
      startedBy: Execution["startedBy"],
      region: Region | undefined,
    ): Execution => ({
      id: nextExecutionId++,
      commandLine: commandLine ?? region?.commandLine,
      startedBy,
      startedAt: now(),
      startSequence: t.lastSequence,
      startMark: t.mirror.mark({ exact: startedBy === "agent" }),
      startLost: false,
      region,
      ended: false,
      endedAt: undefined,
      exitCode: undefined,
      endedBy: undefined,
      endSequence: undefined,
      endMark: undefined,
    });

    /** Keeps `ref`'s mirror (and record) from being dropped until the returned release runs. */
    const pin = (ref: TerminalRef): (() => void) => {
      const record = recordFor(keyOf(ref));
      record.pins += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        record.pins = Math.max(0, record.pins - 1);
      };
    };

    /** Wakes when `t` changes (parsed output, a command's end, process activity). */
    const changed = (t: TrackedTerminal) =>
      Effect.callback<void>((resume) => {
        const waker = () => resume(Effect.void);
        t.wakers.add(waker);
        return Effect.sync(() => {
          t.wakers.delete(waker);
        });
      });

    /**
     * Runs `check` on every change and at least every {@link WAIT_POLL_MS} until true or
     * timeout. The mirror is held for the whole wait.
     */
    const waitUntil = <E, R>(
      t: TrackedTerminal,
      check: Effect.Effect<boolean, E, R>,
      timeoutMs: number,
    ): Effect.Effect<boolean, E, R> =>
      Effect.acquireUseRelease(
        Effect.sync(() => pin(t.ref)),
        () =>
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
          }),
        (release) => Effect.sync(release),
      );

    /**
     * Until `t`'s mirror has parsed the output up to `sequence` (the manager's cursor when its
     * shell state was read), so the marks that state counted are in the mirror too: the manager
     * reads them first, the mirror parses them later. False when that did not happen in time.
     */
    const catchUp = (t: TrackedTerminal, sequence: number, timeoutMs: number) =>
      Effect.gen(function* () {
        const reached = yield* waitUntil(
          t,
          Effect.sync(() => t.lastSequence >= sequence),
          timeoutMs,
        );
        if (reached) yield* Effect.promise(() => t.mirror.flush());
        return reached;
      });

    const isRunning = (t: TrackedTerminal) =>
      (t.record.current !== undefined && !t.record.current.ended) ||
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
        const execution = t.record.current;
        // Only what the running command printed: an earlier command's prompt, link or code still
        // on screen is not this one's. Without a tracked command, the screen.
        const tail =
          execution !== undefined && !execution.ended
            ? outputOf(t, execution)
                .lines.filter((line) => line.trim() !== "")
                .slice(-8)
            : t.mirror.tail(8);
        return assessActivity({
          running,
          quietMs: quiet,
          beforeCursor,
          afterCursor,
          tail,
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
      const execution = newExecution(t, commandLine, "agent", undefined);
      if (t.record.current !== undefined && !t.record.current.ended) {
        endExecution(t, t.record.current, undefined, "guess");
      }
      t.record.current = execution;
      return execution;
    };

    /** Withdraws an execution whose command never reached the shell. */
    const abandonExecution = (t: TrackedTerminal, execution: Execution) => {
      if (t.record.current === execution) t.record.current = undefined;
    };

    const outputOf = (t: TrackedTerminal, execution: Execution): OutputLines => {
      if (execution.region !== undefined) {
        const result = t.mirror.regionLines(execution.region);
        return execution.startLost ? { ...result, startLost: true } : result;
      }
      const result = t.mirror.linesBetween(
        execution.startLost ? undefined : execution.startMark,
        execution.ended ? execution.endMark : undefined,
      );
      return execution.startLost ? { ...result, startLost: true } : result;
    };

    const readNew = (t: TrackedTerminal, threadId: string): OutputLines => {
      const result = t.mirror.linesSince(t.marks.get(threadId));
      t.marks.set(threadId, t.mirror.mark());
      t.record.readSequences.set(threadId, t.lastSequence);
      return result;
    };

    /** After a thread read an execution's output: what follows it is new. */
    const markRead = (t: TrackedTerminal, threadId: string, execution: Execution | undefined) => {
      const afterRegion =
        execution?.ended === true && execution.region !== undefined
          ? t.mirror.markAfter(execution.region)
          : undefined;
      t.marks.set(threadId, afterRegion ?? t.mirror.mark());
      t.record.readSequences.set(
        threadId,
        execution?.ended === true && execution.endSequence !== undefined
          ? execution.endSequence
          : t.lastSequence,
      );
    };

    /** A finished execution `threadId` has not been told about; claims it. */
    const takeUnreportedEnd = (t: TrackedTerminal, threadId: string): Execution | undefined => {
      const last = t.record.last;
      if (last === undefined || !last.ended || t.record.reportedEnd.get(threadId) === last.id) {
        return undefined;
      }
      t.record.reportedEnd.set(threadId, last.id);
      return last;
    };

    const noteReported = (t: TrackedTerminal, threadId: string, execution: Execution) => {
      if (execution.ended) t.record.reportedEnd.set(threadId, execution.id);
    };

    const find = (ref: TerminalRef): TrackedTerminal | undefined => {
      const t = tracked.get(keyOf(ref));
      return t?.state === "live" ? t : undefined;
    };

    /** Drops a terminal's mirror and record (its session closed). */
    const forget = (ref: TerminalRef) => {
      const key = keyOf(ref);
      records.delete(key);
      const t = tracked.get(key);
      if (t === undefined) return;
      evict(t);
    };

    return {
      track,
      find,
      forget,
      pin,
      waitUntil,
      isRunning,
      quietMs,
      activityOf,
      fallbackEnded,
      beginExecution,
      catchUp,
      abandonExecution,
      endExecution,
      outputOf,
      readNew,
      markRead,
      takeUnreportedEnd,
      noteReported,
      inspect,
      readInputMode,
      close,
      mirrorCount: () => tracked.size,
    };
  });

/** A read position the history no longer reaches. */
const LOST_MARK: Mark = { marker: undefined, col: 0, alternate: false, skips: 0 };
