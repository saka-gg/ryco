import type { KVService } from "@ryco/client-runtime/platform";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import * as Schema from "effect/Schema";

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

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const WorktreeKind = Schema.Struct({ kind: Schema.Literals(["local", "existing", "new"]) });

/**
 * The fields a stored entry must have for this build to start it: who it goes
 * to, under which ids, and what it says. Checked, not decoded: the entry is
 * used as stored, so nothing it carries beyond these is lost.
 */
const ReadableStoredLaunch = Schema.Struct({
  key: Schema.String,
  queuedAt: NonEmptyString,
  failure: Schema.NullOr(
    Schema.Struct({
      step: Schema.Literals(["project", "worktree", "thread", "turn"]),
      message: Schema.String,
      deliveryUncertain: Schema.Boolean,
    }),
  ),
  attempt: Schema.Struct({
    environmentId: NonEmptyString,
    threadId: NonEmptyString,
    prompt: Schema.String,
    createdAt: NonEmptyString,
    project: Schema.Struct({ kind: Schema.Literals(["existing", "new", "chat"]) }),
    worktree: WorktreeKind,
    attachments: Schema.Array(Schema.Unknown),
    // A task's chat goes out as the task's: a malformed task id must not turn it into a plain chat.
    localTaskId: Schema.optionalKey(NonEmptyString),
    ids: Schema.Struct({
      projectId: NonEmptyString,
      projectCommandId: NonEmptyString,
      threadId: NonEmptyString,
      threadCommandId: NonEmptyString,
      attachCommandId: NonEmptyString,
      turnCommandId: NonEmptyString,
      messageId: NonEmptyString,
    }),
  }),
  draft: Schema.Struct({ prompt: Schema.String, worktree: WorktreeKind }),
});
const isReadableStoredLaunch = Schema.is(ReadableStoredLaunch);

/** The stored outbox of this version; its entries are read one by one. */
const isStoredOutbox = Schema.is(
  Schema.Struct({ version: Schema.Literal(VERSION), launches: Schema.Array(Schema.Unknown) }),
);

/** What is stored: the draft's images are the attempt's, so they are stored once. */
type StoredLaunch = Omit<NewTaskLaunch, "draft" | "editing"> & {
  readonly draft: Omit<NewTaskLaunch["draft"], "attachments">;
};

function toStoredLaunch(launch: NewTaskLaunch): StoredLaunch {
  const { editing: _editing, draft, ...rest } = launch;
  const { attachments: _attachments, ...storedDraft } = draft;
  return { ...rest, draft: storedDraft };
}

/**
 * Whether a stored entry still has the shape this build reads. A malformed or
 * foreign entry is dropped rather than half-trusted: the worst case is a task
 * the user writes again, never one sent with fields this build cannot check.
 */
function readPersistedLaunch(value: unknown): NewTaskLaunch | null {
  if (!isReadableStoredLaunch(value)) return null;
  // The rest of the entry is as this build's outbox wrote it.
  const stored = value as unknown as StoredLaunch;
  if (stored.key !== newTaskLaunchKey(stored.attempt.environmentId, stored.attempt.threadId)) {
    return null;
  }
  const failure = value.failure;
  const launch: NewTaskLaunch = {
    ...stored,
    failure,
    fromOutbox: true,
    draft: {
      ...stored.draft,
      // The images went out with the attempt; the draft shows them again. A
      // streamed file's bytes are not kept, so an edited task attaches it again.
      attachments: stored.attempt.attachments.flatMap((attachment, index) =>
        attachment.type === "image" && attachment.dataUrl
          ? [
              {
                type: "image" as const,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                dataUrl: attachment.dataUrl,
                id: `${stored.key}:attachment-${index}`,
                previewUri: attachment.dataUrl,
              },
            ]
          : [],
      ),
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
      if (isStoredOutbox(parsed)) {
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
