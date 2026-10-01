import {
  isWorkspaceMetadataSnapshot,
  planWorkspaceMetadataCacheEvictions,
  workspaceMetadataNamespaceKey,
  workspaceMetadataPayloadBytes,
  type WorkspaceMetadataCache,
  type WorkspaceMetadataCacheNamespace,
  type WorkspaceMetadataCacheRecord,
} from "@ryco/client-runtime/state/workspace";

export const HOSTED_WORKSPACE_METADATA_CACHE_KEY = "ryco:hosted-workspace-metadata:v1";

const DOCUMENT_VERSION = 1 as const;

interface WorkspaceMetadataCacheDocument {
  readonly version: typeof DOCUMENT_VERSION;
  readonly records: ReadonlyArray<WorkspaceMetadataCacheRecord>;
}

export interface WorkspaceMetadataStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.origin.toLowerCase();
  } catch {
    return origin.replace(/\/+$/gu, "").toLowerCase();
  }
}

function normalizeNamespace(
  namespace: WorkspaceMetadataCacheNamespace,
): WorkspaceMetadataCacheNamespace {
  return { ...namespace, hubOrigin: normalizeOrigin(namespace.hubOrigin) };
}

function normalizeRecord(record: WorkspaceMetadataCacheRecord): WorkspaceMetadataCacheRecord {
  return { ...record, namespace: normalizeNamespace(record.namespace) };
}

function isNamespace(value: unknown): value is WorkspaceMetadataCacheNamespace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkspaceMetadataCacheNamespace>;
  return (
    typeof candidate.hubOrigin === "string" &&
    candidate.hubOrigin.length > 0 &&
    candidate.hubOrigin.length <= 2_048 &&
    typeof candidate.accountId === "string" &&
    candidate.accountId.length > 0 &&
    candidate.accountId.length <= 2_048 &&
    typeof candidate.environmentId === "string" &&
    candidate.environmentId.length > 0 &&
    candidate.environmentId.length <= 2_048
  );
}

function isRecord(value: unknown): value is WorkspaceMetadataCacheRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkspaceMetadataCacheRecord>;
  return (
    isNamespace(candidate.namespace) &&
    isWorkspaceMetadataSnapshot(candidate.snapshot, candidate.namespace.environmentId) &&
    Number.isSafeInteger(candidate.payloadBytes) &&
    candidate.payloadBytes === workspaceMetadataPayloadBytes(candidate.snapshot) &&
    Number.isSafeInteger(candidate.updatedAt) &&
    Number(candidate.updatedAt) >= 0
  );
}

function readDocument(storage: WorkspaceMetadataStorage): WorkspaceMetadataCacheDocument {
  try {
    const raw = storage.getItem(HOSTED_WORKSPACE_METADATA_CACHE_KEY);
    if (!raw) return { version: DOCUMENT_VERSION, records: [] };
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { version: DOCUMENT_VERSION, records: [] };
    }
    const document = value as Partial<WorkspaceMetadataCacheDocument>;
    if (document.version !== DOCUMENT_VERSION || !Array.isArray(document.records)) {
      return { version: DOCUMENT_VERSION, records: [] };
    }
    const unique = new Map<string, WorkspaceMetadataCacheRecord>();
    for (const record of document.records) {
      if (!isRecord(record)) continue;
      const normalized = normalizeRecord(record);
      const key = workspaceMetadataNamespaceKey(normalized.namespace);
      const current = unique.get(key);
      if (!current || normalized.updatedAt > current.updatedAt) unique.set(key, normalized);
    }
    return { version: DOCUMENT_VERSION, records: Array.from(unique.values()) };
  } catch {
    return { version: DOCUMENT_VERSION, records: [] };
  }
}

function writeDocument(
  storage: WorkspaceMetadataStorage,
  records: ReadonlyArray<WorkspaceMetadataCacheRecord>,
): void {
  if (records.length === 0) {
    storage.removeItem(HOSTED_WORKSPACE_METADATA_CACHE_KEY);
    return;
  }
  storage.setItem(
    HOSTED_WORKSPACE_METADATA_CACHE_KEY,
    JSON.stringify({ version: DOCUMENT_VERSION, records } satisfies WorkspaceMetadataCacheDocument),
  );
}

/**
 * Metadata-only hosted-Web cache. It deliberately uses the page's storage
 * adapter directly and never the service worker, authenticated HTTP cache, or
 * CacheStorage data plane.
 */
export function createBrowserWorkspaceMetadataCache(
  storage: WorkspaceMetadataStorage,
): WorkspaceMetadataCache {
  let pending: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const run = pending.then(operation, operation);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    load: async (namespace) => {
      const key = workspaceMetadataNamespaceKey(normalizeNamespace(namespace));
      return (
        readDocument(storage).records.find(
          (record) => workspaceMetadataNamespaceKey(record.namespace) === key,
        ) ?? null
      );
    },
    list: async ({ hubOrigin, accountId }) =>
      readDocument(storage).records.filter(
        (record) =>
          normalizeOrigin(record.namespace.hubOrigin) === normalizeOrigin(hubOrigin) &&
          record.namespace.accountId === accountId,
      ),
    replace: (incoming) =>
      exclusive(async () => {
        if (!isRecord(incoming)) throw new TypeError("Invalid hosted workspace metadata record.");
        const normalizedIncoming = normalizeRecord(incoming);
        const document = readDocument(storage);
        const plan = planWorkspaceMetadataCacheEvictions({
          existing: document.records,
          incoming: normalizedIncoming,
        });
        if (!plan.accepted) return;
        const incomingKey = workspaceMetadataNamespaceKey(normalizedIncoming.namespace);
        const evicted = new Set(plan.evict.map(workspaceMetadataNamespaceKey));
        writeDocument(storage, [
          ...document.records.filter((record) => {
            const key = workspaceMetadataNamespaceKey(record.namespace);
            return key !== incomingKey && !evicted.has(key);
          }),
          normalizedIncoming,
        ]);
      }),
    purgeEnvironment: (namespace) =>
      exclusive(async () => {
        const key = workspaceMetadataNamespaceKey(normalizeNamespace(namespace));
        const document = readDocument(storage);
        writeDocument(
          storage,
          document.records.filter(
            (record) => workspaceMetadataNamespaceKey(record.namespace) !== key,
          ),
        );
      }),
    purgeAccount: ({ hubOrigin, accountId }) =>
      exclusive(async () => {
        const document = readDocument(storage);
        writeDocument(
          storage,
          document.records.filter(
            (record) =>
              normalizeOrigin(record.namespace.hubOrigin) !== normalizeOrigin(hubOrigin) ||
              record.namespace.accountId !== accountId,
          ),
        );
      }),
  };
}

let browserWorkspaceMetadataCache: WorkspaceMetadataCache | null = null;

export function getBrowserWorkspaceMetadataCache(): WorkspaceMetadataCache {
  if (!browserWorkspaceMetadataCache) {
    // Disk persistence now belongs to the account-fenced encrypted read cache.
    // This adapter remains the coordinator's bounded in-memory metadata index.
    try {
      window.localStorage.removeItem(HOSTED_WORKSPACE_METADATA_CACHE_KEY);
    } catch {
      /* Optional storage. */
    }
    const memory = new Map<string, string>();
    browserWorkspaceMetadataCache = createBrowserWorkspaceMetadataCache({
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      },
    });
  }
  return browserWorkspaceMetadataCache;
}
