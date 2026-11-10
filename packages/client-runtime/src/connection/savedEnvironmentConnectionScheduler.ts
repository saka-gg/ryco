import type { EnvironmentId } from "@ryco/contracts";

export interface SavedEnvironmentConnectionQueueItem {
  readonly environmentId: EnvironmentId;
  readonly lastConnectedAt?: string | null;
}

export function orderSavedEnvironmentConnectionQueue<T extends SavedEnvironmentConnectionQueueItem>(
  records: ReadonlyArray<T>,
  priorityEnvironmentIds: ReadonlySet<EnvironmentId> = new Set(),
): T[] {
  return [...records].toSorted((left, right) => {
    const leftPriority = priorityEnvironmentIds.has(left.environmentId);
    const rightPriority = priorityEnvironmentIds.has(right.environmentId);
    if (leftPriority !== rightPriority) {
      return leftPriority ? -1 : 1;
    }

    const leftConnectedAt = left.lastConnectedAt ?? "";
    const rightConnectedAt = right.lastConnectedAt ?? "";
    if (leftConnectedAt !== rightConnectedAt) {
      return rightConnectedAt.localeCompare(leftConnectedAt);
    }

    return String(left.environmentId).localeCompare(String(right.environmentId));
  });
}

/**
 * Connects `records` in order, `concurrency` at a time. Each free slot first
 * takes a record `readPriority` names at that moment (the machine of a thread
 * the user just opened), so it never waits behind machines that are asleep.
 */
export async function runSavedEnvironmentConnectionQueue<
  T extends { readonly environmentId: EnvironmentId },
>(
  records: ReadonlyArray<T>,
  options: {
    readonly concurrency: number;
    readonly connect: (record: T) => Promise<void>;
    readonly readPriority?: () => ReadonlySet<EnvironmentId>;
  },
): Promise<void> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const queue = [...records];
  const takeNext = (): T | undefined => {
    const priority = options.readPriority?.();
    const index =
      priority === undefined || priority.size === 0
        ? 0
        : Math.max(
            0,
            queue.findIndex((record) => priority.has(record.environmentId)),
          );
    return queue.splice(index, 1)[0];
  };
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const record = takeNext();
      if (!record) {
        return;
      }
      await options.connect(record);
    }
  });
  await Promise.all(workers);
}
