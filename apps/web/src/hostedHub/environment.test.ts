import {
  peekProjectIconSource,
  projectIconCacheBytes,
  readProjectIconSource,
} from "@ryco/client-runtime/connection";
import { dailyRecapCache } from "@ryco/client-runtime/state/dailyRecap";
import { statisticsSnapshotCache } from "@ryco/client-runtime/usage";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DailyRecapRequest,
  type DailyRecapSnapshot,
  type EnvironmentApi,
  type ExecutionEnvironmentDescriptor,
  type ProjectSearchEntriesResult,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type StatisticsSnapshot,
  type VcsListRefsResult,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import * as environmentApi from "../environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import { useMessageQueueStore } from "../messageQueueStore";
import {
  getBranchesSnapshot,
  getBranchesTargetKey,
  resetGitAtomsForTests,
  watchBranches,
} from "../rpc/gitAtoms";
import {
  EMPTY_PROJECT_SEARCH_ENTRIES_STATE,
  getProjectSearchEntriesSnapshot,
  requestProjectSearchEntries,
  resetProjectAtomsForTests,
} from "../rpc/projectAtoms";
import {
  checkpointDiffCacheKey,
  checkpointDiffStateAtom,
  resetCheckpointDiffStateForTests,
  watchCheckpointDiff,
  type CheckpointDiffInput,
} from "../rpc/providerAtoms";
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
import { clearWebE2eeLatches, isWebE2eeSelectionLatched, latchWebE2eeSelection } from "./e2eeLatch";
import {
  beginWebE2eeChannelAttempt,
  lockWebE2eeChannelMode,
  resetWebE2eeSession,
  webE2eeSessionStateFor,
} from "./e2eeSession";
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

const RECAP_REQUEST = { date: "2026-10-24", timeZone: "Europe/Berlin" } as DailyRecapRequest;

/** Load `target`'s daily recap into the shared cache; it answers when `release` runs. */
function loadRecap(target: EnvironmentId) {
  let release: () => void = () => undefined;
  const answered = new Promise<DailyRecapSnapshot>((resolve) => {
    release = () => resolve({ date: RECAP_REQUEST.date } as DailyRecapSnapshot);
  });
  const result = dailyRecapCache.load(
    { environmentId: target, label: target, getDailyRecap: () => answered },
    RECAP_REQUEST,
  );
  return { result, release };
}

async function cacheRecap(target: EnvironmentId): Promise<void> {
  const recap = loadRecap(target);
  recap.release();
  await recap.result;
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
  dailyRecapCache.clear();
  resetServerStateForTests();
  resetEnvironmentServerConfigsForTests();
  resetPrimaryEnvironmentDescriptorForTests();
  resetProjectAtomsForTests();
  resetGitAtomsForTests();
  resetCheckpointDiffStateForTests();
  resetWebE2eeSession();
  clearWebE2eeLatches();
  vi.restoreAllMocks();
});

const CWD = "/workspace";
const threadId = ThreadId.make("thread-id");

/**
 * One environment's project search, branch and checkpoint-diff caches, each
 * holding a fetched answer, through a fake environment API.
 */
async function cacheNodeContent(target: EnvironmentId): Promise<() => void> {
  const api = {
    projects: {
      searchEntries: async () =>
        ({
          entries: [{ kind: "file", path: `${target}.ts` }],
          truncated: true,
        }) as unknown as ProjectSearchEntriesResult,
    },
    vcs: {
      listRefs: async (): Promise<VcsListRefsResult> => ({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 0,
      }),
    },
    orchestration: {
      getTurnDiff: async (request: { fromTurnCount: number; toTurnCount: number }) => ({
        diff: `patch-${target}`,
        threadId,
        fromTurnCount: request.fromTurnCount,
        toTurnCount: request.toTurnCount,
      }),
    },
  } as unknown as EnvironmentApi;
  vi.spyOn(environmentApi, "ensureEnvironmentApi").mockReturnValue(api);
  vi.spyOn(environmentApi, "readEnvironmentApi").mockReturnValue(api);

  requestProjectSearchEntries({ environmentId: target, cwd: CWD, query: "a" });
  const releaseBranches = watchBranches({ environmentId: target, cwd: CWD, query: "" });
  // Released once fetched, so it stays cached as an unwatched diff.
  const releaseDiff = watchCheckpointDiff(diffInput(target));
  await vi.waitFor(() => {
    expect(projectSearch(target).data).not.toBeNull();
    expect(branches(target).pages).toHaveLength(1);
    expect(diff(target).data?.diff).toBe(`patch-${target}`);
  });
  releaseDiff();
  vi.restoreAllMocks();
  return releaseBranches;
}

function projectSearch(target: EnvironmentId) {
  return getProjectSearchEntriesSnapshot({ environmentId: target, cwd: CWD, query: "a" });
}

function branches(target: EnvironmentId) {
  return getBranchesSnapshot(getBranchesTargetKey({ environmentId: target, cwd: CWD, query: "" }));
}

function diffInput(target: EnvironmentId): CheckpointDiffInput {
  return {
    environmentId: target,
    threadId,
    fromTurnCount: 1,
    toTurnCount: 2,
    ignoreWhitespace: false,
    cacheScope: "turn:2",
  };
}

function diff(target: EnvironmentId) {
  return appAtomRegistry.get(checkpointDiffStateAtom(checkpointDiffCacheKey(diffInput(target))));
}

/** A channel to `target` that locked `e2ee`, as the §4.4 machine drives it. */
function lockE2eeChannel(target: EnvironmentId): void {
  const channel = {};
  beginWebE2eeChannelAttempt(target, channel);
  lockWebE2eeChannelMode("e2ee", target, channel);
}

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

  it("forgets the left environment's daily recaps, in flight too, and keeps the others'", async () => {
    await cacheRecap(environmentId);
    await cacheRecap(otherEnvironmentId);
    const inFlight = loadRecap(environmentId);

    clearWebHostedNodeScopedState(environmentId);
    inFlight.release();
    await inFlight.result;

    expect(dailyRecapCache.peek(environmentId, RECAP_REQUEST)).toBeUndefined();
    expect(dailyRecapCache.peek(otherEnvironmentId, RECAP_REQUEST)?.environmentId).toBe(
      otherEnvironmentId,
    );
  });

  it("clears only the left environment's E2EE entry and node caches", async () => {
    const releaseA = await cacheNodeContent(environmentId);
    const releaseB = await cacheNodeContent(otherEnvironmentId);
    lockE2eeChannel(environmentId);
    lockE2eeChannel(otherEnvironmentId);
    const selection = {
      hubOrigin: "https://hub.example.test",
      accountId: "acct_0123456789",
      nodeId: "node_AAAAAAAAAAAAAAAAAAAAAA",
    };
    latchWebE2eeSelection(selection);

    clearWebHostedNodeScopedState(environmentId);

    expect(webE2eeSessionStateFor(environmentId).status).toBe("unavailable");
    expect(projectSearch(environmentId)).toEqual(EMPTY_PROJECT_SEARCH_ENTRIES_STATE);
    expect(branches(environmentId).pages).toHaveLength(0);
    expect(diff(environmentId).data).toBeNull();
    // Another node's channel and caches did not end with this one.
    expect(webE2eeSessionStateFor(otherEnvironmentId).status).toBe("web-unsigned");
    expect(projectSearch(otherEnvironmentId).data).not.toBeNull();
    expect(branches(otherEnvironmentId).pages).toHaveLength(1);
    expect(diff(otherEnvironmentId).data?.diff).toBe(`patch-${otherEnvironmentId}`);
    // docs/relay-e2ee-protocol.md §12.1's latch is application-session state and
    // outlives every node teardown.
    expect(isWebE2eeSelectionLatched(selection)).toBe(true);
    releaseA();
    releaseB();
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

  it("clears every environment's daily recaps at the account-session boundary", async () => {
    await cacheRecap(otherEnvironmentId);
    const inFlight = loadRecap(environmentId);

    clearWebHostedAccountScopedState();
    inFlight.release();
    await inFlight.result;

    expect(dailyRecapCache.peek(environmentId, RECAP_REQUEST)).toBeUndefined();
    expect(dailyRecapCache.peek(otherEnvironmentId, RECAP_REQUEST)).toBeUndefined();
  });

  it("clears every environment's node caches at the account-session boundary", async () => {
    const releaseA = await cacheNodeContent(environmentId);
    const releaseB = await cacheNodeContent(otherEnvironmentId);

    clearWebHostedAccountScopedState();

    for (const target of [environmentId, otherEnvironmentId]) {
      expect(projectSearch(target)).toEqual(EMPTY_PROJECT_SEARCH_ENTRIES_STATE);
      expect(branches(target).pages).toHaveLength(0);
      expect(diff(target).data).toBeNull();
    }
    releaseA();
    releaseB();
  });

  it("purges every environment's server config entry at the account-session boundary", () => {
    writeEnvironmentServerConfig(environmentId, serverConfigFor(environmentId));
    writeEnvironmentServerConfig(otherEnvironmentId, serverConfigFor(otherEnvironmentId));

    clearWebHostedAccountScopedState();

    expect(readEnvironmentServerConfig(environmentId)).toBeNull();
    expect(readEnvironmentServerConfig(otherEnvironmentId)).toBeNull();
  });
});
