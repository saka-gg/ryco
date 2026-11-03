import { EnvironmentId, type DesktopWorkspaceMachineProjection } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reconcileWorkspaceMachine, type WorkspaceMachineCatalogInput } from "./machineCatalog.js";
import {
  buildNodeCatalog,
  catalogPlatformOs,
  nodeMutateBlockedReason,
  sameNodeCatalog,
  type NodeCatalogInput,
  type NodeCatalogLiveFacts,
  type NodeCatalogSavedSource,
} from "./nodeCatalog.js";

const PRIMARY = EnvironmentId.make("env-primary");
const LOCAL_ALIAS = EnvironmentId.make("env-local-hub");
const MINI = EnvironmentId.make("env-mini");
const SERVER = EnvironmentId.make("env-server");
const LAPTOP = EnvironmentId.make("env-laptop");

function desktopMachine(
  environmentId: EnvironmentId,
  overrides: Partial<DesktopWorkspaceMachineProjection> = {},
): DesktopWorkspaceMachineProjection {
  return {
    environmentId,
    nodeId: `node-${environmentId}`,
    label: String(environmentId),
    online: true,
    nativeTrust: "verified",
    connectionState: "disconnected",
    canReadMetadata: true,
    canConnect: true,
    canMutate: true,
    effectiveRole: "owner",
    accessReasons: [],
    ...overrides,
  };
}

function saved(
  environmentId: EnvironmentId,
  overrides: Partial<NodeCatalogSavedSource> = {},
): NodeCatalogSavedSource {
  return {
    environmentId,
    label: String(environmentId),
    connectionState: "connected",
    role: "owner",
    viaSsh: false,
    lastSeenAt: 1_000,
    ...overrides,
  };
}

function hostedMachine(
  environmentId: EnvironmentId,
  overrides: Partial<WorkspaceMachineCatalogInput> = {},
) {
  return reconcileWorkspaceMachine({
    environmentId,
    nodeId: `node-${environmentId}`,
    label: String(environmentId),
    platform: { os: "linux", arch: "x64" },
    clientTier: "hosted-web",
    nativeTrust: "not-required",
    requiresNativeVerification: false,
    effectiveRole: "owner",
    transport: "relay",
    online: true,
    lastSeenAt: 500,
    observedAt: 600,
    connectionState: "disconnected",
    ...overrides,
  });
}

function catalogInput(overrides: Partial<NodeCatalogInput> = {}): NodeCatalogInput {
  return {
    hosted: null,
    primary: {
      environmentId: PRIMARY,
      label: "MacBook Pro",
      connectionState: "connected",
      role: "owner",
    },
    saved: [],
    desktop: null,
    thisDeviceEnvironmentId: PRIMARY,
    liveFacts: () => null,
    observedAt: 1_000,
    ...overrides,
  };
}

function liveFacts(
  facts: Partial<Record<EnvironmentId, NodeCatalogLiveFacts>>,
): (environmentId: EnvironmentId) => NodeCatalogLiveFacts | null {
  return (environmentId) => facts[environmentId] ?? null;
}

const byId = (catalog: ReturnType<typeof buildNodeCatalog>, environmentId: EnvironmentId) =>
  catalog.nodes.find((node) => node.environmentId === environmentId);

describe("node catalog", () => {
  it("folds the Desktop's local Hub alias into the primary under the Hub's name", () => {
    const catalog = buildNodeCatalog(
      catalogInput({
        desktop: {
          localEnvironmentId: LOCAL_ALIAS,
          machines: [
            desktopMachine(LOCAL_ALIAS, {
              label: "Laurin's MacBook",
              connectionState: "connected",
            }),
            desktopMachine(MINI, { label: "Mac mini", platformOs: "darwin" }),
          ],
        },
      }),
    );
    expect(catalog.nodes.map((node) => node.environmentId)).toEqual([PRIMARY, MINI]);
    expect(byId(catalog, PRIMARY)).toEqual({
      environmentId: PRIMARY,
      label: "Laurin's MacBook",
      isPrimary: true,
      isThisDevice: true,
      presence: "online",
      platformOs: null,
      iconKind: "laptop",
      canMutate: true,
      mutateBlockedReason: null,
      projectCopySupport: "unknown",
      transport: "direct",
      lastSeenAt: null,
    });
    expect(byId(catalog, MINI)).toMatchObject({
      isPrimary: false,
      isThisDevice: false,
      presence: "online",
      platformOs: "darwin",
      iconKind: "mini-pc",
      transport: null,
      canMutate: true,
    });
    expect(Array.from(catalog.ownerEnvironmentIds).toSorted()).toEqual([PRIMARY, MINI].toSorted());
  });

  it("keeps the alias's own entry when there is no primary to fold it into", () => {
    const catalog = buildNodeCatalog(
      catalogInput({
        primary: null,
        thisDeviceEnvironmentId: null,
        desktop: { localEnvironmentId: LOCAL_ALIAS, machines: [desktopMachine(LOCAL_ALIAS)] },
      }),
    );
    expect(catalog.nodes.map((node) => node.environmentId)).toEqual([LOCAL_ALIAS]);
  });

  it("describes a node a saved session and the Hub both list by its direct session", () => {
    const catalog = buildNodeCatalog(
      catalogInput({
        saved: [saved(MINI, { label: "mini.local" })],
        desktop: {
          localEnvironmentId: null,
          machines: [desktopMachine(MINI, { label: "Mac mini", connectionState: "connected" })],
        },
      }),
    );
    expect(catalog.nodes.filter((node) => node.environmentId === MINI)).toHaveLength(1);
    expect(byId(catalog, MINI)).toMatchObject({ label: "Mac mini", transport: "direct" });
  });

  it("reaches connected Hub machines through the relay and reports offline ones", () => {
    const catalog = buildNodeCatalog(
      catalogInput({
        desktop: {
          localEnvironmentId: null,
          machines: [
            desktopMachine(MINI, { connectionState: "connected" }),
            desktopMachine(SERVER, {
              online: false,
              canConnect: false,
              canMutate: false,
              effectiveRole: null,
              accessReasons: ["offline", "role-unknown", "some-future-reason"],
            }),
            desktopMachine(LAPTOP, {
              canReadMetadata: false,
              canConnect: false,
              canMutate: false,
              accessReasons: ["revoked"],
            }),
          ],
        },
      }),
    );
    expect(byId(catalog, MINI)).toMatchObject({ presence: "online", transport: "relay" });
    expect(byId(catalog, SERVER)).toMatchObject({
      presence: "offline",
      transport: null,
      canMutate: false,
      mutateBlockedReason: "env-server is offline",
    });
    // Revoked machines are not offered at all.
    expect(byId(catalog, LAPTOP)).toBeUndefined();
    expect(catalog.ownerEnvironmentIds.has(SERVER)).toBe(false);
  });

  it("treats a saved session's connection as its presence", () => {
    const catalog = buildNodeCatalog(
      catalogInput({
        saved: [
          saved(MINI),
          saved(SERVER, { connectionState: "disconnected", role: null, lastSeenAt: 42 }),
          saved(LAPTOP, { connectionState: "connecting" }),
        ],
        liveFacts: liveFacts({
          [MINI]: { platformOs: "darwin", iconKind: "mini-pc", projectCopy: true },
          [SERVER]: { platformOs: "linux", iconKind: "server", projectCopy: false },
        }),
      }),
    );
    expect(byId(catalog, MINI)).toMatchObject({
      presence: "online",
      transport: "direct",
      canMutate: true,
      platformOs: "darwin",
      iconKind: "mini-pc",
      projectCopySupport: "yes",
    });
    // What the node said when it was last connected still holds.
    expect(byId(catalog, SERVER)).toMatchObject({
      presence: "offline",
      transport: null,
      canMutate: false,
      mutateBlockedReason: "env-server is offline",
      projectCopySupport: "no",
      lastSeenAt: 42,
    });
    expect(byId(catalog, LAPTOP)).toMatchObject({
      presence: "connecting",
      projectCopySupport: "unknown",
    });
    // Only a known owner session is owner-held.
    expect(catalog.ownerEnvironmentIds.has(MINI)).toBe(true);
    expect(catalog.ownerEnvironmentIds.has(SERVER)).toBe(false);
  });

  it("refuses mutation through client-role sessions, naming the fix", () => {
    const catalog = buildNodeCatalog(
      catalogInput({
        saved: [
          saved(MINI, { label: "Mac mini", role: "client", viaSsh: true }),
          saved(SERVER, { label: "Build box", role: "client" }),
        ],
      }),
    );
    expect(byId(catalog, MINI)).toMatchObject({
      presence: "online",
      canMutate: false,
      mutateBlockedReason: "Update Ryco on Mac mini to copy projects here",
    });
    expect(byId(catalog, SERVER)).toMatchObject({
      canMutate: false,
      mutateBlockedReason:
        "Build box was paired with limited access; pair it again as its owner to add projects",
    });
    expect(catalog.ownerEnvironmentIds.has(MINI)).toBe(false);
    expect(catalog.ownerEnvironmentIds.has(SERVER)).toBe(false);
  });

  it("lets an unknown primary role mutate, but publishes only a known owner", () => {
    const catalog = buildNodeCatalog(
      catalogInput({
        primary: {
          environmentId: PRIMARY,
          label: "Studio",
          connectionState: "connecting",
          role: null,
        },
        thisDeviceEnvironmentId: null,
      }),
    );
    expect(byId(catalog, PRIMARY)).toMatchObject({
      presence: "connecting",
      canMutate: true,
      isThisDevice: false,
      transport: null,
    });
    expect(catalog.ownerEnvironmentIds.size).toBe(0);
  });

  it("lists the Hub directory's nodes in hosted mode, with the node's own copy support", () => {
    const catalog = buildNodeCatalog(
      catalogInput({
        primary: {
          environmentId: MINI,
          label: "placeholder",
          connectionState: "connected",
          role: null,
        },
        thisDeviceEnvironmentId: null,
        hosted: [
          hostedMachine(MINI, { label: "Mac mini", connectionState: "connected" }),
          hostedMachine(SERVER, { label: "Server" }),
          hostedMachine(LAPTOP, { label: "Laptop", effectiveRole: "viewer" }),
          hostedMachine(EnvironmentId.make("env-gone"), { revokedAt: 1 }),
        ],
        liveFacts: liveFacts({
          [MINI]: { platformOs: "darwin", iconKind: null, projectCopy: true },
        }),
      }),
    );
    expect(catalog.nodes.map((node) => node.label)).toEqual(["Mac mini", "Laptop", "Server"]);
    expect(byId(catalog, MINI)).toMatchObject({
      isPrimary: true,
      isThisDevice: false,
      presence: "online",
      transport: "relay",
      projectCopySupport: "yes",
      platformOs: "darwin",
      iconKind: "mini-pc",
    });
    // Reachable through the Hub, not connected yet: selectable, support unknown.
    expect(byId(catalog, SERVER)).toMatchObject({
      presence: "online",
      transport: null,
      canMutate: true,
      projectCopySupport: "unknown",
      platformOs: "linux",
      lastSeenAt: 500,
    });
    expect(byId(catalog, LAPTOP)).toMatchObject({
      canMutate: false,
      mutateBlockedReason: "You can only view Laptop",
    });
    expect(Array.from(catalog.ownerEnvironmentIds).toSorted()).toEqual([MINI, SERVER].toSorted());
  });

  it("ignores the saved and Desktop sources in hosted mode", () => {
    const catalog = buildNodeCatalog(
      catalogInput({
        hosted: [hostedMachine(MINI)],
        saved: [saved(SERVER)],
        desktop: { localEnvironmentId: null, machines: [desktopMachine(LAPTOP)] },
      }),
    );
    expect(catalog.nodes.map((node) => node.environmentId)).toEqual([MINI]);
  });

  it("orders the primary first, then this device, then by label", () => {
    const catalog = buildNodeCatalog(
      catalogInput({
        primary: {
          environmentId: SERVER,
          label: "Zeta",
          connectionState: "connected",
          role: "owner",
        },
        thisDeviceEnvironmentId: LAPTOP,
        saved: [saved(MINI, { label: "Alpha" }), saved(LAPTOP, { label: "Omega" })],
      }),
    );
    expect(catalog.nodes.map((node) => node.label)).toEqual(["Zeta", "Omega", "Alpha"]);
  });

  it("compares catalogs by what they show", () => {
    const first = buildNodeCatalog(catalogInput({ saved: [saved(MINI)] })).nodes;
    const same = buildNodeCatalog(catalogInput({ saved: [saved(MINI)], observedAt: 9_999 })).nodes;
    const changed = buildNodeCatalog(
      catalogInput({ saved: [saved(MINI, { connectionState: "disconnected" })] }),
    ).nodes;
    expect(same).not.toBe(first);
    expect(sameNodeCatalog(first, same)).toBe(true);
    expect(sameNodeCatalog(first, changed)).toBe(false);
    expect(sameNodeCatalog(first, first.slice(1))).toBe(false);
  });
});

describe("catalogPlatformOs", () => {
  it("names a node's OS as the contracts do", () => {
    expect(catalogPlatformOs("darwin")).toBe("darwin");
    expect(catalogPlatformOs("win32")).toBe("windows");
    expect(catalogPlatformOs("freebsd")).toBe("unknown");
    expect(catalogPlatformOs(null)).toBeNull();
  });
});

describe("nodeMutateBlockedReason", () => {
  it("names the most fundamental reason first", () => {
    expect(
      nodeMutateBlockedReason({ label: "Mini", accessReasons: ["offline", "not-verified"] }),
    ).toBe("Verify Mini on this device first");
    expect(nodeMutateBlockedReason({ label: "Mini", accessReasons: ["viewer", "offline"] })).toBe(
      "Mini is offline",
    );
    expect(nodeMutateBlockedReason({ label: "Mini", accessReasons: ["role-unknown"] })).toBe(
      "Checking your access to Mini…",
    );
    expect(nodeMutateBlockedReason({ label: "Mini", accessReasons: [] })).toBe(
      "Mini is not available right now",
    );
  });
});
