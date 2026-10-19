import * as FSSync from "node:fs";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type { CachedThreadContent } from "@ryco/client-runtime/state/threads";
import {
  THREAD_CONTENT_CACHE_MAX_THREADS,
  THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
  decodeCachedEnvironmentContent,
  measureRecordBodyBytes,
  trimContentToBudget,
  utf8ByteLength,
} from "@ryco/client-runtime/state/threads/threadContentCachePolicy";
import type { WorkspaceMetadataCache } from "@ryco/client-runtime/state/workspace";

import type { DesktopSecretProtection } from "./protectedRecordStore.ts";

const DOCUMENT_VERSION = 1 as const;
const CACHE_FILE_NAME = "thread-content-v1.enc";
const SETTINGS_FILE_NAME = "thread-content-settings.json";
const FILE_HEADER = "ryco-desktop-thread-content-v1\n";
/** The largest cache file read back; a full cache encodes well below this. */
const MAX_CACHE_FILE_BYTES = 16 * 1024 * 1024;
const BOUNDED_ID_LENGTH = 2_048;

/** Environments whose content the file keeps; the least recently updated one is dropped first. */
export const DESKTOP_THREAD_CONTENT_CACHE_MAX_ENVIRONMENTS = 3;
/** Whether recent conversations are kept on this device until the user chooses. */
export const DESKTOP_THREAD_CONTENT_CACHE_DEFAULT_ENABLED = true;

/** A burst of changes is written once, after this much quiet... */
const WRITE_DEBOUNCE_MS = 2_000;
/** ...but never later than this after the first unwritten change. */
const WRITE_MAX_WAIT_MS = 10_000;

export interface DesktopThreadContentScope {
  readonly accountId: string;
  readonly environmentId: string;
}

export type DesktopThreadContent = Readonly<Record<string, CachedThreadContent>>;

interface StoredRecord extends DesktopThreadContentScope {
  /** When this environment's content was last updated. */
  readonly capturedAt: number;
  /** Thread content, least recently visited first. */
  readonly content: DesktopThreadContent;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= BOUNDED_ID_LENGTH;
}

function recordKey(scope: DesktopThreadContentScope): string {
  return `${scope.accountId}\0${scope.environmentId}`;
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/gu, "").toLowerCase();
}

/**
 * The content a record may hold: threads the policy accepts, the most recent
 * ones if there are too many, and few enough to keep the record within its
 * budget. Used for what the renderer sends and for what is read back from disk.
 */
function boundContent(
  record: DesktopThreadContentScope & { readonly capturedAt: number },
  content: unknown,
): DesktopThreadContent {
  if (typeof content !== "object" || content === null || Array.isArray(content)) return {};
  // Threads arrive least recently visited first, so any excess is dropped from the front.
  const recent = Object.fromEntries(
    Object.entries(content).slice(-THREAD_CONTENT_CACHE_MAX_THREADS),
  );
  const decoded = decodeCachedEnvironmentContent({ content: recent }, new Set(Object.keys(recent)));
  const entries = Object.entries(decoded).map(([threadId, thread]) => ({
    threadId,
    thread,
    // The same measure as a captured thread: its serialized `"id":content` entry.
    entryBytes:
      utf8ByteLength(JSON.stringify(threadId)) + 1 + utf8ByteLength(JSON.stringify(thread)),
  }));
  return Object.fromEntries(
    trimContentToBudget({
      bodyBytes: measureRecordBodyBytes({
        accountId: record.accountId,
        environmentId: record.environmentId,
        capturedAt: record.capturedAt,
      }),
      entries,
      budgetBytes: THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
    }).map((entry) => [entry.threadId, entry.thread]),
  );
}

/** A record read back from disk is untrusted: its envelope and every thread are validated. */
function readStoredRecord(value: unknown): StoredRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Partial<StoredRecord>;
  if (
    !isBoundedId(record.accountId) ||
    !isBoundedId(record.environmentId) ||
    !Number.isSafeInteger(record.capturedAt) ||
    Number(record.capturedAt) < 0
  ) {
    return null;
  }
  const envelope = {
    accountId: record.accountId,
    environmentId: record.environmentId,
    capturedAt: Number(record.capturedAt),
  };
  const content = boundContent(envelope, record.content);
  return Object.keys(content).length === 0 ? null : { ...envelope, content };
}

/** How many threads a stored record claims to hold, before validation. */
function threadCount(record: unknown): number {
  const content = (record as { content?: unknown } | null)?.content;
  return typeof content === "object" && content !== null ? Object.keys(content).length : 0;
}

interface LoadedRecords {
  readonly records: ReadonlyArray<StoredRecord>;
  /** The file held content that `records` does not: discarded records or an unusable file. */
  readonly discarded: boolean;
}

const NO_RECORDS: LoadedRecords = { records: [], discarded: false };

export interface DesktopThreadContentCache {
  /** The device setting; until the user chooses, the default. */
  readonly isEnabled: () => Promise<boolean>;
  /** Turning the cache off deletes what it holds. */
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  /** The saved content of an environment, or none while the cache is off. */
  readonly load: (scope: DesktopThreadContentScope) => Promise<DesktopThreadContent>;
  /**
   * Replaces an environment's saved content with `content`, bounded to the
   * policy. Ignored while the cache is off or encryption is unavailable, and
   * anything beyond the environment cap, or from another account, is dropped.
   */
  readonly publish: (scope: DesktopThreadContentScope, content: unknown) => Promise<void>;
  readonly purgeEnvironment: (scope: DesktopThreadContentScope) => Promise<void>;
  readonly purgeAccount: (accountId: string) => Promise<void>;
  /** Forgets every account's content but this one's: an identity change drops the previous account's. */
  readonly retainAccount: (accountId: string) => Promise<void>;
  /** Writes any change that is still waiting for its quiet period. */
  readonly flush: () => Promise<void>;
  /** Flushes, then writes every later change at once instead of deferring it. */
  readonly dispose: () => Promise<void>;
}

/**
 * Desktop UI-client display content: recent conversation text, kept so a cold
 * start can paint a thread before the relay is up. Never a replay baseline or
 * authority. Callers place `directory` below the dedicated
 * `desktop-workspace-client` directory, never in the backend/node namespace.
 *
 * The file is a single document encrypted with the OS-protected key, and is
 * never written while encryption is unavailable. It holds at most
 * `DESKTOP_THREAD_CONTENT_CACHE_MAX_ENVIRONMENTS` environments of one account,
 * each within the shared policy's record budget. The in-memory document is
 * authoritative; a change is written after a quiet period (or at most a maximum
 * wait after the first unwritten change). A purge is written at once, and so is
 * anything still unwritten when the process exits.
 *
 * Whether the cache runs is a device setting kept in a plain file beside it.
 */
export function createDesktopThreadContentCache(input: {
  readonly directory: string;
  readonly hubOrigin: string;
  readonly protection: DesktopSecretProtection;
  readonly now?: () => number;
}): DesktopThreadContentCache {
  const cachePath = Path.join(input.directory, CACHE_FILE_NAME);
  const settingsPath = Path.join(input.directory, SETTINGS_FILE_NAME);
  const hubOrigin = normalizeOrigin(input.hubOrigin);
  const now = input.now ?? Date.now;

  let pending: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const run = pending.then(operation, operation);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const encode = (records: ReadonlyArray<StoredRecord>): string => {
    if (!input.protection.isEncryptionAvailable()) {
      throw new Error("Desktop thread content cannot be encrypted.");
    }
    const encrypted = input.protection.encryptString(
      JSON.stringify({ version: DOCUMENT_VERSION, hubOrigin, records }),
    );
    try {
      return `${FILE_HEADER}${encrypted.toString("base64")}\n`;
    } finally {
      encrypted.fill(0);
    }
  };

  const decode = (stored: string): LoadedRecords | null => {
    if (!stored.startsWith(FILE_HEADER) || !input.protection.isEncryptionAvailable()) return null;
    const encrypted = Buffer.from(stored.slice(FILE_HEADER.length).trim(), "base64");
    try {
      const value = JSON.parse(input.protection.decryptString(encrypted)) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const document = value as { version?: unknown; hubOrigin?: unknown; records?: unknown };
      if (
        document.version !== DOCUMENT_VERSION ||
        document.hubOrigin !== hubOrigin ||
        !Array.isArray(document.records)
      ) {
        return null;
      }
      const unique = new Map<string, StoredRecord>();
      let incomplete = false;
      for (const candidate of document.records) {
        const record = readStoredRecord(candidate);
        if (record === null || Object.keys(record.content).length < threadCount(candidate)) {
          incomplete = true;
        }
        if (record === null) continue;
        const key = recordKey(record);
        const current = unique.get(key);
        if (!current || record.capturedAt > current.capturedAt) unique.set(key, record);
      }
      const records = Array.from(unique.values())
        .toSorted((left, right) => left.capturedAt - right.capturedAt)
        .slice(-DESKTOP_THREAD_CONTENT_CACHE_MAX_ENVIRONMENTS);
      return { records, discarded: incomplete || records.length !== document.records.length };
    } catch {
      return null;
    } finally {
      encrypted.fill(0);
    }
  };

  async function readRecords(): Promise<LoadedRecords> {
    let stored: string;
    try {
      if ((await FS.stat(cachePath)).size > MAX_CACHE_FILE_BYTES) {
        return { records: [], discarded: true };
      }
      stored = await FS.readFile(cachePath, "utf8");
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
      return missing ? NO_RECORDS : { records: [], discarded: true };
    }
    return decode(stored) ?? { records: [], discarded: true };
  }

  async function writeRecords(records: ReadonlyArray<StoredRecord>): Promise<void> {
    if (records.length === 0) {
      await FS.rm(cachePath, { force: true });
      return;
    }
    const body = encode(records);
    const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    await FS.mkdir(input.directory, { recursive: true, mode: 0o700 });
    try {
      await FS.writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await FS.rename(temporary, cachePath);
    } finally {
      await FS.rm(temporary, { force: true });
    }
  }

  /** The same write for the moment the process exits, when nothing can be awaited. */
  function writeRecordsSync(records: ReadonlyArray<StoredRecord>): void {
    if (records.length === 0) {
      FSSync.rmSync(cachePath, { force: true });
      return;
    }
    const body = encode(records);
    const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    FSSync.mkdirSync(input.directory, { recursive: true, mode: 0o700 });
    try {
      FSSync.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
      FSSync.renameSync(temporary, cachePath);
    } finally {
      FSSync.rmSync(temporary, { force: true });
    }
  }

  let cached: ReadonlyArray<StoredRecord> | undefined;
  // The file holds something the document does not, until the next write replaces it.
  let diskHoldsDiscarded = false;
  const read = async (): Promise<ReadonlyArray<StoredRecord>> => {
    if (cached === undefined) {
      const loaded = await readRecords();
      cached = loaded.records;
      diskHoldsDiscarded = loaded.discarded;
    }
    return cached;
  };

  // A change bumps `revision`; a completed write records the revision it held.
  let revision = 0;
  let written = 0;
  let disposed = false;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let exitHooked = false;

  const writeBeforeExit = () => {
    if (cached === undefined || revision === written) return;
    try {
      writeRecordsSync(cached);
      written = revision;
    } catch {
      // The file written last stays valid.
    }
  };
  /** The exit hook is installed exactly while a change is not yet in the file. */
  const syncExitHook = () => {
    const unwritten = cached !== undefined && revision !== written;
    if (unwritten && !exitHooked) process.on("exit", writeBeforeExit);
    if (!unwritten && exitHooked) process.off("exit", writeBeforeExit);
    exitHooked = unwritten;
  };
  const cancelDeferredWrite = () => {
    clearTimeout(quietTimer);
    clearTimeout(maxWaitTimer);
    quietTimer = undefined;
    maxWaitTimer = undefined;
  };
  const writeInBackground = () => {
    void exclusive(writePending).catch(() => undefined);
  };
  const deferWrite = (quietMs: number, maxWaitMs: number) => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(writeInBackground, quietMs);
    quietTimer.unref?.();
    if (maxWaitTimer === undefined) {
      maxWaitTimer = setTimeout(writeInBackground, maxWaitMs);
      maxWaitTimer.unref?.();
    }
  };

  /** Writes the current document if it holds changes. Callers hold the exclusive lane. */
  async function writePending(): Promise<void> {
    cancelDeferredWrite();
    if (cached === undefined || revision === written) {
      syncExitHook();
      return;
    }
    const records = cached;
    const target = revision;
    try {
      await writeRecords(records);
    } catch (error) {
      // Keep the change and try again later; the caller still learns of the failure.
      if (!disposed) deferWrite(WRITE_MAX_WAIT_MS, WRITE_MAX_WAIT_MS);
      throw error;
    }
    written = target;
    diskHoldsDiscarded = false;
    syncExitHook();
  }

  /** Callers hold the exclusive lane. */
  const commit = async (
    records: ReadonlyArray<StoredRecord>,
    mode: "deferred" | "immediate",
  ): Promise<void> => {
    cached = records;
    revision += 1;
    syncExitHook();
    if (mode === "immediate" || disposed) await writePending();
    else deferWrite(WRITE_DEBOUNCE_MS, WRITE_MAX_WAIT_MS);
  };

  /**
   * A purge that finds nothing to remove writes nothing, unless the file still
   * holds records the reader discarded, which a purge must not leave behind.
   */
  const purge = async (keep: (record: StoredRecord) => boolean): Promise<void> => {
    const existing = await read();
    const records = existing.filter(keep);
    if (records.length === existing.length && !diskHoldsDiscarded) return;
    await commit(records, "immediate");
  };

  let enabledSetting: boolean | undefined;
  let settingsRead = false;
  /** Callers hold the exclusive lane. */
  const enabled = async (): Promise<boolean> => {
    if (!settingsRead) {
      settingsRead = true;
      try {
        const value = JSON.parse(await FS.readFile(settingsPath, "utf8")) as {
          version?: unknown;
          enabled?: unknown;
        } | null;
        enabledSetting =
          value?.version === DOCUMENT_VERSION && typeof value.enabled === "boolean"
            ? value.enabled
            : undefined;
      } catch {
        enabledSetting = undefined;
      }
    }
    return enabledSetting ?? DESKTOP_THREAD_CONTENT_CACHE_DEFAULT_ENABLED;
  };
  const writeEnabled = async (value: boolean): Promise<void> => {
    const temporary = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
    await FS.mkdir(input.directory, { recursive: true, mode: 0o700 });
    try {
      await FS.writeFile(
        temporary,
        `${JSON.stringify({ version: DOCUMENT_VERSION, enabled: value })}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
      await FS.rename(temporary, settingsPath);
    } finally {
      await FS.rm(temporary, { force: true });
    }
  };

  return {
    isEnabled: () => exclusive(enabled),
    setEnabled: (value) =>
      exclusive(async () => {
        settingsRead = true;
        if (value) {
          await writeEnabled(true);
          enabledSetting = true;
          return;
        }
        // Off first: nothing is kept from here on, even if the setting cannot be saved.
        enabledSetting = false;
        await purge(() => false);
        await writeEnabled(false);
      }),
    load: (scope) =>
      exclusive(async () => {
        if (!(await enabled())) return {};
        const key = recordKey(scope);
        return (await read()).find((record) => recordKey(record) === key)?.content ?? {};
      }),
    publish: (scope, content) =>
      exclusive(async () => {
        if (
          !isBoundedId(scope.accountId) ||
          !isBoundedId(scope.environmentId) ||
          !input.protection.isEncryptionAvailable() ||
          !(await enabled())
        ) {
          return;
        }
        const capturedAt = now();
        const bounded = boundContent({ ...scope, capturedAt }, content);
        const key = recordKey(scope);
        const existing = await read();
        const others = existing.filter(
          (record) => record.accountId === scope.accountId && recordKey(record) !== key,
        );
        if (Object.keys(bounded).length === 0) {
          if (others.length < existing.length) await commit(others, "deferred");
          return;
        }
        await commit(
          [
            ...others,
            {
              accountId: scope.accountId,
              environmentId: scope.environmentId,
              capturedAt,
              content: bounded,
            },
          ].slice(-DESKTOP_THREAD_CONTENT_CACHE_MAX_ENVIRONMENTS),
          "deferred",
        );
      }),
    purgeEnvironment: (scope) =>
      exclusive(() => {
        const key = recordKey(scope);
        return purge((record) => recordKey(record) !== key);
      }),
    purgeAccount: (accountId) => exclusive(() => purge((record) => record.accountId !== accountId)),
    retainAccount: (accountId) =>
      exclusive(() => purge((record) => record.accountId === accountId)),
    flush: () => exclusive(writePending),
    dispose: () =>
      exclusive(async () => {
        disposed = true;
        await writePending();
      }),
  };
}

/**
 * The workspace metadata cache, with the thread content cache forgetting
 * whatever it forgets: a purged environment or account, and every other
 * account's content once an account's metadata is read. The content is
 * display data, so a failure to purge it never fails the metadata operation.
 */
export function withThreadContentPurges(
  metadata: WorkspaceMetadataCache,
  content: Pick<DesktopThreadContentCache, "purgeEnvironment" | "purgeAccount" | "retainAccount">,
): WorkspaceMetadataCache {
  const forget = (purge: () => Promise<void>) => purge().catch(() => undefined);
  return {
    ...metadata,
    list: (account) => {
      // Not awaited: an identity change must not wait for the content file.
      void forget(() => content.retainAccount(account.accountId));
      return metadata.list(account);
    },
    purgeEnvironment: async (namespace) => {
      await Promise.all([
        metadata.purgeEnvironment(namespace),
        forget(() =>
          content.purgeEnvironment({
            accountId: namespace.accountId,
            environmentId: namespace.environmentId,
          }),
        ),
      ]);
    },
    purgeAccount: async (account) => {
      await Promise.all([
        metadata.purgeAccount(account),
        forget(() => content.purgeAccount(account.accountId)),
      ]);
    },
  };
}
