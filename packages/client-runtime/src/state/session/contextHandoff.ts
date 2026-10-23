import type { ContextHandoffId, MessageId, TurnId } from "@ryco/contracts";
import {
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  ContextHandoffActivityPayload,
  type ContextHandoffEndpointSnapshot,
  type ContextHandoffInspectionSummaryMetadata,
  type ContextHandoffReason,
  type ModelSelection,
  type OrchestrationThreadActivity,
} from "@ryco/contracts/orchestration";
import { modelSelectionRequiresContextHandoff } from "@ryco/shared/model";
import { forkContextHandoffPending } from "@ryco/shared/threadFork";
import * as Schema from "effect/Schema";

export type ContextHandoffTimelineStatus = "consumed" | "failed" | "delivery-uncertain";

export interface ContextHandoffTimelineEntry {
  id: string;
  activityId: string;
  handoffId: ContextHandoffId;
  createdAt: string;
  turnId: TurnId | null;
  status: ContextHandoffTimelineStatus;
  /** Absent for model changes recorded before handoffs carried a reason. */
  reason?: ContextHandoffReason;
  targetMessageId: MessageId;
  targetTurnId: TurnId | null;
  sources: ReadonlyArray<ContextHandoffEndpointSnapshot>;
  target: ContextHandoffEndpointSnapshot;
  /**
   * A fork handoff whose fresh session is on another provider instance than the fork was: the
   * endpoint it moved from, shown as `<changedFrom> → <target>`. Absent for every other handoff
   * (a model change lists all of its `sources`).
   */
  changedFrom?: ContextHandoffEndpointSnapshot;
  error?: string;
  inspection?: ContextHandoffInspectionSummaryMetadata;
}

/**
 * Whether a handoff continued the thread after its working directory moved
 * (a chat turned into a project, a relocated workspace) rather than switching
 * models. Accepts timeline entries and decoded activity payloads alike; a
 * missing reason is a model change recorded before handoffs carried one.
 */
export function isCwdRelocationHandoff(handoff: {
  readonly reason?: ContextHandoffReason | undefined;
}): boolean {
  return handoff.reason === "cwd-relocation";
}

/**
 * Whether a handoff delivered a fork's inherited conversation to its first fresh session
 * (no provider-native copy could stop at the fork's boundary). The node records it as a fork
 * handoff whichever model the first message chose, so it may also move the fork to another
 * provider instance; `isModelChangeHandoff` says whether it did.
 */
export function isForkHandoff(handoff: {
  readonly reason?: ContextHandoffReason | undefined;
}): boolean {
  return handoff.reason === "fork";
}

/** What `isModelChangeHandoff` reads: an activity payload or a timeline entry. */
export interface ContextHandoffTransitionSubject {
  readonly reason?: ContextHandoffReason | undefined;
  readonly sourceSelection?: ModelSelection | undefined;
  readonly targetSelection?: ModelSelection | undefined;
  readonly changedFrom?: ContextHandoffEndpointSnapshot | undefined;
}

function forkHandoffChangesProvider(handoff: ContextHandoffTransitionSubject): boolean {
  if (handoff.changedFrom !== undefined) return true;
  return (
    handoff.sourceSelection !== undefined &&
    handoff.targetSelection !== undefined &&
    // The threshold the node applies to a model-change handoff.
    modelSelectionRequiresContextHandoff({
      canonicalSelection: handoff.sourceSelection,
      targetSelection: handoff.targetSelection,
    })
  );
}

/**
 * Whether a handoff moved the thread to another provider instance or model: every model change
 * (a missing reason is one recorded before handoffs carried a reason), and a fork's first fresh
 * session when the first message also switched provider instance. Resume fallbacks (a relocation,
 * missing native history) keep their model.
 */
export function isModelChangeHandoff(handoff: ContextHandoffTransitionSubject): boolean {
  if (handoff.reason === undefined || handoff.reason === "model-change") return true;
  return handoff.reason === "fork" && forkHandoffChangesProvider(handoff);
}

/**
 * The endpoint a handoff moved from: the `sources` entry of its source selection (`sources` also
 * lists earlier endpoints of the conversation). Null when the payload does not list it.
 */
export function contextHandoffSourceEndpoint(handoff: {
  readonly sources: ReadonlyArray<ContextHandoffEndpointSnapshot>;
  readonly sourceSelection: ModelSelection;
}): ContextHandoffEndpointSnapshot | null {
  const { instanceId, model } = handoff.sourceSelection;
  return (
    handoff.sources.find(
      (endpoint) => endpoint.providerInstanceId === instanceId && endpoint.modelSlug === model,
    ) ??
    handoff.sources.find((endpoint) => endpoint.providerInstanceId === instanceId) ??
    null
  );
}

/**
 * Platform-neutral copy for a handoff the node started itself because the thread's native
 * conversation could not be resumed. Its source and target are normally the same model, so it
 * reads as a fresh session, with the reason it was needed, instead of a model transition.
 */
export interface ResumeFallbackHandoffCopy {
  /** Divider headline once the fresh session received the context. */
  readonly continued: string;
  /** Divider headline for an attempt that failed or could not be confirmed. */
  readonly attempted: string;
  /** Hover card title for an attempt that failed. */
  readonly failed: string;
  /** Why the conversation was not resumed natively. */
  readonly explanation: string;
  /** Nothing was sent: the same message goes out again with a new send. */
  readonly retryHint: string;
}

/** A working-directory relocation: the provider can't resume a conversation from another folder. */
export const CWD_RELOCATION_HANDOFF_COPY = {
  continued: "Continued in a fresh session in the new folder",
  attempted: "Fresh session in the new folder",
  failed: "Couldn't continue in the new folder",
  explanation:
    "The working folder moved and this provider can't resume a conversation from another folder, so a fresh session received the conversation's context.",
  retryHint: "Send your message again to retry.",
} as const satisfies ResumeFallbackHandoffCopy;

/** The provider no longer had the conversation (for example, it cleaned up old history). */
export const NATIVE_HISTORY_UNAVAILABLE_HANDOFF_COPY = {
  continued: "Continued in a fresh session",
  attempted: "Fresh session",
  failed: "Couldn't continue in a fresh session",
  explanation:
    "The provider no longer has this conversation's history, so a fresh session received the conversation's context.",
  retryHint: "Send your message again to retry.",
} as const satisfies ResumeFallbackHandoffCopy;

/**
 * The copy of a handoff that stood in for a native resume: a working-directory relocation, or
 * native history the provider no longer had. Null for model changes and forks.
 */
export function resumeFallbackHandoffCopy(handoff: {
  readonly reason?: ContextHandoffReason | undefined;
}): ResumeFallbackHandoffCopy | null {
  switch (handoff.reason) {
    case "cwd-relocation":
      return CWD_RELOCATION_HANDOFF_COPY;
    case "native-history-unavailable":
      return NATIVE_HISTORY_UNAVAILABLE_HANDOFF_COPY;
    default:
      return null;
  }
}

/** A resume-fallback divider's headline for its terminal status. */
export function resumeFallbackHandoffHeadline(
  copy: ResumeFallbackHandoffCopy,
  status: ContextHandoffTimelineStatus,
): string {
  return status === "consumed" ? copy.continued : copy.attempted;
}

/**
 * Platform-neutral copy for a fork's handoff: the fork's own (inherited) history goes to a fresh
 * session, so it reads as that delivery. When the first message also switched provider instance
 * the headline names the model it switched from as well (`changedFrom`).
 */
export const FORK_HANDOFF_COPY = {
  /** Divider headline once the fresh session received the inherited conversation. */
  continued: "Sent the inherited conversation to a fresh session",
  /** Divider headline for a delivery that failed. */
  failed: "Couldn't send the inherited conversation to a fresh session",
  /** Divider headline for a delivery Ryco could not confirm. */
  uncertain: "Couldn't confirm the inherited conversation reached a fresh session",
  /** Why the fork did not continue a copy of the provider's own session. */
  explanation:
    "This fork has no copy of the provider's session, so a fresh session received the conversation it inherited as context. Tool results and reasoning from before the fork weren't carried over.",
  /** The handoff stays owed: the next send delivers the inherited conversation again. */
  retryHint: "Send your message again to retry.",
} as const;

/**
 * The fork divider's headline. `targetLabel` names the fresh session's model where the platform
 * has a label for it ("… to a fresh Claude Sonnet session"); `sourceLabel` names the model the
 * fork switched from when the handoff also changed provider (`changedFrom`).
 */
export function forkHandoffHeadline(
  status: ContextHandoffTimelineStatus,
  targetLabel?: string | null,
  sourceLabel?: string | null,
): string {
  const source = sourceLabel?.trim();
  const switched = source ? `, switching from ${source}` : "";
  if (status === "failed") return `${FORK_HANDOFF_COPY.failed}${switched}`;
  if (status === "delivery-uncertain") return `${FORK_HANDOFF_COPY.uncertain}${switched}`;
  const label = targetLabel?.trim();
  return label
    ? `Sent the inherited conversation to a fresh ${label} session${switched}`
    : `${FORK_HANDOFF_COPY.continued}${switched}`;
}

/** How a platform names a handoff endpoint; each app supplies its own provider labels. */
export interface ContextHandoffEndpointLabelers {
  /** Provider and model ("Claude Sonnet"). */
  readonly endpoint: (endpoint: ContextHandoffEndpointSnapshot) => string;
  /** The model alone ("Sonnet"). */
  readonly model: (endpoint: ContextHandoffEndpointSnapshot) => string;
}

/**
 * The labels a fork handoff's divider names (`forkHandoffHeadline`, `forkHandoffAccessibleLabel`).
 * Usually just the fresh session's model. When the first message also switched provider instance
 * (`changedFrom`), both ends are named with their provider: the provider is what changed, and two
 * instances can serve the same model.
 */
export function forkHandoffEndpointLabels(
  handoff: {
    readonly target: ContextHandoffEndpointSnapshot;
    readonly changedFrom?: ContextHandoffEndpointSnapshot | undefined;
  },
  labelers: ContextHandoffEndpointLabelers,
): { readonly target: string; readonly source: string | null } {
  return handoff.changedFrom
    ? {
        target: labelers.endpoint(handoff.target),
        source: labelers.endpoint(handoff.changedFrom),
      }
    : { target: labelers.model(handoff.target), source: null };
}

/**
 * What a composer says about the next message's context handoff, in precedence order:
 * - `fork`: a handoff fork still owes a provider its inherited conversation, so the node starts
 *   the next turn with a "fork" handoff whichever model is selected. It takes the model-change
 *   chip's place: the node records a fork handoff, not a model change, even when the model
 *   changed too;
 * - `model-change`: the selected model is on another provider instance (the app's own
 *   presentation of both ends);
 * - null: the next message continues the current session.
 */
export type PendingComposerHandoff<ModelChange extends object> =
  | { readonly kind: "fork" }
  | ({ readonly kind: "model-change" } & ModelChange);

/** The one precedence rule every composer applies (`PendingComposerHandoff`). */
export function resolvePendingComposerHandoff<ModelChange extends object>(input: {
  /** The thread's activities; null where the composer shows no handoff chips. */
  readonly activities:
    | ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>
    | null
    | undefined;
  /** The model change the selection makes, read only when no fork handoff is owed. */
  readonly modelChange: () => ModelChange | null;
}): PendingComposerHandoff<ModelChange> | null {
  if (input.activities != null && forkContextHandoffPending(input.activities)) {
    return { kind: "fork" };
  }
  const modelChange = input.modelChange();
  return modelChange ? { kind: "model-change", ...modelChange } : null;
}

/** The divider subject every kind of handoff is described from. */
export interface ContextHandoffMarkerSubject {
  readonly status: ContextHandoffTimelineStatus;
  readonly reason?: ContextHandoffReason | undefined;
  readonly error?: string | undefined;
}

/**
 * How a handoff that did not complete ended, with its error: "Failed: …" or
 * "Delivery uncertain: …". Null once the target received the context.
 */
export function contextHandoffStatusSuffix(handoff: ContextHandoffMarkerSubject): string | null {
  const detail = handoff.error ? `: ${handoff.error}` : "";
  if (handoff.status === "failed") return `Failed${detail}`;
  if (handoff.status === "delivery-uncertain") return `Delivery uncertain${detail}`;
  return null;
}

/**
 * What a failed resume-fallback handoff tells the user to do: nothing was sent,
 * so the same message goes out again with a new send. Null once it completed or
 * when its delivery is uncertain. Model changes offer no retry of their own.
 */
export function resumeFallbackHandoffRetryHint(
  copy: ResumeFallbackHandoffCopy,
  handoff: ContextHandoffMarkerSubject,
): string | null {
  return handoff.status === "failed" ? copy.retryHint : null;
}

/**
 * What a fork handoff that did not complete tells the user: the fork still owes its inherited
 * conversation (a failed or unconfirmed delivery leaves it pending), so the next send retries.
 */
export function forkHandoffRetryHint(handoff: ContextHandoffMarkerSubject): string | null {
  return isForkHandoff(handoff) && handoff.status !== "consumed"
    ? FORK_HANDOFF_COPY.retryHint
    : null;
}

function joinAccessibleSentences(parts: ReadonlyArray<string | null>): string {
  return parts
    .filter((part): part is string => part !== null)
    .map((part) => part.replace(/\.+$/, ""))
    .join(". ");
}

/**
 * The screen-reader label of a resume-fallback divider: its headline, how it
 * ended and what to do next, as sentences. Model changes name their endpoints,
 * which each platform labels itself.
 */
export function resumeFallbackHandoffAccessibleLabel(
  copy: ResumeFallbackHandoffCopy,
  handoff: ContextHandoffMarkerSubject,
): string {
  return joinAccessibleSentences([
    resumeFallbackHandoffHeadline(copy, handoff.status),
    contextHandoffStatusSuffix(handoff),
    resumeFallbackHandoffRetryHint(copy, handoff),
  ]);
}

/** The screen-reader label of a fork handoff divider, like a resume fallback's. */
export function forkHandoffAccessibleLabel(
  handoff: ContextHandoffMarkerSubject,
  targetLabel?: string | null,
  sourceLabel?: string | null,
): string {
  return joinAccessibleSentences([
    forkHandoffHeadline(handoff.status, targetLabel, sourceLabel),
    contextHandoffStatusSuffix(handoff),
    forkHandoffRetryHint(handoff),
  ]);
}

const decodeContextHandoffActivityPayload = Schema.decodeUnknownSync(ContextHandoffActivityPayload);

/**
 * Validates the otherwise opaque activity payload and projects only terminal
 * handoff states. Internal preparation states intentionally have no timeline
 * representation.
 */
export function toContextHandoffTimelineEntry(
  activity: OrchestrationThreadActivity,
): ContextHandoffTimelineEntry | null {
  if (activity.kind !== CONTEXT_HANDOFF_ACTIVITY_KIND) {
    return null;
  }

  let payload;
  try {
    payload = decodeContextHandoffActivityPayload(activity.payload);
  } catch {
    return null;
  }

  if (
    payload.status !== "consumed" &&
    payload.status !== "failed" &&
    payload.status !== "delivery-uncertain"
  ) {
    return null;
  }

  const changedFrom =
    payload.reason === "fork" && forkHandoffChangesProvider(payload)
      ? contextHandoffSourceEndpoint(payload)
      : null;
  return {
    id: `context-handoff:${activity.id}`,
    activityId: activity.id,
    handoffId: payload.handoffId,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    status: payload.status,
    ...(payload.reason ? { reason: payload.reason } : {}),
    targetMessageId: payload.targetMessageId,
    targetTurnId: payload.targetTurnId ?? activity.turnId,
    sources: payload.sources,
    target: payload.target,
    ...(changedFrom ? { changedFrom } : {}),
    ...(payload.inspection ? { inspection: payload.inspection } : {}),
    ...(payload.status === "failed" || payload.status === "delivery-uncertain"
      ? { error: payload.error }
      : {}),
  };
}
