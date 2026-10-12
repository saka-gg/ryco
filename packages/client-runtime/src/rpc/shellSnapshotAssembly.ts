import type {
  OrchestrationShellSnapshotBeginItem,
  OrchestrationShellStreamItem,
  OrchestrationShellSubscriptionItem,
  OrchestrationThreadShell,
} from "@ryco/contracts";

/**
 * Reassembles a paged shell snapshot (`snapshotDelivery: "paged"`) into the
 * single `snapshot` item every shell consumer understands, so the store still
 * applies one snapshot atomically. Every other item passes through as it
 * arrives: an event between two pages is one the server sent before the
 * snapshot completed, exactly as if it had preceded a single `snapshot` item.
 *
 * A server that does not page (an older one) sends `snapshot` items, which
 * pass through unchanged. One assembler serves one subscription attempt; call
 * `reset` when the subscription restarts so a half-received snapshot from the
 * previous attempt can never be completed by the next one.
 */
export interface ShellSnapshotAssembler {
  readonly accept: (
    item: OrchestrationShellStreamItem,
  ) => OrchestrationShellSubscriptionItem | null;
  readonly reset: () => void;
}

export function createShellSnapshotAssembler(
  onIncomplete: (detail: { readonly expected: number; readonly received: number }) => void = (
    detail,
  ) => console.warn("Paged shell snapshot ended with a different thread count", detail),
): ShellSnapshotAssembler {
  let header: OrchestrationShellSnapshotBeginItem | null = null;
  let threads: Array<OrchestrationThreadShell> = [];
  const reset = () => {
    header = null;
    threads = [];
  };
  return {
    reset,
    accept: (item) => {
      switch (item.kind) {
        case "snapshot-begin":
          // A new snapshot supersedes one that never ended.
          header = item;
          threads = [];
          return null;
        case "snapshot-threads":
          if (header === null) return null;
          for (const thread of item.threads) threads.push(thread);
          return null;
        case "snapshot-end": {
          const begun = header;
          const received = threads;
          reset();
          if (begun === null) return null;
          if (received.length !== begun.threadCount) {
            onIncomplete({ expected: begun.threadCount, received: received.length });
          }
          return {
            kind: "snapshot",
            snapshot: {
              snapshotSequence: begun.snapshotSequence,
              projects: begun.projects,
              ...(begun.worktrees === undefined ? {} : { worktrees: begun.worktrees }),
              threads: received,
              updatedAt: begun.updatedAt,
            },
          };
        }
        default:
          return item;
      }
    },
  };
}
