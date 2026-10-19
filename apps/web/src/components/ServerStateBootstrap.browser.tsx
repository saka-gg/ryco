import {
  getServerConfig,
  resetEnvironmentServerConfigsForTests,
  resetServerStateForTests,
  writeEnvironmentServerConfig,
} from "@ryco/client-runtime/rpc";
import { EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  connection: null as null | {
    readonly environmentId: string;
    readonly client: { readonly server: { readonly stop: () => void } };
  },
  hosted: false,
  activeEnvironmentId: null as string | null,
  listeners: new Set<() => void>(),
  descriptorListeners: new Set<() => void>(),
  storeListeners: new Set<() => void>(),
  startServerStateSync: vi.fn(
    (connection: { readonly client: { readonly server: { readonly stop: () => void } } }) =>
      connection.client.server.stop,
  ),
}));

vi.mock("../env", async () => ({
  ...(await vi.importActual<typeof import("../env")>("../env")),
  isHostedHubMode: () => harness.hosted,
}));

vi.mock("../environments/primary", () => ({
  getPrimaryKnownEnvironment: () =>
    harness.connection ? { environmentId: harness.connection.environmentId } : null,
  readPrimaryEnvironmentDescriptor: () =>
    harness.connection ? { environmentId: harness.connection.environmentId } : null,
  subscribePrimaryEnvironmentDescriptor: (listener: () => void) => {
    harness.descriptorListeners.add(listener);
    return () => harness.descriptorListeners.delete(listener);
  },
}));

vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: (environmentId: string) =>
    harness.connection?.environmentId === environmentId ? harness.connection : null,
  subscribeEnvironmentConnections: (listener: () => void) => {
    harness.listeners.add(listener);
    return () => harness.listeners.delete(listener);
  },
}));

vi.mock("../rpc/serverState", async () => ({
  startActiveEnvironmentServerConfigProjection: (await import("@ryco/client-runtime/rpc"))
    .startActiveEnvironmentServerConfigProjection,
  startServerStateSync: harness.startServerStateSync,
}));

vi.mock("../store", () => ({
  useStore: {
    getState: () => ({ activeEnvironmentId: harness.activeEnvironmentId }),
    subscribe: (listener: () => void) => {
      harness.storeListeners.add(listener);
      return () => harness.storeListeners.delete(listener);
    },
  },
}));

import { ServerStateBootstrap } from "./ServerStateBootstrap";

const NODE_A = EnvironmentId.make("env_first");
const NODE_B = EnvironmentId.make("env_second");
const NODE_C = EnvironmentId.make("env_saved");

function replaceConnection(connection: typeof harness.connection): void {
  harness.connection = connection;
  for (const listener of harness.descriptorListeners) listener();
  for (const listener of harness.listeners) listener();
}

function setActiveEnvironment(environmentId: EnvironmentId | null): void {
  harness.activeEnvironmentId = environmentId;
  for (const listener of harness.storeListeners) listener();
}

function connectionFor(environmentId: EnvironmentId, stop = vi.fn()) {
  return { environmentId, client: { server: { stop } } };
}

function configFor(environmentId: EnvironmentId, providers: ReadonlyArray<string>): ServerConfig {
  return {
    environment: { environmentId, label: environmentId, capabilities: {} },
    issues: [],
    providers: providers.map((instanceId) => ({ instanceId })),
    settings: {},
  } as unknown as ServerConfig;
}

function shownProviderIds(): ReadonlyArray<string> {
  return (getServerConfig()?.providers ?? []).map((provider) => provider.instanceId);
}

beforeEach(() => {
  harness.connection = null;
  harness.hosted = false;
  harness.activeEnvironmentId = null;
  harness.listeners.clear();
  harness.descriptorListeners.clear();
  harness.storeListeners.clear();
  harness.startServerStateSync.mockClear();
  resetServerStateForTests();
  resetEnvironmentServerConfigsForTests();
});

afterEach(() => {
  harness.connection = null;
  harness.listeners.clear();
  harness.descriptorListeners.clear();
  harness.storeListeners.clear();
  resetServerStateForTests();
  resetEnvironmentServerConfigsForTests();
});

describe("ServerStateBootstrap", () => {
  it("unsubscribes from the previous primary connection and subscribes to its replacement", async () => {
    const stopFirst = vi.fn();
    const stopSecond = vi.fn();
    replaceConnection(connectionFor(NODE_A, stopFirst));
    const mounted = await render(<ServerStateBootstrap />);

    await vi.waitFor(() => expect(harness.startServerStateSync).toHaveBeenCalledTimes(1));
    expect(harness.startServerStateSync).toHaveBeenLastCalledWith(harness.connection);

    replaceConnection(null);
    await vi.waitFor(() => expect(stopFirst).toHaveBeenCalledOnce());

    replaceConnection(connectionFor(NODE_B, stopSecond));
    await vi.waitFor(() => expect(harness.startServerStateSync).toHaveBeenCalledTimes(2));
    expect(harness.startServerStateSync).toHaveBeenLastCalledWith(harness.connection);

    await mounted.unmount();
    expect(stopSecond).toHaveBeenCalledOnce();
  });

  it("shows the newly active hosted environment's stored providers without a write", async () => {
    harness.hosted = true;
    replaceConnection(connectionFor(NODE_A));
    writeEnvironmentServerConfig(NODE_A, configFor(NODE_A, ["codex"]));
    writeEnvironmentServerConfig(NODE_B, configFor(NODE_B, ["claude", "opencode"]));
    harness.activeEnvironmentId = NODE_A;
    const mounted = await render(<ServerStateBootstrap />);

    await vi.waitFor(() => expect(shownProviderIds()).toEqual(["codex"]));

    // Both entries are in the store, so nothing is written or fetched for the
    // switch. (The hosted teardown forgets a left environment's entry, so a
    // return to one waits for its next snapshot; keeping it is a later change.)
    setActiveEnvironment(NODE_B);
    await vi.waitFor(() => expect(shownProviderIds()).toEqual(["claude", "opencode"]));

    setActiveEnvironment(NODE_A);
    await vi.waitFor(() => expect(shownProviderIds()).toEqual(["codex"]));

    await mounted.unmount();
  });

  it("shows a config the store already holds in the shell's first commit", async () => {
    replaceConnection(connectionFor(NODE_A));
    writeEnvironmentServerConfig(NODE_A, configFor(NODE_A, ["codex"]));
    const seenInFirstCommit: Array<ReadonlyArray<string>> = [];
    function FirstCommitProbe() {
      // Runs after the bootstrap's own layout effect, before the first paint.
      useLayoutEffect(() => {
        seenInFirstCommit.push(shownProviderIds());
      }, []);
      return null;
    }
    const mounted = await render(
      <>
        <ServerStateBootstrap />
        <FirstCommitProbe />
      </>,
    );

    expect(seenInFirstCommit).toEqual([["codex"]]);

    await mounted.unmount();
  });

  it("never lets another connection's config replace the active environment's", async () => {
    harness.hosted = true;
    replaceConnection(connectionFor(NODE_A));
    writeEnvironmentServerConfig(NODE_A, configFor(NODE_A, ["codex"]));
    harness.activeEnvironmentId = NODE_A;
    const mounted = await render(<ServerStateBootstrap />);
    await vi.waitFor(() => expect(shownProviderIds()).toEqual(["codex"]));

    // A saved connection's config stream writes its own entry only.
    writeEnvironmentServerConfig(NODE_C, configFor(NODE_C, ["gemini"]));
    expect(shownProviderIds()).toEqual(["codex"]);

    // The active environment's own updates still arrive.
    writeEnvironmentServerConfig(NODE_A, configFor(NODE_A, ["codex", "claude"]));
    await vi.waitFor(() => expect(shownProviderIds()).toEqual(["codex", "claude"]));

    await mounted.unmount();
  });

  it("shows the primary's config before any environment is active", async () => {
    harness.hosted = true;
    replaceConnection(connectionFor(NODE_A));
    writeEnvironmentServerConfig(NODE_A, configFor(NODE_A, ["codex"]));
    const mounted = await render(<ServerStateBootstrap />);

    await vi.waitFor(() => expect(shownProviderIds()).toEqual(["codex"]));

    await mounted.unmount();
  });

  it("follows the primary node when it changes while no environment is active", async () => {
    harness.hosted = true;
    replaceConnection(connectionFor(NODE_A));
    writeEnvironmentServerConfig(NODE_A, configFor(NODE_A, ["codex"]));
    writeEnvironmentServerConfig(NODE_B, configFor(NODE_B, ["claude"]));
    const mounted = await render(<ServerStateBootstrap />);
    await vi.waitFor(() => expect(shownProviderIds()).toEqual(["codex"]));

    replaceConnection(connectionFor(NODE_B));
    await vi.waitFor(() => expect(shownProviderIds()).toEqual(["claude"]));

    await mounted.unmount();
  });

  it("keeps a standard session on its primary node's config", async () => {
    replaceConnection(connectionFor(NODE_A));
    writeEnvironmentServerConfig(NODE_A, configFor(NODE_A, ["codex"]));
    writeEnvironmentServerConfig(NODE_C, configFor(NODE_C, ["gemini"]));
    harness.activeEnvironmentId = NODE_C;
    const mounted = await render(<ServerStateBootstrap />);

    await vi.waitFor(() => expect(shownProviderIds()).toEqual(["codex"]));
    // The thread store changes constantly and decides nothing here.
    expect(harness.storeListeners.size).toBe(0);
    setActiveEnvironment(NODE_A);
    expect(shownProviderIds()).toEqual(["codex"]);

    await mounted.unmount();
  });
});
