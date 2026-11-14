import type { PersistedComposerImageAttachment } from "@ryco/client-runtime/state/composer";

import { appLocalStorage } from "./hooks/useLocalStorage";

// ---------------------------------------------------------------------------
// Recovery records for messages sent while their attachments uploaded
// (`heldSends.ts`). The message itself waits in this tab's queue, in memory;
// this record is what a reload, a closed tab or a crash leaves behind, so the
// message comes back into its draft unless it already went out. Text and
// attachment rows only: bytes stay where the draft keeps them (IndexedDB), and
// a file whose upload had not finished comes back as "attach again".
// Hosted Hub builds keep the record in this window's memory (`appLocalStorage`):
// it holds prompt text, which must not reach the browser's localStorage there.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "ryco:held-sends:v1";
/** This tab's id, kept across its reloads (session storage is per tab). */
const TAB_ID_KEY = "ryco:held-sends:tab";
/** A record whose tab has not written for this long belongs to a tab that is gone. */
export const HELD_SEND_STALE_MS = 30_000;
export const HELD_SEND_HEARTBEAT_MS = 10_000;

export type HeldSendDraftTarget =
  | { readonly kind: "thread" }
  | { readonly kind: "draft"; readonly draftId: string };

export interface HeldSendRecord {
  readonly messageId: string;
  /** The scoped thread key the message is queued under. */
  readonly threadKey: string;
  /** Where it goes back: the thread's own draft, or the new-thread draft it was the first send of. */
  readonly draftTarget: HeldSendDraftTarget;
  readonly tabId: string;
  readonly heartbeatAt: number;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<PersistedComposerImageAttachment>;
  /** `TerminalContextDraft`s and `ComposerReferenceDraft`s as JSON; decoded when restored. */
  readonly terminalContexts: ReadonlyArray<unknown>;
  readonly fileReferences: ReadonlyArray<unknown>;
}

function storage(): Storage | null {
  return typeof window === "undefined" ? null : appLocalStorage;
}

let cachedTabId: string | null = null;

/** This tab's id: the same after a reload of the tab, new for every other tab. */
export function heldSendTabId(): string {
  if (cachedTabId !== null) return cachedTabId;
  let id: string | null = null;
  try {
    id = window.sessionStorage.getItem(TAB_ID_KEY);
    if (id === null) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem(TAB_ID_KEY, id);
    }
  } catch {
    id ??= `tab-${Math.random().toString(36).slice(2)}`;
  }
  cachedTabId = id;
  return id;
}

function isRecord(value: unknown): value is HeldSendRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.messageId === "string" &&
    typeof record.threadKey === "string" &&
    typeof record.tabId === "string" &&
    typeof record.heartbeatAt === "number" &&
    typeof record.prompt === "string" &&
    Array.isArray(record.attachments) &&
    Array.isArray(record.terminalContexts) &&
    Array.isArray(record.fileReferences) &&
    typeof record.draftTarget === "object" &&
    record.draftTarget !== null
  );
}

export function readHeldSendRecords(): HeldSendRecord[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function writeHeldSendRecords(records: ReadonlyArray<HeldSendRecord>): void {
  const store = storage();
  if (!store) return;
  try {
    if (records.length === 0) store.removeItem(STORAGE_KEY);
    else store.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch (error) {
    console.warn("A message waiting for its uploads could not be saved for a reload.", error);
  }
}

/** Applies `change` to the stored records (a read-modify-write of the one entry). */
export function updateHeldSendRecords(
  change: (records: HeldSendRecord[]) => HeldSendRecord[],
): void {
  const before = readHeldSendRecords();
  const after = change(before);
  if (after !== before) writeHeldSendRecords(after);
}

/**
 * Attachment ids the records still need: their bytes must survive the draft clean-up
 * (`collectComposerAttachmentBytes`) until the record is settled.
 */
export function readHeldSendAttachmentIds(): string[] {
  return readHeldSendRecords().flatMap((record) =>
    record.attachments.map((attachment) => attachment.id),
  );
}

/**
 * The records left by a tab that is gone: this tab before its reload, or another tab that
 * stopped writing (closed, crashed). `liveIds` are messages this tab still holds.
 */
export function selectOrphanedHeldSendRecords(input: {
  readonly records: ReadonlyArray<HeldSendRecord>;
  readonly tabId: string;
  readonly liveIds: ReadonlySet<string>;
  readonly nowMs: number;
}): HeldSendRecord[] {
  return input.records.filter(
    (record) =>
      !input.liveIds.has(record.messageId) &&
      (record.tabId === input.tabId || input.nowMs - record.heartbeatAt > HELD_SEND_STALE_MS),
  );
}
