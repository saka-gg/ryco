/**
 * Command watches at work: the scheduler that looks at watched chats, the runner that executes a
 * watch's command, the wake that tells the agent, and starting and stopping a watch. Loaded
 * through `import()` by `CommandWatchService` once commands are admitted (or on the first call),
 * so none of it, nor the run rules (`@ryco/shared/commandWatch`), is on the boot path. Ports T3
 * Code's `CommandWatchReactor` onto Ryco's pull request watch path: every change is one
 * revision-fenced `thread.command-watch.update`, and a wake is that update's nested queued turn
 * start, behind the shared server wake fence.
 *
 * Per look (every 30 s while any watch exists, 5 minutes while none does, at once when a watch
 * changes), and per watched chat, at most one run at a time, at most 4 across the node:
 *
 * 1. The chat must still be live, unarchived, unsettled, in Full access and default mode, in the
 *    checkout the watch started in, and Agent Control must be on; otherwise the watch ends
 *    (`scope-changed`, ...), or pauses while Agent Control is off (24 hours at most).
 * 2. A due watch runs; while the chat is busy only a baseline runs (it wakes nobody).
 * 3. The outcome (`evaluateCommandWatch`): quiet writes nothing; a baseline records the output's
 *    hash; new output wakes the agent; 8 failures in a row, output over 4 KiB, 10 wakes or 7
 *    days end it, with a closing message.
 * 4. A wake the chat cannot take now (busy, usage-limited, snoozed, plan waiting, cold-start
 *    budget) is kept in memory and tried again every 10 s and on the chat's events, never by
 *    running the command again; after a day it ends the watch (`expired`).
 *
 * Trust boundary, what runs: the stored command (the agent wrote it; the node never edits it),
 * through the node's shell with `-c`, in the cwd resolved when the watch started and checked
 * again before every run (a different or missing one ends the watch, so a watch never follows a
 * chat into another checkout), with the terminal's environment (`createTerminalSpawnEnv`: the
 * node's own without `RYCO_*` and Ryco's ports, so no Agent Control token or node secret
 * reaches the command), stdin closed, in its own process group (POSIX) that the 60 s timeout
 * ends with SIGTERM and, 2 s later, SIGKILL (a process tree on Windows). A process that leaves
 * its group (`setsid`, double fork) escapes that kill; only an OS sandbox could contain it. At
 * most 64 KiB of each stream is kept. What reaches the model: only a wake's output, at most 4 KiB,
 * sanitised and fenced (`commandWatchMessage`); the database keeps only its SHA-256.
 *
 * Due times, failure counts and held wakes are process memory: after a restart every watch runs
 * at its next look, and the hash comparison keeps an unchanged output from waking anyone again.
 *
 * @module commandWatchRuntime
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import {
  COMMAND_WATCH_WAKE_MESSAGE_PREFIX,
  CommandId,
  MessageId,
  type CommandWatchEndReason,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadShell,
  type ThreadCommandWatch,
  type ThreadCommandWatches,
  type ThreadCommandWatchUpdateCommand,
  type ThreadId,
} from "@ryco/contracts";
import {
  COMMAND_WATCH_LIMITS as LIMITS,
  commandWatchMessage,
  evaluateCommandWatch,
  type CommandWatchNotice,
  type CommandWatchProgress,
  type CommandWatchRun,
} from "@ryco/shared/commandWatch";
import { makeKeyedSerialExecutor } from "@ryco/shared/KeyedSerialExecutor";
import { sanitizeUntrustedLine } from "@ryco/shared/untrustedText";
import { Clock, Data, Duration, Effect, Fiber, Latch, Option, Semaphore, Stream } from "effect";
import type { Scope } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import type * as SqlClient from "effect/sql/SqlClient";

// Boot-path modules are type-only imports here: the thin service layer hands their services and
// helpers over (`CommandWatchRuntimeDeps`), so this chunk imports no boot module.
import type { AgentControlPolicyShape } from "../agentControl/Services/AgentControlPolicy.ts";
import type { logOnceEvery } from "../logOnceEvery.ts";
import { COMMAND_WATCH_CHANGED_DETAIL } from "../orchestration/commandWatchUpdates.ts";
import type { serverWakeGuard } from "../orchestration/serverWake.ts";
import type { OrchestrationCommandApplicationShape } from "../orchestration/Services/OrchestrationCommandApplication.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ServerWakeFenceShape } from "../orchestration/Services/ServerWakeFence.ts";
import type { isThreadWaitWakeEvent } from "../orchestration/threadWaitWakeEvents.ts";
import { readWakeStartFailureDelivery } from "../persistence/wakeStartDelivery.ts";

type Thread = OrchestrationReadModel["threads"][number];

/** What the watch runs on, handed over by the thin boot layer (`CommandWatchService.ts`). */
export interface CommandWatchRuntimeDeps {
  readonly commands: OrchestrationCommandApplicationShape;
  readonly engine: OrchestrationEngineShape;
  readonly projections: ProjectionSnapshotQueryShape;
  readonly fence: ServerWakeFenceShape;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly sql: SqlClient.SqlClient;
  /** Runs pause and wakes hold while Agent Control is off; absent = on. */
  readonly policy: AgentControlPolicyShape | undefined;
  readonly helpers: {
    readonly serverWakeGuard: typeof serverWakeGuard;
    readonly isThreadWaitWakeEvent: typeof isThreadWaitWakeEvent;
    readonly isThreadSnoozed: (
      shell: Pick<OrchestrationThreadShell, "snoozedUntil" | "snoozedAt">,
      nowMs: number,
    ) => boolean;
    readonly logOnceEvery: typeof logOnceEvery;
    /** The command's environment (the terminal's: no `RYCO_*`). */
    readonly spawnEnv: () => NodeJS.ProcessEnv;
  };
  /** Tests: the shell a command runs through (default: the node's, see `shellInvocation`). */
  readonly shell?: (command: string) => { readonly command: string; readonly args: string[] };
  /** Tests: a shorter run timeout (default `COMMAND_WATCH_LIMITS.runTimeoutMs`). */
  readonly runTimeoutMs?: number;
}

/** Why a watch could not start or stop, in words for the agent. */
export class CommandWatchFailure extends Data.TaggedError("CommandWatchFailure")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface CommandWatchStartInput {
  readonly threadId: ThreadId;
  readonly command: string;
  readonly label: string;
  readonly everyMinutes: number;
}

export interface CommandWatchStartResult {
  readonly watchId: string;
  /** False when the chat already watched that command (the watch is left unchanged). */
  readonly started: boolean;
  readonly watches: ThreadCommandWatches;
}

export interface CommandWatchRuntime {
  /** Start a watch on `threadId` (the caller checked it is that chat's own agent). */
  readonly start: (
    input: CommandWatchStartInput,
  ) => Effect.Effect<CommandWatchStartResult, CommandWatchFailure>;
  /** Stop one watch, or every watch of the chat; what already ended changes nothing. */
  readonly stop: (input: {
    readonly threadId: ThreadId;
    readonly watchId?: string | undefined;
  }) => Effect.Effect<{ readonly stopped: ReadonlyArray<string> }, CommandWatchFailure>;
  /** The chat's watches, full state (commands included): for its own agent only. */
  readonly list: (threadId: ThreadId) => Effect.Effect<ThreadCommandWatches>;
  /** One look at every watched chat, waiting for the runs it starts (tests). */
  readonly sweep: Effect.Effect<void>;
  /** Looks on schedule, and at once on watch changes and held chats' events, until interrupted. */
  readonly run: Effect.Effect<never>;
}

/** Thread events that can free a held wake beyond the ones Agent Control waits wake on. */
const HELD_WAKE_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set<
  OrchestrationEvent["type"]
>(["thread.usage-limit-cleared", "thread.unsnoozed"]);
/** A woken look runs at most this often (thread events come in bursts). */
const WOKEN_LOOK_MIN_SPACING_MS = 1_000;

const EMPTY: ThreadCommandWatches = { active: [], ended: [] };
const fail = (detail: string) => new CommandWatchFailure({ detail });
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The node's shell, run non-interactively with `-c` (T3 Code): the server already has the login
 * PATH. `$SHELL` when it names an absolute path, else the platform's usual shell.
 */
export const shellInvocation = (
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { readonly command: string; readonly args: string[] } => {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  const shell = env.SHELL?.trim();
  return {
    command:
      shell !== undefined && shell.startsWith("/")
        ? shell
        : platform === "darwin"
          ? "/bin/zsh"
          : platform === "linux"
            ? "/bin/bash"
            : "/bin/sh",
    args: ["-c", command],
  };
};

/** The decider's refusal detail inside a dispatch error, or null for any other failure. */
const refusalDetail = (error: unknown): string | null => {
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  return typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "OrchestrationCommandInvariantError" &&
    "detail" in cause &&
    typeof cause.detail === "string"
    ? cause.detail
    : null;
};

/** Keeps the first `limit` bytes of a stream and drains the rest, so the child never blocks. */
const collectCapped = <E>(stream: Stream.Stream<Uint8Array, E>, limit: number) =>
  Stream.runFold(
    stream,
    () => ({ chunks: [] as Uint8Array[], bytes: 0, truncated: false }),
    (acc, chunk) => {
      const room = limit - acc.bytes;
      if (room <= 0) return chunk.byteLength > 0 ? { ...acc, truncated: true } : acc;
      const kept = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
      acc.chunks.push(kept);
      return {
        chunks: acc.chunks,
        bytes: acc.bytes + kept.byteLength,
        truncated: acc.truncated || kept.byteLength < chunk.byteLength,
      };
    },
  ).pipe(
    Effect.map((acc) => ({
      text: Buffer.concat(acc.chunks).toString("utf8"),
      truncated: acc.truncated,
    })),
  );

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** A held wake (or closing message), kept until the chat can take it. */
interface HeldWake {
  readonly text: string;
  /** The progress the wake records; null for a closing message, which ends the watch. */
  readonly progress: CommandWatchProgress | null;
  readonly endReason: CommandWatchEndReason | null;
}

type UpdateOutcome = "accepted" | "changed" | "refused" | "failed";

export const makeCommandWatchRuntime = (
  deps: CommandWatchRuntimeDeps,
): Effect.Effect<CommandWatchRuntime, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { commands, engine, projections, fence, spawner, sql, policy, helpers } = deps;
    const scope = yield* Effect.scope;
    const serial = yield* makeKeyedSerialExecutor<ThreadId>();
    const permits = yield* Semaphore.make(LIMITS.concurrentRuns);
    const toShell = deps.shell ?? ((command: string) => shellInvocation(command));
    const runTimeoutMs = deps.runTimeoutMs ?? LIMITS.runTimeoutMs;

    // Process memory (see the module comment), keyed by watch generation.
    const dueAtMs = new Map<string, number>();
    const failures = new Map<string, number>();
    const refusals = new Map<string, number>();
    /** First sighting of a held wake, a pause (Agent Control off) or a pending delivery. */
    const heldSinceMs = new Map<string, number>();
    const heldWakes = new Map<string, HeldWake>();
    /** The run in flight per chat: its watch generation and fiber. */
    const running = new Map<ThreadId, { readonly key: string; fiber?: Fiber.Fiber<void> }>();
    let changed = true;
    let nextScanAtMs = 0;
    const woken = yield* Latch.make(false);

    const keyOf = (threadId: ThreadId, watch: Pick<ThreadCommandWatch, "watchId" | "startedAt">) =>
      `${threadId}\u0000${watch.watchId}\u0000${watch.startedAt}`;

    const forget = (key: string) => {
      for (const memory of [dueAtMs, failures, refusals, heldSinceMs, heldWakes]) {
        memory.delete(key);
      }
    };

    const log = (key: string, message: string, fields: Record<string, unknown>, cause?: unknown) =>
      helpers.logOnceEvery({
        key: `commandWatch.${key}`,
        message,
        fields,
        ...(cause === undefined ? {} : { cause }),
      });

    // ── Reads ───────────────────────────────────────────────────────

    const readModel = Effect.suspend(() =>
      engine.getReadModel === undefined
        ? Effect.die(new Error("Command watches need the engine's read model."))
        : engine.getReadModel(),
    );
    const threadOf = (threadId: ThreadId) =>
      readModel.pipe(
        Effect.map((model) => model.threads.find((thread) => thread.id === threadId) ?? null),
      );
    const threadShell = (threadId: ThreadId) =>
      projections.getThreadShellById(threadId).pipe(
        Effect.map((shell) => Option.getOrNull(shell)),
        Effect.orElseSucceed(() => null),
      );
    /** Where a chat's commands run: its checkout, else its project's root. */
    const cwdOf = (thread: Pick<Thread, "worktreePath" | "projectId">) =>
      thread.worktreePath !== null
        ? Effect.succeed<string | null>(thread.worktreePath)
        : projections.getProjectShellById(thread.projectId).pipe(
            Effect.map((project) => (Option.isSome(project) ? project.value.workspaceRoot : null)),
            Effect.orElseSucceed(() => null),
          );

    // ── Updates ─────────────────────────────────────────────────────

    /** One revision-fenced change; `current` null creates `next`. */
    const applyUpdate = (input: {
      readonly threadId: ThreadId;
      readonly watchId: string;
      readonly current: ThreadCommandWatch | null;
      readonly next: ThreadCommandWatch | null;
      readonly endReason?: CommandWatchEndReason | undefined;
      readonly wake?: ThreadCommandWatchUpdateCommand["wake"];
      readonly createdAt: string;
    }): Effect.Effect<{ readonly outcome: UpdateOutcome; readonly detail: string | null }> => {
      const command: ThreadCommandWatchUpdateCommand = {
        type: "thread.command-watch.update",
        // A fresh id per update: a refused receipt never poisons a later retry.
        commandId: CommandId.make(
          `server:command-watch:${input.threadId}:${input.watchId}:${input.current?.revision ?? 0}:${crypto.randomUUID()}`,
        ),
        threadId: input.threadId,
        watchId: input.watchId,
        expectedRevision: input.current?.revision ?? null,
        expectedStartedAt: input.current?.startedAt ?? null,
        next: input.next,
        ...(input.endReason === undefined ? {} : { endReason: input.endReason }),
        ...(input.wake === undefined ? {} : { wake: input.wake }),
        createdAt: input.createdAt,
      };
      type Result = { readonly outcome: UpdateOutcome; readonly detail: string | null };
      return commands.applyInternal(command).pipe(
        Effect.as<Result>({ outcome: "accepted", detail: null }),
        Effect.catch((error): Effect.Effect<Result> => {
          const detail = refusalDetail(error);
          if (detail === null) {
            return log(
              `dispatch:${input.threadId}:${input.watchId}`,
              "Command watch update failed; it is tried again on the next look",
              { threadId: input.threadId, watchId: input.watchId },
              error,
            ).pipe(Effect.as({ outcome: "failed" as UpdateOutcome, detail: null }));
          }
          return Effect.succeed({
            outcome: (detail === COMMAND_WATCH_CHANGED_DETAIL
              ? "changed"
              : "refused") as UpdateOutcome,
            detail,
          });
        }),
      );
    };

    /** Ends a watch with no message (a lifecycle or scope end, or a closing message given up). */
    const endSilently = (
      threadId: ThreadId,
      watch: ThreadCommandWatch,
      reason: CommandWatchEndReason,
      nowMs: number,
    ) =>
      applyUpdate({
        threadId,
        watchId: watch.watchId,
        current: watch,
        next: null,
        endReason: reason,
        createdAt: iso(nowMs),
      }).pipe(
        Effect.tap(({ outcome }) =>
          Effect.sync(() => {
            if (outcome === "accepted") forget(keyOf(threadId, watch));
          }),
        ),
      );

    const revised = (watch: ThreadCommandWatch, patch: Partial<ThreadCommandWatch>) => ({
      ...watch,
      ...patch,
      revision: watch.revision + 1,
    });

    /** Why the chat cannot take a wake now, or null (the shared fence, then the chat's own state). */
    const holdOf = (shell: OrchestrationThreadShell, nowMs: number) =>
      Effect.gen(function* () {
        const hold = yield* fence
          .holdReason(shell, nowMs, "command-watch")
          .pipe(Effect.orElseSucceed(() => "busy" as const));
        if (hold !== null) return hold;
        if (yield* fence.reverting(shell.id, nowMs).pipe(Effect.orElseSucceed(() => true))) {
          return "reverting";
        }
        const cold = yield* fence.coldStart(shell.id, nowMs);
        if (cold.cold && cold.budgetFull) return "cold-budget";
        if (helpers.isThreadSnoozed(shell, nowMs)) return "snoozed";
        if (shell.hasActionableProposedPlan) return "plan-ready";
        return null;
      });

    /**
     * Sends `held` to the agent: a wake (progress recorded, delivery pending) or a closing
     * message (the watch ends). Held when the chat cannot take it; a day of that ends the watch.
     */
    const deliver = (
      threadId: ThreadId,
      watch: ThreadCommandWatch,
      held: HeldWake,
      nowMs: number,
    ) =>
      Effect.gen(function* () {
        const key = keyOf(threadId, watch);
        const shell = yield* threadShell(threadId);
        const hold = shell === null ? "busy" : yield* holdOf(shell, nowMs);
        if (shell === null || hold !== null) {
          const since = heldSinceMs.get(key) ?? nowMs;
          heldSinceMs.set(key, since);
          if (nowMs - since < LIMITS.heldWakeExpiryMs) {
            heldWakes.set(key, held);
            return;
          }
          // A closing message gives up and the watch ends as it would have; news expires it.
          yield* endSilently(threadId, watch, held.endReason ?? "expired", nowMs);
          return;
        }
        const messageId = MessageId.make(
          `${COMMAND_WATCH_WAKE_MESSAGE_PREFIX}${threadId}:${crypto.randomUUID()}`,
        );
        const cold = yield* fence.coldStart(threadId, nowMs);
        if (cold.cold && !(yield* fence.reserveColdSlot(threadId, messageId, nowMs))) {
          heldWakes.set(key, held);
          heldSinceMs.set(key, heldSinceMs.get(key) ?? nowMs);
          return;
        }
        const result = yield* Effect.gen(function* () {
          const latestUserMessageId = yield* fence
            .latestUserMessageId(threadId)
            .pipe(Effect.orElseSucceed(() => null));
          const sentAt = iso(nowMs);
          return yield* applyUpdate({
            threadId,
            watchId: watch.watchId,
            current: watch,
            next:
              held.progress === null
                ? null
                : revised(watch, {
                    ...held.progress,
                    lastChangeAt: sentAt,
                    delivery: { messageId, sentAt },
                    beforeWake: { lastOutputHash: watch.lastOutputHash, wakes: watch.wakes },
                  }),
            endReason: held.endReason ?? undefined,
            wake: {
              messageId,
              text: held.text,
              guard: helpers.serverWakeGuard(shell, latestUserMessageId, "command-watch"),
            },
            createdAt: sentAt,
          });
        }).pipe(
          Effect.onExit((exit) =>
            !cold.cold
              ? Effect.void
              : exit._tag === "Success" && exit.value.outcome === "accepted"
                ? fence.noteColdWake(threadId, messageId, nowMs)
                : fence.releaseColdSlot(threadId, messageId),
          ),
        );
        if (result.outcome === "accepted") {
          heldWakes.delete(key);
          heldSinceMs.delete(key);
          refusals.delete(key);
          if (held.progress === null) forget(key);
          return;
        }
        if (result.outcome !== "refused") {
          // Changed meanwhile, or a failed write: the next look reads the watch again.
          heldWakes.delete(key);
          return;
        }
        yield* log(`refused:${threadId}:${watch.watchId}`, "Command watch update was refused", {
          threadId,
          watchId: watch.watchId,
          detail: result.detail,
        });
        heldWakes.set(key, held);
        heldSinceMs.set(key, heldSinceMs.get(key) ?? nowMs);
        const count = (refusals.get(key) ?? 0) + 1;
        refusals.set(key, count);
        // Its updates keep being refused (a state the decider will not lift): stop.
        if (count >= LIMITS.maxRejectedUpdates) {
          yield* endSilently(threadId, watch, "rejected", nowMs);
        }
      });

    // ── Running a command ───────────────────────────────────────────

    const execute = (watch: ThreadCommandWatch): Effect.Effect<CommandWatchRun> => {
      const shell = toShell(watch.command);
      return Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(shell.command, shell.args, {
              cwd: watch.cwd,
              env: helpers.spawnEnv(),
              extendEnv: false,
              stdin: "ignore",
              // Its own process group on POSIX, so the timeout ends whatever it started.
              detached: process.platform !== "win32",
              killSignal: "SIGTERM",
              forceKillAfter: Duration.millis(LIMITS.killGraceMs),
            }),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [
              collectCapped(handle.stdout, LIMITS.captureLimitBytes),
              collectCapped(handle.stderr, LIMITS.captureLimitBytes),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return {
            kind: "exited",
            code: Number(code),
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutHash: createHash("sha256").update(stdout.text.trim()).digest("hex"),
            stdoutTruncated: stdout.truncated,
          } satisfies CommandWatchRun;
        }),
      ).pipe(
        // Closing the run's scope at the deadline ends the process group (see the spawner).
        Effect.timeoutOption(Duration.millis(runTimeoutMs)),
        Effect.map((result) =>
          Option.getOrElse(result, (): CommandWatchRun => ({
            kind: "failed",
            reason: `timed out after ${Math.round(runTimeoutMs / 1_000)} seconds`,
          })),
        ),
        Effect.catch((error) =>
          Effect.succeed<CommandWatchRun>({
            kind: "failed",
            reason: /signal/iu.test(String(error))
              ? "was stopped by a signal"
              : "could not start its shell",
          }),
        ),
      );
    };

    /** Records what one run of `watch` found (under the chat's lock, on the current watch). */
    const recordRun = (threadId: ThreadId, ran: ThreadCommandWatch, run: CommandWatchRun) =>
      serial.withLock(
        threadId,
        Effect.gen(function* () {
          const thread = yield* threadOf(threadId);
          const watch = thread?.commandWatchState?.active.find(
            (candidate) => candidate.watchId === ran.watchId,
          );
          // Stopped or started again while it ran: this run's outcome is no one's.
          if (watch === undefined || watch.startedAt !== ran.startedAt) return;
          const key = keyOf(threadId, watch);
          const nowMs = yield* Clock.currentTimeMillis;
          const outcome = evaluateCommandWatch(watch, run);
          const closing = (reason: CommandWatchEndReason, notice: CommandWatchNotice) =>
            deliver(
              threadId,
              watch,
              { text: commandWatchMessage(watch, notice), progress: null, endReason: reason },
              nowMs,
            );
          switch (outcome.kind) {
            case "quiet":
              failures.delete(key);
              return;
            case "failed": {
              const count = (failures.get(key) ?? 0) + 1;
              failures.set(key, count);
              if (count >= LIMITS.failureLimit) yield* closing("failing", outcome);
              return;
            }
            case "baseline":
              failures.delete(key);
              yield* applyUpdate({
                threadId,
                watchId: watch.watchId,
                current: watch,
                next: revised(watch, outcome.next),
                createdAt: iso(nowMs),
              });
              return;
            case "too-long":
              failures.delete(key);
              yield* closing("too-long", outcome);
              return;
            case "wake":
              failures.delete(key);
              if (outcome.exhausted) {
                yield* closing("wake-limit", outcome);
              } else {
                yield* deliver(
                  threadId,
                  watch,
                  {
                    text: commandWatchMessage(watch, outcome),
                    progress: outcome.next,
                    endReason: null,
                  },
                  nowMs,
                );
              }
              return;
          }
        }),
      );

    const runWatch = (threadId: ThreadId, watch: ThreadCommandWatch) =>
      permits.withPermits(1)(
        Effect.gen(function* () {
          const run = yield* execute(watch);
          yield* recordRun(threadId, watch, run);
        }),
      );

    // ── One chat's look ─────────────────────────────────────────────

    /** What a watch's delivery came to: settles it (a proven not-sent wake is re-derived). */
    const settleDelivery = (threadId: ThreadId, watch: ThreadCommandWatch, nowMs: number) =>
      Effect.gen(function* () {
        const delivery = watch.delivery!;
        const state = yield* fence
          .wakeStartState(threadId, delivery.messageId)
          .pipe(Effect.orElseSucceed(() => "pending" as const));
        if (state === "pending") return false;
        const start =
          state === "failed"
            ? yield* readWakeStartFailureDelivery(sql, {
                threadId,
                messageId: delivery.messageId,
              }).pipe(Effect.orElseSucceed(() => "uncertain" as const))
            : state;
        const restored = start === "not-sent" && watch.beforeWake !== null ? watch.beforeWake : {};
        const { outcome } = yield* applyUpdate({
          threadId,
          watchId: watch.watchId,
          current: watch,
          next: revised(watch, { ...restored, delivery: null, beforeWake: null }),
          createdAt: iso(nowMs),
        });
        return outcome === "accepted";
      });

    const endReasonOf = (thread: Thread): CommandWatchEndReason | null => {
      if (thread.deletedAt !== null || thread.trashedAt != null) return "trashed";
      if (thread.archivedAt !== null) return "archived";
      if (thread.settledOverride === "settled") return "settled";
      return null;
    };

    /**
     * Looks at one chat: ends what may no longer run, settles deliveries, sends held wakes, and
     * starts the most overdue due watch. `onlyHeld` sends held wakes and starts nothing.
     */
    const lookAt = (threadId: ThreadId, options: { readonly onlyHeld: boolean }) =>
      serial
        .withLock(
          threadId,
          Effect.gen(function* () {
            const thread = yield* threadOf(threadId);
            const watches = thread?.commandWatchState?.active ?? [];
            if (thread === null || watches.length === 0) return;
            const nowMs = yield* Clock.currentTimeMillis;
            const lifecycle = endReasonOf(thread);
            const enabled = policy === undefined ? true : yield* policy.isEnabled;
            const cwd = lifecycle === null ? yield* cwdOf(thread) : null;
            let busy: boolean | null = null;
            let due: ThreadCommandWatch | null = null;
            for (const watch of watches) {
              const key = keyOf(threadId, watch);
              // The decider ends these on the transition; one left from before ends here.
              if (lifecycle !== null) {
                yield* endSilently(threadId, watch, lifecycle, nowMs);
                continue;
              }
              if (
                thread.runtimeMode !== "full-access" ||
                thread.interactionMode !== "default" ||
                thread.runtimeMode !== watch.runtimeMode ||
                thread.worktreePath !== watch.worktreePath ||
                cwd !== watch.cwd ||
                !isDirectory(watch.cwd)
              ) {
                yield* endSilently(threadId, watch, "scope-changed", nowMs);
                continue;
              }
              if (watch.delivery !== null) {
                if (!(yield* settleDelivery(threadId, watch, nowMs))) {
                  const since = heldSinceMs.get(key) ?? nowMs;
                  heldSinceMs.set(key, since);
                  if (nowMs - since >= LIMITS.heldWakeExpiryMs) {
                    yield* endSilently(threadId, watch, "expired", nowMs);
                  }
                } else {
                  heldSinceMs.delete(key);
                  changed = true;
                }
                continue;
              }
              if (!enabled) {
                // Agent Control off: nothing runs and nothing wakes, for a day at most.
                const since = heldSinceMs.get(key) ?? nowMs;
                heldSinceMs.set(key, since);
                if (nowMs - since >= LIMITS.heldWakeExpiryMs) {
                  yield* endSilently(threadId, watch, "expired", nowMs);
                }
                continue;
              }
              const held = heldWakes.get(key);
              if (held !== undefined) {
                yield* deliver(threadId, watch, held, nowMs);
                continue;
              }
              if (!heldWakes.has(key)) heldSinceMs.delete(key);
              if (Date.parse(watch.startedAt) + LIMITS.lifetimeMs <= nowMs) {
                yield* deliver(
                  threadId,
                  watch,
                  {
                    text: commandWatchMessage(watch, { kind: "expired" }),
                    progress: null,
                    endReason: "expired",
                  },
                  nowMs,
                );
                continue;
              }
              if (options.onlyHeld || running.has(threadId)) continue;
              const dueAt = dueAtMs.get(key) ?? 0;
              if (
                dueAt > nowMs ||
                (due !== null && dueAt >= (dueAtMs.get(keyOf(threadId, due)) ?? 0))
              ) {
                continue;
              }
              // While a turn runs only a baseline may run (it wakes nobody); the others wait.
              if (watch.lastOutputHash !== null) {
                if (busy === null) {
                  const shell = yield* threadShell(threadId);
                  busy =
                    shell === null ||
                    (yield* fence
                      .holdReason(shell, nowMs, "command-watch")
                      .pipe(Effect.orElseSucceed(() => "busy" as const))) !== null;
                }
                if (busy) continue;
              }
              due = watch;
            }
            if (due === null) return;
            dueAtMs.set(keyOf(threadId, due), nowMs + due.everyMinutes * 60_000);
            const entry: { readonly key: string; fiber?: Fiber.Fiber<void> } = {
              key: keyOf(threadId, due),
            };
            running.set(threadId, entry);
            entry.fiber = yield* runWatch(threadId, due).pipe(
              Effect.catchCause((cause) =>
                log(`run:${threadId}`, "Command watch run failed", { threadId }, cause),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  if (running.get(threadId) === entry) running.delete(threadId);
                }),
              ),
              Effect.forkIn(scope),
            );
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            log(`look:${threadId}`, "Command watch look failed for a chat", { threadId }, cause),
          ),
        );

    /** One look at every watched chat. */
    const look = (options: { readonly onlyHeld: boolean }) =>
      Effect.gen(function* () {
        const model = yield* readModel;
        const watched = model.threads.filter(
          (thread) => (thread.commandWatchState?.active.length ?? 0) > 0,
        );
        if (!options.onlyHeld) {
          const nowMs = yield* Clock.currentTimeMillis;
          nextScanAtMs = nowMs + (watched.length > 0 ? LIMITS.activeScanMs : LIMITS.idleScanMs);
          const present = new Set(
            watched.flatMap((thread) =>
              thread.commandWatchState!.active.map((watch) => keyOf(thread.id, watch)),
            ),
          );
          for (const memory of [dueAtMs, failures, refusals, heldSinceMs, heldWakes]) {
            for (const key of memory.keys()) if (!present.has(key)) memory.delete(key);
          }
        }
        for (const thread of watched) {
          if (options.onlyHeld && !hasHeld(thread.id)) continue;
          yield* lookAt(thread.id, options);
        }
      });

    const hasHeld = (threadId: ThreadId) => {
      const prefix = `${threadId}\u0000`;
      for (const key of heldSinceMs.keys()) if (key.startsWith(prefix)) return true;
      return false;
    };

    /** Interrupts a chat's run once its watch ended (the decider ends watches with lifecycle). */
    const onEvent = (event: OrchestrationEvent) =>
      Effect.suspend(() => {
        if (event.aggregateKind !== "thread") return Effect.void;
        const threadId = event.aggregateId as ThreadId;
        if (event.type === "thread.command-watch-updated") {
          changed = true;
          const run = running.get(threadId);
          const ended = event.payload.changed.some(
            (change) => change.ended !== null && run?.key.includes(`\u0000${change.watchId}\u0000`),
          );
          if (run?.fiber !== undefined && ended) {
            return Fiber.interrupt(run.fiber).pipe(Effect.andThen(woken.open), Effect.asVoid);
          }
          return Effect.asVoid(woken.open);
        }
        // Deleted, or out of Full access or default mode: its run stops now, and the look that
        // follows ends the watch (`scope-changed`) before anything runs again.
        if (
          event.type === "thread.deleted" ||
          (event.type === "thread.runtime-mode-set" &&
            event.payload.runtimeMode !== "full-access") ||
          (event.type === "thread.interaction-mode-set" &&
            event.payload.interactionMode !== "default")
        ) {
          const run = running.get(threadId);
          changed = true;
          return (run?.fiber === undefined ? Effect.void : Fiber.interrupt(run.fiber)).pipe(
            Effect.andThen(woken.open),
            Effect.asVoid,
          );
        }
        return hasHeld(threadId) &&
          (HELD_WAKE_EVENT_TYPES.has(event.type) || helpers.isThreadWaitWakeEvent(event))
          ? Effect.asVoid(woken.open)
          : Effect.void;
      });

    const awaitRuns = Effect.gen(function* () {
      for (const entry of [...running.values()]) {
        if (entry.fiber !== undefined) yield* Fiber.await(entry.fiber);
      }
    });

    const sweep = look({ onlyHeld: false }).pipe(Effect.andThen(awaitRuns));

    const run: Effect.Effect<never> = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        yield* Stream.runForEach(events, onEvent).pipe(
          Effect.catchCause((cause) =>
            log("events", "Command watches stopped following thread events", {}, cause),
          ),
          Effect.forkScoped,
        );
        let lastLookMs = Number.NEGATIVE_INFINITY;
        while (true) {
          yield* woken.close;
          const nowMs = yield* Clock.currentTimeMillis;
          if (changed || nowMs >= nextScanAtMs) {
            changed = false;
            yield* look({ onlyHeld: false });
          } else {
            yield* look({ onlyHeld: true });
          }
          lastLookMs = yield* Clock.currentTimeMillis;
          const wakeAtMs = Math.min(
            nextScanAtMs,
            heldSinceMs.size > 0 ? lastLookMs + LIMITS.heldWakeRecheckMs : Number.POSITIVE_INFINITY,
          );
          yield* Effect.race(
            Effect.sleep(Duration.millis(Math.max(0, wakeAtMs - lastLookMs))),
            woken.await,
          );
          const wokenAtMs = yield* Clock.currentTimeMillis;
          if (wokenAtMs - lastLookMs < WOKEN_LOOK_MIN_SPACING_MS) {
            yield* Effect.sleep(
              Duration.millis(WOKEN_LOOK_MIN_SPACING_MS - (wokenAtMs - lastLookMs)),
            );
          }
        }
      }),
    );

    // ── Starting, stopping, listing ─────────────────────────────────

    const watchesOf = (thread: Thread | null) => thread?.commandWatchState ?? EMPTY;

    const start: CommandWatchRuntime["start"] = (input) =>
      serial.withLock(
        input.threadId,
        Effect.gen(function* () {
          const thread = yield* threadOf(input.threadId);
          if (thread === null) {
            return yield* Effect.fail(fail("Thread not found."));
          }
          const existing = watchesOf(thread).active.find(
            (watch) => watch.command === input.command,
          );
          // Watching the same command again returns the watch unchanged (T3 Code).
          if (existing !== undefined) {
            return { watchId: existing.watchId, started: false, watches: watchesOf(thread) };
          }
          const label = sanitizeUntrustedLine(input.label, 120);
          if (label.length === 0) {
            return yield* Effect.fail(fail("The label needs visible text."));
          }
          const cwd = yield* cwdOf(thread);
          if (cwd === null || !isDirectory(cwd)) {
            return yield* Effect.fail(fail("This chat has no checkout to run the command in."));
          }
          const nowMs = yield* Clock.currentTimeMillis;
          const startedAt = iso(nowMs);
          const watch: ThreadCommandWatch = {
            watchId: `command-watch:${crypto.randomUUID()}`,
            command: input.command,
            label,
            everyMinutes: input.everyMinutes,
            revision: 1,
            startedAt,
            runtimeMode: thread.runtimeMode,
            worktreePath: thread.worktreePath,
            cwd,
            lastOutputHash: null,
            wakes: 0,
            lastChangeAt: null,
            delivery: null,
            beforeWake: null,
          };
          const { outcome, detail } = yield* applyUpdate({
            threadId: input.threadId,
            watchId: watch.watchId,
            current: null,
            next: watch,
            createdAt: startedAt,
          });
          if (outcome !== "accepted") {
            return yield* Effect.fail(
              fail(detail ?? "Could not start the command watch. Try again."),
            );
          }
          // The baseline runs at the next look, right away.
          changed = true;
          yield* woken.open;
          return {
            watchId: watch.watchId,
            started: true,
            watches: watchesOf(yield* threadOf(input.threadId)),
          };
        }),
      );

    const stop: CommandWatchRuntime["stop"] = (input) =>
      serial.withLock(
        input.threadId,
        Effect.gen(function* () {
          const thread = yield* threadOf(input.threadId);
          if (thread === null) {
            return yield* Effect.fail(fail("Thread not found."));
          }
          const nowMs = yield* Clock.currentTimeMillis;
          const stopped: string[] = [];
          for (const watch of watchesOf(thread).active) {
            if (input.watchId !== undefined && watch.watchId !== input.watchId) continue;
            const { outcome, detail } = yield* endSilently(
              input.threadId,
              watch,
              "unwatched",
              nowMs,
            );
            if (outcome === "accepted") stopped.push(watch.watchId);
            else if (outcome !== "changed") {
              return yield* Effect.fail(
                fail(detail ?? "Could not stop the command watch. Try again."),
              );
            }
          }
          return { stopped };
        }),
      );

    const list: CommandWatchRuntime["list"] = (threadId) =>
      threadOf(threadId).pipe(Effect.map(watchesOf));

    return { start, stop, list, sweep, run } satisfies CommandWatchRuntime;
  });
