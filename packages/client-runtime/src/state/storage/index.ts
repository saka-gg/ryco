import type {
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageSnapshot,
  ProjectId,
} from "@ryco/contracts";
import type { WsRpcClient } from "../../rpc/wsRpcClient.ts";

export interface StorageManagementState {
  readonly busy: boolean;
  readonly snapshot: StorageSnapshot | null;
  readonly preview: StorageCleanupPreview | null;
  readonly result: StorageCleanupResult | null;
  readonly error: string | null;
}

/** Shared request/readiness ownership; presentations supply the existing connection lookup. */
export function createStorageManagementController(input: {
  readonly readClient: () => WsRpcClient | null;
  readonly canManage?: () => boolean;
}) {
  let state: StorageManagementState = {
    busy: false,
    snapshot: null,
    preview: null,
    result: null,
    error: null,
  };
  let presentationReady: boolean | undefined;
  const canManage = () => presentationReady ?? input.canManage?.() ?? false;
  let generation = 0;
  let previewClient: WsRpcClient | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<StorageManagementState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const run = async (work: (client: WsRpcClient) => Promise<Partial<StorageManagementState>>) => {
    if (state.busy) return;
    const client = input.readClient();
    if (!client || !canManage()) {
      publish({
        preview: null,
        error: "Connect as this node's owner and wait for synchronization.",
      });
      return;
    }
    const attempt = ++generation;
    publish({ busy: true, error: null });
    try {
      const next = await work(client);
      if (attempt === generation && input.readClient() === client && canManage()) {
        if (next.preview) previewClient = client;
        publish(next);
      } else if (attempt === generation)
        publish({ preview: null, error: "Connection changed. Scan and review again." });
    } catch (cause) {
      if (attempt === generation)
        publish({
          preview: null,
          error:
            cause instanceof Error
              ? cause.message
              : "Storage request failed. Scan and review again.",
        });
    } finally {
      if (attempt === generation) publish({ busy: false });
    }
  };
  return {
    setReady: (ready: boolean) => {
      presentationReady = ready;
      if (!ready) {
        generation++;
        previewClient = null;
        publish({ busy: false, preview: null, error: null });
      }
    },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidatePreview: () => {
      generation++;
      previewClient = null;
      publish({ busy: false, preview: null, result: null, error: null });
    },
    reset: () => {
      generation++;
      previewClient = null;
      publish({ busy: false, snapshot: null, preview: null, result: null, error: null });
    },
    scan: (projectId?: ProjectId, cursor?: string) =>
      run(async (client) => ({
        snapshot: await client.storage.scan({
          ...(projectId ? { projectId } : {}),
          ...(cursor ? { cursor } : {}),
        }),
        preview: null,
        result: null,
      })),
    preview: (entryIds: readonly string[]) =>
      run(async (client) => {
        const preview = await client.storage.preview({ entryIds });
        return { preview, result: null };
      }),
    execute: (confirmed: boolean) =>
      run(async (client) => {
        if (
          !confirmed ||
          !state.preview ||
          previewClient !== client ||
          Date.parse(state.preview.expiresAt) <= Date.now()
        )
          throw new Error("Cleanup requires a current reviewed preview and explicit confirmation.");
        const result = await client.storage.execute({
          token: state.preview.token,
          confirmation: "delete reviewed data",
        });
        return { result, preview: null, snapshot: null };
      }),
  };
}
