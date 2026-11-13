import {
  composerTargetKey,
  type PersistedComposerImageAttachment,
} from "@ryco/client-runtime/state/composer";
import {
  deriveHeldSendUploadView,
  settleUploadHold,
  withoutHeldAttachment,
  type HeldSendUploadView,
  type QueuedMessageUploadHold,
} from "@ryco/client-runtime/state/message-queue";
import type { ScopedThreadRef } from "@ryco/contracts";
import { useMemo } from "react";

import {
  useComposerDraftStore,
  type ComposerImageAttachment,
  type DraftId,
} from "./composerDraftStore";
import { composerFileUploadEngine, useComposerFileUploadRecords } from "./composerFileUpload";
import { recoverHeldSend } from "./heldSendRecovery";
import { useMessageQueueStore, type WebQueuedMessage } from "./messageQueueStore";
import {
  HELD_SEND_HEARTBEAT_MS,
  heldSendTabId,
  readHeldSendRecords,
  selectOrphanedHeldSendRecords,
  updateHeldSendRecords,
  type HeldSendRecord,
} from "./heldSendRecords";

// ---------------------------------------------------------------------------
// Messages sent while their attachments were still uploading.
//
// Send accepts the message at once: it waits in its thread's queue (this
// tab's), in its place, with `uploadHold` listing the uploads it needs. This
// module applies each finished upload to it (the token it is sent with), and
// the queue's drain sends it, through the same readiness gate as any send,
// once nothing is left to wait for. A recovery record in local storage covers
// what memory cannot: after a reload or a closed tab the message comes back
// into its draft unless the thread already has it.
// ---------------------------------------------------------------------------

type ComposerThreadTarget = ScopedThreadRef | DraftId;

const EMPTY_ENTRIES: readonly WebQueuedMessage[] = [];

function uploadStatus(attachmentId: string) {
  return composerFileUploadEngine.get(attachmentId)?.status;
}

function attachmentRows(
  images: ReadonlyArray<ComposerImageAttachment>,
  draftRows: ReadonlyArray<PersistedComposerImageAttachment>,
): PersistedComposerImageAttachment[] {
  return images.flatMap((image): PersistedComposerImageAttachment[] => {
    if (image.type === "file") {
      const base = {
        type: "file" as const,
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
      };
      return [
        image.uploadToken !== undefined && image.expiresAt !== undefined
          ? { ...base, uploadToken: image.uploadToken, expiresAt: image.expiresAt }
          : { ...base, uploadState: "needsReattach" },
      ];
    }
    // An image comes back with the bytes its draft saved; one not saved yet stays out.
    const row = draftRows.find((candidate) => candidate.id === image.id);
    return row ? [row] : [];
  });
}

/**
 * Accepts a send whose attachments are still uploading: the message waits in the thread's
 * queue, after anything queued before it, and goes out unchanged once `awaiting` finished.
 * The caller clears the composer.
 */
export function holdSendForUploads(input: {
  readonly threadKey: string;
  readonly entry: WebQueuedMessage;
  readonly awaiting: ReadonlyArray<string>;
  readonly sentAs: QueuedMessageUploadHold["sentAs"];
  readonly draftTarget: ComposerThreadTarget;
}): void {
  const { entry } = input;
  const draftRows =
    useComposerDraftStore.getState().draftsByThreadKey[composerTargetKey(input.draftTarget)]
      ?.persistedAttachments ?? [];
  const record: HeldSendRecord = {
    messageId: entry.id,
    threadKey: input.threadKey,
    draftTarget:
      typeof input.draftTarget === "string"
        ? { kind: "draft", draftId: input.draftTarget }
        : { kind: "thread" },
    tabId: heldSendTabId(),
    heartbeatAt: Date.now(),
    prompt: entry.composer.promptForRestore ?? entry.composer.prompt,
    attachments: attachmentRows(entry.composer.images, draftRows),
    terminalContexts: entry.composer.sendableTerminalContexts,
    fileReferences: entry.composer.fileReferences ?? [],
  };
  // Written before the composer clears, so the draft's clean-up keeps the image bytes.
  updateHeldSendRecords((records) => [
    ...records.filter((candidate) => candidate.messageId !== entry.id),
    record,
  ]);
  useMessageQueueStore.getState().enqueue(input.threadKey, {
    ...entry,
    uploadHold: { awaiting: [...input.awaiting], sentAs: input.sentAs },
  });
  ensureHeldSendWatcher();
  scheduleSync();
}

/** Attachment ids the thread queues still carry: their uploads must not be released. */
export function collectQueuedAttachmentIds(): Set<string> {
  const ids = new Set<string>();
  for (const queue of Object.values(useMessageQueueStore.getState().queuesByThreadKey)) {
    for (const entry of queue) for (const image of entry.composer.images) ids.add(image.id);
  }
  return ids;
}

function referencedAttachmentIds(): Set<string> {
  const ids = collectQueuedAttachmentIds();
  for (const draft of Object.values(useComposerDraftStore.getState().draftsByThreadKey)) {
    for (const image of draft.images) ids.add(image.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// The watcher: uploads → entries, entries → recovery records.
// ---------------------------------------------------------------------------

interface KnownHeldEntry {
  readonly threadKey: string;
  readonly fileIds: ReadonlyArray<string>;
  /** What the record was last written from: the uploads still awaited and the tokens known. */
  readonly signature: string;
}

let watcherStarted = false;
let syncScheduled = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const known = new Map<string, KnownHeldEntry>();
/** Records this tab is settling after a reload; never adopted twice. */
const recovering = new Set<string>();

function scheduleSync(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  // Never inside a zustand listener: the update below would notify mid-update.
  queueMicrotask(sync);
}

function entrySignature(entry: WebQueuedMessage): string {
  return [
    ...(entry.uploadHold?.awaiting ?? []),
    "|",
    ...entry.composer.images.map((image) => `${image.id}:${image.uploadToken ?? ""}`),
  ].join(",");
}

function sync(): void {
  syncScheduled = false;
  const queueStore = useMessageQueueStore.getState();
  // 1. Finished uploads: the entry carries their tokens and stops waiting for them.
  for (const [threadKey, queue] of Object.entries(queueStore.queuesByThreadKey)) {
    for (const entry of queue) {
      if (!entry.uploadHold || entry.uploadHold.awaiting.length === 0) continue;
      queueStore.update(threadKey, entry.id, (current) => {
        if (!current.uploadHold) return current;
        const settled = settleUploadHold({
          hold: current.uploadHold,
          attachments: current.composer.images,
          statusOf: uploadStatus,
        });
        return settled
          ? {
              ...current,
              uploadHold: settled.hold,
              composer: { ...current.composer, images: settled.attachments },
            }
          : current;
      });
    }
  }
  // 2. The entries held now, against the ones known before.
  const live = new Map<string, { threadKey: string; entry: WebQueuedMessage }>();
  for (const [threadKey, queue] of Object.entries(
    useMessageQueueStore.getState().queuesByThreadKey,
  )) {
    for (const entry of queue) if (entry.uploadHold) live.set(entry.id, { threadKey, entry });
  }
  const gone = [...known.entries()].filter(([id]) => !live.has(id));
  const changed = [...live.entries()].filter(
    ([id, { entry }]) => known.get(id)?.signature !== entrySignature(entry),
  );
  if (gone.length > 0 || changed.length > 0) {
    const goneIds = new Set(gone.map(([id]) => id));
    updateHeldSendRecords((records) =>
      records.flatMap((record) => {
        if (goneIds.has(record.messageId)) return [];
        const update = changed.find(([id]) => id === record.messageId)?.[1].entry;
        if (!update) return [record];
        const tokens = new Map(
          update.composer.images.flatMap((image) =>
            image.uploadToken !== undefined && image.expiresAt !== undefined
              ? [[image.id, { uploadToken: image.uploadToken, expiresAt: image.expiresAt }]]
              : [],
          ),
        );
        const ids = new Set(update.composer.images.map((image) => image.id));
        return [
          {
            ...record,
            attachments: record.attachments.flatMap((row) => {
              if (!ids.has(row.id)) return [];
              const token = tokens.get(row.id);
              if (!token || row.type !== "file") return [row];
              const { uploadState: _uploadState, ...rest } = row;
              return [{ ...rest, ...token }];
            }),
          },
        ];
      }),
    );
  }
  // 3. Uploads of a message that left the queue (sent, cancelled) are no longer needed,
  // unless its files went back into a draft.
  if (gone.length > 0) {
    const referenced = referencedAttachmentIds();
    for (const [, entry] of gone) {
      for (const id of entry.fileIds) {
        if (!referenced.has(id)) composerFileUploadEngine.release(id);
      }
    }
  }
  for (const [id] of gone) known.delete(id);
  for (const [id, { threadKey, entry }] of live) {
    known.set(id, {
      threadKey,
      fileIds: entry.composer.images.filter((image) => image.type === "file").map((i) => i.id),
      signature: entrySignature(entry),
    });
  }
  syncHeartbeat();
}

function syncHeartbeat(): void {
  const needed = known.size > 0 || recovering.size > 0;
  if (needed && heartbeatTimer === null) {
    heartbeatTimer = setInterval(heartbeat, HELD_SEND_HEARTBEAT_MS);
  } else if (!needed && heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** Keeps this tab's records fresh, so no other tab takes them for a closed tab's. */
function heartbeat(): void {
  const tabId = heldSendTabId();
  const now = Date.now();
  updateHeldSendRecords((records) =>
    records.some((record) => record.tabId === tabId)
      ? records.map((record) => (record.tabId === tabId ? { ...record, heartbeatAt: now } : record))
      : records,
  );
  adoptOrphanedRecords();
}

/** Starts the watcher once; the queue's drain and every send that holds call it. */
export function ensureHeldSendWatcher(): void {
  if (watcherStarted || typeof window === "undefined") return;
  watcherStarted = true;
  composerFileUploadEngine.subscribe(scheduleSync);
  useMessageQueueStore.subscribe(scheduleSync);
  const adopt = () => adoptOrphanedRecords();
  if (useComposerDraftStore.persist.hasHydrated()) adopt();
  else useComposerDraftStore.persist.onFinishHydration(adopt);
}

// ---------------------------------------------------------------------------
// Recovery: a record whose message is no longer held by a live tab.
// ---------------------------------------------------------------------------

function heldEntryIds(): string[] {
  return Object.values(useMessageQueueStore.getState().queuesByThreadKey).flatMap((queue) =>
    queue.flatMap((entry) => (entry.uploadHold ? [entry.id] : [])),
  );
}

function adoptOrphanedRecords(): void {
  const tabId = heldSendTabId();
  const now = Date.now();
  const orphans = selectOrphanedHeldSendRecords({
    records: readHeldSendRecords(),
    tabId,
    // Held by this tab right now (even before the watcher first saw it), or being settled.
    liveIds: new Set([...heldEntryIds(), ...recovering]),
    nowMs: now,
  });
  if (orphans.length === 0) return;
  const adopted = new Set(orphans.map((record) => record.messageId));
  // Taken over first: this tab now keeps them fresh, and another tab leaves them alone.
  updateHeldSendRecords((records) =>
    records.map((record) =>
      adopted.has(record.messageId) ? { ...record, tabId, heartbeatAt: now } : record,
    ),
  );
  for (const id of adopted) recovering.add(id);
  syncHeartbeat();
  for (const record of orphans) {
    recoverHeldSend({ ...record, tabId, heartbeatAt: now }, () => {
      recovering.delete(record.messageId);
      syncHeartbeat();
    });
  }
}

// ---------------------------------------------------------------------------
// Actions on a held message.
// ---------------------------------------------------------------------------

function findEntry(threadKey: string, id: string): WebQueuedMessage | null {
  return (
    useMessageQueueStore
      .getState()
      .queuesByThreadKey[threadKey]?.find((entry) => entry.id === id) ?? null
  );
}

/** Uploads the failed file of a held message again. */
export function retryHeldUpload(attachmentId: string): void {
  composerFileUploadEngine.retry(attachmentId);
}

function hasContent(entry: WebQueuedMessage): boolean {
  return (
    entry.composer.trimmedPrompt.length > 0 ||
    entry.composer.images.length > 0 ||
    entry.composer.sendableTerminalContexts.length > 0 ||
    (entry.composer.fileReferences?.length ?? 0) > 0 ||
    entry.composer.sourceControlContexts.length > 0
  );
}

/**
 * Drops one file from a held message, which then goes out without it. A message left with
 * nothing to send is removed.
 */
export function removeHeldAttachment(threadKey: string, id: string, attachmentId: string): void {
  const store = useMessageQueueStore.getState();
  const entry = findEntry(threadKey, id);
  if (!entry?.uploadHold || entry.deliveryStatus === "sending") return;
  const removed = entry.composer.images.find((image) => image.id === attachmentId);
  if (removed?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(removed.previewUrl);
  const next = withoutHeldAttachment({
    hold: entry.uploadHold,
    attachments: entry.composer.images,
    attachmentId,
  });
  const updated: WebQueuedMessage = {
    ...entry,
    uploadHold: next.hold,
    composer: { ...entry.composer, images: next.attachments },
  };
  if (hasContent(updated)) store.update(threadKey, id, () => updated);
  else store.remove(threadKey, id);
  composerFileUploadEngine.release(attachmentId);
}

/**
 * Takes a held message out of the queue before it went out, for the caller to put back into the
 * composer. Null once it is being sent (or gone).
 */
export function takeHeldSend(threadKey: string, id: string): WebQueuedMessage | null {
  const entry = findEntry(threadKey, id);
  if (!entry?.uploadHold || entry.deliveryStatus === "sending") return null;
  return entry;
}

export interface HeldSendView {
  readonly entry: WebQueuedMessage;
  readonly hold: QueuedMessageUploadHold;
  readonly uploads: HeldSendUploadView;
}

/** The thread's held messages with their uploads, for the timeline and the queue. */
export function useHeldSends(threadKey: string | null): ReadonlyMap<string, HeldSendView> {
  const records = useComposerFileUploadRecords();
  const queue = useMessageQueueStore((store) =>
    threadKey ? (store.queuesByThreadKey[threadKey] ?? EMPTY_ENTRIES) : EMPTY_ENTRIES,
  );
  return useMemo(() => {
    const views = new Map<string, HeldSendView>();
    for (const entry of queue) {
      if (!entry.uploadHold) continue;
      views.set(entry.id, {
        entry,
        hold: entry.uploadHold,
        uploads: deriveHeldSendUploadView({
          hold: entry.uploadHold,
          attachments: entry.composer.images,
          statusOf: (attachmentId) => records.get(attachmentId)?.status,
        }),
      });
    }
    return views;
  }, [queue, records]);
}
