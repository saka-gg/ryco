// Routes window captures from the macOS desktop app into a composer draft.
//
// Captures reach the renderer two ways: the attachment menu's window picker
// captures for the composer it was opened from, and the global shortcut
// pushes captures for whichever composer is focused. Both go through the
// composer's own attachment path, so a remote or hosted node receives a normal
// image attachment.
//
// The desktop app keeps every capture pending (bounded and journaled on disk)
// until the renderer acknowledges it. A capture is acknowledged only once a
// draft has saved it, it stayed out of every draft for a while (sent or
// removed), its draft already held an identical image, or the composer refused
// it (and said why). Otherwise it stays pending and is delivered when a
// composer registers, including after a reload.

import type {
  DesktopAppSnapCapture,
  DesktopBridge,
  DesktopWindowCapturePendingEntry,
  ScopedThreadRef,
} from "@ryco/contracts";

import { toastManager } from "./components/ui/toast";
import {
  composerDraftImageDedupKey,
  type ComposerDraftStoreState,
  type ComposerThreadDraftState,
  type DraftId,
  hasVerifiedPersistedAttachment,
  useComposerDraftStore,
} from "./composerDraftStore";

type WindowCaptureBridge = NonNullable<DesktopBridge["windowCapture"]>;

/** How a composer answered a capture: kept, refused with its own notice, or not ready. */
export type WindowCaptureAttachResult = "attached" | "rejected" | "unavailable";

export interface WindowCaptureSink {
  /** The draft the composer edits. */
  readonly target: ScopedThreadRef | DraftId;
  /**
   * Whether it can take attachments now. A focused composer that cannot (no
   * chat open yet) still registers, so shortcut captures wait for it instead
   * of reaching another pane's chat.
   */
  readonly available: boolean;
  /** Adds the capture through the composer's attachment path under the given id. */
  attach(input: {
    readonly attachmentId: string;
    readonly file: File;
  }): Promise<WindowCaptureAttachResult>;
  /** Puts the caret back in the composer so the user can write about the capture. */
  focus?(): void;
}

/** A capture to deliver; pending ones read their bytes only once they are needed. */
interface CaptureDelivery {
  readonly id: string;
  load(): Promise<DesktopAppSnapCapture | null>;
}

/** Where a capture's attachment is: saved by a draft, only in memory, or in no draft. */
type DraftHold = "saved" | "unsaved" | "absent";

/** A landed capture still pending until its draft saves it or it leaves every draft. */
interface WatchedCapture {
  readonly bridge: WindowCaptureBridge;
  readonly captureId: string;
  /** Runs while the attachment is in no draft; acknowledges it if it stays out. */
  exitTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_FILE_NAME_STEM = 120;
/**
 * How long a landed attachment must stay out of every draft before it counts
 * as sent or removed. A send clears the draft before the dispatch and puts
 * the attachments back if it fails, and a draft can move to a new key in
 * steps; a capture back in time keeps its watch.
 */
const DRAFT_EXIT_SETTLE_MS = 5_000;

const sinks: WindowCaptureSink[] = [];
const inFlightCaptureIds = new Set<string>();
let deliveryQueue: Promise<void> = Promise.resolve();
let subscribedBridge: WindowCaptureBridge | null = null;
// Attachments that landed in a draft this session. One that is in no draft
// any more was sent or removed, so its capture must not be attached again.
const landedAttachmentIds = new Set<string>();
const watchedCaptures = new Map<string, WatchedCapture>();
let stopWatchingDrafts: (() => void) | null = null;

function readBridge(): WindowCaptureBridge | null {
  return typeof window === "undefined" ? null : (window.desktopBridge?.windowCapture ?? null);
}

/**
 * Derived from the capture id, so a capture delivered again (after a reload,
 * or by a picker and a pending drain at once) is recognized in any draft.
 */
export function windowCaptureAttachmentId(captureId: string): string {
  return `capture-${captureId.replace(/[^a-z0-9_-]/gi, "").slice(0, 96)}`;
}

function cleanNamePart(value: string | null): string {
  return (value ?? "")
    .replace(/[/\\\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "App - Window title.png": the agent sees which window the image shows. */
export function windowCaptureFileName(
  capture: Pick<DesktopAppSnapCapture, "sourceAppName" | "sourceWindowTitle">,
): string {
  const appName = cleanNamePart(capture.sourceAppName);
  const title = cleanNamePart(capture.sourceWindowTitle);
  const parts = title && title !== appName ? [appName, title].filter(Boolean) : [appName];
  const stem = parts.filter(Boolean).join(" - ") || "Window";
  return `${stem.slice(0, MAX_FILE_NAME_STEM).trim()}.png`;
}

export function windowCaptureFile(capture: DesktopAppSnapCapture): File {
  const capturedAt = Date.parse(capture.capturedAt);
  return new File([new Uint8Array(capture.bytes)], windowCaptureFileName(capture), {
    type: capture.mimeType,
    lastModified: Number.isFinite(capturedAt) ? capturedAt : Date.now(),
  });
}

/** Strips Electron's invoke wrapper so the main-process message reads plainly. */
export function windowCaptureErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u, "").trim() ||
    "Window capture failed."
  );
}

function draftHasAttachment(
  draft: ComposerThreadDraftState | undefined,
  attachmentId: string,
): boolean {
  return (
    draft !== undefined &&
    (draft.images.some((image) => image.id === attachmentId) ||
      draft.persistedAttachments.some((attachment) => attachment.id === attachmentId))
  );
}

/**
 * Only a save the draft store read back counts (bytes in IndexedDB, the draft
 * record written): drafts that are not durable (hosted) never hold one, so
 * their captures wait until they leave the draft.
 */
function draftHold(attachmentId: string): DraftHold {
  let unsaved = false;
  for (const draft of Object.values(useComposerDraftStore.getState().draftsByThreadKey)) {
    if (hasVerifiedPersistedAttachment(draft, attachmentId)) return "saved";
    if (draftHasAttachment(draft, attachmentId)) unsaved = true;
  }
  return unsaved ? "unsaved" : "absent";
}

/**
 * Whether the draft holds an image the store treats as this file (same type,
 * size and name), e.g. the same unchanged window captured twice: the store
 * keeps that copy and drops this one without saying so.
 */
function draftHoldsIdenticalImage(target: ScopedThreadRef | DraftId, file: File): boolean {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  if (!draft) return false;
  const key = composerDraftImageDedupKey({
    mimeType: file.type,
    sizeBytes: file.size,
    name: file.name,
  });
  return draft.images.some((image) => composerDraftImageDedupKey(image) === key);
}

async function acknowledge(bridge: WindowCaptureBridge, captureId: string): Promise<void> {
  await bridge.acknowledgeCapture(captureId).catch(() => undefined);
}

function clearExitTimer(watched: WatchedCapture): void {
  if (watched.exitTimer) clearTimeout(watched.exitTimer);
  watched.exitTimer = null;
}

function releaseWatchedCapture(attachmentId: string, watched: WatchedCapture): void {
  clearExitTimer(watched);
  watchedCaptures.delete(attachmentId);
  void acknowledge(watched.bridge, watched.captureId);
}

function stopWatchingWhenIdle(): void {
  if (watchedCaptures.size > 0) return;
  stopWatchingDrafts?.();
  stopWatchingDrafts = null;
}

/**
 * Acknowledges a watched capture once its draft saved it, or once it stayed
 * out of every draft for the settle window (sent or removed).
 */
function settleWatchedCapture(attachmentId: string, watched: WatchedCapture): void {
  const hold = draftHold(attachmentId);
  if (hold === "saved") {
    releaseWatchedCapture(attachmentId, watched);
  } else if (hold === "unsaved") {
    clearExitTimer(watched);
  } else {
    watched.exitTimer ??= setTimeout(() => {
      watched.exitTimer = null;
      if (watchedCaptures.get(attachmentId) !== watched) return;
      if (draftHold(attachmentId) === "absent") releaseWatchedCapture(attachmentId, watched);
      stopWatchingWhenIdle();
    }, DRAFT_EXIT_SETTLE_MS);
  }
}

/** A prompt edit keeps a draft's attachment lists, so typing changes nothing here. */
function draftAttachmentsChanged(
  previous: ComposerThreadDraftState | undefined,
  next: ComposerThreadDraftState | undefined,
): boolean {
  return (
    previous?.images !== next?.images ||
    previous?.persistedAttachments !== next?.persistedAttachments ||
    previous?.persistedAttachmentsUnverified !== next?.persistedAttachmentsUnverified
  );
}

/**
 * Settles the watched captures a draft-store change can move: only drafts whose
 * attachments changed are read, and only for the captures they hold or held.
 * One subscription serves every watched capture and ends with the last.
 */
function settleChangedDrafts(
  state: ComposerDraftStoreState,
  previous: ComposerDraftStoreState,
): void {
  const drafts = state.draftsByThreadKey;
  const before = previous.draftsByThreadKey;
  if (drafts === before) return;
  const affected = new Set<string>();
  const check = (threadKey: string) => {
    const next = drafts[threadKey];
    const prior = before[threadKey];
    if (next === prior || !draftAttachmentsChanged(prior, next)) return;
    for (const attachmentId of watchedCaptures.keys()) {
      if (draftHasAttachment(prior, attachmentId) || draftHasAttachment(next, attachmentId)) {
        affected.add(attachmentId);
      }
    }
  };
  for (const threadKey of Object.keys(drafts)) check(threadKey);
  for (const threadKey of Object.keys(before)) {
    if (!Object.hasOwn(drafts, threadKey)) check(threadKey);
  }
  for (const attachmentId of affected) {
    const watched = watchedCaptures.get(attachmentId);
    if (watched) settleWatchedCapture(attachmentId, watched);
  }
  stopWatchingWhenIdle();
}

function watchCapture(bridge: WindowCaptureBridge, captureId: string, attachmentId: string): void {
  let watched = watchedCaptures.get(attachmentId);
  if (!watched) {
    watched = { bridge, captureId, exitTimer: null };
    watchedCaptures.set(attachmentId, watched);
  }
  stopWatchingDrafts ??= useComposerDraftStore.subscribe(settleChangedDrafts);
  settleWatchedCapture(attachmentId, watched);
  stopWatchingWhenIdle();
}

function focusedSink(): WindowCaptureSink | null {
  return sinks.at(-1) ?? null;
}

/** A live capture stays pending; the description says where it goes. */
function notifyCapturePending(description: string): void {
  toastManager.add({ type: "info", title: "Window captured", description });
}

async function deliver(
  bridge: WindowCaptureBridge,
  delivery: CaptureDelivery,
  preferredSink: WindowCaptureSink | null,
  live: boolean,
): Promise<void> {
  const attachmentId = windowCaptureAttachmentId(delivery.id);
  // Its watch settles it: once its draft saves it, or once it stays out of every draft.
  if (watchedCaptures.has(attachmentId)) return;
  const hold = draftHold(attachmentId);
  if (hold === "saved" || (hold === "absent" && landedAttachmentIds.has(attachmentId))) {
    // A draft saved it already, or it was sent or removed; the acknowledgement may have been lost.
    await acknowledge(bridge, delivery.id);
    return;
  }
  // Only in a draft's memory, e.g. put back by a failed send: watch it, never attach it twice.
  if (hold === "unsaved") {
    landedAttachmentIds.add(attachmentId);
    watchCapture(bridge, delivery.id, attachmentId);
    return;
  }
  const sink = preferredSink && sinks.includes(preferredSink) ? preferredSink : focusedSink();
  // Without a composer that can take it, e.g. the focused one has no chat
  // open, the capture stays pending until one registers.
  if (!sink?.available) {
    if (live) notifyCapturePending("Open a chat to attach it.");
    return;
  }
  const capture = await delivery.load();
  // Acknowledged elsewhere in the meantime.
  if (!capture) return;
  let file: File;
  let result: WindowCaptureAttachResult;
  try {
    file = windowCaptureFile(capture);
    result = await sink.attach({ attachmentId, file });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Couldn't add the capture",
      description: windowCaptureErrorMessage(error),
    });
    return;
  }
  // A refused capture is dropped like a refused paste; the composer said why.
  if (result === "rejected") {
    await acknowledge(bridge, delivery.id);
    return;
  }
  // The composer may report success while its draft did not take the image.
  if (result === "attached" && draftHold(attachmentId) !== "absent") {
    landedAttachmentIds.add(attachmentId);
    if (live) sink.focus?.();
    watchCapture(bridge, delivery.id, attachmentId);
    return;
  }
  // Its draft kept an identical image instead, so nothing is left to deliver.
  // Counted as landed: a lost acknowledgement must not attach it elsewhere later.
  if (result === "attached" && draftHoldsIdenticalImage(sink.target, file)) {
    landedAttachmentIds.add(attachmentId);
    if (live) sink.focus?.();
    await acknowledge(bridge, delivery.id);
    return;
  }
  // Not ready, or its draft dropped it: it stays pending, and the next
  // composer that registers (another chat, this one once it can take
  // attachments, a reload) attaches it.
  if (live) {
    notifyCapturePending(
      "This chat couldn't take it. It's kept and added the next time you open a chat.",
    );
  }
}

/** Captures attach one at a time, in arrival order, each at most once at a time. */
function enqueue(
  bridge: WindowCaptureBridge,
  delivery: CaptureDelivery,
  sink: WindowCaptureSink | null,
  live: boolean,
): Promise<void> {
  if (inFlightCaptureIds.has(delivery.id)) return deliveryQueue;
  inFlightCaptureIds.add(delivery.id);
  deliveryQueue = deliveryQueue
    .then(() => deliver(bridge, delivery, sink, live))
    .catch(() => undefined)
    .finally(() => {
      inFlightCaptureIds.delete(delivery.id);
    });
  return deliveryQueue;
}

function liveDelivery(capture: DesktopAppSnapCapture): CaptureDelivery {
  return { id: capture.id, load: async () => capture };
}

async function drainPendingCaptures(
  bridge: WindowCaptureBridge,
  sink: WindowCaptureSink,
): Promise<void> {
  // Metadata only; each capture's bytes cross IPC once it is going to attach.
  let pending: readonly DesktopWindowCapturePendingEntry[];
  try {
    pending = await bridge.listPendingCaptures();
  } catch {
    return;
  }
  for (const entry of pending) {
    if (focusedSink() !== sink) return;
    void enqueue(
      bridge,
      { id: entry.id, load: () => bridge.readPendingCapture(entry.id).catch(() => null) },
      sink,
      false,
    );
  }
}

function subscribe(bridge: WindowCaptureBridge): void {
  if (subscribedBridge === bridge) return;
  subscribedBridge = bridge;
  bridge.onCaptured((capture) => {
    void enqueue(bridge, liveDelivery(capture), null, true);
  });
  bridge.onError((error) => {
    toastManager.add({
      type: "error",
      title: "Window capture failed",
      description: error.message,
    });
  });
}

/**
 * The focused composer registers itself; the latest registration receives
 * shortcut captures, and keeps them pending while it is not available.
 * Registering an available one also delivers captures still pending, so one a
 * composer could not take arrives again.
 */
export function registerWindowCaptureSink(sink: WindowCaptureSink): () => void {
  const bridge = readBridge();
  if (!bridge) return () => undefined;
  subscribe(bridge);
  sinks.push(sink);
  if (sink.available) void drainPendingCaptures(bridge, sink);
  return () => {
    const index = sinks.lastIndexOf(sink);
    if (index >= 0) sinks.splice(index, 1);
  };
}

/** Captures one window from the picker into the composer that opened it. */
export async function captureWindowIntoComposer(
  windowId: number,
  sink: WindowCaptureSink,
): Promise<void> {
  const bridge = readBridge();
  if (!bridge) return;
  subscribe(bridge);
  let capture: DesktopAppSnapCapture;
  try {
    capture = await bridge.captureWindow(windowId);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Couldn't capture the window",
      description: windowCaptureErrorMessage(error),
    });
    return;
  }
  await enqueue(bridge, liveDelivery(capture), sink, true);
}

export function resetWindowCaptureIntakeForTests(): void {
  sinks.length = 0;
  inFlightCaptureIds.clear();
  deliveryQueue = Promise.resolve();
  subscribedBridge = null;
  landedAttachmentIds.clear();
  for (const watched of watchedCaptures.values()) clearExitTimer(watched);
  watchedCaptures.clear();
  stopWatchingDrafts?.();
  stopWatchingDrafts = null;
}
