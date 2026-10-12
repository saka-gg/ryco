/**
 * Durable shapes of the chat fork ledger (`thread_forks`, migration 084).
 *
 * A row is written once a fork request is accepted, before any side effect. `plan` pins
 * everything decided at acceptance (boundary, destination, pinned commits, provider strategy,
 * the publication command); the other JSON columns record what the run created, each persisted
 * before the next step, so a restart resumes from `phase` without repeating a native fork or
 * creating a second checkout. Only resources recorded here are ever cleaned up. Once a row
 * settles for good (completed, or failed without retry) it only answers replays, so the
 * publication's inherited history is dropped from its plan.
 *
 * Also the deterministic identity derived from a fork key, so a retried or resumed request
 * always targets the same thread, commands, worktree and branch.
 *
 * Schemas and pure functions only.
 */
import {
  ChatAttachment,
  CheckpointRef,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  type ThreadForkAttemptState,
  type ThreadForkCreateCommand,
  ThreadForkDestination,
  ThreadForkErrorReason,
  ThreadForkHandoffReason,
  type ThreadForkInput,
  ThreadForkKey,
  ThreadForkResult,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  WorktreeId,
} from "@ryco/contracts";
import { Schema, Struct } from "effect";

import { canonicalJson, sha256Hex } from "../canonicalJson.ts";

export const ThreadForkPhase = Schema.Literals([
  /** Plan pinned; nothing created yet. */
  "accepted",
  /** A new worktree's path and branch are recorded; `git worktree add` may have run. */
  "checkout-preparing",
  /** The destination exists (or was verified for `current-checkout`). */
  "checkout-ready",
  /** A native fork call may be in flight. Never call it again for this key. */
  "provider-forking",
  /** The native copy (or the decision to hand off) is recorded. */
  "provider-ready",
  /** The fork thread is published; only post-publication work remains. */
  "published",
  "completed",
  "failed",
]);
export type ThreadForkPhase = typeof ThreadForkPhase.Type;

export const THREAD_FORK_UNFINISHED_PHASES: ReadonlyArray<ThreadForkPhase> = [
  "accepted",
  "checkout-preparing",
  "checkout-ready",
  "provider-forking",
  "provider-ready",
  "published",
];

export const ThreadForkDestinationKind = Schema.Literals([
  "current-checkout",
  "new-worktree",
  "new-chat",
]);
export type ThreadForkDestinationKind = typeof ThreadForkDestinationKind.Type;

/** A full Git object id (SHA-1 or SHA-256). */
export const GitCommitOid = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
);
export type GitCommitOid = typeof GitCommitOid.Type;

const Sha256HexDigest = TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/** Provider drivers that can fork natively at a selected turn. */
export const ThreadForkNativeDriver = Schema.Literals(["codex", "claudeAgent"]);
export type ThreadForkNativeDriver = typeof ThreadForkNativeDriver.Type;

/** The `thread.fork.create` command, decoded through the shared command union. */
export const ThreadForkPublishCommand = OrchestrationCommand.pipe(
  Schema.refine(
    (command): command is ThreadForkCreateCommand => command.type === "thread.fork.create",
  ),
);

/** How the destination is prepared, pinned at acceptance. */
export const ThreadForkCheckoutPlan = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("current-checkout"),
    /** The source's checkout, shared as is. Null ids/paths: the project root of a non-Git project. */
    worktreeId: Schema.NullOr(WorktreeId),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
    branch: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("new-worktree"),
    worktreeId: WorktreeId,
    /** Fork-derived, so a branch with this name is provably this fork's. */
    branch: TrimmedNonEmptyString,
    start: Schema.Literals(["checkpoint", "base-ref"]),
    /** What the user chose (`base-ref`), or the source commit the checkpoint is laid on. */
    baseRef: TrimmedNonEmptyString,
    /** Where `git worktree add` runs: the project's workspace root. */
    repositoryRoot: TrimmedNonEmptyString,
    /** The new branch's start commit, resolved at acceptance and pinned under `baseCommitRef`. */
    baseCommit: GitCommitOid,
    baseCommitRef: CheckpointRef,
    /** `checkpoint` only: the snapshot overlaid on the new worktree, pinned under its own ref. */
    checkpointCommit: Schema.NullOr(GitCommitOid),
    checkpointCommitRef: Schema.NullOr(CheckpointRef),
  }),
  Schema.Struct({
    kind: Schema.Literal("new-chat"),
    /** Fork-derived chat project. */
    projectId: ProjectId,
    titleSeed: TrimmedNonEmptyString,
  }),
]);
export type ThreadForkCheckoutPlan = typeof ThreadForkCheckoutPlan.Type;

/**
 * Where a Claude copy ends: the boundary turn's last main-chain entry, read from the source
 * transcript when the fork was accepted. Transcripts only grow, so the entry keeps its position
 * while later turns are appended; the run forks up to exactly this entry and never to a tail it
 * reads later.
 */
export const ThreadForkClaudeCutoff = Schema.Struct({
  entryUuid: TrimmedNonEmptyString,
  /** Its position in the main chain, oldest first. */
  entryIndex: NonNegativeInt,
});
export type ThreadForkClaudeCutoff = typeof ThreadForkClaudeCutoff.Type;

const nativeProviderPlanFields = {
  kind: Schema.Literal("native"),
  instanceId: ProviderInstanceId,
  /** sha-256 of the instance configuration when accepted; a changed config hands off. */
  configFingerprint: Sha256HexDigest,
  /** Codex thread id, or the Claude session uuid, of the source binding. */
  sourceNativeId: TrimmedNonEmptyString,
  /** The cwd the source session ran in (its binding's `runtimePayload.cwd`). */
  recordedCwd: TrimmedNonEmptyString,
  /** The boundary turn: the native copy ends with it. */
  turnId: TurnId,
  /** User turns the fork inherits (Claude cursor `turnCount`). */
  inheritedUserTurnCount: NonNegativeInt,
};

/** The provider strategy chosen at acceptance. A native candidate may still hand off. */
export const ThreadForkProviderPlan = Schema.Union([
  /** Codex forks with an exact `lastTurnId`: nothing else to pin. */
  Schema.Struct({ ...nativeProviderPlanFields, driver: Schema.Literal("codex") }),
  Schema.Struct({
    ...nativeProviderPlanFields,
    driver: Schema.Literal("claudeAgent"),
    cutoff: ThreadForkClaudeCutoff,
  }),
  Schema.Struct({
    kind: Schema.Literal("handoff"),
    reason: ThreadForkHandoffReason,
  }),
]);
export type ThreadForkProviderPlan = typeof ThreadForkProviderPlan.Type;

/** An inherited attachment and the fork-owned id its copy gets. */
export const ThreadForkAttachmentCopy = Schema.Struct({
  source: ChatAttachment,
  attachmentId: TrimmedNonEmptyString,
});
export type ThreadForkAttachmentCopy = typeof ThreadForkAttachmentCopy.Type;

export const ThreadForkNotice = TrimmedNonEmptyString.check(Schema.isMaxLength(500));

export const ThreadForkPlan = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  forkThreadId: ThreadId,
  /** The fork's project: the source's, or the new chat's. */
  projectId: ProjectId,
  sourceProjectId: ProjectId,
  sourceThreadId: ThreadId,
  sourceMessageId: MessageId,
  sourceTurnId: TurnId,
  sourceTitle: TrimmedNonEmptyString,
  destination: ThreadForkDestination,
  checkout: ThreadForkCheckoutPlan,
  provider: ThreadForkProviderPlan,
  attachments: Schema.Array(ThreadForkAttachmentCopy),
  /** The publication, finalized with the checkout and provider outcome before dispatch. */
  command: ThreadForkPublishCommand,
  /** Shown with the result, e.g. that older history was not inherited. */
  notices: Schema.Array(ThreadForkNotice),
});
export type ThreadForkPlan = typeof ThreadForkPlan.Type;

/** What the checkout step created or verified. */
export const ThreadForkCheckoutRecord = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("current-checkout"),
    worktreeId: Schema.NullOr(WorktreeId),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
    branch: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("new-worktree"),
    worktreeId: WorktreeId,
    /**
     * The fork-derived name. Recorded before Git runs, so it is only removed while it still
     * points at the plan's `baseCommit` (what this fork created); a branch anyone moved stays.
     */
    branch: TrimmedNonEmptyString,
    /** Recorded before `git worktree add`; the created checkout's path once ready. */
    worktreePath: TrimmedNonEmptyString,
    /** Set when Git left submodules uninitialized (e.g. disabled by settings); shown with the result. */
    submoduleNotice: Schema.optional(ThreadForkNotice),
  }),
  Schema.Struct({
    kind: Schema.Literal("new-chat"),
    projectId: ProjectId,
    folder: TrimmedNonEmptyString,
    /** Only a folder this fork created may be released on failure. */
    createdFolder: Schema.Boolean,
  }),
]);
export type ThreadForkCheckoutRecord = typeof ThreadForkCheckoutRecord.Type;

/** A native copy this fork created and proved; the only kind it may delete. */
export const ThreadForkOwnedNativeCopy = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("codex-thread"), threadId: TrimmedNonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("claude-file"),
    /** The instance's Claude config root; the file must stay inside it. */
    root: TrimmedNonEmptyString,
    file: TrimmedNonEmptyString,
  }),
]);
export type ThreadForkOwnedNativeCopy = typeof ThreadForkOwnedNativeCopy.Type;

/** What the provider step decided or created. */
export const ThreadForkProviderRecord = Schema.Union([
  /** Written by the claim to `provider-forking`, before the native call. */
  Schema.Struct({
    kind: Schema.Literal("forking"),
    driver: ThreadForkNativeDriver,
    instanceId: ProviderInstanceId,
    targetCwd: TrimmedNonEmptyString,
    startedAt: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("native"),
    driver: ThreadForkNativeDriver,
    instanceId: ProviderInstanceId,
    nativeThreadId: TrimmedNonEmptyString,
    resumeCursor: Schema.Unknown,
    /** The fork's effective cwd, canonical: the binding's `runtimePayload.cwd`. */
    cwd: TrimmedNonEmptyString,
    runtimeSessionId: RuntimeSessionId,
    ownedCopy: ThreadForkOwnedNativeCopy,
  }),
  Schema.Struct({
    kind: Schema.Literal("handoff"),
    reason: ThreadForkHandoffReason,
    detail: Schema.NullOr(Schema.String),
    /**
     * A copy the native fork provably created (its id came from the provider) but could neither
     * verify nor remove. The fork never uses it; the run removes it once more after publication
     * (or on failure), and the record keeps its id either way.
     */
    orphan: Schema.optional(
      Schema.Struct({
        nativeThreadId: TrimmedNonEmptyString,
        copy: ThreadForkOwnedNativeCopy,
      }),
    ),
  }),
]);
export type ThreadForkProviderRecord = typeof ThreadForkProviderRecord.Type;

/** Fork-owned attachment copies that exist on disk. */
export const ThreadForkAttachmentsRecord = Schema.Struct({
  attachmentIds: Schema.Array(TrimmedNonEmptyString),
});
export type ThreadForkAttachmentsRecord = typeof ThreadForkAttachmentsRecord.Type;

/** The `ThreadForkError` a failed row answers with. */
export const ThreadForkFailure = Schema.Struct({
  reason: ThreadForkErrorReason,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type ThreadForkFailure = typeof ThreadForkFailure.Type;

export const ThreadForkLedgerRow = Schema.Struct({
  forkKey: ThreadForkKey,
  requestDigest: Sha256HexDigest,
  forkThreadId: ThreadId,
  sourceThreadId: ThreadId,
  sourceMessageId: MessageId,
  destinationKind: ThreadForkDestinationKind,
  phase: ThreadForkPhase,
  plan: ThreadForkPlan,
  checkout: Schema.NullOr(ThreadForkCheckoutRecord),
  provider: Schema.NullOr(ThreadForkProviderRecord),
  attachments: Schema.NullOr(ThreadForkAttachmentsRecord),
  result: Schema.NullOr(ThreadForkResult),
  error: Schema.NullOr(ThreadForkFailure),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadForkLedgerRow = typeof ThreadForkLedgerRow.Type;

/**
 * A row without its plan: what a phase transition returns. The plan never changes after
 * acceptance (a settled row only drops its inherited history), so the run keeps the plan it
 * already holds instead of decoding it again at every phase.
 */
export const ThreadForkLedgerState = ThreadForkLedgerRow.mapFields(Struct.omit(["plan"]));
export type ThreadForkLedgerState = typeof ThreadForkLedgerState.Type;

/** What a row's key holds for its request, as `ThreadForkError.attempt` reports it. */
export function threadForkAttemptState(
  row: Pick<ThreadForkLedgerRow, "phase"> | undefined,
): ThreadForkAttemptState {
  if (row === undefined) return "none";
  return row.phase === "completed" || row.phase === "failed" ? "stopped" : "running";
}

/** Columns a phase transition may replace; omitted keys keep their value, `null` clears. */
export const ThreadForkLedgerPatch = Schema.Struct({
  checkout: Schema.optional(Schema.NullOr(ThreadForkCheckoutRecord)),
  provider: Schema.optional(Schema.NullOr(ThreadForkProviderRecord)),
  attachments: Schema.optional(Schema.NullOr(ThreadForkAttachmentsRecord)),
  result: Schema.optional(Schema.NullOr(ThreadForkResult)),
  error: Schema.optional(Schema.NullOr(ThreadForkFailure)),
});
export type ThreadForkLedgerPatch = typeof ThreadForkLedgerPatch.Type;

/**
 * Identifies what a fork key asks for. The key alone is the idempotency handle; reusing it for
 * another source, boundary or destination is refused.
 */
export function threadForkRequestDigest(
  input: Pick<ThreadForkInput, "sourceThreadId" | "sourceMessageId" | "destination">,
): string {
  return sha256Hex(
    canonicalJson({
      sourceThreadId: input.sourceThreadId,
      sourceMessageId: input.sourceMessageId,
      destination: input.destination,
    }),
  );
}

/** Every id a fork key determines. Retries and restarts recompute the same values. */
export interface ThreadForkIdentity {
  /** First 32 hex characters of sha-256(forkKey). */
  readonly keyHash: string;
  readonly forkThreadId: ThreadId;
  readonly worktreeId: WorktreeId;
  /** Project id of a `new-chat` fork's chat. */
  readonly chatProjectId: ProjectId;
  readonly runtimeSessionId: RuntimeSessionId;
  /** Command id of one step, e.g. `commandId("publish")`. */
  readonly commandId: (step: string) => CommandId;
  /** `<prefix>/fork-<8 hex>`; the prefix is the project's worktree branch prefix. */
  readonly branch: (worktreeBranchPrefix: string) => string;
}

export function threadForkIdentity(forkKey: ThreadForkKey | string): ThreadForkIdentity {
  const keyHash = sha256Hex(forkKey).slice(0, 32);
  return {
    keyHash,
    forkThreadId: ThreadId.make(`fork-${keyHash}`),
    worktreeId: WorktreeId.make(`worktree-fork-${keyHash}`),
    chatProjectId: ProjectId.make(`chat-fork-${keyHash}`),
    runtimeSessionId: RuntimeSessionId.make(`fork-${keyHash}`),
    commandId: (step) => CommandId.make(`thread-fork:${keyHash}:${step}`),
    branch: (worktreeBranchPrefix) => {
      const prefix = worktreeBranchPrefix.trim().replace(/\/+$/, "");
      return `${prefix.length > 0 ? `${prefix}/` : ""}fork-${keyHash.slice(0, 8)}`;
    },
  };
}
