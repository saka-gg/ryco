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

function isRecord(value: unknown): value is WorkspaceMetadataCacheRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<WorkspaceMetadataCacheRecord>;
  return (
    isNamespace(record.namespace) &&
    isWorkspaceMetadataSnapshot(record.snapshot, record.namespace.environmentId) &&
    Number.isSafeInteger(record.payloadBytes) &&
    Number(record.payloadBytes) === workspaceMetadataPayloadBytes(record.snapshot) &&
    Number.isSafeInteger(record.updatedAt) &&
    Number(record.updatedAt) >= 0
  );
}

async function readDocument(filePath: string): Promise<DesktopWorkspaceCacheDocument> {
  try {
    const value = JSON.parse(await FS.readFile(filePath, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return emptyDocument();
    }
    const document = value as Partial<DesktopWorkspaceCacheDocument>;
    if (document.version !== DOCUMENT_VERSION || !Array.isArray(document.records)) {
      return emptyDocument();
    }
    const records = document.records.filter(isRecord);
    const unique = new Map<string, WorkspaceMetadataCacheRecord>();
    for (const record of records) {
      const key = workspaceMetadataNamespaceKey(record.namespace);
      const current = unique.get(key);
      if (!current || record.updatedAt > current.updatedAt) unique.set(key, record);
    }
    return { version: DOCUMENT_VERSION, records: Array.from(unique.values()) };
  } catch {
    return emptyDocument();
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

/**
 * Desktop UI-client metadata only. Callers must place this file below the
 * dedicated `desktop-workspace-client` directory, never in the backend/node
 * persistence namespace.
 */
export function createDesktopWorkspaceMetadataCache(filePath: string): WorkspaceMetadataCache {
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
  const read = async () => (cached ??= await readDocument(filePath));
  const write = async (document: DesktopWorkspaceCacheDocument) => {
    await writeDocument(filePath, document);
    cached = document;
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
        if (!isRecord(incoming)) throw new TypeError("Invalid Desktop workspace metadata record.");
        const document = await read();
        const plan = planWorkspaceMetadataCacheEvictions({
          existing: document.records,
          incoming,
        });
        if (!plan.accepted) return;
        const incomingKey = workspaceMetadataNamespaceKey(incoming.namespace);
        const evicted = new Set(plan.evict.map(workspaceMetadataNamespaceKey));
        await write({
          version: DOCUMENT_VERSION,
          records: [
            ...document.records.filter((record) => {
              const key = workspaceMetadataNamespaceKey(record.namespace);
              return key !== incomingKey && !evicted.has(key);
            }),
            incoming,
          ],
        });
      }),
    purgeEnvironment: (namespace) =>
      exclusive(async () => {
        const key = workspaceMetadataNamespaceKey(namespace);
        const document = await read();
        await write({
          version: DOCUMENT_VERSION,
          records: document.records.filter(
            (record) => workspaceMetadataNamespaceKey(record.namespace) !== key,
          ),
        });
      }),
    purgeAccount: ({ hubOrigin, accountId }) =>
      exclusive(async () => {
        const document = await read();
        await write({
          version: DOCUMENT_VERSION,
          records: document.records.filter(
            (record) =>
              normalizeOrigin(record.namespace.hubOrigin) !== normalizeOrigin(hubOrigin) ||
              record.namespace.accountId !== accountId,
          ),
        });
      }),
  };
}
