import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import {
  WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
  createWorkspaceConnectionDemandState,
  type WorkspaceMachineCatalogEntry,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { describe, expect, it, vi } from "vite-plus/test";

import { DESKTOP_WORKSPACE_IPC } from "./desktopWorkspaceChannels.ts";
import type {
  DesktopWorkspaceClient,
  DesktopWorkspaceClientSnapshot,
} from "./desktopWorkspaceClient.ts";
import {
  createDesktopWorkspaceIpcHandlers,
  projectDesktopWorkspaceFullState,
  projectDesktopWorkspaceState,
  projectDesktopWorkspaceSummary,
} from "./desktopWorkspaceIpc.ts";

const source = (name: string) => readFileSync(join(import.meta.dirname, name), "utf8");

describe("Desktop workspace IPC boundary", () => {
  it("exposes only bounded projections, opaque handles, and scoped commands", () => {
    const ipc = source("desktopWorkspaceIpc.ts");
    const preload = source("preload.ts");

    expect(Object.keys(DESKTOP_WORKSPACE_IPC)).toEqual([
      "getState",
      "refreshCatalog",
      "renameDevice",
      "publishSnapshot",
      "retainScope",
      "renewScope",
      "releaseScope",
      "setBackgrounded",
      "purgeCache",
      "beginVerification",
      "cancelVerification",
      "verifyApproval",
      "stateChanged",
      "connectionCommand",
      "prepareTransport",
      "activateTransport",
      "sendTransport",
      "closeTransport",
      "reportConnection",
      "transportEvent",
    ]);
    for (const forbidden of [
      "accessToken",
      "refreshToken",
      "dpopProof",
      "privateKey",
      "agreementSecretKey",
      "epochSecretC2N",
      "epochSecretN2C",
      "exporterSecret",
      "serverConfirmationKey",
    ]) {
      expect(ipc).not.toContain(forbidden);
      expect(preload).not.toContain(forbidden);
    }
  });

  it("keeps relay authorization and native handshake material in main", () => {
    const preload = source("preload.ts");
    const relay = source("desktopWorkspaceRelay.ts");
    expect(relay).toContain("HostedRelayEngine");
    expect(relay).toContain("makeRelayE2eeInitiator");
    expect(preload).not.toContain("issueRelayTicket");
    expect(preload).not.toContain("authorizeRelayUpgrade");
    expect(preload).not.toContain("RelayE2eeInitiatorAttempt");
  });

  it("does not expose the former low-level native handshake through preload", () => {
    const preload = source("preload.ts");
    expect(preload).not.toContain("prepareNativeE2eeAttempt");
    expect(preload).not.toContain("startNativeE2eeHandshake");
    expect(preload).not.toContain("finishNativeE2eeHandshake");
  });
});

describe("Desktop workspace state projections", () => {
  const environmentId = EnvironmentId.make("environment-projection");
  const bodyMarker = "conversation-title-marker";

  const machine: WorkspaceMachineCatalogEntry = {
    environmentId,
    nodeId: "node-projection",
    label: "Projection node",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "1.0.0",
    capabilities: { repositoryIdentity: true, nativeClientRequired: true, threadSettlement: false },
    clientTier: "native",
    nativeTrust: "verified",
    effectiveRole: "owner",
    presence: { online: true, lastSeenAt: 1, observedAt: 1 },
    connectionState: "connected",
    deliveryUnknown: false,
    revokedAt: null,
    removed: false,
    canReadMetadata: true,
    canConnect: true,
    canMutate: true,
    cacheDisposition: "available",
    accessReasons: [],
  };

  const metadata: WorkspaceMetadataSnapshot = {
    schemaVersion: WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
    environmentId,
    capturedAt: 5,
    projects: [
      {
        environmentId,
        id: ProjectId.make("project-projection"),
        name: "Project",
        cwd: "/project",
        repositoryIdentity: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
    worktrees: [],
    threads: [
      {
        environmentId,
        id: ThreadId.make("thread-projection"),
        projectId: ProjectId.make("project-projection"),
        worktreeId: null,
        title: bodyMarker,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: null,
        archivedAt: null,
        modelSelection: null,
        providerDriver: null,
        branch: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        deliveryUnknown: false,
      },
    ],
  };

  const state = (
    overrides: Partial<DesktopWorkspaceClientSnapshot> = {},
  ): DesktopWorkspaceClientSnapshot => ({
    status: "ready",
    accountId: "account-projection",
    localEnvironmentId: environmentId,
    catalog: [machine],
    snapshots: [metadata],
    demand: createWorkspaceConnectionDemandState(3),
    queuedEnvironmentIds: [],
    accountE2ee: "ready",
    ...overrides,
  });

  it("pushes snapshots with a changed state and omits the ones it repeats", () => {
    const changed = projectDesktopWorkspaceState(state());
    expect(changed.snapshots).toEqual([metadata]);

    const repeated = projectDesktopWorkspaceState(state({ snapshotsUnchanged: true }));
    expect(Object.keys(repeated)).not.toContain("snapshots");
    expect(repeated).toEqual(projectDesktopWorkspaceSummary(state()));
    expect(repeated.machines).toHaveLength(1);
    expect(JSON.stringify(repeated)).not.toContain(bodyMarker);
  });

  it("answers a state read with every snapshot and a command with none", async () => {
    const reply = state({ snapshotsUnchanged: true });
    const client = {
      snapshot: () => state(),
      refreshCatalog: vi.fn(async () => reply),
      renameDevice: vi.fn(async () => reply),
      acceptWorkspaceSnapshot: vi.fn(async () => reply),
      retainScope: vi.fn(async () => ({ leaseId: "desktop-workspace-1", snapshot: state() })),
      renewScope: vi.fn(async () => state()),
      releaseScope: vi.fn(async () => state()),
      setBackgrounded: vi.fn(async () => state()),
      purgeCache: vi.fn(async () => state()),
      verifyApproval: vi.fn(async () => state()),
    } as unknown as DesktopWorkspaceClient;
    const handlers = createDesktopWorkspaceIpcHandlers(client);

    const full = await handlers.getState();
    expect(full).toEqual(projectDesktopWorkspaceFullState(state()));
    expect(full.snapshots).toEqual([metadata]);

    const replies: Array<[string, unknown]> = [
      ["refreshCatalog", await handlers.refreshCatalog()],
      [
        "renameDevice",
        await handlers.renameDevice({ environmentId, label: "Renamed projection node" }),
      ],
      ["publishSnapshot", await handlers.publishSnapshot(metadata)],
      [
        "retainScope",
        (await handlers.retainScope({ environmentId, scope: { type: "interactive" } })).state,
      ],
      ["renewScope", await handlers.renewScope("desktop-workspace-1")],
      ["releaseScope", await handlers.releaseScope("desktop-workspace-1")],
      ["setBackgrounded", await handlers.setBackgrounded(true)],
      ["purgeCache", await handlers.purgeCache(environmentId)],
      [
        "verifyApproval",
        await handlers.verifyApproval({
          nodeId: "node-projection",
          environmentId,
          payload: "approval-payload",
        }),
      ],
    ];
    for (const [name, value] of replies) {
      expect(Object.keys(value as object), name).not.toContain("snapshots");
      expect(JSON.stringify(value), name).not.toContain(bodyMarker);
      expect((value as { machines: unknown[] }).machines, name).toHaveLength(1);
    }
  });
});
