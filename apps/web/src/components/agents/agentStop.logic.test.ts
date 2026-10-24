import type { HostedRpcCapability } from "@ryco/client-runtime/authorization/capabilities";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, OrchestrationStopBackgroundTaskError, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeSubagentStopFailure,
  isEnvironmentReachable,
  resolveSubagentStopAvailability,
  subagentStopKey,
  subagentStopRefusal,
} from "./agentStop.logic";

const NOT_HOSTED: HostedRpcCapability = {
  hosted: false,
  allowed: true,
  reason: null,
  kind: "ready",
};
const HOSTED_READY: HostedRpcCapability = {
  hosted: true,
  allowed: true,
  reason: null,
  kind: "ready",
};
const STALE_REASON = "This action is unavailable while Hub authorization or the relay is stale.";

function refused(kind: NonNullable<HostedRpcCapability["kind"]>): HostedRpcCapability {
  return { hosted: true, allowed: false, reason: STALE_REASON, kind };
}

describe("isEnvironmentReachable", () => {
  it("needs the environment's socket connected", () => {
    for (const wsPhase of ["idle", "connecting", "disconnected"] as const) {
      expect(
        isEnvironmentReachable({ savedEnvironment: false, savedConnectionState: null, wsPhase }),
      ).toBe(false);
    }
    expect(
      isEnvironmentReachable({
        savedEnvironment: false,
        savedConnectionState: null,
        wsPhase: "connected",
      }),
    ).toBe(true);
  });

  it("also needs a saved environment's own connection", () => {
    expect(
      isEnvironmentReachable({
        savedEnvironment: true,
        savedConnectionState: "connected",
        wsPhase: "connected",
      }),
    ).toBe(true);
    for (const savedConnectionState of [null, "connecting", "disconnected", "error"] as const) {
      expect(
        isEnvironmentReachable({
          savedEnvironment: true,
          savedConnectionState,
          wsPhase: "connected",
        }),
      ).toBe(false);
    }
  });
});

describe("resolveSubagentStopAvailability", () => {
  it("offers Stop when the connection takes it and the environment is reachable", () => {
    for (const capability of [NOT_HOSTED, HOSTED_READY]) {
      expect(
        resolveSubagentStopAvailability({ capability, nodeLabel: null, reachable: true }),
      ).toEqual({ unavailableReason: null });
    }
  });

  it("hides Stop from a role that may not stop agents", () => {
    for (const reachable of [true, false]) {
      expect(
        resolveSubagentStopAvailability({
          capability: {
            hosted: true,
            allowed: false,
            reason: "This action is unavailable for your role on this node.",
            kind: "role",
          },
          nodeLabel: "Studio",
          reachable,
        }),
      ).toBe("hidden");
    }
  });

  it("says when a connection being established will take a stop", () => {
    expect(
      resolveSubagentStopAvailability({
        capability: refused("establishing"),
        nodeLabel: "Studio",
        reachable: true,
      }),
    ).toEqual({ unavailableReason: "Available when Studio is connected" });
    expect(
      resolveSubagentStopAvailability({
        capability: refused("establishing"),
        nodeLabel: null,
        reachable: false,
      }),
    ).toEqual({ unavailableReason: "Available when this node is connected" });
  });

  it("keeps the reason of any other hosted refusal", () => {
    for (const kind of ["stale", "delivery-unknown"] as const) {
      expect(
        resolveSubagentStopAvailability({
          capability: refused(kind),
          nodeLabel: "Studio",
          reachable: false,
        }),
      ).toEqual({ unavailableReason: STALE_REASON });
    }
    expect(
      resolveSubagentStopAvailability({
        capability: { hosted: true, allowed: false, reason: null, kind: "stale" },
        nodeLabel: "Studio",
        reachable: true,
      }),
    ).toEqual({ unavailableReason: "Stopping agents is unavailable on this connection." });
  });

  it("disables Stop while the environment is not reachable", () => {
    expect(
      resolveSubagentStopAvailability({
        capability: NOT_HOSTED,
        nodeLabel: null,
        reachable: false,
      }),
    ).toEqual({ unavailableReason: "Not connected to this environment." });
  });
});

describe("subagentStopRefusal", () => {
  it("refuses only what the connection does not take", () => {
    expect(subagentStopRefusal(HOSTED_READY, "Studio")).toBeNull();
    expect(subagentStopRefusal(refused("establishing"), "Studio")).toBe(
      "Available when Studio is connected",
    );
    expect(subagentStopRefusal(refused("stale"), "Studio")).toBe(STALE_REASON);
  });
});

describe("describeSubagentStopFailure", () => {
  function nodeError(reason: OrchestrationStopBackgroundTaskError["reason"]) {
    return new OrchestrationStopBackgroundTaskError({ reason, threadId: "thread-1", taskId: "t1" });
  }

  it("speaks of the agent for each reason the node gives", () => {
    expect(describeSubagentStopFailure(nodeError("unsupported"))).toBe(
      "This provider can't stop a single agent.",
    );
    expect(describeSubagentStopFailure(nodeError("session-not-found"))).toBe(
      "This agent's session has ended.",
    );
    expect(describeSubagentStopFailure(nodeError("stop-failed"))).toBe(
      "The agent did not stop. Try again.",
    );
  });

  it("keeps any other error's message", () => {
    expect(describeSubagentStopFailure(new Error("This environment can't stop agents."))).toBe(
      "This environment can't stop agents.",
    );
    expect(
      describeSubagentStopFailure({
        _tag: "OrchestrationStopBackgroundTaskError",
        reason: "from-a-newer-node",
        message: "Stopping the background task failed.",
      }),
    ).toBe("Stopping the background task failed.");
  });

  it("falls back when there is nothing to show", () => {
    for (const cause of [new Error("  "), "boom", undefined, null, 42]) {
      expect(describeSubagentStopFailure(cause)).toBe("Could not stop this agent.");
    }
  });
});

describe("subagentStopKey", () => {
  it("tells activations of the same task, and the same task of other threads, apart", () => {
    const thread = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
    const identity = { taskId: "t1", runtimeSessionId: "rt-1", attempt: 0 };
    const key = subagentStopKey(thread, identity);
    expect(key).toBe("env-1:thread-1:rt-1:t1:0");
    expect(subagentStopKey(thread, { ...identity, runtimeSessionId: "rt-2" })).not.toBe(key);
    expect(subagentStopKey(thread, { ...identity, attempt: 1 })).not.toBe(key);
    expect(
      subagentStopKey(scopeThreadRef(thread.environmentId, ThreadId.make("thread-2")), identity),
    ).not.toBe(key);
    expect(
      subagentStopKey(scopeThreadRef(EnvironmentId.make("env-2"), thread.threadId), identity),
    ).not.toBe(key);
  });
});
