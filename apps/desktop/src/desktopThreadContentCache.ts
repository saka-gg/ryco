import * as Crypto from "node:crypto";
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
import {
  boundSavedTaskList,
  decodeSavedTaskList,
  type SavedTaskList,
} from "@ryco/client-runtime/state/tasks/savedTaskList";
import type { WorkspaceMetadataCache } from "@ryco/client-runtime/state/workspace";

import type { DesktopSecretProtection } from "./protectedRecordStore.ts";

const DOCUMENT_VERSION = 1 as const;
/** One file for every environment, read back once and replaced by per-environment files. */
const LEGACY_CACHE_FILE_NAME = "thread-content-v1.enc";
const LEGACY_FILE_HEADER = "ryco-desktop-thread-content-v1\n";
/** One file per environment, so a change re-encrypts and rewrites that environment alone. */
const RECORD_DOCUMENT_VERSION = 2 as const;
const RECORD_FILE_PREFIX = "thread-content-v2-";
const RECORD_FILE_NAME = /^thread-content-v2-[0-9a-f]{32}\.enc$/u;
const RECORD_FILE_HEADER = "ryco-desktop-thread-content-v2\n";
const SETTINGS_FILE_NAME = "thread-content-settings.json";
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
  /** The machine's last read task list (display only), when one was kept. */
  readonly tasks?: SavedTaskList;
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
/** Serialized sizes of validated threads, so unchanged threads are not measured again. */
const entryBytesByThread = new WeakMap<CachedThreadContent, number>();

function measuredEntry(threadId: string, thread: CachedThreadContent) {
  let entryBytes = entryBytesByThread.get(thread);
  if (entryBytes === undefined) {
    // The same measure as a captured thread: its serialized `"id":content` entry.
    entryBytes =
      utf8ByteLength(JSON.stringify(threadId)) + 1 + utf8ByteLength(JSON.stringify(thread));
    entryBytesByThread.set(thread, entryBytes);
  }
  return { threadId, thread, entryBytes };
}

/** Validated threads, least recently visited first, trimmed to the record budget. */
function boundEntries(
  record: DesktopThreadContentScope & { readonly capturedAt: number },
  threads: ReadonlyArray<readonly [string, CachedThreadContent]>,
): DesktopThreadContent {
  return Object.fromEntries(
    trimContentToBudget({
      bodyBytes: measureRecordBodyBytes({
        accountId: record.accountId,
        environmentId: record.environmentId,
        capturedAt: record.capturedAt,
      }),
      entries: threads
        .slice(-THREAD_CONTENT_CACHE_MAX_THREADS)
        .map(([threadId, thread]) => measuredEntry(threadId, thread)),
      budgetBytes: THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
    }).map((entry) => [entry.threadId, entry.thread]),
  );
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
  return boundEntries(record, Object.entries(decoded));
}

/** The file of an environment's record: a digest of its scope, so ids never reach the file system. */
function recordFileName(scope: DesktopThreadContentScope): string {
  const digest = Crypto.createHash("sha256").update(recordKey(scope)).digest("hex");
  return `${RECORD_FILE_PREFIX}${digest.slice(0, 32)}.enc`;
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
  const tasks = record.tasks === undefined ? null : decodeSavedTaskList(record.tasks);
  const hasTasks = tasks !== null && tasks.tasks.length > 0;
  if (Object.keys(content).length === 0 && !hasTasks) return null;
  return { ...envelope, content, ...(hasTasks ? { tasks } : {}) };
}

/** How many threads a stored record claims to hold, before validation. */
function threadCount(record: unknown): number {
  const content = (record as { content?: unknown } | null)?.content;
  return typeof content === "object" && content !== null ? Object.keys(content).length : 0;
}

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
  /**
   * Replaces an environment's saved content with the threads `order` lists:
   * each from `changed` when it is there, otherwise as saved. Resolves to
   * false, changing nothing, when a listed thread is in neither (the sender
   * then publishes every thread), or while the cache is off.
   */
  readonly publishChanges: (
    scope: DesktopThreadContentScope,
    changes: { readonly order: ReadonlyArray<string>; readonly changed: unknown },
  ) => Promise<boolean>;
  /**
   * Replaces the machine's saved task list (`SavedTaskList`, untrusted) kept
   * beside its conversations, under the same setting and purges. Resolves to
   * whether it was kept; `null` removes it.
   */
  readonly publishTasks: (scope: DesktopThreadContentScope, raw: unknown) => Promise<boolean>;
  /** The machine's saved task list, or null (none, or the cache is off). */
  readonly loadTasks: (scope: DesktopThreadContentScope) => Promise<SavedTaskList | null>;
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
 * Each environment's record is its own file, encrypted with the OS-protected
 * key, so a change re-encrypts and rewrites only the environment it touches;
 * nothing is written while encryption is unavailable. The single file of
 * earlier versions is read once and replaced by them on the next write. It holds at most
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

  const encrypt = (document: object, header: string): string => {
    if (!input.protection.isEncryptionAvailable()) {
      throw new Error("Desktop thread content cannot be encrypted.");
    }
    const encrypted = input.protection.encryptString(JSON.stringify(document));
    try {
      return `${header}${encrypted.toString("base64")}\n`;
    } finally {
      encrypted.fill(0);
    }
  };
  const encodeRecord = (record: StoredRecord): string =>
    encrypt({ version: RECORD_DOCUMENT_VERSION, hubOrigin, record }, RECORD_FILE_HEADER);

  const decrypt = (stored: string, header: string): unknown => {
    if (!stored.startsWith(header) || !input.protection.isEncryptionAvailable()) return null;
    const encrypted = Buffer.from(stored.slice(header.length).trim(), "base64");
    try {
      const value = JSON.parse(input.protection.decryptString(encrypted)) as unknown;
      return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    } finally {
      encrypted.fill(0);
    }
  };

  /** A record and whether all of it was usable, or null for a record nothing of was. */
  const readCandidate = (candidate: unknown) => {
    const record = readStoredRecord(candidate);
    return {
      record,
      complete: record !== null && Object.keys(record.content).length >= threadCount(candidate),
    };
  };

  async function readFileWithin(path: string): Promise<string | null> {
    if ((await FS.stat(path)).size > MAX_CACHE_FILE_BYTES) return null;
    return FS.readFile(path, "utf8");
  }

  /**
   * What each cache file on disk holds: the record it was written with, or null
   * for a file that holds anything else (unusable, discarded, the old single
   * file). A write replaces the files whose record differs and removes the rest.
   */
  const onDisk = new Map<string, StoredRecord | null>();

  async function readRecords(): Promise<ReadonlyArray<StoredRecord>> {
    onDisk.clear();
    let names: string[];
    try {
      names = await FS.readdir(input.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
      throw error;
    }
    /** Every usable record with the file it came from. */
    const found: Array<{ readonly record: StoredRecord; readonly file: string }> = [];
    for (const name of names) {
      const legacy = name === LEGACY_CACHE_FILE_NAME;
      if (!legacy && !RECORD_FILE_NAME.test(name)) continue;
      onDisk.set(name, null);
      let stored: string | null;
      try {
        stored = await readFileWithin(Path.join(input.directory, name));
      } catch {
        continue;
      }
      if (stored === null) continue;
      if (legacy) {
        const document = decrypt(stored, LEGACY_FILE_HEADER) as {
          version?: unknown;
          hubOrigin?: unknown;
          records?: unknown;
        } | null;
        if (
          document?.version !== DOCUMENT_VERSION ||
          document.hubOrigin !== hubOrigin ||
          !Array.isArray(document.records)
        ) {
          continue;
        }
        // Its records move into their own files with the next write.
        for (const candidate of document.records) {
          const { record } = readCandidate(candidate);
          if (record !== null) found.push({ record, file: name });
        }
        continue;
      }
      const document = decrypt(stored, RECORD_FILE_HEADER) as {
        version?: unknown;
        hubOrigin?: unknown;
        record?: unknown;
      } | null;
      if (document?.version !== RECORD_DOCUMENT_VERSION || document.hubOrigin !== hubOrigin) {
        continue;
      }
      const { record, complete } = readCandidate(document.record);
      // A file under another record's name is not trusted to be that record.
      if (record === null || recordFileName(record) !== name) continue;
      found.push({ record, file: name });
      if (complete) onDisk.set(name, record);
    }
    const unique = new Map<string, { readonly record: StoredRecord; readonly file: string }>();
    for (const entry of found) {
      const key = recordKey(entry.record);
      const current = unique.get(key);
      if (!current || entry.record.capturedAt > current.record.capturedAt) unique.set(key, entry);
    }
    const kept = Array.from(unique.values())
      .toSorted((left, right) => left.record.capturedAt - right.record.capturedAt)
      .slice(-DESKTOP_THREAD_CONTENT_CACHE_MAX_ENVIRONMENTS);
    const keptFiles = new Set(kept.map((entry) => entry.file));
    for (const [name, record] of onDisk) {
      if (record !== null && !keptFiles.has(name)) onDisk.set(name, null);
    }
    return kept.map((entry) => entry.record);
  }

  const recordFiles = (records: ReadonlyArray<StoredRecord>) =>
    new Map(records.map((record) => [recordFileName(record), record]));

  async function writeRecords(records: ReadonlyArray<StoredRecord>): Promise<void> {
    const wanted = recordFiles(records);
    if (wanted.size > 0) await FS.mkdir(input.directory, { recursive: true, mode: 0o700 });
    for (const [name, record] of wanted) {
      if (onDisk.get(name) === record) continue;
      const body = encodeRecord(record);
      const target = Path.join(input.directory, name);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        await FS.writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
        await FS.rename(temporary, target);
      } finally {
        await FS.rm(temporary, { force: true });
      }
      onDisk.set(name, record);
    }
    // Removed only once every kept record is in its own file.
    for (const name of onDisk.keys()) {
      if (wanted.has(name)) continue;
      await FS.rm(Path.join(input.directory, name), { force: true });
      onDisk.delete(name);
    }
  }

  /** The same write for the moment the process exits, when nothing can be awaited. */
  function writeRecordsSync(records: ReadonlyArray<StoredRecord>): void {
    const wanted = recordFiles(records);
    if (wanted.size > 0) FSSync.mkdirSync(input.directory, { recursive: true, mode: 0o700 });
    for (const [name, record] of wanted) {
      if (onDisk.get(name) === record) continue;
      const body = encodeRecord(record);
      const target = Path.join(input.directory, name);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        FSSync.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
        FSSync.renameSync(temporary, target);
      } finally {
        FSSync.rmSync(temporary, { force: true });
      }
      onDisk.set(name, record);
    }
    for (const name of onDisk.keys()) {
      if (wanted.has(name)) continue;
      FSSync.rmSync(Path.join(input.directory, name), { force: true });
      onDisk.delete(name);
    }
  }

  let cached: ReadonlyArray<StoredRecord> | undefined;
  /** Whether the files hold something the document does not, until the next write replaces it. */
  const diskHoldsDiscarded = () => [...onDisk.values()].some((record) => record === null);
  const read = async (): Promise<ReadonlyArray<StoredRecord>> => {
    if (cached === undefined) {
      try {
        cached = await readRecords();
      } catch {
        cached = [];
      }
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
    if (records.length === existing.length && !diskHoldsDiscarded()) return;
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

  /** Callers hold the exclusive lane. */
  const accepts = async (scope: DesktopThreadContentScope): Promise<boolean> =>
    isBoundedId(scope.accountId) &&
    isBoundedId(scope.environmentId) &&
    input.protection.isEncryptionAvailable() &&
    (await enabled());

  /**
   * Replaces an environment's record with `content` (bounded already), dropping
   * other accounts' records and the least recently updated beyond the cap.
   * Callers hold the exclusive lane.
   */
  const replace = async (
    scope: DesktopThreadContentScope,
    capturedAt: number,
    update: { readonly content: DesktopThreadContent } | { readonly tasks: SavedTaskList | null },
  ): Promise<void> => {
    const key = recordKey(scope);
    const existing = await read();
    const saved = existing.find((record) => recordKey(record) === key);
    const others = existing.filter(
      (record) => record.accountId === scope.accountId && recordKey(record) !== key,
    );
    // Conversations and the task list are published apart; each keeps the other.
    const content = "content" in update ? update.content : (saved?.content ?? {});
    const tasks = "tasks" in update ? update.tasks : (saved?.tasks ?? null);
    const keepsTasks = tasks !== null && tasks.tasks.length > 0;
    if (Object.keys(content).length === 0 && !keepsTasks) {
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
          content,
          ...(keepsTasks ? { tasks } : {}),
        },
      ].slice(-DESKTOP_THREAD_CONTENT_CACHE_MAX_ENVIRONMENTS),
      "deferred",
    );
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
        if (!(await accepts(scope))) return;
        const capturedAt = now();
        await replace(scope, capturedAt, {
          content: boundContent({ ...scope, capturedAt }, content),
        });
      }),
    publishChanges: (scope, changes) =>
      exclusive(async () => {
        if (!(await accepts(scope))) return false;
        const changed = changes.changed;
        if (typeof changed !== "object" || changed === null || Array.isArray(changed)) return false;
        const key = recordKey(scope);
        const saved = (await read()).find((record) => recordKey(record) === key)?.content ?? {};
        // Threads arrive least recently visited first, so any excess is dropped from the front.
        const order = changes.order.slice(-THREAD_CONTENT_CACHE_MAX_THREADS);
        const listed = new Set(order);
        // Only the changed threads are validated; saved ones were when they arrived.
        const decoded = decodeCachedEnvironmentContent(
          {
            content: Object.fromEntries(
              Object.entries(changed).filter(([threadId]) => listed.has(threadId)),
            ),
          },
          listed,
        );
        const threads: Array<readonly [string, CachedThreadContent]> = [];
        for (const threadId of order) {
          if (Object.hasOwn(changed, threadId)) {
            // A thread the policy refuses is left out, as from a full publication.
            const thread = decoded[threadId];
            if (thread !== undefined) threads.push([threadId, thread]);
            continue;
          }
          const thread = Object.hasOwn(saved, threadId) ? saved[threadId] : undefined;
          if (thread === undefined) return false;
          threads.push([threadId, thread]);
        }
        const capturedAt = now();
        const bounded = boundEntries({ ...scope, capturedAt }, threads);
        await replace(scope, capturedAt, { content: bounded });
        // The sender keeps what it listed; a thread the budget dropped here
        // must travel again with the next change.
        return Object.keys(bounded).length === threads.length;
      }),
    publishTasks: (scope, raw) =>
      exclusive(async () => {
        if (!(await accepts(scope))) return false;
        const decoded = raw === null ? null : decodeSavedTaskList(raw);
        if (raw !== null && decoded === null) return false;
        // Bounded again: the same limits as the copy the phone keeps.
        const tasks = decoded === null ? null : boundSavedTaskList(decoded.tasks, decoded.readAt);
        await replace(scope, now(), { tasks });
        return tasks !== null || raw === null;
      }),
    loadTasks: (scope) =>
      exclusive(async () => {
        if (!(await enabled())) return null;
        const key = recordKey(scope);
        return (await read()).find((record) => recordKey(record) === key)?.tasks ?? null;
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
