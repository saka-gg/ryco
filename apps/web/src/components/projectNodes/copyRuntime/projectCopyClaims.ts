// FILE: projectCopyClaims.ts
// Purpose: Decides which window of this browser runs a copy. The job records
//          live in shared localStorage (direct and Desktop builds), so every
//          window's start-up resume sees every record. A copy, or an Agent
//          Control approval, is run, resumed, cleaned up or reported only by
//          the window that holds its claim. A claim is a Web Lock held for as
//          long as that run lives, released by the browser when the window
//          closes. Without Web Locks (a direct build opened over plain HTTP on
//          the LAN, where they are not exposed, or an older browser) it is a
//          lease in that same localStorage, renewed while the run lives:
//          claims are shared exactly as widely as the records they guard.
// Layer: Web copy runtime, loaded with `copyManager`.

import {
  createInMemoryProjectCopyClaims,
  type ProjectCopyClaim,
  type ProjectCopyClaims,
} from "@ryco/client-runtime/projectCopy/manager";

import { appLocalStorage } from "../../../hooks/useLocalStorage";
import { randomUUID } from "../../../lib/utils";

export type { ProjectCopyClaim, ProjectCopyClaims };

const LOCK_PREFIX = "ryco:project-copy:";

function onceClaim(release: () => void): ProjectCopyClaim {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      release();
    },
  };
}

/** Claims this window keeps to itself (one holder per key here; other windows don't see them). */
export const createWindowProjectCopyClaims = createInMemoryProjectCopyClaims;

// ── Leases in storage ──

/** Where lease claims are kept; one item per claimed key. */
export type ProjectCopyClaimStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

export interface StorageProjectCopyClaimsOptions {
  /** Default: the storage the job records are kept in. */
  readonly storage?: ProjectCopyClaimStorage;
  readonly now?: () => number;
  /** How long a lease outlives its last renewal (a window that crashed lets go then). */
  readonly leaseMs?: number;
  readonly renewEveryMs?: number;
  /** How long a claim waits for a competing window's write to arrive before it reads its lease back. */
  readonly settleMs?: number;
  /** Calls `listener` when this page goes away for good; default: a `pagehide` that is not kept. */
  readonly onPageHide?: (listener: () => void) => void;
}

const LEASE_PREFIX = "ryco:project-copy-claim:v1:";
/**
 * A hidden tab's timers can be held to one wake-up a minute (Chrome's
 * intensive throttling), so a lease outlives three of them. A window that
 * closes or reloads lets go at once (`pagehide`); only one that crashed keeps
 * its copies from the other windows until then.
 */
const LEASE_MS = 3 * 60_000;
const RENEW_EVERY_MS = 30_000;
/** Longer than another window's write takes to reach this one's storage. */
const SETTLE_MS = 200;

interface Lease {
  readonly token: string;
  readonly expiresAt: number;
}

function readLease(storage: ProjectCopyClaimStorage, itemKey: string): Lease | null {
  const raw = storage.getItem(itemKey);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { token, expiresAt } = parsed as Partial<Record<keyof Lease, unknown>>;
    return typeof token === "string" && typeof expiresAt === "number" ? { token, expiresAt } : null;
  } catch {
    // Unreadable: nobody holds it.
    return null;
  }
}

function writeLease(storage: ProjectCopyClaimStorage, itemKey: string, lease: Lease): void {
  storage.setItem(itemKey, JSON.stringify(lease));
}

function subscribePageHide(listener: () => void): void {
  if (typeof window === "undefined") return;
  window.addEventListener("pagehide", (event) => {
    // A page kept for back/forward comes back with its runs: it renews its leases then.
    if (!event.persisted) listener();
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

/**
 * Claims shared with every window of this origin through `storage`, which has
 * no compare-and-set: a claim writes its lease, waits `settleMs`, and holds the
 * key only if its own lease is still the one stored. Of two windows claiming at
 * once, the one whose write the storage keeps last wins in both. Where storage
 * refuses, claims are this window's.
 */
export function createStorageProjectCopyClaims(
  options: StorageProjectCopyClaimsOptions = {},
): ProjectCopyClaims {
  const storage = options.storage ?? appLocalStorage;
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const renewEveryMs = options.renewEveryMs ?? RENEW_EVERY_MS;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const here = createWindowProjectCopyClaims();
  /** This window's leases, by key: each drops its stored lease. */
  const dropLeases = new Map<string, () => void>();
  const isLive = (lease: Lease | null): lease is Lease => lease !== null && lease.expiresAt > now();

  // Leases windows that crashed left behind.
  try {
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const itemKey = storage.key(index);
      if (itemKey?.startsWith(LEASE_PREFIX) && !isLive(readLease(storage, itemKey))) {
        stale.push(itemKey);
      }
    }
    for (const itemKey of stale) storage.removeItem(itemKey);
  } catch {
    // Best effort.
  }
  (options.onPageHide ?? subscribePageHide)(() => {
    for (const drop of Array.from(dropLeases.values())) drop();
  });

  const claimShared = async (
    key: string,
    mine: ProjectCopyClaim,
  ): Promise<ProjectCopyClaim | null> => {
    const itemKey = `${LEASE_PREFIX}${key}`;
    const token = randomUUID();
    const lease = (): Lease => ({ token, expiresAt: now() + leaseMs });
    try {
      if (isLive(readLease(storage, itemKey))) return null;
      writeLease(storage, itemKey, lease());
    } catch (error) {
      console.warn("Storage refuses copy claims; this window claims its copies alone.", error);
      return mine;
    }
    await sleep(settleMs);
    let kept: boolean;
    try {
      kept = readLease(storage, itemKey)?.token === token;
    } catch {
      kept = true;
    }
    if (!kept) return null;

    const ownsLease = () => readLease(storage, itemKey)?.token === token;
    const renew = () => {
      try {
        const current = readLease(storage, itemKey);
        // Another window took it after this one's lease ran out (a long sleep): it is that window's.
        if (isLive(current) && current.token !== token) return;
        writeLease(storage, itemKey, lease());
      } catch {
        // The next renewal tries again.
      }
    };
    const dropLease = () => {
      try {
        if (ownsLease()) storage.removeItem(itemKey);
      } catch {
        // It runs out by itself.
      }
    };
    const timer = globalThis.setInterval(renew, renewEveryMs);
    dropLeases.set(key, dropLease);
    return onceClaim(() => {
      globalThis.clearInterval(timer);
      if (dropLeases.get(key) === dropLease) dropLeases.delete(key);
      dropLease();
      mine.release();
    });
  };

  return {
    tryClaim: async (key) => {
      // One claim of a key at a time in this window, while its lease is being taken too.
      const mine = await here.tryClaim(key);
      if (mine === null) return null;
      const claimed = await claimShared(key, mine);
      if (claimed === null) mine.release();
      return claimed;
    },
  };
}

// ── Web Locks ──

type LockRequest = (
  name: string,
  options: { readonly ifAvailable: true },
  callback: (lock: unknown) => Promise<void> | undefined,
) => Promise<unknown>;

/**
 * Claims shared by every window of this origin: Web Locks (`navigator.locks`)
 * where the browser has them, else (`fallback`, by default) leases in the
 * storage the records are kept in. Web Locks are only exposed to secure
 * contexts, so a direct build opened over plain HTTP at a LAN address claims
 * through storage, as does a window whose lock requests are refused.
 */
export function createProjectCopyClaims(
  request: LockRequest | null = defaultLockRequest(),
  fallback?: ProjectCopyClaims,
): ProjectCopyClaims {
  let fallbackClaims = fallback;
  const fallbackClaim = (key: string) => {
    fallbackClaims ??= createStorageProjectCopyClaims();
    return fallbackClaims.tryClaim(key);
  };
  if (request === null) return { tryClaim: fallbackClaim };
  // A released lock is free only once its request settled: a claim this window
  // makes again right after letting go waits for that, instead of finding it held.
  const releasing = new Map<string, Promise<void>>();
  const claimOnce = (key: string) =>
    new Promise<ProjectCopyClaim | null>((resolve) => {
      let answered = false;
      let settled: Promise<void> = Promise.resolve();
      settled = request(`${LOCK_PREFIX}${key}`, { ifAvailable: true }, (lock) => {
        answered = true;
        if (lock === null) {
          resolve(null);
          return undefined;
        }
        // Held until released: the lock request settles only then.
        return new Promise<void>((release) =>
          resolve(
            onceClaim(() => {
              const done = settled.finally(() => {
                if (releasing.get(key) === done) releasing.delete(key);
              });
              releasing.set(key, done);
              release();
            }),
          ),
        );
      }).then(
        () => undefined,
        (error: unknown) => {
          if (answered) return;
          console.warn("Web Locks are unavailable; copies are claimed through storage.", error);
          void fallbackClaim(key).then(resolve);
        },
      );
    });
  return {
    tryClaim: async (key) => {
      await releasing.get(key);
      return claimOnce(key);
    },
  };
}

function defaultLockRequest(): LockRequest | null {
  // Typed as always there; missing outside secure contexts and before Safari 15.4.
  const locks = (globalThis.navigator as Partial<Navigator> | undefined)?.locks;
  if (locks === undefined) return null;
  return (name, options, callback) => locks.request(name, options, callback);
}
