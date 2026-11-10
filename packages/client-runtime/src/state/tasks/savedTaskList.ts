/**
 * A device's saved copy of one machine's last read task list: the one
 * definition the phone (`apps/mobile` taskCache) and the Mac (the Desktop's
 * encrypted per-machine cache) keep and read back. Display only: it fills the
 * shared task store while nothing was read from the machine in this session,
 * and a live read replaces it. Devices keep it under the same rules and the
 * same setting as their recent conversations, and never in the hosted service
 * worker. Its own subpath, off every first download, and free of runtime
 * imports beyond the task schema, so the Desktop main process reads it too.
 *
 * @module savedTaskList
 */
import type { EnvironmentId, LocalTask } from "@ryco/contracts";
import { LocalTask as LocalTaskSchema } from "@ryco/contracts/local-tasks";
import * as Schema from "effect/Schema";

import type { LocalTasksStoreState } from "./store.ts";

export const SAVED_TASK_LIST_VERSION = 1;
/** Most tasks kept per machine: open ones first, then the latest done ones. */
export const SAVED_TASK_LIST_MAX_TASKS = 400;
/** Most bytes one machine's copy may take (as JSON); a bigger list is not kept. */
export const SAVED_TASK_LIST_MAX_BYTES = 1_000_000;

export interface SavedTaskList {
  readonly version: number;
  /** When the copy was read from the machine (ms since the epoch). */
  readonly readAt: number;
  readonly tasks: ReadonlyArray<LocalTask>;
}

const isLocalTask = Schema.is(LocalTaskSchema);

/** The copy kept of a machine's tasks, or null when it would be too large. */
export function boundSavedTaskList(
  tasks: ReadonlyArray<LocalTask>,
  readAt: number,
): SavedTaskList | null {
  const open = tasks.filter((task) => task.state !== "done");
  const done = tasks
    .filter((task) => task.state === "done")
    .toSorted((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
  const saved: SavedTaskList = {
    version: SAVED_TASK_LIST_VERSION,
    readAt,
    tasks: [...open, ...done].slice(0, SAVED_TASK_LIST_MAX_TASKS),
  };
  return JSON.stringify(saved).length > SAVED_TASK_LIST_MAX_BYTES ? null : saved;
}

/** A copy as this build reads it (it is untrusted); tasks it cannot read are left out. */
export function decodeSavedTaskList(value: unknown): SavedTaskList | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== SAVED_TASK_LIST_VERSION) return null;
  if (typeof record.readAt !== "number" || !Number.isFinite(record.readAt)) return null;
  if (!Array.isArray(record.tasks)) return null;
  return {
    version: SAVED_TASK_LIST_VERSION,
    readAt: record.readAt,
    tasks: record.tasks.slice(0, SAVED_TASK_LIST_MAX_TASKS).filter(isLocalTask),
  };
}

/** The stored text of a copy (string stores), or null when it would be too large. */
export function encodeSavedTaskList(
  tasks: ReadonlyArray<LocalTask>,
  readAt: number,
): string | null {
  const saved = boundSavedTaskList(tasks, readAt);
  return saved === null ? null : JSON.stringify(saved);
}

/** A copy read back from a string store. */
export function parseSavedTaskList(raw: string | null): SavedTaskList | null {
  if (raw === null) return null;
  try {
    return decodeSavedTaskList(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/**
 * Shows a machine's saved copy in the task store while nothing was read from
 * it in this session (offline, or before its first read lands). Returns
 * whether it was applied. A live read, before or after, wins: it is newer
 * than any copy.
 */
export function applySavedTaskList(
  store: { readonly getState: () => LocalTasksStoreState },
  environmentId: EnvironmentId,
  saved: SavedTaskList,
): boolean {
  const state = store.getState();
  const current = state.byEnvironment[environmentId];
  if ((current?.readAt ?? null) !== null || saved.tasks.length === 0) return false;
  state.applyList(environmentId, saved.tasks, {
    since: current?.writeEpoch ?? 0,
    readAt: saved.readAt,
  });
  return true;
}
