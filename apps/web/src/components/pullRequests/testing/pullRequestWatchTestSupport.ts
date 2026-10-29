/**
 * Browser-test support for the pull request watch controls (the pull request
 * rail and the Crown's Checks): a node that watches pull requests, connected,
 * whose watch RPC is recorded, and watch summaries as its shells carry them.
 */
import {
  clearServerConfigState,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "@ryco/client-runtime/rpc";
import {
  WorktreeId,
  type EnvironmentApi,
  type EnvironmentId,
  type ServerConfig,
  type SourceControlSetPullRequestWatchInput,
  type SourceControlSetPullRequestWatchResult,
  type ThreadPullRequestWatchSummary,
} from "@ryco/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@ryco/contracts/settings";
import { vi } from "vite-plus/test";

import { __setEnvironmentApiOverrideForTests } from "~/environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "~/environments/primary/context";
import { setServerConfigSnapshot } from "~/rpc/serverState";

export function pullRequestWatchSummary(
  overrides: Partial<ThreadPullRequestWatchSummary> = {},
): ThreadPullRequestWatchSummary {
  return {
    watchId: "github.com/ryco/ryco#683",
    number: 683,
    url: "https://github.com/ryco/ryco/pull/683",
    worktreeId: WorktreeId.make("worktree-watch"),
    startedAt: "2026-10-28T10:00:00.000Z",
    startedBy: "user",
    news: false,
    autoFix: { status: "watching", pauseReason: null, attempts: 0, maxAttempts: 3 },
    headSha: "abc1234def5678",
    failingChecks: 0,
    passed: false,
    conflicting: false,
    delivering: false,
    lastChangeAt: null,
    ...overrides,
  };
}

/**
 * Makes `environmentId` the primary node: its config says whether it watches
 * pull requests, its connection is up (unless `connected` is false), and the
 * watch RPC answers through the returned mock.
 */
export function installPullRequestWatchNode(
  environmentId: EnvironmentId,
  options: { readonly available?: boolean; readonly connected?: boolean } = {},
) {
  const setPullRequestWatch = vi.fn(
    async (
      _input: SourceControlSetPullRequestWatchInput,
    ): Promise<SourceControlSetPullRequestWatchResult> => ({ watch: null, now: "" }),
  );
  const environment = {
    environmentId,
    label: "Node",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
      threadSettlement: false,
      threadPriorityRanking: false,
    },
  } as const;
  writePrimaryEnvironmentDescriptor(environment);
  setServerConfigSnapshot({
    environment,
    providers: [],
    settings: DEFAULT_SERVER_SETTINGS,
    ...(options.available === false ? {} : { pullRequestWatch: { available: true } }),
  } as unknown as ServerConfig);
  if (options.connected !== false) recordWsConnectionOpened({ environmentId });
  __setEnvironmentApiOverrideForTests(environmentId, {
    sourceControl: { setPullRequestWatch },
  } as unknown as EnvironmentApi);
  return { setPullRequestWatch };
}

/**
 * Undo `installPullRequestWatchNode` (the environment API overrides are the
 * caller's to reset). Leaves the atom registry itself alone: the rendered tree
 * still reads it until the render cleanup runs.
 */
export function resetPullRequestWatchNode(): void {
  clearServerConfigState();
  resetWsConnectionStateForTests();
  resetPrimaryEnvironmentDescriptorForTests();
}
