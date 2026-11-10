/**
 * The app icon badge: how many threads need the person, over every machine
 * (`docs/push-alerts.md`).
 *
 * While the app runs it follows the live counts: each machine the app holds a
 * current connection to writes its own count. A machine that is not live keeps
 * the count its last alert carried (the push extension writes those while the
 * app is closed), and one that is no longer listed is dropped. The native
 * store sums them and sets the badge. A build without that store (a Personal
 * Team build) sets the badge from the live counts alone.
 */

export interface AppBadgeCounts {
  /** "Needs you" per machine the app sees live now (0 included: it clears an older count). */
  readonly live: ReadonlyMap<string, number>;
  /** Every machine the app lists; any other machine's count is dropped. */
  readonly listed: ReadonlyArray<string>;
}

export interface AppBadgePorts {
  readonly native: {
    readonly setBadgeCounts: (
      live: Readonly<Record<string, number>>,
      listed: ReadonlyArray<string>,
    ) => Promise<number>;
    readonly clearBadge: () => Promise<void>;
  } | null;
  /** The plain badge (expo-notifications `setBadgeCountAsync`), without the native store. */
  readonly setBadgeCount: (count: number) => Promise<unknown>;
  readonly onError?: (error: unknown) => void;
}

export interface AppBadge {
  readonly update: (counts: AppBadgeCounts) => void;
  /** Sign-out or alerts off: every count goes and the badge clears. */
  readonly clear: () => Promise<void>;
}

function keyOf(counts: AppBadgeCounts): string {
  return JSON.stringify([
    [...counts.live].toSorted(([left], [right]) => left.localeCompare(right)),
    counts.listed.toSorted(),
  ]);
}

export function createAppBadge(ports: AppBadgePorts): AppBadge {
  const onError =
    ports.onError ?? ((error: unknown) => console.warn("The app badge was not updated.", error));
  /** What was written last; an update with the same counts writes nothing. */
  let written: string | null = null;
  /** Writes run one after another, so the last update is the one that stays. */
  let writes: Promise<void> = Promise.resolve();

  const enqueue = (write: () => Promise<unknown>) => {
    writes = writes.then(write).then(
      () => undefined,
      (error: unknown) => {
        written = null;
        onError(error);
      },
    );
    return writes;
  };

  return {
    update: (counts) => {
      const key = keyOf(counts);
      if (key === written) return;
      written = key;
      const native = ports.native;
      if (native !== null) {
        void enqueue(() => native.setBadgeCounts(Object.fromEntries(counts.live), counts.listed));
        return;
      }
      let total = 0;
      for (const count of counts.live.values()) total += Math.max(0, count);
      void enqueue(() => ports.setBadgeCount(total));
    },
    clear: () => {
      written = null;
      const native = ports.native;
      return enqueue(() => (native !== null ? native.clearBadge() : ports.setBadgeCount(0)));
    },
  };
}
