import { useSideChatStore } from "../sideChatStore";
import { getPreviewFileSession, resetPreviewFileSessionsForTests } from "./previewFileSessions";
import { createPreviewFileDocument } from "./PreviewFileEditSession";
import {
  type EnvironmentApi,
  type MessageId,
  type OrchestrationReadModel,
  ORCHESTRATION_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type TurnId,
  WS_METHODS,
  DEFAULT_AGENT_TOKEN_MODE,
} from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { useMessageQueueStore } from "../messageQueueStore";
import { inspectMessageQueueDrain } from "../messageQueueDrain";
import { setLocalGitRefNameForTests } from "../../test/gitStatusStateMock";
import { selectThreadByRef, useStore } from "../store";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import {
  readEnvironmentApi,
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { useUiStateStore } from "../uiStateStore";
import { DEFAULT_CLIENT_SETTINGS } from "@ryco/contracts/settings";
import {
  setupChatViewBrowserSuite,
  COMPACT_FOOTER_VIEWPORT,
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  PROJECT_ID,
  addThreadToSnapshot,
  rpcHarness,
  threadKeyFor,
  toThreadWindowSnapshot,
  PROJECT_LOGICAL_KEY,
  THREAD_ID,
  THREAD_KEY,
  THREAD_REF,
  THREAD_TITLE,
  WIDE_FOOTER_VIEWPORT,
  createBrowserComposerImage,
  createShortTranscriptSnapshot,
  createSnapshotForTargetUser,
  createSnapshotWithLongProposedPlan,
  createSnapshotWithPendingUserInput,
  createSnapshotWithPlanFollowUpPrompt,
  expectComposerActionsContained,
  findScrollToBottomButton,
  findScrollableAncestor,
  mountChatView,
  selectTranscriptQuote,
  selectionSnapshot,
  waitForButtonByText,
  waitForButtonContainingText,
  waitForComposerEditor,
  waitForElement,
  waitForLayout,
  waitForSendButton,
  wsRequests,
} from "./ChatView.browser.helpers";

type SnapshotThread = OrchestrationReadModel["threads"][number];

function queuedBrowserMessage(id: string, thread: SnapshotThread) {
  return {
    id,
    composer: {
      prompt: id,
      trimmedPrompt: id,
      images: [],
      sendableTerminalContexts: [],
      sourceControlContexts: [],
      selectedProvider: ProviderDriverKind.make("codex"),
      selectedModel: thread.modelSelection.model,
      selectedProviderModels: [],
      selectedPromptEffort: null,
      selectedModelSelection: thread.modelSelection,
      expiredTerminalContextCount: 0,
    },
    settings: {
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      tokenMode: DEFAULT_AGENT_TOKEN_MODE,
    },
  };
}

let windowSequence = 100;
/** Delivers a new session state over the live thread-detail subscriptions. */
function emitThreadSession(
  thread: SnapshotThread,
  session: Partial<NonNullable<SnapshotThread["session"]>>,
): void {
  windowSequence += 1;
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThreadWindow, {
    kind: "snapshot",
    snapshot: toThreadWindowSnapshot(windowSequence, {
      ...thread,
      session: {
        ...thread.session!,
        ...session,
        updatedAt: new Date(Date.parse(thread.session!.updatedAt) + windowSequence).toISOString(),
      },
    }),
  });
}

function recordingDispatch(snapshot: OrchestrationReadModel) {
  const commands: Array<{ type: string; threadId?: unknown }> = [];
  const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
  __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
    ...api,
    orchestration: {
      ...api.orchestration,
      dispatchCommand: async (command) => {
        commands.push(command as { type: string; threadId?: unknown });
        return { sequence: snapshot.snapshotSequence + 1 };
      },
    },
  });
  return {
    turnStarts: () => commands.filter((command) => command.type === "thread.turn.start"),
    commands,
  };
}

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

describe("ChatView Conversation (full app)", () => {
  setupChatViewBrowserSuite();

  it("selection actions preserve current and Side drafts without sending", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: selectionSnapshot(),
    });
    try {
      await waitForComposerEditor();
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "My current draft");
      useSideChatStore
        .getState()
        .open(
          THREAD_KEY,
          { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          "My side draft",
        );
      useSideChatStore.getState().close(THREAD_KEY);
      await waitForLayout();
      await selectTranscriptQuote();
      await page
        .getByRole("button", { name: "Add to chat", exact: true })
        .click({ timeout: 4_000 });
      await vi.waitFor(() =>
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toContain(
          "My current draft\n\nQuoted assistant text",
        ),
      );
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toContain(
        "> assistant filler 21",
      );
      await waitForLayout();
      await selectTranscriptQuote();
      await page
        .getByRole("button", { name: "Add to Side", exact: true })
        .click({ timeout: 4_000 });
      await vi.waitFor(() =>
        expect(useSideChatStore.getState().chatsByThreadKey[THREAD_KEY]?.draft).toContain(
          "My side draft\n\nQuoted assistant text",
        ),
      );
      await expect.element(page.getByLabelText("Side question")).toBeVisible();
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.textGenerationAskSideQuestion),
      ).toBe(false);
    } finally {
      useSideChatStore.setState({ chatsByThreadKey: {} });
      await mounted.cleanup();
    }
  });

  it("selection mini composer preserves input on autosave failure and transfers a fresh draft after retry", async () => {
    const snapshot = selectionSnapshot();
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    let unsubscribe = () => {};
    try {
      await waitForComposerEditor();
      const drafts = useComposerDraftStore.getState();
      const original = DraftId.make("existing-project-draft");
      drafts.setLogicalProjectDraftThreadId(
        PROJECT_LOGICAL_KEY,
        { environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID },
        original,
      );
      drafts.setPrompt(original, "Keep existing project draft");
      drafts.setPrompt(THREAD_REF, "Keep source draft");
      const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
      const file = {
        relativePath: "selection.ts",
        contents: "saved",
        version: "v1",
        encoding: "utf8" as const,
        lineEnding: "lf" as const,
      };
      let fail = true;
      let writes = 0;
      __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
        ...api,
        projects: {
          ...api.projects,
          readFile: async () => file,
          writeFile: async () => {
            writes++;
            if (fail) throw new Error("Disk full");
            return { relativePath: file.relativePath, version: "v2" };
          },
        },
      });
      const scope = { environmentId: LOCAL_ENVIRONMENT_ID, cwd: "/repo/project" };
      const owner = getPreviewFileSession(scope, createPreviewFileDocument(scope, file));
      unsubscribe = owner.subscribe(() => {});
      owner.change("Keep file draft");
      await selectTranscriptQuote();
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Message for new chat" })
        .fill("Explain the selection");
      await page.getByRole("button", { name: "Open in chat", exact: true }).click();
      await expect
        .element(page.getByRole("dialog", { name: "New chat from selection" }).getByRole("alert"))
        .toHaveTextContent("Save the pending file changes");
      await expect
        .element(page.getByRole("textbox", { name: "Message for new chat" }))
        .toHaveTextContent("Explain the selection");
      expect(owner.getSnapshot().contents).toBe("Keep file draft");
      expect(mounted.router.state.location.pathname).toBe(`/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`);
      expect(writes).toBe(1);
      fail = false;
      expect(await owner.flush(true)).toBe(true);
      await page.getByRole("button", { name: "Open in chat", exact: true }).click();
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toMatch(/^\/draft\/selection-/),
      );
      const fresh = DraftId.make(mounted.router.state.location.pathname.split("/").at(-1)!);
      expect(drafts.getComposerDraft(fresh)?.prompt).toContain(
        "Explain the selection\n\nQuoted assistant text",
      );
      expect(drafts.getComposerDraft(fresh)?.prompt).toContain("> assistant filler 21");
      expect(drafts.getComposerDraft(original)?.prompt).toBe("Keep existing project draft");
      expect(drafts.getComposerDraft(THREAD_REF)?.prompt).toBe("Keep source draft");
      expect(drafts.getDraftSessionByLogicalProjectKey(PROJECT_LOGICAL_KEY)?.draftId).toBe(
        original,
      );
    } finally {
      unsubscribe();
      await mounted.cleanup();
    }
  });

  it("selection fresh-draft retry does not replace a concurrent destination edit", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: selectionSnapshot(),
    });
    let navigation: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await waitForComposerEditor();
      navigation = vi.spyOn(mounted.router, "navigate").mockImplementationOnce(async (options) => {
        const params = options.params as unknown as { draftId: string };
        useComposerDraftStore
          .getState()
          .setPrompt(DraftId.make(params.draftId), "Concurrent destination edit");
        throw new Error("Navigation interrupted");
      });
      await selectTranscriptQuote();
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await page.getByRole("textbox", { name: "Message for new chat" }).fill("Original mini draft");
      await page.getByRole("button", { name: "Open in chat", exact: true }).click();
      await expect
        .element(page.getByRole("dialog", { name: "New chat from selection" }).getByRole("alert"))
        .toHaveTextContent("Navigation interrupted");
      await page.getByRole("button", { name: "Open in chat", exact: true }).click();
      await expect
        .element(page.getByRole("dialog", { name: "New chat from selection" }).getByRole("alert"))
        .toHaveTextContent("destination draft changed elsewhere");
      const destination = Object.entries(useComposerDraftStore.getState().draftsByThreadKey).find(
        ([key]) => key.startsWith("selection-"),
      );
      expect(destination?.[1].prompt).toBe("Concurrent destination edit");
      await expect
        .element(page.getByRole("textbox", { name: "Message for new chat" }))
        .toHaveTextContent("Original mini draft");
      expect(navigation).toHaveBeenCalledOnce();
    } finally {
      navigation?.mockRestore();
      await mounted.cleanup();
    }
  });

  it("selection new-chat sends use the normal first-turn queue and retain failed snapshots", async () => {
    const snapshot = selectionSnapshot();
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await waitForComposerEditor();
      const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
      let attempts = 0;
      __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: async (command) => {
            if (command.type === "thread.turn.start") {
              attempts++;
              throw new Error("Provider unavailable");
            }
            return { sequence: snapshot.snapshotSequence + 1 };
          },
        },
      });
      await selectTranscriptQuote();
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await page.getByRole("textbox", { name: "Message for new chat" }).fill("Explain it");
      await page
        .getByRole("dialog", { name: "New chat from selection" })
        .getByRole("button", { name: "Send", exact: true })
        .click();
      await vi.waitFor(() => expect(attempts).toBe(1), { timeout: 8_000 });
      const queued = Object.values(useMessageQueueStore.getState().queuesByThreadKey).flat();
      await vi.waitFor(() =>
        expect(
          Object.values(useMessageQueueStore.getState().queuesByThreadKey).flat()[0]
            ?.deliveryStatus,
        ).toBe("failed"),
      );
      expect(queued[0]?.composer.prompt).toContain("Explain it\n\nQuoted assistant text");
      expect(queued[0]?.composer.prompt).toContain("> assistant filler 21");
      await waitForLayout();
      expect(attempts).toBe(1);
      await expect
        .element(page.getByRole("button", { name: /Retry queued message/ }))
        .toBeVisible();
    } finally {
      useMessageQueueStore.setState({ queuesByThreadKey: {}, steeringIdsByThreadKey: {} });
      await mounted.cleanup();
    }
  });

  it.each([false, true])(
    "drains editor saves before direct send and preserves drafts on failure=%s",
    async (fail) => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "editor-send-existing" as MessageId,
        targetText: "Existing turn",
      });
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      let unsubscribe = () => {};
      try {
        await waitForComposerEditor();
        const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
        let finish!: () => void;
        let writes = 0;
        let starts = 0;
        const file = {
          relativePath: "app.ts",
          contents: "saved",
          version: "v1",
          encoding: "utf8" as const,
          lineEnding: "lf" as const,
        };
        __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
          ...api,
          projects: {
            ...api.projects,
            readFile: async () => file,
            writeFile: () => {
              writes++;
              return new Promise((resolve, reject) => {
                finish = () =>
                  fail
                    ? reject({ reason: "conflict", message: "External edit" })
                    : resolve({ relativePath: "app.ts", version: "v2" });
              });
            },
          },
          orchestration: {
            ...api.orchestration,
            dispatchCommand: async (command) => {
              if (command.type === "thread.turn.start") starts++;
              return { sequence: snapshot.snapshotSequence + 1 };
            },
          },
        });
        const scope = { environmentId: LOCAL_ENVIRONMENT_ID, cwd: "/repo/project" };
        const owner = getPreviewFileSession(scope, createPreviewFileDocument(scope, file));
        unsubscribe = owner.subscribe(() => {});
        owner.change("editor draft");
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Use my edited file");
        await waitForLayout();
        (await waitForSendButton()).click();
        await vi.waitFor(() => expect(writes).toBe(1));
        expect(starts).toBe(0);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          "Use my edited file",
        );
        finish();
        if (fail) {
          await vi.waitFor(() => expect(owner.getSnapshot().saveStatus).toBe("conflict"));
          expect(starts).toBe(0);
          expect(owner.getSnapshot().contents).toBe("editor draft");
          expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
            "Use my edited file",
          );
        } else {
          await vi.waitFor(() => expect(starts).toBe(1));
          expect(owner.dirty).toBe(false);
        }
      } finally {
        unsubscribe();
        resetPreviewFileSessionsForTests();
        __resetEnvironmentApiOverridesForTests();
        await mounted.cleanup();
      }
    },
  );

  it.each(["text", "attachment"] as const)(
    "preserves later composer %s during the direct editor-save barrier",
    async (editKind) => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "editor-send-existing" as MessageId,
        targetText: "Existing turn",
      });
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      let unsubscribe = () => {};
      try {
        await waitForComposerEditor();
        const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
        let finish!: () => void;
        let writes = 0;
        let starts = 0;
        const file = {
          relativePath: "app.ts",
          contents: "saved",
          version: "v1",
          encoding: "utf8" as const,
          lineEnding: "lf" as const,
        };
        __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
          ...api,
          projects: {
            ...api.projects,
            readFile: async () => file,
            writeFile: () => {
              writes++;
              return new Promise((resolve) => {
                finish = () => resolve({ relativePath: "app.ts", version: "v2" });
              });
            },
          },
          orchestration: {
            ...api.orchestration,
            dispatchCommand: async (command) => {
              if (command.type === "thread.turn.start") starts++;
              return { sequence: snapshot.snapshotSequence + 1 };
            },
          },
        });
        const scope = { environmentId: LOCAL_ENVIRONMENT_ID, cwd: "/repo/project" };
        const owner = getPreviewFileSession(scope, createPreviewFileDocument(scope, file));
        unsubscribe = owner.subscribe(() => {});
        owner.change("editor draft");
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Use my edited file");
        await waitForLayout();
        (await waitForSendButton()).click();
        await vi.waitFor(() => expect(writes).toBe(1));
        expect(starts).toBe(0);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          "Use my edited file",
        );
        if (editKind === "text")
          useComposerDraftStore.getState().setPrompt(THREAD_REF, "Later typing");
        else
          useComposerDraftStore
            .getState()
            .addImage(THREAD_REF, createBrowserComposerImage({ id: "later-attachment" }));
        await waitForLayout();
        finish();
        await vi.waitFor(() => expect(starts).toBe(1));
        expect(owner.dirty).toBe(false);
        const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        expect(draft?.prompt).toBe(editKind === "text" ? "Later typing" : "Use my edited file");
        expect(draft?.images.map((image) => image.id)).toEqual(
          editKind === "attachment" ? ["later-attachment"] : [],
        );
      } finally {
        unsubscribe();
        resetPreviewFileSessionsForTests();
        __resetEnvironmentApiOverridesForTests();
        await mounted.cleanup();
      }
    },
  );

  it.each(["text", "attachment"] as const)(
    "preserves later composer %s during the enqueue editor-save barrier",
    async (editKind) => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "editor-send-existing" as MessageId,
        targetText: "Existing turn",
        sessionStatus: "running",
      });
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      let unsubscribe = () => {};
      try {
        await waitForComposerEditor();
        const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
        let finish!: () => void;
        let writes = 0;
        let starts = 0;
        const file = {
          relativePath: "app.ts",
          contents: "saved",
          version: "v1",
          encoding: "utf8" as const,
          lineEnding: "lf" as const,
        };
        __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
          ...api,
          projects: {
            ...api.projects,
            readFile: async () => file,
            writeFile: () => {
              writes++;
              return new Promise((resolve) => {
                finish = () => resolve({ relativePath: "app.ts", version: "v2" });
              });
            },
          },
          orchestration: {
            ...api.orchestration,
            dispatchCommand: async (command) => {
              if (command.type === "thread.turn.start") starts++;
              return { sequence: snapshot.snapshotSequence + 1 };
            },
          },
        });
        const scope = { environmentId: LOCAL_ENVIRONMENT_ID, cwd: "/repo/project" };
        const owner = getPreviewFileSession(scope, createPreviewFileDocument(scope, file));
        unsubscribe = owner.subscribe(() => {});
        owner.change("editor draft");
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Use my edited file");
        await waitForLayout();
        (await waitForComposerEditor()).focus();
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(writes).toBe(1));
        expect(starts).toBe(0);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          "Use my edited file",
        );
        if (editKind === "text")
          useComposerDraftStore.getState().setPrompt(THREAD_REF, "Later typing");
        else
          useComposerDraftStore
            .getState()
            .addImage(THREAD_REF, createBrowserComposerImage({ id: "later-attachment" }));
        await waitForLayout();
        finish();
        await vi.waitFor(() =>
          expect(useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY]).toHaveLength(1),
        );
        expect(starts).toBe(0);
        expect(owner.dirty).toBe(false);
        const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        expect(draft?.prompt).toBe(editKind === "text" ? "Later typing" : "Use my edited file");
        expect(draft?.images.map((image) => image.id)).toEqual(
          editKind === "attachment" ? ["later-attachment"] : [],
        );
      } finally {
        useMessageQueueStore.getState().clear(THREAD_KEY);
        unsubscribe();
        resetPreviewFileSessionsForTests();
        __resetEnvironmentApiOverridesForTests();
        await mounted.cleanup();
      }
    },
  );

  it("retains a failed queued send and the next draft until explicit retry", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "existing-queue-test" as MessageId,
      targetText: "Existing turn",
    });
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await waitForComposerEditor();
      const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
      let turnAttempts = 0;
      const dispatchCommand: EnvironmentApi["orchestration"]["dispatchCommand"] = async (
        command,
      ) => {
        if (command.type === "thread.turn.start") {
          turnAttempts++;
          if (turnAttempts === 1) throw new Error("Temporary send failure");
        }
        return { sequence: snapshot.snapshotSequence + 1 };
      };
      __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
        ...api,
        orchestration: { ...api.orchestration, dispatchCommand },
      });
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep my next draft");
      await waitForLayout();
      const modelSelection = snapshot.threads[0]!.modelSelection;
      useMessageQueueStore.getState().enqueue(THREAD_KEY, {
        id: "queued-retry-browser",
        composer: {
          prompt: "Queued earlier",
          trimmedPrompt: "Queued earlier",
          images: [],
          sendableTerminalContexts: [],
          sourceControlContexts: [],
          selectedProvider: ProviderDriverKind.make("codex"),
          selectedModel: modelSelection.model,
          selectedProviderModels: [],
          selectedPromptEffort: null,
          selectedModelSelection: modelSelection,
          expiredTerminalContextCount: 0,
        },
        settings: {
          runtimeMode: "full-access",
          interactionMode: "default",
          tokenMode: DEFAULT_AGENT_TOKEN_MODE,
        },
      });
      await vi.waitFor(() =>
        expect(
          useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY]?.[0]?.deliveryStatus,
        ).toBe("failed"),
      );
      expect(turnAttempts).toBe(1);
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
        "Keep my next draft",
      );
      await page.getByRole("button", { name: /Retry queued message/ }).click();
      await vi.waitFor(() =>
        expect(useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY]).toHaveLength(0),
      );
      expect(turnAttempts).toBe(2);
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
        "Keep my next draft",
      );
    } finally {
      useMessageQueueStore.getState().clear(THREAD_KEY);
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it("blocks queued dispatch on editor failure and retains the next composer draft", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "existing-queue-test" as MessageId,
      targetText: "Existing turn",
    });
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await waitForComposerEditor();
      const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
      let turnAttempts = 0;
      let failWrite = true;
      const file = {
        relativePath: "queue.ts",
        contents: "saved",
        version: "v1",
        encoding: "utf8" as const,
        lineEnding: "lf" as const,
      };
      const dispatchCommand: EnvironmentApi["orchestration"]["dispatchCommand"] = async (
        command,
      ) => {
        if (command.type === "thread.turn.start") {
          turnAttempts++;
        }
        return { sequence: snapshot.snapshotSequence + 1 };
      };
      __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
        ...api,
        orchestration: { ...api.orchestration, dispatchCommand },
        projects: {
          ...api.projects,
          readFile: async () => file,
          writeFile: async () => {
            if (failWrite) throw new Error("Temporary file write failure");
            return { relativePath: "queue.ts", version: "v2" };
          },
        },
      });
      const scope = { environmentId: LOCAL_ENVIRONMENT_ID, cwd: "/repo/project" };
      const owner = getPreviewFileSession(scope, createPreviewFileDocument(scope, file));
      const unsubscribe = owner.subscribe(() => {});
      owner.change("queued editor draft");
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep my next draft");
      await waitForLayout();
      const modelSelection = snapshot.threads[0]!.modelSelection;
      useMessageQueueStore.getState().enqueue(THREAD_KEY, {
        id: "queued-retry-browser",
        composer: {
          prompt: "Queued earlier",
          trimmedPrompt: "Queued earlier",
          images: [],
          sendableTerminalContexts: [],
          sourceControlContexts: [],
          selectedProvider: ProviderDriverKind.make("codex"),
          selectedModel: modelSelection.model,
          selectedProviderModels: [],
          selectedPromptEffort: null,
          selectedModelSelection: modelSelection,
          expiredTerminalContextCount: 0,
        },
        settings: {
          runtimeMode: "full-access",
          interactionMode: "default",
          tokenMode: DEFAULT_AGENT_TOKEN_MODE,
        },
      });
      await vi.waitFor(() =>
        expect(
          useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY]?.[0]?.deliveryStatus,
        ).toBe("failed"),
      );
      expect(turnAttempts).toBe(0);
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
        "Keep my next draft",
      );
      failWrite = false;
      expect(await owner.flush(true)).toBe(true);
      unsubscribe();
      await page.getByRole("button", { name: /Retry queued message/ }).click();
      await vi.waitFor(() =>
        expect(useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY]).toHaveLength(0),
      );
      expect(turnAttempts).toBe(1);
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
        "Keep my next draft",
      );
    } finally {
      useMessageQueueStore.getState().clear(THREAD_KEY);
      resetPreviewFileSessionsForTests();
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it.each([false, true])(
    "blocks plan implementation on editor failure (new thread=%s)",
    async (newThread) => {
      useUiStateStore.getState().setAlwaysUseBuildMode(false);
      const snapshot = createSnapshotWithPlanFollowUpPrompt();
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      let unsubscribe = () => {};
      try {
        await waitForComposerEditor();
        const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
        const file = {
          relativePath: "plan.ts",
          contents: "saved",
          version: "v1",
          encoding: "utf8" as const,
          lineEnding: "lf" as const,
        };
        let mutations = 0;
        __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
          ...api,
          projects: {
            ...api.projects,
            readFile: async () => file,
            writeFile: async () => {
              throw new Error("Disk unavailable");
            },
          },
          orchestration: {
            ...api.orchestration,
            dispatchCommand: async () => {
              mutations++;
              return { sequence: snapshot.snapshotSequence + 1 };
            },
          },
        });
        const scope = { environmentId: LOCAL_ENVIRONMENT_ID, cwd: "/repo/project" };
        const owner = getPreviewFileSession(scope, createPreviewFileDocument(scope, file));
        unsubscribe = owner.subscribe(() => {});
        owner.change("plan editor draft");
        if (newThread) {
          await page.getByRole("button", { name: "Implementation actions" }).click();
          await page.getByRole("menuitem", { name: "Implement in a new thread" }).click();
        } else {
          (await waitForButtonByText("Implement")).click();
        }
        await vi.waitFor(() => expect(owner.getSnapshot().saveStatus).toBe("error"));
        expect(mutations).toBe(0);
        expect(owner.getSnapshot().contents).toBe("plan editor draft");
      } finally {
        unsubscribe();
        resetPreviewFileSessionsForTests();
        __resetEnvironmentApiOverridesForTests();
        await mounted.cleanup();
      }
    },
  );

  it("blocks queued steering on editor failure and retains the message", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "steer-existing" as MessageId,
      targetText: "Existing turn",
      sessionStatus: "running",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) => ({
        ...thread,
        session: {
          ...thread.session!,
          providerInstanceId: ProviderInstanceId.make("codex"),
          activeTurnId: "steer-turn" as TurnId,
        },
      })),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: (value) => {
        value.serverConfig = {
          ...value.serverConfig,
          providers: value.serverConfig.providers.map((provider) => ({
            ...provider,
            supportsTurnSteering: true,
          })),
        };
      },
    });
    try {
      await waitForComposerEditor();
      const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
      let turnAttempts = 0;
      let failWrite = true;
      const file = {
        relativePath: "queue.ts",
        contents: "saved",
        version: "v1",
        encoding: "utf8" as const,
        lineEnding: "lf" as const,
      };
      const dispatchCommand: EnvironmentApi["orchestration"]["dispatchCommand"] = async (
        command,
      ) => {
        if (command.type === "thread.turn.steer") {
          turnAttempts++;
        }
        return { sequence: snapshot.snapshotSequence + 1 };
      };
      __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
        ...api,
        orchestration: { ...api.orchestration, dispatchCommand },
        projects: {
          ...api.projects,
          readFile: async () => file,
          writeFile: async () => {
            if (failWrite) throw new Error("Temporary file write failure");
            return { relativePath: "queue.ts", version: "v2" };
          },
        },
      });
      const scope = { environmentId: LOCAL_ENVIRONMENT_ID, cwd: "/repo/project" };
      const owner = getPreviewFileSession(scope, createPreviewFileDocument(scope, file));
      const unsubscribe = owner.subscribe(() => {});
      owner.change("queued editor draft");
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep my next draft");
      await waitForLayout();
      const modelSelection = snapshot.threads[0]!.modelSelection;
      useMessageQueueStore.getState().enqueue(THREAD_KEY, {
        id: "queued-retry-browser",
        composer: {
          prompt: "Queued earlier",
          trimmedPrompt: "Queued earlier",
          images: [],
          sendableTerminalContexts: [],
          sourceControlContexts: [],
          selectedProvider: ProviderDriverKind.make("codex"),
          selectedModel: modelSelection.model,
          selectedProviderModels: [],
          selectedPromptEffort: null,
          selectedModelSelection: modelSelection,
          expiredTerminalContextCount: 0,
        },
        settings: {
          runtimeMode: "full-access",
          interactionMode: "default",
          tokenMode: DEFAULT_AGENT_TOKEN_MODE,
        },
      });
      const steer = page.getByRole("button", {
        name: /Steer queued message.*into the active turn/,
      });
      await expect.element(steer).toBeEnabled();
      await steer.click();
      await vi.waitFor(() => expect(owner.getSnapshot().saveStatus).toBe("error"));
      expect(useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY]).toHaveLength(1);
      expect(turnAttempts).toBe(0);
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
        "Keep my next draft",
      );
      failWrite = false;
      expect(await owner.flush(true)).toBe(true);
      unsubscribe();
      await steer.click();
      await vi.waitFor(() => expect(turnAttempts).toBe(1));
      expect(turnAttempts).toBe(1);
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
        "Keep my next draft",
      );
    } finally {
      useMessageQueueStore.getState().clear(THREAD_KEY);
      resetPreviewFileSessionsForTests();
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it("Stop holds the queue and Resume sends it", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "stop-hold-existing" as MessageId,
      targetText: "Existing turn",
      sessionStatus: "running",
    });
    const thread = snapshot.threads[0]!;
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await waitForComposerEditor();
      const dispatch = recordingDispatch(snapshot);
      useMessageQueueStore
        .getState()
        .enqueue(THREAD_KEY, queuedBrowserMessage("queued-after-stop", thread));
      await page.getByRole("button", { name: "Stop generation" }).click();
      await vi.waitFor(() =>
        expect(dispatch.commands.map((command) => command.type)).toContain("thread.turn.interrupt"),
      );
      emitThreadSession(thread, { status: "ready", activeTurnId: null });
      // The hold copy shows from the Stop click alone; the point is that it
      // still blocks once the settled session has reached the store.
      await vi.waitFor(() => {
        const session = selectThreadByRef(useStore.getState(), {
          environmentId: LOCAL_ENVIRONMENT_ID,
          threadId: THREAD_ID,
        })?.session;
        expect(session?.orchestrationStatus).toBe("ready");
        expect(session?.activeTurnId ?? null).toBeNull();
      });
      await waitForLayout();
      expect(inspectMessageQueueDrain(THREAD_KEY)).toMatchObject({
        inFlightMessageId: null,
        lastStep: { kind: "wait", reason: "held" },
      });
      expect(useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY]).toEqual([
        expect.not.objectContaining({ deliveryStatus: expect.anything() }),
      ]);
      await expect.element(page.getByText(/Paused after Stop/)).toBeVisible();
      expect(dispatch.turnStarts()).toEqual([]);
      await page.getByRole("button", { name: "Resume queued messages" }).click();
      await vi.waitFor(() => expect(dispatch.turnStarts()).toHaveLength(1));
      await vi.waitFor(() =>
        expect(useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY]).toHaveLength(0),
      );
    } finally {
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it("an error end holds the queue", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "error-hold-existing" as MessageId,
      targetText: "Existing turn",
      sessionStatus: "running",
    });
    const thread = snapshot.threads[0]!;
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await waitForComposerEditor();
      const dispatch = recordingDispatch(snapshot);
      useMessageQueueStore
        .getState()
        .enqueue(THREAD_KEY, queuedBrowserMessage("queued-after-error", thread));
      await waitForLayout();
      emitThreadSession(thread, { status: "error", lastError: "Usage limit reached" });
      await expect.element(page.getByText(/Paused after an error/)).toBeVisible();
      await expect.element(page.getByTitle("Usage limit reached")).toBeVisible();
      await waitForLayout();
      expect(dispatch.turnStarts()).toEqual([]);
      expect(useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY]).toHaveLength(1);
    } finally {
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it("a queued message on a thread that is not on screen sends when its turn settles", async () => {
    const otherThreadId = ThreadId.make("thread-off-screen-target");
    const snapshot = addThreadToSnapshot(
      createSnapshotForTargetUser({
        targetMessageId: "off-screen-existing" as MessageId,
        targetText: "Existing turn",
        sessionStatus: "running",
      }),
      otherThreadId,
    );
    const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID)!;
    // A branch thread without a worktree: the background sender reads which
    // branch the project root has checked out before sending in place.
    setLocalGitRefNameForTests(thread.branch);
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await waitForComposerEditor();
      const dispatch = recordingDispatch(snapshot);
      useMessageQueueStore
        .getState()
        .enqueue(THREAD_KEY, queuedBrowserMessage("queued-off-screen", thread));
      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: otherThreadId },
      });
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(
          `/${LOCAL_ENVIRONMENT_ID}/${otherThreadId}`,
        ),
      );
      await waitForLayout();
      expect(dispatch.turnStarts()).toEqual([]);
      emitThreadSession(thread, { status: "ready", activeTurnId: null });
      await vi.waitFor(() => expect(dispatch.turnStarts()).toHaveLength(1), { timeout: 8_000 });
      expect(dispatch.turnStarts()[0]?.threadId).toBe(THREAD_ID);
      expect(useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY]).toHaveLength(0);
      expect(useMessageQueueStore.getState().queuesByThreadKey[threadKeyFor(otherThreadId)]).toBe(
        undefined,
      );
    } finally {
      setLocalGitRefNameForTests(undefined);
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it("shows a pointer cursor for the running stop button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-button-cursor" as MessageId,
        targetText: "stop button cursor target",
        sessionStatus: "running",
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );

      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the active thread title in the breadcrumb", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-tooltip-target" as MessageId,
        targetText: "thread tooltip target",
      }),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Breadcrumb"]')).find(
            (element) => element.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the active thread title in the breadcrumb.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not render a thread archive action in the chat header", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        confirmThreadArchive: true,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-archive-confirm-test" as MessageId,
        targetText: "archive confirm target",
      }),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Breadcrumb"]')).find(
            (element) => element.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the active thread title in the breadcrumb.",
      );
      expect(document.querySelector(`[data-testid="thread-archive-${THREAD_ID}"]`)).toBeNull();
      expect(
        document.querySelector(`[data-testid="thread-archive-confirm-${THREAD_ID}"]`),
      ).toBeNull();
    } finally {
      localStorage.removeItem("ryco:client-settings:v1");
      await mounted.cleanup();
    }
  });

  it("keeps the scroll-to-bottom pill hidden when the transcript is too short to scroll", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createShortTranscriptSnapshot(),
    });

    try {
      const timelineRow = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-message-id]"),
        "Unable to find a timeline message row.",
      );
      expect(findScrollableAncestor(timelineRow)).toBeNull();

      // The pill is shown behind a 150ms debounce, so a stale "not at end"
      // signal would surface shortly after the timeline paints.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(findScrollToBottomButton()).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the scroll-to-bottom pill only while the transcript is scrolled away from the bottom", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-scroll-pill" as MessageId,
        targetText: "scroll pill target",
      }),
    });

    try {
      const timelineRow = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-message-id]"),
        "Unable to find a timeline message row.",
      );
      const scrollContainer = findScrollableAncestor(timelineRow);
      expect(scrollContainer).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(findScrollToBottomButton()).toBeNull();

      // The list keeps re-pinning to the end until its scroll handler observes
      // the user-initiated offset, so re-assert until the position sticks.
      await vi.waitFor(async () => {
        scrollContainer!.scrollTop = 0;
        await waitForLayout();
        expect(scrollContainer!.scrollTop).toBeLessThan(100);
      });
      await vi.waitFor(() => {
        expect(findScrollToBottomButton()).not.toBeNull();
      });

      findScrollToBottomButton()!.click();
      await vi.waitFor(() => {
        expect(findScrollToBottomButton()).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps long proposed plans lightweight until the user expands them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );

      expect(document.body.textContent).not.toContain("deep hidden detail only after expand");

      const expandButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );
      expandButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the active worktree path when saving a proposed plan to the workspace", async () => {
    const snapshot = createSnapshotWithLongProposedPlan();
    const threads = snapshot.threads.slice();
    const targetThreadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
    const targetThread = targetThreadIndex >= 0 ? threads[targetThreadIndex] : undefined;
    if (targetThread) {
      threads[targetThreadIndex] = {
        ...targetThread,
        worktreePath: "/repo/worktrees/plan-thread",
      };
    }

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads,
      },
    });

    try {
      const planActionsButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Plan actions"]'),
        "Unable to find proposed plan actions button.",
      );
      planActionsButton.click();

      const saveToWorkspaceItem = await waitForElement(
        () =>
          (Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Save to workspace",
          ) ?? null) as HTMLElement | null,
        'Unable to find "Save to workspace" menu item.',
      );
      saveToWorkspaceItem.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Enter a path relative to /repo/worktrees/plan-thread.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps pending-question footer actions inside the composer after a real resize", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();

      await waitForButtonByText("Previous");
      await waitForButtonByText("Submit answers");

      await mounted.setViewport({
        ...COMPACT_FOOTER_VIEWPORT,
        width: 1_024,
      });
      await expectComposerActionsContained();
    } finally {
      await mounted.cleanup();
    }
  });
});
