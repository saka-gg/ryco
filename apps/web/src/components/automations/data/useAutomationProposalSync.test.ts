import { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  client: null as object | null,
  listeners: new Set<() => void>(),
  subscribeProposals: vi.fn(() => vi.fn()),
}));
vi.mock("../../../environments/runtime", () => ({
  readEnvironmentConnection: () => (runtime.client ? { client: runtime.client } : null),
  subscribeEnvironmentConnections: (listener: () => void) => {
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  },
}));
vi.mock("../../../environmentApi", () => ({
  readEnvironmentApiForConnection: () => ({
    agentControl: { subscribeProposals: runtime.subscribeProposals },
  }),
}));

import {
  isAgentControlProposalSyncRetained,
  proposalSyncKey,
  retainAgentControlProposalSync,
} from "./useAutomationProposalSync";

const LOCAL = EnvironmentId.make("env-local");
const STUDIO = EnvironmentId.make("env-studio");
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  runtime.client = null;
  runtime.listeners.clear();
  runtime.subscribeProposals.mockClear();
});

// Reference counting, hand-over and refusal rules are the shared registry's
// (client-runtime `retainedSync.test.ts`); these cover the web binding.
describe("retainAgentControlProposalSync", () => {
  it("shares one subscription per connection although the api is built per read", async () => {
    runtime.client = {};
    const first = retainAgentControlProposalSync(LOCAL);
    const second = retainAgentControlProposalSync(LOCAL);
    for (const listener of runtime.listeners) listener();
    expect(runtime.subscribeProposals).toHaveBeenCalledTimes(1);
    const unsubscribe = runtime.subscribeProposals.mock.results[0]!.value;
    first();
    await flush();
    expect(isAgentControlProposalSyncRetained(LOCAL)).toBe(true);
    second();
    await flush();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(isAgentControlProposalSyncRetained(LOCAL)).toBe(false);
  });

  it("subscribes once the environment connects", async () => {
    const release = retainAgentControlProposalSync(LOCAL);
    expect(runtime.subscribeProposals).not.toHaveBeenCalled();
    expect(isAgentControlProposalSyncRetained(LOCAL)).toBe(true);
    runtime.client = {};
    for (const listener of runtime.listeners) listener();
    expect(runtime.subscribeProposals).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(runtime.listeners.size).toBe(0);
  });

  it("restarts the stream when the environment's connection is replaced", async () => {
    runtime.client = {};
    const release = retainAgentControlProposalSync(STUDIO);
    runtime.client = {};
    for (const listener of runtime.listeners) listener();
    expect(runtime.subscribeProposals).toHaveBeenCalledTimes(2);
    expect(runtime.subscribeProposals.mock.results[0]!.value).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(runtime.subscribeProposals.mock.results[1]!.value).toHaveBeenCalledTimes(1);
  });
});

describe("proposalSyncKey", () => {
  it("ignores order and duplicates", () => {
    expect(proposalSyncKey([STUDIO, LOCAL, STUDIO])).toBe(proposalSyncKey([LOCAL, STUDIO]));
  });
});
