import { describe, expect, it } from "vite-plus/test";
import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import { reconcileWorkspaceMachineCatalog } from "@ryco/client-runtime/state/workspace";
import { EnvironmentId } from "@ryco/contracts";

import {
  needsVerificationEnvironmentIds,
  resolveAuthoritativeNativeNodeTrust,
  workspaceEligibleEnvironmentIds,
} from "./nativeNodeEligibilityModel";
import { buildNeedsVerificationRows } from "./needsVerificationModel";

const NOT_PAIRING = () => false;

describe("authoritative native node eligibility", () => {
  it("awaits durable classification per node and never promotes unknown evidence", async () => {
    const result = await resolveAuthoritativeNativeNodeTrust({
      scope: { hubOrigin: "https://hub.example", accountId: "account" },
      targets: [
        { environmentId: "env-a", nodeId: "node-a" },
        { environmentId: "env-b", nodeId: "node-b" },
        { environmentId: "env-c", nodeId: "node-c" },
      ],
      classify: async ({ nodeId }) => {
        if (nodeId === "node-a") return { class: "latched" };
        if (nodeId === "node-b") return { class: "legacy-eligible", branch: "a" };
        throw new Error("secure store unavailable");
      },
      pairing: NOT_PAIRING,
    });
    expect(Object.fromEntries(result)).toEqual({
      "env-a": "verified",
      "env-b": "unverified",
      "env-c": "unknown",
    });
    expect([...workspaceEligibleEnvironmentIds(result)]).toEqual(["env-a"]);
    expect([...needsVerificationEnvironmentIds(result)]).toEqual(["env-b", "env-c"]);
  });

  it("locks only the environment with an identity conflict", async () => {
    const result = await resolveAuthoritativeNativeNodeTrust({
      scope: { hubOrigin: "https://hub.example", accountId: "account" },
      targets: [
        { environmentId: "env-a", nodeId: "node-a" },
        { environmentId: "env-b", nodeId: "node-b" },
      ],
      classify: async () => ({ class: "latched" }),
      pairing: NOT_PAIRING,
      identityConflictEnvironmentIds: new Set(["env-b"]),
    });
    expect(result.get("env-a")).toBe("verified");
    expect(result.get("env-b")).toBe("identity-conflict");
    expect([...workspaceEligibleEnvironmentIds(result)]).toEqual(["env-a"]);
  });

  it("makes fresh nodes account-trusted and selectable once enrollment is ready", async () => {
    const result = await resolveAuthoritativeNativeNodeTrust({
      scope: { hubOrigin: "https://hub.example", accountId: "account" },
      targets: [{ environmentId: "env-a", nodeId: "node-a" }],
      classify: async () => ({ class: "legacy-eligible", branch: "a" }),
      pairing: NOT_PAIRING,
      accountEnrollmentReady: true,
    });
    expect(result.get("env-a")).toBe("account-trusted");
    expect([...workspaceEligibleEnvironmentIds(result)]).toEqual(["env-a"]);
    expect([...needsVerificationEnvironmentIds(result)]).toEqual(["env-a"]);
  });

  it("keeps a node with a pending approval request out of workspaces and in Needs verification", async () => {
    // Every channel to a node in §13.2 pairing is pairing-only: one hello, then
    // a terminal close. The account grant does not change that, so the node must
    // not be offered as account-trusted, whichever class its record yields —
    // `unexpected` clause (i) as "Request approval" leaves it, or branch (b)
    // once the owner also recorded a legacy consent on it.
    const classifications = {
      "node-a": {
        class: "unexpected",
        clause: "i",
        record: "unverified",
        scope: { kind: "fresh" },
      },
      "node-b": { class: "legacy-eligible", branch: "b" },
    } as const;
    const result = await resolveAuthoritativeNativeNodeTrust({
      scope: { hubOrigin: "https://hub.example", accountId: "account" },
      targets: [
        { environmentId: "env-a", nodeId: "node-a" },
        { environmentId: "env-b", nodeId: "node-b" },
        { environmentId: "env-c", nodeId: "node-c" },
      ],
      classify: async ({ nodeId }) =>
        nodeId === "node-c"
          ? { class: "legacy-eligible", branch: "a" }
          : classifications[nodeId as keyof typeof classifications],
      pairing: ({ nodeId }) => nodeId !== "node-c",
      accountEnrollmentReady: true,
    });
    expect(Object.fromEntries(result)).toEqual({
      "env-a": "unverified",
      "env-b": "unverified",
      "env-c": "account-trusted",
    });
    expect([...workspaceEligibleEnvironmentIds(result)]).toEqual(["env-c"]);

    const node = (id: string): HostedHubNode => ({
      id,
      environmentId: EnvironmentId.make(`env-${id.slice(-1)}`),
      label: id,
      platformOs: "darwin",
      platformArch: "arm64",
      clientVersion: "1",
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: null,
      revokedAt: null,
      revocationReasonCode: null,
      grant: { id: `grant-${id}`, role: "operator" },
      effectiveRole: "operator",
      presence: { online: true, lastHeartbeatAt: null },
    });
    const rows = buildNeedsVerificationRows({
      nodes: [node("node-a"), node("node-b"), node("node-c")],
      trustByEnvironmentId: result,
    });
    expect(rows.map((row) => row.route)).toEqual([
      { nodeId: "node-a", environmentId: "env-a" },
      { nodeId: "node-b", environmentId: "env-b" },
    ]);
  });

  it("keeps revocation, presence, role and trust as independent gates", () => {
    const base = {
      label: "Node",
      clientTier: "native" as const,
      requiresNativeVerification: true,
      lastSeenAt: null,
      observedAt: 1,
    };
    const catalog = reconcileWorkspaceMachineCatalog([
      {
        ...base,
        environmentId: EnvironmentId.make("verified-operator"),
        nativeTrust: "verified",
        effectiveRole: "operator",
        online: true,
      },
      {
        ...base,
        environmentId: EnvironmentId.make("account-operator"),
        nativeTrust: "account-trusted",
        effectiveRole: "operator",
        online: true,
      },
      {
        ...base,
        environmentId: EnvironmentId.make("offline"),
        nativeTrust: "verified",
        effectiveRole: "operator",
        online: false,
      },
      {
        ...base,
        environmentId: EnvironmentId.make("viewer"),
        nativeTrust: "verified",
        effectiveRole: "viewer",
        online: true,
      },
      {
        ...base,
        environmentId: EnvironmentId.make("unknown"),
        nativeTrust: "unknown",
        effectiveRole: "operator",
        online: true,
      },
      {
        ...base,
        environmentId: EnvironmentId.make("revoked"),
        nativeTrust: "verified",
        effectiveRole: "operator",
        online: true,
        revokedAt: 1,
      },
    ]);
    const byId = new Map(catalog.map((entry) => [entry.environmentId, entry]));
    expect(byId.get("verified-operator" as never)?.canMutate).toBe(true);
    expect(byId.get("account-operator" as never)?.canMutate).toBe(true);
    expect(byId.get("offline" as never)?.accessReasons).toContain("offline");
    expect(byId.get("viewer" as never)?.accessReasons).toContain("viewer");
    expect(byId.get("unknown" as never)?.accessReasons).toContain("trust-unknown");
    expect(byId.get("revoked" as never)?.accessReasons).toContain("revoked");
  });
});
