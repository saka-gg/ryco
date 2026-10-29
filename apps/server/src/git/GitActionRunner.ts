/**
 * GitActionRunner - recoverable stacked Git actions (commit, push, pull request) that outlive
 * the request that started them.
 *
 * A recoverable action runs in the runner's scope, not in its request's: when the client's
 * connection drops, the action goes on, and the client attaches again with the same input
 * (`git.resumeStackedAction`) to get the progress it missed and the outcome. Records are keyed
 * by owner and action id; a fingerprint of the input keeps an id from attaching to a different
 * action. Records live in memory only. After a node restart a resume reports the result as
 * unavailable and never runs Git again: a graceful shutdown stops the Git child with the
 * runner's scope, but a node that crashed ran no finalizers, and its Git child (in its own
 * process group) may still finish. Either way only the repository knows, so the client asks
 * the user to check it rather than retrying.
 *
 * This module is the service and its layer, on the boot path; the runner itself
 * (`gitActionRunnerCore.ts`) loads with the first recoverable action.
 *
 * @module GitActionRunner
 */
import type {
  GitActionProgressEvent,
  GitActionResultUnavailableError,
  GitActionStoppedError,
  GitManagerServiceError,
  GitRunStackedActionInput,
} from "@ryco/contracts";
import { Context, Effect, Layer, Option, Scope, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { directPairingOwnerKey } from "../ws/RpcPrincipal.ts";

/** Settled receipts (and resume misses) kept for a client that attaches late. */
export const GIT_ACTION_RECEIPTS_TO_KEEP = 256;
/** How long a settled receipt stays readable; at least the client's resume horizon. */
export const GIT_ACTION_RECEIPT_TTL_MS = 30 * 60_000;
/** Progress buffered per observer; a slow observer loses its oldest events, never the work. */
export const GIT_ACTION_OBSERVER_BUFFER = 128;

export type GitStackedActionStreamError = GitManagerServiceError | GitActionStoppedError;
export type GitResumeStackedActionStreamError =
  | GitStackedActionStreamError
  | GitActionResultUnavailableError;
export type GitActionPublish = (event: GitActionProgressEvent) => Effect.Effect<void>;
export type GitActionStopReason = GitActionStoppedError["reason"];

export interface GitActionRunnerShape {
  /**
   * Starts a recoverable action and follows it, or follows the running one when the same
   * owner sends the same input again: a repeated start never runs Git twice. Refused for an
   * id that is not a random UUID, an id a resume already reported unavailable, an id used for
   * a different input, and while another recoverable action runs in the same checkout.
   */
  readonly start: (input: {
    readonly owner: string;
    /** As decoded; `recoverable` is not part of the fingerprint. */
    readonly command: GitRunStackedActionInput;
    readonly run: (publish: GitActionPublish) => Effect.Effect<void, GitManagerServiceError>;
  }) => Stream.Stream<GitActionProgressEvent, GitStackedActionStreamError>;
  /**
   * Follows an action again: its current progress, then the rest. Never starts one; without
   * a record it fails with `GitActionResultUnavailableError("missing")` and refuses a later
   * start of that id.
   */
  readonly resume: (input: {
    readonly owner: string;
    readonly command: GitRunStackedActionInput;
  }) => Stream.Stream<GitActionProgressEvent, GitResumeStackedActionStreamError>;
  /**
   * Stops a running action of this owner (its Git child is killed); false when none runs
   * under the id or it already reported its result.
   */
  readonly cancel: (input: {
    readonly owner: string;
    readonly actionId: string;
  }) => Effect.Effect<boolean>;
  /**
   * Stops every running action of an owner whose access ended and refuses its later starts
   * (one may already be on its way); returns how many were running.
   */
  readonly stopOwner: (owner: string, reason: "access-revoked") => Effect.Effect<number>;
}

export class GitActionRunner extends Context.Service<GitActionRunner, GitActionRunnerShape>()(
  "ryco/git/GitActionRunner",
) {}

/**
 * The node's runner, shared by every connection (direct and relay). Revoking a direct pairing
 * stops the actions it started; a renewal of the pairing does not. The runner loads with the
 * first action that needs it, or with a revocation: a start may be waiting for the load.
 */
export const GitActionRunnerLive = Layer.effect(
  GitActionRunner,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const storage = yield* Effect.serviceOption(SqlClient.SqlClient);
    let loaded: GitActionRunnerShape | undefined;
    const load = yield* Effect.cached(
      Effect.promise(() => import("./gitActionRunnerCore.ts")).pipe(
        Effect.flatMap(({ makeGitActionRunner }) =>
          makeGitActionRunner.pipe(
            Scope.provide(scope),
            Option.isSome(storage)
              ? Effect.provideService(SqlClient.SqlClient, storage.value)
              : (effect) => effect,
          ),
        ),
        Effect.tap((runner) =>
          Effect.sync(() => {
            loaded = runner;
          }),
        ),
      ),
    );
    const runner: GitActionRunnerShape = {
      start: (input) => Stream.unwrap(Effect.map(load, (core) => core.start(input))),
      // Loads too: a miss must refuse a later start of the id.
      resume: (input) => Stream.unwrap(Effect.map(load, (core) => core.resume(input))),
      cancel: (input) =>
        Effect.suspend(() => (loaded === undefined ? Effect.succeed(false) : loaded.cancel(input))),
      // Loads too: the runner must refuse a start of that owner that is waiting for the load.
      stopOwner: (owner, reason) => Effect.flatMap(load, (core) => core.stopOwner(owner, reason)),
    };
    const sessions = yield* Effect.serviceOption(SessionCredentialService);
    if (Option.isSome(sessions)) {
      yield* sessions.value.streamChanges.pipe(
        Stream.runForEach((change) =>
          change.type === "clientRemoved" && change.reason === "revoked"
            ? runner.stopOwner(directPairingOwnerKey(change.chainId), "access-revoked")
            : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
    }
    return runner;
  }),
);
