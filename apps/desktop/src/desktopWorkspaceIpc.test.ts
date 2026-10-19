import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import {
  WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
  createWorkspaceConnectionDemandState,
  type WorkspaceMachineCatalogEntry,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import {
  THREAD_CONTENT_CACHE_MAX_THREADS,
  THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
} from "@ryco/client-runtime/state/threads/threadContentCachePolicy";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createDesktopThreadContentCache } from "./desktopThreadContentCache.ts";
import type { DesktopSecretProtection } from "./protectedRecordStore.ts";
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
      "publishThreadContent",
      "getThreadContent",
      "getThreadContentCacheEnabled",
      "setThreadContentCacheEnabled",
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

  it("hands the renderer only bounded display content and the cache setting", () => {
    const preload = source("preload.ts");
    for (const channel of [
      "publishThreadContent",
      "getThreadContent",
      "getThreadContentCacheEnabled",
      "setThreadContentCacheEnabled",
    ]) {
      expect(preload).toContain(`DESKTOP_WORKSPACE_IPC.${channel}`);
    }
    // Publishing is one-way: nothing is awaited and nothing about the cache is returned.
    expect(preload).toMatch(/publishDesktopThreadContent:[^\n]*\n?[^\n]*ipcRenderer\.send\(/u);
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

  describe("thread content", () => {
    const threadId = String(metadata.threads[0]!.id);
    const directories: string[] = [];
    const mask = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0x5a));
    const protection: DesktopSecretProtection = {
      isEncryptionAvailable: () => true,
      encryptString: (plaintext) => mask(Buffer.from(plaintext, "utf8")),
      decryptString: (ciphertext) => mask(ciphertext).toString("utf8"),
    };
    const content = (name: string, text = `text of ${name}`) => ({
      messages: [
        {
          id: `${name}-message`,
          role: "user",
          text,
          createdAt: "2026-10-01T00:00:00Z",
          turnId: null,
          streaming: false,
        },
      ],
    });
    const threadsOf = (names: ReadonlyArray<string>) =>
      Object.fromEntries(names.map((name) => [name, content(name)]));

    function setup(overrides: Partial<DesktopWorkspaceClientSnapshot> = {}) {
      const directory = mkdtempSync(join(tmpdir(), "ryco-desktop-thread-content-ipc-"));
      directories.push(directory);
      const cache = createDesktopThreadContentCache({
        directory,
        hubOrigin: "https://hub.example",
        protection,
      });
      const client = { snapshot: () => state(overrides) } as unknown as DesktopWorkspaceClient;
      return {
        cache,
        handlers: createDesktopWorkspaceIpcHandlers(client, cache),
        scope: { accountId: "account-projection", environmentId },
      };
    }

    afterEach(() => {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("keeps published content and serves it back for threads the metadata lists", async () => {
      const { handlers, cache, scope } = setup();
      await handlers.publishThreadContent(environmentId, {
        ...threadsOf([threadId]),
        "thread-the-environment-does-not-list": content("stray"),
      });

      // Everything published is kept; only what the environment lists is served.
      expect(Object.keys(await cache.load(scope))).toEqual([
        threadId,
        "thread-the-environment-does-not-list",
      ]);
      expect(await handlers.getThreadContent(environmentId)).toEqual({
        [threadId]: expect.objectContaining({
          messages: [expect.objectContaining({ text: `text of ${threadId}` })],
        }),
      });
      await cache.dispose();
    });

    it("rejects a malformed environment or payload", async () => {
      const { handlers } = setup();
      for (const invalid of [undefined, null, "", "x".repeat(2_049), 7, {}]) {
        await expect(handlers.publishThreadContent(invalid, {})).rejects.toThrow("environment");
        await expect(handlers.getThreadContent(invalid)).rejects.toThrow("environment");
      }
      for (const invalid of [undefined, null, [], "content", 3]) {
        await expect(handlers.publishThreadContent(environmentId, invalid)).rejects.toThrow(
          "thread content",
        );
      }
      for (const invalid of [undefined, null, "true", 1]) {
        await expect(handlers.setThreadContentCacheEnabled(invalid)).rejects.toThrow(
          "thread content setting",
        );
      }
    });

    it("bounds what it keeps to the shared thread and size limits", async () => {
      const { handlers, cache, scope } = setup();
      const names = Array.from(
        { length: THREAD_CONTENT_CACHE_MAX_THREADS + 5 },
        (_, index) => `thread-${String(index).padStart(2, "0")}`,
      );
      await handlers.publishThreadContent(environmentId, threadsOf(names));
      expect(Object.keys(await cache.load(scope))).toEqual(
        names.slice(-THREAD_CONTENT_CACHE_MAX_THREADS),
      );

      const large = Object.fromEntries(
        ["a", "b", "c", "d", "e"].map((name) => [name, content(name, "x".repeat(450_000))]),
      );
      await handlers.publishThreadContent(environmentId, large);
      const kept = await cache.load(scope);
      expect(Object.keys(kept)).toEqual(["b", "c", "d", "e"]);
      expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(
        THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
      );
      await cache.dispose();
    });

    it("keeps and serves nothing for a machine or account it may not show", async () => {
      const otherEnvironment = EnvironmentId.make("environment-other");
      for (const overrides of [
        { catalog: [{ ...machine, canReadMetadata: false }] },
        { catalog: [{ ...machine, cacheDisposition: "locked-stale" as const }] },
        { catalog: [] },
        { status: "signed-out" as const, accountId: null },
        { status: "unavailable" as const },
      ]) {
        const { handlers, cache, scope } = setup(overrides);
        await handlers.publishThreadContent(environmentId, threadsOf([threadId]));
        expect(await cache.load(scope), JSON.stringify(Object.keys(overrides))).toEqual({});
        await cache.dispose();
      }

      const { handlers, cache } = setup();
      await handlers.publishThreadContent(otherEnvironment, threadsOf([threadId]));
      expect(await handlers.getThreadContent(otherEnvironment)).toEqual({});
      // A machine that stops being shown stops being served, whatever the cache still holds.
      await handlers.publishThreadContent(environmentId, threadsOf([threadId]));
      const withdrawn = createDesktopWorkspaceIpcHandlers(
        {
          snapshot: () => state({ catalog: [], snapshots: [] }),
        } as unknown as DesktopWorkspaceClient,
        cache,
      );
      expect(await withdrawn.getThreadContent(environmentId)).toEqual({});
      await cache.dispose();
    });

    it("reports the setting, and turning it off forgets and refuses content", async () => {
      const { handlers, cache, scope } = setup();
      expect(await handlers.getThreadContentCacheEnabled()).toBe(true);
      await handlers.publishThreadContent(environmentId, threadsOf([threadId]));
      expect(Object.keys(await handlers.getThreadContent(environmentId))).toEqual([threadId]);

      expect(await handlers.setThreadContentCacheEnabled(false)).toBe(false);
      expect(await handlers.getThreadContentCacheEnabled()).toBe(false);
      expect(await handlers.getThreadContent(environmentId)).toEqual({});
      await handlers.publishThreadContent(environmentId, threadsOf([threadId]));
      expect(await cache.load(scope)).toEqual({});

      expect(await handlers.setThreadContentCacheEnabled(true)).toBe(true);
      await handlers.publishThreadContent(environmentId, threadsOf([threadId]));
      expect(Object.keys(await handlers.getThreadContent(environmentId))).toEqual([threadId]);
      await cache.dispose();
    });

    it("keeps nothing when the client has no content cache", async () => {
      const handlers = createDesktopWorkspaceIpcHandlers({
        snapshot: () => state(),
      } as unknown as DesktopWorkspaceClient);
      await handlers.publishThreadContent(environmentId, threadsOf([threadId]));
      expect(await handlers.getThreadContent(environmentId)).toEqual({});
      expect(await handlers.getThreadContentCacheEnabled()).toBe(false);
      expect(await handlers.setThreadContentCacheEnabled(true)).toBe(false);
    });
  });
});
