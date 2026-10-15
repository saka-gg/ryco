import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  connection: null as null | {
    readonly environmentId: string;
    readonly client: { readonly server: { readonly stop: () => void } };
  },
  listeners: new Set<() => void>(),
  startServerStateSync: vi.fn(
    (connection: { readonly client: { readonly server: { readonly stop: () => void } } }) =>
      connection.client.server.stop,
  ),
}));

vi.mock("../environments/primary", () => ({
  getPrimaryKnownEnvironment: () =>
    harness.connection ? { environmentId: harness.connection.environmentId } : null,
}));

vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: (environmentId: string) =>
    harness.connection?.environmentId === environmentId ? harness.connection : null,
  subscribeEnvironmentConnections: (listener: () => void) => {
    harness.listeners.add(listener);
    return () => harness.listeners.delete(listener);
  },
}));

vi.mock("../rpc/serverState", () => ({
  startServerStateSync: harness.startServerStateSync,
}));

import { ServerStateBootstrap } from "./ServerStateBootstrap";

function replaceConnection(connection: typeof harness.connection): void {
  harness.connection = connection;
  for (const listener of harness.listeners) listener();
}

beforeEach(() => {
  harness.connection = null;
  harness.listeners.clear();
  harness.startServerStateSync.mockClear();
});

afterEach(() => {
  harness.connection = null;
  harness.listeners.clear();
});

describe("ServerStateBootstrap", () => {
  it("unsubscribes from the previous primary connection and subscribes to its replacement", async () => {
    const stopFirst = vi.fn();
    const stopSecond = vi.fn();
    replaceConnection({
      environmentId: "env_first",
      client: { server: { stop: stopFirst } },
    });
    const mounted = await render(<ServerStateBootstrap />);

    await vi.waitFor(() => expect(harness.startServerStateSync).toHaveBeenCalledTimes(1));
    expect(harness.startServerStateSync).toHaveBeenLastCalledWith(harness.connection);

    replaceConnection(null);
    await vi.waitFor(() => expect(stopFirst).toHaveBeenCalledOnce());

    replaceConnection({
      environmentId: "env_second",
      client: { server: { stop: stopSecond } },
    });
    await vi.waitFor(() => expect(harness.startServerStateSync).toHaveBeenCalledTimes(2));
    expect(harness.startServerStateSync).toHaveBeenLastCalledWith(harness.connection);

    await mounted.unmount();
    expect(stopSecond).toHaveBeenCalledOnce();
  });
});
