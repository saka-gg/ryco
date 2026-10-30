import type { KVService } from "@ryco/client-runtime/platform";
import type { EnvironmentId } from "@ryco/contracts";

import { startQueuedNewTaskLaunch, type NewTaskLaunchDeps } from "./newTaskLaunch";
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

interface PersistedOutbox {
  readonly version: typeof VERSION;
  readonly launches: ReadonlyArray<NewTaskLaunch>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
  if (!isRecord(attempt.project) || !isRecord(attempt.worktree)) return null;
  if (!Array.isArray(attempt.attachments) || !Array.isArray(draft.attachments)) return null;
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
  const launch = value as unknown as NewTaskLaunch;
  if (launch.key !== newTaskLaunchKey(launch.attempt.environmentId, launch.attempt.threadId)) {
    return null;
  }
  if (launch.status === "queued" || launch.status === "failed") return launch;
  // The app stopped while it was starting: it starts again from the outbox.
  if (launch.status === "starting") {
    return { ...launch, status: "queued", failure: null, interrupted: true };
  }
  return null;
}

/** Launches the outbox keeps: everything not yet taken by the node. */
function persistable(launches: Readonly<Record<string, NewTaskLaunch>>): NewTaskLaunch[] {
  return Object.values(launches)
    .filter((launch) => launch.status !== "started")
    .toSorted((left, right) => left.queuedAt.localeCompare(right.queuedAt))
    .slice(-MAX_PERSISTED_LAUNCHES);
}

export interface NewTaskOutboxPersistence {
  /** Loads the stored outbox into the launch store, then keeps it written. */
  readonly hydrate: () => Promise<void>;
  readonly dispose: () => void;
}

/**
 * Bind the outbox to a key-value store. Hydration merges stored launches under
 * any already in memory (a launch started this session wins); every change
 * after it is written back, serialized so an older write never lands last.
 */
export function createNewTaskOutboxPersistence(kv: KVService): NewTaskOutboxPersistence {
  let hydrated = false;
  let disposed = false;
  let lastWritten: string | null = null;
  let writing: Promise<void> = Promise.resolve();

  const write = () => {
    if (!hydrated || disposed) return;
    const launches = persistable(useNewTaskLaunchStore.getState().launchesByKey);
    const serialized =
      launches.length === 0
        ? null
        : JSON.stringify({ version: VERSION, launches } satisfies PersistedOutbox);
    if (serialized === lastWritten) return;
    lastWritten = serialized;
    writing = writing
      .then(() =>
        serialized === null ? kv.removeItem(STORAGE_KEY) : kv.setItem(STORAGE_KEY, serialized),
      )
      .catch(() => {
        // The next change writes the whole outbox again.
        lastWritten = null;
      });
  };

  const unsubscribe = useNewTaskLaunchStore.subscribe(write);

  return {
    hydrate: async () => {
      if (hydrated) return;
      let stored: NewTaskLaunch[] = [];
      try {
        const raw = await kv.getItem(STORAGE_KEY);
        const parsed: unknown = raw === null ? null : JSON.parse(raw);
        if (isRecord(parsed) && parsed.version === VERSION && Array.isArray(parsed.launches)) {
          stored = parsed.launches.flatMap((entry) => readPersistedLaunch(entry) ?? []);
        }
      } catch {
        stored = [];
      }
      hydrated = true;
      if (disposed) return;
      useNewTaskLaunchStore.setState((state) => {
        const launchesByKey = { ...state.launchesByKey };
        for (const launch of stored) launchesByKey[launch.key] ??= launch;
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
}): number {
  let started = 0;
  for (const launch of Object.values(useNewTaskLaunchStore.getState().launchesByKey)) {
    if (launch.status !== "queued") continue;
    const environmentId = launch.attempt.environmentId;
    if (!input.isEnvironmentReady(environmentId)) continue;
    startQueuedNewTaskLaunch(launch.key, input.depsFor(environmentId));
    started += 1;
  }
  return started;
}
