import type { EnvironmentId } from "@ryco/contracts";
import type { SavedEnvironmentRecord } from "@ryco/client-runtime/connection";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

import { createEnvironmentActions, type EnvironmentActionsDeps } from "./environmentActions";
import { useStore } from "../state/threadsRuntime";

const ENV = "env-a" as EnvironmentId;
const TARGET = {
  httpBaseUrl: "http://node.local/",
  wsBaseUrl: "ws://node.local/",
  credential: "cred-1",
};

function fakeRegistry(
  overrides: {
    writeBearerToken?: (env: EnvironmentId, token: string) => Promise<boolean>;
    priorRecord?: SavedEnvironmentRecord | null;
  } = {},
) {
  const upsert = vi.fn();
  const removeRecord = vi.fn();
  const rename = vi.fn();
  const clearRuntime = vi.fn();
  const persistRecord = vi.fn(async () => undefined);
  const writeBearerToken = vi.fn(overrides.writeBearerToken ?? (async () => true));
  const removeBearerToken = vi.fn(async () => undefined);
  const supervisorRemove = vi.fn(async () => true);
  const cancelPendingSavedEnvironmentConnection = vi.fn();
  const ensureSavedEnvironmentConnection = vi.fn(async () => ({}));
  const disposeForEnv = vi.fn();
  const connectSavedEnvironment = vi.fn(async () => ({}));

  const registry = {
    catalog: {
      get: () => overrides.priorRecord ?? null,
      persistRecord,
      writeBearerToken,
      removeBearerToken,
      registryStore: { getState: () => ({ upsert, remove: removeRecord, rename }) },
      runtimeStore: { getState: () => ({ clear: clearRuntime }) },
    },
    remoteApi: {
      fetchRemoteEnvironmentDescriptor: async () => ({ environmentId: ENV, label: "Node label" }),
      bootstrapRemoteBearerSession: async () => ({ sessionToken: "bearer-xyz", role: "owner" }),
    },
    driver: {
      supervisor: {
        remove: supervisorRemove,
        cancelPendingSavedEnvironmentConnection,
        ensureSavedEnvironmentConnection,
        disposeThreadDetailSubscriptionsForEnvironment: disposeForEnv,
      },
      connectSavedEnvironment,
    },
  } as unknown as EnvironmentActionsDeps["registry"];

  return {
    registry,
    spies: {
      upsert,
      removeRecord,
      rename,
      clearRuntime,
      persistRecord,
      writeBearerToken,
      removeBearerToken,
      supervisorRemove,
      cancelPendingSavedEnvironmentConnection,
      ensureSavedEnvironmentConnection,
      disposeForEnv,
      connectSavedEnvironment,
    },
  };
}

const forgetEnvironment = vi.fn(async () => undefined);

function actions(reg: ReturnType<typeof fakeRegistry>) {
  return createEnvironmentActions({
    registry: reg.registry,
    resolvePairingTarget: () => TARGET,
    now: () => "2026-07-24T00:00:00.000Z",
    trustStore: { forgetEnvironment },
  });
}

describe("environmentActions", () => {
  it("persists the record + bearer token, then upserts and connects", async () => {
    const reg = fakeRegistry();
    const record = await actions(reg).addSavedEnvironment({
      label: "My node",
      pairingUrl: "ryco://pair?host=node.local#token=t",
    });

    expect(reg.spies.persistRecord).toHaveBeenCalledTimes(1);
    expect(reg.spies.writeBearerToken).toHaveBeenCalledWith(ENV, "bearer-xyz");
    expect(reg.spies.upsert).toHaveBeenCalledTimes(1);
    expect(reg.spies.ensureSavedEnvironmentConnection).toHaveBeenCalledTimes(1);
    // A connect still running on the replaced credential is not joined.
    expect(reg.spies.cancelPendingSavedEnvironmentConnection).toHaveBeenCalledWith(ENV);
    expect(
      reg.spies.cancelPendingSavedEnvironmentConnection.mock.invocationCallOrder[0],
    ).toBeLessThan(
      reg.spies.ensureSavedEnvironmentConnection.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    // Secret boundary: the returned record carries no bearer token.
    expect(record).not.toHaveProperty("bearerToken");
    expect(record.environmentId).toBe(ENV);
    expect(record.label).toBe("My node");
  });

  it("rolls back and throws the exact message when the token write fails", async () => {
    const prior = {
      environmentId: ENV,
      label: "Old",
      httpBaseUrl: "http://old/",
      wsBaseUrl: "ws://old/",
      createdAt: "2026-07-01T00:00:00.000Z",
      lastConnectedAt: null,
    } as SavedEnvironmentRecord;
    const reg = fakeRegistry({ writeBearerToken: async () => false, priorRecord: prior });

    await expect(
      actions(reg).addSavedEnvironment({ label: "My node", pairingUrl: "ryco://x" }),
    ).rejects.toThrow("Unable to persist saved environment credentials.");
    // The failing path restores the prior record and never upserts.
    expect(reg.spies.persistRecord).toHaveBeenLastCalledWith(prior);
    expect(reg.spies.upsert).not.toHaveBeenCalled();
  });

  it("removeSavedEnvironment clears the supervisor, catalog, runtime, store, and token", async () => {
    const reg = fakeRegistry();
    const removeEnvironmentState = vi
      .spyOn(useStore.getState(), "removeEnvironmentState")
      .mockImplementation(() => undefined);

    await actions(reg).removeSavedEnvironment(ENV);

    expect(reg.spies.supervisorRemove).toHaveBeenCalledWith(ENV);
    expect(reg.spies.disposeForEnv).toHaveBeenCalledWith(ENV);
    expect(reg.spies.removeRecord).toHaveBeenCalledWith(ENV);
    expect(reg.spies.clearRuntime).toHaveBeenCalledWith(ENV);
    expect(removeEnvironmentState).toHaveBeenCalledWith(ENV);
    expect(reg.spies.removeBearerToken).toHaveBeenCalledWith(ENV);
    // docs/relay-e2ee-protocol.md §13.1/§13.3: forgetting a node forgets its pin,
    // latch, approval and legacy consent too. There is no generic secret-wipe
    // path this rides on, so a missed registration would show up only here.
    expect(forgetEnvironment).toHaveBeenCalledWith(ENV);

    removeEnvironmentState.mockRestore();
  });
});
