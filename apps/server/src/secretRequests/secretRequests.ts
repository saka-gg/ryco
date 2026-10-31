/**
 * The node's side of `ryco_request_secret` (docs/secret-requests.md): opening a request,
 * answering it from the owner's card, and expiring it after a day.
 *
 * A request is two thread activities: `secret.requested` (key, purpose, file, expiry) and one
 * `secret.resolved` (provided, declined or expired). Their command and activity ids derive from
 * the request id, so a request is opened once and resolved once, whoever records first. Answers,
 * expiry and the tool's own expiry check for one request run one at a time in this process.
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
import {
  deriveSecretRequests,
  isSecretRequestExpired,
  secretRequestFailureMessage,
  type SecretRequestView,
} from "@ryco/shared/secretRequests";
import { Clock, Duration, Effect, Option } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { findThreadInArray } from "../orchestration/threadIndex.ts";
import type { WorkspaceAccessPolicyShape } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import {
  DotenvSinkError,
  normalizeDotenvRelativePath,
  normalizeSecretValue,
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

/** The thread's own checkout: its worktree, else its project's folder. */
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

/** Records the expiry of a request whose day passed unanswered; anything else is left alone. */
export const expireSecretRequestIfDue = (
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
  ).pipe(
    Effect.catch((error) =>
      error.reason === "busy"
        ? Effect.void
        : Effect.logWarning("Could not record a secret request's expiry", {
            reason: error.reason,
          }),
    ),
  );

const scheduled = new Set<string>();

/**
 * Expires the request when its day is up. The timer lives in this process; after a restart the
 * startup reconciliation schedules it again (`scheduleSecretRequestExpiries`).
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
    yield* Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.andThen(expireSecretRequestIfDue(deps, threadId, request.requestId)),
      Effect.ensuring(Effect.sync(() => scheduled.delete(key))),
      Effect.forkDetach,
    );
  });

/** After a restart: expiry timers for every pending request of these threads. */
export const scheduleSecretRequestExpiries = (
  deps: SecretRequestDeps,
  threads: ReadonlyArray<Pick<OrchestrationThread, "id" | "deletedAt" | "activities">>,
) =>
  Effect.forEach(
    threads.filter((thread) => thread.deletedAt === null),
    (thread) =>
      Effect.forEach(
        deriveSecretRequests(thread.activities).filter((request) => request.status === "pending"),
        (request) => scheduleSecretRequestExpiry(deps, thread.id, request),
        { discard: true },
      ),
    { discard: true },
  );

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
 * file is checked now (checkout, links, `.git`, Git ignore), so the agent hears about a bad
 * file at once and the user is never shown a card that cannot be saved.
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
    yield* Effect.tryPromise({
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
        Effect.mapError(() => new SecretRequestOpenError("The node could not record the request.")),
      );
    yield* scheduleSecretRequestExpiry(deps, input.threadId, payload);
    const view: SecretRequestView = {
      requestId,
      key: input.key,
      purpose: input.purpose,
      file,
      requestedAt: createdAt,
      expiresAt: payload.expiresAt,
      turnId: input.turnId,
      status: "pending",
    };
    return view;
  });

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
 */
export const answerSecretRequest = (
  deps: SecretRequestDeps,
  input: SecretRequestAnswerInput,
): Effect.Effect<SecretRequestAnswerResult, SecretRequestError> =>
  withRequestLock(
    input.threadId,
    input.requestId,
    Effect.gen(function* () {
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
        try: () => writeDotenvSecret({ checkout, file: request.file, key: request.key, value }),
        catch: (cause) =>
          new SecretRequestError({
            reason: cause instanceof DotenvSinkError ? cause.reason : "write-failed",
          }),
      });
      yield* recordResolution(deps, input.threadId, request, "provided");
      return { status: "provided" as const, file: request.file, key: request.key };
    }),
  );
