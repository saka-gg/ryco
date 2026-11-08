import {
  planTaskFileAdds,
  TASK_FILE_INLINE_MAX_BYTES,
  type TaskFileCandidate,
} from "@ryco/client-runtime/state/tasks";
import type { EnvironmentId, LocalTaskFile } from "@ryco/contracts";
import { Alert } from "react-native";
import { create } from "zustand";

import { readComposerFileBytes, type PickComposerAttachmentsResult } from "../../lib/composerFiles";
import { uuidv4 } from "../../lib/uuid";
import { mobileChatFileUploadTransport } from "../../platform/attachmentUpload";
import { mobileLocalTaskWriter } from "./tasksRuntime";

/**
 * Adding files to a task from the phone: photos and files picked the way the
 * composer picks them, checked against the shared task file rules
 * (`planTaskFileAdds`), streamed to the machine when it takes uploads (else
 * sent inline), then added to the task through its writer. Files on their way
 * show on the task sheet until they land; a chat started meanwhile waits for
 * them, since the machine hands a chat the files its task holds.
 */

export interface PendingTaskFile {
  /** `upload:<uuid>`, never a stored file id. */
  readonly key: string;
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

export const useTaskFileUploadsStore = create<TaskFileUploadsState>(() => ({ byTask: {} }));

const sending = new Map<string, Set<Promise<void>>>();

/** Resolves once every file on its way to the task has landed (or failed). */
export function whenTaskFilesSent(taskId: string): Promise<void> {
  const files = sending.get(taskId);
  return files ? Promise.all(files).then(() => undefined) : Promise.resolve();
}

function track(taskId: string, sent: Promise<void>): void {
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

function patchPending(
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

/** Takes a failed upload off the sheet. */
export function dismissPendingTaskFile(taskId: string, key: string): void {
  patchPending(taskId, key, () => null);
}

/** A picked photo or file as the shared rules read it. */
interface PickedTaskFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly source:
    | { readonly kind: "inline"; readonly dataUrl: string }
    | { readonly kind: "read"; readonly readUri: string };
}

function base64Bytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const binary = atob(comma === -1 ? dataUrl : dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sendFile(input: {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly key: string;
  readonly candidate: TaskFileCandidate<PickedTaskFile>;
  readonly streams: boolean;
}): Promise<void> {
  const { candidate, taskId, key } = input;
  const writer = mobileLocalTaskWriter(input.environmentId);
  const described = {
    name: candidate.name,
    mimeType: candidate.mimeType,
    sizeBytes: candidate.file.size,
  };
  const source = candidate.file.source;
  let added: { readonly uploadToken: string } | { readonly dataUrl: string };
  try {
    if (
      source.kind === "inline" &&
      (!input.streams || candidate.file.size <= TASK_FILE_INLINE_MAX_BYTES)
    ) {
      added = { dataUrl: source.dataUrl };
    } else {
      const { uploadToken } = await writer.createFileUpload({ taskId, ...described });
      const bytes =
        source.kind === "inline"
          ? base64Bytes(source.dataUrl)
          : await readComposerFileBytes(source.readUri);
      await mobileChatFileUploadTransport.transferBytes({
        environmentId: input.environmentId,
        uploadToken,
        bytes,
        onProgress: (progress) => patchPending(taskId, key, (file) => ({ ...file, progress })),
      });
      added = { uploadToken };
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The upload failed.";
    patchPending(taskId, key, (file) => ({ ...file, error: message }));
    return;
  }
  // The add queues behind the task's other saves; a refusal is reported by the writer.
  await writer.addFile(taskId, { ...described, ...added });
  patchPending(taskId, key, () => null);
}

/**
 * Adds what the composer's picker returned to the task. `streamingMaxBytes`
 * is the machine's upload limit when it takes streamed uploads, else null.
 */
export function addPickedTaskFiles(input: {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly picked: Pick<PickComposerAttachmentsResult, "images" | "files">;
  readonly stored: ReadonlyArray<LocalTaskFile>;
  readonly streamingMaxBytes: number | null;
}): void {
  const files: PickedTaskFile[] = [
    ...input.picked.images.map((image) => ({
      name: image.name,
      type: image.mimeType,
      size: image.sizeBytes,
      source: { kind: "inline" as const, dataUrl: image.dataUrl },
    })),
    ...input.picked.files.map((file) => ({
      name: file.name,
      type: file.mimeType,
      size: file.sizeBytes,
      source: { kind: "read" as const, readUri: file.readUri },
    })),
  ];
  const pending = (useTaskFileUploadsStore.getState().byTask[input.taskId] ?? []).filter(
    (file) => file.error === null,
  );
  const plan = planTaskFileAdds({
    files,
    heldCount: input.stored.length + pending.length,
    heldBytes:
      input.stored.reduce((total, file) => total + file.sizeBytes, 0) +
      pending.reduce((total, file) => total + file.sizeBytes, 0),
    streamingMaxBytes: input.streamingMaxBytes,
    inlineMaxBytes: input.streamingMaxBytes === null ? TASK_FILE_INLINE_MAX_BYTES : null,
  });
  if (plan.error) Alert.alert("Some files were not added", plan.error);
  if (plan.accepted.length === 0) return;
  const added = plan.accepted.map((candidate) => ({
    candidate,
    file: {
      key: `upload:${uuidv4()}`,
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
  for (const { candidate, file } of added)
    track(
      input.taskId,
      sendFile({
        environmentId: input.environmentId,
        taskId: input.taskId,
        key: file.key,
        candidate,
        streams: input.streamingMaxBytes !== null,
      }).catch(() => patchPending(input.taskId, file.key, () => null)),
    );
}
