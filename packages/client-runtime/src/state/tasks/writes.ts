import type {
  EnvironmentId,
  FileAttachmentCreateUploadUrlResult,
  LocalTask,
  LocalTaskAddFileInput,
  LocalTaskCreateInput,
  LocalTaskDelegateInput,
  LocalTaskFile,
  LocalTaskFileUploadInput,
  LocalTaskLink,
  LocalTaskRemoveFileInput,
} from "@ryco/contracts";
import { isTagged } from "effect/Predicate";

import { taskLinkKey } from "./logic.ts";
import { selectLocalTasksEnvironment, selectTaskView, useLocalTasksStore } from "./store.ts";
import { refreshLocalTasks, requireLocalTaskMethod, type LocalTasksApi } from "./sync.ts";
import type { LocalTaskOptimisticStart, LocalTaskPatch, LocalTaskView } from "./types.ts";

/** A file to add to a task; the writer supplies the task and its revision. */
export type LocalTaskAddFileRequest = Omit<LocalTaskAddFileInput, "taskId" | "expectedRevision">;

/** The write a reported failure belongs to. */
export type LocalTaskWriteOperation =
  | { readonly kind: "create"; readonly taskId: string }
  | { readonly kind: "update"; readonly taskId: string; readonly patch: LocalTaskPatch | null }
  | { readonly kind: "remove"; readonly taskId: string }
  | { readonly kind: "addFile"; readonly taskId: string; readonly name: string }
  | { readonly kind: "removeFile"; readonly taskId: string; readonly fileId: string };

export interface LocalTaskWriterOptions {
  /**
   * The node's task methods, or a getter for the current connection's. Prefer
   * the getter: a write queued across a reconnect then goes out on the new
   * connection instead of failing on the old one.
   */
  readonly api: LocalTasksApi | (() => LocalTasksApi | null | undefined);
  readonly environmentId: EnvironmentId;
  /**
   * A write the node refused or never confirmed, after its change was rolled
   * back and the tasks re-read. Every write but `delegate` reports here.
   */
  readonly onError: (cause: unknown, operation: LocalTaskWriteOperation) => void;
}

export interface LocalTaskWriter {
  /** Shows the task at once; resolves with the node's task, or `null` once a failure is reported. */
  readonly create: (input: LocalTaskCreateInput) => Promise<LocalTask | null>;
  /**
   * Shows the change at once; changes made while a save is in flight go out together after it.
   * `links` is the whole list the task should show; it goes out as this client's additions and
   * removals applied to the links the node has, so a link someone else added meanwhile stays.
   */
  readonly update: (taskId: string, patch: LocalTaskPatch) => void;
  /** Hides the task at once and drops changes still waiting; resolves `false` (task restored) on failure. */
  readonly remove: (taskId: string) => Promise<boolean>;
  /**
   * Adds a file; `null` once a failure is reported, or when the task is being deleted. Aborting
   * `signal` drops an add still waiting, and takes the file off again when the add was already
   * on its way (resolving `null`), so a cancelled file never stays on the task.
   */
  readonly addFile: (
    taskId: string,
    request: LocalTaskAddFileRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<LocalTask | null>;
  /** Removes a file; `null` once a failure is reported, or when the task is being deleted. */
  readonly removeFile: (
    taskId: string,
    fileId: LocalTaskRemoveFileInput["fileId"],
  ) => Promise<LocalTask | null>;
  /**
   * Starts a chat. It shows as starting at once and does not wait for the
   * task's saves (a start never changes the revision), only for the task's
   * creation and for its file adds and removals still on their way: the node
   * gives the chat the files the task holds when the start reaches it.
   * Rejects on failure, with the start dropped, so the caller can say what
   * went wrong; a task that is gone or being deleted is refused at once.
   */
  readonly delegate: (
    taskId: string,
    command: LocalTaskDelegateInput["command"],
    options: { readonly branch: string | null },
  ) => Promise<LocalTask>;
  /** Mints an upload token for a task file. Rejects on failure. */
  readonly createFileUpload: (
    input: LocalTaskFileUploadInput,
  ) => Promise<FileAttachmentCreateUploadUrlResult>;
}

type QueuedWrite =
  | {
      readonly kind: "create";
      readonly input: LocalTaskCreateInput;
      readonly settle: (task: LocalTask | null) => void;
    }
  /** The fields waiting in `TaskQueue.pending` at the time it runs. */
  | { readonly kind: "patch" }
  | {
      readonly kind: "addFile";
      readonly request: LocalTaskAddFileRequest;
      readonly signal: AbortSignal | undefined;
      readonly settle: (task: LocalTask | null) => void;
    }
  | {
      readonly kind: "removeFile";
      readonly fileId: LocalTaskRemoveFileInput["fileId"];
      readonly settle: (task: LocalTask | null) => void;
    }
  | { readonly kind: "remove"; readonly settle: (removed: boolean) => void };

/**
 * Link edits as a change rather than a list, so a save that has to be sent
 * again (after a conflict) applies them to the links the node has by then.
 */
interface LinkChanges {
  /** Links added, by `taskLinkKey`, in the order they were added. */
  readonly added: ReadonlyMap<string, LocalTaskLink>;
  /** Keys of links removed. */
  readonly removed: ReadonlySet<string>;
}

interface TaskQueue {
  running: boolean;
  readonly writes: QueuedWrite[];
  /** Fields changed since the patch in flight went out. */
  pending: LocalTaskPatch | null;
  /** Fields of the patch in flight. */
  sent: LocalTaskPatch | null;
  /** The link edits among `pending`. */
  pendingLinks: LinkChanges | null;
  /** The link edits among `sent`. */
  sentLinks: LinkChanges | null;
  /** Settles with the task's creation when one is queued or in flight. */
  created: Promise<LocalTask | null> | null;
  removing: Promise<boolean> | null;
}

function mergePatch(
  base: LocalTaskPatch | null,
  next: LocalTaskPatch | null,
): LocalTaskPatch | null {
  if (base === null) return next;
  if (next === null) return base;
  return { ...base, ...next };
}

/** What turns `from` into `to`; `null` when they hold the same links. */
function diffLinks(
  from: ReadonlyArray<LocalTaskLink>,
  to: ReadonlyArray<LocalTaskLink>,
): LinkChanges | null {
  const fromKeys = new Set(from.map(taskLinkKey));
  const toKeys = new Set(to.map(taskLinkKey));
  const added = new Map<string, LocalTaskLink>();
  for (const link of to) {
    const key = taskLinkKey(link);
    if (!fromKeys.has(key)) added.set(key, link);
  }
  const removed = new Set([...fromKeys].filter((key) => !toKeys.has(key)));
  return added.size === 0 && removed.size === 0 ? null : { added, removed };
}

/** `next` made after `base`: the later edit of a link wins. */
function mergeLinkChanges(base: LinkChanges | null, next: LinkChanges | null): LinkChanges | null {
  if (base === null) return next;
  if (next === null) return base;
  const added = new Map(base.added);
  const removed = new Set(base.removed);
  for (const key of next.removed) {
    added.delete(key);
    removed.add(key);
  }
  for (const [key, link] of next.added) {
    removed.delete(key);
    added.set(key, link);
  }
  return { added, removed };
}

/** `links` with the changes applied: removed ones dropped, added ones appended once. */
function applyLinkChanges(
  links: ReadonlyArray<LocalTaskLink>,
  changes: LinkChanges,
): LocalTaskLink[] {
  const kept = links.filter((link) => !changes.removed.has(taskLinkKey(link)));
  const keys = new Set(kept.map(taskLinkKey));
  for (const [key, link] of changes.added) if (!keys.has(key)) kept.push(link);
  return kept;
}

/** The file an add put on the task: in its answer, not in the task it was sent against. */
function addedFile(
  base: LocalTask,
  added: LocalTask,
  request: LocalTaskAddFileRequest,
): LocalTaskFile | undefined {
  const before = new Set(base.files.map((file) => file.fileId));
  return added.files.find(
    (file) =>
      !before.has(file.fileId) &&
      file.name === request.name &&
      file.sizeBytes === request.sizeBytes,
  );
}

/** The fields of `patch` that differ from what the task already shows; `null` when none do. */
function changedFields(
  patch: LocalTaskPatch,
  shown: LocalTaskView | undefined,
): LocalTaskPatch | null {
  if (!shown) return patch;
  const changed: Record<string, unknown> = {};
  let any = false;
  for (const [key, value] of Object.entries(patch)) {
    const current: unknown = shown[key as keyof LocalTaskPatch];
    // Links are small value lists; their JSON is a faithful comparison.
    const same =
      key === "links" ? JSON.stringify(current) === JSON.stringify(value) : current === value;
    if (same) continue;
    changed[key] = value;
    any = true;
  }
  return any ? (changed as LocalTaskPatch) : null;
}

const hasReason = (cause: unknown, reason: string) =>
  isTagged(cause, "LocalTaskError") && (cause as { reason?: unknown }).reason === reason;

function cancelWrite(write: QueuedWrite): void {
  switch (write.kind) {
    case "patch":
      return;
    case "remove":
      return write.settle(false);
    default:
      return write.settle(null);
  }
}

/**
 * Writes one environment's tasks with optimistic changes in
 * `useLocalTasksStore`. Each task has one serial queue: one write in flight,
 * later field changes merged into one patch, every write sent with the
 * revision the one before it returned. A conflict (someone else saved first)
 * reloads the task and sends the change once more; a second conflict or any
 * other failure rolls the change back, re-reads the tasks and reports it.
 * Create one writer per environment so its tasks share the queues.
 */
export function createLocalTaskWriter(options: LocalTaskWriterOptions): LocalTaskWriter {
  const { environmentId, onError } = options;
  const queues = new Map<string, TaskQueue>();
  const store = () => useLocalTasksStore.getState();

  const currentApi = (): LocalTasksApi => {
    const api = typeof options.api === "function" ? options.api() : options.api;
    if (!api) throw new Error("The node is not connected.");
    return api;
  };

  const queueFor = (taskId: string): TaskQueue => {
    let queue = queues.get(taskId);
    if (!queue) {
      queue = {
        running: false,
        writes: [],
        pending: null,
        sent: null,
        pendingLinks: null,
        sentLinks: null,
        created: null,
        removing: null,
      };
      queues.set(taskId, queue);
    }
    return queue;
  };

  const fail = (cause: unknown, operation: LocalTaskWriteOperation) => {
    void refreshLocalTasks(environmentId);
    onError(cause, operation);
  };

  /**
   * File adds and removals not settled yet, by task: a start waits for them.
   * Their promises never reject.
   */
  const fileWrites = new Map<string, Set<Promise<unknown>>>();
  const trackFileWrite = <T>(taskId: string, settled: Promise<T>): Promise<T> => {
    let pending = fileWrites.get(taskId);
    if (!pending) {
      pending = new Set();
      fileWrites.set(taskId, pending);
    }
    const tracked = pending;
    tracked.add(settled);
    void settled.then(() => {
      tracked.delete(settled);
      if (tracked.size === 0 && fileWrites.get(taskId) === tracked) fileWrites.delete(taskId);
    });
    return settled;
  };

  /**
   * Shows the fields in flight and waiting over the node's task. Its links are
   * this client's link edits over the links the node has now.
   */
  const publishPatch = (taskId: string, queue: TaskQueue, patchedAt?: string) => {
    let patch = mergePatch(queue.sent, queue.pending);
    const linkChanges = mergeLinkChanges(queue.sentLinks, queue.pendingLinks);
    if (patch !== null && linkChanges !== null) {
      const environment = selectLocalTasksEnvironment(store(), environmentId);
      const base = environment.tasks[taskId] ?? environment.overlays[taskId]?.created;
      patch = { ...patch, links: applyLinkChanges(base?.links ?? [], linkChanges) };
    }
    store().setOverlay(environmentId, taskId, (overlay) => {
      if (patch === null)
        return overlay.patch === null ? overlay : { ...overlay, patch: null, patchedAt: null };
      return {
        ...overlay,
        patch,
        patchedAt: patchedAt ?? overlay.patchedAt ?? new Date().toISOString(),
      };
    });
  };

  const fetchTask = async (taskId: string): Promise<LocalTask> => {
    const task = await requireLocalTaskMethod(currentApi(), "getLocalTask")({ taskId });
    store().applyTask(environmentId, task);
    return task;
  };

  /**
   * Sends against the newest copy of the task known (its revision, and its
   * links for a link edit), and once more against a fresh copy after a conflict.
   */
  const sendWithRevision = async <T>(
    taskId: string,
    attempt: (base: LocalTask, retry: boolean) => Promise<T>,
  ): Promise<T> => {
    const known = selectLocalTasksEnvironment(store(), environmentId).tasks[taskId];
    try {
      return await attempt(known ?? (await fetchTask(taskId)), false);
    } catch (cause) {
      if (!hasReason(cause, "conflict")) throw cause;
    }
    return attempt(await fetchTask(taskId), true);
  };

  /** The task could not be created: nothing queued behind it can succeed. */
  const abandon = (taskId: string, queue: TaskQueue) => {
    for (const write of queue.writes.splice(0)) cancelWrite(write);
    queue.pending = null;
    queue.sent = null;
    queue.pendingLinks = null;
    queue.sentLinks = null;
    store().clearOverlay(environmentId, taskId);
  };

  const perform = async (taskId: string, queue: TaskQueue, write: QueuedWrite): Promise<void> => {
    switch (write.kind) {
      case "create": {
        try {
          const task = await requireLocalTaskMethod(currentApi(), "createLocalTask")(write.input);
          store().applyTask(environmentId, task);
          write.settle(task);
        } catch (cause) {
          abandon(taskId, queue);
          fail(cause, { kind: "create", taskId });
          write.settle(null);
        }
        return;
      }
      case "patch": {
        queue.sent = queue.pending;
        queue.pending = null;
        queue.sentLinks = queue.pendingLinks;
        queue.pendingLinks = null;
        if (queue.sent === null) return;
        try {
          const task = await sendWithRevision(taskId, (base, retry) => {
            // The retry carries everything changed so far, not only the fields that conflicted.
            if (retry) {
              queue.sent = mergePatch(queue.sent, queue.pending);
              queue.pending = null;
              queue.sentLinks = mergeLinkChanges(queue.sentLinks, queue.pendingLinks);
              queue.pendingLinks = null;
            }
            const { links: _shownLinks, ...fields }: LocalTaskPatch = queue.sent ?? {};
            // A whole list would undo a link someone else added since this client read it.
            const links = queue.sentLinks ? applyLinkChanges(base.links, queue.sentLinks) : null;
            return requireLocalTaskMethod(
              currentApi(),
              "updateLocalTask",
            )({
              taskId,
              expectedRevision: base.revision,
              ...fields,
              ...(links ? { links } : {}),
            });
          });
          queue.sent = null;
          queue.sentLinks = null;
          // The node's task first, so dropping the overlay never flashes the old value.
          store().applyTask(environmentId, task);
          publishPatch(taskId, queue);
        } catch (cause) {
          const failed = queue.sent;
          queue.sent = null;
          queue.sentLinks = null;
          publishPatch(taskId, queue);
          fail(cause, { kind: "update", taskId, patch: failed });
        }
        return;
      }
      case "addFile": {
        // Cancelled before it went out: there is nothing to undo.
        if (write.signal?.aborted) return write.settle(null);
        try {
          let added: LocalTaskFile | undefined;
          const task = await sendWithRevision(taskId, async (base) => {
            const result = await requireLocalTaskMethod(
              currentApi(),
              "addLocalTaskFile",
            )({
              ...write.request,
              taskId,
              expectedRevision: base.revision,
            });
            added = addedFile(base, result, write.request);
            return result;
          });
          if (write.signal?.aborted && added) {
            // Cancelled while it was on its way: take it off again before it shows.
            try {
              store().applyTask(
                environmentId,
                await requireLocalTaskMethod(
                  currentApi(),
                  "removeLocalTaskFile",
                )({ taskId, expectedRevision: task.revision, fileId: added.fileId }),
              );
            } catch (cause) {
              store().applyTask(environmentId, task);
              fail(cause, { kind: "removeFile", taskId, fileId: added.fileId });
            }
            write.settle(null);
            return;
          }
          store().applyTask(environmentId, task);
          write.settle(task);
        } catch (cause) {
          // A file the user cancelled has no failure to report.
          if (write.signal?.aborted) void refreshLocalTasks(environmentId);
          else fail(cause, { kind: "addFile", taskId, name: write.request.name });
          write.settle(null);
        }
        return;
      }
      case "removeFile": {
        try {
          const task = await sendWithRevision(taskId, (base) =>
            requireLocalTaskMethod(
              currentApi(),
              "removeLocalTaskFile",
            )({
              taskId,
              expectedRevision: base.revision,
              fileId: write.fileId,
            }),
          );
          store().applyTask(environmentId, task);
          write.settle(task);
        } catch (cause) {
          fail(cause, { kind: "removeFile", taskId, fileId: write.fileId });
          write.settle(null);
        }
        return;
      }
      case "remove": {
        try {
          await sendWithRevision(taskId, (base) =>
            requireLocalTaskMethod(
              currentApi(),
              "deleteLocalTask",
            )({ taskId, expectedRevision: base.revision }),
          );
          store().removeTask(environmentId, taskId);
          write.settle(true);
        } catch (cause) {
          // Already gone is what the delete wanted.
          if (hasReason(cause, "not-found")) {
            store().removeTask(environmentId, taskId);
            write.settle(true);
            return;
          }
          queue.removing = null;
          store().setOverlay(environmentId, taskId, (overlay) => ({ ...overlay, hidden: false }));
          fail(cause, { kind: "remove", taskId });
          write.settle(false);
        }
        return;
      }
    }
  };

  const drain = async (taskId: string, queue: TaskQueue): Promise<void> => {
    if (queue.running) return;
    queue.running = true;
    try {
      for (let write = queue.writes.shift(); write; write = queue.writes.shift())
        await perform(taskId, queue, write);
    } finally {
      queue.running = false;
      if (queues.get(taskId) === queue) queues.delete(taskId);
    }
  };

  const enqueue = <T>(taskId: string, make: (settle: (value: T) => void) => QueuedWrite) => {
    const queue = queueFor(taskId);
    const settled = new Promise<T>((resolve) => queue.writes.push(make(resolve)));
    void drain(taskId, queue);
    return { queue, settled };
  };

  return {
    create: (input) => {
      const now = new Date().toISOString();
      const optimistic: LocalTask = {
        ...input,
        revision: 0,
        links: [],
        files: [],
        state: "todo",
        createdAt: now,
        updatedAt: now,
        status: "todo",
        delegations: [],
      };
      store().setOverlay(environmentId, input.taskId, (overlay) => ({
        ...overlay,
        created: optimistic,
      }));
      const { queue, settled } = enqueue<LocalTask | null>(input.taskId, (settle) => ({
        kind: "create",
        input,
        settle,
      }));
      queue.created = settled;
      return settled;
    },
    update: (taskId, patch) => {
      if (queues.get(taskId)?.removing) return;
      // A save that changes nothing would only bump the revision.
      const shown = selectTaskView(store(), environmentId, taskId);
      const changed = changedFields(patch, shown);
      if (changed === null) return;
      const queue = queueFor(taskId);
      if (changed.links !== undefined)
        queue.pendingLinks = mergeLinkChanges(
          queue.pendingLinks,
          diffLinks(shown?.links ?? [], changed.links),
        );
      queue.pending = mergePatch(queue.pending, changed);
      if (!queue.writes.some((write) => write.kind === "patch"))
        queue.writes.push({ kind: "patch" });
      publishPatch(taskId, queue, new Date().toISOString());
      void drain(taskId, queue);
    },
    remove: (taskId) => {
      const existing = queues.get(taskId)?.removing;
      if (existing) return existing;
      const queue = queueFor(taskId);
      store().setOverlay(environmentId, taskId, (overlay) =>
        overlay.hidden ? overlay : { ...overlay, hidden: true },
      );
      // Saves still waiting are moot; a creation in flight still has to land first.
      const kept = queue.writes.filter((write) => write.kind === "create");
      for (const write of queue.writes.splice(0)) if (write.kind !== "create") cancelWrite(write);
      queue.writes.push(...kept);
      queue.pending = null;
      queue.pendingLinks = null;
      publishPatch(taskId, queue);
      const { settled } = enqueue<boolean>(taskId, (settle) => ({ kind: "remove", settle }));
      queue.removing = settled;
      return settled;
    },
    addFile: (taskId, request, options) => {
      // The task is going away, and the file with it.
      if (queues.get(taskId)?.removing) return Promise.resolve(null);
      return trackFileWrite(
        taskId,
        enqueue<LocalTask | null>(taskId, (settle) => ({
          kind: "addFile",
          request,
          signal: options?.signal,
          settle,
        })).settled,
      );
    },
    removeFile: (taskId, fileId) => {
      if (queues.get(taskId)?.removing) return Promise.resolve(null);
      return trackFileWrite(
        taskId,
        enqueue<LocalTask | null>(taskId, (settle) => ({ kind: "removeFile", fileId, settle }))
          .settled,
      );
    },
    delegate: async (taskId, command, { branch }) => {
      // A chat for a task being deleted would only be left behind.
      if (queues.get(taskId)?.removing || !selectTaskView(store(), environmentId, taskId))
        throw new Error("The task was deleted, so its chat was not started.");
      const start: LocalTaskOptimisticStart = {
        commandId: command.commandId,
        threadId: command.threadId,
        status: "starting",
        branch,
        createdAt: new Date().toISOString(),
      };
      const isThisStart = (other: LocalTaskOptimisticStart) => other.commandId === start.commandId;
      store().setOverlay(environmentId, taskId, (overlay) => ({
        ...overlay,
        optimisticStarts: [
          ...overlay.optimisticStarts.filter((other) => !isThisStart(other)),
          start,
        ],
      }));
      try {
        const creating = queues.get(taskId)?.created;
        if (creating && (await creating) === null)
          throw new Error("The task could not be saved, so its chat was not started.");
        // The node gives the chat the files the task holds when the start arrives.
        await Promise.all(fileWrites.get(taskId) ?? []);
        const task = await requireLocalTaskMethod(
          currentApi(),
          "delegateLocalTask",
        )({
          taskId,
          command,
        });
        store().applyTask(environmentId, task);
        return task;
      } catch (cause) {
        // The start may have reached the node before the reply was lost.
        void refreshLocalTasks(environmentId);
        throw cause;
      } finally {
        store().setOverlay(environmentId, taskId, (overlay) =>
          overlay.optimisticStarts.some(isThisStart)
            ? {
                ...overlay,
                optimisticStarts: overlay.optimisticStarts.filter((other) => !isThisStart(other)),
              }
            : overlay,
        );
      }
    },
    createFileUpload: async (input) =>
      requireLocalTaskMethod(currentApi(), "createLocalTaskFileUpload")(input),
  };
}
