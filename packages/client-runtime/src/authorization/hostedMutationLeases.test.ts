import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HostedEnvironmentSessionRecord } from "./hostedEnvironmentSessions.ts";
import {
  createHostedMutationLeases,
  hostedCatalogAllowsMutation,
  hostedSessionMutationReadiness,
  isHostedConnectableNode,
  type HostedMutationReadiness,
} from "./hostedMutationLeases.ts";
import type { HostedHubNode } from "./types.ts";

const MINI = EnvironmentId.make("environment-mini");

const READY: HostedMutationReadiness = {
  environmentId: MINI,
  snapshotGeneration: 4,
  effectiveRole: "owner",
  directoryReady: true,
  relayReady: true,
  shellReady: true,
};

function fakeSource(initial: ReadonlyArray<HostedMutationReadiness>) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    source: {
      readAll: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    set(next: ReadonlyArray<HostedMutationReadiness>, notify = true) {
      current = next;
      if (notify) for (const listener of Array.from(listeners)) listener();
    },
  };
}

describe("hostedSessionMutationReadiness", () => {
  const record = {
    environmentId: MINI,
    generation: 4,
    effectiveRole: "owner",
    transportStatus: "online",
    sessionEstablished: true,
    sessionStatus: "ready",
  } as HostedEnvironmentSessionRecord;
  const node = {
    environmentId: MINI,
    revokedAt: null,
    presence: { online: true },
    capabilities: null,
  } as unknown as HostedHubNode;
  const hub = { directoryStatus: "ready", browserStatus: "current", nodes: [node] } as const;
  const ready = { directoryReady: true, relayReady: true, shellReady: true };

  it("is ready for a connected session on a listed, connectable node whose shell is held", () => {
    expect(hostedSessionMutationReadiness({ hub, record, client: "web", shellHeld: true })).toEqual(
      ready,
    );
  });

  it("is not ready once anything the web coordinator checks is missing", () => {
    const shell = (input: Partial<Parameters<typeof hostedSessionMutationReadiness>[0]>) =>
      hostedSessionMutationReadiness({ hub, record, client: "web", shellHeld: true, ...input })
        .shellReady;
    expect(shell({ shellHeld: false })).toBe(false);
    expect(shell({ hub: { ...hub, nodes: [] } })).toBe(false);
    expect(shell({ hub: { ...hub, nodes: [{ ...node, revokedAt: 1_000 }] } })).toBe(false);
    expect(
      shell({ hub: { ...hub, nodes: [{ ...node, presence: { online: false } }] } as never }),
    ).toBe(false);
    expect(shell({ record: { ...record, sessionStatus: "replaying" } })).toBe(false);
    expect(
      hostedSessionMutationReadiness({
        hub,
        record: { ...record, sessionEstablished: false },
        client: "web",
        shellHeld: true,
      }).relayReady,
    ).toBe(false);
    expect(
      hostedSessionMutationReadiness({
        hub: { ...hub, browserStatus: "error" } as never,
        record,
        client: "web",
        shellHeld: true,
      }).directoryReady,
    ).toBe(false);
  });

  it("lets only a native client hold a node that needs one", () => {
    const nativeOnly = { ...node, capabilities: { nativeClientRequired: true } } as HostedHubNode;
    expect(isHostedConnectableNode(nativeOnly, "web")).toBe(false);
    expect(isHostedConnectableNode(nativeOnly, "native")).toBe(true);
  });

  it("grants only while the published catalog shows the machine connected and open to changes", () => {
    const machine = { environmentId: MINI, connectionState: "connected", canMutate: true };
    expect(hostedCatalogAllowsMutation([machine], MINI)).toBe(true);
    expect(hostedCatalogAllowsMutation([{ ...machine, canMutate: false }], MINI)).toBe(false);
    expect(hostedCatalogAllowsMutation([{ ...machine, connectionState: "connecting" }], MINI)).toBe(
      false,
    );
    expect(hostedCatalogAllowsMutation([], MINI)).toBe(false);
  });
});

describe("createHostedMutationLeases", () => {
  it("waits for an owner session to be ready, then grants a lease", async () => {
    const fake = fakeSource([{ ...READY, relayReady: false }]);
    const leases = createHostedMutationLeases(fake.source);
    let isCurrent: (() => boolean) | null = null;
    void leases.await(MINI, new AbortController().signal).then((check) => {
      isCurrent = check;
    });
    await Promise.resolve();
    expect(isCurrent).toBeNull();
    fake.set([READY]);
    await Promise.resolve();
    expect(isCurrent).not.toBeNull();
    expect(isCurrent!()).toBe(true);
  });

  it("never grants a lease to a session that is not the owner's", async () => {
    const fake = fakeSource([{ ...READY, effectiveRole: "operator" }]);
    const leases = createHostedMutationLeases(fake.source);
    const controller = new AbortController();
    const waiting = leases.await(MINI, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("Stopped waiting");
  });

  it("revokes the lease for good once the session renews, even before it is told", async () => {
    const fake = fakeSource([READY]);
    const leases = createHostedMutationLeases(fake.source);
    const isCurrent = await leases.await(MINI, new AbortController().signal);
    expect(isCurrent()).toBe(true);
    // A new relay attempt: a new generation, read at the instant of the call.
    fake.set([{ ...READY, snapshotGeneration: 5 }], false);
    expect(isCurrent()).toBe(false);
    // The relay dropping and coming back with the same generation still revokes it.
    const again = await leases.await(MINI, new AbortController().signal);
    fake.set([{ ...READY, snapshotGeneration: 5, relayReady: false }]);
    fake.set([{ ...READY, snapshotGeneration: 5 }]);
    expect(again()).toBe(false);
  });

  it("revokes the lease when the session goes away", async () => {
    const fake = fakeSource([READY]);
    const leases = createHostedMutationLeases(fake.source);
    const isCurrent = await leases.await(MINI, new AbortController().signal);
    fake.set([]);
    fake.set([READY]);
    expect(isCurrent()).toBe(false);
  });
});
