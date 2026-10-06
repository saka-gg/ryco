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

describe("retainAgentControlProposalSync", () => {
  it("shares one subscription per environment and stops after the last release", async () => {
    runtime.client = {};
    const first = retainAgentControlProposalSync(LOCAL);
    const second = retainAgentControlProposalSync(LOCAL);
    expect(runtime.subscribeProposals).toHaveBeenCalledTimes(1);
    const unsubscribe = runtime.subscribeProposals.mock.results[0]!.value;

    first();
    first(); // releasing twice counts once
    await flush();
    expect(isAgentControlProposalSyncRetained(LOCAL)).toBe(true);
    expect(unsubscribe).not.toHaveBeenCalled();

    second();
    expect(unsubscribe).not.toHaveBeenCalled();
    await flush();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(isAgentControlProposalSyncRetained(LOCAL)).toBe(false);
  });

  it("hands the subscription over when it is retained again in the same task", async () => {
    runtime.client = {};
    const release = retainAgentControlProposalSync(STUDIO);
    release();
    const again = retainAgentControlProposalSync(STUDIO);
    await flush();
    expect(runtime.subscribeProposals).toHaveBeenCalledTimes(1);
    expect(runtime.subscribeProposals.mock.results[0]!.value).not.toHaveBeenCalled();
    again();
    await flush();
    expect(isAgentControlProposalSyncRetained(STUDIO)).toBe(false);
  });

  it("subscribes once the environment connects", async () => {
    const release = retainAgentControlProposalSync(LOCAL);
    expect(runtime.subscribeProposals).not.toHaveBeenCalled();
    runtime.client = {};
    for (const listener of runtime.listeners) listener();
    expect(runtime.subscribeProposals).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(runtime.listeners.size).toBe(0);
  });
});

describe("proposalSyncKey", () => {
  it("ignores order and duplicates", () => {
    expect(proposalSyncKey([STUDIO, LOCAL, STUDIO])).toBe(proposalSyncKey([LOCAL, STUDIO]));
  });
});
