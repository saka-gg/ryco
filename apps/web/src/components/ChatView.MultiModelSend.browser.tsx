import { createMultiModelSendTracker } from "@ryco/client-runtime/state/composer";
import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  ProviderInstanceId,
  type EnvironmentApi,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { setGitStatusForTests } from "../../test/gitStatusStateMock";
import { WsRpcFailure, type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";
import { paneLeaves } from "../chatPanes.logic";
import { useChatPanesStore } from "../chatPanesStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  addMultiModelSend,
  readMultiModelSelection,
  readMultiModelSends,
  setMultiModelSelection,
  useMultiModelSendStore,
} from "./chat/multiModelSendStore";
import {
  setupChatViewBrowserSuite,
  configureContextHandoffProviders,
  createDraftOnlySnapshot,
  findComposerProviderModelPicker,
  fixture,
  LOCAL_ENVIRONMENT_ID,
  mountChatView,
  NOW_ISO,
  PROJECT_DRAFT_KEY,
  PROJECT_ID,
  THREAD_ID,
  WIDE_FOOTER_VIEWPORT,
  waitForElement,
  waitForLayout,
  wsRequests,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const DRAFT_ID = DraftId.make("draft-compare-models");
const GPT = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5");
const SONNET = createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-sonnet-4-6");

const REPO_STATUS = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
} as const;

type TurnStartRequest = NormalizedWsRpcRequestBody & {
  readonly type?: string;
  readonly threadId?: string;
  readonly modelSelection?: { readonly instanceId?: string; readonly model?: string };
  readonly message?: { readonly text?: string };
  readonly bootstrap?: {
    readonly requireWorktree?: boolean;
    readonly createThread?: { readonly projectId?: string };
    readonly prepareWorktree?: { readonly baseBranch?: string; readonly branch?: string };
  };
};

function seedWorktreeDraft(): void {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {
      [DRAFT_ID]: {
        threadId: THREAD_ID,
        environmentId: LOCAL_ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        logicalProjectKey: PROJECT_DRAFT_KEY,
        createdAt: NOW_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        envMode: "worktree",
      },
    },
    logicalProjectDraftThreadKeyByLogicalProjectKey: { [PROJECT_DRAFT_KEY]: DRAFT_ID },
  });
}

async function mountCompareDraft(options: {
  readonly requiredWorktreeBootstrap?: boolean;
  readonly answer?: (request: TurnStartRequest) => unknown;
}) {
  setGitStatusForTests(REPO_STATUS);
  useMultiModelSendStore.setState({ byDraftId: {} });
  useChatPanesStore.setState({ root: null, activeRef: null });
  seedWorktreeDraft();
  return mountChatView({
    viewport: WIDE_FOOTER_VIEWPORT,
    snapshot: createDraftOnlySnapshot(),
    initialPath: `/draft/${DRAFT_ID}`,
    configureFixture: (nextFixture) => {
      configureContextHandoffProviders(nextFixture);
      nextFixture.serverConfig = {
        ...nextFixture.serverConfig,
        environment: {
          ...nextFixture.serverConfig.environment,
          capabilities: {
            ...nextFixture.serverConfig.environment.capabilities,
            requiredWorktreeBootstrap: options.requiredWorktreeBootstrap ?? true,
          },
        },
      };
    },
    resolveRpc: (body) => {
      if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) return undefined;
      return (
        options.answer?.(body as TurnStartRequest) ?? {
          sequence: fixture.snapshot.snapshotSequence + 1,
        }
      );
    },
  });
}

function turnStarts(): TurnStartRequest[] {
  return (wsRequests as TurnStartRequest[]).filter(
    (request) =>
      request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
      request.type === "thread.turn.start",
  );
}

const sendButton = () =>
  waitForElement(
    () =>
      document.querySelector<HTMLButtonElement>('button[type="submit"][data-send-target-count]'),
    "Unable to find the compare send button.",
  );
const confirmDialog = () =>
  document.querySelector<HTMLElement>('[data-testid="multi-model-send-confirm"]');
const bannerTargets = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-multi-model-target]")).map(
    (row) => row.dataset.status,
  );

async function sendThroughConfirmation(models = "2 models"): Promise<void> {
  const button = await sendButton();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  button.click();
  const dialog = await waitForElement(confirmDialog, "The compare confirmation did not open.");
  expect(dialog.textContent).toContain(`Send to ${models}?`);
  expect(dialog.textContent).toContain("origin/main");
  await page
    .getByRole("button", { name: `Send to ${models}`, exact: true })
    .last()
    .click();
  await vi.waitFor(() => expect(confirmDialog()).toBeNull());
}

/**
 * A send whose Sonnet answer was lost on another connection: GPT started,
 * Sonnet is not confirmed.
 */
async function seedSendWithUnconfirmedSonnet() {
  const tracker = createMultiModelSendTracker({
    draftId: DRAFT_ID,
    submissionId: "submission-1",
    projectId: PROJECT_ID,
    projectCwd: "/repo/project",
    baseBranch: "origin/main",
    title: "Compare this",
    runtimeMode: "full-access",
    tokenMode: "balanced",
    turnAttachments: [],
    sourceControlContexts: [],
    createdAt: NOW_ISO,
    targets: [GPT, SONNET].map((modelSelection) => ({
      modelSelection,
      outgoingMessageText: "Compare this",
      interactionMode: "default" as const,
    })),
  });
  const lostApi = {
    orchestration: {
      dispatchCommand: async (command: { readonly modelSelection?: { instanceId: string } }) => {
        if (command.modelSelection?.instanceId === "claudeAgent") {
          throw new Error("Socket closed");
        }
        return { sequence: 1 };
      },
    },
  } as unknown as EnvironmentApi;
  await tracker.send({ api: lostApi });
  addMultiModelSend(DRAFT_ID, {
    tracker,
    environmentId: LOCAL_ENVIRONMENT_ID,
    sending: false,
    content: { prompt: "Compare this", images: [], terminalContexts: [], fileReferences: [] },
  });
  return tracker;
}

describe("ChatView compare models (full app)", () => {
  setupChatViewBrowserSuite();

  it("offers Compare models in a new draft of a Git project, on a node that isolates each model", async () => {
    const mounted = await mountCompareDraft({});
    try {
      const picker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find the composer's model picker.",
      );
      picker.click();
      await waitForElement(
        () => document.querySelector('[data-slot="model-picker-compare"]'),
        "The picker offers no Compare models switch.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps single selection on a node that cannot require a worktree", async () => {
    const mounted = await mountCompareDraft({ requiredWorktreeBootstrap: false });
    try {
      const picker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find the composer's model picker.",
      );
      picker.click();
      await waitForElement(
        () => document.querySelector(".model-picker-list"),
        "The model picker did not open.",
      );
      expect(document.querySelector('[data-slot="model-picker-compare"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends one prompt to each chosen model after a confirmation and stays in the composer", async () => {
    const mounted = await mountCompareDraft({});
    try {
      setMultiModelSelection(DRAFT_ID, { enabled: true, selections: [GPT, SONNET] });
      useComposerDraftStore.getState().setPrompt(DRAFT_ID, "Compare this");
      const button = await sendButton();
      expect(button.getAttribute("aria-label")).toBe("Send to 2 models");

      // Cancelling sends nothing and keeps the prompt.
      await vi.waitFor(() => expect(button.disabled).toBe(false));
      button.click();
      await waitForElement(confirmDialog, "The compare confirmation did not open.");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await vi.waitFor(() => expect(confirmDialog()).toBeNull());
      expect(turnStarts()).toHaveLength(0);

      await sendThroughConfirmation();
      await vi.waitFor(() => expect(turnStarts()).toHaveLength(2), { timeout: 8_000 });
      const starts = turnStarts();
      expect(new Set(starts.map((request) => request.threadId)).size).toBe(2);
      expect(starts.every((request) => request.threadId !== THREAD_ID)).toBe(true);
      expect(starts.map((request) => request.modelSelection?.model).toSorted()).toEqual([
        "claude-sonnet-4-6",
        "gpt-5",
      ]);
      expect(new Set(starts.map((request) => request.message?.text))).toEqual(
        new Set(["Compare this"]),
      );
      for (const request of starts) {
        expect(request.bootstrap).toMatchObject({
          requireWorktree: true,
          createThread: { projectId: PROJECT_ID },
          prepareWorktree: { baseBranch: "origin/main" },
        });
      }

      // The user stays in the cleared draft, comparing is off, and both threads open side by side.
      await vi.waitFor(() => expect(document.body.textContent).toContain("Started 2 threads"));
      expect(mounted.router.state.location.pathname).toBe(`/draft/${DRAFT_ID}`);
      expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt ?? "").toBe("");
      expect(readMultiModelSelection(DRAFT_ID).enabled).toBe(false);
      expect(bannerTargets()).toEqual(["started", "started"]);
      await page.getByRole("button", { name: "Open side by side", exact: true }).click();
      await vi.waitFor(() =>
        expect(paneLeaves(useChatPanesStore.getState().root!).map((ref) => ref.threadId)).toEqual(
          starts.map((request) => request.threadId),
        ),
      );
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(
          `/${LOCAL_ENVIRONMENT_ID}/${starts[0]!.threadId}`,
        ),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a model whose answer was lost unconfirmed and never resends it on its own", async () => {
    let claudeCalls = 0;
    const mounted = await mountCompareDraft({
      answer: (request) => {
        if (request.modelSelection?.instanceId !== "claudeAgent") return undefined;
        claudeCalls += 1;
        // The answer is lost with the connection: the client cannot tell whether it ran.
        return Promise.reject(new Error("Socket closed"));
      },
    });
    try {
      setMultiModelSelection(DRAFT_ID, { enabled: true, selections: [GPT, SONNET] });
      useComposerDraftStore.getState().setPrompt(DRAFT_ID, "Compare this");
      await sendThroughConfirmation();

      await vi.waitFor(() => expect(bannerTargets()).toEqual(["started", "uncertain"]), {
        timeout: 8_000,
      });
      // It may have started: the prompt is not put back, and comparing is off.
      expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt ?? "").toBe("");
      expect(readMultiModelSelection(DRAFT_ID).enabled).toBe(false);
      // A retry that cannot go out (the connection is gone) sends nothing and says so.
      await page.getByRole("button", { name: "Retry Sonnet 4.6", exact: true }).click();
      await expect.element(page.getByText("Still not confirmed")).toBeInTheDocument();
      expect(claudeCalls).toBe(1);
      expect(bannerTargets()).toEqual(["started", "uncertain"]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("retries an unconfirmed model with the identical command, so it cannot start twice", async () => {
    const mounted = await mountCompareDraft({});
    try {
      const tracker = await seedSendWithUnconfirmedSonnet();
      const plan = tracker.read().targets[1]!.plan;

      await vi.waitFor(() => expect(bannerTargets()).toEqual(["started", "uncertain"]));
      await page.getByRole("button", { name: "Retry Sonnet 4.6", exact: true }).click();
      await vi.waitFor(() => expect(bannerTargets()).toEqual(["started", "started"]));
      const retried = turnStarts() as Array<TurnStartRequest & { readonly commandId?: string }>;
      expect(retried).toHaveLength(1);
      expect(retried[0]).toMatchObject({ threadId: plan.threadId, commandId: plan.commandId });
      await vi.waitFor(() => expect(document.body.textContent).toContain("Started 2 threads"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("puts the prompt back and keeps only the model the node did not create", async () => {
    const mounted = await mountCompareDraft({
      answer: (request) =>
        request.modelSelection?.instanceId === "claudeAgent"
          ? new WsRpcFailure(
              new OrchestrationDispatchCommandError({ message: "Worktree setup failed." }),
            )
          : undefined,
    });
    try {
      setMultiModelSelection(DRAFT_ID, { enabled: true, selections: [GPT, SONNET] });
      useComposerDraftStore.getState().setPrompt(DRAFT_ID, "Compare this");
      await sendThroughConfirmation();

      await vi.waitFor(() => expect(document.body.textContent).toContain("1 of 2 started"), {
        timeout: 8_000,
      });
      expect(bannerTargets()).toEqual(["started", "not-created"]);
      await vi.waitFor(() =>
        expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toBe(
          "Compare this",
        ),
      );
      const selection = readMultiModelSelection(DRAFT_ID);
      expect(selection.retry).toBe(true);
      expect(selection.selections.map((entry) => entry.model)).toEqual(["claude-sonnet-4-6"]);
      await waitForLayout();
      // One model is enough to retry what did not start.
      expect((await sendButton()).getAttribute("aria-label")).toBe("Send to 1 model");
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets a model whose retry the node refused be sent again as new", async () => {
    const mounted = await mountCompareDraft({
      // The first attempt stopped halfway on the node: the identical command
      // fails on the branch it left.
      answer: (request) =>
        request.modelSelection?.instanceId === "claudeAgent"
          ? new WsRpcFailure(
              new OrchestrationDispatchCommandError({
                message: "fatal: a branch named 'ryco/1a2b3c4d' already exists",
              }),
            )
          : undefined,
    });
    try {
      const tracker = await seedSendWithUnconfirmedSonnet();
      await vi.waitFor(() => expect(bannerTargets()).toEqual(["started", "uncertain"]));
      expect(document.querySelector('[aria-label="Send Sonnet 4.6 as new"]')).toBeNull();

      await page.getByRole("button", { name: "Retry Sonnet 4.6", exact: true }).click();
      await expect.element(page.getByText("Ryco refused the retry")).toBeInTheDocument();
      expect(bannerTargets()).toEqual(["started", "uncertain"]);
      await page.getByRole("button", { name: "Send Sonnet 4.6 as new", exact: true }).click();

      // The prompt is back with only that model, as a new send would retry it.
      await vi.waitFor(() =>
        expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toBe(
          "Compare this",
        ),
      );
      const selection = readMultiModelSelection(DRAFT_ID);
      expect(selection.retry).toBe(true);
      expect(selection.selections.map((entry) => entry.model)).toEqual(["claude-sonnet-4-6"]);
      // The old attempt leaves the notice and is never sent again.
      await vi.waitFor(() => expect(bannerTargets()).toEqual(["started"]));
      expect(tracker.read().targets).toHaveLength(1);
      expect(turnStarts()).toHaveLength(1);
      await waitForLayout();
      expect((await sendButton()).getAttribute("aria-label")).toBe("Send to 1 model");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps an unconfirmed model's notice when the draft sends again", async () => {
    const mounted = await mountCompareDraft({});
    try {
      const earlier = await seedSendWithUnconfirmedSonnet();
      await vi.waitFor(() => expect(bannerTargets()).toEqual(["started", "uncertain"]));

      setMultiModelSelection(DRAFT_ID, { enabled: true, selections: [GPT, SONNET] });
      useComposerDraftStore.getState().setPrompt(DRAFT_ID, "Compare that");
      await sendThroughConfirmation();
      await vi.waitFor(() => expect(turnStarts()).toHaveLength(2), { timeout: 8_000 });

      // The new send's notice leads; the earlier one, with its unconfirmed
      // model, stays behind it instead of being replaced.
      await vi.waitFor(() =>
        expect(bannerTargets()).toEqual(["started", "started", "started", "uncertain"]),
      );
      const sends = readMultiModelSends(DRAFT_ID);
      expect(sends).toHaveLength(2);
      expect(sends[1]!.tracker).toBe(earlier);
      expect(document.body.textContent).toContain("Started 2 threads");
      expect(document.body.textContent).toContain("1 of 2 started");
    } finally {
      await mounted.cleanup();
    }
  });
});
