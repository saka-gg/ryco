import type { KVService, SecretKVService } from "@ryco/client-runtime/platform";
import {
  createSavedEnvironmentCatalog,
  type SavedEnvironmentKV,
} from "@ryco/client-runtime/connection";
import { PersistedSavedEnvironmentRecord } from "@ryco/contracts/saved-environment";
import { decodeSavedEnvironmentRecords } from "@ryco/shared/savedEnvironmentRecord";

import { mobileKV, mobileSecretKV } from "../platform";

const REGISTRY_KEY = "ryco.savedEnvironments.registry";

type RegistryKV = Pick<KVService, "getItem" | "setItem">;

/**
 * Adapts the async KV to the catalog's registry persistence: the saved-
 * environment records are stored as one JSON document under a single key.
 * Secrets (bearer tokens) never enter this document — they live in SecretKV.
 */
export function createMobileSavedEnvironmentKV(kv: RegistryKV = mobileKV): SavedEnvironmentKV {
  return {
    getRegistry: async () => {
      const raw = await kv.getItem(REGISTRY_KEY);
      if (!raw) return [];
      try {
        // Record by record: one this build cannot read is left out, the rest still connect.
        return decodeSavedEnvironmentRecords(JSON.parse(raw), PersistedSavedEnvironmentRecord);
      } catch {
        return [];
      }
    },
    setRegistry: async (records) => {
      await kv.setItem(REGISTRY_KEY, JSON.stringify(records));
    },
  };
}

export function createMobileSavedEnvironmentCatalog(input?: {
  readonly kv?: RegistryKV;
  readonly secretKV?: SecretKVService;
}): ReturnType<typeof createSavedEnvironmentCatalog> {
  return createSavedEnvironmentCatalog({
    kv: createMobileSavedEnvironmentKV(input?.kv ?? mobileKV),
    secretKV: input?.secretKV ?? mobileSecretKV,
  });
}
