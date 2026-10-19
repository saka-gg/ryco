import type { LocalTaskWriter } from "@ryco/client-runtime/state/tasks";
import { resolveFileUploadMaxBytes } from "@ryco/client-runtime/state/composer";
import type { EnvironmentId, LocalTaskFile } from "@ryco/contracts";
import { create } from "zustand";

import { readPrimaryEnvironmentDescriptor } from "~/environments/primary";
import { getEnvironmentHttpBaseUrl, useSavedEnvironmentRuntimeStore } from "~/environments/runtime";
import { randomUUID } from "~/lib/utils";
import { webChatFileUploadTransport } from "~/platform/attachmentUpload";

import { toastManager } from "../ui/toast";
import {
  planTaskFileAdds,
  TASK_FILE_INLINE_MAX_BYTES,
  type TaskFileCandidate,
} from "./taskFiles.logic";
import type { TaskFileView } from "./tasksViewModel";

/**
 * Adding files to a task, the composer's way: bytes stream to the node's
 * upload endpoint when it advertises `fileAttachments` and this client can
 * reach it over HTTP (`createLocalTaskFileUpload` → transfer → add), and go
 * inline as a data URL otherwise (the hosted relay). The limits are a chat
 * message's (and, inline, what fits one relay message), checked here before
 * anything is read.
 */

/** A file on its way to a task; it shows as a chip until the task holds it. */
export interface PendingTaskFile {
  /** `upload:<uuid>`, never a stored file id (those have no colon). */
  readonly key: string;
  readonly taskId: string;
  readonly name: string;
  readonly type: "image" | "file";
  readonly sizeBytes: number;
  /** 0..1. */
  readonly progress: number;
  readonly error: string | null;
}

interface TaskFileUploadsState {
  readonly byTask: Readonly<Record<string, ReadonlyArray<PendingTaskFile>>>;
}

/** Files on their way, by task. Memory only, like the bytes they stand for. */
export const useTaskFileUploadsStore = create<TaskFileUploadsState>(() => ({ byTask: {} }));

/** Cancels a file on its way, by chip key, until its add has settled. */
const controllers = new Map<string, AbortController>();
/** Each task's files on their way, until their adds settle; a start waits for them. */
const sending = new Map<string, Set<Promise<void>>>();

function trackSending(taskId: string, sent: Promise<void>): void {
  let files = sending.get(taskId);
  if (!files) {
    files = new Set();
    sending.set(taskId, files);
  }
  const tracked = files;
  tracked.add(sent);
  void sent.finally(() => {
    tracked.delete(sent);
    if (tracked.size === 0 && sending.get(taskId) === tracked) sending.delete(taskId);
  });
}

/**
 * Resolves once every file on its way to the task when called has landed on
 * it, failed or been cancelled. A chat started from the task carries the
 * files the task holds, so its start waits for this first.
 */
export function whenTaskFilesSent(taskId: string): Promise<void> {
  const files = sending.get(taskId);
  return files ? Promise.all(files).then(() => undefined) : Promise.resolve();
}

function updatePending(
  taskId: string,
  key: string,
  update: (file: PendingTaskFile) => PendingTaskFile | null,
): void {
  useTaskFileUploadsStore.setState((state) => {
    const files = state.byTask[taskId];
    if (!files?.some((file) => file.key === key)) return state;
    const next = files.flatMap((file) => {
      if (file.key !== key) return [file];
      const updated = update(file);
      return updated ? [updated] : [];
    });
    const byTask = { ...state.byTask };
    if (next.length > 0) byTask[taskId] = next;
    else delete byTask[taskId];
    return { byTask };
  });
}

function dropPending(taskId: string, key: string): void {
  controllers.delete(key);
  updatePending(taskId, key, () => null);
}

/** The node's streaming upload limit, when this client can stream to it. */
function readStreamingMaxBytes(environmentId: EnvironmentId): number | null {
  if (getEnvironmentHttpBaseUrl(environmentId) === null) return null;
  const primary = readPrimaryEnvironmentDescriptor();
  const descriptor =
    primary?.environmentId === environmentId
      ? primary
      : (useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor ?? null);
  return resolveFileUploadMaxBytes(descriptor?.capabilities);
}

/** An image's size, when the browser can read it without much work. */
async function readImageSize(
  file: File,
): Promise<{ readonly width: number; readonly height: number } | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

function readDataUrl(file: File, signal: AbortSignal): Promise<string> {
  // An abort listener added to a signal already aborted never fires.
  if (signal.aborted) return Promise.reject(new Error("The upload was cancelled."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    signal.addEventListener("abort", abort, { once: true });
    reader.addEventListener("loadend", () => signal.removeEventListener("abort", abort));
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(new Error("The file could not be read.")));
    reader.addEventListener("abort", () => reject(new Error("The upload was cancelled.")));
    reader.readAsDataURL(file);
  });
}

async function sendTaskFile(input: {
  readonly environmentId: EnvironmentId;
  readonly writer: LocalTaskWriter;
  readonly taskId: string;
  readonly key: string;
  readonly candidate: TaskFileCandidate;
  readonly streams: boolean;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { candidate, taskId, key, signal } = input;
  const progress = (value: number) =>
    updatePending(taskId, key, (file) => ({ ...file, progress: value }));
  const size = candidate.type === "image" ? await readImageSize(candidate.file) : null;
  const described = {
    name: candidate.name,
    mimeType: candidate.mimeType,
    sizeBytes: candidate.file.size,
    ...(size ? { width: size.width, height: size.height } : {}),
  };
  let source: { readonly uploadToken: string } | { readonly dataUrl: string };
  try {
    if (signal.aborted) throw new Error("The upload was cancelled.");
    if (input.streams) {
      const { uploadToken } = await input.writer.createFileUpload({
        taskId,
        name: candidate.name,
        mimeType: candidate.mimeType,
        sizeBytes: candidate.file.size,
      });
      if (signal.aborted) throw new Error("The upload was cancelled.");
      await webChatFileUploadTransport.transferBytes({
        environmentId: input.environmentId,
        uploadToken,
        bytes: new Uint8Array(await candidate.file.arrayBuffer()),
        signal,
        onProgress: progress,
      });
      source = { uploadToken };
    } else {
      const dataUrl = await readDataUrl(candidate.file, signal);
      progress(0.5);
      source = { dataUrl };
    }
  } catch (cause) {
    if (signal.aborted) return dropPending(taskId, key);
    const message = cause instanceof Error ? cause.message : "The upload failed.";
    controllers.delete(key);
    updatePending(taskId, key, (file) => ({ ...file, error: message }));
    return;
  }
  if (signal.aborted) return dropPending(taskId, key);
  // The add queues behind the task's other saves; a refusal is reported by the writer. The chip
  // stays cancellable until it lands: the writer drops a cancelled add, or takes the file off
  // again when it was already on its way.
  await input.writer.addFile(taskId, { ...described, ...source }, { signal });
  dropPending(taskId, key);
}

/**
 * Adds files to a task: refused ones are named in a toast, the rest show as
 * chips (filling as they upload) until the task holds them.
 */
export function addTaskFiles(input: {
  readonly environmentId: EnvironmentId;
  readonly writer: LocalTaskWriter;
  readonly taskId: string;
  readonly files: ReadonlyArray<File>;
  /** The files the task holds already. */
  readonly stored: ReadonlyArray<LocalTaskFile>;
}): void {
  const pending = (useTaskFileUploadsStore.getState().byTask[input.taskId] ?? []).filter(
    (file) => file.error === null,
  );
  const streamingMaxBytes = readStreamingMaxBytes(input.environmentId);
  const plan = planTaskFileAdds({
    files: input.files,
    heldCount: input.stored.length + pending.length,
    heldBytes:
      input.stored.reduce((total, file) => total + file.sizeBytes, 0) +
      pending.reduce((total, file) => total + file.sizeBytes, 0),
    streamingMaxBytes,
    inlineMaxBytes: streamingMaxBytes === null ? TASK_FILE_INLINE_MAX_BYTES : null,
  });
  if (plan.error) toastManager.add({ type: "error", title: plan.error });
  if (plan.accepted.length === 0) return;
  const added = plan.accepted.map((candidate) => ({
    candidate,
    file: {
      key: `upload:${randomUUID()}`,
      taskId: input.taskId,
      name: candidate.name,
      type: candidate.type,
      sizeBytes: candidate.file.size,
      progress: 0,
      error: null,
    } satisfies PendingTaskFile,
  }));
  useTaskFileUploadsStore.setState((state) => ({
    byTask: {
      ...state.byTask,
      [input.taskId]: [...(state.byTask[input.taskId] ?? []), ...added.map(({ file }) => file)],
    },
  }));
  for (const { candidate, file } of added) {
    const controller = new AbortController();
    controllers.set(file.key, controller);
    trackSending(
      input.taskId,
      sendTaskFile({
        environmentId: input.environmentId,
        writer: input.writer,
        taskId: input.taskId,
        key: file.key,
        candidate,
        streams: streamingMaxBytes !== null,
        signal: controller.signal,
      }).catch(() => dropPending(input.taskId, file.key)),
    );
  }
}

/** Whether a file chip's key is a file still on its way (rather than a stored file's id). */
export function isPendingTaskFileKey(key: string): boolean {
  return key.startsWith("upload:");
}

/** Stops a file on its way (or clears one that failed). */
export function cancelPendingTaskFile(taskId: string, key: string): void {
  controllers.get(key)?.abort();
  dropPending(taskId, key);
}

const NO_FILE_VIEWS: ReadonlyArray<TaskFileView> = [];

/** The chips a task's files show: the stored ones, then the ones on their way. */
export function taskFileViews(
  stored: ReadonlyArray<LocalTaskFile>,
  pending: ReadonlyArray<PendingTaskFile> | undefined,
): ReadonlyArray<TaskFileView> {
  if (stored.length === 0 && !pending?.length) return NO_FILE_VIEWS;
  return [
    ...stored.map((file) => ({
      key: file.fileId,
      name: file.name,
      type: file.type,
      progress: null,
      error: null,
    })),
    ...(pending ?? []).map((file) => ({
      key: file.key,
      name: file.name,
      type: file.type,
      progress: file.progress,
      error: file.error,
    })),
  ];
}
