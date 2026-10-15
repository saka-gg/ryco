import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { watchDirectCredentialAccess } from "./directCredentialAccess";

const NODE_A = "node-a" as EnvironmentId;
const NODE_B = "node-b" as EnvironmentId;

function fakeCatalog(initial: ReadonlyArray<EnvironmentId>) {
  let environments = [...initial];
  const tokens = new Map<EnvironmentId, string>();
  const listeners = new Set<() => void>();
  const gates = new Map<EnvironmentId, Promise<void>>();
  const readBearerToken = vi.fn(async (environmentId: EnvironmentId) => {
    await gates.get(environmentId);
    return tokens.get(environmentId) ?? null;
  });
  return {
    catalog: {
      waitForHydration: async () => {},
      list: () => environments.map((environmentId) => ({ environmentId })),
      readBearerToken,
      registryStore: {
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    readBearerToken,
    setToken: (environmentId: EnvironmentId, token: string) => tokens.set(environmentId, token),
    setEnvironments: (next: ReadonlyArray<EnvironmentId>) => {
      environments = [...next];
    },
    /** Holds every keychain read for the environment until the returned release. */
    holdReads: (environmentId: EnvironmentId) => {
      let release = () => {};
      gates.set(environmentId, new Promise<void>((resolve) => (release = resolve)));
      return () => {
        gates.delete(environmentId);
        release();
      };
    },
    /** A registry write, such as `markConnected` on a socket open. */
    notify: () => listeners.forEach((listener) => listener()),
  };
}

describe("watchDirectCredentialAccess", () => {
  it("does not reread the keychain when a connect only marks an environment connected", async () => {
    const fake = fakeCatalog([NODE_A]);
    fake.setToken(NODE_A, "bearer");
    const publish = vi.fn();
    const stop = watchDirectCredentialAccess(fake.catalog, publish);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(true));
    expect(fake.readBearerToken).toHaveBeenCalledOnce();

    fake.notify();
    fake.notify();
    await Promise.resolve();

    expect(fake.readBearerToken).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    stop();
  });

  it("rereads when the saved environments change", async () => {
    const fake = fakeCatalog([NODE_A]);
    fake.setToken(NODE_A, "bearer");
    const publish = vi.fn();
    const stop = watchDirectCredentialAccess(fake.catalog, publish);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(true));

    // The only paired machine is removed.
    fake.setEnvironments([]);
    fake.notify();

    await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith(false));
    stop();
  });

  it("rereads on every change while no credential is readable, so pairing the same node again unlocks", async () => {
    const fake = fakeCatalog([NODE_A, NODE_B]);
    const publish = vi.fn();
    const stop = watchDirectCredentialAccess(fake.catalog, publish);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(false));

    // Paired again: the same id, a new credential, then the record upsert.
    fake.setToken(NODE_B, "new-bearer");
    fake.notify();

    await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith(true));
    stop();
  });

  it("rereads a set that changed back while a newer read was in flight", async () => {
    const fake = fakeCatalog([NODE_A]);
    fake.setToken(NODE_A, "bearer");
    const publish = vi.fn();
    const stop = watchDirectCredentialAccess(fake.catalog, publish);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(true));

    // NODE_A is swapped for NODE_B, whose keychain read is slow ...
    const releaseB = fake.holdReads(NODE_B);
    fake.setEnvironments([NODE_B]);
    fake.notify();
    await vi.waitFor(() => expect(fake.readBearerToken).toHaveBeenCalledWith(NODE_B));
    // ... and swapped back before that read answers.
    fake.setEnvironments([NODE_A]);
    fake.notify();
    releaseB();

    await vi.waitFor(() => expect(fake.readBearerToken).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    await Promise.resolve();
    // The answer for NODE_B alone is never published over the restored set.
    expect(publish.mock.calls).toEqual([[true], [true]]);
    stop();
  });

  it("publishes nothing once stopped", async () => {
    const fake = fakeCatalog([NODE_A]);
    fake.setToken(NODE_A, "bearer");
    const publish = vi.fn();
    const stop = watchDirectCredentialAccess(fake.catalog, publish);
    stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });
});
