import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type AgentControlProposalStreamEventView,
  type AgentControlProposalView,
} from "@ryco/contracts";

import { startAgentControlProposalSync } from "./sync.ts";

const environmentId = EnvironmentId.make("env-1");

const snapshot: AgentControlProposalStreamEventView = {
  version: 1,
  type: "snapshot",
  queue: { revision: 1, active: [], recent: [] },
};

function makeHarness() {
  const applied: Array<{ environmentId: string; event: AgentControlProposalStreamEventView }> = [];
  const cleared: string[] = [];
  let listener: ((event: AgentControlProposalStreamEventView) => void) | null = null;
  let errorListener: (() => void) | null = null;
  let unsubscribed = 0;

  return {
    applied,
    cleared,
    emit: (event: AgentControlProposalStreamEventView) => listener?.(event),
    fail: () => errorListener?.(),
    unsubscribedCount: () => unsubscribed,
    source: {
      subscribeProposals: (
        callback: (event: AgentControlProposalStreamEventView) => void,
        options?: { onError?: () => void },
      ) => {
        listener = callback;
        errorListener = options?.onError ?? null;
        return () => {
          unsubscribed += 1;
          listener = null;
        };
      },
    },
    sink: {
      applyStreamEvent: (id: EnvironmentId, event: AgentControlProposalStreamEventView) => {
        applied.push({ environmentId: id, event });
      },
      clearEnvironment: (id: EnvironmentId) => {
        cleared.push(id);
      },
    },
  };
}

describe("startAgentControlProposalSync", () => {
  it("routes stream events into the sink for its environment", () => {
    const harness = makeHarness();
    startAgentControlProposalSync({
      environmentId,
      source: harness.source,
      sink: harness.sink,
    });

    harness.emit(snapshot);
    expect(harness.applied).toHaveLength(1);
    expect(harness.applied[0]?.environmentId).toBe(environmentId);
    expect(harness.applied[0]?.event.type).toBe("snapshot");
  });

  it("stops delivering and unsubscribes without wiping shared state", () => {
    const harness = makeHarness();
    const stop = startAgentControlProposalSync({
      environmentId,
      source: harness.source,
      sink: harness.sink,
    });

    stop();
    stop();
    harness.emit(snapshot);

    expect(harness.applied).toHaveLength(0);
    expect(harness.unsubscribedCount()).toBe(1);
    // Another sync for the same environment may still be rendering this
    // queue; only an authoritative server refusal clears it.
    expect(harness.cleared).toEqual([]);
  });

  it("keeps proposals of plan kinds this build cannot read, as unsupported", () => {
    const harness = makeHarness();
    startAgentControlProposalSync({
      environmentId,
      source: harness.source,
      sink: harness.sink,
    });
    const proposal = (proposalId: string, plan: AgentControlProposalView["plan"]) =>
      ({ proposalId, plan }) as unknown as AgentControlProposalView;
    const known = proposal("known", { kind: "interruptThread", threadId: "thread-1" } as never);
    const unknown = proposal("unknown", { kind: "unsupported", originalKind: "mirrorRepository" });
    const snapshotWithUnknown: AgentControlProposalStreamEventView = {
      version: 1,
      type: "snapshot",
      queue: { revision: 2, active: [unknown, known], recent: [unknown] },
    };

    harness.emit(snapshotWithUnknown);
    harness.emit({ version: 1, type: "proposal", revision: 3, proposal: unknown });

    // The store renders them as "Update Ryco" cards; nothing clears the queue.
    expect(harness.applied.map(({ event }) => event)).toEqual([
      snapshotWithUnknown,
      { version: 1, type: "proposal", revision: 3, proposal: unknown },
    ]);
    expect(harness.cleared).toEqual([]);
  });

  it("clears the environment when the server refuses the subscription", () => {
    const harness = makeHarness();
    let errored = 0;
    startAgentControlProposalSync({
      environmentId,
      source: harness.source,
      sink: harness.sink,
      onError: () => {
        errored += 1;
      },
    });

    harness.fail();
    expect(harness.cleared).toEqual([environmentId]);
    expect(errored).toBe(1);
  });
});
