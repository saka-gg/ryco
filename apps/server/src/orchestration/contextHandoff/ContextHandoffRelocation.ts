/**
 * Context handoffs that continue a thread after its working directory moved.
 *
 * A provider that keys native conversations by directory (Claude) cannot resume
 * a conversation after a chat became a project, the workspace root changed, or
 * a worktree was relocated. The server then runs an ordinary
 * `full-context-fresh-session` handoff on the same provider instance: same
 * coordinator, record, document, renderer and timeline divider. Only the
 * requested activity is appended by the server instead of the decider, with ids
 * derived from the turn-start event so a retry or a restart finds the same
 * operation.
 *
 * Pure module: no services, no I/O.
 *
 * @module ContextHandoffRelocation
 */
import {
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  CONTEXT_HANDOFF_SCHEMA_VERSION,
  ContextHandoffId,
  EventId,
  type ContextHandoffActivityPayload,
  type ContextHandoffReference,
  type MessageId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type RuntimeSessionId,
} from "@ryco/contracts";

/** Every working-directory relocation handoff id starts with this prefix. */
export const CWD_RELOCATION_HANDOFF_ID_PREFIX = "context-handoff:cwd-relocation:";

const CWD_RELOCATION_ACTIVITY_ID_PREFIX = "context-handoff-activity:cwd-relocation:";

/** The parts of a `thread.turn-start-requested` event the reference derives from. */
export interface CwdRelocationTurnStart {
  readonly eventId: EventId;
  readonly payload: { readonly messageId: MessageId };
}

/** The handoff reference of one turn start, stable across retries and restarts. */
export function cwdRelocationHandoffReference(
  event: CwdRelocationTurnStart,
): ContextHandoffReference {
  return {
    handoffId: ContextHandoffId.make(`${CWD_RELOCATION_HANDOFF_ID_PREFIX}${event.eventId}`),
    activityId: EventId.make(`${CWD_RELOCATION_ACTIVITY_ID_PREFIX}${event.eventId}`),
    targetMessageId: event.payload.messageId,
  };
}

export function isCwdRelocationHandoffId(handoffId: string): boolean {
  return handoffId.startsWith(CWD_RELOCATION_HANDOFF_ID_PREFIX);
}

/**
 * The `requested` activity the coordinator validates before it creates the
 * operation record. Same shape as the decider's for a model handoff except for
 * its `cwd-relocation` reason, which the coordinator carries into the terminal
 * divider; the target is normally the source selection itself.
 */
export function makeCwdRelocationRequestedActivity(input: {
  readonly reference: ContextHandoffReference;
  readonly sourceSelection: ModelSelection;
  readonly targetSelection: ModelSelection;
  readonly sourceRuntimeSessionId: RuntimeSessionId | undefined;
  readonly createdAt: string;
}): OrchestrationThreadActivity {
  const payload: Extract<ContextHandoffActivityPayload, { readonly status: "requested" }> = {
    schemaVersion: CONTEXT_HANDOFF_SCHEMA_VERSION,
    handoffId: input.reference.handoffId,
    mode: "full-context-fresh-session",
    reason: "cwd-relocation",
    status: "requested",
    targetMessageId: input.reference.targetMessageId,
    sourceSelection: input.sourceSelection,
    targetSelection: input.targetSelection,
    ...(input.sourceRuntimeSessionId !== undefined
      ? { sourceRuntimeSessionId: input.sourceRuntimeSessionId }
      : {}),
  };
  return {
    id: input.reference.activityId,
    tone: "info",
    kind: CONTEXT_HANDOFF_ACTIVITY_KIND,
    summary: "Context handoff requested",
    payload,
    turnId: null,
    createdAt: input.createdAt,
  };
}
