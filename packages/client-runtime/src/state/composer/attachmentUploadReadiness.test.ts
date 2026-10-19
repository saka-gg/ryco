import { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentConnection } from "../../connection/connection.ts";
import {
  getWsConnectionStatusForEnvironment,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../../rpc/wsConnectionState.ts";
import { watchDirectChatFileUploadReadiness } from "./attachmentUploadReadiness.ts";

const environmentId = EnvironmentId.make("upload-env");
const metadata = { environmentId };
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(resetWsConnectionStateForTests);

function harness(options: { readonly hostedEstablishing?: () => boolean } = {}) {
  let snapshot: object | null = null;
  let snapshotAttempt = -1;
  const shellListeners = new Set<() => void>();
  const connection = {
    environmentId,
    knownEnvironment: { source: "manual" },
    shellSnapshotReadiness: {
      read: () =>
        getWsConnectionStatusForEnvironment(environmentId).phase === "connected" &&
        getWsConnectionStatusForEnvironment(environmentId).attemptCount === snapshotAttempt
          ? snapshot
          : null,
      subscribe: (listener: () => void) => {
        shellListeners.add(listener);
        return () => {
          shellListeners.delete(listener);
        };
      },
    },
  } as EnvironmentConnection;
  let current: EnvironmentConnection | null = connection;
  let allowed = true;
  const listeners = new Set<() => void>();
  const onChange = vi.fn(() => {
    readiness.read();
  });
  const readiness = watchDirectChatFileUploadReadiness({
    environmentId,
    readConnection: () => current,
    canUpload: () => allowed,
    ...(options.hostedEstablishing ? { hostedEstablishing: options.hostedEstablishing } : {}),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onChange,
  });
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const open = () => {
    recordWsConnectionAttempt("ws://test.invalid", metadata);
    recordWsConnectionOpened(metadata);
  };
  return {
    readiness,
    connection,
    onChange,
    open,
    resolve: () => {
      snapshot = {};
      snapshotAttempt = getWsConnectionStatusForEnvironment(environmentId).attemptCount;
      for (const listener of shellListeners) listener();
    },
    replaceBootstrap: () => {
      snapshot = null;
      for (const listener of shellListeners) listener();
    },
    setConnection: (value: EnvironmentConnection | null) => {
      current = value;
      notify();
    },
    setAllowed: (value: boolean) => {
      allowed = value;
      notify();
    },
    listeners,
  };
}

describe("direct upload readiness", () => {
  it("requires an authenticated socket and its current shell bootstrap", async () => {
    const h = harness();
    expect(h.readiness.read()).toBeNull();
    h.open();
    expect(h.readiness.read()).toBeNull();
    h.resolve();
    await flush();
    const first = h.readiness.read();
    expect(first).not.toBeNull();
    expect(h.readiness.read()).toBe(first);
    recordWsConnectionClosed({}, metadata);
    expect(h.readiness.read()).toBeNull();
    h.open();
    // Socket open can notify before the transport resets shell subscriptions.
    h.replaceBootstrap();
    await flush();
    expect(h.readiness.read()).toBeNull();
    h.resolve();
    await flush();
    expect(h.readiness.read()).not.toBeNull();
    expect(h.readiness.read()).not.toBe(first);
    h.readiness.dispose();
  });

  it("stays unavailable after disconnect or connection removal", async () => {
    const h = harness();
    h.open();
    const resolveOld = h.resolve;
    recordWsConnectionClosed({}, metadata);
    resolveOld();
    await flush();
    expect(h.readiness.read()).toBeNull();
    h.replaceBootstrap();
    h.open();
    h.setConnection(null);
    h.resolve();
    await flush();
    expect(h.readiness.read()).toBeNull();
    h.readiness.dispose();
  });

  it("fails closed for hosted connections even with a connected socket and resolved shell", async () => {
    const h = harness();
    h.setConnection({
      ...h.connection,
      knownEnvironment: { ...h.connection.knownEnvironment, source: "hub-hosted" },
    });
    h.open();
    h.resolve();
    await flush();
    expect(h.readiness.read()).toBeNull();
    h.readiness.dispose();
  });

  it("words a hosted node's connection being established as a wait, never as ready", async () => {
    let establishing = true;
    const h = harness({ hostedEstablishing: () => establishing });
    const hosted = {
      ...h.connection,
      knownEnvironment: { ...h.connection.knownEnvironment, source: "hub-hosted" },
    } as EnvironmentConnection;
    const syncing = {
      label: "Syncing",
      message: "Waiting for this node to connect.",
      cancelInFlight: false,
    };

    // Before its connection exists, and once it is on its way.
    h.setConnection(null);
    expect(h.readiness.unavailable?.()).toEqual(syncing);
    h.setConnection(hosted);
    h.open();
    h.resolve();
    await flush();
    expect(h.readiness.unavailable?.()).toEqual(syncing);
    expect(h.readiness.read()).toBeNull();

    // Established: hosted uploads keep failing closed with the usual reason.
    establishing = false;
    expect(h.readiness.unavailable?.()).toMatchObject({
      label: "Authorize",
      cancelInFlight: true,
    });
    expect(h.readiness.read()).toBeNull();
    h.readiness.dispose();
  });

  it("ignores the hosted wait for a direct connection", async () => {
    const h = harness({ hostedEstablishing: () => true });
    expect(h.readiness.unavailable?.()).toMatchObject({ label: "Reconnect" });
    h.open();
    h.resolve();
    await flush();
    expect(h.readiness.read()).not.toBeNull();
    h.readiness.dispose();
  });

  it("revokes authority and disposes subscriptions without late notifications", async () => {
    const h = harness();
    h.open();
    h.resolve();
    await flush();
    expect(h.readiness.read()).not.toBeNull();
    h.setAllowed(false);
    expect(h.readiness.read()).toBeNull();
    h.replaceBootstrap();
    h.setAllowed(true);
    h.readiness.dispose();
    h.onChange.mockClear();
    h.resolve();
    await flush();
    h.open();
    expect(h.readiness.read()).toBeNull();
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });
});
