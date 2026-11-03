import type { EnvironmentId } from "@ryco/contracts";
import {
  createSavedEnvironmentCatalog,
  toPersistedSavedEnvironmentRecord,
  type SavedEnvironmentRegistryState,
  type SavedEnvironmentRuntimeStoreState,
  type StoreApi,
} from "@ryco/client-runtime/connection";
import { getKnownEnvironmentHttpBaseUrl } from "@ryco/client-runtime/knownEnvironment";
import { useSyncExternalStore } from "react";

import { isHostedHubMode } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { rewriteEnvironmentHttpBaseUrlInDev } from "../../platform/endpoint";
import { webSecretKV } from "../../platform/secretKv";
import { getPrimaryKnownEnvironment } from "../primary";

export type {
  SavedEnvironmentAuthState,
  SavedEnvironmentConnectionState,
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "@ryco/client-runtime/connection";
export { toPersistedSavedEnvironmentRecord } from "@ryco/client-runtime/connection";

interface BoundStore<S> {
  <T>(selector: (state: S) => T): T;
  getState: StoreApi<S>["getState"];
  setState: StoreApi<S>["setState"];
  subscribe: StoreApi<S>["subscribe"];
}

function bindStore<S>(store: StoreApi<S>): BoundStore<S> {
  const bound = (<T>(selector: (state: S) => T): T =>
    useSyncExternalStore(
      store.subscribe,
      () => selector(store.getState()),
      () => selector(store.getState()),
    )) as BoundStore<S>;
  bound.getState = store.getState;
  bound.setState = store.setState;
  bound.subscribe = store.subscribe;
  return bound;
}

const catalog = createSavedEnvironmentCatalog({
  kv: {
    getRegistry: () => ensureLocalApi().persistence.getSavedEnvironmentRegistry(),
    setRegistry: (records) =>
      ensureLocalApi().persistence.setSavedEnvironmentRegistry(
        records.map((record) => toPersistedSavedEnvironmentRecord(record)),
      ),
  },
  secretKV: webSecretKV,
});

export const useSavedEnvironmentRegistryStore = bindStore<SavedEnvironmentRegistryState>(
  catalog.registryStore,
);
export const useSavedEnvironmentRuntimeStore = bindStore<SavedEnvironmentRuntimeStoreState>(
  catalog.runtimeStore,
);
export const hasSavedEnvironmentRegistryHydrated = catalog.hasHydrated;
export const waitForSavedEnvironmentRegistryHydration = catalog.waitForHydration;
export const listSavedEnvironmentRecords = catalog.list;
export const getSavedEnvironmentRecord = catalog.get;
/** Hub-linked direct access: routes of a Hub machine, not environments of their own. */
export const listLinkedDirectRecords = catalog.listLinked;
export const getLinkedDirectRecord = catalog.getLinked;
export const persistSavedEnvironmentRecord = catalog.persistRecord;
export const readSavedEnvironmentBearerToken = catalog.readBearerToken;
export const writeSavedEnvironmentBearerToken = catalog.writeBearerToken;
export const removeSavedEnvironmentBearerToken = catalog.removeBearerToken;
export const resetSavedEnvironmentRegistryStoreForTests = catalog.resetForTests;
export const resetSavedEnvironmentRuntimeStoreForTests = catalog.resetRuntimeForTests;
export const getSavedEnvironmentRuntimeState = catalog.getRuntime;

export function getEnvironmentHttpBaseUrl(environmentId: EnvironmentId): string | null {
  if (isHostedHubMode()) return null;
  const primary = getPrimaryKnownEnvironment();
  if (primary?.environmentId === environmentId) return getKnownEnvironmentHttpBaseUrl(primary);
  return getSavedEnvironmentRecord(environmentId)?.httpBaseUrl ?? null;
}

export function resolveEnvironmentHttpUrl(input: {
  readonly environmentId: EnvironmentId;
  readonly pathname: string;
  readonly searchParams?: Record<string, string>;
}): string {
  const baseUrl = getEnvironmentHttpBaseUrl(input.environmentId);
  if (!baseUrl)
    throw new Error(`Unable to resolve HTTP base URL for environment ${input.environmentId}.`);
  const url = new URL(rewriteEnvironmentHttpBaseUrlInDev(baseUrl));
  url.pathname = input.pathname;
  if (input.searchParams) url.search = new URLSearchParams(input.searchParams).toString();
  return url.toString();
}
