/**
 * Test-only fixtures for the projects page: two environments (this device and
 * a "Studio" remote), a repository checked out on both, a local-only scratch
 * folder, threads and worktrees. `seedProjectsFixtureStore` writes them into
 * the real app store so the page derives everything through production code.
 */
import {
  EnvironmentId,
  ProviderInstanceId,
  type ProjectId,
  type RepositoryIdentity,
  type ThreadId,
  type WorktreeId,
} from "@ryco/contracts";

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../../environments/primary";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../../environments/runtime";
import { useStore, type EnvironmentState } from "../../../store";
import type { Project, SidebarThreadSummary, SidebarWorktreeSummary } from "../../../types";
import { useProjectsLayoutStore } from "../projectsLayoutStore";

export const FIXTURE_NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
export const FIXTURE_NOW_ISO = new Date(FIXTURE_NOW_MS).toISOString();

export const LOCAL_ENV = EnvironmentId.make("env-local");
export const STUDIO_ENV = EnvironmentId.make("env-studio");

export const RYCO_LOCAL = "project-ryco-local" as ProjectId;
export const RYCO_STUDIO = "project-ryco-studio" as ProjectId;
export const HUB_LOCAL = "project-hub-local" as ProjectId;
export const SCRATCH_LOCAL = "project-scratch-local" as ProjectId;

export const RYCO_IDENTITY: RepositoryIdentity = {
  canonicalKey: "github.com/sak0a/ryco",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:sak0a/ryco.git",
  },
  displayName: "sak0a/ryco",
  provider: "github",
  owner: "sak0a",
  name: "ryco",
  remotes: [
    {
      name: "origin",
      url: "git@github.com:sak0a/ryco.git",
      provider: "github",
      ownerRepo: "sak0a/ryco",
    },
    {
      name: "upstream",
      url: "https://github.com/pingdotgg/t3code.git",
      provider: "github",
      ownerRepo: "pingdotgg/t3code",
    },
  ],
};

export const HUB_IDENTITY: RepositoryIdentity = {
  canonicalKey: "github.com/sak0a/ryco-hub",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:sak0a/ryco-hub.git",
  },
  displayName: "sak0a/ryco-hub",
  provider: "github",
  owner: "sak0a",
  name: "ryco-hub",
  remotes: [
    {
      name: "origin",
      url: "git@github.com:sak0a/ryco-hub.git",
      provider: "github",
      ownerRepo: "sak0a/ryco-hub",
    },
  ],
};

export function fixtureProject(input: {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly cwd: string;
  readonly repositoryIdentity?: RepositoryIdentity | null;
  readonly overrides?: Partial<Project>;
}): Project {
  return {
    id: input.id,
    environmentId: input.environmentId,
    name: input.name,
    cwd: input.cwd,
    repositoryIdentity: input.repositoryIdentity ?? null,
    defaultModelSelection: null,
    customSystemPrompt: null,
    customAvatarContentHash: null,
    preferredRemoteName: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-09-20T09:00:00.000Z",
    scripts: [],
    ...input.overrides,
  };
}

export function fixtureThread(input: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly updatedAt?: string;
  readonly overrides?: Partial<SidebarThreadSummary>;
}): SidebarThreadSummary {
  const at = input.updatedAt ?? FIXTURE_NOW_ISO;
  return {
    id: input.id as ThreadId,
    environmentId: input.environmentId,
    projectId: input.projectId,
    title: input.title,
    interactionMode: "default",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    session: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: at,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input.overrides,
  };
}

export function fixtureWorktree(input: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly overrides?: Partial<SidebarWorktreeSummary>;
}): SidebarWorktreeSummary {
  return {
    id: input.id as WorktreeId,
    environmentId: input.environmentId,
    projectId: input.projectId,
    title: null,
    branch: input.branch,
    worktreePath: input.worktreePath,
    origin: "branch",
    prNumber: null,
    issueNumber: null,
    prTitle: null,
    issueTitle: null,
    prState: null,
    prIsDraft: null,
    issueState: null,
    workItemProvider: null,
    workItemKey: null,
    workItemTitle: null,
    workItemState: null,
    workItemStateName: null,
    workItemUrl: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    archivedAt: null,
    manualPosition: 1,
    ...input.overrides,
  };
}

export interface FixtureEnvironment {
  readonly projects: readonly Project[];
  readonly threads?: readonly SidebarThreadSummary[];
  readonly worktrees?: readonly SidebarWorktreeSummary[];
  readonly bootstrapComplete?: boolean;
}

export function fixtureEnvironmentState(environment: FixtureEnvironment): EnvironmentState {
  const threads = environment.threads ?? [];
  const worktrees = environment.worktrees ?? [];
  const threadIdsByProjectId: Record<string, ThreadId[]> = {};
  for (const thread of threads) {
    (threadIdsByProjectId[thread.projectId] ??= []).push(thread.id);
  }
  const worktreeIdsByProjectId: Record<string, WorktreeId[]> = {};
  for (const worktree of worktrees) {
    (worktreeIdsByProjectId[worktree.projectId] ??= []).push(worktree.id);
  }
  return {
    projectIds: environment.projects.map((project) => project.id),
    projectById: Object.fromEntries(environment.projects.map((project) => [project.id, project])),
    worktreeIds: worktrees.map((worktree) => worktree.id),
    worktreeIdsByProjectId,
    worktreeById: Object.fromEntries(worktrees.map((worktree) => [worktree.id, worktree])),
    threadIds: threads.map((thread) => thread.id),
    threadIdsByProjectId,
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    pendingMessagesByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: Object.fromEntries(threads.map((thread) => [thread.id, thread])),
    bootstrapComplete: environment.bootstrapComplete ?? true,
  } as EnvironmentState;
}

/** The default fixture world: ryco on both devices, ryco-hub and a scratch folder locally. */
export function defaultFixtureEnvironments(): Record<EnvironmentId, FixtureEnvironment> {
  return {
    [LOCAL_ENV]: {
      projects: [
        fixtureProject({
          id: RYCO_LOCAL,
          environmentId: LOCAL_ENV,
          name: "ryco",
          cwd: "/Users/me/Code/ryco",
          repositoryIdentity: RYCO_IDENTITY,
          overrides: {
            scripts: [
              {
                id: "test",
                name: "Test",
                command: "bun run test",
                icon: "test",
                runOnWorktreeCreate: false,
              },
              {
                id: "setup",
                name: "Setup",
                command: "bun install",
                icon: "configure",
                runOnWorktreeCreate: true,
              },
            ],
            customSystemPrompt: "Prefer Effect Schema over zod.",
          },
        }),
        fixtureProject({
          id: HUB_LOCAL,
          environmentId: LOCAL_ENV,
          name: "ryco-hub",
          cwd: "/Users/me/Code/ryco-hub",
          repositoryIdentity: HUB_IDENTITY,
        }),
        fixtureProject({
          id: SCRATCH_LOCAL,
          environmentId: LOCAL_ENV,
          name: "scratch",
          cwd: "/Users/me/tmp/scratch",
        }),
      ],
      threads: [
        fixtureThread({
          id: "thread-relay",
          environmentId: LOCAL_ENV,
          projectId: RYCO_LOCAL,
          title: "Fix the relay reconnect",
          updatedAt: "2026-10-03T10:00:00.000Z",
        }),
        fixtureThread({
          id: "thread-projects",
          environmentId: LOCAL_ENV,
          projectId: RYCO_LOCAL,
          title: "Add a projects page",
          updatedAt: "2026-10-02T10:00:00.000Z",
          overrides: {
            branch: "projects-page",
            worktreePath: "/Users/me/.ryco/worktrees/ryco/projects-page__abcde",
          },
        }),
        fixtureThread({
          id: "thread-hub",
          environmentId: LOCAL_ENV,
          projectId: HUB_LOCAL,
          title: "Rotate relay keys",
          updatedAt: "2026-09-28T10:00:00.000Z",
        }),
      ],
      worktrees: [
        fixtureWorktree({
          id: "worktree-projects",
          environmentId: LOCAL_ENV,
          projectId: RYCO_LOCAL,
          branch: "projects-page",
          worktreePath: "/Users/me/.ryco/worktrees/ryco/projects-page__abcde",
          overrides: {
            origin: "pr",
            prNumber: 663,
            prTitle: "Add a projects page",
            prState: "open",
          },
        }),
        fixtureWorktree({
          id: "worktree-old",
          environmentId: LOCAL_ENV,
          projectId: RYCO_LOCAL,
          branch: "old-experiment",
          worktreePath: "/Users/me/.ryco/worktrees/ryco/old-experiment__qwert",
          overrides: { archivedAt: "2026-09-01T09:00:00.000Z" },
        }),
      ],
    },
    [STUDIO_ENV]: {
      projects: [
        fixtureProject({
          id: RYCO_STUDIO,
          environmentId: STUDIO_ENV,
          name: "ryco",
          cwd: "/home/me/src/ryco",
          repositoryIdentity: RYCO_IDENTITY,
        }),
      ],
      threads: [
        fixtureThread({
          id: "thread-studio",
          environmentId: STUDIO_ENV,
          projectId: RYCO_STUDIO,
          title: "Profile the Linux build",
          updatedAt: "2026-10-01T08:00:00.000Z",
        }),
      ],
    },
  };
}

/**
 * Writes fixture environments into the app store and names `LOCAL_ENV` the
 * primary environment ("This device").
 */
export function seedProjectsFixtureStore(
  environments: Record<string, FixtureEnvironment> = defaultFixtureEnvironments(),
): void {
  writePrimaryEnvironmentDescriptor({
    environmentId: LOCAL_ENV,
    label: "MacBook Pro",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
      projectPreferences: true,
      threadSettlement: false,
      threadPriorityRanking: false,
    },
  });
  // The remote device is a saved environment with a live connection.
  useSavedEnvironmentRegistryStore.setState({
    byId: {
      [STUDIO_ENV]: {
        environmentId: STUDIO_ENV,
        label: "Studio",
        wsBaseUrl: "ws://studio.test",
        httpBaseUrl: "http://studio.test",
        createdAt: "2026-08-01T09:00:00.000Z",
        lastConnectedAt: FIXTURE_NOW_ISO,
      },
    },
  });
  useSavedEnvironmentRuntimeStore.setState((state) => ({
    byId: {
      ...state.byId,
      [STUDIO_ENV]: {
        connectionState: "connected",
        authState: "authenticated",
        lastError: null,
        lastErrorAt: null,
        role: "owner",
        descriptor: null,
        serverConfig: null,
        connectedAt: FIXTURE_NOW_ISO,
        disconnectedAt: null,
      },
    },
  }));
  useStore.setState({
    activeEnvironmentId: LOCAL_ENV,
    environmentStateById: Object.fromEntries(
      Object.entries(environments).map(([environmentId, environment]) => [
        environmentId,
        fixtureEnvironmentState(environment),
      ]),
    ),
  });
}

/** Call in `afterEach`: clears the store, primary descriptor and page habits. */
export function resetProjectsFixtureState(): void {
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  resetPrimaryEnvironmentDescriptorForTests();
  resetSavedEnvironmentRegistryStoreForTests();
  resetSavedEnvironmentRuntimeStoreForTests();
  useProjectsLayoutStore.setState({
    lastCheckoutKey: null,
    drawerOpen: false,
    drawerOpener: null,
    filterFocusRequested: false,
  });
}
