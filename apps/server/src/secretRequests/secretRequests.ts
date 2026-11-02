/**
 * The node's side of `ryco_request_secret` (docs/secret-requests.md): opening a request,
 * answering it from the owner's card, and expiring it after a day.
 *
 * A request is two thread activities: `secret.requested` (key, purpose, file, expiry) and one
 * `secret.resolved` (provided, declined or expired). Their command and activity ids derive from
 * the request id, so a request is opened once and resolved once, whoever records first. Answers,
 * expiry and the tool's own expiry check for one request run one at a time in this process, and
 * so do the requests one thread opens (its pending limit holds under parallel tool calls).
 *
 * A request records the identity of the checkout it was opened for (`checkoutId`, never a path);
 * an answer is written only while the thread's checkout still has it. An expiry whose record
 * fails is tried again, with backoff, until it is recorded.
 *
 * The value exists only in `answerSecretRequest`'s input and in the dotenv file it writes: it is
 * not dispatched, logged, traced, returned or kept.
 *
 * Loaded with `import()` the first time an agent asks, the owner answers, or a restart finds a
 * pending request: never at boot.
 *
 * @module secretRequests/secretRequests
 */
import { createHash } from "node:crypto";

import {
  CommandId,
  EventId,
  SECRET_REQUEST_TTL_MS,
  SECRET_REQUESTED_ACTIVITY_KIND,
  SECRET_RESOLVED_ACTIVITY_KIND,
  SecretRequestError,
  SecretRequestId,
  type OrchestrationThread,
  type SecretRequestAnswerInput,
  type SecretRequestAnswerResult,
  type SecretRequestFailureReason,
  type SecretRequestResolution,
  type ThreadId,
  type TurnId,
} from "@ryco/contracts";
import type {
  SecretRequestedActivityPayload,
  SecretResolvedActivityPayload,
} from "@ryco/contracts/secret-request-details";
import { secretRequestFailureMessage } from "@ryco/shared/secretRequests";
import {
  deriveSecretRequests,
  isSecretRequestExpired,
  pendingSecretRequests,
  type SecretRequestView,
} from "@ryco/shared/secretRequestState";
import { Clock, Duration, Effect, Option } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { findThreadInArray } from "../orchestration/threadIndex.ts";
import type { WorkspaceAccessPolicyShape } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import type { RpcConnectionFacts } from "../ws/RpcPrincipal.ts";
import { isEncryptedConnectionPath, readRpcConnectionPath } from "../ws/rpcConnectionPath.ts";
import {
  DotenvSinkError,
  LEFTOVER_TEMPORARY_MIN_AGE_MS,
  normalizeDotenvRelativePath,
  normalizeSecretValue,
  removeDotenvSecretLeftovers,
  resolveDotenvTarget,
  writeDotenvSecret,
} from "./dotenvSink.ts";

export interface SecretRequestDeps {
  readonly engine: Pick<OrchestrationEngineShape, "dispatch" | "getReadModel">;
  readonly projections: Pick<ProjectionSnapshotQueryShape, "getThreadCheckpointContext">;
  /** The node's workspace boundary, when it has one. */
  readonly workspaceAccess?: Pick<WorkspaceAccessPolicyShape, "assertExistingPath"> | undefined;
  /** Passed in from the boot path, so this lazily loaded module does not split it out. */
  readonly findThreadInArray: typeof findThreadInArray;
  /**
   * This machine's own Tailscale addresses, as Tailscale reports them (`undefined` when it
   * cannot say): a direct answer from a Tailscale-range peer is taken only on one of them. From
   * the boot path too (the endpoint registry's service), so this module does not split the
   * Tailscale package out of boot. Only answers read it.
   */
  readonly readNodeTailscaleAddresses?: Effect.Effect<ReadonlyArray<string> | undefined>;
}

const failWith = (reason: SecretRequestFailureReason) =>
  Effect.fail(new SecretRequestError({ reason }));

/** The node's id for a caller's request: stable per thread and caller id, unguessable elsewhere. */
export const secretRequestIdFor = (threadId: ThreadId, callerRequestId: string): SecretRequestId =>
  SecretRequestId.make(
    `secret-request-${createHash("sha256")
      .update(`${threadId}\u0000${callerRequestId}`)
      .digest("hex")
      .slice(0, 32)}`,
  );

const requestedActivityId = (requestId: SecretRequestId) => `${requestId}:requested`;
const resolvedActivityId = (requestId: SecretRequestId) => `${requestId}:resolved`;

/** The thread as the engine holds it now (its command read model keeps the secret activities). */
const readThread = (deps: SecretRequestDeps, threadId: ThreadId) =>
  Effect.gen(function* () {
    if (deps.engine.getReadModel === undefined) return undefined;
    const model = yield* deps.engine.getReadModel();
    const thread: OrchestrationThread | undefined = deps.findThreadInArray(model.threads, threadId);
    return thread === undefined || thread.deletedAt !== null ? undefined : thread;
  });

/** Every request of the thread, with an unanswered request past its expiry read as `expired`. */
export const readThreadSecretRequests = (deps: SecretRequestDeps, threadId: ThreadId) =>
  Effect.gen(function* () {
    const thread = yield* readThread(deps, threadId);
    if (thread === undefined) return undefined;
    const nowMs = yield* Clock.currentTimeMillis;
    return deriveSecretRequests(thread.activities, nowMs);
  });

/**
 * The thread's own checkout now: its worktree, else its project's folder. An answer writes here
 * only when it is still the checkout the request recorded (`checkoutId`): a worktree removed or
 * a thread moved since never sends the value into the project's folder instead.
 */
export const threadCheckout = (deps: SecretRequestDeps, threadId: ThreadId) =>
  Effect.gen(function* () {
    const context = Option.getOrUndefined(
      yield* deps.projections
        .getThreadCheckpointContext(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none())),
    );
    const cwd = context?.worktreePath ?? context?.workspaceRoot;
    if (!cwd) return yield* failWith("no-checkout");
    if (deps.workspaceAccess === undefined) return cwd;
    return yield* deps.workspaceAccess
      .assertExistingPath({ path: cwd, operation: "secret request" })
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "no-checkout" })));
  });

// One answer, expiry or expiry check per request at a time in this process.
const busy = new Set<string>();
const withRequestLock = <A, E, R>(
  threadId: ThreadId,
  requestId: SecretRequestId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SecretRequestError, R> => {
  const key = `${threadId}\u0000${requestId}`;
  return Effect.suspend((): Effect.Effect<A, E | SecretRequestError, R> => {
    if (busy.has(key)) return failWith("busy");
    busy.add(key);
    return effect.pipe(Effect.ensuring(Effect.sync(() => busy.delete(key))));
  });
};

const RESOLVED_SUMMARY: Record<SecretRequestResolution, (key: string, file: string) => string> = {
  provided: (key, file) => `${key} saved to ${file}`,
  declined: (key) => `Declined to provide ${key}`,
  expired: (key) => `Request for ${key} expired`,
};

/** Records how a request ended. A second resolution of the same request changes nothing. */
const recordResolution = (
  deps: SecretRequestDeps,
  threadId: ThreadId,
  request: SecretRequestView,
  status: SecretRequestResolution,
) =>
  Effect.gen(function* () {
    const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const payload: SecretResolvedActivityPayload = { requestId: request.requestId, status };
    yield* deps.engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`secret-request:${request.requestId}:resolved`),
      threadId,
      activity: {
        id: EventId.make(resolvedActivityId(request.requestId)),
        tone: "info",
        kind: SECRET_RESOLVED_ACTIVITY_KIND,
        summary: RESOLVED_SUMMARY[status](request.key, request.file),
        payload,
        turnId: request.turnId === null ? null : (request.turnId as TurnId),
        createdAt,
      },
      createdAt,
    });
  }).pipe(Effect.mapError(() => new SecretRequestError({ reason: "record-failed" })));

/**
 * Records the expiry of a request whose day passed unanswered; anything else is left alone.
 * Fails `busy` while an answer is in progress and `record-failed` when the record failed.
 */
const recordExpiryIfDue = (
  deps: SecretRequestDeps,
  threadId: ThreadId,
  requestId: SecretRequestId,
) =>
  withRequestLock(
    threadId,
    requestId,
    Effect.gen(function* () {
      const thread = yield* readThread(deps, threadId);
      if (thread === undefined) return;
      const request = deriveSecretRequests(thread.activities).find(
        (candidate) => candidate.requestId === requestId,
      );
      if (request?.status !== "pending") return;
      if (!isSecretRequestExpired(request, yield* Clock.currentTimeMillis)) return;
      yield* recordResolution(deps, threadId, request, "expired");
    }),
  );

const logExpiryFailure = (error: SecretRequestError) =>
  error.reason === "busy"
    ? Effect.void
    : Effect.logWarning("Could not record a secret request's expiry", { reason: error.reason });

/** {@link recordExpiryIfDue} for a polling agent: a failure is logged, the timer tries again. */
export const expireSecretRequestIfDue = (
  deps: SecretRequestDeps,
  threadId: ThreadId,
  requestId: SecretRequestId,
) => recordExpiryIfDue(deps, threadId, requestId).pipe(Effect.catch(logExpiryFailure));

/** The wait before trying a failed expiry record again: doubling from this, up to an hour. */
export const SECRET_REQUEST_EXPIRY_RETRY_MS = 5_000;
const SECRET_REQUEST_EXPIRY_RETRY_MAX_MS = 60 * 60 * 1_000;

const scheduled = new Set<string>();

/**
 * Expires the request when its day is up, trying again with backoff while the record fails (or
 * an answer holds the request), so a request never stays pending past its day. The timer lives
 * in this process; after a restart the startup reconciliation schedules it again
 * (`scheduleSecretRequestExpiries`).
 */
export const scheduleSecretRequestExpiry = (
  deps: SecretRequestDeps,
  threadId: ThreadId,
  request: Pick<SecretRequestView, "requestId" | "expiresAt">,
) =>
  Effect.gen(function* () {
    const key = `${threadId}\u0000${request.requestId}`;
    if (scheduled.has(key)) return;
    scheduled.add(key);
    const expiresAtMs = Date.parse(request.expiresAt);
    const delayMs = Number.isFinite(expiresAtMs)
      ? Math.max(0, expiresAtMs - (yield* Clock.currentTimeMillis))
      : 0;
    const attempt = (retryMs: number): Effect.Effect<void> =>
      recordExpiryIfDue(deps, threadId, request.requestId).pipe(
        Effect.catch((error) =>
          logExpiryFailure(error).pipe(
            Effect.andThen(Effect.sleep(Duration.millis(retryMs))),
            Effect.andThen(
              Effect.suspend(() =>
                attempt(Math.min(retryMs * 2, SECRET_REQUEST_EXPIRY_RETRY_MAX_MS)),
              ),
            ),
          ),
        ),
      );
    yield* Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.andThen(attempt(SECRET_REQUEST_EXPIRY_RETRY_MS)),
      Effect.ensuring(Effect.sync(() => scheduled.delete(key))),
      Effect.forkDetach,
    );
  });

type RestartedThread = Pick<OrchestrationThread, "id" | "deletedAt" | "activities">;

/** After a restart: expiry timers for every pending request of these threads. */
export const scheduleSecretRequestExpiries = (
  deps: SecretRequestDeps,
  threads: ReadonlyArray<RestartedThread>,
) =>
  Effect.forEach(
    threads.filter((thread) => thread.deletedAt === null),
    (thread) =>
      Effect.forEach(
        pendingSecretRequests(thread.activities),
        (request) => scheduleSecretRequestExpiry(deps, thread.id, request),
        { discard: true },
      ),
    { discard: true },
  );

/**
 * After a restart: removes the temporary files an answer that crashed mid-write left behind
 * (in the checkout's Git directory or beside the file) for every pending request's file. Such
 * a request is still pending: its answer is recorded only after the rename. Never fails.
 */
export const sweepSecretRequestLeftovers = (
  deps: SecretRequestDeps,
  threads: ReadonlyArray<RestartedThread>,
) =>
  Effect.forEach(
    threads.filter((thread) => thread.deletedAt === null),
    (thread) => {
      const files = new Set(
        pendingSecretRequests(thread.activities).map((request) => request.file),
      );
      if (files.size === 0) return Effect.void;
      return threadCheckout(deps, thread.id).pipe(
        Effect.flatMap((checkout) =>
          Effect.promise(() =>
            Promise.all(
              Array.from(files, (file) => removeDotenvSecretLeftovers({ checkout, file })),
            ),
          ),
        ),
        Effect.ignore,
      );
    },
    { discard: true },
  );

/**
 * What a restart owes pending secret requests: their expiry timers now, and the sweep of crash
 * leftovers once a leftover is old enough to be one (a write in progress elsewhere is younger).
 */
export const reconcileSecretRequestsAfterRestart = (
  deps: SecretRequestDeps,
  threads: ReadonlyArray<RestartedThread>,
) =>
  scheduleSecretRequestExpiries(deps, threads).pipe(
    Effect.andThen(
      Effect.sleep(Duration.millis(LEFTOVER_TEMPORARY_MIN_AGE_MS)).pipe(
        Effect.andThen(sweepSecretRequestLeftovers(deps, threads)),
        Effect.forkDetach,
      ),
    ),
    Effect.asVoid,
  );

// Requests one thread opens, one at a time in this process: the count of pending requests and
// the record of a new one cannot interleave with another call's.
const openLocks = new Map<string, Semaphore.Semaphore>();
const withThreadOpenLock = <A, E, R>(
  threadId: ThreadId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let lock = openLocks.get(threadId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      openLocks.set(threadId, lock);
    }
    return lock.withPermits(1)(effect);
  });

/** Why a request could not be opened, in words for the agent. */
export class SecretRequestOpenError {
  readonly _tag = "SecretRequestOpenError";
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/**
 * Opens a request in the caller's thread, or finds the one this caller id opened before. The
 * file is checked now (checkout, links, `.git`, Git ignore and tracking), so the agent hears
 * about a bad file at once and the user is never shown a card that cannot be saved. The
 * checkout's identity is recorded with the request. One open at a time per thread.
 */
export const openSecretRequest = (
  deps: SecretRequestDeps,
  input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly callerRequestId: string;
    readonly key: string;
    readonly purpose: string;
    readonly file: string;
    readonly maxPending: number;
  },
) =>
  withThreadOpenLock(
    input.threadId,
    Effect.gen(function* () {
      const requestId = secretRequestIdFor(input.threadId, input.callerRequestId);
      const requests = yield* readThreadSecretRequests(deps, input.threadId);
      if (requests === undefined) {
        return yield* Effect.fail(new SecretRequestOpenError("Thread not found."));
      }
      const file = normalizeDotenvRelativePath(input.file);
      if (file === null) {
        return yield* Effect.fail(
          new SecretRequestOpenError(
            "Use a dotenv file relative to this thread's checkout (.env, .env.local, name.env or .dev.vars), without .., links or .git.",
          ),
        );
      }
      const existing = requests.find((request) => request.requestId === requestId);
      if (existing !== undefined) {
        if (existing.key !== input.key || existing.file !== file) {
          return yield* Effect.fail(
            new SecretRequestOpenError(
              "This requestId already asked for another key or file. Use a new requestId.",
            ),
          );
        }
        return existing;
      }
      if (requests.filter((request) => request.status === "pending").length >= input.maxPending) {
        return yield* Effect.fail(
          new SecretRequestOpenError(
            "This thread already has as many unanswered secret requests as it may. Wait for the user to answer or decline them.",
          ),
        );
      }
      const checkout = yield* threadCheckout(deps, input.threadId).pipe(
        Effect.mapError(
          (error) => new SecretRequestOpenError(secretRequestFailureMessage(error.reason)),
        ),
      );
      const target = yield* Effect.tryPromise({
        try: () => resolveDotenvTarget({ checkout, file }),
        catch: (cause) =>
          new SecretRequestOpenError(
            secretRequestFailureMessage(
              cause instanceof DotenvSinkError ? cause.reason : "unsafe-path",
            ),
          ),
      });
      const nowMs = yield* Clock.currentTimeMillis;
      const createdAt = new Date(nowMs).toISOString();
      const payload: SecretRequestedActivityPayload = {
        requestId,
        key: input.key,
        purpose: input.purpose,
        file,
        expiresAt: new Date(nowMs + SECRET_REQUEST_TTL_MS).toISOString(),
        checkoutId: target.checkoutId,
      };
      yield* deps.engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`secret-request:${requestId}:requested`),
          threadId: input.threadId,
          activity: {
            id: EventId.make(requestedActivityId(requestId)),
            tone: "info",
            kind: SECRET_REQUESTED_ACTIVITY_KIND,
            summary: `Asked for ${input.key} for ${file}`,
            payload,
            turnId: input.turnId,
            createdAt,
          },
          createdAt,
        })
        .pipe(
          Effect.mapError(
            () => new SecretRequestOpenError("The node could not record the request."),
          ),
        );
      yield* scheduleSecretRequestExpiry(deps, input.threadId, payload);
      const view: SecretRequestView = {
        requestId,
        key: input.key,
        purpose: input.purpose,
        file,
        requestedAt: createdAt,
        expiresAt: payload.expiresAt,
        checkoutId: payload.checkoutId,
        turnId: input.turnId,
        status: "pending",
      };
      return view;
    }),
  );

/**
 * The status of the caller's request now; a pending one past its expiry is recorded expired.
 * `undefined` when the request is gone (its thread was deleted).
 */
export const currentSecretRequest = (
  deps: SecretRequestDeps,
  threadId: ThreadId,
  requestId: SecretRequestId,
) =>
  Effect.gen(function* () {
    const requests = yield* readThreadSecretRequests(deps, threadId);
    const request = requests?.find((candidate) => candidate.requestId === requestId);
    if (request?.status === "expired") {
      yield* expireSecretRequestIfDue(deps, threadId, requestId);
    }
    return request;
  });

/**
 * The owner's answer from the card: writes the value into the request's file (provide) or
 * closes the request (decline). Every failure is a fixed reason; the value appears in none.
 *
 * A value is taken only from a connection the node itself saw as encrypted, or as never on a
 * network in the clear (`readRpcConnectionPath`), and refused before anything reads it: it is not
 * checked, written or recorded. A decline carries no value and is taken from any connection, so
 * a request can always be closed.
 */
export const answerSecretRequest = (
  deps: SecretRequestDeps,
  input: SecretRequestAnswerInput,
  connection: RpcConnectionFacts | undefined,
): Effect.Effect<SecretRequestAnswerResult, SecretRequestError> =>
  withRequestLock(
    input.threadId,
    input.requestId,
    Effect.gen(function* () {
      if (input.answer.type === "provide") {
        const path = yield* readRpcConnectionPath(
          connection,
          deps.readNodeTailscaleAddresses ?? Effect.succeed(undefined),
        );
        if (!isEncryptedConnectionPath(path)) return yield* failWith("unencrypted-connection");
      }
      const thread = yield* readThread(deps, input.threadId);
      if (thread === undefined) return yield* failWith("not-found");
      const request = deriveSecretRequests(thread.activities).find(
        (candidate) => candidate.requestId === input.requestId,
      );
      if (request === undefined) return yield* failWith("not-found");
      if (request.status !== "pending") return yield* failWith("already-answered");
      if (isSecretRequestExpired(request, yield* Clock.currentTimeMillis)) {
        yield* recordResolution(deps, input.threadId, request, "expired").pipe(Effect.ignore);
        return yield* failWith("expired");
      }
      if (input.answer.type === "decline") {
        yield* recordResolution(deps, input.threadId, request, "declined");
        return { status: "declined" as const, file: request.file, key: request.key };
      }
      const value = normalizeSecretValue(input.answer.value);
      if (value.length === 0) return yield* failWith("empty-value");
      const checkout = yield* threadCheckout(deps, input.threadId);
      yield* Effect.tryPromise({
        try: () =>
          writeDotenvSecret({
            checkout,
            file: request.file,
            key: request.key,
            value,
            checkoutId: request.checkoutId,
          }),
        catch: (cause) =>
          new SecretRequestError({
            reason: cause instanceof DotenvSinkError ? cause.reason : "write-failed",
          }),
      });
      yield* recordResolution(deps, input.threadId, request, "provided");
      return { status: "provided" as const, file: request.file, key: request.key };
    }),
  );
