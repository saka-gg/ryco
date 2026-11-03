import type { EnvironmentApi, OrchestrationThread, ThreadId } from "@ryco/contracts";
import {
  projectThreadExportActivity,
  type ThreadExportSource,
  type ThreadExportMessage,
  type ThreadExportActivity,
} from "@ryco/shared/threadExport";

import { collectThreadHistory, type ThreadHistoryCopy } from "./threadHistory.ts";

export const THREAD_EXPORT_MAX_RECORDS = 20_000;
export const THREAD_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const overLimit = () =>
  new Error(
    "Conversation exceeds the export resource limit (20,000 records / 16 MiB retained data). No partial file was saved.",
  );
function projectMessage(item: OrchestrationThread["messages"][number]): ThreadExportMessage {
  return {
    id: item.id,
    role: item.role,
    text: item.text,
    streaming: item.streaming,
    createdAt: item.createdAt,
    attachmentCount: item.attachments?.length ?? 0,
  };
}
/** The thread's metadata as exported; its messages and activities are collected page by page. */
function projectThread(thread: OrchestrationThread): ThreadExportSource {
  if (thread.messages.length + thread.activities.length > THREAD_EXPORT_MAX_RECORDS)
    throw overLimit();
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    worktreeId: thread.worktreeId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    modelSelection: {
      instanceId: thread.modelSelection.instanceId,
      model: thread.modelSelection.model,
    },
    messages: [],
    activities: [],
  };
}

export const THREAD_EXPORT_RETRY =
  "Conversation or connection changed during export. Wait for activity to settle, reconnect if needed, and retry. No file was saved.";

const EXPORT_HISTORY_COPY: ThreadHistoryCopy = {
  cancelled: "Export cancelled.",
  changed: THREAD_EXPORT_RETRY,
  timedOut: "History request timed out. No file was saved; reconnect and retry.",
  unsupported: "This server cannot export complete retained history. Update the server and retry.",
  stalled: "History pagination stalled. No file was saved; retry or update the server.",
  overlapping: (collection) =>
    `History contains overlapping ${collection === "messages" ? "messages" : "activities"}. No file was saved; retry.`,
  emptyPage: "History page was empty before exhaustion. No file was saved; retry.",
};

/** No UI-store mutation and no provider calls. Every page must belong to one revision. */
export async function loadThreadForExport(input: {
  api: EnvironmentApi;
  threadId: ThreadId;
  signal: AbortSignal;
  isCurrent: () => boolean;
}): Promise<ThreadExportSource> {
  const messages: ThreadExportMessage[] = [];
  const activities: ThreadExportActivity[] = [];
  let retainedBytes = 0;
  let retainedRecords = 0;
  const account = (fields: readonly (string | null | undefined)[], record = false) => {
    retainedBytes += 512 + fields.reduce<number>((sum, field) => sum + (field?.length ?? 0) * 2, 0);
    if (record) retainedRecords++;
    if (retainedBytes > THREAD_EXPORT_MAX_BYTES || retainedRecords > THREAD_EXPORT_MAX_RECORDS)
      throw overLimit();
  };
  const metadata = await collectThreadHistory({
    ...input,
    collections: ["messages", "activities"],
    copy: EXPORT_HISTORY_COPY,
    project: (thread) => {
      const projected = projectThread(thread);
      account([
        projected.id,
        projected.projectId,
        projected.title,
        projected.branch,
        projected.worktreePath,
        projected.worktreeId,
        projected.createdAt,
        projected.updatedAt,
        projected.modelSelection.instanceId,
        projected.modelSelection.model,
      ]);
      return projected;
    },
    onItem: (entry) => {
      if (entry.collection === "messages") {
        const item = projectMessage(entry.item);
        account([item.id, item.role, item.text, item.createdAt], true);
        messages.push(item);
      } else if (entry.collection === "activities") {
        const item = projectThreadExportActivity(entry.item);
        account(
          [
            item.id,
            item.createdAt,
            item.kind,
            item.summary,
            item.boundary,
            item.forkOrigin,
            // Questions and answer text; the serialized length bounds the strings it holds.
            item.userInput ? JSON.stringify(item.userInput) : undefined,
          ],
          true,
        );
        activities.push(item);
      }
    },
    onCursor: (cursor) => account([cursor]),
  });
  return { ...metadata, messages, activities };
}
