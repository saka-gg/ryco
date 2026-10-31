import "../../index.css";

import {
  configureHostedEnvironmentSessions,
  getHostedEnvironmentSessions,
  resetHostedEnvironmentSessionsForTests,
} from "@ryco/client-runtime/authorization/hostedEnvironmentSessions";
import { appAtomRegistry, serverConfigAtom } from "@ryco/client-runtime/rpc";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeId,
  type EnvironmentApi,
  type ModelSelection,
  type OrchestrationShellSnapshot,
  type ServerConfig,
} from "@ryco/contracts";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import { resetNewDraftDefaultsCacheForTests } from "../../hooks/newDraftDefaults";
import { hostedHubStore } from "../../hostedHub/state";
import type { HostedHubNode } from "../../hostedHub/types";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useStore } from "../../store";
import { PromptLinkRoute } from "../routeViews/PromptLinkRouteView";
import { SidebarProvider } from "../ui/sidebar";
import { toastManager } from "../ui/toast";

const ENV = EnvironmentId.make("env-prompt-links");
const PROJECT = ProjectId.make("project-ryco");
const PR_WORKTREE = WorktreeId.make("worktree-pr-42");
const PR_THREAD = ThreadId.make("thread-pr-42");
const AT = "2026-10-30T09:00:00.000Z";
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5-5",
  options: [],
};

const identity = {
  canonicalKey: "github.com/saka-gg/ryco",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/saka-gg/ryco.git",
  },
  remotes: [{ name: "origin", url: "https://github.com/saka-gg/ryco.git" }],
} as const;

function provider(instanceId: string, driver: string, models: ReadonlyArray<string>) {
  return {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: AT,
    models: models.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      ...(index === 0 ? { isDefault: true } : {}),
    })),
    slashCommands: [],
    skills: [],
  };
}

function serverConfig(environment: ServerConfig["environment"]): ServerConfig {
  return {
    environment,
    providers: [
      provider("claude", "claudeAgent", ["claude-opus-5-5"]),
      provider("codex", "codex", ["gpt-5.4", "gpt-5.5"]),
    ],
    settings: { ...DEFAULT_SERVER_SETTINGS, initialModelSelection: MODEL },
  } as unknown as ServerConfig;
}

function seedNode(options: {
  readonly pullRequestThread: boolean;
  readonly pullRequestWorktree?: boolean;
}) {
  const environment = {
    environmentId: ENV,
    label: "Laptop",
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "1",
    capabilities: { repositoryIdentity: true, threadSettlement: true },
  };
  writePrimaryEnvironmentDescriptor(environment);
  appAtomRegistry.set(
    serverConfigAtom,
    serverConfig(environment as unknown as ServerConfig["environment"]),
  );
  useStore.getState().syncServerShellSnapshot(
    {
      snapshotSequence: 1,
      projects: [
        {
          id: PROJECT,
          title: "ryco",
          workspaceRoot: "/repo/ryco",
          repositoryIdentity: identity,
          defaultModelSelection: null,
          scripts: [],
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      worktrees:
        options.pullRequestThread || options.pullRequestWorktree
          ? [
              {
                worktreeId: PR_WORKTREE,
                projectId: PROJECT,
                title: null,
                branch: "fix/failing-check",
                worktreePath: "/repo/ryco-pr-42",
                origin: "pr",
                prNumber: 42,
                issueNumber: null,
                prTitle: "Fix the failing check",
                issueTitle: null,
                prState: "open",
                prIsDraft: false,
                issueState: null,
                createdAt: AT,
                updatedAt: AT,
                archivedAt: null,
              },
            ]
          : [],
      threads: options.pullRequestThread
        ? [
            {
              id: PR_THREAD,
              projectId: PROJECT,
              title: "Fix the failing check",
              modelSelection: MODEL,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "fix/failing-check",
              worktreePath: "/repo/ryco-pr-42",
              worktreeId: PR_WORKTREE,
              latestTurn: null,
              createdAt: AT,
              updatedAt: AT,
              archivedAt: null,
              session: null,
              latestUserMessageAt: AT,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
            },
          ]
        : [],
      updatedAt: AT,
    } as unknown as OrchestrationShellSnapshot,
    ENV,
  );
}

/** A node that records anything that would send or check out. */
function fakeNode() {
  const orchestration = { dispatchCommand: vi.fn(async () => ({ sequence: 1 })) };
  const git = { createWorktreeForProject: vi.fn(async () => ({})) };
  // A hosted draft reads the node's config fresh.
  const server = { getConfig: vi.fn(async () => appAtomRegistry.get(serverConfigAtom)) };
  return {
    orchestration,
    git,
    api: { orchestration, git, server } as unknown as EnvironmentApi,
  };
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function mountAt(url: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/new", component: PromptLinkRoute }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/draft/$draftId",
      component: () => <p>Draft page</p>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/$environmentId/$threadId",
      component: () => <p>Thread page</p>,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  mounted = await render(
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <RouterProvider router={router} />
      </SidebarProvider>
    </AppAtomRegistryProvider>,
  );
  return router;
}

function link(params: Record<string, string>): string {
  return `/new?${new URLSearchParams(params).toString()}`;
}

async function openedDraft(router: Awaited<ReturnType<typeof mountAt>>): Promise<DraftId> {
  await expect.element(page.getByText("Draft page")).toBeInTheDocument();
  const match = /^\/draft\/([^/?]+)/.exec(router.state.location.pathname);
  expect(match).not.toBeNull();
  return match![1] as DraftId;
}

const draftPrompt = (draftId: DraftId) =>
  useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt ?? null;

beforeEach(() => {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mounted?.unmount();
  mounted = null;
  __resetEnvironmentApiOverridesForTests();
  resetNewDraftDefaultsCacheForTests();
  appAtomRegistry.set(serverConfigAtom, null);
  resetPrimaryEnvironmentDescriptorForTests();
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  resetHostedEnvironmentSessionsForTests();
  hostedHubStore.setState(hostedHubStore.getInitialState(), true);
  vi.unstubAllEnvs();
  document.body.innerHTML = "";
});

function hubNode(environmentId: EnvironmentId): HostedHubNode {
  return {
    id: "node_prompt_links",
    environmentId,
    label: "Laptop",
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: "grant_prompt_links", role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

describe("prompt links", () => {
  it("fills a draft in the linked repository's project with the requested model, and sends nothing", async () => {
    seedNode({ pullRequestThread: false });
    const node = fakeNode();
    __setEnvironmentApiOverrideForTests(ENV, node.api);
    const toasts = vi.spyOn(toastManager, "add");

    const router = await mountAt(
      link({
        prompt: "Fix the build",
        repo: "https://github.com/saka-gg/ryco",
        provider: "codex",
        model: "gpt-5.5",
      }),
    );
    const draftId = await openedDraft(router);

    await vi.waitFor(() => expect(draftPrompt(draftId)).toBe("Fix the build"));
    const session = useComposerDraftStore.getState().getDraftSession(draftId);
    expect(session).toMatchObject({ environmentId: ENV, projectId: PROJECT, envMode: "local" });
    expect(session?.runtimeMode).toBe("full-access");
    const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(draft?.modelSelectionByProvider[ProviderInstanceId.make("codex")]?.model).toBe(
      "gpt-5.5",
    );
    expect(draft?.activeProvider).toBe("codex");
    expect(toasts).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Prompt added from a link",
        description: "This prompt came from a link. Read it before you send it.",
      }),
    );
    // A link never sends and never checks anything out.
    expect(node.orchestration.dispatchCommand).not.toHaveBeenCalled();
    expect(node.git.createWorktreeForProject).not.toHaveBeenCalled();
  });

  it("asks before it replaces text the user already typed", async () => {
    seedNode({ pullRequestThread: false });
    __setEnvironmentApiOverrideForTests(ENV, fakeNode().api);
    const toasts = vi.spyOn(toastManager, "add");
    const router = await mountAt(link({ prompt: "First", repo: "saka-gg/ryco" }));
    const draftId = await openedDraft(router);
    await vi.waitFor(() => expect(draftPrompt(draftId)).toBe("First"));
    useComposerDraftStore.getState().setPrompt(draftId, "My own notes");

    toasts.mockClear();
    await router.navigate({ href: link({ prompt: "Second", repo: "saka-gg/ryco" }) });
    await vi.waitFor(() =>
      expect(toasts).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Linked prompt ready", timeout: 0 }),
      ),
    );
    // Same draft, still the user's text.
    expect(router.state.location.pathname).toBe(`/draft/${draftId}`);
    expect(draftPrompt(draftId)).toBe("My own notes");

    const ask = toasts.mock.calls.find(([options]) => options.title === "Linked prompt ready")![0];
    expect(ask.actionProps?.children).toBe("Replace draft");
    vi.spyOn(toastManager, "close").mockImplementation(() => undefined);
    ask.actionProps?.onClick?.({} as never);
    expect(draftPrompt(draftId)).toBe("Second");
  });

  it("removes hidden characters and warns until the warning is dismissed", async () => {
    seedNode({ pullRequestThread: false });
    __setEnvironmentApiOverrideForTests(ENV, fakeNode().api);
    const toasts = vi.spyOn(toastManager, "add");
    const router = await mountAt(
      link({ prompt: "Rate me\u200B\u202E", repo: "saka-gg/ryco", provider: "cursor" }),
    );
    const draftId = await openedDraft(router);
    await vi.waitFor(() => expect(draftPrompt(draftId)).toBe("Rate me"));
    expect(toasts).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        timeout: 0,
        title: "This prompt had hidden characters, it may be malicious",
        description:
          "This prompt had 2 hidden characters, so it may be malicious. Ryco removed them. Read the prompt before you send it. The link asked for cursor, which is not set up here, so your default model is used.",
      }),
    );
  });

  it("puts a pull request link's prompt in the thread working on it", async () => {
    seedNode({ pullRequestThread: true });
    const node = fakeNode();
    __setEnvironmentApiOverrideForTests(ENV, node.api);
    const router = await mountAt(link({ pr: "saka-gg/ryco/42", prompt: "Fix the check" }));

    await expect.element(page.getByText("Thread page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/${ENV}/${PR_THREAD}`);
    await vi.waitFor(() =>
      expect(
        useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(ENV, PR_THREAD))?.prompt,
      ).toBe("Fix the check"),
    );
    expect(node.orchestration.dispatchCommand).not.toHaveBeenCalled();
  });

  it("opens the draft on a checkout that already carries the pull request", async () => {
    seedNode({ pullRequestThread: false, pullRequestWorktree: true });
    const node = fakeNode();
    __setEnvironmentApiOverrideForTests(ENV, node.api);
    const router = await mountAt(link({ pr: "saka-gg/ryco#42", prompt: "Fix the check" }));
    const draftId = await openedDraft(router);

    await vi.waitFor(() => expect(draftPrompt(draftId)).toBe("Fix the check"));
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      envMode: "local",
      worktreePath: "/repo/ryco-pr-42",
      branch: "fix/failing-check",
      worktreeSource: null,
    });
    expect(node.git.createWorktreeForProject).not.toHaveBeenCalled();
  });

  it("records a pull request checkout for Send when no thread works on it yet", async () => {
    seedNode({ pullRequestThread: false });
    const node = fakeNode();
    __setEnvironmentApiOverrideForTests(ENV, node.api);
    const toasts = vi.spyOn(toastManager, "add");
    const router = await mountAt(
      link({ pr: "https://github.com/saka-gg/ryco/pull/7", prompt: "Review it" }),
    );
    const draftId = await openedDraft(router);

    await vi.waitFor(() => expect(draftPrompt(draftId)).toBe("Review it"));
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      envMode: "worktree",
      worktreePath: null,
      worktreeSource: { kind: "pr", number: 7 },
    });
    expect(toasts).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining(
          "Send checks out saka-gg/ryco#7 into a new worktree first, which runs your project's setup script on its code.",
        ),
      }),
    );
    // The checkout waits for Send.
    expect(node.git.createWorktreeForProject).not.toHaveBeenCalled();
    expect(node.orchestration.dispatchCommand).not.toHaveBeenCalled();
  });

  it("waits on the hosted site until the selected node's session is adoptable", async () => {
    vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
    configureHostedEnvironmentSessions({
      now: () => 0,
      setTimeout: () => null,
      clearTimeout: () => undefined,
    });
    seedNode({ pullRequestThread: false });
    const node = fakeNode();
    __setEnvironmentApiOverrideForTests(ENV, node.api);
    hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      selectedNode: hubNode(ENV),
    });
    // The relay is still connecting: the shell in the store may be a cached one.
    const sessions = getHostedEnvironmentSessions();
    const { generation } = sessions.ensureRecord(hubNode(ENV));
    sessions.markConnectRequested(ENV, generation);
    sessions.transportStatus(ENV, generation, "connecting");

    const router = await mountAt(link({ prompt: "Fix the build", repo: "saka-gg/ryco" }));
    await expect.element(page.getByText("Waiting for your machine to connect.")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(router.state.location.pathname).toBe("/new");
    expect(useComposerDraftStore.getState().draftThreadsByThreadKey).toEqual({});

    // The lifecycle owner accepts a current snapshot on a fresh relay attempt.
    await act(async () => {
      sessions.transportStatus(ENV, generation, "online");
      sessions.markSessionReady(ENV, generation);
    });
    const draftId = await openedDraft(router);
    await vi.waitFor(() => expect(draftPrompt(draftId)).toBe("Fix the build"));
    expect(node.orchestration.dispatchCommand).not.toHaveBeenCalled();
  });

  it("says when no project is the linked repository", async () => {
    seedNode({ pullRequestThread: false });
    __setEnvironmentApiOverrideForTests(ENV, fakeNode().api);
    await mountAt(link({ prompt: "Hi", repo: "someone/else" }));
    await expect.element(page.getByText("You don't have someone/else")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Start without a project" }))
      .toBeInTheDocument();
    expect(useComposerDraftStore.getState().draftThreadsByThreadKey).toEqual({});
  });

  it("refuses a link it cannot open safely, before touching any draft", async () => {
    seedNode({ pullRequestThread: false });
    __setEnvironmentApiOverrideForTests(ENV, fakeNode().api);
    await mountAt(link({ prompt: "x".repeat(8_001), repo: "saka-gg/ryco" }));
    await expect
      .element(
        page.getByText("This prompt is longer than 8,000 characters, so Ryco did not open it."),
      )
      .toBeInTheDocument();
    expect(useComposerDraftStore.getState().draftThreadsByThreadKey).toEqual({});
  });
});
