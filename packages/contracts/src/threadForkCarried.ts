import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { GitCommitOid } from "./git.ts";
import { AgentTokenMode, ProviderInteractionMode } from "./orchestration.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { RuntimeMode } from "./runtimeMode.ts";
import { ThreadForkBaseRef, ThreadForkCarriedRequest } from "./threadFork.ts";

/**
 * Continue a thread on another machine (`threads.forkCarried`, docs/thread-forks.md).
 *
 * The client reads a thread's conversation from its own node (A) and carries it to another node
 * (B), which creates a fork from it. B never contacts A: nothing here is a credential, a URL or a
 * path, and the source fields are display-only. B continues the fork by context handoff, built
 * from the carried messages on B.
 *
 * Only clients and the node's lazily loaded carried fork module read these schemas; the RPC
 * payload itself (`ThreadForkCarriedRequest`, threadFork.ts) carries the conversation undecoded.
 */

/** The largest carried conversation, as UTF-8 JSON: under the relay's 4 MiB RPC frame. */
export const CARRIED_THREAD_HISTORY_MAX_BYTES = 3.5 * 1_024 * 1_024;
/** Messages a carried conversation holds at most (the fork publication's own limit). */
export const CARRIED_THREAD_HISTORY_MAX_MESSAGES = 2_000;
export const CARRIED_THREAD_HISTORY_MAX_PLANS = 200;
export const CARRIED_THREAD_HISTORY_MAX_TURN_OUTCOMES = 2_000;
/** One message or plan text. A longer one is shortened by the client before it is carried. */
export const CARRIED_THREAD_TEXT_MAX_CHARS = 200_000;

/** A UTC ISO time as `Date#toISOString` writes it. */
export const CarriedThreadTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
);

/** Where the conversation comes from. Display-only provenance. */
export const CarriedThreadSource = Schema.Struct({
  machineLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  threadTitle: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  threadId: ThreadId.check(Schema.isMaxLength(128)),
  environmentId: EnvironmentId.check(Schema.isMaxLength(128)),
});
export type CarriedThreadSource = typeof CarriedThreadSource.Type;

export const CarriedThreadMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(CARRIED_THREAD_TEXT_MAX_CHARS)),
  createdAt: CarriedThreadTime,
  /** The turn the message belongs to (a prompt: the turn it started). Every reply has one. */
  turnId: Schema.NullOr(TurnId.check(Schema.isMaxLength(128))),
});
export type CarriedThreadMessage = typeof CarriedThreadMessage.Type;

export const CarriedThreadPlan = Schema.Struct({
  turnId: Schema.NullOr(TurnId.check(Schema.isMaxLength(128))),
  planMarkdown: TrimmedNonEmptyString.check(Schema.isMaxLength(CARRIED_THREAD_TEXT_MAX_CHARS)),
  createdAt: CarriedThreadTime,
  /** When it was carried out, if that was before the picked reply. */
  implementedAt: Schema.NullOr(CarriedThreadTime),
});
export type CarriedThreadPlan = typeof CarriedThreadPlan.Type;

/** A carried turn that did not complete, so a fork of the fork refuses it as a boundary. */
export const CarriedThreadTurnOutcome = Schema.Struct({
  turnId: TurnId.check(Schema.isMaxLength(128)),
  state: Schema.Literals(["interrupted", "error"]),
});
export type CarriedThreadTurnOutcome = typeof CarriedThreadTurnOutcome.Type;

/**
 * The source's model by driver: provider instance ids are machine-local, so the node picks its
 * own instance of that driver (`@ryco/shared/carriedFork`).
 */
export const CarriedThreadModel = Schema.Struct({
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type CarriedThreadModel = typeof CarriedThreadModel.Type;

/**
 * A thread's conversation up to and including the picked reply: the last message is that reply.
 * Not carried: attachments, tool activity, checkpoints, approvals, provider sessions and files.
 */
export const CarriedThreadHistory = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: CarriedThreadSource,
  messages: Schema.Array(CarriedThreadMessage).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CARRIED_THREAD_HISTORY_MAX_MESSAGES),
  ),
  proposedPlans: Schema.Array(CarriedThreadPlan).check(
    Schema.isMaxLength(CARRIED_THREAD_HISTORY_MAX_PLANS),
  ),
  turnOutcomes: Schema.Array(CarriedThreadTurnOutcome).check(
    Schema.isMaxLength(CARRIED_THREAD_HISTORY_MAX_TURN_OUTCOMES),
  ),
  model: CarriedThreadModel,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  tokenMode: Schema.optional(AgentTokenMode),
});
export type CarriedThreadHistory = typeof CarriedThreadHistory.Type;

/**
 * Where a fork carried from another node works:
 * - `new-worktree`: a new worktree of the target's own project, from the source's published
 *   branch (`baseRef` is `origin/<branch>`), which the target fetches with its own remote and
 *   credentials. `commit` is the commit the source checkout is at (with nothing left to push it
 *   is on that branch): the target starts the worktree from exactly that commit, and refuses
 *   unless its own fresh `origin/<branch>` is that commit or descends from it.
 * - `new-chat`: a new chat with an empty folder, for a chat without a project.
 */
export const ThreadForkCarriedDestination = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("new-worktree"),
    start: Schema.Struct({
      kind: Schema.Literal("base-ref"),
      baseRef: ThreadForkBaseRef,
      commit: GitCommitOid,
    }),
  }),
  Schema.Struct({ kind: Schema.Literal("new-chat") }),
]);
export type ThreadForkCarriedDestination = typeof ThreadForkCarriedDestination.Type;

/** `threads.forkCarried`'s input typed, as clients build it and the target node decodes it. */
export const ThreadForkCarriedInput = Schema.Struct({
  ...ThreadForkCarriedRequest.fields,
  destination: ThreadForkCarriedDestination,
  history: CarriedThreadHistory,
});
export type ThreadForkCarriedInput = typeof ThreadForkCarriedInput.Type;
