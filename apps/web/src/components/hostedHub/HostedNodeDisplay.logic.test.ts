// The node directory's presentation rules, exercised without a browser.
//
// The two nullable timestamps are the reason this file exists. Their null
// meanings are asymmetric — `lastAuthenticatedAt === null` means the node has
// never authenticated, `presence.lastHeartbeatAt === null` does **not** mean it
// never sent a heartbeat, because the contract permits null while the node is
// online — and swapping them prints a confident false negative about a machine
// that is up right now. They are asserted separately, so one assertion cannot
// cover for the other.

import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HostedHubNode } from "../../hostedHub/types";
import {
  directoryCountLine,
  lastSeenLabel,
  nodeMetaLine,
  nodeSelectionBlocked,
  nodeSelectionBlockedReason,
  platformLabel,
  relativeTime,
  selectableNodes,
  sortNodes,
} from "./HostedNodeDisplay.logic";

const NOW = 1_700_000_000_000;

function node(overrides: Partial<HostedHubNode> = {}): HostedHubNode {
  return {
    id: "node_aaaaaaaaaaaaaaaaaaaaaa",
    environmentId: EnvironmentId.make(`env_${"a".repeat(22)}`),
    label: "Studio",
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "0.9.0",
    createdAt: NOW - 10_000_000,
    updatedAt: NOW - 1_000,
    lastAuthenticatedAt: NOW - 100_000,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: "grant_a", role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: NOW - 5_000 },
    ...overrides,
  };
}

describe("platform label", () => {
  it("maps the closed union to words and never infers a vendor", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("linux")).toBe("Linux");
    expect(platformLabel("windows")).toBe("Windows");
    expect(platformLabel("unknown")).toBe("Unknown platform");
  });

  it("leaves the architecture token alone in the meta line", () => {
    // "Apple silicon" would be an inference the Hub never made, and it is
    // simply wrong for an arm64 Linux box.
    expect(nodeMetaLine(node({ platformOs: "linux", platformArch: "arm64" }))).toContain("arm64");
    expect(nodeMetaLine(node({ platformOs: "linux", platformArch: "arm64" }))).not.toMatch(
      /apple/i,
    );
  });
});

describe("meta line", () => {
  it("names platform, architecture, and the role in effect", () => {
    expect(nodeMetaLine(node())).toBe("macOS · arm64 · Operator");
  });

  it("carries the revocation reason, and drops the role that no longer applies", () => {
    expect(nodeMetaLine(node({ revokedAt: NOW, revocationReasonCode: "administrative" }))).toBe(
      "macOS · arm64 · Access revoked — administrative",
    );
    expect(nodeMetaLine(node({ revokedAt: NOW, revocationReasonCode: null }))).toBe(
      "macOS · arm64 · Access revoked",
    );
  });
});

describe("last-seen resolution", () => {
  it("says nothing at all while the node is online", () => {
    // "Last seen 2 minutes ago" beside a live Online pill reads as a
    // contradiction; the answer is "now" and the pill already gives it.
    expect(
      lastSeenLabel(node({ presence: { online: true, lastHeartbeatAt: NOW } }), NOW),
    ).toBeNull();
  });

  it("prefers the heartbeat once the node is offline", () => {
    expect(
      lastSeenLabel(node({ presence: { online: false, lastHeartbeatAt: NOW - 600_000 } }), NOW),
    ).toBe("Last seen 10 min ago");
  });

  it("falls back to the last authentication when no heartbeat was reported", () => {
    expect(
      lastSeenLabel(
        node({
          presence: { online: false, lastHeartbeatAt: null },
          lastAuthenticatedAt: NOW - 7_200_000,
        }),
        NOW,
      ),
    ).toBe("Last authenticated 2 h ago");
  });

  it("never renders a null as 'Never' when both timestamps are absent", () => {
    // The honest statement is that nothing was recorded — not that the machine
    // has never connected, which neither field can establish on its own.
    expect(
      lastSeenLabel(
        node({ presence: { online: false, lastHeartbeatAt: null }, lastAuthenticatedAt: null }),
        NOW,
      ),
    ).toBe("No connection recorded");
  });
});

describe("relative time", () => {
  it("is minute-granularity or coarser, because presence is polled at 20 seconds", () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 119_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 120_000, NOW)).toBe("2 min ago");
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe("59 min ago");
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe("1 h ago");
    expect(relativeTime(NOW - 23 * 3_600_000, NOW)).toBe("23 h ago");
  });

  it("never claims a second-level precision the poll cannot support", () => {
    for (const elapsed of [1, 999, 19_000]) {
      expect(relativeTime(NOW - elapsed, NOW)).toBe("just now");
    }
  });

  it("renders a future timestamp absolutely rather than as 'in 3 minutes'", () => {
    // Clock skew between the node, the Hub and this browser is ordinary; a
    // negative elapsed time reads as a bug rather than as information.
    const future = relativeTime(NOW + 600_000, NOW);
    expect(future).not.toMatch(/ago/);
    expect(future).not.toMatch(/^in /);
    expect(future.length).toBeGreaterThan(0);
  });

  it("degrades to the absolute form past a day", () => {
    expect(relativeTime(NOW - 48 * 3_600_000, NOW)).not.toMatch(/ago/);
  });
});

describe("directory order", () => {
  it("puts revoked nodes last whatever their label", () => {
    const ordered = sortNodes([
      node({ id: "a", label: "Alpha", revokedAt: NOW }),
      node({ id: "b", label: "Zulu" }),
    ]);
    expect(ordered.map((entry) => entry.label)).toEqual(["Zulu", "Alpha"]);
  });

  it("collates labels numerically and case-insensitively", () => {
    const ordered = sortNodes([
      node({ id: "1", label: "node 10" }),
      node({ id: "2", label: "Node 2" }),
      node({ id: "3", label: "node 1" }),
    ]);
    expect(ordered.map((entry) => entry.label)).toEqual(["node 1", "Node 2", "node 10"]);
  });

  it("is not a presence sort", () => {
    // Presence is polled at 20s and pauses with tab visibility. Sorting on it
    // reorders the list under the user's pointer on a cadence they cannot
    // predict — a misclick generator on a surface whose whole job is one click.
    const ordered = sortNodes([
      node({ id: "a", label: "Alpha", presence: { online: false, lastHeartbeatAt: null } }),
      node({ id: "b", label: "Bravo", presence: { online: true, lastHeartbeatAt: NOW } }),
    ]);
    expect(ordered.map((entry) => entry.label)).toEqual(["Alpha", "Bravo"]);
  });

  it("does not mutate the store's array", () => {
    const input = [node({ id: "b", label: "Zulu" }), node({ id: "a", label: "Alpha" })];
    const snapshot = input.map((entry) => entry.label);
    sortNodes(input);
    expect(input.map((entry) => entry.label)).toEqual(snapshot);
  });
});

describe("count line", () => {
  it("reads both halves of the sentence off the same set", () => {
    // The revoked node is not authorized — the row for it two lines below says
    // "Access revoked" — so it may not be counted as one. Counting it there
    // while excluding it from "online" made one sentence use two definitions of
    // its own subject and overstated the user's reach.
    expect(
      directoryCountLine([
        node({ id: "a", presence: { online: true, lastHeartbeatAt: NOW } }),
        node({ id: "b", presence: { online: false, lastHeartbeatAt: null } }),
        node({ id: "c", revokedAt: NOW, presence: { online: true, lastHeartbeatAt: NOW } }),
      ]),
    ).toBe("2 authorized · 1 online · 1 revoked");
  });

  it("accounts for every row the list renders", () => {
    // Revoked nodes are still listed, so dropping them from the count silently
    // would leave "1 authorized" above two visible rows.
    expect(
      directoryCountLine([
        node({ id: "a", presence: { online: false, lastHeartbeatAt: null } }),
        node({ id: "b", revokedAt: NOW, presence: { online: false, lastHeartbeatAt: null } }),
      ]),
    ).toBe("1 authorized · none online · 1 revoked");
  });

  it("says nothing about revocation when nothing is revoked", () => {
    expect(
      directoryCountLine([
        node({ id: "a", presence: { online: true, lastHeartbeatAt: NOW } }),
        node({ id: "b", presence: { online: false, lastHeartbeatAt: null } }),
      ]),
    ).toBe("2 authorized · 1 online");
  });

  it("says 'none online' rather than a bare zero", () => {
    expect(directoryCountLine([node({ presence: { online: false, lastHeartbeatAt: null } })])).toBe(
      "1 authorized · none online",
    );
  });
});

describe("selection gating", () => {
  it("offers only nodes still authorized and open to this browser", () => {
    const open = node();
    const revoked = node({ id: "node_bbbbbbbbbbbbbbbbbbbbbb", revokedAt: NOW });
    const nativeOnly = node({
      id: "node_cccccccccccccccccccccc",
      capabilities: { repositoryIdentity: true, nativeClientRequired: true },
    });
    expect(selectableNodes([revoked, open, nativeOnly])).toEqual([open]);
  });

  it("blocks a revoked node, a stale directory, and a revalidating browser alike", () => {
    const ready = { directoryStatus: "ready", browserStatus: "current" };
    expect(nodeSelectionBlocked({ ...ready, node: node() })).toBe(false);
    expect(nodeSelectionBlocked({ ...ready, node: node({ revokedAt: NOW }) })).toBe(true);
    expect(
      nodeSelectionBlocked({ directoryStatus: "stale", browserStatus: "current", node: node() }),
    ).toBe(true);
    expect(
      nodeSelectionBlocked({
        ...ready,
        node: node({
          capabilities: { repositoryIdentity: true, nativeClientRequired: true },
        }),
      }),
    ).toBe(true);
    expect(
      nodeSelectionBlocked({
        directoryStatus: "ready",
        browserStatus: "checking-access",
        node: node(),
      }),
    ).toBe(true);
  });

  it("explains a block with the strings the connection sheet already ships", () => {
    expect(
      nodeSelectionBlockedReason({
        directoryStatus: "ready",
        browserStatus: "current",
        node: node({
          capabilities: { repositoryIdentity: true, nativeClientRequired: true },
        }),
      }),
    ).toBe("Open this node in Desktop/Mobile.");
    expect(
      nodeSelectionBlockedReason({
        directoryStatus: "ready",
        browserStatus: "current",
        node: node({ revokedAt: NOW }),
      }),
    ).toBe("Access to this node was revoked.");
    expect(
      nodeSelectionBlockedReason({
        directoryStatus: "stale",
        browserStatus: "current",
        node: node(),
      }),
    ).toBe("Node switching is unavailable until the directory and this browser are current.");
    expect(
      nodeSelectionBlockedReason({
        directoryStatus: "ready",
        browserStatus: "current",
        node: node(),
      }),
    ).toBeNull();
  });
});
