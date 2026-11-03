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
  SETTINGS_SHARING_STAMP_MAX_AT,
  type SettingsSharingStamp,
} from "@ryco/contracts/settings";

/**
 * How far ahead of this client's wall clock a stamp it observes (or a persisted clock it reads
 * back) may be. Anything further is a broken or hostile writer: following it would push every
 * later stamp of this client there, and one stamp at the maximum would tie them all. A real
 * clock is never a year off; a writer that far ahead keeps its own value on the devices it
 * wrote until a person uses another value everywhere.
 */
export const SETTINGS_SHARING_MAX_CLOCK_LEAD_MS = 366 * 24 * 60 * 60_000;

export interface SettingsSharingClock {
  /** This client's id, the `by` of its stamps (unique per running instance, see below). */
  readonly clientId: string;
  /** Moves the clock past a stamp seen on a device (or in the client's cache). */
  readonly observe: (stamp: SettingsSharingStamp) => void;
  /** A fresh stamp, later than every stamp issued or observed. */
  readonly next: () => SettingsSharingStamp;
  /** The latest `at` issued or observed, for persisting across restarts. */
  readonly last: () => number;
}

function wallClock(now: () => number): number {
  const wall = Math.floor(now());
  return Number.isFinite(wall) ? Math.max(0, wall) : 0;
}

/** Whether an `at` is one a clock may follow: a safe integer, in range, not far ahead of now. */
function followableAt(at: unknown, now: () => number): at is number {
  return (
    typeof at === "number" &&
    Number.isSafeInteger(at) &&
    at > 0 &&
    at <= SETTINGS_SHARING_STAMP_MAX_AT &&
    at <= wallClock(now) + SETTINGS_SHARING_MAX_CLOCK_LEAD_MS
  );
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
  // A persisted clock far ahead (one that followed a hostile stamp before) starts over.
  let last = followableAt(input.initialLast, input.now) ? input.initialLast : 0;
  return {
    clientId,
    observe: (stamp) => {
      if (followableAt(stamp.at, input.now) && stamp.at > last) last = stamp.at;
    },
    next: () => {
      last = Math.min(SETTINGS_SHARING_STAMP_MAX_AT, Math.max(wallClock(input.now), last + 1));
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

/** Separates an install's stored id from the running instance's own part in a stamp's `by`. */
const INSTANCE_SEPARATOR = "~";
const INSTANCE_PART_LENGTH = 12;

/**
 * The `by` of one running instance (a browser tab, an Electron window, an app launch): the
 * install's stored id and a part of its own. Tabs share storage, so with the stored id alone
 * two tabs that saw the same stamp would issue the same next stamp for different values, and
 * the second edit would be dropped as not newer.
 */
export function settingsSharingInstanceId(storedId: string, instancePart: string): string {
  const part = instancePart.replace(/[^0-9a-z]/gi, "").slice(0, INSTANCE_PART_LENGTH) || "0";
  const room = SETTINGS_SHARING_ID_MAX_LENGTH - INSTANCE_SEPARATOR.length - part.length;
  return `${storedId.slice(0, room)}${INSTANCE_SEPARATOR}${part}`;
}

/**
 * One namespace's persisted client id, clock and cache store, for `createSettingsSharingRunner`.
 * The clock's `by` is the stored id plus a part of this instance's own
 * (`settingsSharingInstanceId`). Its last stamp is shared through storage: each fresh stamp
 * first reads the stored one (another tab's), and each newer stamp is stored unless storage
 * already holds a later one, so a clock set back after a restart, or a tab that has not seen
 * another tab's edit, stays monotonic.
 */
export function createScopedSettingsSharingPersistence(input: {
  readonly storage: SettingsSharingStorage;
  readonly namespace: SettingsSharingNamespace;
  readonly now: () => number;
  readonly generateId: () => string;
}): {
  readonly clock: SettingsSharingClock;
  readonly cache: {
    readonly read: () => unknown;
    readonly write: (cache: unknown) => void;
    /** Forgets the cache and the clock (an account's sign-out). */
    readonly clear: () => void;
  };
} {
  const { storage } = input;
  const keys = settingsSharingStorageKeys(input.namespace);
  let storedId: string;
  try {
    storedId = resolveSettingsSharingClientId({
      read: () => readJson(storage, keys.clientId),
      write: (id) => writeJson(storage, keys.clientId, id),
      generate: input.generateId,
    });
  } catch {
    storedId = input.generateId();
  }
  const readStoredLast = (): number | undefined => {
    const stored = readJson(storage, keys.clockLast);
    return typeof stored === "number" ? stored : undefined;
  };
  const storedLast = readStoredLast();
  const inner = createSettingsSharingClock({
    clientId: settingsSharingInstanceId(storedId, input.generateId()),
    now: input.now,
    ...(storedLast === undefined ? {} : { initialLast: storedLast }),
  });
  let persisted = inner.last();
  const persist = () => {
    const last = inner.last();
    if (last <= persisted) return;
    persisted = last;
    const stored = readStoredLast();
    if (stored !== undefined && stored >= last) return;
    writeJson(storage, keys.clockLast, last);
  };
  /** Follows another instance's later stamp (a tab sharing this storage). */
  const followStored = () => {
    const stored = readStoredLast();
    if (stored !== undefined) inner.observe({ at: stored, by: inner.clientId });
  };
  const clock: SettingsSharingClock = {
    clientId: inner.clientId,
    observe: (stamp) => {
      inner.observe(stamp);
      persist();
    },
    next: () => {
      followStored();
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
      clear: () => clearSettingsSharingNamespace(storage, input.namespace),
    },
  };
}

/** Storage that can also remove a key (`localStorage`, the mobile kv-store). */
export interface RemovableSettingsSharingStorage extends SettingsSharingStorage {
  readonly removeItem: (key: string) => void;
}

/**
 * Forgets one namespace's newest-value cache and clock (an account's sign-out: the cache holds
 * values of that account's nodes). The client id stays: it names no one and is not secret.
 */
export function clearSettingsSharingNamespace(
  storage: SettingsSharingStorage | RemovableSettingsSharingStorage,
  namespace: SettingsSharingNamespace,
): void {
  const keys = settingsSharingStorageKeys(namespace);
  for (const key of [keys.cache, keys.clockLast]) {
    try {
      if ("removeItem" in storage) storage.removeItem(key);
      else storage.setItem(key, "null");
    } catch {
      // Unavailable storage holds nothing to forget.
    }
  }
}
