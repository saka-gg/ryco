import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type AgentControlProposalStreamEventView } from "@ryco/contracts";

import { createAgentControlSyncRegistry } from "./retainedSync.ts";
import { useAgentControlStore } from "./store.ts";

const LOCAL = EnvironmentId.make("env-local");
const STUDIO = EnvironmentId.make("env-studio");
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

type Listener = (event: AgentControlProposalStreamEventView) => void;

function makeSource() {
  return {
    subscribeProposals: vi.fn(
      (_listener: Listener, _options?: { onError?: () => void }) =>
        vi.fn() as unknown as () => void,
    ),
  };
}

/** A registry over a fake connection list: `connections` maps environments to their source. */
function makeHarness() {
  const connections = new Map<EnvironmentId, ReturnType<typeof makeSource>>();
  const listeners = new Set<() => void>();
  const applied: Array<{
    environmentId: EnvironmentId;
    event: AgentControlProposalStreamEventView;
  }> = [];
  const cleared: EnvironmentId[] = [];
  const registry = createAgentControlSyncRegistry({
    readSource: (environmentId) => {
      const source = connections.get(environmentId);
      return source ? { source } : null;
    },
    subscribeSourceChanges: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sink: {
      applyStreamEvent: (environmentId, event) => applied.push({ environmentId, event }),
      clearEnvironment: (environmentId) => cleared.push(environmentId),
    },
  });
  return {
    registry,
    listeners,
    applied,
    cleared,
    connect: (environmentId: EnvironmentId) => {
      const source = makeSource();
      connections.set(environmentId, source);
      return source;
    },
    disconnect: (environmentId: EnvironmentId) => connections.delete(environmentId),
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
}

const snapshot: AgentControlProposalStreamEventView = {
  version: 1,
  type: "snapshot",
  queue: { revision: 1, active: [], recent: [] },
};

describe("createAgentControlSyncRegistry", () => {
  it("shares one subscription per environment and stops after the last release", async () => {
    const harness = makeHarness();
    const source = harness.connect(LOCAL);
    const first = harness.registry.retain(LOCAL);
    const second = harness.registry.retain(LOCAL);
    const third = harness.registry.retain(LOCAL);
    expect(source.subscribeProposals).toHaveBeenCalledTimes(1);
    const unsubscribe = source.subscribeProposals.mock.results[0]!.value;

    first();
    first(); // releasing twice counts once
    second();
    await flush();
    expect(harness.registry.isRetained(LOCAL)).toBe(true);
    expect(unsubscribe).not.toHaveBeenCalled();

    third();
    expect(unsubscribe).not.toHaveBeenCalled();
    await flush();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.registry.isRetained(LOCAL)).toBe(false);
    expect(harness.listeners.size).toBe(0);
  });

  it("keeps environments apart", async () => {
    const harness = makeHarness();
    const local = harness.connect(LOCAL);
    const studio = harness.connect(STUDIO);
    const releaseLocal = harness.registry.retain(LOCAL);
    const releaseStudio = harness.registry.retain(STUDIO);
    expect(local.subscribeProposals).toHaveBeenCalledTimes(1);
    expect(studio.subscribeProposals).toHaveBeenCalledTimes(1);
    releaseLocal();
    await flush();
    expect(harness.registry.isRetained(LOCAL)).toBe(false);
    expect(harness.registry.isRetained(STUDIO)).toBe(true);
    releaseStudio();
    await flush();
  });

  it("delivers events to its sink and clears the environment on a refusal", async () => {
    const harness = makeHarness();
    const source = harness.connect(LOCAL);
    const release = harness.registry.retain(LOCAL);
    const [listener, options] = source.subscribeProposals.mock.calls[0]!;
    listener(snapshot);
    expect(harness.applied).toEqual([{ environmentId: LOCAL, event: snapshot }]);
    options?.onError?.();
    expect(harness.cleared).toEqual([LOCAL]);
    release();
    await flush();
  });

  it("hands the subscription over when it is retained again in the same task", async () => {
    const harness = makeHarness();
    const source = harness.connect(STUDIO);
    const release = harness.registry.retain(STUDIO);
    release();
    const again = harness.registry.retain(STUDIO);
    await flush();
    expect(source.subscribeProposals).toHaveBeenCalledTimes(1);
    expect(source.subscribeProposals.mock.results[0]!.value).not.toHaveBeenCalled();
    again();
    await flush();
    expect(harness.registry.isRetained(STUDIO)).toBe(false);
  });

  it("binds again for a new retainer after the server refused the subscription", async () => {
    const harness = makeHarness();
    const source = harness.connect(LOCAL);
    const held = harness.registry.retain(LOCAL);
    const [, options] = source.subscribeProposals.mock.calls[0]!;
    const refusedUnsubscribe = source.subscribeProposals.mock.results[0]!.value;
    // The feature was off: the transport does not retry a refusal.
    options?.onError?.();

    // Turned on: a surface retains the environment again while the first
    // retainer still holds the refused entry.
    const reopened = harness.registry.retain(LOCAL);
    expect(source.subscribeProposals).toHaveBeenCalledTimes(2);
    expect(refusedUnsubscribe).toHaveBeenCalledTimes(1);

    // A healthy subscription is shared as before.
    const third = harness.registry.retain(LOCAL);
    expect(source.subscribeProposals).toHaveBeenCalledTimes(2);
    held();
    reopened();
    third();
    await flush();
    expect(source.subscribeProposals.mock.results[1]!.value).toHaveBeenCalledTimes(1);
    expect(harness.registry.isRetained(LOCAL)).toBe(false);
  });

  it("is held before the environment connects and subscribes once it does", async () => {
    const harness = makeHarness();
    const release = harness.registry.retain(LOCAL);
    expect(harness.registry.isRetained(LOCAL)).toBe(true);
    const source = harness.connect(LOCAL);
    harness.notify();
    expect(source.subscribeProposals).toHaveBeenCalledTimes(1);
    // A change elsewhere leaves a bound subscription alone.
    harness.notify();
    expect(source.subscribeProposals).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(harness.listeners.size).toBe(0);
  });

  it("restarts on a replaced connection, found by a change or by the next retain", async () => {
    const harness = makeHarness();
    const initial = harness.connect(LOCAL);
    const first = harness.registry.retain(LOCAL);

    const replaced = harness.connect(LOCAL);
    harness.notify();
    expect(initial.subscribeProposals.mock.results[0]!.value).toHaveBeenCalledTimes(1);
    expect(replaced.subscribeProposals).toHaveBeenCalledTimes(1);

    // Without a change notification, the next retain finds the new connection.
    const latest = harness.connect(LOCAL);
    const second = harness.registry.retain(LOCAL);
    expect(replaced.subscribeProposals.mock.results[0]!.value).toHaveBeenCalledTimes(1);
    expect(latest.subscribeProposals).toHaveBeenCalledTimes(1);

    // The connection goes away: the stream stops, the hold stays.
    harness.disconnect(LOCAL);
    harness.notify();
    expect(latest.subscribeProposals.mock.results[0]!.value).toHaveBeenCalledTimes(1);
    expect(harness.registry.isRetained(LOCAL)).toBe(true);

    first();
    second();
    await flush();
    expect(harness.registry.isRetained(LOCAL)).toBe(false);
  });

  it("writes to the shared store by default", async () => {
    const source = makeSource();
    const registry = createAgentControlSyncRegistry({ readSource: () => ({ source }) });
    const release = registry.retain(LOCAL);
    const [listener] = source.subscribeProposals.mock.calls[0]!;
    listener(snapshot);
    expect(useAgentControlStore.getState().queueByEnvironmentId[LOCAL]).toBeDefined();
    useAgentControlStore.getState().clearEnvironment(LOCAL);
    release();
    await flush();
  });
});
