import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hostedCapabilityCopy,
  hostedQueuedCopy,
  hostedSwitchTargetLabel,
  hostedSwitchTargetQueued,
  hostedSyncingCopy,
} from "./switchTarget";
import type { HostedHubNode } from "./types";

const ENV_X = EnvironmentId.make("env_xxxxxxxxxxxxxxxxxxxxxx");
const ENV_Y = EnvironmentId.make("env_yyyyyyyyyyyyyyyyyyyyyy");
const ENV_Z = EnvironmentId.make("env_zzzzzzzzzzzzzzzzzzzzzz");

function hubNode(environmentId: EnvironmentId, label: string): HostedHubNode {
  const suffix = environmentId.slice(4);
  return {
    id: `node_${suffix}`,
    environmentId,
    label,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${suffix}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

const STALE_REASON = "This action is unavailable while Hub authorization or the relay is stale.";

describe("hostedSwitchTargetLabel", () => {
  const nodes = [hubNode(ENV_X, "Studio Mac"), hubNode(ENV_Y, "Build box")];

  it("names the environment's node from the directory", () => {
    const state = { nodes, selectedNode: nodes[1]! };
    expect(hostedSwitchTargetLabel(state, ENV_X)).toBe("Studio Mac");
    expect(hostedSwitchTargetLabel(state, ENV_Y)).toBe("Build box");
  });

  it("names the selected node when no environment is named", () => {
    const state = { nodes, selectedNode: nodes[1]! };
    expect(hostedSwitchTargetLabel(state)).toBe("Build box");
    expect(hostedSwitchTargetLabel(state, null)).toBe("Build box");
    expect(hostedSwitchTargetLabel({ nodes, selectedNode: null })).toBeNull();
  });

  it("falls back to the selected node when the directory does not list it", () => {
    const selectedNode = hubNode(ENV_Z, "Just selected");
    expect(hostedSwitchTargetLabel({ nodes, selectedNode }, ENV_Z)).toBe("Just selected");
    expect(hostedSwitchTargetLabel({ nodes, selectedNode })).toBe("Just selected");
  });

  it("has no name for an environment nobody lists", () => {
    expect(hostedSwitchTargetLabel({ nodes, selectedNode: nodes[1]! }, ENV_Z)).toBeNull();
  });
});

describe("hostedSwitchTargetQueued", () => {
  it("is true only for an environment waiting for a connection slot", () => {
    expect(hostedSwitchTargetQueued(ENV_X, ENV_Y, [ENV_X])).toBe(true);
    expect(hostedSwitchTargetQueued(ENV_Z, ENV_Y, [ENV_X])).toBe(false);
    expect(hostedSwitchTargetQueued(ENV_X, ENV_Y, [])).toBe(false);
  });

  it("asks about the selected environment when none is named", () => {
    expect(hostedSwitchTargetQueued(undefined, ENV_Y, [ENV_Y])).toBe(true);
    expect(hostedSwitchTargetQueued(null, ENV_Y, [ENV_X])).toBe(false);
    expect(hostedSwitchTargetQueued(undefined, null, [ENV_X])).toBe(false);
  });
});

describe("hostedCapabilityCopy", () => {
  it("promises availability instead of refusing while the connection is being established", () => {
    expect(hostedCapabilityCopy({ kind: "establishing", reason: STALE_REASON }, "Studio Mac")).toBe(
      "Available when Studio Mac is connected",
    );
  });

  it("keeps the reason of every other refusal", () => {
    for (const kind of ["stale", "role", "delivery-unknown"] as const) {
      expect(hostedCapabilityCopy({ kind, reason: "Because." }, "Studio Mac")).toBe("Because.");
    }
    expect(hostedCapabilityCopy({ reason: "No kind." }, "Studio Mac")).toBe("No kind.");
  });

  it("has nothing to say about an allowed action", () => {
    expect(hostedCapabilityCopy({ kind: "ready", reason: null }, "Studio Mac")).toBeNull();
    expect(hostedCapabilityCopy({ reason: null }, null)).toBeNull();
  });

  it("names the node generically when its label is unknown", () => {
    expect(hostedCapabilityCopy({ kind: "establishing", reason: STALE_REASON }, null)).toBe(
      "Available when this node is connected",
    );
    expect(hostedCapabilityCopy({ kind: "establishing", reason: STALE_REASON }, "")).toBe(
      "Available when this node is connected",
    );
  });
});

describe("switch target captions", () => {
  it("names the node being synchronized with", () => {
    expect(hostedSyncingCopy("Studio Mac")).toBe("Syncing with Studio Mac…");
    expect(hostedSyncingCopy(null)).toBe("Syncing with this node…");
  });

  it("explains that the routed node waits for a free connection", () => {
    expect(hostedQueuedCopy("Studio Mac")).toBe("Waiting for a free connection to Studio Mac…");
    expect(hostedQueuedCopy(undefined)).toBe("Waiting for a free connection to this node…");
  });
});
