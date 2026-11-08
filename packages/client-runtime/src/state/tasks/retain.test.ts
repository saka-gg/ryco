import { EnvironmentId, type LocalTaskListResult } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AppState } from "../threads/store.ts";
import {
  combineLocalTasksRefreshTriggers,
  retainConnectedLocalTasks,
  type LocalTasksConnection,
  type LocalTasksConnections,
  type LocalTasksThreadStore,
} from "./retain.ts";
import { isLocalTasksRetained, type LocalTasksApi } from "./sync.ts";

const ENV = EnvironmentId.make("env-tasks-retain");
const EMPTY: LocalTaskListResult = { tasks: [], nextCursor: null };

/** A connection whose shell readiness the test moves by hand. */
function fakeConnection(client: object) {
  let ready: object | null = null;
  const listeners = new Set<() => void>();
  const connection: LocalTasksConnection = {
    client: client as LocalTasksConnection["client"],
    shellSnapshotReadiness: {
      read: () => ready,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  return {
    connection,
    deliverSnapshot: () => {
      ready = {};
      for (const listener of listeners) listener();
    },
  };
}

function fakeConnections() {
  let current: LocalTasksConnection | null = null;
  const apis = new Map<unknown, LocalTasksApi>();
  const listeners = new Set<() => void>();
  const connections: LocalTasksConnections = {
    read: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readApi: (_environmentId, client) => (client ? apis.get(client) : undefined),
  };
  return {
    connections,
    /** Puts a new connection with its own api in place, as a reconnect with a new client would. */
    connect: (client: object, api: LocalTasksApi) => {
      apis.set(client, api);
      const fake = fakeConnection(client);
      current = fake.connection;
      for (const listener of listeners) listener();
      return fake;
    },
  };
}

const threads: LocalTasksThreadStore = {
  getState: () => ({}) as AppState,
  subscribe: () => () => undefined,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("retainConnectedLocalTasks", () => {
  it("reads through the connection there is, and again through a new client", async () => {
    const fake = fakeConnections();
    const first = vi.fn(async () => EMPTY);
    fake.connect({}, { listLocalTasks: first });
    const release = retainConnectedLocalTasks(ENV, { connections: fake.connections, threads });
    await flush();
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn(async () => EMPTY);
    fake.connect({}, { listLocalTasks: second });
    await flush();
    expect(second).toHaveBeenCalledTimes(1);
    expect(isLocalTasksRetained(ENV)).toBe(true);

    release();
    await flush();
    expect(isLocalTasksRetained(ENV)).toBe(false);
  });

  it("re-reads when the same client comes back with a fresh shell snapshot", async () => {
    const fake = fakeConnections();
    const list = vi.fn(async () => EMPTY);
    const connection = fake.connect({}, { listLocalTasks: list });
    const release = retainConnectedLocalTasks(ENV, { connections: fake.connections, threads });
    await flush();
    // The connection's first snapshot adds nothing to the read already made.
    connection.deliverSnapshot();
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    // A reconnect of the same client delivers another one: what changed meanwhile is read.
    connection.deliverSnapshot();
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    release();
  });

  it("runs the platform's own signals too", async () => {
    const fake = fakeConnections();
    const list = vi.fn(async () => EMPTY);
    fake.connect({}, { listLocalTasks: list });
    let signal: (() => void) | null = null;
    const release = retainConnectedLocalTasks(ENV, {
      connections: fake.connections,
      threads,
      triggers: (refresh) => {
        signal = () => refresh();
        return () => {
          signal = null;
        };
      },
    });
    await flush();
    expect(signal).not.toBeNull();
    signal!();
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    release();
    await flush();
    expect(signal).toBeNull();
  });
});

describe("combineLocalTasksRefreshTriggers", () => {
  it("starts and stops every trigger", () => {
    const stops = [vi.fn(), vi.fn()];
    const combined = combineLocalTasksRefreshTriggers(
      () => stops[0]!,
      () => stops[1]!,
    );
    const stop = combined(() => undefined);
    stop();
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).toHaveBeenCalledOnce();
  });
});
