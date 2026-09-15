import { Effect, Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  MessageId,
  ProviderItemId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  BackgroundTaskStopIdentity,
  ChatAttachment,
  ModelSelection,
  ProjectCustomSystemPrompt,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  CONTEXT_HANDOFF_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
  AgentTokenMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";
import { ComposerSourceControlContext } from "./sourceControl.ts";

export const PROVIDER_SEND_TURN_MAX_SOURCE_CONTROL_CONTEXTS = 10;

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /** Runtime epoch. Optional only while decoding sessions produced before context handoffs. */
  runtimeSessionId: Schema.optional(RuntimeSessionId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  tokenMode: Schema.optionalKey(AgentTokenMode),
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionResumePolicy = Schema.Literals(["compatible", "fresh"]);
export type ProviderSessionResumePolicy = typeof ProviderSessionResumePolicy.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  /** Reserved by orchestration for new sessions; optional for historical callers during rollout. */
  runtimeSessionId: Schema.optional(RuntimeSessionId),
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  resumePolicy: ProviderSessionResumePolicy.pipe(
    Schema.withDecodingDefault(Effect.succeed("compatible" as const)),
  ),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
  tokenMode: Schema.optionalKey(AgentTokenMode),
  customSystemPrompt: Schema.optional(ProjectCustomSystemPrompt),
});
type DecodedProviderSessionStartInput = typeof ProviderSessionStartInput.Type;
/**
 * Callers may omit the compatibility default. Schema decoding always materializes
 * `resumePolicy` before the runtime uses the input.
 */
export type ProviderSessionStartInput = Omit<DecodedProviderSessionStartInput, "resumePolicy"> & {
  readonly resumePolicy?: DecodedProviderSessionStartInput["resumePolicy"];
};

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(CONTEXT_HANDOFF_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  sourceControlContexts: Schema.optional(
    Schema.Array(ComposerSourceControlContext).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_SOURCE_CONTROL_CONTEXTS),
    ),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  tokenMode: Schema.optionalKey(AgentTokenMode),
  customSystemPrompt: Schema.optional(ProjectCustomSystemPrompt),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderSteerTurnInput = Schema.Struct({
  threadId: ThreadId,
  expectedTurnId: TurnId,
  messageId: MessageId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
});
export type ProviderSteerTurnInput = typeof ProviderSteerTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderTurnSteerResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type ProviderTurnSteerResult = typeof ProviderTurnSteerResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderStopBackgroundTaskInput = Schema.Struct({
  expected: Schema.optional(BackgroundTaskStopIdentity),
  threadId: ThreadId,
  /** Provider-runtime task id (task.* linkage fields). */
  taskId: TrimmedNonEmptyString,
});
export type ProviderStopBackgroundTaskInput = typeof ProviderStopBackgroundTaskInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  expectedRuntimeSessionId: Schema.optional(RuntimeSessionId),
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  expectedRuntimeSessionId: Schema.optional(RuntimeSessionId),
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
