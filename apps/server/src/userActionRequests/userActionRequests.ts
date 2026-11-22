/**
 * The node's side of user action requests (docs/agent-control.md, "User action requests"): a
 * surface (the browser, the terminal) hands its tab or terminal to the user, and this module keeps
 * the request: opening it, ending it once (the user's Done or Won't do, the surface's own
 * condition, the expiry, the agent's withdrawal), and the bounded wait an agent's tool call
 * makes on it.
 *
 * A request is two thread activities: `user-action.requested` (surface, need, message, target,
 * expiry) and one `user-action.resolved` (its outcome). Their command and activity ids derive
 * from the request id, so a request is opened once and resolved once, whoever records first.
 * Resolutions of one request, and the requests one thread opens, run one at a time in this
 * process. Every resolution then runs the surface's hook (`surfaceHooks.ts`), which gives the tab
 * or terminal back.
 *
 * Loaded with `import()` the first time a surface opens a request, the owner answers, or a restart
 * finds a pending one: never at boot.
 *
 * @module userActionRequests/userActionRequests
 */
import { createHash } from "node:crypto";

import {
  CommandId,
  EventId,
  USER_ACTION_REQUEST_MESSAGE_MAX_CHARS,
  USER_ACTION_REQUEST_TARGET_MAX_CHARS,
  USER_ACTION_REQUEST_TTL_MS_DEFAULT,
  USER_ACTION_REQUEST_TTL_MS_MAX,
  USER_ACTION_REQUEST_TTL_MS_MIN,
  USER_ACTION_REQUESTED_ACTIVITY_KIND,
  USER_ACTION_RESOLVED_ACTIVITY_KIND,
  UserActionRequestError,
  UserActionRequestId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
  type UserActionAnswerInput,
  type UserActionAnswerResult,
  type UserActionNeed,
  type UserActionOutcome,
  type UserActionRequestFailureReason,
  type UserActionSurface,
} from "@ryco/contracts";
import {
  UserActionRequestedActivityPayload,
  type UserActionResolvedActivityPayload,
} from "@ryco/contracts/user-action-request-details";
import { userActionOutcomeLine, userActionRequestLabel } from "@ryco/shared/userActionRequests";
import {
  deriveUserActionRequests,
  isUserActionRequestExpired,
  pendingUserActionRequests,
  type UserActionRequestView,
} from "@ryco/shared/userActionRequestState";
import { Clock, Deferred, Duration, Effect, Stream } from "effect";
import * as Schema from "effect/Schema";

import type { threadWakeSource, waitUntil } from "../agentControl/eventDrivenWait.ts";
import {
  forEachPendingRequestAfterRestart,
  makeExpiryScheduler,
  makeKeyedSemaphore,
  readLiveThread,
  readThreadRecord,
} from "../nodeRequests/nodeRequestLifecycle.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { findThreadInArray } from "../orchestration/threadIndex.ts";
import { userActionSurfaceHook } from "./surfaceHooks.ts";

export interface UserActionRequestDeps {
  readonly engine: Pick<OrchestrationEngineShape, "dispatch" | "getReadModel">;
  /** Passed in from the boot path, so this lazily loaded module does not split it out. */
  readonly findThreadInArray: typeof findThreadInArray;
}

export interface UserActionWaitDeps extends UserActionRequestDeps {
  readonly engine: UserActionRequestDeps["engine"] &
    Pick<OrchestrationEngineShape, "subscribeDomainEvents">;
  /** Boot-path helpers, passed in so this lazily loaded module does not split them out. */
  readonly waitUntil: typeof waitUntil;
  readonly threadWakeSource: typeof threadWakeSource;
}

/** Why a request could not be opened or waited on, in words for the agent. */
export class UserActionRequestOpenError {
  readonly _tag = "UserActionRequestOpenError";
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

const isRequestedPayload = Schema.is(UserActionRequestedActivityPayload);

const failWith = (reason: UserActionRequestFailureReason) =>
  Effect.fail(new UserActionRequestError({ reason }));

/** The node's id for a caller's request: stable per thread and caller id, unguessable elsewhere. */
export const userActionRequestIdFor = (
  threadId: ThreadId,
  callerRequestId: string,
): UserActionRequestId =>
  UserActionRequestId.make(
    `user-action-${createHash("sha256")
      .update(`${threadId}\u0000${callerRequestId}`)
      .digest("hex")
      .slice(0, 32)}`,
  );

/** Keeps a surface's time to live within the contract's bounds. */
export const clampUserActionTtlMs = (ttlMs: number | undefined): number =>
  ttlMs === undefined || !Number.isFinite(ttlMs)
    ? USER_ACTION_REQUEST_TTL_MS_DEFAULT
    : Math.min(USER_ACTION_REQUEST_TTL_MS_MAX, Math.max(USER_ACTION_REQUEST_TTL_MS_MIN, ttlMs));

const readThread = (deps: UserActionRequestDeps, threadId: ThreadId) =>
  readLiveThread(deps, threadId);

/** Every request of the thread, with an unanswered request past its expiry read as `timeout`. */
export const readThreadUserActionRequests = (deps: UserActionRequestDeps, threadId: ThreadId) =>
  Effect.gen(function* () {
    const thread = yield* readThread(deps, threadId);
    if (thread === undefined) return undefined;
    return deriveUserActionRequests(thread.activities, yield* Clock.currentTimeMillis);
  });

const readRecordedRequest = (
  deps: UserActionRequestDeps,
  threadId: ThreadId,
  requestId: UserActionRequestId,
) =>
  readThread(deps, threadId).pipe(
    Effect.map((thread) =>
      thread === undefined
        ? undefined
        : deriveUserActionRequests(thread.activities).find(
            (candidate) => candidate.requestId === requestId,
          ),
    ),
  );

// One resolution per request at a time in this process; a second waits for the first.
const requestLocks = makeKeyedSemaphore();
const withRequestLock = <A, E, R>(
  threadId: ThreadId,
  requestId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => requestLocks.withPermit(`${threadId}\u0000${requestId}`, effect);

/** Tells the request's surface it ended. Never fails: a surface's failure is only logged. */
const notifySurface = (
  threadId: ThreadId,
  request: UserActionRequestView,
  outcome: UserActionOutcome,
) =>
  Effect.suspend(() => {
    const hook = userActionSurfaceHook(request.surface);
    if (hook === undefined) return Effect.void;
    return hook({ threadId, requestId: request.requestId, target: request.target, outcome });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("A user action request's surface could not take its target back", {
        surface: request.surface,
        cause,
      }),
    ),
  );

/**
 * Ends a pending request with `outcome`, records it, and runs the surface's hook. A request that
 * already ended is left as it is. Returns the request as it stands afterwards (`undefined` when it
 * is gone). Fails `record-failed` when the record failed.
 */
export const resolveUserActionRequest = (
  deps: UserActionRequestDeps,
  threadId: ThreadId,
  requestId: UserActionRequestId,
  outcome: UserActionOutcome,
): Effect.Effect<UserActionRequestView | undefined, UserActionRequestError> =>
  withRequestLock(
    threadId,
    requestId,
    Effect.gen(function* () {
      const thread = yield* readThreadRecord(deps, threadId);
      if (thread === undefined || thread.deletedAt !== null) {
        // Nothing can be recorded in a deleted thread; its surface still gets its target back.
        yield* releaseRequestsOf(threadId, thread, requestId);
        return undefined;
      }
      const request = deriveUserActionRequests(thread.activities).find(
        (candidate) => candidate.requestId === requestId,
      );
      if (request === undefined || request.status !== "pending") return request;
      const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const payload: UserActionResolvedActivityPayload = { requestId, outcome };
      yield* deps.engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`user-action:${requestId}:resolved`),
          threadId,
          activity: {
            id: EventId.make(`${requestId}:resolved`),
            tone: "info",
            kind: USER_ACTION_RESOLVED_ACTIVITY_KIND,
            summary: `${userActionRequestLabel(request)}: ${userActionOutcomeLine(outcome)}`,
            payload,
            turnId: request.turnId === null ? null : (request.turnId as TurnId),
            createdAt,
          },
          createdAt,
        })
        .pipe(Effect.mapError(() => new UserActionRequestError({ reason: "record-failed" })));
      opened.delete(requestId);
      yield* notifySurface(threadId, request, outcome);
      return { ...request, status: outcome };
    }),
  );

/** The wait before trying a failed expiry record again: doubling from this, up to ten minutes. */
const scheduleExpiry = makeExpiryScheduler<UserActionRequestError>({
  retryMs: 5_000,
  maxRetryMs: 10 * 60 * 1_000,
  onFailure: () => Effect.logWarning("Could not record a user action request's expiry"),
});

/**
 * Ends the request as `timeout` when its time is up, trying again with backoff while the record
 * fails. The timer lives in this process; after a restart
 * {@link reconcileUserActionRequestsAfterRestart} schedules it again.
 */
export const scheduleUserActionRequestExpiry = (
  deps: UserActionRequestDeps,
  threadId: ThreadId,
  request: Pick<UserActionRequestView, "requestId" | "expiresAt">,
) =>
  scheduleExpiry(
    `${threadId}\u0000${request.requestId}`,
    request.expiresAt,
    resolveUserActionRequest(deps, threadId, request.requestId, "timeout").pipe(Effect.asVoid),
  );

// ------------------------------------------------------------- deleted and archived threads

/**
 * The surface and target of every request this process opened or found pending, until it ends:
 * a thread deleted for good leaves no activities to read them from, and its surface must still
 * get its target back.
 */
const opened = new Map<
  string,
  { readonly threadId: ThreadId; readonly request: UserActionRequestView }
>();
const released = new Set<string>();
const remember = (threadId: ThreadId, request: UserActionRequestView) => {
  if (request.status === "pending") opened.set(request.requestId, { threadId, request });
};

/**
 * Gives the surfaces of a deleted or archived thread's pending requests their targets back
 * (`cancelled`), and records the end where the thread can still take it (archived). Only
 * `requestId`'s when given.
 */
const releaseRequestsOf = (
  threadId: ThreadId,
  thread: Pick<OrchestrationThread, "activities"> | undefined,
  requestId?: string,
) =>
  Effect.gen(function* () {
    const pending = new Map<string, UserActionRequestView>();
    for (const entry of opened.values()) {
      if (entry.threadId === threadId) pending.set(entry.request.requestId, entry.request);
    }
    if (thread !== undefined) {
      for (const request of pendingUserActionRequests(thread.activities)) {
        pending.set(request.requestId, request);
      }
    }
    for (const request of pending.values()) {
      if (requestId !== undefined && request.requestId !== requestId) continue;
      opened.delete(request.requestId);
      // A deleted thread keeps its requests pending for good: release each once.
      if (released.has(request.requestId)) continue;
      released.add(request.requestId);
      if (released.size > 1_000) {
        const oldest = released.values().next().value;
        if (oldest !== undefined) released.delete(oldest);
      }
      yield* notifySurface(threadId, request, "cancelled");
    }
  });

/** Ends the pending requests of a thread that was deleted or archived: see {@link releaseRequestsOf}. */
export const releaseUserActionRequestsOfThread = (
  deps: UserActionRequestDeps,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const thread = yield* readThreadRecord(deps, threadId);
    if (thread !== undefined && thread.deletedAt === null) {
      // Archived: the thread can still record how its requests ended (which releases them).
      for (const request of pendingUserActionRequests(thread.activities)) {
        yield* resolveUserActionRequest(deps, threadId, request.requestId, "cancelled").pipe(
          Effect.ignore,
        );
      }
    }
    // What is still pending now (a record that failed, a thread deleted for good) is released
    // without one, once.
    yield* releaseRequestsOf(threadId, yield* readThreadRecord(deps, threadId));
  });

const isThreadRemoval = (event: OrchestrationEvent) =>
  event.type === "thread.deleted" ||
  event.type === "thread.trashed" ||
  event.type === "thread.archived";

let removalWatchStarted = false;

export interface UserActionRemovalDeps extends UserActionRequestDeps {
  readonly engine: UserActionRequestDeps["engine"] &
    Pick<OrchestrationEngineShape, "subscribeDomainEvents">;
}

/**
 * Started once per process, with the first request opened or restored: a thread deleted, moved to
 * the trash or archived while it waits on the user gives its surfaces their targets back at once,
 * instead of leaving a tab or terminal locked until the expiry.
 */
export const watchThreadRemovals = (deps: UserActionRemovalDeps) =>
  Effect.gen(function* () {
    if (removalWatchStarted) return;
    removalWatchStarted = true;
    const subscribed = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const events = yield* deps.engine.subscribeDomainEvents;
        yield* Deferred.succeed(subscribed, undefined);
        yield* Stream.runForEach(events, (event) =>
          isThreadRemoval(event) && event.aggregateKind === "thread"
            ? releaseUserActionRequestsOfThread(deps, event.aggregateId as ThreadId).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not release a removed thread's hand-offs", { cause }),
                ),
              )
            : Effect.void,
        );
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          removalWatchStarted = false;
        }),
      ),
      Effect.forkDetach,
    );
    // Returns once subscribed, so a removal right after the first wait is not missed.
    yield* Deferred.await(subscribed).pipe(Effect.timeoutOption("2 seconds"));
  });

type RestartedThread = Pick<OrchestrationThread, "id" | "deletedAt" | "archivedAt" | "activities">;

/**
 * After a restart: expiry timers for every pending request, and the release of those whose thread
 * was archived meanwhile. A surface's own watch (its condition, its target closing) does not
 * survive the restart; the user's answer and the expiry still end the request.
 */
export const reconcileUserActionRequestsAfterRestart = (
  deps: UserActionRemovalDeps,
  threads: ReadonlyArray<RestartedThread>,
) =>
  Effect.gen(function* () {
    yield* watchThreadRemovals(deps);
    yield* forEachPendingRequestAfterRestart(
      threads,
      (activities) => pendingUserActionRequests(activities),
      (threadId, request) =>
        Effect.gen(function* () {
          remember(threadId, request);
          yield* scheduleUserActionRequestExpiry(deps, threadId, request);
        }),
    );
    for (const thread of threads) {
      if (thread.deletedAt === null && thread.archivedAt === null) continue;
      if (pendingUserActionRequests(thread.activities).length === 0) continue;
      yield* releaseUserActionRequestsOfThread(deps, thread.id);
    }
  });

// Requests one thread opens, one at a time in this process: the pending count and the record of a
// new one cannot interleave with another call's.
const openLocks = makeKeyedSemaphore();
const withThreadOpenLock = <A, E, R>(
  threadId: ThreadId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => openLocks.withPermit(threadId, effect);

export interface OpenUserActionRequestInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  /** The caller's own idempotency key: the same one finds the request it opened before. */
  readonly callerRequestId: string;
  readonly surface: UserActionSurface;
  readonly need: UserActionNeed;
  readonly message: string;
  readonly target?: string | undefined;
  readonly ttlMs?: number | undefined;
  readonly maxPending: number;
}

export interface OpenedUserActionRequest {
  readonly request: UserActionRequestView;
  /** False when this caller id had opened it before. */
  readonly created: boolean;
}

/**
 * The request this caller id opened before, if any, without opening one. Fails when the id was
 * used for another surface or target.
 */
export const findUserActionRequest = (
  deps: UserActionRequestDeps,
  input: Pick<OpenUserActionRequestInput, "threadId" | "callerRequestId" | "surface" | "target">,
) =>
  Effect.gen(function* () {
    const requestId = userActionRequestIdFor(input.threadId, input.callerRequestId);
    const requests = yield* readThreadUserActionRequests(deps, input.threadId);
    if (requests === undefined) {
      return yield* Effect.fail(new UserActionRequestOpenError("Thread not found."));
    }
    const existing = requests.find((request) => request.requestId === requestId);
    if (
      existing !== undefined &&
      (existing.surface !== input.surface || existing.target !== (input.target ?? null))
    ) {
      return yield* Effect.fail(
        new UserActionRequestOpenError(
          "This requestId already handed over something else. Use a new requestId.",
        ),
      );
    }
    if (existing !== undefined) remember(input.threadId, existing);
    return { requestId, existing, requests };
  });

/**
 * Opens a request in the caller's thread, or finds the one this caller id opened before. At most
 * `maxPending` unanswered requests per thread. One open at a time per thread.
 */
export const openUserActionRequest = (
  deps: UserActionRequestDeps,
  input: OpenUserActionRequestInput,
): Effect.Effect<OpenedUserActionRequest, UserActionRequestOpenError> =>
  withThreadOpenLock(
    input.threadId,
    Effect.gen(function* () {
      const { requestId, existing, requests } = yield* findUserActionRequest(deps, input);
      if (existing !== undefined) return { request: existing, created: false };
      if (requests.filter((request) => request.status === "pending").length >= input.maxPending) {
        return yield* Effect.fail(
          new UserActionRequestOpenError(
            "This thread already waits on the user for as many hand-offs as it may. Wait for them to finish, or ask the user in chat.",
          ),
        );
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const createdAt = new Date(nowMs).toISOString();
      const message = input.message.trim();
      const payload: UserActionRequestedActivityPayload = {
        requestId,
        surface: input.surface,
        need: input.need,
        message,
        ...(input.target === undefined ? {} : { target: input.target }),
        expiresAt: new Date(nowMs + clampUserActionTtlMs(input.ttlMs)).toISOString(),
      };
      // Only a payload every reader accepts is recorded: one the derivation drops would leave the
      // surface handed over with no card and nothing pending.
      if (!isRequestedPayload(payload)) {
        return yield* Effect.fail(
          new UserActionRequestOpenError(
            `The message must be 1 to ${USER_ACTION_REQUEST_MESSAGE_MAX_CHARS} characters, and the target at most ${USER_ACTION_REQUEST_TARGET_MAX_CHARS}.`,
          ),
        );
      }
      yield* deps.engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`user-action:${requestId}:requested`),
          threadId: input.threadId,
          activity: {
            id: EventId.make(`${requestId}:requested`),
            tone: "info",
            kind: USER_ACTION_REQUESTED_ACTIVITY_KIND,
            summary: userActionRequestLabel(input),
            payload,
            turnId: input.turnId,
            createdAt,
          },
          createdAt,
        })
        .pipe(
          Effect.mapError(
            () => new UserActionRequestOpenError("The node could not record the request."),
          ),
        );
      yield* scheduleUserActionRequestExpiry(deps, input.threadId, payload);
      const request: UserActionRequestView = {
        requestId,
        surface: input.surface,
        need: input.need,
        message,
        target: input.target ?? null,
        requestedAt: createdAt,
        expiresAt: payload.expiresAt,
        turnId: input.turnId,
        status: "pending",
      };
      remember(input.threadId, request);
      return { request, created: true };
    }),
  );

/**
 * The request now; a pending one past its expiry is recorded as `timeout` first. `undefined`
 * when it is gone (its thread was deleted).
 */
export const currentUserActionRequest = (
  deps: UserActionRequestDeps,
  threadId: ThreadId,
  requestId: UserActionRequestId,
) =>
  Effect.gen(function* () {
    const requests = yield* readThreadUserActionRequests(deps, threadId);
    const request = requests?.find((candidate) => candidate.requestId === requestId);
    if (request?.status === "timeout") {
      // Read as expired but maybe not recorded yet: record it (a no-op once it is).
      return yield* resolveUserActionRequest(deps, threadId, requestId, "timeout").pipe(
        Effect.map((recorded) => recorded ?? request),
        Effect.orElseSucceed(() => request),
      );
    }
    return request;
  });

const isResolutionEvent = (event: OrchestrationEvent) =>
  event.type === "thread.activity-appended" &&
  event.payload.activity.kind === USER_ACTION_RESOLVED_ACTIVITY_KIND;

/**
 * The bounded wait of a surface's tool call: returns the request once it ended, or still pending
 * after `waitMs` (at most `USER_ACTION_REQUEST_WAIT_MS_MAX`, under the 60 s cut of every Agent
 * Control call), and the agent calls again to keep waiting. Wakes on the request's resolution.
 */
export const waitForUserActionRequest = (
  deps: UserActionWaitDeps,
  input: {
    readonly threadId: ThreadId;
    readonly requestId: UserActionRequestId;
    readonly waitMs: number;
  },
) =>
  watchThreadRemovals(deps).pipe(
    Effect.andThen(
      deps.waitUntil({
        sources: [deps.threadWakeSource(deps.engine, [input.threadId], isResolutionEvent)],
        check: currentUserActionRequest(deps, input.threadId, input.requestId).pipe(
          Effect.map((current) => ({
            done: current === undefined || current.status !== "pending",
            value: current,
          })),
        ),
        timeoutMs: input.waitMs,
      }),
    ),
    Effect.map((outcome) => outcome.value),
  );

/**
 * A surface's watch of its own request: every `everyMs`, `check` says whether the request ended on
 * the surface (its condition held, its target closed), and the first outcome it names ends the
 * request. Runs detached until the request ends any way, once per request in this process; a
 * failed check is tried again on the next tick.
 */
export const watchUserActionRequest = (
  deps: UserActionRequestDeps,
  input: {
    readonly threadId: ThreadId;
    readonly requestId: UserActionRequestId;
    readonly everyMs: number;
    readonly check: Effect.Effect<UserActionOutcome | null>;
  },
) =>
  Effect.suspend(() => {
    const key = `${input.threadId}\u0000${input.requestId}`;
    if (watched.has(key)) return Effect.void;
    watched.add(key);
    const tick: Effect.Effect<void> = Effect.gen(function* () {
      const thread = yield* readThreadRecord(deps, input.threadId);
      if (thread === undefined || thread.deletedAt !== null || thread.archivedAt !== null) {
        // Removed while it waited (the removal watch may have missed it): release it here.
        yield* releaseUserActionRequestsOfThread(deps, input.threadId);
        return;
      }
      const request = deriveUserActionRequests(thread.activities).find(
        (candidate) => candidate.requestId === input.requestId,
      );
      if (request === undefined || request.status !== "pending") return;
      if (isUserActionRequestExpired(request, yield* Clock.currentTimeMillis)) {
        // The expiry timer records it; stop watching.
        return;
      }
      const outcome = yield* input.check;
      if (outcome !== null) {
        const ended = yield* resolveUserActionRequest(
          deps,
          input.threadId,
          input.requestId,
          outcome,
        ).pipe(Effect.orElseSucceed(() => undefined));
        if (ended === undefined || ended.status !== "pending") return;
      }
      yield* Effect.sleep(Duration.millis(input.everyMs));
      return yield* tick;
    }).pipe(Effect.catchCause(() => Effect.void));
    return tick.pipe(
      Effect.ensuring(Effect.sync(() => watched.delete(key))),
      Effect.forkDetach,
      Effect.asVoid,
    );
  });
const watched = new Set<string>();

/**
 * The owner's Done or Won't do from the card. Every failure is a fixed reason. An answer to a
 * request that already ended fails `already-resolved`, so a second device sees it ended.
 */
export const answerUserActionRequest = (
  deps: UserActionRequestDeps,
  input: UserActionAnswerInput,
): Effect.Effect<UserActionAnswerResult, UserActionRequestError> =>
  Effect.gen(function* () {
    const request = yield* readRecordedRequest(deps, input.threadId, input.requestId);
    if (request === undefined) return yield* failWith("not-found");
    if (request.status !== "pending") return yield* failWith("already-resolved");
    if (isUserActionRequestExpired(request, yield* Clock.currentTimeMillis)) {
      yield* resolveUserActionRequest(deps, input.threadId, input.requestId, "timeout").pipe(
        Effect.ignore,
      );
      return yield* failWith("expired");
    }
    const ended = yield* resolveUserActionRequest(
      deps,
      input.threadId,
      input.requestId,
      input.answer,
    );
    if (ended === undefined) return yield* failWith("not-found");
    // Another path (the surface's condition, the expiry) ended it first.
    if (ended.status !== input.answer) return yield* failWith("already-resolved");
    return { outcome: input.answer };
  });
