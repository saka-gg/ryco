import type { KVService } from "@ryco/client-runtime/platform";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import {
  markNewTaskLaunchStarted,
  startQueuedNewTaskLaunch,
  type NewTaskLaunchDeps,
} from "./newTaskLaunch";
import { newTaskLaunchKey, useNewTaskLaunchStore, type NewTaskLaunch } from "./newTaskLaunchStore";

/**
 * The New Task outbox: tasks written while their machine is offline, and
 * launches the app has not seen through yet, kept on this device across
 * restarts. A queued task starts only once its machine is live and its shell
 * snapshot current (the same gate the message outbox drains behind), under the
 * ids it was given when it was written, so a retried or resumed start is
 * answered from the node's receipts instead of creating the task twice.
 */

const STORAGE_KEY = "ryco.newTaskOutbox.v1";
const VERSION = 1;
/** More than a phone queues by hand; older entries go first. */
const MAX_PERSISTED_LAUNCHES = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const FAILURE_STEPS = new Set(["project", "worktree", "thread", "turn"]);
const PROJECT_KINDS = new Set(["existing", "new"]);
const WORKTREE_KINDS = new Set(["local", "existing", "new"]);

/** What is stored: the draft's images are the attempt's, so they are stored once. */
type StoredLaunch = Omit<NewTaskLaunch, "draft" | "editing"> & {
  readonly draft: Omit<NewTaskLaunch["draft"], "attachments">;
};

function toStoredLaunch(launch: NewTaskLaunch): StoredLaunch {
  const { editing: _editing, draft, ...rest } = launch;
  const { attachments: _attachments, ...storedDraft } = draft;
  return { ...rest, draft: storedDraft };
}

function readFailure(value: unknown): NewTaskLaunch["failure"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (typeof value.step !== "string" || !FAILURE_STEPS.has(value.step)) return undefined;
  if (typeof value.message !== "string" || typeof value.deliveryUncertain !== "boolean") {
    return undefined;
  }
  return value as unknown as NewTaskLaunch["failure"];
}

/**
 * Whether a stored entry still has the shape this build reads. A malformed or
 * foreign entry is dropped rather than half-trusted: the worst case is a task
 * the user writes again, never one sent with fields this build cannot check.
 */
function readPersistedLaunch(value: unknown): NewTaskLaunch | null {
  if (!isRecord(value)) return null;
  const { attempt, draft } = value;
  if (!isRecord(attempt) || !isRecord(draft) || !isRecord(attempt.ids)) return null;
  if (!nonEmptyString(attempt.environmentId) || !nonEmptyString(attempt.threadId)) return null;
  if (typeof attempt.prompt !== "string" || typeof draft.prompt !== "string") return null;
  if (!nonEmptyString(value.queuedAt) || !nonEmptyString(attempt.createdAt)) return null;
  if (!isRecord(attempt.project) || !PROJECT_KINDS.has(String(attempt.project.kind))) return null;
  if (!isRecord(attempt.worktree) || !WORKTREE_KINDS.has(String(attempt.worktree.kind))) {
    return null;
  }
  if (!isRecord(draft.worktree) || !WORKTREE_KINDS.has(String(draft.worktree.kind))) return null;
  if (!Array.isArray(attempt.attachments)) return null;
  for (const id of [
    "projectId",
    "projectCommandId",
    "threadId",
    "threadCommandId",
    "attachCommandId",
    "turnCommandId",
    "messageId",
  ]) {
    if (!nonEmptyString(attempt.ids[id])) return null;
  }
  const failure = readFailure(value.failure);
  if (failure === undefined) return null;
  const stored = value as unknown as StoredLaunch;
  if (stored.key !== newTaskLaunchKey(stored.attempt.environmentId, stored.attempt.threadId)) {
    return null;
  }
  const launch: NewTaskLaunch = {
    ...stored,
    failure,
    fromOutbox: true,
    draft: {
      ...stored.draft,
      // The images went out with the attempt; the draft shows them again.
      attachments: stored.attempt.attachments.map((attachment, index) => ({
        ...attachment,
        id: `${stored.key}:attachment-${index}`,
        previewUri: attachment.dataUrl,
      })),
    },
  };
  if (launch.status === "queued" || launch.status === "failed") return launch;
  // The app stopped while it was starting: it starts again from the outbox.
  if (launch.status === "starting") {
    return { ...launch, status: "queued", interrupted: true };
  }
  return null;
}

/** Launches the outbox keeps: written while their machine was away, and not yet taken. */
function persistable(launches: Readonly<Record<string, NewTaskLaunch>>): NewTaskLaunch[] {
  return Object.values(launches)
    .filter((launch) => launch.fromOutbox === true && launch.status !== "started")
    .toSorted((left, right) => left.queuedAt.localeCompare(right.queuedAt))
    .slice(-MAX_PERSISTED_LAUNCHES);
}

function sameLaunches(left: ReadonlyArray<NewTaskLaunch>, right: ReadonlyArray<NewTaskLaunch>) {
  return left.length === right.length && left.every((launch, index) => launch === right[index]);
}

export interface NewTaskOutboxPersistence {
  /** Loads the stored outbox into the launch store, then keeps it written. */
  readonly hydrate: () => Promise<void>;
  readonly dispose: () => void;
}

/** A failed read is tried again once before the outbox may write over the store. */
const HYDRATE_RETRY_MS = 2_000;

/**
 * Bind the outbox to a key-value store. Hydration merges stored launches under
 * any already in memory (a launch started this session wins); every change
 * after it is written back, serialized so an older write never lands last. A
 * launch's images can be large, so nothing is serialized unless the outbox's
 * launches themselves changed.
 */
export function createNewTaskOutboxPersistence(
  kv: KVService,
  options?: { readonly retryDelayMs?: number },
): NewTaskOutboxPersistence {
  let hydrated = false;
  let disposed = false;
  let lastLaunches: ReadonlyArray<NewTaskLaunch> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const write = () => {
    if (!hydrated || disposed) return;
    const launches = persistable(useNewTaskLaunchStore.getState().launchesByKey);
    if (lastLaunches !== null && sameLaunches(lastLaunches, launches)) return;
    lastLaunches = launches;
    const serialized =
      launches.length === 0
        ? null
        : JSON.stringify({
            version: VERSION,
            launches: launches.map(toStoredLaunch),
          });
    writing = writing
      .then(() =>
        serialized === null ? kv.removeItem(STORAGE_KEY) : kv.setItem(STORAGE_KEY, serialized),
      )
      .catch(() => {
        // The next change writes the whole outbox again.
        lastLaunches = null;
      });
  };

  const unsubscribe = useNewTaskLaunchStore.subscribe(write);

  const read = async (): Promise<NewTaskLaunch[] | null> => {
    try {
      const raw = await kv.getItem(STORAGE_KEY);
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      if (isRecord(parsed) && parsed.version === VERSION && Array.isArray(parsed.launches)) {
        return parsed.launches.flatMap((entry) => readPersistedLaunch(entry) ?? []);
      }
      return [];
    } catch {
      return null;
    }
  };

  return {
    hydrate: async () => {
      if (hydrated) return;
      let stored = await read();
      if (stored === null && !disposed) {
        // Writing now would replace a stored outbox this read could not see.
        await new Promise((resolve) =>
          setTimeout(resolve, options?.retryDelayMs ?? HYDRATE_RETRY_MS),
        );
        stored = (await read()) ?? [];
      }
      hydrated = true;
      if (disposed) return;
      useNewTaskLaunchStore.setState((state) => {
        const launchesByKey = { ...state.launchesByKey };
        for (const launch of stored ?? []) launchesByKey[launch.key] ??= launch;
        return { launchesByKey };
      });
      write();
    },
    dispose: () => {
      disposed = true;
      unsubscribe();
    },
  };
}

/**
 * Start every queued launch whose machine may be written to now. The caller's
 * gate is the message outbox's: the machine is connected and its shell
 * snapshot is current, not a cached one. Returns how many it started.
 */
export function drainNewTaskOutbox(input: {
  readonly isEnvironmentReady: (environmentId: EnvironmentId) => boolean;
  readonly depsFor: (environmentId: EnvironmentId) => NewTaskLaunchDeps;
  /** Whether the node shows the task's thread with its turn under way. */
  readonly isThreadStarted: (environmentId: EnvironmentId, threadId: ThreadId) => boolean;
}): number {
  let started = 0;
  for (const launch of Object.values(useNewTaskLaunchStore.getState().launchesByKey)) {
    if (launch.editing === true) continue;
    const { environmentId, threadId } = launch.attempt;
    if (launch.status !== "queued" && launch.status !== "failed") continue;
    // Its turn reached the node after all (an answer lost on the way, or the
    // app stopped mid-way): nothing is left to send, and no row stays behind.
    if (input.isThreadStarted(environmentId, threadId)) {
      markNewTaskLaunchStarted(launch.key);
      continue;
    }
    if (launch.status !== "queued" || !input.isEnvironmentReady(environmentId)) continue;
    startQueuedNewTaskLaunch(launch.key, input.depsFor(environmentId));
    started += 1;
  }
  return started;
}
