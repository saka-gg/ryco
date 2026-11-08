import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HostedEnvironmentSessionRecord } from "./hostedEnvironmentSessions.ts";
import {
  createHostedMutationLeases,
  hostedSessionMutationReadiness,
  type HostedMutationReadiness,
} from "./hostedMutationLeases.ts";

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
    suspended: false,
    relayGap: false,
    snapshotAcceptedAt: 1_000,
    sessionStatus: "ready",
    sessionRecoveredAfterUnknown: false,
  } as HostedEnvironmentSessionRecord;
  const hub = { directoryStatus: "ready", browserStatus: "current" } as const;

  it("is ready only for an adoptable session whose shell the client holds", () => {
    expect(hostedSessionMutationReadiness(record, hub, true)).toEqual(READY);
    expect(hostedSessionMutationReadiness(record, hub, false).shellReady).toBe(false);
    expect(
      hostedSessionMutationReadiness({ ...record, relayGap: true }, hub, true).relayReady,
    ).toBe(false);
    expect(
      hostedSessionMutationReadiness({ ...record, snapshotAcceptedAt: null }, hub, true).shellReady,
    ).toBe(false);
    expect(
      hostedSessionMutationReadiness(record, { ...hub, browserStatus: "error" } as never, true)
        .directoryReady,
    ).toBe(false);
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
