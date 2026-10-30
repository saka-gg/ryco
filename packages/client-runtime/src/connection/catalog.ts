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
  /** The saved environments: each one is a machine of its own. */
  readonly byId: Record<EnvironmentId, SavedEnvironmentRecord>;
  /**
   * Hub-linked direct access, keyed by the machine's direct id. Each record is
   * a route to the Hub environment its `hubLink` names, never an environment
   * of its own (`docs/environment-routes.md`), so nothing that lists or
   * connects environments sees it.
   */
  readonly linkedById: Record<EnvironmentId, SavedEnvironmentRecord>;
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

/** What `getRuntime` answers for an environment the runtime store has no entry for. */
export const DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE: SavedEnvironmentRuntimeState = Object.freeze({
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

/**
 * Put a record where it belongs: a Hub-linked one among the routes, any other
 * among the environments. A direct id lives in one of the two, never both, so
 * linking a machine paired by hand before (or unlinking one) moves it.
 */
export function placeSavedEnvironmentRecord<
  State extends {
    readonly byId: Record<EnvironmentId, SavedEnvironmentRecord>;
    readonly linkedById: Record<EnvironmentId, SavedEnvironmentRecord>;
  },
>(state: State, record: SavedEnvironmentRecord): Pick<State, "byId" | "linkedById"> {
  const { [record.environmentId]: _environment, ...byId } = state.byId;
  const { [record.environmentId]: _linked, ...linkedById } = state.linkedById;
  return record.hubLink
    ? { byId, linkedById: { ...linkedById, [record.environmentId]: record } }
    : { byId: { ...byId, [record.environmentId]: record }, linkedById };
}

export function createSavedEnvironmentCatalog(input: {
  readonly kv: SavedEnvironmentKV;
  readonly secretKV: SecretKVService;
}) {
  let hydrated = false;
  let hydration: Promise<void> | null = null;
  // Its own channel, not a registry notification: the connection supervisor
  // starts a saved-environment sync on every registry notification once
  // hydrated, and already starts one when hydration resolves.
  const hydrationListeners = new Set<() => void>();
  const setHydrated = (next: boolean) => {
    hydrated = next;
    hydrationListeners.forEach((listener) => listener());
  };
  const registryStore = createStore<SavedEnvironmentRegistryState>(
    {} as SavedEnvironmentRegistryState,
  );
  /** Everything the registry holds, in the one list it is stored as. */
  const allRecords = (state: {
    readonly byId: Record<EnvironmentId, SavedEnvironmentRecord>;
    readonly linkedById: Record<EnvironmentId, SavedEnvironmentRecord>;
  }) => [...Object.values(state.byId), ...Object.values(state.linkedById)];
  const persist = (state: {
    readonly byId: Record<EnvironmentId, SavedEnvironmentRecord>;
    readonly linkedById: Record<EnvironmentId, SavedEnvironmentRecord>;
  }) => {
    try {
      void input.kv.setRegistry(allRecords(state)).catch((error) => {
        console.error("[SAVED_ENVIRONMENTS] persist failed", error);
      });
    } catch (error) {
      console.error("[SAVED_ENVIRONMENTS] persist failed", error);
    }
  };
  registryStore.setState({
    byId: {},
    linkedById: {},
    upsert: (record) =>
      registryStore.setState((state) => {
        const next = placeSavedEnvironmentRecord(state, record);
        persist(next);
        return next;
      }),
    remove: (environmentId) =>
      registryStore.setState((state) => {
        const { [environmentId]: _removed, ...byId } = state.byId;
        const { [environmentId]: _removedLink, ...linkedById } = state.linkedById;
        persist({ byId, linkedById });
        return { byId, linkedById };
      }),
    markConnected: (environmentId, connectedAt) =>
      registryStore.setState((state) => {
        const current = state.byId[environmentId];
        if (!current) return {};
        const byId = {
          ...state.byId,
          [environmentId]: { ...current, lastConnectedAt: connectedAt },
        };
        persist({ byId, linkedById: state.linkedById });
        return { byId };
      }),
    rename: (environmentId, label) =>
      registryStore.setState((state) => {
        const current = state.byId[environmentId];
        const nextLabel = label.trim();
        if (!current || !nextLabel || current.label === nextLabel) return {};
        const byId = { ...state.byId, [environmentId]: { ...current, label: nextLabel } };
        persist({ byId, linkedById: state.linkedById });
        return { byId };
      }),
    reset: () => {
      persist({ byId: {}, linkedById: {} });
      registryStore.setState({ byId: {}, linkedById: {} });
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
          : {
              byId: {
                ...state.byId,
                [environmentId]: { ...DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE },
              },
            },
      ),
    patch: (environmentId, patch) =>
      runtimeStore.setState((state) => ({
        byId: {
          ...state.byId,
          [environmentId]: {
            ...(state.byId[environmentId] ?? DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE),
            ...patch,
          },
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
    /**
     * Notifies when `hasHydrated` changes, so a view can read it as a
     * `useSyncExternalStore` snapshot. It flips after the stored records have
     * landed in the registry (also when reading them failed).
     */
    subscribeHydration: (listener: () => void): (() => void) => {
      hydrationListeners.add(listener);
      return () => hydrationListeners.delete(listener);
    },
    waitForHydration: () => {
      if (hydrated) return Promise.resolve();
      if (hydration) return hydration;
      hydration = input.kv
        .getRegistry()
        .then((records) => {
          // A record written this session wins over its stored copy.
          let next = { byId: {}, linkedById: {} } as Pick<
            SavedEnvironmentRegistryState,
            "byId" | "linkedById"
          >;
          for (const record of records) next = placeSavedEnvironmentRecord(next, record);
          const current = registryStore.getState();
          for (const record of allRecords(current))
            next = placeSavedEnvironmentRecord(next, record);
          registryStore.setState(next);
        })
        .catch((error) => console.error("[SAVED_ENVIRONMENTS] hydrate failed", error))
        .finally(() => {
          hydration = null;
          setHydrated(true);
        });
      return hydration;
    },
    list: () =>
      Object.values(registryStore.getState().byId).toSorted((left, right) =>
        left.label.localeCompare(right.label),
      ),
    get: (environmentId: EnvironmentId) => registryStore.getState().byId[environmentId] ?? null,
    /** Hub-linked direct access records, by the machine's direct id. */
    listLinked: () => Object.values(registryStore.getState().linkedById),
    getLinked: (environmentId: EnvironmentId) =>
      registryStore.getState().linkedById[environmentId] ?? null,
    persistRecord: async (record: SavedEnvironmentRecord) => {
      await input.kv.setRegistry(
        allRecords(placeSavedEnvironmentRecord(registryStore.getState(), record)),
      );
    },
    readBearerToken: (environmentId: EnvironmentId) => input.secretKV.get(environmentId),
    writeBearerToken: (environmentId: EnvironmentId, token: string) =>
      input.secretKV.set(environmentId, token),
    removeBearerToken: (environmentId: EnvironmentId) => input.secretKV.remove(environmentId),
    resetForTests: () => {
      hydration = null;
      setHydrated(false);
      registryStore.setState({ byId: {}, linkedById: {} });
    },
    resetRuntimeForTests: () => runtimeStore.getState().reset(),
    getRuntime: (environmentId: EnvironmentId) =>
      runtimeStore.getState().byId[environmentId] ?? DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE,
  };
}
