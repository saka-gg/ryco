import * as FSSync from "node:fs";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import {
  isWorkspaceMetadataSnapshot,
  planWorkspaceMetadataCacheEvictions,
  workspaceMetadataNamespaceKey,
  workspaceMetadataPayloadBytes,
  type WorkspaceMetadataCache,
  type WorkspaceMetadataCacheNamespace,
  type WorkspaceMetadataCacheRecord,
} from "@ryco/client-runtime/state/workspace";

const DOCUMENT_VERSION = 1 as const;

/** A burst of changes is written once, after this much quiet... */
const WRITE_DEBOUNCE_MS = 2_000;
/** ...but never later than this after the first unwritten change. */
const WRITE_MAX_WAIT_MS = 10_000;

interface DesktopWorkspaceCacheDocument {
  readonly version: typeof DOCUMENT_VERSION;
  readonly records: ReadonlyArray<WorkspaceMetadataCacheRecord>;
}

function emptyDocument(): DesktopWorkspaceCacheDocument {
  return { version: DOCUMENT_VERSION, records: [] };
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/gu, "").toLowerCase();
}

function isNamespace(value: unknown): value is WorkspaceMetadataCacheNamespace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<WorkspaceMetadataCacheNamespace>;
  return (
    typeof record.hubOrigin === "string" &&
    record.hubOrigin.length > 0 &&
    record.hubOrigin.length <= 2_048 &&
    typeof record.accountId === "string" &&
    record.accountId.length > 0 &&
    record.accountId.length <= 2_048 &&
    typeof record.environmentId === "string" &&
    record.environmentId.length > 0 &&
    record.environmentId.length <= 2_048
  );
}

/**
 * What every record must satisfy, without looking inside its snapshot: a valid
 * namespace, a snapshot of that namespace's environment, and sane numbers.
 */
function hasValidEnvelope(value: unknown): value is WorkspaceMetadataCacheRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<WorkspaceMetadataCacheRecord>;
  return (
    isNamespace(record.namespace) &&
    typeof record.snapshot === "object" &&
    record.snapshot !== null &&
    record.snapshot.environmentId === record.namespace.environmentId &&
    Number.isSafeInteger(record.payloadBytes) &&
    Number(record.payloadBytes) >= 0 &&
    Number.isSafeInteger(record.updatedAt) &&
    Number(record.updatedAt) >= 0
  );
}

/** A record read back from disk is untrusted: its snapshot is validated and measured in full. */
function isStoredRecord(value: unknown): value is WorkspaceMetadataCacheRecord {
  return (
    hasValidEnvelope(value) &&
    isWorkspaceMetadataSnapshot(value.snapshot, value.namespace.environmentId) &&
    value.payloadBytes === workspaceMetadataPayloadBytes(value.snapshot)
  );
}

interface LoadedDocument {
  readonly document: DesktopWorkspaceCacheDocument;
  /** The file held content that `document` does not: discarded records or an unusable file. */
  readonly discarded: boolean;
}

async function readDocument(filePath: string): Promise<LoadedDocument> {
  const unusable = { document: emptyDocument(), discarded: true };
  let raw: string;
  try {
    raw = await FS.readFile(filePath, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    return { document: emptyDocument(), discarded: !missing };
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return unusable;
    const document = value as Partial<DesktopWorkspaceCacheDocument>;
    if (document.version !== DOCUMENT_VERSION || !Array.isArray(document.records)) return unusable;
    const unique = new Map<string, WorkspaceMetadataCacheRecord>();
    for (const record of document.records.filter(isStoredRecord)) {
      const key = workspaceMetadataNamespaceKey(record.namespace);
      const current = unique.get(key);
      if (!current || record.updatedAt > current.updatedAt) unique.set(key, record);
    }
    return {
      document: { version: DOCUMENT_VERSION, records: Array.from(unique.values()) },
      discarded: unique.size !== document.records.length,
    };
  } catch {
    return unusable;
  }
}

async function writeDocument(
  filePath: string,
  document: DesktopWorkspaceCacheDocument,
): Promise<void> {
  const directory = Path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await FS.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await FS.writeFile(temporary, `${JSON.stringify(document)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await FS.rename(temporary, filePath);
  } finally {
    await FS.rm(temporary, { force: true });
  }
}

/** The same atomic write for the moment the process exits, when nothing can be awaited. */
function writeDocumentSync(filePath: string, document: DesktopWorkspaceCacheDocument): void {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  FSSync.mkdirSync(Path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    FSSync.writeFileSync(temporary, `${JSON.stringify(document)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    FSSync.renameSync(temporary, filePath);
  } finally {
    FSSync.rmSync(temporary, { force: true });
  }
}

export interface DesktopWorkspaceMetadataCache extends WorkspaceMetadataCache {
  /** Writes any change that is still waiting for its quiet period. */
  readonly flush: () => Promise<void>;
  /** Flushes, then writes every later change at once instead of deferring it. */
  readonly dispose: () => Promise<void>;
}

/**
 * Desktop UI-client metadata only. Callers must place this file below the
 * dedicated `desktop-workspace-client` directory, never in the backend/node
 * persistence namespace.
 *
 * The in-memory document is authoritative and the file follows it. A change is
 * written after a quiet period (or at most a maximum wait after the first
 * unwritten change), so a stream of snapshots rewrites the file a few times a
 * minute instead of once per snapshot. A purge is written at once, and so is
 * anything still unwritten when the process exits.
 *
 * `replace` takes the caller's word that the snapshot is valid and that
 * `payloadBytes` is its measured size, as the client does once per publication,
 * and checks only the record's envelope. Records read back from disk are
 * validated and measured in full, and anything they fail is dropped.
 */
export function createDesktopWorkspaceMetadataCache(
  filePath: string,
): DesktopWorkspaceMetadataCache {
  let pending: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const run = pending.then(operation, operation);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  let cached: DesktopWorkspaceCacheDocument | undefined;
  // The file holds something the document does not, until the next write replaces it.
  let diskHoldsDiscarded = false;
  const read = async () => {
    if (cached === undefined) {
      const loaded = await readDocument(filePath);
      cached = loaded.document;
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
      writeDocumentSync(filePath, cached);
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
    const document = cached;
    const target = revision;
    try {
      await writeDocument(filePath, document);
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
    document: DesktopWorkspaceCacheDocument,
    mode: "deferred" | "immediate",
  ): Promise<void> => {
    cached = document;
    revision += 1;
    syncExitHook();
    if (mode === "immediate" || disposed) await writePending();
    else deferWrite(WRITE_DEBOUNCE_MS, WRITE_MAX_WAIT_MS);
  };

  /**
   * A purge that finds nothing to remove writes nothing, unless the file still
   * holds records the reader discarded, which a purge must not leave behind.
   */
  const purge = async (keep: (record: WorkspaceMetadataCacheRecord) => boolean): Promise<void> => {
    const document = await read();
    const records = document.records.filter(keep);
    if (records.length === document.records.length && !diskHoldsDiscarded) return;
    await commit({ version: DOCUMENT_VERSION, records }, "immediate");
  };

  return {
    load: (namespace) =>
      exclusive(async () => {
        const key = workspaceMetadataNamespaceKey(namespace);
        return (
          (await read()).records.find(
            (record) => workspaceMetadataNamespaceKey(record.namespace) === key,
          ) ?? null
        );
      }),
    list: ({ hubOrigin, accountId }) =>
      exclusive(async () =>
        (await read()).records.filter(
          (record) =>
            normalizeOrigin(record.namespace.hubOrigin) === normalizeOrigin(hubOrigin) &&
            record.namespace.accountId === accountId,
        ),
      ),
    replace: (incoming) =>
      exclusive(async () => {
        if (!hasValidEnvelope(incoming)) {
          throw new TypeError("Invalid Desktop workspace metadata record.");
        }
        const document = await read();
        const plan = planWorkspaceMetadataCacheEvictions({
          existing: document.records,
          incoming,
        });
        if (!plan.accepted) return;
        const incomingKey = workspaceMetadataNamespaceKey(incoming.namespace);
        const evicted = new Set(plan.evict.map(workspaceMetadataNamespaceKey));
        await commit(
          {
            version: DOCUMENT_VERSION,
            records: [
              ...document.records.filter((record) => {
                const key = workspaceMetadataNamespaceKey(record.namespace);
                return key !== incomingKey && !evicted.has(key);
              }),
              incoming,
            ],
          },
          "deferred",
        );
      }),
    purgeEnvironment: (namespace) =>
      exclusive(() => {
        const key = workspaceMetadataNamespaceKey(namespace);
        return purge((record) => workspaceMetadataNamespaceKey(record.namespace) !== key);
      }),
    purgeAccount: ({ hubOrigin, accountId }) =>
      exclusive(() =>
        purge(
          (record) =>
            normalizeOrigin(record.namespace.hubOrigin) !== normalizeOrigin(hubOrigin) ||
            record.namespace.accountId !== accountId,
        ),
      ),
    flush: () => exclusive(writePending),
    dispose: () =>
      exclusive(async () => {
        disposed = true;
        await writePending();
      }),
  };
}
