import type { LocalTask } from "@ryco/contracts";
import { LocalTask as LocalTaskSchema } from "@ryco/contracts/local-tasks";
import * as Schema from "effect/Schema";

// The phone's copy of a machine's last read task list, shown (read-only) while
// the machine is offline. Pure, so the format and its bounds are testable.

export const TASK_CACHE_VERSION = 1;
/** Most tasks kept per machine: open ones first, then the latest done ones. */
export const TASK_CACHE_MAX_TASKS = 400;
/** Most bytes one machine's copy may take; a bigger list is not kept. */
export const TASK_CACHE_MAX_BYTES = 1_000_000;

export interface StoredTaskList {
  readonly version: number;
  /** When the copy was read from the machine (ms since the epoch). */
  readonly readAt: number;
  readonly tasks: ReadonlyArray<LocalTask>;
}

const isLocalTask = Schema.is(LocalTaskSchema);

/** The stored form of a machine's tasks, or null when it would be too large. */
export function encodeTaskCache(tasks: ReadonlyArray<LocalTask>, readAt: number): string | null {
  const open = tasks.filter((task) => task.state !== "done");
  const done = tasks
    .filter((task) => task.state === "done")
    .toSorted((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
  const kept = [...open, ...done].slice(0, TASK_CACHE_MAX_TASKS);
  const encoded = JSON.stringify({ version: TASK_CACHE_VERSION, readAt, tasks: kept });
  return encoded.length > TASK_CACHE_MAX_BYTES ? null : encoded;
}

/** A stored copy as this build reads it; tasks it cannot read are left out. */
export function decodeTaskCache(raw: string | null): StoredTaskList | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== TASK_CACHE_VERSION || typeof record.readAt !== "number") return null;
  if (!Array.isArray(record.tasks)) return null;
  return {
    version: TASK_CACHE_VERSION,
    readAt: record.readAt,
    tasks: record.tasks.filter(isLocalTask),
  };
}
