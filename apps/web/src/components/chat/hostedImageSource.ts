/**
 * Thread images read over a connection (on Hub web, where no URL reaches the
 * node). Loaded lazily by `useAttachmentSource`, so only a client that shows
 * images this way pays for it.
 *
 * - A thread shows an image's preview (`readAttachmentPreviewFromTransport`),
 *   the original only once the image is opened.
 * - What was read is kept for this session only: in memory, capped by bytes,
 *   dropped once its machine's state goes (sign-out, a machine leaving the
 *   account). Never the service worker, never disk. A thread scrolled back to,
 *   or opened again, shows its images without another read through the relay.
 *   The cache owns every URL it hands out and revokes it as it goes; an image
 *   already on screen keeps its pixels.
 */
import type {
  ChatAttachmentPreviewSize,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@ryco/contracts";
import { readAttachmentBytesFromTransport } from "@ryco/client-runtime/rpc";
import { readAttachmentPreviewFromTransport } from "@ryco/client-runtime/rpc/attachmentPreviewRead";
import { readEnvironmentApi } from "../../environmentApi";
import { useStore } from "../../store";
import { attachmentUrlPolicy } from "./attachmentPreview";

/** Sharp at an image's size in a thread on a 2x screen. */
const PREVIEW_SIZE: ChatAttachmentPreviewSize = 1024;
/** A preview larger than this (an older node sends the original) waits for a click. */
const AUTO_PREVIEW_MAX_BYTES = 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;

export interface HostedImageReference {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly attachmentId: string;
  readonly sizeBytes: number;
  readonly mimeType: string | undefined;
}

export interface HostedImageSource {
  readonly url: string;
  /** The original, not a preview. */
  readonly original: boolean;
}

interface Kept {
  readonly url: string;
  readonly bytes: number;
  readonly environmentId: EnvironmentId;
}

// In use order, oldest first.
const kept = new Map<string, Kept>();
let keptBytes = 0;
let unsubscribe: (() => void) | undefined;

function revoke(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function drop(key: string) {
  const entry = kept.get(key);
  if (entry === undefined) return;
  kept.delete(key);
  keptBytes -= entry.bytes;
  revoke(entry.url);
}

/** Forget every image read: for tests, and once no machine is left. */
export function clearHostedImageSources(): void {
  for (const key of Array.from(kept.keys())) drop(key);
  unsubscribe?.();
  unsubscribe = undefined;
}

function watchMachines() {
  if (unsubscribe) return;
  unsubscribe = useStore.subscribe((state, previous) => {
    if (state.environmentStateById === previous.environmentStateById) return;
    for (const [key, entry] of Array.from(kept)) {
      if (!(entry.environmentId in state.environmentStateById)) drop(key);
    }
  });
}

function keyOf(reference: HostedImageReference, original: boolean) {
  return JSON.stringify([
    reference.environmentId,
    reference.threadId,
    reference.messageId,
    reference.attachmentId,
    original ? 0 : PREVIEW_SIZE,
  ]);
}

function take(key: string): string | undefined {
  const entry = kept.get(key);
  if (entry === undefined) return undefined;
  kept.delete(key);
  kept.set(key, entry);
  return entry.url;
}

/** Keeps `url`, dropping the least recently used beyond the cap (an image is at most 10 MB). */
function keep(key: string, url: string, bytes: number, environmentId: EnvironmentId): void {
  drop(key);
  kept.set(key, { url, bytes, environmentId });
  keptBytes += bytes;
  for (const oldest of Array.from(kept.keys())) {
    if (keptBytes <= MAX_BYTES || oldest === key) break;
    drop(oldest);
  }
  watchMachines();
}

/** The kept original, else the kept preview, without a read. */
export function peekHostedImage(reference: HostedImageReference): HostedImageSource | undefined {
  const original = take(keyOf(reference, true));
  if (original !== undefined) return { url: original, original: true };
  const preview = take(keyOf(reference, false));
  return preview === undefined ? undefined : { url: preview, original: false };
}

/**
 * The image's original, or (`original` false) its preview: kept from earlier
 * this session, else read over its machine's connection. Undefined when the
 * preview would be too large to load without a click.
 */
export async function loadHostedImage(
  reference: HostedImageReference,
  original: boolean,
  signal: AbortSignal,
): Promise<HostedImageSource | undefined> {
  const known = peekHostedImage(reference);
  if (known && (known.original || !original)) return known;
  const common = {
    reference: {
      threadId: reference.threadId,
      messageId: reference.messageId,
      attachmentId: reference.attachmentId,
    },
    sizeBytes: reference.sizeBytes,
    signal,
    currentTransport: () => readEnvironmentApi(reference.environmentId)?.attachments,
  };
  let bytes: Uint8Array<ArrayBuffer>;
  let isOriginal = original;
  if (original) {
    bytes = await readAttachmentBytesFromTransport(common);
  } else {
    const preview = await readAttachmentPreviewFromTransport({
      ...common,
      size: PREVIEW_SIZE,
      maxBytes: AUTO_PREVIEW_MAX_BYTES,
    });
    if (preview === null) return undefined;
    bytes = preview.bytes;
    isOriginal = !preview.preview;
  }
  if (signal.aborted) return undefined;
  const policy = attachmentUrlPolicy({ mimeType: reference.mimeType, image: true });
  const blob = new Blob([bytes], { type: policy.type });
  const url =
    policy.scheme === "data"
      ? await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        })
      : URL.createObjectURL(blob);
  if (signal.aborted) {
    revoke(url);
    return undefined;
  }
  // An original sent for a preview is the original, and kept as one.
  keep(keyOf(reference, isOriginal), url, bytes.byteLength, reference.environmentId);
  return { url, original: isOriginal };
}
