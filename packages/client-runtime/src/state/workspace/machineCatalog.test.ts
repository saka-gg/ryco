import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  reconcileWorkspaceMachine,
  reconcileWorkspaceMachineCatalog,
  type WorkspaceMachineCatalogInput,
} from "./machineCatalog.js";

function input(
  name: string,
  overrides: Partial<WorkspaceMachineCatalogInput> = {},
): WorkspaceMachineCatalogInput {
  return {
    environmentId: EnvironmentId.make(name),
    nodeId: `node-${name}`,
    label: name,
    clientTier: "native",
    nativeTrust: "verified",
    requiresNativeVerification: true,
    effectiveRole: "operator",
    online: true,
    lastSeenAt: 100,
    observedAt: 101,
    ...overrides,
  };
}

describe("workspace machine catalog", () => {
  it("keeps verified, unverified, unknown, offline, and revoked distinct", () => {
    const catalog = reconcileWorkspaceMachineCatalog([
      input("verified"),
      input("account", { nativeTrust: "account-trusted" }),
      input("unverified", { nativeTrust: "unverified" }),
      input("unknown", { nativeTrust: "unknown" }),
      input("offline", { online: false }),
      input("revoked", { revokedAt: 99 }),
    ]);
    const byId = new Map(catalog.map((machine) => [machine.environmentId, machine]));

    expect(byId.get(EnvironmentId.make("verified"))).toMatchObject({
      canReadMetadata: true,
      canConnect: true,
      canMutate: true,
      cacheDisposition: "available",
    });
    expect(byId.get(EnvironmentId.make("account"))).toMatchObject({
      canReadMetadata: true,
      canConnect: true,
      canMutate: true,
      cacheDisposition: "available",
    });
    expect(byId.get(EnvironmentId.make("unverified"))).toMatchObject({
      canReadMetadata: false,
      cacheDisposition: "purge",
      accessReasons: expect.arrayContaining(["not-verified"]),
    });
    expect(byId.get(EnvironmentId.make("unknown"))).toMatchObject({
      canReadMetadata: false,
      accessReasons: expect.arrayContaining(["trust-unknown"]),
    });
    expect(byId.get(EnvironmentId.make("offline"))).toMatchObject({
      canReadMetadata: true,
      canConnect: false,
      cacheDisposition: "available",
      accessReasons: expect.arrayContaining(["offline"]),
    });
    expect(byId.get(EnvironmentId.make("revoked"))).toMatchObject({
      canReadMetadata: false,
      cacheDisposition: "purge",
      accessReasons: expect.arrayContaining(["revoked"]),
    });
  });

  it("locks identity-conflict metadata and refuses all live authority", () => {
    expect(
      reconcileWorkspaceMachine(input("changed", { nativeTrust: "identity-conflict" })),
    ).toMatchObject({
      canReadMetadata: false,
      canConnect: false,
      canMutate: false,
      cacheDisposition: "locked-stale",
      accessReasons: expect.arrayContaining(["identity-conflict"]),
    });
  });

  it("keeps hosted Web honest about native-only policy", () => {
    const locked = reconcileWorkspaceMachine(
      input("web-locked", {
        clientTier: "hosted-web",
        nativeTrust: "not-required",
        capabilities: { nativeClientRequired: true },
      }),
    );
    expect(locked.canReadMetadata).toBe(false);
    expect(locked.cacheDisposition).toBe("purge");
    expect(locked.accessReasons).toContain("native-client-required");
  });

  it("allows viewers to read without granting mutation authority", () => {
    const viewer = reconcileWorkspaceMachine(input("viewer", { effectiveRole: "viewer" }));
    expect(viewer.canReadMetadata).toBe(true);
    expect(viewer.canConnect).toBe(true);
    expect(viewer.canMutate).toBe(false);
    expect(viewer.accessReasons).toContain("viewer");
  });

  it("carries thread settlement capability independently", () => {
    expect(
      reconcileWorkspaceMachine(input("settlement", { capabilities: { threadSettlement: true } }))
        .capabilities.threadSettlement,
    ).toBe(true);
    expect(
      reconcileWorkspaceMachine(input("legacy", { capabilities: { threadSettlement: false } }))
        .capabilities.threadSettlement,
    ).toBe(false);
  });

  it("leaves thread settlement unstated when the directory does not state it", () => {
    expect(reconcileWorkspaceMachine(input("unstated")).capabilities).not.toHaveProperty(
      "threadSettlement",
    );
    expect(
      reconcileWorkspaceMachine(input("unstated", { capabilities: { repositoryIdentity: true } }))
        .capabilities,
    ).not.toHaveProperty("threadSettlement");
  });

  it("reads project copy support as unknown until the machine states it", () => {
    expect(reconcileWorkspaceMachine(input("unstated")).projectCopySupport).toBe("unknown");
    expect(
      reconcileWorkspaceMachine(input("copy", { capabilities: { projectCopy: true } }))
        .projectCopySupport,
    ).toBe("yes");
    expect(
      reconcileWorkspaceMachine(input("older", { capabilities: { projectCopy: false } }))
        .projectCopySupport,
    ).toBe("no");
  });

  it("states the transport only while the machine is connected", () => {
    expect(
      reconcileWorkspaceMachine(
        input("relayed", { transport: "relay", connectionState: "connected" }),
      ).transport,
    ).toBe("relay");
    expect(
      reconcileWorkspaceMachine(
        input("connecting", { transport: "relay", connectionState: "connecting" }),
      ).transport,
    ).toBeNull();
    expect(
      reconcileWorkspaceMachine(input("unstated", { connectionState: "connected" })).transport,
    ).toBeNull();
  });

  it("refuses mutation through a direct client session for that reason alone", () => {
    const client = reconcileWorkspaceMachine(
      input("client", { effectiveRole: null, directSessionRole: "client" }),
    );
    expect(client.canConnect).toBe(true);
    expect(client.canMutate).toBe(false);
    expect(client.accessReasons).toEqual(["client-session"]);

    const owner = reconcileWorkspaceMachine(
      input("owner", { effectiveRole: "owner", directSessionRole: "owner" }),
    );
    expect(owner.canMutate).toBe(true);
    expect(owner.accessReasons).toEqual([]);
  });
});
