import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";

import { subscribeHubLeaseInputs } from "./hubLeaseInputs";

const MINI = "env-mini" as EnvironmentId;

function fakeConnection() {
  const listeners = new Set<() => void>();
  return {
    shellSnapshotReadiness: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    shellReady: () => {
      for (const listener of Array.from(listeners)) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function fakeSource() {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: () => {
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

describe("subscribeHubLeaseInputs", () => {
  it("wakes when a Hub connection records its shell snapshot after its session is ready", () => {
    let connection = fakeConnection();
    const sessions = fakeSource();
    const listener = vi.fn();
    const stop = subscribeHubLeaseInputs(
      {
        environmentIds: () => [MINI],
        readConnection: () => connection,
        sources: [sessions.subscribe],
      },
      listener,
    );
    // The session is marked ready first: the snapshot is not recorded yet.
    sessions.emit();
    expect(listener).toHaveBeenCalledTimes(1);
    // Then the connection records it: that alone must wake a waiting copy.
    connection.shellReady();
    expect(listener).toHaveBeenCalledTimes(2);

    // A reconnect replaces the connection: the new one is followed, the old one dropped.
    const old = connection;
    connection = fakeConnection();
    sessions.emit();
    expect(old.listenerCount()).toBe(0);
    connection.shellReady();
    expect(listener).toHaveBeenCalledTimes(4);

    stop();
    expect(connection.listenerCount()).toBe(0);
    connection.shellReady();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("stops following a connection whose session went away", () => {
    const connection = fakeConnection();
    const sessions = fakeSource();
    let ids: EnvironmentId[] = [MINI];
    const stop = subscribeHubLeaseInputs(
      {
        environmentIds: () => ids,
        readConnection: () => connection,
        sources: [sessions.subscribe],
      },
      () => undefined,
    );
    expect(connection.listenerCount()).toBe(1);
    ids = [];
    sessions.emit();
    expect(connection.listenerCount()).toBe(0);
    stop();
  });
});
