import "../../index.css";

import { scopeProjectRef, scopedProjectKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentApi,
  EnvironmentId,
  ProjectChatError,
  type ProjectChatDestinationStatus,
  ProjectId,
  type ProjectsPromoteChatInput,
  type ProjectsPromoteChatPreviewInput,
  type ProjectsPromoteChatPreviewResult,
  type ProjectsPromoteChatResult,
  ProviderInstanceId,
  type ServerConfig,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  interruptThreadTurn: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => harness.navigate,
  useParams: () => null,
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({ interruptThreadTurn: harness.interruptThreadTurn }),
}));

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary/context";
import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { deriveLogicalProjectKeyFromSettings } from "../../logicalProject";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { selectProjectByRef, useStore } from "../../store";
import { useTerminalStateStore } from "../../terminalStateStore";
import {
  applyAppearancePreferencesToDocument,
  resetAppearancePreference,
  setAppearancePreference,
} from "../../themes/appearancePreferences";
import { useUiStateStore } from "../../uiStateStore";
import { toastManager } from "../ui/toast";
import { ChatHeaderBar } from "./ChatHeaderBar";
import type { ChatProjectTarget } from "./ChatProjectActions";
import { PromoteChatDialog } from "./PromoteChatDialog";
import { closePromoteChatDialog, usePromoteChatDialogStore } from "./promoteChatDialogStore";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CHAT_PROJECT_ID = ProjectId.make("chat-project");
const THREAD_ID = ThreadId.make("thread-chat");
const CHAT_TITLE = "Plan a trip";
const CHAT_FOLDER = "/home/me/.ryco/chats/2026-10-08-plan-a-trip-1a2b3c4d";
const DEFAULT_DESTINATION = "/home/me/Code/plan-a-trip";
const NOW = "2026-10-08T10:00:00.000Z";

const CHAT_TARGET: ChatProjectTarget = {
  projectRef: scopeProjectRef(ENVIRONMENT_ID, CHAT_PROJECT_ID),
  threadRef: scopeThreadRef(ENVIRONMENT_ID, THREAD_ID),
  title: CHAT_TITLE,
  folderPath: CHAT_FOLDER,
};

interface PreviewOptions {
  readonly busyThreadIds?: ReadonlyArray<ThreadId>;
  readonly gitIdentityConfigured?: boolean;
  readonly taken?: ReadonlySet<string>;
  /** Any other verdict for a specific destination. */
  readonly statuses?: ReadonlyMap<string, ProjectChatDestinationStatus>;
}

let previewOptions: PreviewOptions = {};
const previewChat = vi.fn(
  async (input: ProjectsPromoteChatPreviewInput): Promise<ProjectsPromoteChatPreviewResult> => {
    const destination = input.destination ?? DEFAULT_DESTINATION;
    return {
      projectId: input.projectId,
      source: CHAT_FOLDER,
      defaultDestination: DEFAULT_DESTINATION,
      destination,
      destinationStatus:
        previewOptions.statuses?.get(destination) ??
        (previewOptions.taken?.has(destination) ? "exists" : "available"),
      fileCount: 12,
      totalBytes: 3 * 1024 * 1024,
      countTruncated: false,
      busyThreadIds: [...(previewOptions.busyThreadIds ?? [])],
      gitAvailable: true,
      gitIdentityConfigured: previewOptions.gitIdentityConfigured ?? true,
      crossDevice: false,
    };
  },
);
const promoteChat =
  vi.fn<(input: ProjectsPromoteChatInput) => Promise<ProjectsPromoteChatResult>>();

function serverConfig(): ServerConfig {
  return {
    environment: {
      environmentId: ENVIRONMENT_ID,
      label: "Studio Mac",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        threadPriorityRanking: false,
      },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "ryco_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
    chats: { available: true, root: "/home/me/.ryco/chats" },
  };
}

function seedChatProject(input: {
  kind: "chat" | "project";
  workspaceRoot: string;
  /** Seeds the chat's thread; "running" gives it a working agent. */
  thread?: "idle" | "running";
}): void {
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
  useStore.getState().syncServerShellSnapshot(
    {
      snapshotSequence: input.kind === "chat" ? 1 : 2,
      projects: [
        {
          id: CHAT_PROJECT_ID,
          title: CHAT_TITLE,
          workspaceRoot: input.workspaceRoot,
          kind: input.kind,
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: NOW,
          updatedAt: input.kind === "chat" ? NOW : "2026-10-08T10:05:00.000Z",
        },
      ],
      threads: input.thread
        ? [
            {
              id: THREAD_ID,
              projectId: CHAT_PROJECT_ID,
              title: CHAT_TITLE,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              latestTurn: null,
              goal: null,
              createdAt: NOW,
              updatedAt: NOW,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              session:
                input.thread === "running"
                  ? {
                      threadId: THREAD_ID,
                      status: "running",
                      providerName: "codex",
                      runtimeMode: "full-access",
                      activeTurnId: TurnId.make("turn-running"),
                      lastError: null,
                      updatedAt: NOW,
                    }
                  : null,
              latestUserMessageAt: NOW,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
            },
          ]
        : [],
      updatedAt: NOW,
    },
    ENVIRONMENT_ID,
  );
}

function Harness() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <ChatHeaderBar
        projectName="No project"
        isGitRepo
        chatProject={CHAT_TARGET}
        worktreeBranch={null}
        worktreeTitle={null}
        worktreeOrigin={null}
        sessionTitle={CHAT_TITLE}
      />
      {/* Stands in for the sidebar row the promoted project lands in. */}
      <div
        data-sidebar-project-members={scopedProjectKey(CHAT_TARGET.projectRef)}
        className="h-8 w-48 rounded-md border"
      >
        Project row
      </div>
      <PromoteChatDialog />
    </div>
  );
}

function dialog() {
  return page.getByTestId("promote-chat-dialog");
}

async function openFromHeader(): Promise<void> {
  await page.getByTestId("chat-header-promote").click();
  await expect.element(dialog()).toBeVisible();
  await expect.element(page.getByTestId("promote-chat-location")).toHaveValue(DEFAULT_DESTINATION);
}

function submitButton() {
  return page.getByTestId("promote-chat-submit");
}

describe("PromoteChatDialog", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  beforeEach(async () => {
    // A desktop-tier viewport: the frozen web phone tier offers no promotion.
    await page.viewport(1200, 900);
    syncDocumentPresentationTier();
    localStorage.clear();
    previewOptions = {};
    previewChat.mockClear();
    promoteChat.mockReset();
    harness.navigate.mockClear();
    harness.interruptThreadTurn.mockClear();
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    useUiStateStore.setState({ projectExpandedById: {} });
    useTerminalStateStore.setState({ terminalStateByThreadKey: {} });
    usePromoteChatDialogStore.setState({ open: false, token: 0, request: null, origin: null });
    const config = serverConfig();
    writePrimaryEnvironmentDescriptor({ ...config.environment });
    setServerConfigSnapshot(config);
    seedChatProject({ kind: "chat", workspaceRoot: CHAT_FOLDER });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      projects: { promoteChatPreview: previewChat, promoteChat },
    } as unknown as EnvironmentApi);
    mounted = await render(
      <AppAtomRegistryProvider>
        <Harness />
      </AppAtomRegistryProvider>,
    );
  });

  afterEach(async () => {
    closePromoteChatDialog();
    await mounted?.unmount();
    mounted = null;
    resetAppearancePreference("motion");
    applyAppearancePreferencesToDocument();
    resetPrimaryEnvironmentDescriptorForTests();
    resetServerStateForTests();
    __resetEnvironmentApiOverridesForTests();
    document.body.innerHTML = "";
  });

  it("opens from the header with the preview's defaults and explains the move", async () => {
    await openFromHeader();

    await expect
      .element(page.getByRole("heading", { name: "Turn this chat into a project" }))
      .toBeVisible();
    await expect.element(page.getByTestId("promote-chat-name")).toHaveValue(CHAT_TITLE);
    await expect
      .element(page.getByTestId("promote-chat-location-status"))
      .toHaveAttribute("data-state", "available");
    await expect.element(page.getByText("Folder is available")).toBeVisible();
    await expect
      .element(page.getByTestId("promote-chat-move-plan"))
      .toHaveTextContent("Move 12 files (3.0 MB)");
    await expect.element(page.getByText("Your conversation stays attached")).toBeVisible();
    expect(previewChat).toHaveBeenCalledWith({ projectId: CHAT_PROJECT_ID });

    // Git is on by default, with an initial commit and a .gitignore.
    await expect.element(page.getByTestId("promote-chat-initialize-git")).toBeChecked();
    await expect.element(page.getByTestId("promote-chat-initial-commit")).toBeChecked();
    await expect.element(page.getByTestId("promote-chat-gitignore")).toBeChecked();
    await expect.element(submitButton()).not.toHaveAttribute("aria-disabled");
    await expect.element(submitButton()).toHaveFocus();
  });

  it("offers no promotion on a node that does not host chats", async () => {
    const { chats: _chats, ...withoutChats } = serverConfig();
    setServerConfigSnapshot(withoutChats);

    await expect.element(page.getByTestId("chat-header-reveal-folder")).toBeVisible();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="chat-header-promote"]')).toBeNull(),
    );
    // The header never falls back to "No Git" for a chat.
    expect(document.body.textContent).not.toContain("No Git");
  });

  it("cancels with Escape and submits with Enter", async () => {
    await openFromHeader();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(usePromoteChatDialogStore.getState().open).toBe(false));
    expect(promoteChat).not.toHaveBeenCalled();

    promoteChat.mockImplementation(async () => {
      seedChatProject({ kind: "project", workspaceRoot: DEFAULT_DESTINATION });
      return {
        projectId: CHAT_PROJECT_ID,
        workspaceRoot: DEFAULT_DESTINATION,
        gitInitialized: true,
        initialCommitCreated: true,
      };
    });
    await openFromHeader();
    await page.getByTestId("promote-chat-name").click();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(promoteChat).toHaveBeenCalledOnce());
    await expect
      .element(page.getByTestId("promote-step-move"))
      .toHaveAttribute("data-status", "done");
  });

  it("renames the folder with the project and checks the new location", async () => {
    await openFromHeader();
    await page.getByTestId("promote-chat-name").fill("Paris itinerary");

    await expect
      .element(page.getByTestId("promote-chat-location"))
      .toHaveValue("/home/me/Code/paris-itinerary");
    await vi.waitFor(() =>
      expect(previewChat).toHaveBeenCalledWith({
        projectId: CHAT_PROJECT_ID,
        destination: "/home/me/Code/paris-itinerary",
      }),
    );
  });

  it("explains a taken location and offers the next free name", async () => {
    previewOptions = { taken: new Set(["/home/me/Code/trip"]) };
    await openFromHeader();
    await page.getByTestId("promote-chat-location").fill("/home/me/Code/trip");

    await expect.element(page.getByText("A folder already exists here")).toBeVisible();
    await expect.element(submitButton()).toHaveAttribute("aria-disabled", "true");
    const suggestion = page.getByTestId("promote-chat-use-suggestion");
    await expect.element(suggestion).toHaveTextContent("Use trip-2");
    await suggestion.click();
    await expect
      .element(page.getByTestId("promote-chat-location"))
      .toHaveValue("/home/me/Code/trip-2");
    await expect.element(page.getByText("Folder is available")).toBeVisible();
  });

  it("keeps a busy chat in place until the agent stops", async () => {
    seedChatProject({ kind: "chat", workspaceRoot: CHAT_FOLDER, thread: "running" });
    previewOptions = { busyThreadIds: [THREAD_ID] };
    await openFromHeader();

    await expect.element(page.getByTestId("promote-chat-busy")).toBeVisible();
    await expect
      .element(page.getByText("Wait for the agent to finish (or stop it) before moving the chat."))
      .toBeVisible();
    await expect.element(submitButton()).toHaveAttribute("aria-disabled", "true");
    // Enter in a field does not submit a busy chat.
    await page.getByTestId("promote-chat-name").click();
    await userEvent.keyboard("{Enter}");
    expect(promoteChat).not.toHaveBeenCalled();

    previewOptions = {};
    await page.getByRole("button", { name: "Stop the agent" }).click();
    await vi.waitFor(() =>
      expect(harness.interruptThreadTurn).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
      }),
    );
    // The re-check clears the notice once the agent is idle.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="promote-chat-busy"]')).toBeNull(),
    );
    await expect.element(submitButton()).not.toHaveAttribute("aria-disabled");
  });

  it("names a running terminal command and checks again once it ends", async () => {
    seedChatProject({ kind: "chat", workspaceRoot: CHAT_FOLDER, thread: "idle" });
    const terminals = useTerminalStateStore.getState();
    terminals.ensureTerminal(CHAT_TARGET.threadRef!, "default");
    terminals.setTerminalActivity(CHAT_TARGET.threadRef!, "default", true);
    previewOptions = { busyThreadIds: [THREAD_ID] };
    await openFromHeader();

    const notice = page.getByTestId("promote-chat-busy");
    await expect.element(notice).toBeVisible();
    await expect
      .element(notice)
      .toHaveTextContent("A terminal is still running a command in this chat");
    // Interrupting the agent cannot end a terminal command.
    expect(document.querySelector('[data-testid="promote-chat-busy"]')?.textContent).not.toContain(
      "Stop the agent",
    );
    await expect.element(submitButton()).toHaveAttribute("aria-disabled", "true");

    // The command ends: the dialog re-checks by itself.
    previewOptions = {};
    const previewsBefore = previewChat.mock.calls.length;
    useTerminalStateStore.getState().setTerminalActivity(CHAT_TARGET.threadRef!, "default", false);
    await vi.waitFor(() => expect(previewChat.mock.calls.length).toBeGreaterThan(previewsBefore));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="promote-chat-busy"]')).toBeNull(),
    );
    await expect.element(submitButton()).not.toHaveAttribute("aria-disabled");
    expect(harness.interruptThreadTurn).not.toHaveBeenCalled();
  });

  it("offers a manual check for busy work it cannot see", async () => {
    seedChatProject({ kind: "chat", workspaceRoot: CHAT_FOLDER, thread: "idle" });
    previewOptions = { busyThreadIds: [THREAD_ID] };
    await openFromHeader();

    await expect
      .element(page.getByTestId("promote-chat-busy"))
      .toHaveTextContent("This chat is still busy");
    previewOptions = {};
    await page.getByRole("button", { name: "Check again" }).click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="promote-chat-busy"]')).toBeNull(),
    );
    await expect.element(submitButton()).not.toHaveAttribute("aria-disabled");
    expect(harness.interruptThreadTurn).not.toHaveBeenCalled();
  });

  it("explains a missing Git identity with copyable commands", async () => {
    previewOptions = { gitIdentityConfigured: false };
    await openFromHeader();

    const notice = page.getByTestId("promote-chat-identity-notice");
    await expect.element(notice).toBeVisible();
    await expect.element(notice).toHaveTextContent('git config --global user.name "Your Name"');
    await expect
      .element(notice)
      .toHaveTextContent("git config --global user.email you@example.com");

    // Without an initial commit there is nothing to warn about.
    await page.getByTestId("promote-chat-initial-commit").click();
    await vi.waitFor(() =>
      expect(
        document
          .querySelector('[data-testid="promote-chat-identity-notice"]')
          ?.closest("[aria-hidden]"),
      ).not.toBeNull(),
    );
  });

  it("promotes with the chosen options, reveals each step and folds into the project", async () => {
    const addToast = vi.spyOn(toastManager, "add");
    let resolvePromotion: ((result: ProjectsPromoteChatResult) => void) | null = null;
    promoteChat.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePromotion = resolve;
        }),
    );
    await openFromHeader();
    await page.getByTestId("promote-chat-gitignore").click();
    await submitButton().click();

    await vi.waitFor(() => expect(promoteChat).toHaveBeenCalledOnce());
    expect(promoteChat).toHaveBeenCalledWith({
      projectId: CHAT_PROJECT_ID,
      expectedUpdatedAt: NOW,
      title: CHAT_TITLE,
      destination: DEFAULT_DESTINATION,
      initializeGit: true,
      initialCommit: true,
      writeGitignore: false,
    });
    // One honest step runs while the request is in flight.
    await expect
      .element(page.getByTestId("promote-step-move"))
      .toHaveAttribute("data-status", "running");
    await expect
      .element(page.getByTestId("promote-step-git-init"))
      .toHaveAttribute("data-status", "pending");

    seedChatProject({ kind: "project", workspaceRoot: DEFAULT_DESTINATION });
    const projectKey = deriveLogicalProjectKeyFromSettings(
      selectProjectByRef(useStore.getState(), CHAT_TARGET.projectRef)!,
      {
        sidebarProjectGroupingMode: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingMode,
        sidebarProjectGroupingOverrides: {},
      },
    );
    useUiStateStore.setState({ projectExpandedById: { [projectKey]: false } });
    resolvePromotion!({
      projectId: CHAT_PROJECT_ID,
      workspaceRoot: DEFAULT_DESTINATION,
      gitInitialized: true,
      initialCommitCreated: true,
    });

    for (const step of ["move", "git-init", "initial-commit"]) {
      await expect
        .element(page.getByTestId(`promote-step-${step}`))
        .toHaveAttribute("data-status", "done");
    }
    await expect
      .element(page.getByTestId("promote-step-move"))
      .toHaveTextContent(DEFAULT_DESTINATION);
    await expect.element(page.getByTestId("promote-chat-done")).toHaveFocus();

    // A clean result folds away by itself and points at the new project.
    await vi.waitFor(() => expect(usePromoteChatDialogStore.getState().open).toBe(false), {
      timeout: 5_000,
    });
    expect(harness.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
    });
    // The new project opens in the sidebar so its thread is in view.
    expect(useUiStateStore.getState().projectExpandedById[projectKey]).toBe(true);
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Chat is now a project" }),
    );
    addToast.mockRestore();
  });

  it("stays open to show a skipped commit and how to fix it", async () => {
    previewOptions = { gitIdentityConfigured: false };
    promoteChat.mockImplementation(async () => {
      seedChatProject({ kind: "project", workspaceRoot: DEFAULT_DESTINATION });
      return {
        projectId: CHAT_PROJECT_ID,
        workspaceRoot: DEFAULT_DESTINATION,
        gitInitialized: true,
        initialCommitCreated: false,
        commitError: "Author identity unknown",
      };
    });
    await openFromHeader();
    await submitButton().click();

    const commit = page.getByTestId("promote-step-initial-commit");
    await expect.element(commit).toHaveAttribute("data-status", "warning");
    await expect.element(commit).toHaveTextContent("Author identity unknown");
    await expect.element(page.getByTestId("promote-chat-identity-notice")).toBeVisible();
    // Warnings wait for the user.
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    expect(usePromoteChatDialogStore.getState().open).toBe(true);

    await page.getByTestId("promote-chat-done").click();
    await vi.waitFor(() => expect(usePromoteChatDialogStore.getState().open).toBe(false));
  });

  it("keeps the dialog open with a friendly reason when the server refuses", async () => {
    promoteChat.mockRejectedValueOnce(
      new ProjectChatError({
        reason: "stale",
        message: "This chat changed while it was being moved.",
      }),
    );
    await openFromHeader();
    await submitButton().click();

    const error = page.getByTestId("promote-chat-error");
    await expect.element(error).toHaveAttribute("data-reason", "stale");
    await expect.element(error).toHaveTextContent("This chat changed while the dialog was open");
    expect(usePromoteChatDialogStore.getState().open).toBe(true);
    // The preview is read again so the next attempt uses fresh state.
    await vi.waitFor(() => expect(previewChat.mock.calls.length).toBeGreaterThanOrEqual(2));

    promoteChat.mockRejectedValueOnce(
      new ProjectChatError({
        reason: "destination-exists",
        message: "Something already exists at that location.",
      }),
    );
    await submitButton().click();
    await expect
      .element(page.getByTestId("promote-chat-error"))
      .toHaveTextContent("That folder already exists");
  });

  it("refuses a location inside the chat's own folder and sends the user back to it", async () => {
    const inside = `${CHAT_FOLDER}/project`;
    previewOptions = { statuses: new Map([[inside, "inside-source"]]) };
    await openFromHeader();
    await page.getByTestId("promote-chat-location").fill(inside);

    const status = page.getByTestId("promote-chat-location-status");
    await expect.element(status).toHaveAttribute("data-state", "inside-source");
    await expect
      .element(status)
      .toHaveTextContent("Inside this chat's own folder. Choose a location outside it");
    await expect.element(submitButton()).toHaveAttribute("aria-disabled", "true");

    // The server can still refuse a location the preview allowed (a symlink, a
    // race): the alert explains it, the status line re-judges the location.
    await page.getByTestId("promote-chat-location").fill(DEFAULT_DESTINATION);
    await expect.element(status).toHaveAttribute("data-state", "available");
    promoteChat.mockImplementationOnce(async () => {
      previewOptions = { statuses: new Map([[DEFAULT_DESTINATION, "inside-source"]]) };
      throw new ProjectChatError({
        reason: "destination-inside-source",
        message: "The destination is inside the chat folder.",
      });
    });
    await submitButton().click();

    const error = page.getByTestId("promote-chat-error");
    await expect.element(error).toHaveAttribute("data-reason", "destination-inside-source");
    await expect.element(error).toHaveTextContent("That location is inside this chat's folder");
    await expect
      .element(error)
      .toHaveTextContent("A chat can't move into its own folder. Choose a location outside it.");
    await expect.element(page.getByTestId("promote-chat-location")).toHaveFocus();
    await expect.element(status).toHaveAttribute("data-state", "inside-source");
    await expect.element(submitButton()).toHaveAttribute("aria-disabled", "true");

    // Another location is judged on its own; the refusal no longer applies.
    previewOptions = {};
    await page.getByTestId("promote-chat-location").fill("/home/me/Code/trip");
    await expect.element(status).toHaveAttribute("data-state", "available");
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="promote-chat-error"]')).toBeNull(),
    );
    await expect.element(submitButton()).not.toHaveAttribute("aria-disabled");
  });

  it("closes a chat that no longer exists with only a Close button", async () => {
    previewChat.mockRejectedValueOnce(
      new ProjectChatError({ reason: "not-found", message: "This chat no longer exists." }),
    );
    await page.getByTestId("chat-header-promote").click();

    await expect
      .element(page.getByTestId("promote-chat-error"))
      .toHaveTextContent("This chat no longer exists");
    expect(document.querySelector('[data-testid="promote-chat-submit"]')).toBeNull();
    await expect.element(page.getByTestId("promote-chat-cancel")).toHaveTextContent("Close");
    await page.getByTestId("promote-chat-cancel").click();
    await vi.waitFor(() => expect(usePromoteChatDialogStore.getState().open).toBe(false));
  });

  it("works with reduced motion: no morph ghost and instant step reveals", async () => {
    setAppearancePreference("motion", "reduce");
    applyAppearancePreferencesToDocument();
    promoteChat.mockImplementation(async () => {
      seedChatProject({ kind: "project", workspaceRoot: DEFAULT_DESTINATION });
      return {
        projectId: CHAT_PROJECT_ID,
        workspaceRoot: DEFAULT_DESTINATION,
        gitInitialized: true,
        initialCommitCreated: true,
      };
    });
    await openFromHeader();
    expect(document.querySelector('[data-slot="morph-ghost"]')).toBeNull();

    await submitButton().click();
    const glyph = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-testid="promote-step-initial-commit"][data-status="done"] > span',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    expect(getComputedStyle(glyph).animationDuration).toBe("0s");
    await page.getByTestId("promote-chat-done").click();
    await vi.waitFor(() => expect(usePromoteChatDialogStore.getState().open).toBe(false));
  });
});
