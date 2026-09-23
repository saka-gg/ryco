import { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentConnection } from "../../connection/connection.ts";
import {
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

function harness() {
  let bootstrap = Promise.withResolvers<void>();
  const connection = {
    environmentId,
    knownEnvironment: { source: "manual" },
    ensureBootstrapped: () => bootstrap.promise,
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
    resolve: () => bootstrap.resolve(),
    replaceBootstrap: () => {
      bootstrap = Promise.withResolvers<void>();
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

  it("ignores a stale bootstrap resolution after disconnect or replacement", async () => {
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
