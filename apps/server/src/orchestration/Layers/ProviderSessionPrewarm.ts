// @effect-diagnostics nodeBuiltinImport:off
import { stat } from "node:fs/promises";

import {
  DEFAULT_AGENT_TOKEN_MODE,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSession,
  type ProviderSessionPrewarmInput,
  type ProviderSessionPrewarmResult,
  type RuntimeSessionId,
  type ThreadId,
} from "@ryco/contracts";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { findThreadSession } from "../../provider/threadSessionLookup.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderSessionPrewarm,
  type ProviderSessionPrewarmShape,
} from "../Services/ProviderSessionPrewarm.ts";
import {
  projectStartSystemPrompt,
  type ThreadProviderStart,
  threadProviderStartInput,
  threadProviderStartKey,
} from "../threadProviderStart.ts";

export interface ProviderSessionPrewarmOptions {
  /** How long an unclaimed prewarmed session lives (default 2 minutes). */
  readonly idleTimeout?: Duration.Input;
  /** Prewarmed sessions per provider instance (default 2). */
  readonly perInstanceLimit?: number;
  /** Prewarmed sessions overall (default 4). */
  readonly totalLimit?: number;
}

interface Entry {
  readonly threadId: ThreadId;
  readonly key: string;
  readonly start: ThreadProviderStart;
  readonly startedAtMs: number;
  /**
   * The start opened a brand-new native conversation (no cursor to resume). A provider may keep
   * nothing durable for one that never ran a turn (Codex writes its rollout with the first turn),
   * so an unclaimed stop must drop the cursor the start persisted, or the next start resumes a
   * conversation that does not exist.
   */
  readonly opensNativeConversation: boolean;
  /** The started session, or undefined when the start failed. */
  readonly session: Deferred.Deferred<ProviderSession | undefined>;
  ready: ProviderSession | undefined;
  expiry: Fiber.Fiber<void> | undefined;
}

const skipped = (reason: string): ProviderSessionPrewarmResult => ({ status: "skipped", reason });

const directoryExists = (path: string) =>
  Effect.promise(() =>
    stat(path).then(
      (entry) => entry.isDirectory(),
      () => false,
    ),
  );

export const makeProviderSessionPrewarm = Effect.fnUntraced(function* (
  options?: ProviderSessionPrewarmOptions,
) {
  const providerService = yield* ProviderService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const scope = yield* Effect.scope;
  const idleTimeout = Duration.fromInputUnsafe(options?.idleTimeout ?? Duration.minutes(2));
  const perInstanceLimit = Math.max(1, options?.perInstanceLimit ?? 2);
  const totalLimit = Math.max(1, options?.totalLimit ?? 4);
  const entries = new Map<ThreadId, Entry>();

  /** Removes `entry` when it is still current; the caller then owns its runtime. */
  const take = (entry: Entry): boolean => {
    if (entries.get(entry.threadId) !== entry) return false;
    entries.delete(entry.threadId);
    return true;
  };

  type StartedSession = ProviderSession & {
    readonly providerInstanceId: ProviderInstanceId;
    readonly runtimeSessionId: RuntimeSessionId;
  };
  const isStarted = (session: ProviderSession | undefined): session is StartedSession =>
    session?.runtimeSessionId !== undefined && session.providerInstanceId !== undefined;
  const bindingOf = (session: StartedSession) => ({
    threadId: session.threadId,
    provider: session.provider,
    providerInstanceId: session.providerInstanceId,
    runtimeSessionId: session.runtimeSessionId,
  });

  /**
   * Clears the resume cursor a start persisted for a conversation the provider never kept, but
   * only while the binding is still that runtime's: a successor's binding is left alone.
   */
  const discardNativeConversation = (session: StartedSession, reason: string) =>
    providerService.retireSessionBinding(bindingOf(session)).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.prewarm.discard-failed", {
          threadId: session.threadId,
          reason,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /** Stops exactly the runtime an entry started (never a successor bound since). */
  const stopRuntime = (
    session: ProviderSession | undefined,
    reason: string,
    discardConversation: boolean,
  ) => {
    if (!isStarted(session)) return Effect.void;
    // The cursor goes first. Each step takes the thread's start lock on its own, so a send
    // landing between them then starts fresh instead of resuming what this runtime never kept.
    return (discardConversation ? discardNativeConversation(session, reason) : Effect.void).pipe(
      Effect.andThen(
        providerService.stopSessionBinding(bindingOf(session)).pipe(
          Effect.tap((result) =>
            Effect.logDebug("provider.session.prewarm.stopped", {
              threadId: session.threadId,
              reason,
              result,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.prewarm.stop-failed", {
              threadId: session.threadId,
              reason,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
    );
  };

  const retire = (entry: Entry, reason: string) =>
    Effect.suspend(() => {
      if (!take(entry)) return Effect.void;
      const expiry = entry.expiry;
      entry.expiry = undefined;
      return (expiry ? Fiber.interrupt(expiry) : Effect.void).pipe(
        Effect.andThen(Deferred.await(entry.session)),
        Effect.flatMap((session) => stopRuntime(session, reason, entry.opensNativeConversation)),
      );
    });

  /** Makes room under the limits by retiring the oldest ready entries; false when none can go. */
  const makeRoom = Effect.fnUntraced(function* (start: ThreadProviderStart) {
    const ready = () =>
      [...entries.values()]
        .filter((entry) => entry.ready !== undefined)
        .toSorted((left, right) => left.startedAtMs - right.startedAtMs);
    const onInstance = () =>
      [...entries.values()].filter(
        (entry) => entry.start.providerInstanceId === start.providerInstanceId,
      ).length;
    while (onInstance() >= perInstanceLimit) {
      const victim = ready().find(
        (entry) => entry.start.providerInstanceId === start.providerInstanceId,
      );
      if (!victim) return false;
      yield* retire(victim, "pool-limit");
    }
    while (entries.size >= totalLimit) {
      const victim = ready()[0];
      if (!victim) return false;
      yield* retire(victim, "pool-limit");
    }
    return true;
  });

  /** The start the thread's next send would make, or why there is nothing to prewarm. */
  const resolveStart = Effect.fnUntraced(function* (input: ProviderSessionPrewarmInput) {
    const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(input.threadId));
    if (thread?.archivedAt) return "archived thread";
    if (thread) {
      const live = yield* findThreadSession(providerService, thread.id);
      if (thread.session !== null && thread.session.status !== "stopped" && live) {
        return "already-running";
      }
    }
    const projectId = thread?.projectId ?? input.projectId;
    if (projectId === undefined) return "unknown thread";
    const project = Option.getOrUndefined(yield* snapshots.getProjectShellById(projectId));
    if (!project) return "unknown project";
    const modelSelection =
      input.modelSelection ?? thread?.modelSelection ?? project.defaultModelSelection ?? undefined;
    const runtimeMode = input.runtimeMode ?? thread?.runtimeMode;
    if (!modelSelection || !runtimeMode) return "no model or runtime mode";
    const cwd = thread
      ? resolveThreadWorkspaceCwd({ thread, projects: [project] })
      : project.workspaceRoot;
    if (!cwd || !(yield* directoryExists(cwd))) return "working directory unavailable";
    const info = yield* providerService
      .getInstanceInfo(modelSelection.instanceId)
      .pipe(Effect.option);
    if (Option.isNone(info) || !info.value.enabled) return "provider instance unavailable";
    const driverKind = info.value.driverKind;
    if (!Schema.is(ProviderDriverKind)(driverKind)) return "unknown provider driver";
    // A resume elsewhere (another instance, a moved directory) is the turn start's decision.
    const target = providerService.readResumeTarget
      ? Option.getOrUndefined(yield* providerService.readResumeTarget(input.threadId))
      : undefined;
    if (
      target !== undefined &&
      (target.providerInstanceId !== modelSelection.instanceId ||
        (target.cwd !== undefined && target.cwd !== cwd))
    ) {
      return "resume target differs";
    }
    const start: ThreadProviderStart = {
      threadId: input.threadId,
      provider: driverKind,
      providerInstanceId: modelSelection.instanceId,
      cwd,
      modelSelection,
      runtimeMode,
      tokenMode: input.tokenMode ?? thread?.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
      customSystemPrompt: projectStartSystemPrompt(project),
    };
    return { start, opensNativeConversation: target?.hasResumeCursor !== true };
  });

  const scheduleExpiry = (entry: Entry) =>
    Effect.sleep(idleTimeout).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          // The expiry retires the entry itself: it must not interrupt its own fiber.
          entry.expiry = undefined;
          return retire(entry, "idle");
        }),
      ),
      Effect.forkIn(scope),
      Effect.tap((fiber) =>
        Effect.sync(() => {
          if (entries.get(entry.threadId) === entry) entry.expiry = fiber;
        }),
      ),
    );

  const prewarm: ProviderSessionPrewarmShape["prewarm"] = (input) =>
    Effect.gen(function* () {
      const resolved = yield* resolveStart(input);
      if (resolved === "already-running") return { status: "already-running" } as const;
      if (typeof resolved === "string") return skipped(resolved);
      const { start } = resolved;
      const key = threadProviderStartKey(start);
      const existing = entries.get(input.threadId);
      if (existing?.key === key) return { status: "pending" } as const;
      // The cursor `resolveStart` saw may be the one the entry being replaced persisted; retiring
      // that entry drops it, so the replacement opens a new conversation just the same.
      const opensNativeConversation =
        resolved.opensNativeConversation || existing?.opensNativeConversation === true;
      if (existing) yield* retire(existing, "replaced");
      if (!(yield* makeRoom(start))) return skipped("prewarm pool full");
      const entry: Entry = {
        threadId: input.threadId,
        key,
        start,
        startedAtMs: Date.now(),
        opensNativeConversation,
        session: yield* Deferred.make<ProviderSession | undefined>(),
        ready: undefined,
        expiry: undefined,
      };
      entries.set(input.threadId, entry);
      yield* providerService.startSession(input.threadId, threadProviderStartInput(start)).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            if (Exit.isFailure(exit)) {
              take(entry);
              yield* Effect.logDebug("provider.session.prewarm.start-failed", {
                threadId: input.threadId,
                cause: Cause.pretty(exit.cause),
              });
              yield* Deferred.succeed(entry.session, undefined);
              return;
            }
            entry.ready = exit.value;
            yield* Deferred.succeed(entry.session, exit.value);
            // Retired or claimed while it started: whoever took it owns the runtime now.
            if (entries.get(entry.threadId) === entry) yield* scheduleExpiry(entry);
          }),
        ),
        Effect.onInterrupt(() => Deferred.succeed(entry.session, undefined)),
        Effect.forkIn(scope),
      );
      yield* Effect.logDebug("provider.session.prewarm.started", {
        threadId: input.threadId,
        providerInstanceId: start.providerInstanceId,
      });
      return { status: "started" } as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("provider.session.prewarm.failed", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(skipped("prewarm failed"))),
      ),
    );

  const claim: ProviderSessionPrewarmShape["claim"] = (start) =>
    Effect.gen(function* () {
      const entry = entries.get(start.threadId);
      if (!entry || !take(entry)) return undefined;
      const expiry = entry.expiry;
      entry.expiry = undefined;
      if (expiry) yield* Fiber.interrupt(expiry);
      // From here the turn start owns the runtime: a cancelled claim must not leave it running.
      const session = yield* Deferred.await(entry.session).pipe(
        Effect.onInterrupt(() =>
          Deferred.await(entry.session).pipe(
            Effect.flatMap((started) =>
              stopRuntime(started, "claim-cancelled", entry.opensNativeConversation),
            ),
          ),
        ),
      );
      if (!session) return undefined;
      if (threadProviderStartKey(start) !== entry.key) {
        yield* stopRuntime(session, "mismatch", entry.opensNativeConversation);
        return undefined;
      }
      const live = yield* findThreadSession(providerService, start.threadId);
      if (live === undefined || live.runtimeSessionId !== session.runtimeSessionId) {
        return undefined;
      }
      yield* Effect.logDebug("provider.session.prewarm.claimed", {
        threadId: start.threadId,
        warmMs: Date.now() - entry.startedAtMs,
      });
      return live;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("provider.session.prewarm.claim-failed", {
              threadId: start.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(undefined)),
      ),
    );

  return { prewarm, claim } satisfies ProviderSessionPrewarmShape;
});

export const makeProviderSessionPrewarmLayer = (options?: ProviderSessionPrewarmOptions) =>
  Layer.effect(ProviderSessionPrewarm, makeProviderSessionPrewarm(options));

export const ProviderSessionPrewarmLive = makeProviderSessionPrewarmLayer();
