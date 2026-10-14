import type {
  AuthSessionRole,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  PersistedSavedEnvironmentRecord,
  ServerConfig,
} from "@ryco/contracts";

import { persistedSavedEnvironmentRecordFields } from "@ryco/shared/savedEnvironmentRecord";

import type { SecretKVService } from "../platform/index.ts";

export interface SavedEnvironmentRecord {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly createdAt: string;
  readonly lastConnectedAt: string | null;
  readonly desktopSsh?: PersistedSavedEnvironmentRecord["desktopSsh"];
  readonly hubLink?: PersistedSavedEnvironmentRecord["hubLink"];
}

export interface SavedEnvironmentKV {
  readonly getRegistry: () => Promise<ReadonlyArray<SavedEnvironmentRecord>>;
  readonly setRegistry: (records: ReadonlyArray<SavedEnvironmentRecord>) => Promise<void>;
}

export interface StoreApi<S> {
  readonly getState: () => S;
  readonly setState: (next: Partial<S> | ((state: S) => Partial<S>)) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

function createStore<S>(initial: S): StoreApi<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState: (next) => {
      state = { ...state, ...(typeof next === "function" ? next(state) : next) };
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface SavedEnvironmentRegistryState {
  readonly byId: Record<EnvironmentId, SavedEnvironmentRecord>;
  readonly upsert: (record: SavedEnvironmentRecord) => void;
  readonly remove: (environmentId: EnvironmentId) => void;
  readonly markConnected: (environmentId: EnvironmentId, connectedAt: string) => void;
  readonly rename: (environmentId: EnvironmentId, label: string) => void;
  readonly reset: () => void;
}

export type SavedEnvironmentConnectionState = "connecting" | "connected" | "disconnected" | "error";
export type SavedEnvironmentAuthState = "authenticated" | "requires-auth" | "unknown";
export interface SavedEnvironmentRuntimeState {
  readonly connectionState: SavedEnvironmentConnectionState;
  readonly authState: SavedEnvironmentAuthState;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly role: AuthSessionRole | null;
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  readonly serverConfig: ServerConfig | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
}
export interface SavedEnvironmentRuntimeStoreState {
  readonly byId: Record<EnvironmentId, SavedEnvironmentRuntimeState>;
  readonly ensure: (environmentId: EnvironmentId) => void;
  readonly patch: (
    environmentId: EnvironmentId,
    patch: Partial<SavedEnvironmentRuntimeState>,
  ) => void;
  readonly clear: (environmentId: EnvironmentId) => void;
  readonly reset: () => void;
}

const DEFAULT_RUNTIME_STATE: SavedEnvironmentRuntimeState = Object.freeze({
  connectionState: "disconnected",
  authState: "unknown",
  lastError: null,
  lastErrorAt: null,
  role: null,
  descriptor: null,
  serverConfig: null,
  connectedAt: null,
  disconnectedAt: null,
});

export function toPersistedSavedEnvironmentRecord(
  record: SavedEnvironmentRecord,
): PersistedSavedEnvironmentRecord {
  return persistedSavedEnvironmentRecordFields(record);
}

export function createSavedEnvironmentCatalog(input: {
  readonly kv: SavedEnvironmentKV;
  readonly secretKV: SecretKVService;
}) {
  let hydrated = false;
  let hydration: Promise<void> | null = null;
  const registryStore = createStore<SavedEnvironmentRegistryState>(
    {} as SavedEnvironmentRegistryState,
  );
  const persist = (byId: Record<EnvironmentId, SavedEnvironmentRecord>) => {
    try {
      void input.kv.setRegistry(Object.values(byId)).catch((error) => {
        console.error("[SAVED_ENVIRONMENTS] persist failed", error);
      });
    } catch (error) {
      console.error("[SAVED_ENVIRONMENTS] persist failed", error);
    }
  };
  registryStore.setState({
    byId: {},
    upsert: (record) =>
      registryStore.setState((state) => {
        const byId = { ...state.byId, [record.environmentId]: record };
        persist(byId);
        return { byId };
      }),
    remove: (environmentId) =>
      registryStore.setState((state) => {
        const { [environmentId]: _removed, ...byId } = state.byId;
        persist(byId);
        return { byId };
      }),
    markConnected: (environmentId, connectedAt) =>
      registryStore.setState((state) => {
        const current = state.byId[environmentId];
        if (!current) return {};
        const byId = {
          ...state.byId,
          [environmentId]: { ...current, lastConnectedAt: connectedAt },
        };
        persist(byId);
        return { byId };
      }),
    rename: (environmentId, label) =>
      registryStore.setState((state) => {
        const current = state.byId[environmentId];
        const nextLabel = label.trim();
        if (!current || !nextLabel || current.label === nextLabel) return {};
        const byId = { ...state.byId, [environmentId]: { ...current, label: nextLabel } };
        persist(byId);
        return { byId };
      }),
    reset: () => {
      persist({});
      registryStore.setState({ byId: {} });
    },
  });
  const runtimeStore = createStore<SavedEnvironmentRuntimeStoreState>(
    {} as SavedEnvironmentRuntimeStoreState,
  );
  runtimeStore.setState({
    byId: {},
    ensure: (environmentId) =>
      runtimeStore.setState((state) =>
        state.byId[environmentId]
          ? {}
          : { byId: { ...state.byId, [environmentId]: { ...DEFAULT_RUNTIME_STATE } } },
      ),
    patch: (environmentId, patch) =>
      runtimeStore.setState((state) => ({
        byId: {
          ...state.byId,
          [environmentId]: { ...(state.byId[environmentId] ?? DEFAULT_RUNTIME_STATE), ...patch },
        },
      })),
    clear: (environmentId) =>
      runtimeStore.setState((state) => {
        const { [environmentId]: _removed, ...byId } = state.byId;
        return { byId };
      }),
    reset: () => runtimeStore.setState({ byId: {} }),
  });
  return {
    registryStore,
    runtimeStore,
    hasHydrated: () => hydrated,
    waitForHydration: () => {
      if (hydrated) return Promise.resolve();
      if (hydration) return hydration;
      hydration = input.kv
        .getRegistry()
        .then((records) => {
          const existing = registryStore.getState().byId;
          const hydratedById = Object.fromEntries(
            records.map((record) => [record.environmentId, record]),
          ) as Record<EnvironmentId, SavedEnvironmentRecord>;
          registryStore.setState({ byId: { ...hydratedById, ...existing } });
        })
        .catch((error) => console.error("[SAVED_ENVIRONMENTS] hydrate failed", error))
        .finally(() => {
          hydrated = true;
          hydration = null;
        });
      return hydration;
    },
    list: () =>
      Object.values(registryStore.getState().byId).toSorted((left, right) =>
        left.label.localeCompare(right.label),
      ),
    get: (environmentId: EnvironmentId) => registryStore.getState().byId[environmentId] ?? null,
    persistRecord: async (record: SavedEnvironmentRecord) => {
      const byId = { ...registryStore.getState().byId, [record.environmentId]: record };
      await input.kv.setRegistry(Object.values(byId));
    },
    readBearerToken: (environmentId: EnvironmentId) => input.secretKV.get(environmentId),
    writeBearerToken: (environmentId: EnvironmentId, token: string) =>
      input.secretKV.set(environmentId, token),
    removeBearerToken: (environmentId: EnvironmentId) => input.secretKV.remove(environmentId),
    resetForTests: () => {
      hydrated = false;
      hydration = null;
      registryStore.setState({ byId: {} });
    },
    resetRuntimeForTests: () => runtimeStore.getState().reset(),
    getRuntime: (environmentId: EnvironmentId) =>
      runtimeStore.getState().byId[environmentId] ?? DEFAULT_RUNTIME_STATE,
  };
}
