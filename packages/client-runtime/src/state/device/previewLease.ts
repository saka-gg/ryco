/**
 * Per-tab arbitration for hosted (relay) device previews.
 *
 * A hosted preview samples full PNG screenshots over its node's relay channel,
 * so two previews sampling at once (split panes, two nodes) double the traffic
 * of the tab. Only the lease holder samples; every other visible preview shows
 * a paused state until it is interacted with or the holder lets go.
 *
 * Owners register while they want to sample (visible and not idle) and release
 * when they stop. The holder is the owner that interacted most recently. Owners
 * that never interacted rank below any that did, and are ordered by how
 * recently they acquired. Releasing the holder hands the lease to the best
 * remaining owner.
 *
 * An owner's last interaction outlives its registrations, so hiding and showing
 * a tab (every preview releases, then acquires again) leaves the preview the
 * user was working with in front. `forgetHostedPreviewOwner` ends that memory.
 */

export type HostedPreviewLeaseListener = () => void;

export interface HostedPreviewLease {
  /**
   * Whether the owner held the lease right after acquiring. Later changes are
   * delivered through `subscribeHostedPreviewLease`.
   */
  readonly granted: boolean;
  /** Idempotent. Hands the lease on when the owner was the holder. */
  release(): void;
}

interface LeaseEntry {
  readonly ownerId: string;
  readonly acquiredAt: number;
}

const entries = new Map<string, LeaseEntry>();
/** Logical time of each owner's last interaction; absent until it interacts. */
const interactions = new Map<string, number>();
const listeners = new Set<HostedPreviewLeaseListener>();
let clock = 0;
let holder: string | null = null;

function outranks(candidate: LeaseEntry, other: LeaseEntry): boolean {
  const candidateInteractedAt = interactions.get(candidate.ownerId) ?? 0;
  const otherInteractedAt = interactions.get(other.ownerId) ?? 0;
  if (candidateInteractedAt !== otherInteractedAt) return candidateInteractedAt > otherInteractedAt;
  return candidate.acquiredAt > other.acquiredAt;
}

function electHolder(): string | null {
  let best: LeaseEntry | null = null;
  for (const entry of entries.values()) {
    if (best === null || outranks(entry, best)) best = entry;
  }
  return best?.ownerId ?? null;
}

function reelect(): void {
  const next = electHolder();
  if (next === holder) return;
  holder = next;
  // Listeners read the current holder themselves: one may re-enter and change
  // it while the rest are still being notified.
  for (const listener of listeners) listener();
}

export function acquireHostedPreviewLease(ownerId: string): HostedPreviewLease {
  const entry: LeaseEntry = { ownerId, acquiredAt: ++clock };
  entries.set(ownerId, entry);
  reelect();
  return {
    granted: holder === ownerId,
    release() {
      // A newer acquisition by the same owner replaces this entry.
      if (entries.get(ownerId) !== entry) return;
      entries.delete(ownerId);
      reelect();
    },
  };
}

/** Makes a registered owner the holder. Owners without a lease are ignored. */
export function noteHostedPreviewInteraction(ownerId: string): void {
  if (!entries.has(ownerId)) return;
  interactions.set(ownerId, ++clock);
  reelect();
}

/**
 * Releases the owner's lease, if any, and drops its interaction history. For
 * owners that are going away; a plain release keeps the history.
 */
export function forgetHostedPreviewOwner(ownerId: string): void {
  interactions.delete(ownerId);
  if (entries.delete(ownerId)) reelect();
}

export function readHostedPreviewLeaseHolder(): string | null {
  return holder;
}

/** Notified whenever the holder changes. Returns an unsubscribe. */
export function subscribeHostedPreviewLease(listener: HostedPreviewLeaseListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clears every owner and listener so tests start from an empty tab. */
export function resetHostedPreviewLeaseForTests(): void {
  entries.clear();
  interactions.clear();
  listeners.clear();
  holder = null;
  clock = 0;
}
