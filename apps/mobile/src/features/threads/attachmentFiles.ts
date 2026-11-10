import {
  readAttachmentBytesFromTransport,
  type AttachmentReadTransport,
} from "@ryco/client-runtime/rpc";
import { readAttachmentPreviewFromTransport } from "@ryco/client-runtime/rpc/attachmentPreviewRead";
import type {
  ChatAttachmentPreviewSize,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@ryco/contracts";
import { Directory, File, Paths } from "expo-file-system";

// A message attachment (an image, a PDF, any file) reaches the phone over its
// machine's own authorized connection, never a URL: a paired machine and a
// machine reached through the Hub each have their own connection, and no
// address the app could build reaches either with its credentials. The bytes
// are written once to a file in the app's cache folder, which the image view,
// the video player and the share sheet all read. The files are node-owned
// content, so they last for this run of the app only: evicted beyond a budget,
// removed when the machine's device data goes ("Clear device cache", forgetting
// the machine, signing out; registered in `runtime/bootstrap.ts`), and cleared
// at the next launch.

const ROOT_DIRECTORY = "attachment-files";
const MAX_ENTRIES = 160;
const MAX_BYTES = 160 * 1024 * 1024;

/** Images up to this size load as their row mounts; larger files wait for a tap. */
export const ATTACHMENT_FILE_AUTO_LOAD_MAX_BYTES = 12 * 1024 * 1024;

export interface AttachmentFileReference {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly attachmentId: string;
  readonly name: string;
  readonly sizeBytes: number;
  /**
   * The image's preview of this size instead of the original: what a thread
   * shows. A machine that makes no previews sends the original.
   */
  readonly preview?: ChatAttachmentPreviewSize | undefined;
}

interface StoredFile {
  readonly environmentId: EnvironmentId;
  readonly uri: string;
  readonly sizeBytes: number;
  readonly file: File;
}

// In use order, oldest first.
const stored = new Map<string, StoredFile>();
let storedBytes = 0;
let rootCleared = false;

export function attachmentFileKey(reference: AttachmentFileReference): string {
  return JSON.stringify([
    reference.environmentId,
    reference.threadId,
    reference.messageId,
    reference.attachmentId,
    ...(reference.preview === undefined ? [] : [reference.preview]),
  ]);
}

/** A path segment that is safe on every file system and never climbs out. */
export function attachmentFileSegment(value: string, fallback: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 120);
  return safe.length > 0 ? safe : fallback;
}

function deleteQuietly(entry: { readonly delete: () => void; readonly exists: boolean }) {
  try {
    if (entry.exists) entry.delete();
  } catch {
    // The next launch clears the folder.
  }
}

/**
 * The previous run's files go: at launch (`initializeMobileRuntime`), and at
 * the latest before this run writes its first.
 */
export function clearAttachmentFilesFromEarlierRuns(): void {
  clearRootOnce();
}

function clearRootOnce() {
  if (rootCleared) return;
  rootCleared = true;
  deleteQuietly(new Directory(Paths.cache, ROOT_DIRECTORY));
}

function forget(key: string) {
  const entry = stored.get(key);
  if (entry === undefined) return;
  stored.delete(key);
  storedBytes -= entry.sizeBytes;
  deleteQuietly(entry.file);
}

function evictOverBudget() {
  for (const key of stored.keys()) {
    if (stored.size <= MAX_ENTRIES && storedBytes <= MAX_BYTES) return;
    forget(key);
  }
}

/** The file of an attachment already read in this run, without touching it: for rendering. */
export function peekStoredAttachmentFile(key: string): string | undefined {
  return stored.get(key)?.uri;
}

/** The file of an attachment already read in this run, if it is still kept. */
export function readStoredAttachmentFile(key: string): string | undefined {
  const entry = stored.get(key);
  if (entry === undefined) return undefined;
  if (!entry.file.exists) {
    forget(key);
    return undefined;
  }
  // Most recently used last.
  stored.delete(key);
  stored.set(key, entry);
  return entry.uri;
}

function writeAttachmentFile(reference: AttachmentFileReference, bytes: Uint8Array): StoredFile {
  clearRootOnce();
  // One folder per attachment keeps the file's own name for the share sheet.
  const directory = new Directory(
    Paths.cache,
    ROOT_DIRECTORY,
    attachmentFileSegment(reference.environmentId, "environment"),
    attachmentFileSegment(reference.attachmentId, "attachment"),
    ...(reference.preview === undefined ? [] : [`preview-${reference.preview}`]),
  );
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, attachmentFileSegment(reference.name, "attachment"));
  file.write(bytes);
  return {
    environmentId: reference.environmentId,
    uri: file.uri,
    sizeBytes: bytes.byteLength,
    file,
  };
}

interface InflightRead {
  readonly controller: AbortController;
  readonly promise: Promise<string>;
  holders: number;
}

const inflight = new Map<string, InflightRead>();

export interface AttachmentFileLease {
  readonly promise: Promise<string>;
  /** The caller no longer needs the file. The read stops once no caller does. */
  readonly release: () => void;
}

/**
 * The attachment as a local file URL: kept from earlier in this run, or read
 * once over `currentTransport` for every caller asking while it is in flight.
 * The read stops once every caller has released it.
 */
export function acquireAttachmentFile(request: {
  readonly reference: AttachmentFileReference;
  /** The environment's authorized transport right now; undefined while disconnected. */
  readonly currentTransport: () => AttachmentReadTransport | undefined;
}): AttachmentFileLease {
  const { reference } = request;
  const key = attachmentFileKey(reference);
  const kept = readStoredAttachmentFile(key);
  if (kept !== undefined) return { promise: Promise.resolve(kept), release: () => undefined };
  let read = inflight.get(key);
  if (read === undefined) {
    const controller = new AbortController();
    const source = {
      reference: {
        threadId: reference.threadId,
        messageId: reference.messageId,
        attachmentId: reference.attachmentId,
      },
      sizeBytes: reference.sizeBytes,
      signal: controller.signal,
      currentTransport: request.currentTransport,
    };
    const bytesRead =
      reference.preview === undefined
        ? readAttachmentBytesFromTransport(source)
        : readAttachmentPreviewFromTransport({ ...source, size: reference.preview }).then(
            (preview) => {
              // Without `maxBytes` a preview read always answers.
              if (preview === null) throw new Error("Attachment preview unavailable.");
              return preview.bytes;
            },
          );
    const promise = bytesRead.then((bytes) => {
      if (controller.signal.aborted) throw new Error("Attachment load cancelled.");
      const entry = writeAttachmentFile(reference, bytes);
      forget(key);
      stored.set(key, entry);
      storedBytes += entry.sizeBytes;
      evictOverBudget();
      return entry.uri;
    });
    const started: InflightRead = { controller, promise, holders: 0 };
    const settle = () => {
      if (inflight.get(key) === started) inflight.delete(key);
    };
    // Also handles the rejection of a read nobody awaits anymore.
    promise.then(settle, settle);
    inflight.set(key, started);
    read = started;
  }
  const held = read;
  held.holders += 1;
  let released = false;
  return {
    promise: held.promise,
    release: () => {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders > 0) return;
      held.controller.abort();
      if (inflight.get(key) === held) inflight.delete(key);
    },
  };
}

/** Drops every kept file of one machine (its device data is going). */
export function purgeAttachmentFiles(environmentId: EnvironmentId): void {
  for (const [key, entry] of stored) {
    if (entry.environmentId === environmentId) forget(key);
  }
  for (const [key, read] of inflight) {
    if (key.startsWith(JSON.stringify([environmentId]).slice(0, -1))) {
      read.controller.abort();
      inflight.delete(key);
    }
  }
  deleteQuietly(
    new Directory(Paths.cache, ROOT_DIRECTORY, attachmentFileSegment(environmentId, "environment")),
  );
}

/** For tests: forget every kept file and read. */
export function resetAttachmentFilesForTests(): void {
  stored.clear();
  inflight.clear();
  storedBytes = 0;
  rootCleared = false;
}
