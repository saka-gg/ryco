import type { EnvironmentApi, OrchestrationThread, ThreadId } from "@ryco/contracts";
import {
  projectThreadExportActivity,
  type ThreadExportSource,
  type ThreadExportMessage,
  type ThreadExportActivity,
} from "@ryco/shared/threadExport";

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
    messages: thread.messages.map(projectMessage),
    activities: thread.activities.map(projectThreadExportActivity),
  };
}

export const THREAD_EXPORT_RETRY =
  "Conversation or connection changed during export. Wait for activity to settle, reconnect if needed, and retry. No file was saved.";

/** No UI-store mutation and no provider calls. Every page must belong to one revision. */
export async function loadThreadForExport(input: {
  api: EnvironmentApi;
  threadId: ThreadId;
  signal: AbortSignal;
  isCurrent: () => boolean;
}): Promise<ThreadExportSource> {
  const check = () => {
    if (input.signal.aborted) throw new Error("Export cancelled.");
    if (!input.isCurrent()) throw new Error(THREAD_EXPORT_RETRY);
  };
  const request = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abort = () => finish(() => reject(new Error("Export cancelled.")));
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(new Error("History request timed out. No file was saved; reconnect and retry.")),
          ),
        30_000,
      );
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        settle();
      };
      input.signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
      if (input.signal.aborted) abort();
    });
  const { getThreadWindow, getThreadHistoryPage } = input.api.orchestration;
  if (!getThreadWindow || !getThreadHistoryPage)
    throw new Error(
      "This server cannot export complete retained history. Update the server and retry.",
    );
  const limits = { messages: 100, activities: 100, proposedPlans: 1, checkpoints: 1 };
  check();
  const snapshot = await request(
    getThreadWindow({ threadId: input.threadId, limits }).then((raw) => ({
      snapshotSequence: raw.snapshotSequence,
      history: raw.history,
      thread: projectThread(raw.thread),
    })),
  );
  check();
  if (snapshot.thread.id !== input.threadId) throw new Error(THREAD_EXPORT_RETRY);
  const messages = new Map<string, ThreadExportMessage>();
  const activities = new Map<string, ThreadExportActivity>();
  let retainedBytes = 0;
  let retainedRecords = 0;
  const account = (fields: readonly (string | null | undefined)[], record = false) => {
    retainedBytes += 512 + fields.reduce<number>((sum, field) => sum + (field?.length ?? 0) * 2, 0);
    if (record) retainedRecords++;
    if (retainedBytes > THREAD_EXPORT_MAX_BYTES || retainedRecords > THREAD_EXPORT_MAX_RECORDS)
      throw overLimit();
  };
  const addMessage = (item: ThreadExportMessage) => {
    if (messages.has(item.id))
      throw new Error("History contains overlapping messages. No file was saved; retry.");
    account([item.id, item.role, item.text, item.createdAt], true);
    messages.set(item.id, item);
  };
  const addActivity = (item: ThreadExportActivity) => {
    if (activities.has(item.id))
      throw new Error("History contains overlapping activities. No file was saved; retry.");
    account([item.id, item.createdAt, item.kind, item.summary, item.boundary], true);
    activities.set(item.id, item);
  };
  const metadata = snapshot.thread;
  account([
    metadata.id,
    metadata.projectId,
    metadata.title,
    metadata.branch,
    metadata.worktreePath,
    metadata.worktreeId,
    metadata.createdAt,
    metadata.updatedAt,
    metadata.modelSelection.instanceId,
    metadata.modelSelection.model,
  ]);
  snapshot.thread.messages.forEach(addMessage);
  snapshot.thread.activities.forEach(addActivity);
  for (const collection of ["messages", "activities"] as const) {
    let page = snapshot.history[collection];
    const cursors = new Set<string>();
    while (page.hasMoreBefore) {
      check();
      const cursor = page.oldestCursor;
      if (!cursor || cursors.has(cursor))
        throw new Error(
          "History pagination stalled. No file was saved; retry or update the server.",
        );
      account([cursor]);
      cursors.add(cursor);
      const result = await request(
        getThreadHistoryPage({
          threadId: input.threadId,
          collection,
          mode: { kind: "before", cursor },
          limit: 100,
        }),
      );
      check();
      if (result.snapshotSequence !== snapshot.snapshotSequence || result.collection !== collection)
        throw new Error(THREAD_EXPORT_RETRY);
      if (result.page.oldestCursor && cursors.has(result.page.oldestCursor))
        throw new Error(
          "History pagination stalled. No file was saved; retry or update the server.",
        );
      if (!result.items.length)
        throw new Error("History page was empty before exhaustion. No file was saved; retry.");
      if (result.collection === "messages")
        for (const item of result.items) addMessage(projectMessage(item));
      if (result.collection === "activities")
        for (const item of result.items) addActivity(projectThreadExportActivity(item));
      page = result.page;
    }
  }
  const final = await request(
    getThreadWindow({
      threadId: input.threadId,
      limits: { messages: 1, activities: 1, proposedPlans: 1, checkpoints: 1 },
    }),
  );
  check();
  if (final.thread.id !== input.threadId || final.snapshotSequence !== snapshot.snapshotSequence)
    throw new Error(THREAD_EXPORT_RETRY);
  return {
    ...snapshot.thread,
    messages: [...messages.values()],
    activities: [...activities.values()],
  };
}
