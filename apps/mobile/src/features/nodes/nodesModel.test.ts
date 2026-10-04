import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId } from "@ryco/contracts";

import {
  buildNodeSections,
  canSelectHubNode,
  directConnectActionLabel,
  directRoleLabel,
  directTransportLabel,
} from "./nodesModel";

describe("Nodes model", () => {
  it("keeps Hub and direct rows in separate ordered sections", () => {
    const sections = buildNodeSections({
      rows: [
        {
          environmentId: "direct-a" as EnvironmentId,
          plane: "direct",
          label: "MacBook",
          readiness: "ready",
          selected: false,
          transportLabel: "Tailscale",
        },
        {
          environmentId: "hub-a" as EnvironmentId,
          plane: "hub",
          label: "Studio",
          role: "Owner",
          presence: "online",
          readiness: "ready",
          selected: true,
          transportLabel: "Hub relay",
        },
      ],
    });

    expect(sections.map((section) => section.key)).toEqual(["hub", "direct"]);
    // The headers are the machines surface's own copy; pin them so the model
    // cannot drift away from what NodesScreen renders.
    expect(sections.map((section) => section.title)).toEqual(["Hub nodes", "Paired directly"]);
    expect(sections[0]?.rows[0]?.label).toBe("Studio");
    expect(sections[1]?.rows[0]?.transportLabel).toBe("Tailscale");
  });

  it("filters without merging credential planes", () => {
    const sections = buildNodeSections({
      rows: [
        {
          environmentId: "direct-a" as EnvironmentId,
          plane: "direct",
          label: "MacBook",
          readiness: "ready",
          selected: false,
          transportLabel: "Tailscale",
        },
        {
          environmentId: "hub-a" as EnvironmentId,
          plane: "hub",
          label: "Studio",
          readiness: "ready",
          selected: true,
          transportLabel: "Hub relay",
        },
      ],
      query: "tailscale",
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]?.key).toBe("direct");
  });

  it("fails closed when selecting a Hub node", () => {
    expect(
      canSelectHubNode({
        directoryStatus: "ready",
        browserStatus: "current",
        revokedAt: null,
      }),
    ).toBe(true);
    expect(
      canSelectHubNode({
        directoryStatus: "loading",
        browserStatus: "current",
        revokedAt: null,
      }),
    ).toBe(false);
    expect(
      canSelectHubNode({
        directoryStatus: "ready",
        browserStatus: "current",
        revokedAt: "2026-07-26T10:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("labels LAN and Tailscale as direct transports", () => {
    expect(directTransportLabel("https://macbook.local:44342")).toBe("LAN · Direct");
    expect(directTransportLabel("https://192.168.1.12:44342")).toBe("LAN · Direct");
    expect(directTransportLabel("https://100.96.12.4:44342")).toBe("Tailscale · Direct");
    expect(directTransportLabel("https://studio.tail123.ts.net")).toBe("Tailscale · Direct");
    expect(directTransportLabel("https://node.example.com")).toBe("Direct");
  });

  it("keeps direct role copy bounded", () => {
    expect(directRoleLabel("owner")).toBe("Owner");
    expect(directRoleLabel("client")).toBe("Client");
    expect(directRoleLabel(null)).toBe("Role pending");
  });
});

describe("directConnectActionLabel", () => {
  it("retries a machine that rejected its pairing, next to Re-pair", () => {
    expect(directConnectActionLabel({ connectionState: "disconnected", needsRepair: true })).toBe(
      "Retry",
    );
  });

  it("connects, retries, or uses a machine whose pairing holds", () => {
    expect(directConnectActionLabel({ connectionState: "disconnected", needsRepair: false })).toBe(
      "Connect",
    );
    expect(directConnectActionLabel({ connectionState: "error", needsRepair: false })).toBe(
      "Retry",
    );
    expect(directConnectActionLabel({ connectionState: "connected", needsRepair: false })).toBe(
      "Use",
    );
  });
});
