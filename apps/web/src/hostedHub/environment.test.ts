import {
  peekProjectIconSource,
  projectIconCacheBytes,
  readProjectIconSource,
} from "@ryco/client-runtime/connection";
import { statisticsSnapshotCache } from "@ryco/client-runtime/usage";
import {
  EnvironmentId,
  ProjectId,
  type EnvironmentApi,
  type ExecutionEnvironmentDescriptor,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type StatisticsSnapshot,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import { useMessageQueueStore } from "../messageQueueStore";
import {
  appAtomRegistry,
  emitWelcome,
  getServerConfig,
  getServerConfigUpdatedNotification,
  readEnvironmentServerConfig,
  resetEnvironmentServerConfigsForTests,
  resetServerStateForTests,
  startActiveEnvironmentServerConfigProjection,
  welcomeAtom,
  writeEnvironmentServerConfig,
} from "../rpc/serverState";
import { useSettingsDialogStore } from "../settingsDialogStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { clearWebHostedAccountScopedState, clearWebHostedNodeScopedState } from "./environment";

/**
 * The browser/UI clearing catalog. The core transition queue owns the call
 * ordering (see the package `environment.test.ts`); this suite covers only the
 * web store sweep the catalog performs when the core asks it to clear
 * node-scoped state.
 */

const environmentId = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
const iconProjectId = ProjectId.make("iconProject");
const ICON_SOURCE = "data:image/png;base64,aWNvbg==";

const otherEnvironmentId = EnvironmentId.make("env_bbbbbbbbbbbbbbbbbbbbbb");

function cacheStatistics(target: EnvironmentId): Promise<StatisticsSnapshot> {
  return statisticsSnapshotCache.load(
    target,
    async () =>
      ({
        generatedAt: `statistics-${target}`,
      }) as StatisticsSnapshot,
  );
}

function serverConfigFor(target: EnvironmentId): ServerConfig {
  return {
    environment: { environmentId: target, label: target, capabilities: {} },
    issues: [],
    providers: [],
    settings: {},
  } as unknown as ServerConfig;
}

beforeEach(() => {
  resetServerStateForTests();
  resetEnvironmentServerConfigsForTests();
  resetPrimaryEnvironmentDescriptorForTests();
});

afterEach(() => {
  resetServerStateForTests();
  resetEnvironmentServerConfigsForTests();
  resetPrimaryEnvironmentDescriptorForTests();
});

function cacheProjectIcon(): Promise<string | null> {
  const api = {
    projects: { readIcon: async () => ({ mimeType: "image/png", dataBase64: "aWNvbg==" }) },
  } as unknown as EnvironmentApi;
  return readProjectIconSource(api, environmentId, iconProjectId, null);
}

describe("clearWebHostedNodeScopedState", () => {
  it("demotes only transport projections and preserves cross-node UI state", async () => {
    await cacheProjectIcon();
    await cacheStatistics(environmentId);
    await cacheStatistics(otherEnvironmentId);
    useStore.setState({ activeEnvironmentId: environmentId });
    useComposerDraftStore.getState().setPrompt(DraftId.make("sensitiveThread"), "sensitive prompt");
    useTerminalStateStore.setState({
      terminalStateByThreadKey: { sensitiveThread: {} as never },
      terminalLaunchContextByThreadKey: { sensitiveThread: {} as never },
      terminalEventEntriesByKey: { sensitiveThread: [] },
    });
    useMessageQueueStore.setState({ queuesByThreadKey: { sensitiveThread: [] } });
    useUiStateStore.setState({
      projectOrder: ["sensitiveProject"],
      pinnedThreadKeys: { sensitiveThread: true },
    });
    useCommandPaletteStore.getState().openAddProject();
    useSettingsDialogStore.getState().openSettings("providers");

    clearWebHostedNodeScopedState(environmentId);

    expect(useStore.getState().activeEnvironmentId).toBe(environmentId);
    expect(
      useComposerDraftStore.getState().getComposerDraft(DraftId.make("sensitiveThread"))?.prompt,
    ).toBe("sensitive prompt");
    expect(useTerminalStateStore.getState().terminalStateByThreadKey).toHaveProperty(
      "sensitiveThread",
    );
    expect(useMessageQueueStore.getState().queuesByThreadKey).toHaveProperty("sensitiveThread");
    expect(useUiStateStore.getState()).toMatchObject({
      projectOrder: ["sensitiveProject"],
      pinnedThreadKeys: { sensitiveThread: true },
    });
    expect(useCommandPaletteStore.getState().open).toBe(true);
    expect(useSettingsDialogStore.getState().open).toBe(true);
    // Project artwork is keyed by node and survives a node switch.
    expect(peekProjectIconSource(environmentId, iconProjectId, null)).toBe(ICON_SOURCE);
    // Owner-only statistics of the node being left are not repainted; other nodes keep theirs.
    expect(statisticsSnapshotCache.peek(environmentId)).toBeUndefined();
    expect(statisticsSnapshotCache.peek(otherEnvironmentId)?.generatedAt).toBe(
      `statistics-${otherEnvironmentId}`,
    );
  });

  it("forgets only the left environment's server config entry", () => {
    const leftConfig = serverConfigFor(environmentId);
    const keptConfig = serverConfigFor(otherEnvironmentId);
    writeEnvironmentServerConfig(environmentId, leftConfig);
    writeEnvironmentServerConfig(otherEnvironmentId, keptConfig);

    clearWebHostedNodeScopedState(environmentId);

    expect(readEnvironmentServerConfig(environmentId)).toBeNull();
    expect(readEnvironmentServerConfig(otherEnvironmentId)).toBe(keptConfig);
  });

  it("leaves the global server config on the environment that is shown", () => {
    const keptConfig = serverConfigFor(otherEnvironmentId);
    writeEnvironmentServerConfig(environmentId, serverConfigFor(environmentId));
    writeEnvironmentServerConfig(otherEnvironmentId, keptConfig);
    const stop = startActiveEnvironmentServerConfigProjection({
      readActive: () => otherEnvironmentId,
      subscribeActive: () => () => undefined,
    });

    // The previous node's teardown during a switch: no global config clear.
    clearWebHostedNodeScopedState(environmentId);
    expect(getServerConfig()).toBe(keptConfig);

    // Forgetting the shown environment's own entry resets what is shown.
    clearWebHostedNodeScopedState(otherEnvironmentId);
    expect(getServerConfig()).toBeNull();
    stop();
  });

  it("resets the shown server config of the environment left while no projection runs", () => {
    const leftConfig = serverConfigFor(environmentId);
    writeEnvironmentServerConfig(environmentId, leftConfig);
    writeEnvironmentServerConfig(otherEnvironmentId, serverConfigFor(otherEnvironmentId));
    // The projection showed the left node, then went away with the shell
    // surface a node switch renders without.
    startActiveEnvironmentServerConfigProjection({
      readActive: () => environmentId,
      subscribeActive: () => () => undefined,
    })();
    expect(getServerConfig()).toBe(leftConfig);

    clearWebHostedNodeScopedState(environmentId);

    expect(getServerConfig()).toBeNull();
    expect(getServerConfigUpdatedNotification()).toBeNull();
    expect(readEnvironmentServerConfig(otherEnvironmentId)).not.toBeNull();
  });

  it("keeps the shown server config when another environment is left with no projection", () => {
    const shownConfig = serverConfigFor(otherEnvironmentId);
    writeEnvironmentServerConfig(environmentId, serverConfigFor(environmentId));
    writeEnvironmentServerConfig(otherEnvironmentId, shownConfig);
    startActiveEnvironmentServerConfigProjection({
      readActive: () => otherEnvironmentId,
      subscribeActive: () => () => undefined,
    })();

    clearWebHostedNodeScopedState(environmentId);

    expect(getServerConfig()).toBe(shownConfig);
  });

  it("drops the welcome of the primary node being left and keeps it for any other", () => {
    writePrimaryEnvironmentDescriptor({
      environmentId,
      label: "node",
    } as unknown as ExecutionEnvironmentDescriptor);
    const welcome = {
      environment: { environmentId: "legacy-node-id", label: "node" },
      cwd: "/workspace",
      bootstrapProjectId: "project",
      bootstrapThreadId: "thread",
    } as unknown as ServerLifecycleWelcomePayload;
    emitWelcome(welcome);

    // Leaving an environment that is not the primary does not touch its welcome.
    clearWebHostedNodeScopedState(otherEnvironmentId);
    expect(appAtomRegistry.get(welcomeAtom)).toBe(welcome);

    // The welcome names the node by its own id, not the Hub's: the primary
    // descriptor tells which environment it belongs to.
    clearWebHostedNodeScopedState(environmentId);
    expect(appAtomRegistry.get(welcomeAtom)).toBeNull();
  });

  it("clears preserved cross-node state at the account-session boundary", async () => {
    await cacheProjectIcon();
    await cacheStatistics(environmentId);
    useComposerDraftStore.getState().setPrompt(DraftId.make("accountDraft"), "private prompt");
    useUiStateStore.setState({ pinnedThreadKeys: { accountThread: true } });
    useCommandPaletteStore.getState().openAddProject();
    useMessageQueueStore
      .getState()
      .enqueue("accountThread", { id: "queued", composer: {} as never, settings: {} as never });
    useMessageQueueStore.getState().hold("accountThread", {
      reason: "error",
      detail: "boom",
      causeKeys: ["error:turn:boom"],
      heldAt: "2026-10-01T00:00:00.000Z",
    });
    const epoch = useMessageQueueStore.getState().epoch;

    clearWebHostedAccountScopedState();

    expect(
      useComposerDraftStore.getState().getComposerDraft(DraftId.make("accountDraft")),
    ).toBeNull();
    expect(useUiStateStore.getState().pinnedThreadKeys).toEqual({});
    expect(useCommandPaletteStore.getState().open).toBe(false);
    // The queue reset bumps the epoch so in-flight queued sends are dropped.
    expect(useMessageQueueStore.getState()).toMatchObject({
      queuesByThreadKey: {},
      holdsByThreadKey: {},
      acknowledgedCauseKeysByThreadKey: {},
      epoch: epoch + 1,
    });
    expect(peekProjectIconSource(environmentId, iconProjectId, null)).toBeUndefined();
    expect(projectIconCacheBytes(environmentId)).toBe(0);
    expect(statisticsSnapshotCache.peek(environmentId)).toBeUndefined();
  });

  it("purges every environment's server config entry at the account-session boundary", () => {
    writeEnvironmentServerConfig(environmentId, serverConfigFor(environmentId));
    writeEnvironmentServerConfig(otherEnvironmentId, serverConfigFor(otherEnvironmentId));

    clearWebHostedAccountScopedState();

    expect(readEnvironmentServerConfig(environmentId)).toBeNull();
    expect(readEnvironmentServerConfig(otherEnvironmentId)).toBeNull();
  });
});
