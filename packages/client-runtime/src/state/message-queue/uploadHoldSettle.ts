import type { ChatFileUploadStatus } from "../composer/attachmentUpload.ts";

import type { QueuedMessageUploadHold } from "./uploadHold.ts";

/** One attachment of a held message, as its upload stands. */
export type HeldAttachmentUpload =
  | {
      readonly id: string;
      readonly name: string;
      readonly kind: "uploading";
      readonly progress: number | null;
    }
  | {
      readonly id: string;
      readonly name: string;
      readonly kind: "failed";
      readonly message: string;
      /** False for a file that must be attached again (its bytes are gone). */
      readonly retryable: boolean;
    };

/** What the held message shows: its uploads still running, and the ones that failed. */
export interface HeldSendUploadView {
  readonly uploads: ReadonlyArray<HeldAttachmentUpload>;
  /** True when at least one upload failed: the message waits for the user. */
  readonly failed: boolean;
}

/**
 * The held message's uploads as its row shows them. A record that is gone (released, or lost
 * with a reload) reads as a file that must be attached again: the message cannot go out with it.
 */
export function deriveHeldSendUploadView(input: {
  readonly hold: QueuedMessageUploadHold;
  readonly attachments: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly statusOf: (attachmentId: string) => ChatFileUploadStatus | undefined;
}): HeldSendUploadView {
  const uploads: HeldAttachmentUpload[] = [];
  let failed = false;
  for (const id of input.hold.awaiting) {
    const name = input.attachments.find((attachment) => attachment.id === id)?.name ?? "file";
    const status = input.statusOf(id);
    if (status === undefined || status.kind === "needsReattach") {
      failed = true;
      uploads.push({
        id,
        name,
        kind: "failed",
        message: status?.message ?? "The file is no longer available. Attach it again.",
        retryable: false,
      });
    } else if (status.kind === "failed") {
      failed = true;
      uploads.push({
        id,
        name,
        kind: "failed",
        message: status.label ?? status.message,
        retryable: status.retryable,
      });
    } else if (status.kind === "pending" || status.kind === "uploading") {
      uploads.push({
        id,
        name,
        kind: "uploading",
        progress: status.kind === "uploading" ? status.progress : null,
      });
    }
  }
  return { uploads, failed };
}

/** An attachment as a held entry carries it: a streamed file gets its token once uploaded. */
export interface UploadHeldAttachment {
  readonly id: string;
  readonly uploadToken?: string | undefined;
  readonly expiresAt?: string | undefined;
}

/**
 * The entry's attachments and hold once the uploads that finished are applied: each finished
 * file carries its upload token (so the send dispatches it by token) and leaves `awaiting`.
 * Null when nothing changed. The hold itself stays (with `awaiting` empty) until the message
 * went out, so later sends keep waiting behind it.
 */
export function settleUploadHold<A extends UploadHeldAttachment>(input: {
  readonly hold: QueuedMessageUploadHold;
  readonly attachments: ReadonlyArray<A>;
  readonly statusOf: (attachmentId: string) => ChatFileUploadStatus | undefined;
}): { readonly attachments: A[]; readonly hold: QueuedMessageUploadHold } | null {
  const finished = new Map<string, { uploadToken: string; expiresAt: string }>();
  for (const id of input.hold.awaiting) {
    const status = input.statusOf(id);
    if (status?.kind === "uploaded") {
      finished.set(id, { uploadToken: status.uploadToken, expiresAt: status.expiresAt });
    }
  }
  // An attachment the user removed from the held message no longer holds it.
  const present = new Set(input.attachments.map((attachment) => attachment.id));
  const awaiting = input.hold.awaiting.filter((id) => present.has(id) && !finished.has(id));
  if (finished.size === 0 && awaiting.length === input.hold.awaiting.length) return null;
  return {
    attachments: input.attachments.map((attachment) => {
      const token = finished.get(attachment.id);
      return token ? { ...attachment, ...token } : attachment;
    }),
    hold: { ...input.hold, awaiting },
  };
}

/** The held entry without one attachment ("Remove file and send"). */
export function withoutHeldAttachment<A extends { readonly id: string }>(input: {
  readonly hold: QueuedMessageUploadHold;
  readonly attachments: ReadonlyArray<A>;
  readonly attachmentId: string;
}): { readonly attachments: A[]; readonly hold: QueuedMessageUploadHold } {
  return {
    attachments: input.attachments.filter((attachment) => attachment.id !== input.attachmentId),
    hold: {
      ...input.hold,
      awaiting: input.hold.awaiting.filter((id) => id !== input.attachmentId),
    },
  };
}

/**
 * After a reload (or a closed tab), what becomes of a message that was waiting for its uploads:
 * `sent` when the thread already has it (sent, or queued on the node), `restore` when it never
 * went out (it goes back into the thread's draft), `load-detail` when the thread's messages must
 * be read first, `wait` while the environment is not live. Decided once, so a message ends up
 * either sent once or back in the draft.
 */
export type HeldSendRecoveryDecision = "wait" | "load-detail" | "sent" | "restore";

export function resolveHeldSendRecovery(input: {
  readonly messageId: string;
  /** A live shell snapshot of the thread's environment is applied. */
  readonly shellLive: boolean;
  /** The thread as its shell lists it; null when the shell has no such thread. */
  readonly view: {
    readonly detailLoaded: boolean;
    readonly projectedMessageIds: ReadonlySet<string>;
  } | null;
  /** Message ids of the node's follow-up queue for the thread. */
  readonly serverQueueMessageIds: ReadonlySet<string>;
}): HeldSendRecoveryDecision {
  if (!input.shellLive) return "wait";
  // A draft's first message that never created its thread.
  if (input.view === null) return "restore";
  if (input.serverQueueMessageIds.has(input.messageId)) return "sent";
  if (!input.view.detailLoaded) return "load-detail";
  return input.view.projectedMessageIds.has(input.messageId) ? "sent" : "restore";
}
