/**
 * Context handoffs that stand in for a native resume that cannot happen.
 *
 * A turn start normally resumes the thread's native conversation. Two cases make that impossible:
 * - `cwd-relocation`: the working directory moved (a chat became a project, the workspace root
 *   changed, a worktree was relocated) and the provider keeps conversations per directory
 *   (Claude), or the resume in the new directory found nothing;
 * - `native-history-unavailable`: the provider no longer has the conversation at all (Claude
 *   removed an old transcript, a Codex rollout is gone), on a thread with history to carry.
 *
 * The server then runs an ordinary `full-context-fresh-session` handoff on the same provider
 * instance: same coordinator, record, document, renderer and timeline divider. Only the requested
 * activity is appended by the server instead of the decider, with ids derived from the turn-start
 * event, so a retry or a restart finds the same operation. One turn start becomes at most one such
 * handoff, so both reasons share these ids: a replay that classifies the failure differently still
 * finds the first operation instead of starting a second one.
 *
 * Pure module: no services, no I/O.
 *
 * @module ContextHandoffResumeFallback
 */
import {
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  CONTEXT_HANDOFF_SCHEMA_VERSION,
  ContextHandoffId,
  EventId,
  type ContextHandoffActivityPayload,
  type ContextHandoffReason,
  type ContextHandoffReference,
  type MessageId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type RuntimeSessionId,
} from "@ryco/contracts";

/** Why the server continued a turn by handoff instead of resuming its native conversation. */
export type ResumeFallbackReason = Extract<
  ContextHandoffReason,
  "cwd-relocation" | "native-history-unavailable"
>;

/**
 * Every resume-fallback handoff id starts with this prefix. It names the first such fallback, a
 * working-directory move; persisted handoffs and their recovery depend on the value.
 */
export const RESUME_FALLBACK_HANDOFF_ID_PREFIX = "context-handoff:cwd-relocation:";

const RESUME_FALLBACK_ACTIVITY_ID_PREFIX = "context-handoff-activity:cwd-relocation:";

/** The parts of a `thread.turn-start-requested` event the reference derives from. */
export interface ResumeFallbackTurnStart {
  readonly eventId: EventId;
  readonly payload: { readonly messageId: MessageId };
}

/** The handoff reference of one turn start, stable across retries and restarts. */
export function resumeFallbackHandoffReference(
  event: ResumeFallbackTurnStart,
): ContextHandoffReference {
  return {
    handoffId: ContextHandoffId.make(`${RESUME_FALLBACK_HANDOFF_ID_PREFIX}${event.eventId}`),
    activityId: EventId.make(`${RESUME_FALLBACK_ACTIVITY_ID_PREFIX}${event.eventId}`),
    targetMessageId: event.payload.messageId,
  };
}

export function isResumeFallbackHandoffId(handoffId: string): boolean {
  return handoffId.startsWith(RESUME_FALLBACK_HANDOFF_ID_PREFIX);
}

/**
 * The `requested` activity the coordinator validates before it creates the
 * operation record. Same shape as the decider's for a model handoff except for
 * its reason, which the coordinator carries into the terminal divider; the
 * target is normally the source selection itself.
 */
export function makeResumeFallbackRequestedActivity(input: {
  readonly reason: ResumeFallbackReason;
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
    reason: input.reason,
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
