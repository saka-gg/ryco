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
 *   nothing while it is in front (its local alerts cover the screen).
 * - One signal per pass (split at 32 deliveries), each with a fresh sequence
 *   persisted before it is sent. A failed send is retried once with the same
 *   sequence and payload, then dropped: alerts are perishable. A Hub without
 *   the route (404) is not asked again for an hour.
 *
 * @module push/attentionPublisher
 */
import {
  createThreadNotificationProjector,
  type SidebarThreadOrStub,
  type SidebarThreadSummary,
  type ThreadNotificationEvent,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { PushAlertKind, PushHubDelivery } from "@ryco/contracts/push";
import {
  PUSH_ALERT_TITLE_MAX_LENGTH,
  PUSH_ATTENTION_MAX_DELIVERIES,
  type PushAlertPlaintext,
  type PushAttentionDelivery,
  type PushAttentionSignalInput,
  type PushAttentionSignalResult,
} from "@ryco/contracts/push-hub";
import {
  pushCollapseIdBytes,
  pushSealAssociatedData,
  sealPushPayload,
} from "@ryco/shared/pushSeal";

import { effectivePushKinds, type PushRegistration } from "./pushRegistrations.ts";

export const ATTENTION_READ_DEBOUNCE_MS = 150;
export const ATTENTION_COALESCE_MS = 1_000;
export const ATTENTION_RETRY_DELAY_MS = 5_000;
export const ATTENTION_UNSUPPORTED_BACKOFF_MS = 60 * 60 * 1_000;

export type AttentionSendOutcome =
  | { readonly kind: "delivered"; readonly result: PushAttentionSignalResult }
  /** The Hub has no attention route (an older Hub). */
  | { readonly kind: "unsupported" }
  /** The Hub refused the node itself; asking again won't help. */
  | { readonly kind: "refused" }
  /** Network failure, timeout or a server error: worth one retry. */
  | { readonly kind: "failed" };

export interface AttentionPublisherDeps {
  /** The node's Hub environment id: the id devices know it by. */
  readonly environmentId: () => Promise<string | null>;
  readonly isConnectorOnline: () => boolean;
  readonly readShell: () => Promise<{
    readonly sequence: number;
    readonly threads: ReadonlyArray<SidebarThreadOrStub>;
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
  const chunks: AttentionRecipient[][] = [];
  for (let index = 0; index < recipients.length; index += PUSH_ATTENTION_MAX_DELIVERIES) {
    chunks.push(recipients.slice(index, index + PUSH_ATTENTION_MAX_DELIVERIES));
  }
  return chunks;
}

/** Seals each recipient's payload, bound to this signal's sequence. */
export function sealAttentionDeliveries(input: {
  readonly environmentId: string;
  readonly sequence: number;
  readonly issuedAt: number;
  readonly recipients: ReadonlyArray<AttentionRecipient>;
}): ReadonlyArray<PushAttentionDelivery> {
  return input.recipients.map(({ registration, candidate }) => {
    const plaintext: PushAlertPlaintext = {
      v: 1,
      k: candidate.kind,
      t: truncateTitle(candidate.title),
      e: input.environmentId,
      th: candidate.ref.threadId,
      tu: candidate.turnId,
      q: input.sequence,
      at: input.issuedAt,
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

  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch((error: unknown) => {
      deps.reportFailure("Push alert work failed.", error);
    });
  };

  const baseline = async () => {
    const id = await deps.environmentId();
    if (stopped || id === null) return;
    environmentId = id as EnvironmentId;
    const shell = await deps.readShell();
    if (stopped) return;
    projector.baseline({
      environmentId,
      generation: GENERATION,
      sequence: shell.sequence,
      threads: shell.threads.map((thread) => ({ ...thread, environmentId: environmentId! })),
      nowMs: deps.now(),
    });
    baselined = true;
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
        continue;
      }
      const thread = await deps.readThread(environmentId, threadId);
      if (stopped) return;
      if (thread === null) continue;
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

  const sendWithRetry = async (signal: Omit<PushAttentionSignalInput, "proof">) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (stopped || !deps.isConnectorOnline()) {
        deps.setHubDelivery("offline");
        return;
      }
      const outcome = await deps.send(signal);
      if (outcome.kind === "delivered") {
        deps.setHubDelivery("available");
        const unauthorized = outcome.result.results
          .filter((result) => result.status === "not-authorized")
          .map((result) => result.enrollmentId as string);
        if (unauthorized.length > 0) await deps.removeEnrollments(unauthorized);
        return;
      }
      if (outcome.kind === "unsupported") {
        unsupportedUntil = deps.now() + ATTENTION_UNSUPPORTED_BACKOFF_MS;
        deps.setHubDelivery("hub-unsupported");
        return;
      }
      if (outcome.kind === "refused") return;
      if (attempt === 0) {
        await new Promise<void>((resolve) => {
          deps.setTimeout(resolve, ATTENTION_RETRY_DELAY_MS);
        });
      }
    }
    deps.reportFailure("A push alert signal could not reach the Hub; it was dropped.");
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
    for (const recipients of chunks) {
      if (stopped) return;
      const sequence = await deps.reserveSequence();
      const issuedAt = deps.now();
      await sendWithRetry({
        sequence,
        issuedAt,
        deliveries: sealAttentionDeliveries({ environmentId, sequence, issuedAt, recipients }),
      });
    }
  };

  enqueue(baseline);

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
      if (readTimer !== null) deps.clearTimeout(readTimer);
      if (flushTimer !== null) deps.clearTimeout(flushTimer);
      readTimer = null;
      flushTimer = null;
      dirty.clear();
      pending.clear();
      projector.reset();
      await chain;
    },
  };
}
