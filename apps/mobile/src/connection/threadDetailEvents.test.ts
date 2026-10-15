import type { EnvironmentId, OrchestrationEvent } from "@ryco/contracts";
import type { EnvironmentStateSink } from "@ryco/client-runtime/connection";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Native modules are stubbed so the applier (which imports the composer draft
// store and the threads runtime) loads under the Node runner.
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

import { useStore } from "../state/threadsRuntime";
import { createThreadDetailEventApplier } from "./threadDetailEvents";

const ENV_ID = "env-detail-1" as EnvironmentId;

function messageEvent(sequence: number, text: string, streaming: boolean): OrchestrationEvent {
  return {
    sequence,
    type: "thread.message-sent",
    payload: { threadId: "thread-1", messageId: "message-1", text, streaming },
  } as unknown as OrchestrationEvent;
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function makeApplier() {
  const frames: Array<() => void> = [];
  const applied: Array<ReadonlyArray<OrchestrationEvent>> = [];
  const stateSink = {
    applyOrchestrationEvents: vi.fn((_environmentId: EnvironmentId, events) => {
      applied.push([...events]);
    }),
    markProviderInvalidationNeeded: vi.fn(),
    clearThreadDraft: vi.fn(),
    clearProjectDraftThread: vi.fn(),
    clearTerminalState: vi.fn(),
  } as unknown as EnvironmentStateSink;
  const supervisor = { reconcileThreadDetailSubscriptionEvictionForEnvironment: vi.fn() };
  const applier = createThreadDetailEventApplier({
    stateSink,
    getSupervisor: () => supervisor,
    scheduleFrame: (callback) => frames.push(callback),
    scheduleFallback: () => undefined,
  });
  disposers.push(applier.dispose);
  return { applier, frames, applied, stateSink, supervisor };
}

describe("createThreadDetailEventApplier", () => {
  it("applies one frame's detail events as one batch, in arrival order", () => {
    const { applier, frames, applied, supervisor } = makeApplier();
    const events = [
      messageEvent(1, "Earlier ", true),
      messageEvent(2, "tail", true),
      // The empty completion of the same message stays its own event: merging
      // it into the delta would make it a replacement of the whole text.
      messageEvent(3, "", false),
    ];
    for (const event of events) applier.enqueue(ENV_ID, event);

    expect(applied).toEqual([]);
    expect(frames).toHaveLength(1);
    frames[0]!();

    expect(applied).toEqual([events]);
    expect(
      supervisor.reconcileThreadDetailSubscriptionEvictionForEnvironment,
    ).toHaveBeenCalledExactlyOnceWith(ENV_ID);
  });

  it("applies buffered events before any other thread-store write", () => {
    const { applier, frames, applied } = makeApplier();
    const event = messageEvent(1, "delta", true);
    applier.enqueue(ENV_ID, event);
    expect(applied).toEqual([]);

    // A snapshot, removal or shell event lands through a store mutator; the
    // batcher is a mutation barrier, so the earlier detail event goes first.
    useStore.getState().setActiveEnvironmentId(ENV_ID);
    expect(applied).toEqual([[event]]);

    // The scheduled frame has nothing left to apply.
    frames[0]!();
    expect(applied).toHaveLength(1);
  });

  it("applies everything buffered on an explicit flush", () => {
    const { applier, applied } = makeApplier();
    applier.enqueue(ENV_ID, messageEvent(1, "a", true));
    applier.enqueue(ENV_ID, messageEvent(2, "b", true));
    applier.flush();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toHaveLength(2);
  });

  it("applies what is buffered on dispose, and is no longer a store barrier", () => {
    const { applier, applied } = makeApplier();
    applier.enqueue(ENV_ID, messageEvent(1, "a", true));
    applier.dispose();
    expect(applied).toHaveLength(1);

    // A later event stays buffered across a store write: the barrier is gone.
    applier.enqueue(ENV_ID, messageEvent(2, "b", true));
    useStore.getState().setActiveEnvironmentId(ENV_ID);
    expect(applied).toHaveLength(1);
  });
});
