import { ComputerTurnIntent } from "./computerBeta.ts";
import { ApprovalResponseIdentity } from "./approvalResponses.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { ProviderOptionSelections } from "./model.ts";
import { RepositoryIdentity } from "./environment.ts";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  ContextHandoffId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  ThreadPriorityBatchId,
  ThreadPriorityConfidence,
  ThreadPriorityFingerprint,
  ThreadPriorityReason,
  ThreadPriorityTier,
} from "./threadPriorityVocabulary.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ComposerSourceControlContext } from "./sourceControl.ts";
import { WorkItemProviderKind, WorkItemState } from "./workItems.ts";
import { ThreadGoal, ThreadGoalEventOrigin, ThreadGoalUpdate } from "./threadGoal.ts";
import { ThreadForkedActivityPayload } from "./threadFork.ts";
import { SidebarAutoSettleAfterDays } from "./threadAutoSettlement.ts";
import {
  IssueState,
  PullRequestState,
  StatusBucket,
  Worktree,
  WorktreeCheckoutRemovalReason,
  WorktreeId,
  WorktreeOrigin,
  WorktreePullRequestLink,
  WorktreePullRequestLinkSource,
} from "./worktree.ts";

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getWorkflowScript: "orchestration.getWorkflowScript",
  getTaskOutput: "orchestration.getTaskOutput",
  stopBackgroundTask: "orchestration.stopBackgroundTask",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  searchThreadMessages: "orchestration.searchThreadMessages",
  getThreadWindow: "orchestration.getThreadWindow",
  getThreadShells: "orchestration.getThreadShells",
  getThreadHistoryPage: "orchestration.getThreadHistoryPage",
  getActivityPayload: "orchestration.getActivityPayload",
  setThreadHistoryRecovery: "orchestration.setThreadHistoryRecovery",
  replayEvents: "orchestration.replayEvents",
  replayEventsPage: "orchestration.replayEventsPage",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  subscribeThreadWindow: "orchestration.subscribeThreadWindow",
} as const;

export const CONTEXT_HANDOFF_WS_METHODS = {
  getInspectionSummary: "contextHandoff.getInspectionSummary",
  listInspectionEntries: "contextHandoff.listInspectionEntries",
  readRawPayloadChunk: "contextHandoff.readRawPayloadChunk",
  readExportChunk: "contextHandoff.readExportChunk",
} as const;

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

/**
 * `ModelSelection` — selection of a model on a configured provider instance.
 *
 * The routing key is `instanceId` (a user-defined slug identifying one
 * configured provider instance). Drivers, credentials, working-directory
 * bindings, and any other per-instance state are recovered from the
 * runtime registry via the instance id.
 *
 * Wire legacy: persisted selections produced before the driver/instance
 * split carried a `provider: <driver-id>` field instead. The schema absorbs
 * that shape via a pre-decoding transform — `{provider, model}` is promoted
 * to `{instanceId: defaultInstanceIdForDriver(provider), model}`. No
 * post-decode compatibility code lives in the runtime; the transform is the
 * only compat surface.
 */
const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

// Source shape for persisted legacy payloads. Fields are typed as
// `Schema.Unknown` so malformed drafts still make it into the transform and
// fail validation through the target schema (with proper error messages)
// rather than at the source-struct layer where the error is less actionable.
const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformEffect({
      decode: (raw) => {
        // Resolve the routing key: prefer an explicit `instanceId`; fall
        // back to promoting the legacy `provider` slug (the canonical
        // `defaultInstanceIdForDriver` mapping) so persisted rollout-era
        // payloads decode without data loss. The target schema brands the
        // string as `ProviderInstanceId`.
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          model: value.model,
          instanceId: value.instanceId,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

export const CONTEXT_HANDOFF_ACTIVITY_KIND = "context-handoff";
export const CONTEXT_HANDOFF_CONTEXT_VERSION = 1;
export const CONTEXT_HANDOFF_SCHEMA_VERSION = 1;
export const CONTEXT_HANDOFF_ERROR_MAX_CHARS = 2_000;
export const CONTEXT_HANDOFF_INSPECTION_PAGE_MAX_ITEMS = 20;
export const CONTEXT_HANDOFF_INSPECTION_MAX_RESPONSE_BYTES = 128 * 1_024;
export const CONTEXT_HANDOFF_INSPECTION_CHUNK_MAX_BYTES = 96 * 1_024;

export const ContextHandoffMode = Schema.Literal("full-context-fresh-session");
export type ContextHandoffMode = typeof ContextHandoffMode.Type;

/**
 * Why a thread handed its context to a fresh session:
 * - `model-change`: the user switched to another provider instance.
 * - `cwd-relocation`: the thread's working directory moved (for example, a chat became a project)
 *   and the provider cannot resume its conversation there.
 * - `fork`: a forked thread's first turn delivers the inherited conversation, because no
 *   provider-native copy could stop at the fork's boundary.
 */
export const ContextHandoffReason = Schema.Literals(["model-change", "cwd-relocation", "fork"]);
export type ContextHandoffReason = typeof ContextHandoffReason.Type;

export const ContextHandoffEndpointSnapshot = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  providerDisplayName: Schema.optional(TrimmedNonEmptyString),
  providerAccentColor: Schema.optional(TrimmedNonEmptyString),
  modelSlug: TrimmedNonEmptyString,
  modelDisplayName: Schema.optional(TrimmedNonEmptyString),
});
export type ContextHandoffEndpointSnapshot = typeof ContextHandoffEndpointSnapshot.Type;

const ContextHandoffSources = Schema.Array(ContextHandoffEndpointSnapshot).check(
  Schema.isMinLength(1),
);
export const ContextHandoffDigest = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export type ContextHandoffDigest = typeof ContextHandoffDigest.Type;
const ContextHandoffFailure = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CONTEXT_HANDOFF_ERROR_MAX_CHARS),
);

export const ContextHandoffInspectionSummaryMetadata = Schema.Struct({
  completeEntryCount: NonNegativeInt,
  includedEntryCount: Schema.optional(NonNegativeInt),
  truncated: Schema.optional(Schema.Boolean),
  completeDigest: ContextHandoffDigest,
  providerInputDigest: Schema.optional(ContextHandoffDigest),
  preparedAt: Schema.optional(IsoDateTime),
  acceptedAt: Schema.optional(IsoDateTime),
});
export type ContextHandoffInspectionSummaryMetadata =
  typeof ContextHandoffInspectionSummaryMetadata.Type;

const ContextHandoffActivityBaseFields = {
  // Decode historical records without enabling recall or persisting rendered text.
  projectMemory: Schema.optional(Schema.Unknown),
  schemaVersion: Schema.Literal(CONTEXT_HANDOFF_SCHEMA_VERSION),
  handoffId: ContextHandoffId,
  mode: ContextHandoffMode,
  /** Absent on records written before reasons existed: those are model changes. */
  reason: Schema.optional(ContextHandoffReason),
  targetMessageId: MessageId,
  targetTurnId: Schema.optional(TurnId),
  sourceSelection: ModelSelection,
  targetSelection: ModelSelection,
  sourceRuntimeSessionId: Schema.optional(RuntimeSessionId),
  targetRuntimeSessionId: Schema.optional(RuntimeSessionId),
} as const;

const ContextHandoffPresentationFields = {
  sources: ContextHandoffSources,
  target: ContextHandoffEndpointSnapshot,
} as const;

const ContextHandoffContextFields = {
  contextVersion: Schema.Literal(CONTEXT_HANDOFF_CONTEXT_VERSION),
  contextDigest: ContextHandoffDigest,
} as const;

export const ContextHandoffActivityPayload = Schema.Union([
  Schema.Struct({
    ...ContextHandoffActivityBaseFields,
    status: Schema.Literal("requested"),
  }),
  Schema.Struct({
    ...ContextHandoffActivityBaseFields,
    status: Schema.Literal("preparing"),
  }),
  Schema.Struct({
    ...ContextHandoffActivityBaseFields,
    ...ContextHandoffPresentationFields,
    ...ContextHandoffContextFields,
    status: Schema.Literal("dispatching"),
  }),
  Schema.Struct({
    ...ContextHandoffActivityBaseFields,
    ...ContextHandoffPresentationFields,
    ...ContextHandoffContextFields,
    status: Schema.Literal("consumed"),
    inspection: Schema.optional(ContextHandoffInspectionSummaryMetadata),
  }),
  Schema.Struct({
    ...ContextHandoffActivityBaseFields,
    ...ContextHandoffPresentationFields,
    contextVersion: Schema.optional(Schema.Literal(CONTEXT_HANDOFF_CONTEXT_VERSION)),
    contextDigest: Schema.optional(ContextHandoffDigest),
    status: Schema.Literal("failed"),
    error: ContextHandoffFailure,
    inspection: Schema.optional(ContextHandoffInspectionSummaryMetadata),
  }),
  Schema.Struct({
    ...ContextHandoffActivityBaseFields,
    ...ContextHandoffPresentationFields,
    ...ContextHandoffContextFields,
    status: Schema.Literal("delivery-uncertain"),
    error: ContextHandoffFailure,
    inspection: Schema.optional(ContextHandoffInspectionSummaryMetadata),
  }),
]);
export type ContextHandoffActivityPayload = typeof ContextHandoffActivityPayload.Type;

/**
 * Lifecycle activity journaling one checkpoint revert. Its id is
 * `checkpoint-revert:<revertRequestId>`; every phase replaces the same row.
 */
export const CHECKPOINT_REVERT_ACTIVITY_KIND = "checkpoint.revert";
export const CheckpointRevertStatus = Schema.Literals([
  // pending
  "requested",
  "rolling-back",
  "restoring-files",
  // terminal
  "completed",
  "files-not-restored",
  "failed",
  "interrupted",
]);
export type CheckpointRevertStatus = typeof CheckpointRevertStatus.Type;
export const CheckpointRevertFailureReason = Schema.Literals([
  "thread-busy",
  "target-unavailable",
  "handoff-boundary",
  "not-git",
  "shared-checkout",
  "provider-unsupported",
  "provider-failed",
  "files-failed",
  "restart",
  // Ryco itself failed (journal write, storage, defect), not the provider or files.
  "internal-error",
]);
export type CheckpointRevertFailureReason = typeof CheckpointRevertFailureReason.Type;
export const CheckpointRevertActivityPayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  // Not "requestId": that payload key is special-cased for approval routing.
  revertRequestId: CommandId,
  /** Target checkpoint K. */
  turnCount: NonNegativeInt,
  fromTurnCount: Schema.optional(NonNegativeInt),
  status: CheckpointRevertStatus,
  reason: Schema.optional(CheckpointRevertFailureReason),
  detail: Schema.optional(TrimmedNonEmptyString),
  /** Restore cwd, recorded from "rolling-back" on so startup recovery can finish. */
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type CheckpointRevertActivityPayload = typeof CheckpointRevertActivityPayload.Type;

export const ContextHandoffInspectionScope = Schema.Literals(["sent", "complete"]);
export type ContextHandoffInspectionScope = typeof ContextHandoffInspectionScope.Type;

export const ContextHandoffInspectionSection = Schema.Literals([
  "messages",
  "plans",
  "tools",
  "checkpoints",
  "notices",
  "subagents",
  "priorHandoffs",
  "triggeringMessage",
]);
export type ContextHandoffInspectionSection = typeof ContextHandoffInspectionSection.Type;

export const ContextHandoffExportFormat = Schema.Literals(["markdown", "json"]);
export type ContextHandoffExportFormat = typeof ContextHandoffExportFormat.Type;

export const ContextHandoffInspectionUnavailableReason = Schema.Literals([
  "not-prepared",
  "exact-payload-unavailable",
  "invalid-artifact",
]);
export type ContextHandoffInspectionUnavailableReason =
  typeof ContextHandoffInspectionUnavailableReason.Type;

export const ContextHandoffInspectionSectionSummary = Schema.Struct({
  section: ContextHandoffInspectionSection,
  entryCount: NonNegativeInt,
});
export type ContextHandoffInspectionSectionSummary =
  typeof ContextHandoffInspectionSectionSummary.Type;

export const ContextHandoffInspectionScopeSummary = Schema.Struct({
  scope: ContextHandoffInspectionScope,
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(ContextHandoffInspectionUnavailableReason),
  entryCount: NonNegativeInt,
  byteCount: NonNegativeInt,
  digest: Schema.NullOr(ContextHandoffDigest),
  truncated: Schema.NullOr(Schema.Boolean),
  sections: Schema.Array(ContextHandoffInspectionSectionSummary),
});
export type ContextHandoffInspectionScopeSummary = typeof ContextHandoffInspectionScopeSummary.Type;

export const ContextHandoffInspectionDeliveryLabel = Schema.Literals([
  "sent",
  "prepared-not-sent",
  "prepared-not-accepted",
  "delivery-uncertain",
]);
export type ContextHandoffInspectionDeliveryLabel =
  typeof ContextHandoffInspectionDeliveryLabel.Type;

export const ContextHandoffInspectionSummaryInput = Schema.Struct({
  threadId: ThreadId,
  handoffId: ContextHandoffId,
});
export type ContextHandoffInspectionSummaryInput = typeof ContextHandoffInspectionSummaryInput.Type;

export const CONTEXT_HANDOFF_MAX_INPUT_CHARS = 1_400_000;

export const ModelContextWindowMetadata = Schema.Array(
  Schema.Struct({
    slug: Schema.String,
    aliases: Schema.optional(Schema.Array(Schema.String)),
    defaultContextWindow: Schema.optional(Schema.String),
    contextWindowTokens: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
    fixedContextWindowTokens: Schema.optional(Schema.Number),
  }),
);

export const ContextHandoffInputBudget = Schema.Struct({
  maxInputChars: PositiveInt,
  budgetSource: Schema.Literals(["default", "manifest", "slug"]),
  contextWindowTokens: Schema.NullOr(PositiveInt),
});
export type ContextHandoffInputBudget = typeof ContextHandoffInputBudget.Type;

export const ContextHandoffAppliedBudget = Schema.Struct({
  maxInputChars: Schema.optional(Schema.NullOr(PositiveInt)),
  budgetSource: Schema.optional(Schema.NullOr(ContextHandoffInputBudget.fields.budgetSource)),
  contextWindowTokens: Schema.optional(Schema.NullOr(PositiveInt)),
});

export const ContextHandoffInspectionSummary = Schema.Struct({
  ...ContextHandoffAppliedBudget.fields,
  threadId: ThreadId,
  handoffId: ContextHandoffId,
  status: Schema.Literals([
    "requested",
    "preparing",
    "dispatching",
    "consumed",
    "failed",
    "delivery-uncertain",
  ]),
  deliveryLabel: ContextHandoffInspectionDeliveryLabel,
  sources: ContextHandoffSources,
  target: ContextHandoffEndpointSnapshot,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  preparedAt: Schema.NullOr(IsoDateTime),
  acceptedAt: Schema.NullOr(IsoDateTime),
  sent: ContextHandoffInspectionScopeSummary,
  complete: ContextHandoffInspectionScopeSummary,
});
export type ContextHandoffInspectionSummary = typeof ContextHandoffInspectionSummary.Type;

export const ContextHandoffInspectionEntriesInput = Schema.Struct({
  threadId: ThreadId,
  handoffId: ContextHandoffId,
  scope: ContextHandoffInspectionScope,
  section: ContextHandoffInspectionSection,
  cursor: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)))),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(CONTEXT_HANDOFF_INSPECTION_PAGE_MAX_ITEMS)),
  ),
});
export type ContextHandoffInspectionEntriesInput = typeof ContextHandoffInspectionEntriesInput.Type;

export const ContextHandoffInspectionEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: Schema.Unknown,
});
export type ContextHandoffInspectionEntry = typeof ContextHandoffInspectionEntry.Type;

export const ContextHandoffInspectionEntriesPage = Schema.Struct({
  scope: ContextHandoffInspectionScope,
  section: ContextHandoffInspectionSection,
  artifactDigest: ContextHandoffDigest,
  entries: Schema.Array(ContextHandoffInspectionEntry),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type ContextHandoffInspectionEntriesPage = typeof ContextHandoffInspectionEntriesPage.Type;

export const ContextHandoffRawPayloadChunkInput = Schema.Struct({
  threadId: ThreadId,
  handoffId: ContextHandoffId,
  scope: ContextHandoffInspectionScope,
  offset: NonNegativeInt,
});
export type ContextHandoffRawPayloadChunkInput = typeof ContextHandoffRawPayloadChunkInput.Type;

export const ContextHandoffRawPayloadChunk = Schema.Struct({
  scope: ContextHandoffInspectionScope,
  offset: NonNegativeInt,
  chunk: Schema.String,
  nextOffset: Schema.NullOr(NonNegativeInt),
  totalBytes: NonNegativeInt,
  digest: ContextHandoffDigest,
});
export type ContextHandoffRawPayloadChunk = typeof ContextHandoffRawPayloadChunk.Type;

export const ContextHandoffExportChunkInput = Schema.Struct({
  threadId: ThreadId,
  handoffId: ContextHandoffId,
  scope: ContextHandoffInspectionScope,
  format: ContextHandoffExportFormat,
  offset: NonNegativeInt,
});
export type ContextHandoffExportChunkInput = typeof ContextHandoffExportChunkInput.Type;

export const ContextHandoffExportChunk = Schema.Struct({
  scope: ContextHandoffInspectionScope,
  format: ContextHandoffExportFormat,
  offset: NonNegativeInt,
  chunk: Schema.String,
  nextOffset: Schema.NullOr(NonNegativeInt),
  totalBytes: NonNegativeInt,
  digest: ContextHandoffDigest,
  filename: TrimmedNonEmptyString.check(
    Schema.isMaxLength(180),
    Schema.isPattern(/^ryco-context-handoff-[a-zA-Z0-9_-]+-(sent|complete)\.(md|json)$/),
  ),
});
export type ContextHandoffExportChunk = typeof ContextHandoffExportChunk.Type;

export class ContextHandoffInspectionError extends Schema.TaggedError<ContextHandoffInspectionError>()(
  "ContextHandoffInspectionError",
  {
    reason: Schema.Literals([
      "not-found",
      "scope-unavailable",
      "invalid-cursor",
      "invalid-offset",
      "invalid-artifact",
      "response-too-large",
      "internal",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

export const ContextHandoffReference = Schema.Struct({
  handoffId: ContextHandoffId,
  activityId: EventId,
  targetMessageId: MessageId,
});
export type ContextHandoffReference = typeof ContextHandoffReference.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan", "ask"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const AgentTokenMode = Schema.Literals(["off", "balanced", "aggressive"]);
export type AgentTokenMode = typeof AgentTokenMode.Type;
export const DEFAULT_AGENT_TOKEN_MODE: AgentTokenMode = "off";
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
export const PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS = 70_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
const FILE_ATTACHMENT_UPLOAD_TOKEN_MAX_CHARS = 256;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

export const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatAttachmentName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^[^/\\\p{Cc}]+$/u),
);
export const ChatAttachmentMimeType = TrimmedNonEmptyString.check(
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
);
const UnknownChatAttachmentType = Schema.String.check(
  Schema.makeFilter((type) =>
    type === "image" || type === "file" ? "reserved chat attachment type" : true,
  ),
);

/**
 * Marks a stored attachment as an artifact handed over from another thread: a
 * delegating parent's artifact copied into its delegated child, or a child's
 * returned artifact copied back. Names the thread and message it was copied
 * from; provenance only, never authority to read that thread.
 */
export const ChatAttachmentHandoff = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type ChatAttachmentHandoff = typeof ChatAttachmentHandoff.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: ChatAttachmentName,
  mimeType: ChatAttachmentMimeType.check(Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  width: Schema.optional(NonNegativeInt),
  height: Schema.optional(NonNegativeInt),
  handoff: Schema.optional(ChatAttachmentHandoff),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: ChatAttachmentName,
  mimeType: ChatAttachmentMimeType.check(Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

/**
 * Marks a `text/html` file attachment as an agent HTML render: a page the agent
 * published with `ryco_html_render` for clients to show inline in the thread.
 * Deliberately loose (any finite numbers, no length caps) so a newer server's
 * metadata can never fail an older client's decode; `@ryco/shared/htmlRender`
 * `readHtmlRenderMetadata` clamps it before use.
 */
export const ChatHtmlRenderMetadata = Schema.Struct({
  title: Schema.String,
  /** The agent's frame height in CSS pixels, and the cap on any measured height. */
  height: Schema.Finite,
  /** `[width, contentHeight]` pairs measured at publish; absent when not measured. */
  heights: Schema.optional(Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite]))),
  /** Small `data:image/...` screenshots of the page's top per appearance; absent when not captured. */
  thumbnails: Schema.optional(
    Schema.Struct({ dark: Schema.optional(Schema.String), light: Schema.optional(Schema.String) }),
  ),
});
export type ChatHtmlRenderMetadata = typeof ChatHtmlRenderMetadata.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: ChatAttachmentName,
  mimeType: ChatAttachmentMimeType,
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  width: Schema.optional(NonNegativeInt),
  height: Schema.optional(NonNegativeInt),
  htmlRender: Schema.optional(ChatHtmlRenderMetadata),
  handoff: Schema.optional(ChatAttachmentHandoff),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

export const CHAT_ATTACHMENT_READ_CHUNK_BYTES = 256 * 1024;
export const ChatAttachmentReadChunkInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  attachmentId: ChatAttachmentId,
  offset: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
});
export type ChatAttachmentReadChunkInput = typeof ChatAttachmentReadChunkInput.Type;
export const ChatAttachmentReadChunkResult = Schema.Struct({
  dataBase64: Schema.String.check(
    Schema.isMaxLength(4 * Math.ceil(CHAT_ATTACHMENT_READ_CHUNK_BYTES / 3)),
  ),
  offset: NonNegativeInt,
  totalBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
});
export type ChatAttachmentReadChunkResult = typeof ChatAttachmentReadChunkResult.Type;
export class ChatAttachmentReadError extends Schema.TaggedError<ChatAttachmentReadError>()(
  "ChatAttachmentReadError",
  {
    message: Schema.String,
  },
) {}

export const FileAttachmentUploadToken = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FILE_ATTACHMENT_UPLOAD_TOKEN_MAX_CHARS),
);
export type FileAttachmentUploadToken = typeof FileAttachmentUploadToken.Type;

const UploadChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  name: ChatAttachmentName,
  mimeType: ChatAttachmentMimeType,
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  dataUrl: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS)),
  ),
  uploadToken: Schema.optionalKey(FileAttachmentUploadToken),
}).check(
  Schema.makeFilter((attachment) => {
    const hasDataUrl = attachment.dataUrl !== undefined;
    const hasUploadToken = attachment.uploadToken !== undefined;
    return hasDataUrl !== hasUploadToken
      ? true
      : {
          path: ["dataUrl"],
          issue: hasDataUrl
            ? "provide either dataUrl or uploadToken, not both"
            : "provide exactly one of dataUrl or uploadToken",
        };
  }),
);
export type UploadChatFileAttachment = typeof UploadChatFileAttachment.Type;

export const FileAttachmentCreateUploadUrlInput = Schema.Struct({
  threadId: ThreadId,
  name: ChatAttachmentName,
  mimeType: ChatAttachmentMimeType,
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
});
export type FileAttachmentCreateUploadUrlInput = typeof FileAttachmentCreateUploadUrlInput.Type;

export const FileAttachmentCreateUploadUrlResult = Schema.Struct({
  uploadToken: FileAttachmentUploadToken,
  expiresAt: IsoDateTime,
  maxUploadBytes: NonNegativeInt,
});
export type FileAttachmentCreateUploadUrlResult = typeof FileAttachmentCreateUploadUrlResult.Type;

export const ChatUnknownAttachment = Schema.Struct({
  type: UnknownChatAttachmentType,
  id: Schema.optional(ChatAttachmentId),
  name: Schema.optional(ChatAttachmentName),
  mimeType: Schema.optional(Schema.String),
  sizeBytes: Schema.optional(NonNegativeInt),
});
export type ChatUnknownAttachment = typeof ChatUnknownAttachment.Type;

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatUnknownAttachment,
]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([
  UploadChatImageAttachment,
  UploadChatFileAttachment,
  ChatUnknownAttachment,
]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;
const ChatAttachments = Schema.Array(ChatAttachment).check(
  Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
);
const UploadChatAttachments = Schema.Array(UploadChatAttachment).check(
  Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
);

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
});
export type ProjectScript = typeof ProjectScript.Type;

export const PROJECT_CUSTOM_SYSTEM_PROMPT_MAX_CHARS = 20_000;
export const ProjectCustomSystemPrompt = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_CUSTOM_SYSTEM_PROMPT_MAX_CHARS),
);
export type ProjectCustomSystemPrompt = typeof ProjectCustomSystemPrompt.Type;

export const DEFAULT_PROJECT_METADATA_DIR = ".ryco";
export const ProjectMetadataDir = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?![\\/])(?!~)(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/),
);
export type ProjectMetadataDir = typeof ProjectMetadataDir.Type;

/**
 * `chat` backs a "No project" chat: one project record per chat, rooted in a Ryco-managed
 * plain folder under the chats root. Promotion turns it into a regular `project`, never back.
 * Read it through `@ryco/shared/projectKind`, which treats an absent kind as `project`.
 */
export const ProjectKind = Schema.Literals(["project", "chat"]);
export type ProjectKind = typeof ProjectKind.Type;
export const DEFAULT_PROJECT_KIND: ProjectKind = "project";
/** Absent on snapshots, events and nodes that predate chats; those only had regular projects. */
export const OptionalProjectKind = Schema.optional(ProjectKind).pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_KIND)),
);

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  kind: OptionalProjectKind,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  projectMetadataDir: Schema.optional(ProjectMetadataDir).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_METADATA_DIR)),
  ),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  customSystemPrompt: Schema.optional(Schema.NullOr(ProjectCustomSystemPrompt)),
  scripts: Schema.Array(ProjectScript),
  customAvatarContentHash: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null as string | null)),
  ),
  preferredRemoteName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null as string | null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const TurnDispatchMode = Schema.Literals(["queue", "steer"]);
export type TurnDispatchMode = typeof TurnDispatchMode.Type;

/**
 * Why a steer was not applied. `deferred`: the message stays queued and is sent as the next turn
 * (the turn ended, or the provider could not take it right now). `failed`: a real provider error.
 * Absent on older events, which read as `failed`.
 */
export const TurnSteerRejectionReason = Schema.Literals(["deferred", "failed"]);
export type TurnSteerRejectionReason = typeof TurnSteerRejectionReason.Type;

/**
 * Set on a `failed` steer rejection the provider may still have received (a restart cut off its
 * delivery). Clients hold such a message for an explicit retry or removal instead of sending it
 * again as the next turn. An optional flag rather than a third reason, so older clients that
 * decode the event keep working and read it as a plain failure.
 */
export const TurnSteerDeliveryUncertain = Schema.optionalKey(Schema.Boolean);

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  dispatchMode: Schema.optional(TurnDispatchMode),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /** Runtime epoch. Optional only while replaying pre-handoff session events. */
  runtimeSessionId: Schema.optional(RuntimeSessionId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  tokenMode: Schema.optionalKey(AgentTokenMode),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const ThreadSettlementOverride = Schema.Literals(["settled", "active"]);
export type ThreadSettlementOverride = typeof ThreadSettlementOverride.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  /**
   * Present when `payload` is a bounded preview of a larger stored payload: a
   * window or history page served with `activityPayloads: "preview"`. The
   * preview keeps the payload's structure with long strings and arrays cut, and
   * `orchestration.getActivityPayload` returns the stored payload.
   */
  payloadPreview: Schema.optional(
    Schema.Struct({
      /** Encoded size of the stored payload. */
      fullBytes: NonNegativeInt,
    }),
  ),
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

/**
 * Frozen set of states a turn can end in. New outcomes (for example usage limits)
 * go into `reason` or a separate field, never into this literal set.
 */
export const OrchestrationTerminalTurnState = Schema.Literals([
  "completed",
  "error",
  "interrupted",
]);
export type OrchestrationTerminalTurnState = typeof OrchestrationTerminalTurnState.Type;

/** Server-internal: what the caller knows about how the active turn ended. */
export const OrchestrationTurnOutcome = Schema.Struct({
  /** Omitted = "the turn this release ends", whichever it is. */
  turnId: Schema.optional(TurnId),
  state: OrchestrationTerminalTurnState,
  /** Open diagnostic string (see TURN_FINALIZATION_REASON). Never a closed literal set. */
  reason: TrimmedNonEmptyString,
  completedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationTurnOutcome = typeof OrchestrationTurnOutcome.Type;

/** Decided by the server: the turn this session-set releases, and how it ended. */
export const OrchestrationReleasedTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationTerminalTurnState,
  completedAt: IsoDateTime,
  reason: TrimmedNonEmptyString,
});
export type OrchestrationReleasedTurn = typeof OrchestrationReleasedTurn.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  userMessageId: Schema.optional(MessageId),
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const ThreadUsageLimitId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export type ThreadUsageLimitId = typeof ThreadUsageLimitId.Type;

/**
 * A provider usage limit stopped this thread's turn. Durable until a turn starts, the
 * thread is archived or reverted; it only gates the thread while
 * `modelSelection.instanceId === providerInstanceId`.
 */
export const ThreadUsageLimit = Schema.Struct({
  /** "usage-limit:<threadId>:<turnId>" */
  limitId: ThreadUsageLimitId,
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  turnId: TurnId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  limitedAt: IsoDateTime,
  resetAt: Schema.NullOr(IsoDateTime),
  /** null follows ServerSettings.autoResumeLimitedThreads; a boolean is an explicit per-thread override. */
  autoResume: Schema.NullOr(Schema.Boolean),
  updatedAt: IsoDateTime,
});
export type ThreadUsageLimit = typeof ThreadUsageLimit.Type;

/** Accepts the resume turn only while this exact limit is still recorded and idle. */
export const UsageLimitResumeGuard = Schema.Struct({
  limitId: ThreadUsageLimitId,
  origin: Schema.Literals(["auto", "manual"]),
});
export type UsageLimitResumeGuard = typeof UsageLimitResumeGuard.Type;

/**
 * Server-owned provenance of a thread created on behalf of another thread.
 * Absent on root threads. Immutable for a thread incarnation. Never authority.
 * `relationship` is deliberately an open string: a newer server may add kinds
 * without failing older clients' shell decode. Clients must treat values they
 * do not know as "no known relationship". Known values: "delegated", "forked".
 */
export const ThreadLineage = Schema.Struct({
  parentThreadId: ThreadId,
  rootThreadId: ThreadId,
  relationship: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** "forked" only: the parent's message the inherited history ends at (inclusive). */
  sourceMessageId: Schema.optional(MessageId),
  /** "forked" only: the parent's completed turn that message ends. */
  sourceTurnId: Schema.optional(TurnId),
});
export type ThreadLineage = typeof ThreadLineage.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  tokenMode: Schema.optionalKey(AgentTokenMode),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  manualStatusBucket: Schema.optional(Schema.NullOr(StatusBucket)),
  manualPosition: Schema.optional(Schema.Number),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  goal: Schema.optional(Schema.NullOr(ThreadGoal)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Server-owned provenance; absent on root threads and from older servers. */
  lineage: Schema.optional(Schema.NullOr(ThreadLineage)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(ThreadSettlementOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Optional so mixed-version snapshots decode; older clients strip it. */
  usageLimit: Schema.optional(Schema.NullOr(ThreadUsageLimit)),
  /**
   * Hidden from every live view. A trashed thread also carries `trashedAt` and keeps
   * its history and assets; without `trashedAt` the deletion is permanent.
   */
  deletedAt: Schema.NullOr(IsoDateTime),
  trashedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationWorktreeShell = Schema.Struct({
  ...Worktree.fields,
  /** Retired managed path, so persisted drafts can retarget after a cold reconnect. */
  relocatedFromPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type OrchestrationWorktreeShell = typeof OrchestrationWorktreeShell.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  worktrees: Schema.optional(Schema.Array(OrchestrationWorktreeShell)),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  kind: OptionalProjectKind,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  projectMetadataDir: Schema.optional(ProjectMetadataDir).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_METADATA_DIR)),
  ),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  customSystemPrompt: Schema.optional(Schema.NullOr(ProjectCustomSystemPrompt)),
  customAvatarContentHash: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null as string | null)),
  ),
  preferredRemoteName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null as string | null)),
  ),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

/** Environment-local shell projection used by clients to derive Focus without another data plane. */
export const ThreadPriorityProjectedRanking = Schema.Struct({
  tier: ThreadPriorityTier,
  confidence: ThreadPriorityConfidence,
  reason: ThreadPriorityReason,
  inputFingerprint: ThreadPriorityFingerprint,
  batchId: ThreadPriorityBatchId,
  modelSelection: ModelSelection,
  rankedAt: IsoDateTime,
  usableUntil: IsoDateTime,
});
export type ThreadPriorityProjectedRanking = typeof ThreadPriorityProjectedRanking.Type;

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  tokenMode: Schema.optionalKey(AgentTokenMode),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  manualStatusBucket: Schema.optional(Schema.NullOr(StatusBucket)),
  manualPosition: Schema.optional(Schema.Number),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  goal: Schema.optional(Schema.NullOr(ThreadGoal)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(ThreadSettlementOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Optional so mixed-version snapshots decode; older clients strip it. */
  usageLimit: Schema.optional(Schema.NullOr(ThreadUsageLimit)),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  /** Last successful turn that is no longer active; absent on older servers. */
  latestCompletedTurnAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  /**
   * Native background work alive after the turn settles: "working" while
   * subagents/workflows run, "monitoring" when watch loops are the only
   * live work. Optional so old servers/clients interop; absent = none.
   */
  backgroundLiveness: Schema.optional(Schema.NullOr(Schema.Literals(["working", "monitoring"]))),
  /** Server-owned provenance; absent on root threads and from older servers. */
  lineage: Schema.optional(Schema.NullOr(ThreadLineage)),
  priority: Schema.optional(ThreadPriorityProjectedRanking),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

/**
 * An archived thread as a shell snapshot lists it for a client that asked for
 * stubs (`archivedThreads: "stub"`): enough to list, count, link to, search and
 * relate it (lineage), without the fields only an open conversation needs
 * (model selection, session, latest turn, goal, pending flags). A client loads
 * the full shell on demand (`getThreadShells`), and any later `thread-upserted`
 * carries the full shell again. Uses the same leaf schemas as the full shell.
 */
export const OrchestrationArchivedThreadStub = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: IsoDateTime,
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  /** Server-owned provenance; absent on root threads. */
  lineage: Schema.optional(Schema.NullOr(ThreadLineage)),
});
export type OrchestrationArchivedThreadStub = typeof OrchestrationArchivedThreadStub.Type;

/**
 * The node's thread settlement rule, as its shell snapshot carries it so a
 * client that only has the snapshot (a cached or read-only copy) classifies
 * the node's threads by the node's own rule. `autoSettleAfterDays` is the
 * resolved rule: the shared default when the node never set one, null when off.
 */
export const OrchestrationShellSettlementPolicy = Schema.Struct({
  autoSettleAfterDays: SidebarAutoSettleAfterDays,
});
export type OrchestrationShellSettlementPolicy = typeof OrchestrationShellSettlementPolicy.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  worktrees: Schema.optional(Schema.Array(OrchestrationWorktreeShell)),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
  /** Absent from older servers, whose threads follow each client's own rule. */
  settlementPolicy: Schema.optionalKey(OrchestrationShellSettlementPolicy),
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

/**
 * A shell snapshot taken with `archivedThreads: "stub"`: `threads` lists every
 * unarchived thread as a full shell and `archivedThreadStubs` every archived
 * one, so each live thread is in exactly one of the two. It is never a wire
 * shape of its own: the server sends it as pages (`snapshot-threads`, then
 * `snapshot-archived-threads`) and the client reassembles it. A snapshot
 * without the field (an older server, or no opt-in) lists archived threads in
 * `threads` as full shells.
 */
export type OrchestrationStubbedShellSnapshot = OrchestrationShellSnapshot & {
  readonly archivedThreadStubs?: ReadonlyArray<OrchestrationArchivedThreadStub> | undefined;
};

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("worktree-upserted"),
    sequence: NonNegativeInt,
    worktree: OrchestrationWorktreeShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("worktree-relocated"),
    sequence: NonNegativeInt,
    worktree: OrchestrationWorktreeShell,
    sourcePath: TrimmedNonEmptyString,
    destinationPath: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("worktree-removed"),
    sequence: NonNegativeInt,
    worktreeId: WorktreeId,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

/** One thread's current projected ranking, as carried by a `thread-priorities` item. */
export const OrchestrationThreadPriorityEntry = Schema.Struct({
  threadId: ThreadId,
  priority: ThreadPriorityProjectedRanking,
});
export type OrchestrationThreadPriorityEntry = typeof OrchestrationThreadPriorityEntry.Type;

/**
 * A thread-priority ranking replaced the projected rankings. `priorities` lists
 * every thread's current ranking; a thread it does not list has none. It has
 * no event sequence: a ranking is not an orchestration event, so it applies on
 * top of whatever shell the client holds. Only sent to a client that asked for
 * it (`threadPriorities: "delta"`); others receive a full snapshot instead.
 */
export const OrchestrationShellThreadPrioritiesItem = Schema.Struct({
  kind: Schema.Literal("thread-priorities"),
  priorities: Schema.Array(OrchestrationThreadPriorityEntry),
});
export type OrchestrationShellThreadPrioritiesItem =
  typeof OrchestrationShellThreadPrioritiesItem.Type;

/**
 * How a client takes the shell snapshot. `"paged"` asks for it in bounded
 * pieces instead of one message: a `snapshot-begin` header, `snapshot-threads`
 * pages (every unarchived thread before any archived one), and `snapshot-end`.
 * The client applies the assembled snapshot at `snapshot-end`, so no message
 * outgrows a relayed connection however large the shell is. Pages fill one
 * byte budget regardless of archive state; a shell within it is one message.
 */
export const OrchestrationShellSnapshotDelivery = Schema.Literal("paged");
export type OrchestrationShellSnapshotDelivery = typeof OrchestrationShellSnapshotDelivery.Type;

/**
 * Opens a paged shell snapshot. Everything but the threads, plus how many
 * threads the pages will carry: `threadCount` in all, the last
 * `archivedThreadCount` of them archived. With archived stubs, the archived
 * ones are the `snapshot-archived-threads` stubs and the rest the
 * `snapshot-threads` shells.
 */
export const OrchestrationShellSnapshotBeginItem = Schema.Struct({
  kind: Schema.Literal("snapshot-begin"),
  snapshotSequence: NonNegativeInt,
  updatedAt: IsoDateTime,
  projects: Schema.Array(OrchestrationProjectShell),
  worktrees: Schema.optional(Schema.Array(OrchestrationWorktreeShell)),
  threadCount: NonNegativeInt,
  archivedThreadCount: NonNegativeInt,
  settlementPolicy: Schema.optionalKey(OrchestrationShellSettlementPolicy),
});
export type OrchestrationShellSnapshotBeginItem = typeof OrchestrationShellSnapshotBeginItem.Type;

/** One page of a paged shell snapshot's threads, in snapshot order. */
export const OrchestrationShellSnapshotThreadsItem = Schema.Struct({
  kind: Schema.Literal("snapshot-threads"),
  threads: Schema.Array(OrchestrationThreadShell),
});
export type OrchestrationShellSnapshotThreadsItem =
  typeof OrchestrationShellSnapshotThreadsItem.Type;

/**
 * One page of a paged shell snapshot's archived threads as stubs. Only ever
 * sent to a client that asked for `archivedThreads: "stub"`, after every
 * `snapshot-threads` page of the same snapshot.
 */
export const OrchestrationShellSnapshotArchivedThreadsItem = Schema.Struct({
  kind: Schema.Literal("snapshot-archived-threads"),
  threads: Schema.Array(OrchestrationArchivedThreadStub),
});
export type OrchestrationShellSnapshotArchivedThreadsItem =
  typeof OrchestrationShellSnapshotArchivedThreadsItem.Type;

/** Closes a paged shell snapshot; the events after its sequence follow. */
export const OrchestrationShellSnapshotEndItem = Schema.Struct({
  kind: Schema.Literal("snapshot-end"),
});
export type OrchestrationShellSnapshotEndItem = typeof OrchestrationShellSnapshotEndItem.Type;

export const OrchestrationShellSnapshotPageItem = Schema.Union([
  OrchestrationShellSnapshotBeginItem,
  OrchestrationShellSnapshotThreadsItem,
  OrchestrationShellSnapshotArchivedThreadsItem,
  OrchestrationShellSnapshotEndItem,
]);
export type OrchestrationShellSnapshotPageItem = typeof OrchestrationShellSnapshotPageItem.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellThreadPrioritiesItem,
  /** Only ever sent to a client that asked for `snapshotDelivery: "paged"`. */
  OrchestrationShellSnapshotBeginItem,
  OrchestrationShellSnapshotThreadsItem,
  /** Only ever sent to a client that asked for `archivedThreads: "stub"` as well. */
  OrchestrationShellSnapshotArchivedThreadsItem,
  OrchestrationShellSnapshotEndItem,
  /**
   * The server accepted `resumeFromSequence`: instead of a snapshot, the events
   * after `fromSequence` follow, and the client keeps the shell it already has.
   * Only ever sent to a client that asked to resume.
   */
  Schema.Struct({
    kind: Schema.Literal("resumed"),
    fromSequence: NonNegativeInt,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

/**
 * A shell stream item as subscribers see it: a client that takes paged
 * snapshots reassembles the pages into one `snapshot` item before delivery,
 * whose snapshot carries the archived stubs when the server sent any.
 */
export type OrchestrationShellSubscriptionItem =
  | Exclude<
      OrchestrationShellStreamItem,
      OrchestrationShellSnapshotPageItem | { readonly kind: "snapshot" }
    >
  | { readonly kind: "snapshot"; readonly snapshot: OrchestrationStubbedShellSnapshot };

export const OrchestrationSubscribeShellInput = Schema.Struct({
  /**
   * The last shell sequence the client applied. A server that still holds every
   * event since then answers `resumed` and replays only those, sparing a full
   * snapshot on every reconnect; otherwise it sends a snapshot as usual. Older
   * servers ignore the field.
   */
  resumeFromSequence: Schema.optional(NonNegativeInt),
  /**
   * How the client takes a thread-priority ranking: `"delta"` asks for a small
   * `thread-priorities` item instead of a full shell snapshot. Absent, the
   * server sends a snapshot, which every client understands; older servers
   * ignore the field and keep sending snapshots.
   */
  threadPriorities: Schema.optional(Schema.Literal("delta")),
  /**
   * `"paged"` asks for every shell snapshot in bounded pages (see
   * `OrchestrationShellSnapshotDelivery`). Absent, a snapshot is one `snapshot`
   * item, which every client understands; older servers ignore the field and
   * keep sending that.
   */
  snapshotDelivery: Schema.optional(OrchestrationShellSnapshotDelivery),
  /**
   * `"stub"` asks for archived threads as stubs (`OrchestrationArchivedThreadStub`)
   * in `snapshot-archived-threads` pages instead of full shells. Honoured only
   * with `snapshotDelivery: "paged"`; the snapshot still lists every live
   * thread. Live `thread-upserted` items keep carrying full shells. Absent, or
   * from an older server, which ignores the field, archived threads arrive as
   * full shells.
   */
  archivedThreads: Schema.optional(Schema.Literal("stub")),
});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

/**
 * The last orchestration sequence the client applied for this thread. A server
 * that still holds every event since then answers `resumed` and replays only
 * the thread's missed events; otherwise it sends a snapshot. Older servers
 * ignore the field.
 */
const ThreadResumeFromSequence = Schema.optional(NonNegativeInt);

/**
 * Whether the subscription serves a view the user has open (`"active"`) or
 * only keeps the thread warm (`"passive"`: a sidebar prewarm, a retained idle
 * thread). Provider history recovery runs only for active subscriptions; a
 * passive one turns active through `orchestration.setThreadHistoryRecovery`.
 * Absent means active, which is what older clients get.
 */
export const OrchestrationThreadHistoryRecoveryMode = Schema.Literals(["active", "passive"]);
export type OrchestrationThreadHistoryRecoveryMode =
  typeof OrchestrationThreadHistoryRecoveryMode.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  resumeFromSequence: ThreadResumeFromSequence,
  historyRecovery: Schema.optional(OrchestrationThreadHistoryRecoveryMode),
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const OrchestrationThreadHistoryCursor = TrimmedNonEmptyString.pipe(
  Schema.brand("OrchestrationThreadHistoryCursor"),
);
export type OrchestrationThreadHistoryCursor = typeof OrchestrationThreadHistoryCursor.Type;

export const OrchestrationThreadHistoryCollection = Schema.Literals([
  "messages",
  "proposedPlans",
  "activities",
  "checkpoints",
]);
export type OrchestrationThreadHistoryCollection = typeof OrchestrationThreadHistoryCollection.Type;

export const OrchestrationThreadHistoryLimits = Schema.Struct({
  messages: PositiveInt,
  proposedPlans: PositiveInt,
  activities: PositiveInt,
  checkpoints: PositiveInt,
});
export type OrchestrationThreadHistoryLimits = typeof OrchestrationThreadHistoryLimits.Type;

export const OrchestrationThreadHistoryPageInfo = Schema.Struct({
  oldestCursor: Schema.NullOr(OrchestrationThreadHistoryCursor),
  newestCursor: Schema.NullOr(OrchestrationThreadHistoryCursor),
  hasMoreBefore: Schema.Boolean,
});
export type OrchestrationThreadHistoryPageInfo = typeof OrchestrationThreadHistoryPageInfo.Type;

export const OrchestrationThreadHistoryState = Schema.Struct({
  messages: OrchestrationThreadHistoryPageInfo,
  proposedPlans: OrchestrationThreadHistoryPageInfo,
  activities: OrchestrationThreadHistoryPageInfo,
  checkpoints: OrchestrationThreadHistoryPageInfo,
});
export type OrchestrationThreadHistoryState = typeof OrchestrationThreadHistoryState.Type;

/**
 * How a window or history page sends activity payloads. `"preview"` bounds each
 * large payload (see `OrchestrationThreadActivity.payloadPreview`); absent means
 * full payloads, which is all an older client understands. Older servers ignore
 * the field and send full payloads, which a client that asked for previews
 * handles unchanged.
 */
export const OrchestrationActivityPayloadMode = Schema.Literals(["full", "preview"]);
export type OrchestrationActivityPayloadMode = typeof OrchestrationActivityPayloadMode.Type;

export const OrchestrationGetThreadWindowInput = Schema.Struct({
  threadId: ThreadId,
  limits: OrchestrationThreadHistoryLimits,
  activityPayloads: Schema.optional(OrchestrationActivityPayloadMode),
});
export type OrchestrationGetThreadWindowInput = typeof OrchestrationGetThreadWindowInput.Type;

/** How many threads one `getThreadShells` request may name. */
export const ORCHESTRATION_GET_THREAD_SHELLS_MAX_IDS = 100;

/**
 * Full shells of the named threads, for a client holding archived stubs
 * (`archivedThreads: "stub"`) that needs a thread's full shell, such as when
 * it opens an archived conversation.
 */
export const OrchestrationGetThreadShellsInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(
    Schema.isMaxLength(ORCHESTRATION_GET_THREAD_SHELLS_MAX_IDS),
  ),
});
export type OrchestrationGetThreadShellsInput = typeof OrchestrationGetThreadShellsInput.Type;

export const OrchestrationGetThreadShellsResult = Schema.Struct({
  /** The projection sequence the shells were read at. */
  snapshotSequence: NonNegativeInt,
  /** Shells of the named live threads, in request order. A deleted or unknown id is left out. */
  threads: Schema.Array(OrchestrationThreadShell),
  /**
   * Named threads the response's byte budget left out (it stays far below the
   * relay message cap); ask for them again. Empty when every shell fitted.
   */
  remainingThreadIds: Schema.Array(ThreadId),
});
export type OrchestrationGetThreadShellsResult = typeof OrchestrationGetThreadShellsResult.Type;

/**
 * Moves this connection's subscriptions of one thread between serving an open
 * view (`"active"`) and keeping the thread warm (`"passive"`). Turning active
 * runs the history recovery a view's subscription runs when it opens.
 */
export const OrchestrationSetThreadHistoryRecoveryInput = Schema.Struct({
  threadId: ThreadId,
  mode: OrchestrationThreadHistoryRecoveryMode,
});
export type OrchestrationSetThreadHistoryRecoveryInput =
  typeof OrchestrationSetThreadHistoryRecoveryInput.Type;

export const OrchestrationSubscribeThreadWindowInput = Schema.Struct({
  threadId: ThreadId,
  limits: OrchestrationThreadHistoryLimits,
  resumeFromSequence: ThreadResumeFromSequence,
  historyRecovery: Schema.optional(OrchestrationThreadHistoryRecoveryMode),
  activityPayloads: Schema.optional(OrchestrationActivityPayloadMode),
});
export type OrchestrationSubscribeThreadWindowInput =
  typeof OrchestrationSubscribeThreadWindowInput.Type;

export const OrchestrationThreadWindowSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  history: OrchestrationThreadHistoryState,
  /**
   * The directory the thread's next turn runs in (its worktree, else its project root), as the
   * server resolves it when starting a provider session. Absent from older servers and when the
   * thread has no resolvable project.
   */
  workspaceCwd: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationThreadWindowSnapshot = typeof OrchestrationThreadWindowSnapshot.Type;

export const OrchestrationThreadHistoryPageMode = Schema.Struct({
  kind: Schema.Literal("before"),
  cursor: OrchestrationThreadHistoryCursor,
});
export type OrchestrationThreadHistoryPageMode = typeof OrchestrationThreadHistoryPageMode.Type;

/**
 * Narrows a `messages` page to some of the thread's messages; the page's
 * cursors and `hasMoreBefore` then page through those alone. `"artifacts"`:
 * messages that carry artifacts (`@ryco/shared/threadArtifacts`): assistant
 * messages with attachments, and messages with handed-over attachments. What a
 * thread's artifacts list reads. Older servers ignore the field and send every
 * message, which a client that asked for a filter narrows itself.
 */
export const OrchestrationThreadHistoryMessageFilter = Schema.Literals(["artifacts"]);
export type OrchestrationThreadHistoryMessageFilter =
  typeof OrchestrationThreadHistoryMessageFilter.Type;

export const OrchestrationGetThreadHistoryPageInput = Schema.Union([
  Schema.Struct({
    threadId: ThreadId,
    collection: OrchestrationThreadHistoryCollection,
    mode: OrchestrationThreadHistoryPageMode,
    limit: PositiveInt,
    activityPayloads: Schema.optional(OrchestrationActivityPayloadMode),
    /** Only read for the `messages` collection. */
    messageFilter: Schema.optional(OrchestrationThreadHistoryMessageFilter),
  }),
  Schema.Struct({
    threadId: ThreadId,
    collection: Schema.Literal("messages"),
    mode: Schema.Struct({
      kind: Schema.Literal("around"),
      anchorId: MessageId,
    }),
    limit: PositiveInt,
  }),
]);
export type OrchestrationGetThreadHistoryPageInput =
  typeof OrchestrationGetThreadHistoryPageInput.Type;

const OrchestrationThreadMessageHistoryPage = Schema.Struct({
  collection: Schema.Literal("messages"),
  snapshotSequence: NonNegativeInt,
  items: Schema.Array(OrchestrationMessage),
  page: OrchestrationThreadHistoryPageInfo,
});
const OrchestrationThreadProposedPlanHistoryPage = Schema.Struct({
  collection: Schema.Literal("proposedPlans"),
  snapshotSequence: NonNegativeInt,
  items: Schema.Array(OrchestrationProposedPlan),
  page: OrchestrationThreadHistoryPageInfo,
});
const OrchestrationThreadActivityHistoryPage = Schema.Struct({
  collection: Schema.Literal("activities"),
  snapshotSequence: NonNegativeInt,
  items: Schema.Array(OrchestrationThreadActivity),
  page: OrchestrationThreadHistoryPageInfo,
});
const OrchestrationThreadCheckpointHistoryPage = Schema.Struct({
  collection: Schema.Literal("checkpoints"),
  snapshotSequence: NonNegativeInt,
  items: Schema.Array(OrchestrationCheckpointSummary),
  page: OrchestrationThreadHistoryPageInfo,
});

export const OrchestrationThreadHistoryPage = Schema.Union([
  OrchestrationThreadMessageHistoryPage,
  OrchestrationThreadProposedPlanHistoryPage,
  OrchestrationThreadActivityHistoryPage,
  OrchestrationThreadCheckpointHistoryPage,
]);
export type OrchestrationThreadHistoryPage = typeof OrchestrationThreadHistoryPage.Type;

export const OrchestrationGetActivityPayloadInput = Schema.Struct({
  threadId: ThreadId,
  activityId: EventId,
});
export type OrchestrationGetActivityPayloadInput = typeof OrchestrationGetActivityPayloadInput.Type;

export const OrchestrationGetActivityPayloadResult = Schema.Struct({
  activityId: EventId,
  /** The stored payload, or a preview of it when it exceeds what one response carries. */
  payload: Schema.Unknown,
  /** Encoded size of the stored payload. */
  fullBytes: NonNegativeInt,
  /** Whether `payload` is still a preview: the stored payload is larger than a response carries. */
  truncated: Schema.Boolean,
});
export type OrchestrationGetActivityPayloadResult =
  typeof OrchestrationGetActivityPayloadResult.Type;

export class OrchestrationGetActivityPayloadError extends Schema.TaggedError<OrchestrationGetActivityPayloadError>()(
  "OrchestrationGetActivityPayloadError",
  {
    reason: Schema.Literals(["not-found", "unavailable"]),
    threadId: ThreadId,
    activityId: EventId,
  },
) {}

export class OrchestrationThreadHistoryError extends Schema.TaggedError<OrchestrationThreadHistoryError>()(
  "OrchestrationThreadHistoryError",
  {
    reason: Schema.Literals([
      "invalid-cursor",
      "stale-cursor",
      "unsupported-version",
      "thread-not-found",
    ]),
    threadId: ThreadId,
    collection: Schema.optional(OrchestrationThreadHistoryCollection),
  },
) {}

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  /** Absent creates a regular project. */
  kind: Schema.optional(ProjectKind),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  projectMetadataDir: Schema.optional(ProjectMetadataDir).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_METADATA_DIR)),
  ),
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  /** @deprecated Accepted for old clients; project model defaults are ignored. */
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  customSystemPrompt: Schema.optional(Schema.NullOr(ProjectCustomSystemPrompt)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  /** Optional compare-and-set guard used by governed mutation flows. */
  expectedUpdatedAt: Schema.optional(IsoDateTime),
  /** Only `chat` -> `project` (promotion) is accepted; the same kind is a no-op. */
  kind: Schema.optional(ProjectKind),
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  projectMetadataDir: Schema.optional(ProjectMetadataDir),
  /** @deprecated Accepted for old clients; project model defaults are ignored. */
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  customSystemPrompt: Schema.optional(Schema.NullOr(ProjectCustomSystemPrompt)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  preferredRemoteName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const ProjectAvatarSetCommand = Schema.Struct({
  type: Schema.Literal("project.avatar.set"),
  commandId: CommandId,
  projectId: ProjectId,
  contentHash: Schema.NullOr(TrimmedNonEmptyString),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
  /** Optional compare-and-set guards used by governed mutation flows. */
  expectedUpdatedAt: Schema.optional(IsoDateTime),
  expectedThreadIds: Schema.optional(Schema.Array(ThreadId)),
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  tokenMode: Schema.optionalKey(AgentTokenMode),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

/** Server-originated only (Agent Control). Never part of ClientOrchestrationCommand. */
const ThreadDelegatedCreateCommand = Schema.Struct({
  ...ThreadCreateCommand.fields,
  type: Schema.Literal("thread.delegated.create"),
  parentThreadId: ThreadId,
});
export type ThreadDelegatedCreateCommand = typeof ThreadDelegatedCreateCommand.Type;

/** Permanent deletion. Only a trashed (or never-used) thread can be deleted. */
const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

/** Recoverable removal: hidden everywhere, history and assets preserved. */
const ThreadTrashCommand = Schema.Struct({
  type: Schema.Literal("thread.trash"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUntrashCommand = Schema.Struct({
  type: Schema.Literal("thread.untrash"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

// Receipts are short-lived and owned by the server; clients cannot supply restoration state.
const ThreadSidebarUndoCommand = Schema.Struct({
  type: Schema.Literal("thread.sidebar.undo"),
  commandId: CommandId,
  threadId: ThreadId,
  undoCommandId: CommandId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
});
const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
});

/** Per-thread auto-resume override for the thread's current usage limit. */
const ThreadUsageLimitConfigureCommand = Schema.Struct({
  type: Schema.Literal("thread.usage-limit.configure"),
  commandId: CommandId,
  threadId: ThreadId,
  limitId: ThreadUsageLimitId,
  autoResume: Schema.NullOr(Schema.Boolean),
  createdAt: IsoDateTime,
});

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: Schema.Literal("user"),
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadTokenModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.token-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  tokenMode: AgentTokenMode,
  createdAt: IsoDateTime,
});

const ThreadGoalSetCommand = Schema.Struct({
  type: Schema.Literal("thread.goal.set"),
  startTurn: Schema.optional(Schema.Boolean),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadGoalUpdate.fields,
  createdAt: IsoDateTime,
});

const ThreadGoalClearCommand = Schema.Struct({
  type: Schema.Literal("thread.goal.clear"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  tokenMode: Schema.optionalKey(AgentTokenMode),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  fetchOrigin: Schema.optional(Schema.Boolean),
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
});

/** Bounds a chat's title seed and the title it is given on promotion. */
export const CHAT_PROJECT_TITLE_MAX_CHARS = 200;

/**
 * Shown when work (a turn, provider session, terminal or file write) is refused because the chat's
 * folder is moving into a project. The move settles in moments, so retrying shortly succeeds.
 */
export const PROJECT_RELOCATION_PENDING_MESSAGE =
  "This chat is being moved into a project. Try again in a moment.";

/**
 * First send of a "No project" chat. The server, not the client, allocates the chat folder
 * under its chats root, creates a `chat` project with `projectId` there, and then continues
 * with `createThread` for that project. Mutually exclusive with `prepareWorktree` and
 * `requireWorktree`: a chat folder is a plain directory, never a Git worktree.
 */
const ThreadTurnStartBootstrapCreateChatProject = Schema.Struct({
  projectId: ProjectId,
  /** Seeds the chat title and its folder name; the folder name never changes afterwards. */
  titleSeed: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_PROJECT_TITLE_MAX_CHARS)),
});

const ThreadTurnStartBootstrap = Schema.Struct({
  /** Reject a turn unless this bootstrap creates a fresh isolated Git worktree. */
  requireWorktree: Schema.optional(Schema.Boolean),
  createChatProject: Schema.optional(ThreadTurnStartBootstrapCreateChatProject),
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((bootstrap) => {
    if (bootstrap.createChatProject === undefined) return undefined;
    if (bootstrap.prepareWorktree !== undefined || bootstrap.requireWorktree === true)
      return "A chat without a project cannot also prepare a Git worktree";
    if (bootstrap.createThread?.projectId !== bootstrap.createChatProject.projectId)
      return "A chat without a project must create its first thread in that chat";
    return undefined;
  }),
);

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

/**
 * Delegated-result wake fence. Legacy fields (`turnMessageId`, `turnId`, `runtimeSessionId`,
 * `providerInstanceId`) are decoded for stored events and ledger commands and ignored.
 */
export const DelegationReturnGuard = Schema.Struct({
  latestUserMessageId: Schema.NullOr(MessageId),
  projectId: ProjectId,
  runtimeMode: RuntimeMode,
  worktreePath: Schema.NullOr(Schema.String),
  turnMessageId: Schema.optional(MessageId),
  turnId: Schema.optional(TurnId),
  runtimeSessionId: Schema.optional(RuntimeSessionId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export const ClaudeResumeGuard = Schema.Struct({
  requireReady: Schema.Boolean,
  /**
   * The runtime the review saw. Null when the session had none (it was stopped): the send is
   * then accepted only while still no runtime is bound, so the review stays current until the
   * next turn starts one.
   */
  runtimeSessionId: Schema.NullOr(RuntimeSessionId),
  latestTurnId: Schema.NullOr(TurnId),
  modelSelection: ModelSelection,
});
export type ClaudeResumeGuard = typeof ClaudeResumeGuard.Type;

/**
 * Server-only optimistic fence for an automatic continuation after a restart. Never part
 * of `ClientThreadTurnStartCommand`: client decode strips it, so it cannot be forged.
 */
export const RestartContinuationGuard = Schema.Struct({
  sourceTurnId: TurnId,
  expectedLatestTurnState: Schema.Literals(["interrupted", "completed"]),
  latestUserMessageId: Schema.NullOr(MessageId),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  worktreePath: Schema.NullOr(Schema.String),
  providerInstanceId: ProviderInstanceId,
});
export type RestartContinuationGuard = typeof RestartContinuationGuard.Type;

/** How many other threads one user message may mention for its agent to read. */
export const MAX_THREAD_REFERENCES_PER_MESSAGE = 4;

/**
 * Threads a user message mentions (`@thread:<id>` chips). The server appends a
 * bounded excerpt of each to the provider input, never to the stored message.
 * Only the composer sets it: Agent Control and other server-built turns never
 * do, so a mention cannot widen what an agent may read.
 */
export const ThreadReferences = Schema.Array(ThreadId).check(
  Schema.isMaxLength(MAX_THREAD_REFERENCES_PER_MESSAGE),
);
export type ThreadReferences = typeof ThreadReferences.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  claudeResumeGuard: Schema.optional(ClaudeResumeGuard),
  restartContinuationGuard: Schema.optional(RestartContinuationGuard),
  computerUse: Schema.optionalKey(ComputerTurnIntent),
  // Reject retired recall requests instead of silently stripping their context.
  projectMemory: Schema.optional(Schema.Never),
  type: Schema.Literal("thread.turn.start"),
  delegationReturnGuard: Schema.optional(DelegationReturnGuard),
  usageLimitResumeGuard: Schema.optional(UsageLimitResumeGuard),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: ChatAttachments,
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  tokenMode: Schema.optionalKey(AgentTokenMode),
  goal: Schema.optional(ThreadGoalUpdate),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  sourceControlContexts: Schema.optional(Schema.Array(ComposerSourceControlContext)),
  threadReferences: Schema.optional(ThreadReferences),
  createdAt: IsoDateTime,
});
/** A turn start as dispatched: its attachments are already stored. */
export type ThreadTurnStartCommand = typeof ThreadTurnStartCommand.Type;

export const ClientThreadTurnStartCommand = Schema.Struct({
  claudeResumeGuard: Schema.optional(ClaudeResumeGuard),
  computerUse: Schema.optionalKey(ComputerTurnIntent),
  // Reject retired recall requests instead of silently stripping their context.
  projectMemory: Schema.optional(Schema.Never),
  type: Schema.Literal("thread.turn.start"),
  delegationReturnGuard: Schema.optional(DelegationReturnGuard),
  usageLimitResumeGuard: Schema.optional(UsageLimitResumeGuard),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: UploadChatAttachments,
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  tokenMode: Schema.optionalKey(AgentTokenMode),
  goal: Schema.optional(ThreadGoalUpdate),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  sourceControlContexts: Schema.optional(Schema.Array(ComposerSourceControlContext)),
  threadReferences: Schema.optional(ThreadReferences),
  createdAt: IsoDateTime,
});

export const ThreadTurnSteerCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.steer"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedTurnId: TurnId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: ChatAttachments,
  }),
  threadReferences: Schema.optional(ThreadReferences),
  createdAt: IsoDateTime,
  requestedAt: IsoDateTime,
});
export type ThreadTurnSteerCommand = typeof ThreadTurnSteerCommand.Type;

const ClientThreadTurnSteerCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.steer"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedTurnId: TurnId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: UploadChatAttachments,
  }),
  threadReferences: Schema.optional(ThreadReferences),
  createdAt: IsoDateTime,
  requestedAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  approvalIdentity: Schema.optional(ApprovalResponseIdentity),
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
  userInputIdentity: Schema.optional(ApprovalResponseIdentity),
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const WorktreeCreateCommand = Schema.Struct({
  type: Schema.Literal("worktree.create"),
  commandId: CommandId,
  worktreeId: WorktreeId,
  projectId: ProjectId,
  branch: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  origin: WorktreeOrigin,
  prNumber: Schema.NullOr(Schema.Number),
  issueNumber: Schema.NullOr(Schema.Number),
  prTitle: Schema.NullOr(TrimmedNonEmptyString),
  issueTitle: Schema.NullOr(TrimmedNonEmptyString),
  workItemProvider: Schema.optional(Schema.NullOr(WorkItemProviderKind)),
  workItemKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workItemTitle: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workItemState: Schema.optional(Schema.NullOr(WorkItemState)),
  workItemStateName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workItemUrl: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: IsoDateTime,
});

export const WorktreeLifecycleGuard = Schema.Struct({
  mainWorkspaceId: Schema.NullOr(WorktreeId),
  projectId: ProjectId,
  projectUpdatedAt: IsoDateTime,
  workspaceRoot: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: TrimmedNonEmptyString,
  sessions: Schema.Array(Schema.Struct({ threadId: ThreadId, updatedAt: IsoDateTime })),
});

const WorktreeArchiveCommand = Schema.Struct({
  type: Schema.Literal("worktree.archive"),
  commandId: CommandId,
  worktreeId: WorktreeId,
  lifecycleGuard: Schema.optional(WorktreeLifecycleGuard),
  archivedAt: IsoDateTime,
  deletedBranch: Schema.Boolean,
});

const WorktreeMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("worktree.meta.update"),
  commandId: CommandId,
  worktreeId: WorktreeId,
  title: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  branch: Schema.optional(TrimmedNonEmptyString),
  changedAt: IsoDateTime,
});

/** Link (or refresh) and dismiss pull requests on a workspace; server-issued only. */
const WorktreePullRequestLinkUpsert = Schema.Struct({
  number: Schema.Number,
  title: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.NullOr(PullRequestState),
  isDraft: Schema.NullOr(Schema.Boolean),
  /** Omitted: derived (kept while the state holds, else the event time). */
  terminalAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  headRefName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  baseRefName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  source: WorktreePullRequestLinkSource,
  /** Linked by hand: brings a dismissed link back (nothing else does). */
  restore: Schema.optional(Schema.Boolean),
});
export type WorktreePullRequestLinkUpsert = typeof WorktreePullRequestLinkUpsert.Type;

const WorktreePullRequestsUpdateCommand = Schema.Struct({
  type: Schema.Literal("worktree.pull-requests.update"),
  commandId: CommandId,
  worktreeId: WorktreeId,
  upserts: Schema.optional(Schema.Array(WorktreePullRequestLinkUpsert)),
  dismissals: Schema.optional(Schema.Array(Schema.Number)),
  /** The linked issue's refreshed state; omitted keeps the stored one. */
  issueState: Schema.optional(Schema.NullOr(IssueState)),
  updatedAt: IsoDateTime,
});

const WorktreeSourceControlStateUpdateCommand = Schema.Struct({
  type: Schema.Literal("worktree.source-control-state.update"),
  commandId: CommandId,
  worktreeId: WorktreeId,
  prNumber: Schema.optional(Schema.NullOr(Schema.Number)),
  prTitle: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  prState: Schema.NullOr(PullRequestState),
  prIsDraft: Schema.NullOr(Schema.Boolean),
  /** When the PR reached its current merged/closed state; see `Worktree.prTerminalAt`. */
  prTerminalAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  issueState: Schema.NullOr(IssueState),
  updatedAt: IsoDateTime,
});

const WorktreeRestoreCommand = Schema.Struct({
  type: Schema.Literal("worktree.restore"),
  commandId: CommandId,
  worktreeId: WorktreeId,
  lifecycleGuard: Schema.optional(WorktreeLifecycleGuard),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  restoredAt: IsoDateTime,
});

/**
 * Drops a workspace record. Never touches conversations: the decider refuses while
 * any conversation (active, archived or trashed) still references the record.
 * `sessions` is decoded for stored commands only; "delete" is always refused.
 */
const WorktreeDeleteCommand = Schema.Struct({
  sessions: Schema.optional(Schema.Literals(["preserve", "delete"])),
  type: Schema.Literal("worktree.delete"),
  commandId: CommandId,
  worktreeId: WorktreeId,
  lifecycleGuard: Schema.optional(WorktreeLifecycleGuard),
  deletedAt: IsoDateTime,
  deletedBranch: Schema.Boolean,
});

/**
 * Server-only (workspace lifecycle service): records that the physical checkout is
 * gone. Archives the record when it is still active; the path and branch stay.
 */
const WorktreeCheckoutRemoveCommand = Schema.Struct({
  type: Schema.Literal("worktree.checkout.remove"),
  commandId: CommandId,
  worktreeId: WorktreeId,
  reason: WorktreeCheckoutRemovalReason,
  lifecycleGuard: Schema.optional(WorktreeLifecycleGuard),
  removedAt: IsoDateTime,
});

/** Server-only: the checkout was recreated at its recorded path. */
const WorktreeCheckoutRestoreCommand = Schema.Struct({
  type: Schema.Literal("worktree.checkout.restore"),
  commandId: CommandId,
  worktreeId: WorktreeId,
  worktreePath: TrimmedNonEmptyString,
  restoredAt: IsoDateTime,
});

/** Server-only: a verified managed checkout moved under workspace lifecycle admission. */
const WorktreeRelocateCommand = Schema.Struct({
  type: Schema.Literal("worktree.relocate"),
  commandId: CommandId,
  worktreeId: WorktreeId,
  projectId: ProjectId,
  sourcePath: TrimmedNonEmptyString,
  destinationPath: TrimmedNonEmptyString,
  expectedUpdatedAt: IsoDateTime,
  relocatedAt: IsoDateTime,
});

const ThreadAttachToWorktreeCommand = Schema.Struct({
  type: Schema.Literal("thread.attach-to-worktree"),
  commandId: CommandId,
  threadId: ThreadId,
  worktreeId: WorktreeId,
  attachedAt: IsoDateTime,
});

const ThreadStatusBucketOverrideCommand = Schema.Struct({
  type: Schema.Literal("thread.status-bucket.override"),
  commandId: CommandId,
  threadId: ThreadId,
  bucket: Schema.NullOr(StatusBucket),
  changedAt: IsoDateTime,
});

const ThreadManualPositionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.manual-position.set"),
  commandId: CommandId,
  threadId: ThreadId,
  position: Schema.Number,
  changedAt: IsoDateTime,
});

const WorktreeManualPositionSetCommand = Schema.Struct({
  type: Schema.Literal("worktree.manual-position.set"),
  commandId: CommandId,
  worktreeId: WorktreeId,
  position: Schema.Number,
  changedAt: IsoDateTime,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectAvatarSetCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadTrashCommand,
  ThreadUntrashCommand,
  ThreadArchiveCommand,
  ThreadSidebarUndoCommand,
  ThreadUnarchiveCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadUsageLimitConfigureCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTokenModeSetCommand,
  ThreadGoalSetCommand,
  ThreadGoalClearCommand,
  ThreadTurnStartCommand,
  ThreadTurnSteerCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
  WorktreeCreateCommand,
  WorktreeArchiveCommand,
  WorktreeMetaUpdateCommand,
  WorktreeSourceControlStateUpdateCommand,
  WorktreeRestoreCommand,
  WorktreeDeleteCommand,
  ThreadAttachToWorktreeCommand,
  ThreadStatusBucketOverrideCommand,
  ThreadManualPositionSetCommand,
  WorktreeManualPositionSetCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectAvatarSetCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadTrashCommand,
  ThreadUntrashCommand,
  ThreadArchiveCommand,
  ThreadSidebarUndoCommand,
  ThreadUnarchiveCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadUsageLimitConfigureCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTokenModeSetCommand,
  ThreadGoalSetCommand,
  ThreadGoalClearCommand,
  ClientThreadTurnStartCommand,
  ClientThreadTurnSteerCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
  WorktreeCreateCommand,
  WorktreeArchiveCommand,
  WorktreeMetaUpdateCommand,
  WorktreeSourceControlStateUpdateCommand,
  WorktreeRestoreCommand,
  WorktreeDeleteCommand,
  ThreadAttachToWorktreeCommand,
  ThreadStatusBucketOverrideCommand,
  ThreadManualPositionSetCommand,
  WorktreeManualPositionSetCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

/**
 * The runtime a provider-originated session update comes from. The update applies only while
 * the thread's session is still bound to exactly this provider instance and runtime (null: none),
 * so a late lifecycle event of a replaced runtime can never overwrite its successor, whatever
 * order the two writes reach the engine in.
 */
export const ThreadSessionSetExpectedRuntime = Schema.Struct({
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  runtimeSessionId: Schema.NullOr(RuntimeSessionId),
});
export type ThreadSessionSetExpectedRuntime = typeof ThreadSessionSetExpectedRuntime.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  /** Server-internal precondition; absent for server-decided transitions (bind, stop, restart). */
  expectedRuntime: Schema.optional(ThreadSessionSetExpectedRuntime),
  /** Internal hint: how the turn this session-set releases ended, when the caller knows. */
  turnOutcome: Schema.optional(OrchestrationTurnOutcome),
  /**
   * Internal: whether an `error` session wakes a snoozed thread (absent: it does). False for
   * a release the server decides on its own (startup reconciliation, a context handoff
   * rollback), which is not new thread activity.
   */
  wakesSnoozed: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadTurnSteerResolveCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread.turn.steer.resolve"),
    commandId: CommandId,
    requestCommandId: CommandId,
    threadId: ThreadId,
    expectedTurnId: TurnId,
    message: Schema.Struct({
      messageId: MessageId,
      role: Schema.Literal("user"),
      text: Schema.String,
      attachments: Schema.Array(ChatAttachment),
    }),
    createdAt: IsoDateTime,
    requestedAt: IsoDateTime,
    resolution: Schema.Struct({
      status: Schema.Literal("accepted"),
      turnId: TurnId,
      resolvedAt: IsoDateTime,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.turn.steer.resolve"),
    commandId: CommandId,
    requestCommandId: CommandId,
    threadId: ThreadId,
    expectedTurnId: TurnId,
    message: Schema.Struct({
      messageId: MessageId,
      role: Schema.Literal("user"),
      text: Schema.String,
      attachments: Schema.Array(ChatAttachment),
    }),
    createdAt: IsoDateTime,
    requestedAt: IsoDateTime,
    resolution: Schema.Struct({
      status: Schema.Literal("rejected"),
      error: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
      reason: Schema.optionalKey(TurnSteerRejectionReason),
      deliveryUncertain: TurnSteerDeliveryUncertain,
      resolvedAt: IsoDateTime,
    }),
  }),
]);

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  droppedTurnIds: Schema.optional(Schema.Array(TurnId)),
  latestTurn: Schema.optional(Schema.NullOr(OrchestrationLatestTurn)),
  createdAt: IsoDateTime,
});

const ThreadGoalSyncCommand = Schema.Struct({
  type: Schema.Literal("thread.goal.sync"),
  commandId: CommandId,
  threadId: ThreadId,
  goal: ThreadGoal,
  expectedRequestId: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

/** Internal only: clients must never be able to forge a usage limit. */
const ThreadUsageLimitRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.usage-limit.record"),
  commandId: CommandId,
  threadId: ThreadId,
  limitId: ThreadUsageLimitId,
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  turnId: TurnId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  resetAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});

const ThreadGoalProviderClearCommand = Schema.Struct({
  type: Schema.Literal("thread.goal.provider-clear"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedRequestId: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

/**
 * Server-originated only (`threads.fork`). Publishes a fork atomically: optional new worktree
 * record, the thread with "forked" lineage, its inherited history (fresh ids, original order and
 * timestamps), the `thread.forked` provenance activity, and the worktree attachment.
 */
const ThreadForkCreateCommand = Schema.Struct({
  ...ThreadCreateCommand.fields,
  type: Schema.Literal("thread.fork.create"),
  sourceThreadId: ThreadId,
  sourceMessageId: MessageId,
  sourceTurnId: TurnId,
  /** Worktree the fork attaches to (the source's, or `newWorktree`); null for none. */
  worktreeId: Schema.NullOr(WorktreeId),
  /** Recorded in the same commit when the fork created this checkout. */
  newWorktree: Schema.NullOr(
    Schema.Struct({
      worktreeId: WorktreeId,
      branch: TrimmedNonEmptyString,
      worktreePath: TrimmedNonEmptyString,
    }),
  ),
  messages: Schema.Array(OrchestrationMessage).check(Schema.isMaxLength(2000)),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).check(Schema.isMaxLength(200)),
  activities: Schema.Array(OrchestrationThreadActivity).check(Schema.isMaxLength(2000)),
  forked: ThreadForkedActivityPayload,
});
export type ThreadForkCreateCommand = typeof ThreadForkCreateCommand.Type;

const InternalOrchestrationCommand = Schema.Union([
  ThreadDelegatedCreateCommand,
  ThreadForkCreateCommand,
  Schema.Struct({
    ...ThreadCreateCommand.fields,
    type: Schema.Literal("thread.history.import"),
    source: Schema.Literals(["codex", "claudeAgent"]),
    archived: Schema.Boolean,
    messages: Schema.Array(OrchestrationMessage).check(Schema.isMaxLength(2000)),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.history.restore"),
    commandId: CommandId,
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    runtimeSessionId: RuntimeSessionId,
    expectedUpdatedAt: IsoDateTime,
    messages: Schema.Array(OrchestrationMessage),
    activities: Schema.Array(OrchestrationThreadActivity),
    completedTurnIds: Schema.Array(TurnId),
    failedTurnIds: Schema.Array(TurnId),
    createdAt: IsoDateTime,
  }),
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadTurnSteerResolveCommand,
  ThreadRevertCompleteCommand,
  ThreadGoalSyncCommand,
  ThreadGoalProviderClearCommand,
  ThreadUsageLimitRecordCommand,
  WorktreeCheckoutRemoveCommand,
  WorktreeCheckoutRestoreCommand,
  WorktreePullRequestsUpdateCommand,
  WorktreeRelocateCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.avatar-set",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.trashed",
  "thread.untrashed",
  "thread.archived",
  "thread.unarchived",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.settled",
  "thread.unsettled",
  "thread.usage-limit-set",
  "thread.usage-limit-cleared",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.token-mode-set",
  "thread.goal-updated",
  "thread.goal-cleared",
  "thread.context-handoff-requested",
  "thread.message-sent",
  "thread.turn-steer-requested",
  "thread.turn-steer-accepted",
  "thread.turn-steer-rejected",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "worktree.created",
  "worktree.archived",
  "worktree.metaUpdated",
  "worktree.sourceControlStateUpdated",
  "worktree.restored",
  "worktree.deleted",
  "worktree.checkoutRemoved",
  "worktree.checkoutRestored",
  "worktree.relocated",
  "thread.attachedToWorktree",
  "thread.statusBucketOverridden",
  "thread.manualPositionSet",
  "worktree.manualPositionSet",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread", "worktree"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  kind: OptionalProjectKind,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  projectMetadataDir: Schema.optional(ProjectMetadataDir).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_METADATA_DIR)),
  ),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  customSystemPrompt: Schema.optional(Schema.NullOr(ProjectCustomSystemPrompt)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  /** Present only when the kind changed, which is always `chat` -> `project`. */
  kind: Schema.optional(ProjectKind),
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  projectMetadataDir: Schema.optional(ProjectMetadataDir),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  customSystemPrompt: Schema.optional(Schema.NullOr(ProjectCustomSystemPrompt)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  preferredRemoteName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});

export const ProjectAvatarSetPayload = Schema.Struct({
  projectId: ProjectId,
  contentHash: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  tokenMode: Schema.optionalKey(AgentTokenMode),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lineage: Schema.optional(ThreadLineage),
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadTrashedPayload = Schema.Struct({
  threadId: ThreadId,
  trashedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUntrashedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadSidebarRestoreState = Schema.Struct({
  settledOverride: Schema.NullOr(ThreadSettlementOverride),
  settledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
  restoredSidebarState: Schema.optional(ThreadSidebarRestoreState),
});

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
  restoredSidebarState: Schema.optional(ThreadSidebarRestoreState),
});

export const ThreadUsageLimitSetPayload = Schema.Struct({
  threadId: ThreadId,
  usageLimit: ThreadUsageLimit,
});

export const ThreadUsageLimitClearedPayload = Schema.Struct({
  threadId: ThreadId,
  limitId: ThreadUsageLimitId,
  reason: Schema.Literals(["turn-started", "archived", "reverted"]),
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadTokenModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  tokenMode: Schema.optionalKey(AgentTokenMode),
  updatedAt: IsoDateTime,
});

export const ThreadGoalUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  goal: ThreadGoal,
  origin: ThreadGoalEventOrigin,
});

export const ThreadGoalClearedPayload = Schema.Struct({
  threadId: ThreadId,
  origin: ThreadGoalEventOrigin,
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  dispatchMode: Schema.optional(TurnDispatchMode),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnSteerRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  expectedTurnId: TurnId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  threadReferences: Schema.optional(ThreadReferences),
  createdAt: IsoDateTime,
  requestedAt: IsoDateTime,
});
export type ThreadTurnSteerRequestedPayload = typeof ThreadTurnSteerRequestedPayload.Type;

export const ThreadTurnSteerAcceptedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  expectedTurnId: TurnId,
  turnId: TurnId,
  resolvedAt: IsoDateTime,
});
export type ThreadTurnSteerAcceptedPayload = typeof ThreadTurnSteerAcceptedPayload.Type;

export const ThreadTurnSteerRejectedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  expectedTurnId: TurnId,
  error: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  reason: Schema.optionalKey(TurnSteerRejectionReason),
  deliveryUncertain: TurnSteerDeliveryUncertain,
  resolvedAt: IsoDateTime,
});
export type ThreadTurnSteerRejectedPayload = typeof ThreadTurnSteerRejectedPayload.Type;

export const ThreadContextHandoffRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  handoffId: ContextHandoffId,
  activityId: EventId,
  mode: ContextHandoffMode,
  targetMessageId: MessageId,
  sourceSelection: ModelSelection,
  targetSelection: ModelSelection,
  sourceRuntimeSessionId: Schema.optional(RuntimeSessionId),
  createdAt: IsoDateTime,
});
export type ThreadContextHandoffRequestedPayload = typeof ThreadContextHandoffRequestedPayload.Type;

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  delegationReturnGuard: Schema.optional(DelegationReturnGuard),
  computerUse: Schema.optionalKey(ComputerTurnIntent),
  // Decode historical records without enabling recall or persisting rendered text.
  projectMemory: Schema.optional(Schema.Unknown),
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  tokenMode: AgentTokenMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_TOKEN_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  contextHandoff: Schema.optional(ContextHandoffReference),
  threadReferences: Schema.optional(ThreadReferences),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  approvalIdentity: Schema.optional(ApprovalResponseIdentity),
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
  userInputIdentity: Schema.optional(ApprovalResponseIdentity),
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  /**
   * Authoritative revert result read from the projection. Absent on legacy
   * events, which keep the count-based projection.
   */
  droppedTurnIds: Schema.optional(Schema.Array(TurnId)),
  latestTurn: Schema.optional(Schema.NullOr(OrchestrationLatestTurn)),
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
  /** Decided by the server: the turn this session-set releases and its terminal state. */
  releasedTurn: Schema.optional(OrchestrationReleasedTurn),
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const WorktreeCreatedPayload = Schema.Struct({
  worktreeId: WorktreeId,
  projectId: ProjectId,
  branch: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  origin: WorktreeOrigin,
  prNumber: Schema.NullOr(Schema.Number),
  issueNumber: Schema.NullOr(Schema.Number),
  prTitle: Schema.NullOr(TrimmedNonEmptyString),
  issueTitle: Schema.NullOr(TrimmedNonEmptyString),
  workItemProvider: Schema.optional(Schema.NullOr(WorkItemProviderKind)),
  workItemKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workItemTitle: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workItemState: Schema.optional(Schema.NullOr(WorkItemState)),
  workItemStateName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workItemUrl: Schema.optional(Schema.NullOr(Schema.String)),
  /** The workspace's pull request links; absent from older servers (derive from `prNumber`). */
  pullRequests: Schema.optional(Schema.Array(WorktreePullRequestLink)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const WorktreeArchivedPayload = Schema.Struct({
  worktreeId: WorktreeId,
  archivedAt: IsoDateTime,
  deletedBranch: Schema.Boolean,
});

export const WorktreeMetaUpdatedPayload = Schema.Struct({
  worktreeId: WorktreeId,
  title: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  branch: Schema.optional(TrimmedNonEmptyString),
  changedAt: IsoDateTime,
});

export const WorktreeSourceControlStateUpdatedPayload = Schema.Struct({
  worktreeId: WorktreeId,
  prNumber: Schema.optional(Schema.NullOr(Schema.Number)),
  prTitle: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  prState: Schema.NullOr(PullRequestState),
  prIsDraft: Schema.NullOr(Schema.Boolean),
  /** When the PR reached its current merged/closed state; see `Worktree.prTerminalAt`. */
  prTerminalAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  issueState: Schema.NullOr(IssueState),
  /**
   * The workspace's links after this update. When present, the `pr*` fields
   * above describe the current link. Absent from older servers' events.
   */
  pullRequests: Schema.optional(Schema.Array(WorktreePullRequestLink)),
  updatedAt: IsoDateTime,
});
export type WorktreeSourceControlStateUpdatedPayload =
  typeof WorktreeSourceControlStateUpdatedPayload.Type;

export const WorktreeRestoredPayload = Schema.Struct({
  worktreeId: WorktreeId,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  restoredAt: IsoDateTime,
});

export const WorktreeDeletedPayload = Schema.Struct({
  worktreeId: WorktreeId,
  deletedAt: IsoDateTime,
  deletedBranch: Schema.Boolean,
});

export const WorktreeCheckoutRemovedPayload = Schema.Struct({
  worktreeId: WorktreeId,
  reason: WorktreeCheckoutRemovalReason,
  removedAt: IsoDateTime,
});

export const WorktreeCheckoutRestoredPayload = Schema.Struct({
  worktreeId: WorktreeId,
  worktreePath: TrimmedNonEmptyString,
  restoredAt: IsoDateTime,
});

export const WorktreeRelocatedPayload = Schema.Struct({
  worktreeId: WorktreeId,
  projectId: ProjectId,
  sourcePath: TrimmedNonEmptyString,
  destinationPath: TrimmedNonEmptyString,
  relocatedAt: IsoDateTime,
});

export const ThreadAttachedToWorktreePayload = Schema.Struct({
  threadId: ThreadId,
  worktreeId: WorktreeId,
  attachedAt: IsoDateTime,
});

export const ThreadStatusBucketOverriddenPayload = Schema.Struct({
  threadId: ThreadId,
  bucket: Schema.NullOr(StatusBucket),
  changedAt: IsoDateTime,
});

export const ThreadManualPositionSetPayload = Schema.Struct({
  threadId: ThreadId,
  position: Schema.Number,
  changedAt: IsoDateTime,
});

export const WorktreeManualPositionSetPayload = Schema.Struct({
  worktreeId: WorktreeId,
  position: Schema.Number,
  changedAt: IsoDateTime,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, WorktreeId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.avatar-set"),
    payload: ProjectAvatarSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.trashed"),
    payload: ThreadTrashedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.untrashed"),
    payload: ThreadUntrashedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.usage-limit-set"),
    payload: ThreadUsageLimitSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.usage-limit-cleared"),
    payload: ThreadUsageLimitClearedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.token-mode-set"),
    payload: ThreadTokenModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.goal-updated"),
    payload: ThreadGoalUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.goal-cleared"),
    payload: ThreadGoalClearedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.context-handoff-requested"),
    payload: ThreadContextHandoffRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-steer-requested"),
    payload: ThreadTurnSteerRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-steer-accepted"),
    payload: ThreadTurnSteerAcceptedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-steer-rejected"),
    payload: ThreadTurnSteerRejectedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("worktree.created"),
    payload: WorktreeCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("worktree.archived"),
    payload: WorktreeArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("worktree.metaUpdated"),
    payload: WorktreeMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("worktree.sourceControlStateUpdated"),
    payload: WorktreeSourceControlStateUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("worktree.restored"),
    payload: WorktreeRestoredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("worktree.deleted"),
    payload: WorktreeDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("worktree.checkoutRemoved"),
    payload: WorktreeCheckoutRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("worktree.checkoutRestored"),
    payload: WorktreeCheckoutRestoredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("worktree.relocated"),
    payload: WorktreeRelocatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.attachedToWorktree"),
    payload: ThreadAttachedToWorktreePayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.statusBucketOverridden"),
    payload: ThreadStatusBucketOverriddenPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.manualPositionSet"),
    payload: ThreadManualPositionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("worktree.manualPositionSet"),
    payload: WorktreeManualPositionSetPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  /**
   * The server accepted `resumeFromSequence`: no snapshot follows, only the
   * thread's events after `fromSequence`, applied on top of what the client
   * already holds. Only ever sent to a client that asked to resume.
   */
  Schema.Struct({
    kind: Schema.Literal("resumed"),
    fromSequence: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationThreadWindowStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadWindowSnapshot,
  }),
  /**
   * The server accepted `resumeFromSequence`: no snapshot follows, only the
   * thread's events after `fromSequence`, applied on top of what the client
   * already holds. Only ever sent to a client that asked to resume.
   */
  Schema.Struct({
    kind: Schema.Literal("resumed"),
    fromSequence: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadWindowStreamItem = typeof OrchestrationThreadWindowStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(
        { message: "fromTurnCount must be less than or equal to toTurnCount" },
        input.fromTurnCount,
      ),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationSearchThreadMessagesInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  limit: PositiveInt,
});
export type OrchestrationSearchThreadMessagesInput =
  typeof OrchestrationSearchThreadMessagesInput.Type;

export const OrchestrationThreadMessageSearchResult = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  snippet: Schema.String,
  timestamp: IsoDateTime,
  historyCursor: Schema.optional(OrchestrationThreadHistoryCursor),
});
export type OrchestrationThreadMessageSearchResult =
  typeof OrchestrationThreadMessageSearchResult.Type;

export const OrchestrationSearchThreadMessagesResult = Schema.Array(
  OrchestrationThreadMessageSearchResult,
);
export type OrchestrationSearchThreadMessagesResult =
  typeof OrchestrationSearchThreadMessagesResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationReplayEventsPageInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
  limit: PositiveInt,
});
export type OrchestrationReplayEventsPageInput = typeof OrchestrationReplayEventsPageInput.Type;

export const OrchestrationReplayEventsPageResult = Schema.Struct({
  events: Schema.Array(OrchestrationEvent),
  nextSequence: NonNegativeInt,
  hasMore: Schema.Boolean,
});
export type OrchestrationReplayEventsPageResult = typeof OrchestrationReplayEventsPageResult.Type;

export const OrchestrationGetWorkflowScriptInput = Schema.Struct({
  threadId: ThreadId,
  /** Absolute path from the workflow's runHandles.scriptPath. The server
   * re-derives containment; the client value is a hint, never trusted. */
  scriptPath: TrimmedNonEmptyString,
});
export type OrchestrationGetWorkflowScriptInput = typeof OrchestrationGetWorkflowScriptInput.Type;

export const OrchestrationGetWorkflowScriptResult = Schema.Struct({
  scriptPath: TrimmedNonEmptyString,
  contents: Schema.String,
  truncated: Schema.Boolean,
});
export type OrchestrationGetWorkflowScriptResult = typeof OrchestrationGetWorkflowScriptResult.Type;

export const WORKFLOW_SCRIPT_ERROR_MESSAGES = {
  "invalid-path": "Workflow scripts must be absolute .js paths.",
  "root-unavailable": "Script root unavailable.",
  "not-found": "Script not found.",
  "outside-root": "Script path is outside the workflow scripts root.",
  "not-js": "Resolved script is not a .js file.",
  "not-regular-file": "Script is not a regular file.",
  "changed-during-read": "Script changed between resolution and open.",
  "read-failed": "Script read failed.",
} as const;

export class OrchestrationGetWorkflowScriptError extends Schema.TaggedError<OrchestrationGetWorkflowScriptError>()(
  "OrchestrationGetWorkflowScriptError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "not-js",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    /** Always the client-supplied path: failures never echo the server-side
     * resolved path (or a raw cause) — those stay in server logs. */
    scriptPath: Schema.String,
  },
) {
  override get message(): string {
    return WORKFLOW_SCRIPT_ERROR_MESSAGES[this.reason];
  }
}

export const OrchestrationGetTaskOutputInput = Schema.Struct({
  threadId: ThreadId,
  /** Absolute path from the task's outputFile linkage field. The server
   * re-derives containment; the client value is a hint, never trusted. */
  outputPath: TrimmedNonEmptyString,
  /** Byte offset from a previous read's nextOffset to poll appended output;
   * omit to tail (start near the end of large files). */
  offset: Schema.optional(NonNegativeInt),
});
export type OrchestrationGetTaskOutputInput = typeof OrchestrationGetTaskOutputInput.Type;

export const OrchestrationGetTaskOutputResult = Schema.Struct({
  outputPath: TrimmedNonEmptyString,
  chunk: Schema.String,
  /** Byte offset to pass back as `offset` to continue reading appended output. */
  nextOffset: NonNegativeInt,
  /** Total file size in bytes at read time. */
  size: NonNegativeInt,
  /** True when this read skipped earlier bytes (tail mode on a large file). */
  truncatedHead: Schema.Boolean,
});
export type OrchestrationGetTaskOutputResult = typeof OrchestrationGetTaskOutputResult.Type;

export const TASK_OUTPUT_ERROR_MESSAGES = {
  "invalid-path": "Task output must be an absolute path.",
  "root-unavailable": "Task output root unavailable.",
  "not-found": "Task output not found.",
  "outside-root": "Task output path is outside the task output roots.",
  "not-regular-file": "Task output is not a regular file.",
  "changed-during-read": "Task output changed between resolution and open.",
  "read-failed": "Task output read failed.",
} as const;

export class OrchestrationGetTaskOutputError extends Schema.TaggedError<OrchestrationGetTaskOutputError>()(
  "OrchestrationGetTaskOutputError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    /** Always the client-supplied path: failures never echo the server-side
     * resolved path (or a raw cause) — those stay in server logs. */
    outputPath: Schema.String,
  },
) {
  override get message(): string {
    return TASK_OUTPUT_ERROR_MESSAGES[this.reason];
  }
}

/** Identity of the displayed task activation; prevents stale stop actions. */
export const BackgroundTaskStopIdentity = Schema.Struct({
  runtimeSessionId: RuntimeSessionId,
  attempt: NonNegativeInt,
});
export type BackgroundTaskStopIdentity = typeof BackgroundTaskStopIdentity.Type;

export const OrchestrationStopBackgroundTaskInput = Schema.Struct({
  /** Optional for older callers; new background disclosures always supply it. */
  expected: Schema.optional(BackgroundTaskStopIdentity),
  threadId: ThreadId,
  /** Provider-runtime task id from the task.* linkage fields. */
  taskId: TrimmedNonEmptyString,
});
export type OrchestrationStopBackgroundTaskInput = typeof OrchestrationStopBackgroundTaskInput.Type;

export const OrchestrationStopBackgroundTaskResult = Schema.Struct({});
export type OrchestrationStopBackgroundTaskResult =
  typeof OrchestrationStopBackgroundTaskResult.Type;

export const STOP_BACKGROUND_TASK_ERROR_MESSAGES = {
  unsupported: "This provider cannot stop individual background tasks.",
  "session-not-found": "No live provider session for this thread.",
  "stop-failed": "Stopping the background task failed.",
} as const;

export class OrchestrationStopBackgroundTaskError extends Schema.TaggedError<OrchestrationStopBackgroundTaskError>()(
  "OrchestrationStopBackgroundTaskError",
  {
    reason: Schema.Literals(["unsupported", "session-not-found", "stop-failed"]),
    threadId: Schema.String,
    taskId: Schema.String,
  },
) {
  override get message(): string {
    return STOP_BACKGROUND_TASK_ERROR_MESSAGES[this.reason];
  }
}

export const OrchestrationRpcSchemas = {
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getWorkflowScript: {
    input: OrchestrationGetWorkflowScriptInput,
    output: OrchestrationGetWorkflowScriptResult,
  },
  getTaskOutput: {
    input: OrchestrationGetTaskOutputInput,
    output: OrchestrationGetTaskOutputResult,
  },
  stopBackgroundTask: {
    input: OrchestrationStopBackgroundTaskInput,
    output: OrchestrationStopBackgroundTaskResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  searchThreadMessages: {
    input: OrchestrationSearchThreadMessagesInput,
    output: OrchestrationSearchThreadMessagesResult,
  },
  getThreadWindow: {
    input: OrchestrationGetThreadWindowInput,
    output: OrchestrationThreadWindowSnapshot,
  },
  getThreadShells: {
    input: OrchestrationGetThreadShellsInput,
    output: OrchestrationGetThreadShellsResult,
  },
  getThreadHistoryPage: {
    input: OrchestrationGetThreadHistoryPageInput,
    output: OrchestrationThreadHistoryPage,
  },
  getActivityPayload: {
    input: OrchestrationGetActivityPayloadInput,
    output: OrchestrationGetActivityPayloadResult,
  },
  setThreadHistoryRecovery: {
    input: OrchestrationSetThreadHistoryRecoveryInput,
    output: Schema.Struct({}),
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
  replayEventsPage: {
    input: OrchestrationReplayEventsPageInput,
    output: OrchestrationReplayEventsPageResult,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeThreadWindow: {
    input: OrchestrationSubscribeThreadWindowInput,
    output: OrchestrationThreadWindowStreamItem,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: OrchestrationShellStreamItem,
  },
} as const;

export class OrchestrationGetSnapshotError extends Schema.TaggedError<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Machine-readable dispatch failures a client acts on. Absent for every other failure, which a
 * client only shows by `message`.
 *
 * - `chat-project-retired`: a `thread.turn.start` whose `bootstrap.createChatProject` names a
 *   project id this node has already deleted, such as an unused chat removed by startup cleanup.
 *   Nothing was created and the id can never be used again. The client gives the draft a fresh
 *   project id and sends again once.
 */
export const OrchestrationDispatchCommandErrorReason = Schema.Literals(["chat-project-retired"]);
export type OrchestrationDispatchCommandErrorReason =
  typeof OrchestrationDispatchCommandErrorReason.Type;

export class OrchestrationDispatchCommandError extends Schema.TaggedError<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    /** Additive: older clients ignore it and show `message`. */
    reason: Schema.optionalKey(OrchestrationDispatchCommandErrorReason),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedError<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedError<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationReplayEventsError extends Schema.TaggedError<OrchestrationReplayEventsError>()(
  "OrchestrationReplayEventsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class FileAttachmentCreateUploadUrlError extends Schema.TaggedError<FileAttachmentCreateUploadUrlError>()(
  "FileAttachmentCreateUploadUrlError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
