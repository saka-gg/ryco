/**
 * The clock that stamps shared device setting writes: a hybrid logical clock in ms. A stamp is
 * never behind the wall clock, any stamp this client issued, or any stamp it has seen on a
 * device, so a person's edit always orders after everything their client showed them, even
 * when another client's clock runs ahead. Ordering is `(at, by)` (`compareSharingStamps`).
 *
 * Pure apart from the injected wall clock; no DOM or React Native imports.
 */
import {
  SETTINGS_SHARING_ID_MAX_LENGTH,
  type SettingsSharingStamp,
} from "@ryco/contracts/settings";

export interface SettingsSharingClock {
  /** This client's stable id, the `by` of its stamps. */
  readonly clientId: string;
  /** Moves the clock past a stamp seen on a device (or in the client's cache). */
  readonly observe: (stamp: SettingsSharingStamp) => void;
  /** A fresh stamp, later than every stamp issued or observed. */
  readonly next: () => SettingsSharingStamp;
  /** The latest `at` issued or observed, for persisting across restarts. */
  readonly last: () => number;
}

export function createSettingsSharingClock(input: {
  readonly clientId: string;
  /** Wall clock in ms. */
  readonly now: () => number;
  /** A persisted {@link SettingsSharingClock.last}, so a clock set back after a restart stays monotonic. */
  readonly initialLast?: number;
}): SettingsSharingClock {
  const clientId = normalizeSettingsSharingClientId(input.clientId);
  if (clientId === null)
    throw new Error("A settings sharing client id must be a short non-empty string.");
  let last = Number.isSafeInteger(input.initialLast) ? Math.max(0, input.initialLast ?? 0) : 0;
  return {
    clientId,
    observe: (stamp) => {
      if (Number.isSafeInteger(stamp.at) && stamp.at > last) last = stamp.at;
    },
    next: () => {
      const wall = Math.floor(input.now());
      last = Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(Number.isFinite(wall) ? wall : 0, last + 1),
      );
      return { at: last, by: clientId };
    },
    last: () => last,
  };
}

/** A usable client id (trimmed, non-empty, short enough for a stamp), or null. */
export function normalizeSettingsSharingClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= SETTINGS_SHARING_ID_MAX_LENGTH ? trimmed : null;
}

/**
 * This client's stable sharing id: the stored one, else a fresh one (`generate`, e.g.
 * `crypto.randomUUID`) that is stored for next time. Each install of each app has its own.
 */
export function resolveSettingsSharingClientId(input: {
  readonly read: () => unknown;
  readonly write: (clientId: string) => void;
  readonly generate: () => string;
}): string {
  const stored = normalizeSettingsSharingClientId(input.read());
  if (stored !== null) return stored;
  const fresh = normalizeSettingsSharingClientId(input.generate());
  if (fresh === null) throw new Error("Could not create a settings sharing client id.");
  input.write(fresh);
  return fresh;
}

// ── Persistence, scoped per account ─────────────────────────────

/**
 * Whose devices a client's sharing state serves: the devices this app reaches on its own
 * (`local`: the desktop's or browser's own and saved connections), or one Hub account. The
 * client id, the clock and the newest-value cache are kept per namespace, so another account
 * on the same browser never sees this one's id or values, and a cache never crosses accounts.
 */
export type SettingsSharingNamespace =
  | { readonly kind: "local" }
  | { readonly kind: "hosted"; readonly hubOrigin: string; readonly accountId: string };

/** A stable string for a namespace (origin case and trailing slashes ignored). */
export function settingsSharingNamespaceKey(namespace: SettingsSharingNamespace): string {
  if (namespace.kind === "local") return "local";
  return JSON.stringify([
    "hosted",
    namespace.hubOrigin.replace(/\/+$/g, "").toLowerCase(),
    namespace.accountId,
  ]);
}

const STORAGE_PREFIX = "ryco:settings-sharing:v1";

/** The storage keys of one namespace's client id, clock and cache. */
export function settingsSharingStorageKeys(namespace: SettingsSharingNamespace): {
  readonly clientId: string;
  readonly clockLast: string;
  readonly cache: string;
} {
  const scope = settingsSharingNamespaceKey(namespace);
  return {
    clientId: `${STORAGE_PREFIX}:client-id:${scope}`,
    clockLast: `${STORAGE_PREFIX}:clock:${scope}`,
    cache: `${STORAGE_PREFIX}:cache:${scope}`,
  };
}

/** Synchronous string storage (`localStorage` on the web). Errors are the caller's to absorb. */
export interface SettingsSharingStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

function readJson(storage: SettingsSharingStorage, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function writeJson(storage: SettingsSharingStorage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the devices stay authoritative, the cache is a hint.
  }
}

/**
 * One namespace's persisted client id, clock and cache store, for `createSettingsSharingRunner`.
 * The clock persists its last stamp each time it issues or observes a newer one, so a clock set
 * back after a restart stays monotonic.
 */
export function createScopedSettingsSharingPersistence(input: {
  readonly storage: SettingsSharingStorage;
  readonly namespace: SettingsSharingNamespace;
  readonly now: () => number;
  readonly generateId: () => string;
}): {
  readonly clock: SettingsSharingClock;
  readonly cache: { readonly read: () => unknown; readonly write: (cache: unknown) => void };
} {
  const { storage } = input;
  const keys = settingsSharingStorageKeys(input.namespace);
  let clientId: string;
  try {
    clientId = resolveSettingsSharingClientId({
      read: () => readJson(storage, keys.clientId),
      write: (id) => writeJson(storage, keys.clientId, id),
      generate: input.generateId,
    });
  } catch {
    clientId = input.generateId();
  }
  const storedLast = readJson(storage, keys.clockLast);
  const inner = createSettingsSharingClock({
    clientId,
    now: input.now,
    ...(typeof storedLast === "number" ? { initialLast: storedLast } : {}),
  });
  let persisted = inner.last();
  const persist = () => {
    const last = inner.last();
    if (last <= persisted) return;
    persisted = last;
    writeJson(storage, keys.clockLast, last);
  };
  const clock: SettingsSharingClock = {
    clientId: inner.clientId,
    observe: (stamp) => {
      inner.observe(stamp);
      persist();
    },
    next: () => {
      const stamp = inner.next();
      persist();
      return stamp;
    },
    last: inner.last,
  };
  return {
    clock,
    cache: {
      read: () => readJson(storage, keys.cache),
      write: (cache) => writeJson(storage, keys.cache, cache),
    },
  };
}
