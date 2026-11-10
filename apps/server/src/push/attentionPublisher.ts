/**
 * attentionPublisher - The node's half of push alerts (`docs/push-alerts.md`):
 * decide when a thread needs attention, seal one payload per registered
 * device, and signal the Hub.
 *
 * The decision is the clients' own: one `createThreadNotificationProjector`
 * runs over this node's shell, fed the same thread rows the WebSocket shell
 * stream sends, with the Inbox's snooze rule. It baselines silently when the
 * publisher starts, so a restart never replays old transitions.
 *
 * - Domain events only mark threads dirty; dirty threads are re-read in
 *   sequence order on a short debounce, so a streaming turn costs one row read
 *   per pass, not one per event, and short-lived states (an approval answered
 *   at once) never alert.
 * - Each thread's candidate waits {@link ATTENTION_COALESCE_MS}, and a newer
 *   one replaces it: a turn that completes right after an approval sends one
 *   alert.
 * - Per device: the kinds it asked for, minus action kinds for a viewer, and
 *   nothing while it is in front (its local alerts cover the screen). Each
 *   sealed alert carries the node's "needs you" count (`b`, the Live Activity's
 *   rule) for the device's app icon badge.
 * - One signal per pass (split at 32 deliveries), each with a fresh sequence
 *   persisted before it is sent. A failed send is retried once with the same
 *   sequence and payload, then dropped: alerts are perishable. A Hub without
 *   the route (404) is not asked again for an hour.
 * - Live Activity counts (`docs/live-activity-push.md`) ride the same passes: the rows each
 *   pass read are kept, and after it the node counts them and signals the devices whose card
 *   takes push updates, on the same sequence counter and proof, at most once per
 *   {@link ACTIVITY_MIN_INTERVAL_MS}. A failed activity signal is never retried inside the
 *   queue the alerts share: later passes back off on their own timer.
 *
 * @module push/attentionPublisher
 */
import {
  createThreadNotificationProjector,
  isArchivedThreadStub,
  type SidebarThreadOrStub,
  type SidebarThreadSummary,
  type SidebarWorktreeSummary,
  type ThreadNotificationEvent,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { PushAlertKind, PushHubDelivery } from "@ryco/contracts/push";
import {
  PUSH_ALERT_REQUEST_ID_MAX_LENGTH,
  PUSH_ALERT_TITLE_MAX_LENGTH,
  type PushActivitySignalInput,
  type PushActivitySignalResult,
  type PushAlertPlaintext,
  type PushAttentionDelivery,
  type PushAttentionSignalInput,
  type PushAttentionSignalResult,
} from "@ryco/contracts/push-hub";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";
import {
  pushCollapseIdBytes,
  pushSealAssociatedData,
  sealPushPayload,
} from "@ryco/shared/pushSeal";

import {
  ACTIVITY_FOREGROUND_RECHECK_MS,
  ACTIVITY_MIN_INTERVAL_MS,
  ACTIVITY_REFRESH_MS,
  activityCountsZero,
  countNodeAgentActivity,
  planActivityRecipients,
  type SentActivity,
} from "./liveActivityCounts.ts";
import { effectivePushKinds, type PushRegistration } from "./pushRegistrations.ts";
import { chunkForSignals } from "./pushSignalChunks.ts";

export const ATTENTION_READ_DEBOUNCE_MS = 150;
export const ATTENTION_COALESCE_MS = 1_000;
export const ATTENTION_RETRY_DELAY_MS = 5_000;
export const ATTENTION_UNSUPPORTED_BACKOFF_MS = 60 * 60 * 1_000;

/** How one node-proof signal to the Hub went. */
export type HubSignalOutcome<Result> =
  | { readonly kind: "delivered"; readonly result: Result }
  /** The Hub has no such route (an older Hub). */
  | { readonly kind: "unsupported" }
  /** The Hub refused the node itself; asking again won't help. */
  | { readonly kind: "refused" }
  /** Network failure, timeout or a server error: worth one retry. */
  | { readonly kind: "failed" };

export type AttentionSendOutcome = HubSignalOutcome<PushAttentionSignalResult>;
export type ActivitySendOutcome = HubSignalOutcome<PushActivitySignalResult>;

export interface AttentionPublisherDeps {
  /** The node's Hub environment id: the id devices know it by. */
  readonly environmentId: () => Promise<string | null>;
  readonly isConnectorOnline: () => boolean;
  readonly readShell: () => Promise<{
    readonly sequence: number;
    readonly threads: ReadonlyArray<SidebarThreadOrStub>;
    /** The node's workspaces, for its Inbox rule; read again on each activity refresh. */
    readonly worktrees?: ReadonlyArray<SidebarWorktreeSummary> | undefined;
    /** The node's own automatic settlement rule. */
    readonly autoSettleAfterDays?: SidebarAutoSettleAfterDays | undefined;
  }>;
  /** The thread's current row, mapped as the shell stream maps it; null once it is gone. */
  readonly readThread: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Promise<SidebarThreadSummary | null>;
  readonly isSnoozed: (thread: SidebarThreadSummary, nowMs: number) => boolean;
  readonly registrations: () => Promise<ReadonlyArray<PushRegistration>>;
  /** Enrollments whose device is in front now; they get no push. */
  readonly foregroundEnrollments: (nowMs: number) => Promise<ReadonlySet<string>>;
  readonly reserveSequence: () => Promise<number>;
  readonly removeEnrollments: (enrollmentIds: ReadonlyArray<string>) => Promise<void>;
  readonly setHubDelivery: (delivery: PushHubDelivery) => void;
  /** Adds a fresh node proof and posts the signal. */
  readonly send: (signal: Omit<PushAttentionSignalInput, "proof">) => Promise<AttentionSendOutcome>;
  /** Adds a fresh node proof and posts an activity signal; absent: no Live Activity counts. */
  readonly sendActivity?:
    | ((signal: Omit<PushActivitySignalInput, "proof">) => Promise<ActivitySendOutcome>)
    | undefined;
  /** Calls back after a registration or a device's presence changed; returns the unsubscribe. */
  readonly onRegistrationsChanged?: ((listener: () => void) => () => void) | undefined;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly reportFailure: (message: string, error?: unknown) => void;
}

export interface AttentionPublisher {
  /** A domain event touched this thread at `sequence`. */
  readonly threadChanged: (threadId: ThreadId, sequence: number) => void;
  /** The thread was deleted or trashed at `sequence`. */
  readonly threadRemoved: (threadId: ThreadId, sequence: number) => void;
  readonly stop: () => Promise<void>;
}

/** The node's own projection has one lifecycle: it is current while the publisher runs. */
const GENERATION: object = Object.freeze({});

const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

function truncateTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length <= PUSH_ALERT_TITLE_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, PUSH_ALERT_TITLE_MAX_LENGTH - 1)}…`;
}

/**
 * An approval alert's `rq`: the approval an Approve or Deny on it answers. Left out when the
 * row names none (an older projection) or the id is too long to seal; the phone then answers
 * nothing from the alert and the person chooses on screen.
 */
function sealedApprovalRequestIdField(
  candidate: ThreadNotificationEvent,
): Pick<PushAlertPlaintext, "rq"> {
  const requestId = candidate.kind === "approval" ? candidate.approvalRequestId : null;
  return requestId !== null && requestId.length <= PUSH_ALERT_REQUEST_ID_MAX_LENGTH
    ? { rq: requestId }
    : {};
}

/** One alert for one device. */
export interface AttentionRecipient {
  readonly registration: PushRegistration;
  readonly candidate: ThreadNotificationEvent;
}

/**
 * Who gets what in one pass: every device not in front, for each candidate of
 * a kind it receives, chunked so each chunk fits one signal.
 */
export function planAttentionRecipients(input: {
  readonly candidates: ReadonlyArray<ThreadNotificationEvent>;
  readonly registrations: ReadonlyArray<PushRegistration>;
  readonly isForeground: (enrollmentId: string) => boolean;
}): ReadonlyArray<ReadonlyArray<AttentionRecipient>> {
  const recipients: AttentionRecipient[] = [];
  for (const registration of input.registrations) {
    if (input.isForeground(registration.enrollmentId)) continue;
    const kinds = new Set<PushAlertKind>(effectivePushKinds(registration));
    for (const candidate of input.candidates) {
      if (kinds.has(candidate.kind)) recipients.push({ registration, candidate });
    }
  }
  return chunkForSignals(recipients);
}

/** Seals each recipient's payload, bound to this signal's sequence. */
export function sealAttentionDeliveries(input: {
  readonly environmentId: string;
  readonly sequence: number;
  readonly issuedAt: number;
  readonly recipients: ReadonlyArray<AttentionRecipient>;
  /** This node's "needs you" count, for the device's app icon badge (`b`). */
  readonly needsYou?: number | undefined;
}): ReadonlyArray<PushAttentionDelivery> {
  return input.recipients.map(({ registration, candidate }) => {
    const plaintext: PushAlertPlaintext = {
      v: 1,
      k: candidate.kind,
      t: truncateTitle(candidate.title),
      e: input.environmentId,
      th: candidate.ref.threadId,
      tu: candidate.turnId,
      ...sealedApprovalRequestIdField(candidate),
      q: input.sequence,
      at: input.issuedAt,
      ...(input.needsYou === undefined ? {} : { b: input.needsYou }),
    };
    return {
      enrollmentId: registration.enrollmentId as PushAttentionDelivery["enrollmentId"],
      sealed: toBase64Url(
        sealPushPayload({
          recipientPublicKey: Uint8Array.from(Buffer.from(registration.publicKey, "base64url")),
          plaintext: new TextEncoder().encode(JSON.stringify(plaintext)),
          associatedData: pushSealAssociatedData({
            environmentId: input.environmentId,
            sequence: input.sequence,
            enrollmentId: registration.enrollmentId,
          }),
        }),
      ),
      collapseId: toBase64Url(
        pushCollapseIdBytes({
          salt: Uint8Array.from(Buffer.from(registration.collapseSalt, "base64url")),
          environmentId: input.environmentId,
          threadId: candidate.ref.threadId,
        }),
      ),
    };
  });
}

export function startAttentionPublisher(deps: AttentionPublisherDeps): AttentionPublisher {
  let stopped = false;
  let environmentId: EnvironmentId | null = null;
  let baselined = false;
  let unsupportedUntil = 0;
  const projector = createThreadNotificationProjector({
    readGeneration: () => (stopped ? null : GENERATION),
    isSnoozed: deps.isSnoozed,
  });
  /** Thread → the latest sequence an event touched it at (null: removed). */
  const dirty = new Map<ThreadId, { readonly sequence: number; readonly removed: boolean }>();
  const pending = new Map<ThreadId, ThreadNotificationEvent>();
  let readTimer: unknown = null;
  let flushTimer: unknown = null;
  let chain: Promise<void> = Promise.resolve();

  // Live Activity counts: the rows the passes read, and what the Hub holds per device.
  const rows = new Map<ThreadId, SidebarThreadSummary>();
  let worktrees: ReadonlyArray<SidebarWorktreeSummary> = [];
  let autoSettleAfterDays: SidebarAutoSettleAfterDays | undefined;
  let shellReadAt = 0;
  const sentActivity = new Map<string, SentActivity>();
  let activityTimer: unknown = null;
  let activityDueAt: number | null = null;
  let lastActivitySignalAt = Number.NEGATIVE_INFINITY;
  let activityUnsupportedUntil = 0;
  /** After a failed or refused activity signal: no pass before this, the wait growing. */
  let activityRetryAt = 0;
  let activityBackoffMs = 0;

  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch((error: unknown) => {
      deps.reportFailure("Push alert work failed.", error);
    });
  };

  const readShell = async () => {
    const shell = await deps.readShell();
    shellReadAt = deps.now();
    worktrees = shell.worktrees ?? [];
    autoSettleAfterDays = shell.autoSettleAfterDays;
    return shell;
  };

  const keepRows = (threads: ReadonlyArray<SidebarThreadOrStub>) => {
    rows.clear();
    for (const thread of threads) {
      if (!isArchivedThreadStub(thread)) rows.set(thread.id, thread);
    }
  };

  const baseline = async () => {
    const id = await deps.environmentId();
    if (stopped || id === null) return;
    environmentId = id as EnvironmentId;
    const shell = await readShell();
    if (stopped) return;
    projector.baseline({
      environmentId,
      generation: GENERATION,
      sequence: shell.sequence,
      threads: shell.threads.map((thread) => ({ ...thread, environmentId: environmentId! })),
      nowMs: deps.now(),
    });
    keepRows(shell.threads);
    baselined = true;
    scheduleActivity(0);
  };

  const readDirty = async () => {
    if (stopped || !baselined || environmentId === null) return;
    const batch = Array.from(dirty.entries()).toSorted(
      (left, right) => left[1].sequence - right[1].sequence,
    );
    dirty.clear();
    for (const [threadId, change] of batch) {
      if (stopped) return;
      if (change.removed) {
        projector.remove({
          environmentId,
          generation: GENERATION,
          sequence: change.sequence,
          threadId,
        });
        pending.delete(threadId);
        rows.delete(threadId);
        continue;
      }
      const thread = await deps.readThread(environmentId, threadId);
      if (stopped) return;
      if (thread === null) {
        rows.delete(threadId);
        continue;
      }
      rows.set(threadId, thread);
      const candidate = projector.observe({
        generation: GENERATION,
        sequence: change.sequence,
        thread: { ...thread, environmentId },
        nowMs: deps.now(),
      });
      if (candidate !== null) {
        pending.set(threadId, candidate);
        scheduleFlush();
      }
    }
    if (batch.length > 0) scheduleActivity(0);
  };

  const scheduleRead = () => {
    if (stopped || readTimer !== null) return;
    readTimer = deps.setTimeout(() => {
      readTimer = null;
      enqueue(readDirty);
    }, ATTENTION_READ_DEBOUNCE_MS);
  };

  const scheduleFlush = () => {
    if (stopped || flushTimer !== null) return;
    flushTimer = deps.setTimeout(() => {
      flushTimer = null;
      enqueue(flush);
    }, ATTENTION_COALESCE_MS);
  };

  /**
   * Runs an activity pass `delayMs` from now, but never sooner than
   * {@link ACTIVITY_MIN_INTERVAL_MS} after the last activity signal; an earlier
   * request replaces a later one.
   */
  function scheduleActivity(delayMs: number) {
    if (stopped || deps.sendActivity === undefined) return;
    const dueAt = Math.max(
      deps.now() + delayMs,
      lastActivitySignalAt + ACTIVITY_MIN_INTERVAL_MS,
      activityRetryAt,
    );
    if (activityDueAt !== null && activityDueAt <= dueAt) return;
    if (activityTimer !== null) deps.clearTimeout(activityTimer);
    activityDueAt = dueAt;
    activityTimer = deps.setTimeout(
      () => {
        activityTimer = null;
        activityDueAt = null;
        enqueue(flushActivity);
      },
      Math.max(0, dueAt - deps.now()),
    );
  }

  /** Sends one signal, retried once on failure; null when it was not delivered. */
  const sendWithRetry = async <Result>(
    send: () => Promise<HubSignalOutcome<Result>>,
    onUnsupported: () => void,
  ): Promise<Result | null> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (stopped || !deps.isConnectorOnline()) {
        deps.setHubDelivery("offline");
        return null;
      }
      const outcome = await send();
      if (outcome.kind === "delivered") return outcome.result;
      if (outcome.kind === "unsupported") {
        onUnsupported();
        return null;
      }
      if (outcome.kind === "refused") return null;
      if (attempt === 0) {
        await new Promise<void>((resolve) => {
          deps.setTimeout(resolve, ATTENTION_RETRY_DELAY_MS);
        });
      }
    }
    deps.reportFailure("A push signal could not reach the Hub; it was dropped.");
    return null;
  };

  const forgetUnauthorized = async (
    results: ReadonlyArray<{ readonly enrollmentId: string; readonly status: string }>,
  ) => {
    const unauthorized = results
      .filter((result) => result.status === "not-authorized")
      .map((result) => result.enrollmentId);
    if (unauthorized.length > 0) await deps.removeEnrollments(unauthorized);
  };

  const flush = async () => {
    if (stopped || environmentId === null) return;
    const candidates = Array.from(pending.values()).filter((candidate) =>
      projector.isCurrent(candidate),
    );
    pending.clear();
    if (candidates.length === 0) return;
    if (!deps.isConnectorOnline()) {
      deps.setHubDelivery("offline");
      return;
    }
    if (deps.now() < unsupportedUntil) return;
    const [registrations, foreground] = await Promise.all([
      deps.registrations(),
      deps.foregroundEnrollments(deps.now()),
    ]);
    if (stopped) return;
    const chunks = planAttentionRecipients({
      candidates,
      registrations,
      isForeground: (enrollmentId) => foreground.has(enrollmentId),
    });
    // The rows the passes keep are current for every thread an alert is about.
    const { needsYou } = countNodeAgentActivity({
      environmentId,
      threads: rows.values(),
      worktrees,
      autoSettleAfterDays,
      nowMs: deps.now(),
    }).counts;
    for (const recipients of chunks) {
      if (stopped) return;
      const sequence = await deps.reserveSequence();
      const issuedAt = deps.now();
      const signal = {
        sequence,
        issuedAt,
        deliveries: sealAttentionDeliveries({
          environmentId,
          sequence,
          issuedAt,
          recipients,
          needsYou,
        }),
      };
      const result = await sendWithRetry(
        () => deps.send(signal),
        () => {
          unsupportedUntil = deps.now() + ATTENTION_UNSUPPORTED_BACKOFF_MS;
          deps.setHubDelivery("hub-unsupported");
        },
      );
      if (result === null) continue;
      deps.setHubDelivery("available");
      await forgetUnauthorized(result.results);
    }
  };

  /**
   * One Live Activity pass: count this node's threads and signal each device whose counts the
   * Hub must hear, then plan the next pass (a result ageing out, a device leaving the front, the
   * refresh before the Hub's stale window).
   */
  const flushActivity = async () => {
    const sendActivity = deps.sendActivity;
    if (stopped || sendActivity === undefined || !baselined || environmentId === null) return;
    const registrations = (await deps.registrations()).filter(
      (registration) => registration.liveActivity === true,
    );
    if (stopped) return;
    const wanted = new Set(registrations.map((registration) => registration.enrollmentId));
    for (const enrollmentId of sentActivity.keys()) {
      if (!wanted.has(enrollmentId)) sentActivity.delete(enrollmentId);
    }
    // Nothing to count for: the next registration's own pass starts again.
    if (registrations.length === 0) return;
    // Back off without forgetting the cadence: the refresh comes round again.
    if (!deps.isConnectorOnline() || deps.now() < activityUnsupportedUntil) {
      scheduleActivity(ACTIVITY_REFRESH_MS);
      return;
    }
    // Workspaces change rarely; read them again with each refresh.
    if (deps.now() - shellReadAt >= ACTIVITY_REFRESH_MS) {
      const shell = await readShell();
      if (stopped) return;
      keepRows(shell.threads);
    }
    const nowMs = deps.now();
    const foreground = await deps.foregroundEnrollments(nowMs);
    if (stopped) return;
    let anyForeground = false;
    for (const registration of registrations) {
      if (!foreground.has(registration.enrollmentId)) continue;
      anyForeground = true;
      // The app updates its own card in front; once it leaves, the Hub hears the counts again.
      const previous = sentActivity.get(registration.enrollmentId);
      if (previous !== undefined) {
        sentActivity.set(registration.enrollmentId, { ...previous, resend: true });
      }
    }
    if (registrations.every((registration) => foreground.has(registration.enrollmentId))) {
      scheduleActivity(ACTIVITY_FOREGROUND_RECHECK_MS);
      return;
    }
    const activity = countNodeAgentActivity({
      environmentId,
      threads: rows.values(),
      worktrees,
      autoSettleAfterDays,
      nowMs,
    });
    const chunks = planActivityRecipients({
      registrations,
      isForeground: (enrollmentId) => foreground.has(enrollmentId),
      sent: sentActivity,
      counts: activity.counts,
      nowMs,
    });
    let limited = false;
    for (const enrollmentIds of chunks) {
      if (stopped) return;
      if (!deps.isConnectorOnline()) break;
      const sequence = await deps.reserveSequence();
      const issuedAt = deps.now();
      lastActivitySignalAt = issuedAt;
      // One attempt per pass: a failure backs off on its own timer instead of holding the queue
      // the alerts share; the first retry comes after ATTENTION_RETRY_DELAY_MS, later ones wait
      // longer, up to the refresh.
      const outcome = await sendActivity({
        sequence,
        issuedAt,
        activities: enrollmentIds.map((enrollmentId) => ({
          enrollmentId:
            enrollmentId as PushActivitySignalInput["activities"][number]["enrollmentId"],
          counts: activity.counts,
        })),
      });
      if (stopped) return;
      if (outcome.kind === "unsupported") {
        activityUnsupportedUntil = deps.now() + ATTENTION_UNSUPPORTED_BACKOFF_MS;
        break;
      }
      if (outcome.kind !== "delivered") {
        activityBackoffMs = Math.min(
          Math.max(ATTENTION_RETRY_DELAY_MS, activityBackoffMs * 2),
          ACTIVITY_REFRESH_MS,
        );
        activityRetryAt = deps.now() + activityBackoffMs;
        deps.reportFailure(
          "A Live Activity signal could not reach the Hub; it is sent again later.",
        );
        scheduleActivity(activityBackoffMs);
        return;
      }
      activityBackoffMs = 0;
      activityRetryAt = 0;
      for (const entry of outcome.result.results) {
        if (entry.status === "accepted" || entry.status === "no-token") {
          sentActivity.set(entry.enrollmentId, {
            counts: activity.counts,
            // The pass's own time, so the next pass on the refresh timer finds it due.
            atMs: nowMs,
            held: entry.status === "accepted",
            resend: false,
          });
        } else if (entry.status === "not-authorized") {
          sentActivity.delete(entry.enrollmentId);
        } else {
          // Rate-limited, or a status this node does not know yet: send it again later.
          limited = true;
          const previous = sentActivity.get(entry.enrollmentId);
          if (previous !== undefined) {
            sentActivity.set(entry.enrollmentId, { ...previous, resend: true });
          }
        }
      }
      await forgetUnauthorized(outcome.result.results);
    }
    if (stopped) return;
    const nextAt = [
      activity.nextChangeAtMs,
      anyForeground ? nowMs + ACTIVITY_FOREGROUND_RECHECK_MS : null,
      limited ? nowMs + ACTIVITY_FOREGROUND_RECHECK_MS : null,
      // Only work in progress needs the refresh: zero counts the Hub took stay true.
      activityCountsZero(activity.counts) ? null : nowMs + ACTIVITY_REFRESH_MS,
    ].reduce<number>(
      (earliest, at) => (at !== null && at < earliest ? at : earliest),
      Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(nextAt)) scheduleActivity(Math.max(0, nextAt - deps.now()));
  };

  enqueue(baseline);
  const unsubscribe = deps.onRegistrationsChanged?.(() => {
    if (baselined) scheduleActivity(0);
  });

  return {
    threadChanged: (threadId, sequence) => {
      if (stopped) return;
      const previous = dirty.get(threadId);
      if (previous === undefined || previous.sequence <= sequence) {
        dirty.set(threadId, { sequence, removed: false });
      }
      scheduleRead();
    },
    threadRemoved: (threadId, sequence) => {
      if (stopped) return;
      dirty.set(threadId, { sequence, removed: true });
      scheduleRead();
    },
    stop: async () => {
      stopped = true;
      unsubscribe?.();
      if (readTimer !== null) deps.clearTimeout(readTimer);
      if (flushTimer !== null) deps.clearTimeout(flushTimer);
      if (activityTimer !== null) deps.clearTimeout(activityTimer);
      readTimer = null;
      flushTimer = null;
      activityTimer = null;
      dirty.clear();
      pending.clear();
      rows.clear();
      sentActivity.clear();
      projector.reset();
      await chain;
    },
  };
}
