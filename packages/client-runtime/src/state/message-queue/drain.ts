import { resolveQueuedDispatchAck, type QueuedDispatchSnapshot } from "../session/dispatchAck.ts";
import {
  deriveQueueFailureCauses,
  holdQueueForCauses,
  mergeQueueHold,
  partitionNewQueueFailureCauses,
  releasableRestartCauseKeys,
  releasableUsageLimitCauseKeys,
  type QueueHold,
} from "./hold.ts";
import {
  collectQueuedMessageSteerOutcomes,
  type QueuedMessageSteerAttempt,
  type QueuedMessageSteerRejection,
} from "./logic.ts";
import type { QueueThreadView } from "./threadView.ts";

export type QueueDrainWaitReason =
  | "environment"
  | "held"
  | "awaiting-ack"
  | "archived"
  | "busy"
  | "no-sender"
  | "detail"
  | "failed-head"
  | "in-flight"
  | "steering";

export interface QueueDrainInput {
  readonly nowIso: string;
  readonly queue: ReadonlyArray<{
    readonly id: string;
    readonly deliveryStatus?: "sending" | "failed";
  }>;
  /** Live steer attempts by message id. An entry with one is never sent as a turn. */
  readonly steerAttempts: Readonly<Record<string, QueuedMessageSteerAttempt>>;
  readonly hold: QueueHold | null;
  /** undefined → the baseline step runs first. */
  readonly acknowledgedCauseKeys: readonly string[] | undefined;
  readonly headProviderInstanceId: string | null;
  readonly view: QueueThreadView | null;
  /** Local draft key with a mounted foreground sender (web only). */
  readonly draft: boolean;
  readonly environment: { readonly shellLive: boolean; readonly mutationReady: boolean };
  readonly pendingDispatch: QueuedDispatchSnapshot | null;
  readonly dispatchedMessageIds: ReadonlySet<string>;
  readonly sender: "foreground" | "background" | null;
}

export type QueueDrainStep =
  | { readonly kind: "idle" }
  | { readonly kind: "baseline"; readonly causeKeys: string[] }
  | { readonly kind: "thread-gone" }
  | {
      readonly kind: "reconcile";
      readonly removeIds: string[];
      readonly endSteers: QueueDrainSteerRejection[];
    }
  | { readonly kind: "dispatch-started"; readonly messageId: string }
  | { readonly kind: "dispatch-failed"; readonly hold: QueueHold }
  | { readonly kind: "acknowledge"; readonly causeKeys: string[] }
  /** Remove these causes from the hold and acknowledge them (an ended usage limit). */
  | { readonly kind: "release"; readonly causeKeys: string[] }
  | { readonly kind: "hold"; readonly hold: QueueHold }
  | { readonly kind: "wait"; readonly reason: QueueDrainWaitReason }
  | {
      readonly kind: "send";
      readonly messageId: string;
      readonly sender: "foreground" | "background";
    };

export type QueueDrainSteerRejection = QueuedMessageSteerRejection;

const IDLE: QueueDrainStep = { kind: "idle" };
const THREAD_GONE: QueueDrainStep = { kind: "thread-gone" };
const WAIT_STEPS = {} as Record<QueueDrainWaitReason, QueueDrainStep>;
function wait(reason: QueueDrainWaitReason): QueueDrainStep {
  return (WAIT_STEPS[reason] ??= { kind: "wait", reason });
}

function headWaitReason(
  head: QueueDrainInput["queue"][number],
  steerAttempts: QueueDrainInput["steerAttempts"],
): QueueDrainWaitReason | null {
  if (head.deliveryStatus === "failed") return "failed-head";
  if (head.deliveryStatus === "sending") return "in-flight";
  if (steerAttempts[head.id] !== undefined) return "steering";
  return null;
}

/**
 * One ordered drain decision for one thread. The steps are tried in a fixed
 * order and the first that applies is returned; the caller applies it and
 * re-evaluates for the bookkeeping steps (baseline, reconcile, ack, hold).
 */
export function resolveQueueDrainStep(input: QueueDrainInput): QueueDrainStep {
  const { queue, view, environment } = input;
  const nowMs = Date.parse(input.nowIso);
  const head = queue[0];
  // 1. Nothing queued.
  if (!head) return IDLE;

  // 2. A local draft has no thread yet; its mounted ChatView sends through the
  // bootstrap that creates it.
  if (view === null && input.draft) {
    if (input.hold !== null) return wait("held");
    if (input.pendingDispatch !== null) return wait("awaiting-ack");
    if (!environment.mutationReady) return wait("environment");
    const headWait = headWaitReason(head, input.steerAttempts);
    if (headWait !== null) return wait(headWait);
    return { kind: "send", messageId: head.id, sender: "foreground" };
  }

  // 3. No shell for the thread.
  if (view === null) return environment.shellLive ? THREAD_GONE : wait("environment");

  // 4. Cached or demoted rows cannot be trusted for dedupe or running state.
  if (!environment.shellLive) return wait("environment");

  // 5. The causes current when the queue became non-empty were already seen,
  // including an interrupt whose turn has not settled yet.
  if (input.acknowledgedCauseKeys === undefined) {
    return {
      kind: "baseline",
      causeKeys: deriveQueueFailureCauses(view, input.dispatchedMessageIds, {
        includeUnsettled: true,
        nowMs,
      }).map((cause) => cause.causeKey),
    };
  }

  // 6. Projected queued messages were delivered (including a lost reply or an
  // accepted steer); a steer rejected by its own request returns its message to
  // the queue, failed (explicit retry) when the provider may already have it.
  // Runs before any eligibility check.
  if (view.detailLoaded) {
    const removeIds = queue
      .filter((entry) => view.projectedMessageIds.has(entry.id))
      .map((entry) => entry.id);
    const endSteers = collectQueuedMessageSteerOutcomes({
      attempts: Object.entries(input.steerAttempts),
      projectedMessageIds: view.projectedMessageIds,
      rejectionsByActivityId: view.steerRejectionsByActivityId,
    }).rejected;
    if (removeIds.length > 0 || endSteers.length > 0) {
      return { kind: "reconcile", removeIds, endSteers };
    }
  }

  // 7. The previous queued send is acknowledged by its own turn or failure.
  if (input.pendingDispatch !== null) {
    const ack = resolveQueuedDispatchAck({ snapshot: input.pendingDispatch, view });
    // A start a Stop cancelled is settled the same way: the Stop holds the queue.
    if (ack.kind === "started" || ack.kind === "settled") {
      return { kind: "dispatch-started", messageId: input.pendingDispatch.messageId };
    }
    if (ack.kind === "failed") {
      return {
        kind: "dispatch-failed",
        hold: mergeQueueHold(
          input.hold,
          { reason: "error", causeKeys: [ack.causeKey], detail: ack.detail },
          input.nowIso,
        ),
      };
    }
  }

  // 8. A usage-limit hold ends by itself once the limit no longer holds the queue, and
  // a restart hold once a later turn took over.
  const causes = deriveQueueFailureCauses(view, input.dispatchedMessageIds, { nowMs });
  const released = [
    ...releasableUsageLimitCauseKeys({
      hold: input.hold,
      view,
      currentCauses: causes,
      nowMs,
    }),
    ...releasableRestartCauseKeys({ hold: input.hold, view }),
  ];
  if (released.length > 0) return { kind: "release", causeKeys: released };

  // 9. New failure causes merge into the hold before the held check, so a
  // cause arriving while already held is covered by a single Resume.
  const partition = partitionNewQueueFailureCauses({
    causes,
    acknowledgedCauseKeys: input.acknowledgedCauseKeys,
    hold: input.hold,
    headProviderInstanceId: input.headProviderInstanceId,
  });
  if (partition.exempt.length > 0) {
    return { kind: "acknowledge", causeKeys: partition.exempt.map((cause) => cause.causeKey) };
  }
  if (partition.hold.length > 0) {
    return { kind: "hold", hold: holdQueueForCauses(input.hold, partition.hold, input.nowIso)! };
  }

  // 10–17. Waits, in order.
  if (input.hold !== null) return wait("held");
  if (input.pendingDispatch !== null) return wait("awaiting-ack");
  if (view.archived) return wait("archived");
  if (view.running || view.hasPendingApproval || view.hasPendingUserInput) return wait("busy");
  if (!environment.mutationReady) return wait("environment");
  if (input.sender === null) return wait("no-sender");
  if (!view.detailLoaded) return wait("detail");
  const headWait = headWaitReason(head, input.steerAttempts);
  if (headWait !== null) return wait(headWait);

  // 18.
  return { kind: "send", messageId: head.id, sender: input.sender };
}
