import {
  type EnvironmentApi,
  type MessageId,
  type OrchestrationReadModel,
  type ServerConfig,
} from "@ryco/contracts";
import type { ProjectImportSnapshot, ProjectImportStartInput } from "@ryco/contracts/project-copy";
import { projectCopyPlanWithSendFiles, startProjectCopy } from "@ryco/client-runtime/projectCopy";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { __setEnvironmentApiOverrideForTests } from "../../environmentApi";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  PROJECT_ID,
  REMOTE_ENVIRONMENT_ID,
  UUID_ROUTE_RE,
  createMockEnvironmentApi,
  createSnapshotForTargetUser,
  fixture,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForServerConfigToApply,
  waitForURL,
} from "../ChatView.browser.helpers";
import {
  resetProjectCopyManagerForTests,
  setProjectCopyRuntimeForTests,
} from "./copyRuntime/copyManager";
import {
  callNodeToRead,
  callNodeWithLease,
  createWebProjectCopyIo,
} from "./copyRuntime/webProjectCopyIo";
import { readAddProjectLastUsed, rememberAddProjectLastUsed } from "./addProjectMemory";
import { openAddProject, useProjectNodesDialogStore } from "./projectNodesDialogStore";
import {
  createFakeNodeApi,
  pinSavedEnvironmentState,
  unpinSavedEnvironmentStates,
} from "./projectNodesTestFixtures";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../../lib/gitStatusState", () => import("../../../test/gitStatusStateMock"));

const MINI = REMOTE_ENVIRONMENT_ID;
const OFFLINE = "environment-gaming-pc" as typeof MINI;
const BLOCKED = "environment-build" as typeof MINI;

function snapshotWith(
  repository: { canonicalKey: string; remoteUrl: string; name: string } | null,
): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-add-project-dialog" as MessageId,
    targetText: "add project dialog",
  });
  if (repository === null) return snapshot;
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID
        ? Object.assign({}, project, {
            repositoryIdentity: {
              canonicalKey: repository.canonicalKey,
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: repository.remoteUrl,
              },
              owner: "sak0a",
              name: repository.name,
              remotes: [],
            },
          })
        : project,
    ),
  };
}

/** A saved node in the catalog: connected (with or without project copy), offline, or client-only. */
function addSavedNode(input: {
  readonly environmentId: typeof MINI;
  readonly label: string;
  readonly projectCopy?: boolean;
  readonly state?: "connected" | "offline" | "client";
}) {
  const state = input.state ?? "connected";
  useSavedEnvironmentRegistryStore.getState().upsert({
    environmentId: input.environmentId,
    label: input.label,
    httpBaseUrl: `https://${input.environmentId}.example.test`,
    wsBaseUrl: `wss://${input.environmentId}.example.test/ws`,
    createdAt: NOW_ISO,
    lastConnectedAt: NOW_ISO,
  });
  const environment = {
    ...fixture.serverConfig.environment,
    environmentId: input.environmentId,
    label: input.label,
    capabilities: {
      ...fixture.serverConfig.environment.capabilities,
      projectCopy: input.projectCopy === true,
    },
  };
  const serverConfig: ServerConfig = { ...fixture.serverConfig, environment };
  const connectionState = state === "offline" ? "disconnected" : "connected";
  pinSavedEnvironmentState(input.environmentId, {
    connectionState,
    role: state === "client" ? "client" : null,
  });
  useSavedEnvironmentRuntimeStore.getState().patch(input.environmentId, {
    connectionState,
    authState: "authenticated",
    ...(state === "client" ? { role: "client" as const } : {}),
    descriptor: environment,
    serverConfig,
    connectedAt: NOW_ISO,
    ...(state === "offline"
      ? { disconnectedAt: new Date(Date.now() - 7_200_000).toISOString() }
      : {}),
  });
  return serverConfig;
}

function importSnapshot(
  input: ProjectImportStartInput,
  status: ProjectImportSnapshot["status"],
  steps: ProjectImportSnapshot["steps"],
  outputTail = "",
): ProjectImportSnapshot {
  return {
    importId: input.importId,
    projectId: input.projectId,
    title: input.title,
    destinationPath: input.destinationPath,
    status,
    steps,
    outputTail,
    error: null,
    warnings: [],
    preflight: null,
    leftoverPath: null,
    followUpThreadId: null,
    origin: input.origin,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

/** Mac mini: the picker fixture's folders, plus imports the test drives step by step. */
function createMacMiniApi(serverConfig: ServerConfig) {
  const fake = createFakeNodeApi();
  const listeners = new Set<(snapshot: ProjectImportSnapshot) => void>();
  let current: ProjectImportSnapshot | null = null;
  const emit = (snapshot: ProjectImportSnapshot) => {
    current = snapshot;
    for (const listener of listeners) listener(snapshot);
  };
  const importStart = vi.fn(async (input: ProjectImportStartInput) => {
    current = importSnapshot(input, "running", [
      { id: "preflight", status: "running", progressPercent: null, detail: null },
      { id: "clone", status: "pending", progressPercent: null, detail: null },
      { id: "register", status: "pending", progressPercent: null, detail: null },
    ]);
    return current;
  });
  const subscribeImport = vi.fn(
    (_input: { importId: string }, callback: (snapshot: ProjectImportSnapshot) => void) => {
      listeners.add(callback);
      if (current) callback(current);
      return () => listeners.delete(callback);
    },
  );
  const dispatchCommand = vi.fn(async (_command: unknown) => ({
    sequence: fixture.snapshot.snapshotSequence + 1,
  }));
  const cloneRepository = vi.fn(
    async (input: { readonly remoteUrl: string; readonly destinationPath: string }) => ({
      cwd: input.destinationPath,
      remoteUrl: input.remoteUrl,
      repository: null,
    }),
  );
  const cancelImport = vi.fn(async (_input: { importId: string }) => current!);
  const base = createMockEnvironmentApi({
    getConfig: async () => serverConfig,
    browse: fake.browse,
    dispatchCommand,
  });
  const api = {
    ...base,
    filesystem: fake.api.filesystem,
    projects: {
      ...fake.api.projects,
      importStart,
      subscribeImport,
      cancelImport,
      listImports: vi.fn(async () => ({ imports: current ? [current] : [] })),
    },
    sourceControl: { cloneRepository },
  } as unknown as EnvironmentApi;
  __setEnvironmentApiOverrideForTests(MINI, api);
  return {
    api,
    importStart,
    subscribeImport,
    cancelImport,
    dispatchCommand,
    cloneRepository,
    emit,
    fake,
  };
}

const dialog = () => page.getByTestId("add-project-dialog");
/** Fails an assertion where it waits instead of at the test's timeout. */
const ELEMENT_WAIT = { timeout: 8_000 } as const;

async function openDialog(): Promise<void> {
  useCommandPaletteStore.getState().openAddProject();
  await expect.element(dialog(), ELEMENT_WAIT).toBeVisible();
}

describe("AddProjectDialog", () => {
  setupChatViewBrowserSuite();
  afterEach(() => {
    unpinSavedEnvironmentStates();
    resetProjectCopyManagerForTests();
    setProjectCopyRuntimeForTests(null);
  });

  it("opens on the thread's node with the last used source, and the node pill goes back", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWith(null),
    });
    try {
      await waitForServerConfigToApply();
      createMacMiniApi(addSavedNode({ environmentId: MINI, label: "Mac mini", projectCopy: true }));
      // The last add cloned on the Mac mini; the thread on screen is on the Studio Mac.
      rememberAddProjectLastUsed(MINI, "clone");
      await openDialog();

      await expect
        .element(dialog().getByText(/What do you want to add on/), ELEMENT_WAIT)
        .toMatchTextContent(/What do you want to add on Studio Mac\?/);
      // The last source is preselected, not taken.
      await expect
        .element(dialog().getByRole("textbox", { name: "Repository to clone" }), ELEMENT_WAIT)
        .toBeVisible();
      await dialog().getByRole("button", { name: "Studio Mac" }).click();
      await expect
        .element(dialog().getByText("Which node should the project live on?"), ELEMENT_WAIT)
        .toBeVisible();
      await dialog()
        .getByRole("radio", { name: /Mac mini/ })
        .click();
      await expect
        .element(dialog().getByText(/What do you want to add on/), ELEMENT_WAIT)
        .toMatchTextContent(/What do you want to add on Mac mini\?/);
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists every node with its state, disables what can't take a project, then asks for the source", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWith(null),
    });
    try {
      await waitForServerConfigToApply();
      createMacMiniApi(addSavedNode({ environmentId: MINI, label: "Mac mini", projectCopy: true }));
      addSavedNode({ environmentId: OFFLINE, label: "Gaming PC", state: "offline" });
      addSavedNode({ environmentId: BLOCKED, label: "hetzner-build", state: "client" });
      await openDialog();
      // The thread's node is preselected; its pill goes back to the node step.
      await dialog().getByRole("button", { name: "Studio Mac" }).click();

      await expect
        .element(dialog().getByText("Which node should the project live on?"), ELEMENT_WAIT)
        .toBeVisible();
      const studio = dialog().getByRole("radio", { name: /Studio Mac/ });
      const mini = dialog().getByRole("radio", { name: /Mac mini/ });
      await expect.element(studio, ELEMENT_WAIT).toMatchTextContent(/1 project/);
      // Code roots come from the node's path hints.
      await expect
        .element(mini, ELEMENT_WAIT)
        .toMatchTextContent(/0 projects\s*·\s*~\/Code, ~\/Dropbox\/Code\/Web/);
      await expect
        .element(dialog().getByRole("radio", { name: /Gaming PC/ }), ELEMENT_WAIT)
        .toMatchTextContent(/offline (since|for) /);
      await expect
        .element(dialog().getByRole("radio", { name: /Gaming PC/ }), ELEMENT_WAIT)
        .toBeDisabled();
      await expect
        .element(dialog().getByRole("radio", { name: /hetzner-build/ }), ELEMENT_WAIT)
        .toBeDisabled();
      await expect
        .element(dialog().getByText("Settings → Connections"), ELEMENT_WAIT)
        .toBeVisible();

      await mini.click();
      await expect
        .element(dialog().getByText(/What do you want to add on/), ELEMENT_WAIT)
        .toMatchTextContent(/What do you want to add on Mac mini\?/);
      // The finished node step goes back.
      await dialog().getByRole("button", { name: "Mac mini" }).click();
      await expect
        .element(dialog().getByText("Which node should the project live on?"), ELEMENT_WAIT)
        .toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("clones through the node's import and follows it to the done step", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWith(null),
    });
    try {
      await waitForServerConfigToApply();
      const mini = createMacMiniApi(
        addSavedNode({ environmentId: MINI, label: "Mac mini", projectCopy: true }),
      );
      openAddProject({ environmentId: MINI, mode: "clone" });
      await expect.element(dialog(), ELEMENT_WAIT).toBeVisible();

      const repository = dialog().getByRole("textbox", { name: "Repository to clone" });
      await repository.fill("git@github.com:openai/codex.git");
      // A URL clones as typed, whatever provider the field had; its host lights GitHub
      // (not set up on this node, which a URL clone doesn't need).
      const github = dialog()
        .getByRole("group", { name: "Clone source" })
        .getByRole("button", { name: /^GitHub/ });
      await expect.element(github, ELEMENT_WAIT).toHaveAttribute("data-detected", "");
      await expect.element(github).toHaveAttribute("data-active", "");
      await userEvent.keyboard("{Enter}");

      await expect
        .element(dialog().getByText(/Where should/), ELEMENT_WAIT)
        .toMatchTextContent(/Where should codex go on Mac mini\? Pick the parent folder\./);
      await expect
        .element(page.getByTestId("folder-picker-status"), ELEMENT_WAIT)
        .toMatchTextContent(/^~\/Code\/codex\s*Clones github\.com\/openai\/codex here$/);
      const clone = dialog().getByRole("button", { name: "Clone to Mac mini" });
      await expect.element(clone, ELEMENT_WAIT).toBeEnabled();
      await clone.click();

      await vi.waitFor(() => expect(mini.importStart).toHaveBeenCalledTimes(1));
      // The next open starts from this node and source.
      expect(readAddProjectLastUsed()).toEqual({ nodeId: MINI, kind: "clone" });
      const input = mini.importStart.mock.calls[0]![0];
      expect(input).toMatchObject({
        title: "codex",
        destinationPath: "/Users/me/Code/codex",
        source: {
          kind: "clone",
          remoteUrl: "git@github.com:openai/codex.git",
          remoteName: "origin",
        },
        commits: null,
        changes: null,
        settings: null,
        setup: null,
        followUpThread: null,
        origin: { kind: "user", sourceLabel: null, proposalId: null },
      });

      await expect
        .element(dialog().getByText("Cloning codex to Mac mini"), ELEMENT_WAIT)
        .toBeVisible();
      mini.emit(
        importSnapshot(
          input,
          "running",
          [
            { id: "preflight", status: "done", progressPercent: null, detail: null },
            { id: "clone", status: "running", progressPercent: 40, detail: null },
            { id: "register", status: "pending", progressPercent: null, detail: null },
          ],
          "Receiving objects:  40% (736/1840)\n",
        ),
      );
      const steps = page.getByTestId("add-project-import-steps");
      await expect.element(steps, ELEMENT_WAIT).toMatchTextContent(/Cloning the repository/);
      await expect
        .element(steps, ELEMENT_WAIT)
        .toMatchTextContent(/Receiving objects: 40% \(736\/1840\)/);
      await expect
        .element(
          dialog().getByText("This keeps running on Mac mini if you close it."),
          ELEMENT_WAIT,
        )
        .toBeVisible();

      mini.emit(
        importSnapshot(input, "completed", [
          { id: "preflight", status: "done", progressPercent: null, detail: null },
          { id: "clone", status: "done", progressPercent: 100, detail: null },
          { id: "register", status: "done", progressPercent: null, detail: null },
        ]),
      );
      const done = page.getByTestId("add-project-done");
      await expect.element(done, ELEMENT_WAIT).toMatchTextContent(/codex is on Mac mini/);
      await expect.element(done, ELEMENT_WAIT).toMatchTextContent(/Ready for threads\./);
      await expect
        .element(page.getByTestId("add-project-node-list"), ELEMENT_WAIT)
        .toMatchTextContent(/Mac mini.*~\/Code\/codex.*new/);

      await dialog().getByRole("button", { name: "Show in project selector" }).click();
      await vi.waitFor(() =>
        expect(useProjectNodesDialogStore.getState().addProject.open).toBe(false),
      );
      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "A new thread should open in the cloned project.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hands a clone it runs in the background to the copy runtime, which toasts how it ends", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWith(null),
    });
    try {
      await waitForServerConfigToApply();
      const mini = createMacMiniApi(
        addSavedNode({ environmentId: MINI, label: "Mac mini", projectCopy: true }),
      );
      // The real coordinator, holding the fake node directly (the suite's saved
      // node has no credential to reconnect with).
      setProjectCopyRuntimeForTests({
        startProjectCopy,
        projectCopyPlanWithSendFiles,
        callNodeWithLease,
        callNodeToRead,
        createIo: () =>
          createWebProjectCopyIo({
            acquire: async (environmentId) => ({
              environmentId,
              api: mini.api,
              transport: "direct",
              isCurrent: () => true,
              isConnected: () => true,
              withLease: (call) => call(mini.api),
              release: () => undefined,
            }),
          }),
      });
      openAddProject({ environmentId: MINI, mode: "clone" });
      await expect.element(dialog(), ELEMENT_WAIT).toBeVisible();
      await dialog()
        .getByRole("textbox", { name: "Repository to clone" })
        .fill("git@github.com:openai/codex.git");
      await userEvent.keyboard("{Enter}");
      const clone = dialog().getByRole("button", { name: "Clone to Mac mini" });
      await expect.element(clone, ELEMENT_WAIT).toBeEnabled();
      await clone.click();
      await vi.waitFor(() => expect(mini.importStart).toHaveBeenCalledTimes(1));
      const input = mini.importStart.mock.calls[0]![0];
      await expect
        .element(
          dialog().getByText("This keeps running on Mac mini if you close it."),
          ELEMENT_WAIT,
        )
        .toBeVisible();

      await dialog().getByRole("button", { name: "Run in background" }).click();
      await vi.waitFor(() =>
        expect(useProjectNodesDialogStore.getState().addProject.open).toBe(false),
      );
      // The copy runtime follows the node's import: its progress toast, worded as a clone.
      await expect
        .element(page.getByText("Cloning codex to Mac mini").first(), ELEMENT_WAIT)
        .toBeVisible();
      expect(mini.importStart).toHaveBeenCalledTimes(1);

      mini.emit(
        importSnapshot(input, "completed", [
          { id: "preflight", status: "done", progressPercent: null, detail: null },
          { id: "clone", status: "done", progressPercent: 100, detail: null },
          { id: "register", status: "done", progressPercent: null, detail: null },
        ]),
      );
      await expect
        .element(page.getByText("codex is ready on Mac mini"), ELEMENT_WAIT)
        .toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows every clone provider by its logo, lights a pasted URL's, and sends one that needs setup to Settings", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWith(null),
    });
    try {
      await waitForServerConfigToApply();
      openAddProject({ environmentId: LOCAL_ENVIRONMENT_ID, mode: "clone" });
      await expect.element(dialog(), ELEMENT_WAIT).toBeVisible();
      const sources = dialog().getByRole("group", { name: "Clone source" });
      const chip = (name: RegExp) => sources.getByRole("button", { name });

      // Every source in one order, ready or not; GitHub, the first ready one, is lit.
      await expect.element(chip(/^GitHub$/), ELEMENT_WAIT).toHaveAttribute("aria-pressed", "true");
      await expect.element(chip(/^GitHub$/)).toHaveAttribute("data-active", "");
      expect(
        sources
          .getByRole("button")
          .elements()
          .map((element) => element.getAttribute("data-source")),
      ).toEqual(["github", "gitlab", "forgejo", "bitbucket", "azure-devops", "url"]);
      for (const element of sources.getByRole("button").elements()) {
        expect(element.querySelector("svg")).not.toBeNull();
      }
      const repository = dialog().getByRole("textbox", { name: "Repository to clone" });
      await expect
        .element(repository)
        .toHaveAttribute("placeholder", "owner/repo on GitHub, or paste a Git URL");

      await chip(/^GitLab$/).click();
      await expect.element(chip(/^GitLab$/)).toHaveAttribute("aria-pressed", "true");
      await expect.element(chip(/^GitHub$/)).toHaveAttribute("aria-pressed", "false");
      await expect
        .element(repository)
        .toHaveAttribute("placeholder", "owner/repo on GitLab, or paste a Git URL");

      // A pasted URL lights the provider its host belongs to.
      await repository.fill("https://bitbucket.org/team/app.git");
      await expect.element(chip(/^Bitbucket$/)).toHaveAttribute("aria-pressed", "true");
      await expect.element(chip(/^Bitbucket$/)).toHaveAttribute("data-detected", "");
      await expect.element(chip(/^GitLab$/)).toHaveAttribute("aria-pressed", "false");
      await repository.fill("ssh://git@git.internal/app.git");
      await expect.element(chip(/^Git URL$/)).toHaveAttribute("aria-pressed", "true");

      // A provider the node can't use yet stays visible, says why, and leads to its setup.
      const forgejo = chip(/^Forgejo: Setup Required$/);
      await expect.element(forgejo).not.toHaveAttribute("data-ready");
      expect(forgejo.element().getAttribute("title")).toMatch(/Settings -> Source Control/);
      await forgejo.click();
      await expect
        .element(page.getByText(/isn't set up on this node yet\./))
        .toMatchTextContent(
          /Forgejo isn't set up on this node yet\. Provider status unavailable\./,
        );
      expect(useProjectNodesDialogStore.getState().addProject.open).toBe(true);
      await page.getByRole("menuitem", { name: "Set up in Settings…" }).click();
      await vi.waitFor(() => {
        expect(useProjectNodesDialogStore.getState().addProject.open).toBe(false);
        expect(useSettingsDialogStore.getState()).toMatchObject({
          open: true,
          section: "source-control",
        });
      });
    } finally {
      useSettingsDialogStore.getState().closeSettings();
      await mounted.cleanup();
    }
  });

  it("cancels a clone the node had not answered yet, once it answers", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWith(null),
    });
    try {
      await waitForServerConfigToApply();
      const mini = createMacMiniApi(
        addSavedNode({ environmentId: MINI, label: "Mac mini", projectCopy: true }),
      );
      // The node starts the job, but its answer is still on the way.
      let answer: () => void = () => undefined;
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });
      const startOnNode = mini.importStart.getMockImplementation()!;
      mini.importStart.mockImplementationOnce(async (input) => {
        const started = await startOnNode(input);
        await answered;
        return started;
      });
      openAddProject({ environmentId: MINI, mode: "clone" });
      await expect.element(dialog(), ELEMENT_WAIT).toBeVisible();
      await dialog()
        .getByRole("textbox", { name: "Repository to clone" })
        .fill("git@github.com:openai/codex.git");
      await userEvent.keyboard("{Enter}");
      const clone = dialog().getByRole("button", { name: "Clone to Mac mini" });
      await expect.element(clone, ELEMENT_WAIT).toBeEnabled();
      await clone.click();
      await vi.waitFor(() => expect(mini.importStart).toHaveBeenCalledTimes(1));
      const input = mini.importStart.mock.calls[0]![0];
      await expect
        .element(page.getByTestId("add-project-import-steps"), ELEMENT_WAIT)
        .toMatchTextContent(/Asking Mac mini to start/);

      // Its name gains the spinner's "Loading" while it cancels.
      const cancel = dialog().getByRole("button", { name: /Cancel$/u });
      await cancel.click();
      // Nothing is known to cancel yet: the dialog waits for the node's answer.
      await expect.element(cancel, ELEMENT_WAIT).toBeDisabled();
      expect(mini.cancelImport).not.toHaveBeenCalled();

      answer();
      // The job the node started is cancelled by its id, then the folder step is back.
      await vi.waitFor(() =>
        expect(mini.cancelImport).toHaveBeenCalledWith({ importId: input.importId }),
      );
      await expect
        .element(dialog().getByRole("button", { name: "Clone to Mac mini" }), ELEMENT_WAIT)
        .toBeVisible();
      expect(mini.subscribeImport).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("clones with the node's own clone and adds the project when it lacks project copy", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWith({
        canonicalKey: "github.com/sak0a/ryco",
        remoteUrl: "git@github.com:sak0a/ryco.git",
        name: "ryco",
      }),
    });
    try {
      await waitForServerConfigToApply();
      const mini = createMacMiniApi(
        addSavedNode({ environmentId: MINI, label: "Mac mini", projectCopy: false }),
      );
      openAddProject({ environmentId: MINI, mode: "clone" });
      await expect.element(dialog(), ELEMENT_WAIT).toBeVisible();

      // The user's own repositories are offered, with the nodes that have them.
      const suggestion = dialog()
        .getByRole("group", { name: "Clone a repository" })
        .getByRole("button", { name: /sak0a\/ryco/ });
      await expect.element(suggestion, ELEMENT_WAIT).toMatchTextContent(/also on/);
      await suggestion.click();

      // Without project copy the picker browses from the node's add-project folder.
      await expect
        .element(page.getByTestId("folder-picker-status"), ELEMENT_WAIT)
        .toMatchTextContent(/^~\/ryco\s*Clones github\.com\/sak0a\/ryco here$/);
      await dialog()
        .getByRole("option", { name: /^Code$/ })
        .click();
      await expect
        .element(page.getByTestId("folder-picker-status"), ELEMENT_WAIT)
        .toMatchTextContent(/^\/Users\/me\/Code\/ryco\s*Clones github\.com\/sak0a\/ryco here$/);
      await dialog().getByRole("button", { name: "Clone to Mac mini" }).click();

      await vi.waitFor(() => {
        expect(mini.cloneRepository).toHaveBeenCalledWith({
          remoteUrl: "git@github.com:sak0a/ryco.git",
          destinationPath: "/Users/me/Code/ryco",
        });
        expect(mini.dispatchCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "project.create",
            workspaceRoot: "/Users/me/Code/ryco",
            title: "ryco",
            projectMetadataDir: ".ryco",
            createWorkspaceRootIfMissing: true,
          }),
        );
      });
      expect(mini.importStart).not.toHaveBeenCalled();
      const done = page.getByTestId("add-project-done");
      await expect.element(done, ELEMENT_WAIT).toMatchTextContent(/ryco is on Mac mini/);
      await expect
        .element(done, ELEMENT_WAIT)
        .toMatchTextContent(
          /Same repository as on Studio Mac, so it shows up as one project on 2 nodes\./,
        );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hands a project from another node to the copy dialog", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWith(null),
    });
    try {
      await waitForServerConfigToApply();
      createMacMiniApi(addSavedNode({ environmentId: MINI, label: "Mac mini", projectCopy: true }));
      openAddProject({ environmentId: MINI, mode: "copy" });
      await expect.element(dialog(), ELEMENT_WAIT).toBeVisible();

      const row = dialog()
        .getByRole("group", { name: "Copy from another node" })
        .getByRole("button", { name: /Project/ });
      await expect.element(row, ELEMENT_WAIT).toMatchTextContent(/Studio Mac · \/repo\/project/);
      await row.click();

      await vi.waitFor(() => {
        const state = useProjectNodesDialogStore.getState();
        expect(state.addProject.open).toBe(false);
        expect(state.copyProject).toMatchObject({
          open: true,
          request: {
            source: { environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID },
            targetEnvironmentId: MINI,
            origin: "add-project",
          },
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("links a checkout that is already on the node and shows both nodes", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWith({
        canonicalKey: "github.com/sak0a/cs2inspect-web",
        remoteUrl: "git@github.com:sak0a/cs2inspect-web.git",
        name: "cs2inspect-web",
      }),
    });
    try {
      await waitForServerConfigToApply();
      const mini = createMacMiniApi(
        addSavedNode({ environmentId: MINI, label: "Mac mini", projectCopy: true }),
      );
      openAddProject({
        environmentId: MINI,
        mode: "link",
        projectRef: { environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID },
      });
      await expect.element(dialog(), ELEMENT_WAIT).toBeVisible();

      // The search starts with the repository's name and badges its checkouts.
      await expect
        .element(
          dialog().getByRole("combobox", { name: "Search folders on Mac mini" }),
          ELEMENT_WAIT,
        )
        .toHaveValue("cs2inspect-web");
      const checkout = dialog().getByRole("option", { name: /cs2inspect-web.*same repository/ });
      await expect.element(checkout, ELEMENT_WAIT).toBeVisible();
      await checkout.click();
      await expect
        .element(page.getByTestId("folder-picker-status"), ELEMENT_WAIT)
        .toMatchTextContent(/Same repository, on dev/);
      await dialog().getByRole("button", { name: "Link checkout" }).click();

      await vi.waitFor(() => expect(mini.importStart).toHaveBeenCalledTimes(1));
      const input = mini.importStart.mock.calls[0]![0];
      expect(input).toMatchObject({
        title: "Project",
        destinationPath: "/Users/me/Dropbox/Code/Web/cs2inspect-web",
        source: {
          kind: "existing-checkout",
          expectedCanonicalKey: "github.com/sak0a/cs2inspect-web",
        },
        remotes: [],
      });
      mini.emit(
        importSnapshot(input, "completed", [
          { id: "preflight", status: "done", progressPercent: null, detail: null },
          { id: "register", status: "done", progressPercent: null, detail: null },
        ]),
      );
      const done = page.getByTestId("add-project-done");
      await expect.element(done, ELEMENT_WAIT).toMatchTextContent(/Project is on Mac mini/);
      await expect
        .element(done, ELEMENT_WAIT)
        .toMatchTextContent(
          /Same repository as on Studio Mac, so it shows up as one project on 2 nodes\./,
        );
      await expect
        .element(page.getByTestId("add-project-node-list"), ELEMENT_WAIT)
        .toMatchTextContent(
          /Studio Mac.*\/repo\/project.*Mac mini.*~\/Dropbox\/Code\/Web\/cs2inspect-web.*new/,
        );
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers copying the thread's project to another node in the command palette", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWith(null),
    });
    try {
      await waitForServerConfigToApply();
      const palette = page.getByTestId("command-palette");
      const copyAction = palette.getByRole("option", { name: /Copy Project to another node…/ });
      // One node: nowhere to copy to.
      useCommandPaletteStore.getState().setOpen(true);
      await expect.element(palette, ELEMENT_WAIT).toBeInTheDocument();
      await expect.element(palette.getByText("Add project", { exact: true })).toBeVisible();
      await expect.element(copyAction).not.toBeInTheDocument();
      useCommandPaletteStore.getState().setOpen(false);

      createMacMiniApi(addSavedNode({ environmentId: MINI, label: "Mac mini", projectCopy: true }));
      useCommandPaletteStore.getState().setOpen(true);
      await palette.getByRole("combobox").fill("copy");
      await copyAction.click();
      expect(useProjectNodesDialogStore.getState().copyProject).toMatchObject({
        open: true,
        request: {
          source: { environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID },
          targetEnvironmentId: null,
          origin: "palette",
        },
      });
      expect(useCommandPaletteStore.getState().open).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });
});
