import { batchLaunchStore, webBatchLaunchLock } from "../batchLaunchStore";
import { createWebKV } from "../platform/kv";
import { readEnvironmentConnection } from "../environments/runtime";
import {
  type EnvironmentApi,
  type MessageId,
  ProviderInstanceId,
  type VcsStatusResult,
} from "@ryco/contracts";
import { createBatchLaunch, createBatchLaunchStore } from "@ryco/client-runtime/state/composer";
import { createModelCapabilities, createModelSelection } from "@ryco/shared/model";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  readEnvironmentApi,
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import {
  setupChatViewBrowserSuite,
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  PROJECT_ID,
  THREAD_REF,
  addThreadToSnapshot,
  createBaseServerConfig,
  createBrowserComposerImage,
  createDraftOnlySnapshot,
  createSourceControlContext,
  createUserMessage,
  fixture,
  mountChatView,
  setDraftThreadWithoutWorktree,
  toThreadWindowSnapshot,
  waitForAppBootstrap,
  waitForComposerEditor,
  waitForLayout,
  waitForSendButton,
} from "./ChatView.browser.helpers";

// Hoisted per suite so the comparison fixture reaches the app's static imports.
const batchGitFixture = vi.hoisted(() => ({ data: null as VcsStatusResult | null }));
vi.mock("../lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: batchGitFixture.data, error: null, cause: null, isPending: false }),
  refreshGitStatus: async () => null,
  resetGitStatusStateForTests: () => {},
}));

describe("ChatView model comparisons (full app)", () => {
  setupChatViewBrowserSuite();
  beforeEach(() => {
    batchGitFixture.data = null;
  });

  it("coordinates two browser stores over shared storage without losing or duplicating a source", async () => {
    const providers = createBaseServerConfig().providers.map((provider) =>
      Object.assign({}, provider, {
        models: ["model-a", "model-b"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        })),
      }),
    );
    const selections = ["model-a", "model-b"].map((model) =>
      createModelSelection(ProviderInstanceId.make("codex"), model),
    );
    const make = (id: string, ownerKey: string) =>
      createBatchLaunch({
        id,
        ownerKey,
        environmentId: LOCAL_ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        selections,
        providers,
        prompt: "Fixture shared source",
        isGitRepo: true,
        baseBranch: "main",
        createdAt: NOW_ISO,
      });
    // Distinct adapter identities deliberately defeat the native in-process lock.
    // Real Web Locks coordinate these independent hydrated browser stores.
    const first = createBatchLaunchStore(createWebKV(), webBatchLaunchLock);
    const second = createBatchLaunchStore(createWebKV(), webBatchLaunchLock);
    await Promise.all([first.ready, second.ready]);
    await Promise.all([
      first.add(make("browser-a", "source-a")),
      second.add(make("browser-b", "source-b")),
    ]);
    await first.refresh();
    expect(first.useStore.getState().batches.map((batch) => batch.id)).toEqual([
      "browser-a",
      "browser-b",
    ]);
    const claims = await Promise.all([
      first.add(make("browser-c", "same-source")),
      second.add(make("browser-d", "same-source")),
    ]);
    expect(claims[0]!.id).toBe(claims[1]!.id);
    const dispatch = vi.fn(async () => {});
    const ports = { assertMutationReady: () => {}, prepare: async () => dispatch };
    await Promise.all([first.run(claims[0]!.id, ports), second.run(claims[1]!.id, ports)]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await first.refresh();
    expect(first.useStore.getState().batches).toHaveLength(3);
  });

  it("submits an actual new-thread comparison, retries after reconnect, and reconciles a lost ack after assistant output", async () => {
    setDraftThreadWithoutWorktree();
    batchGitFixture.data = {
      isRepo: true,
      refName: "main",
      isDefaultRef: true,
      hasPrimaryRemote: false,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
    const models = ["candidate-a", "candidate-b", "candidate-c"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
    }));
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (value) => {
        value.serverConfig = {
          ...value.serverConfig,
          environment: {
            ...value.serverConfig.environment,
            capabilities: {
              ...value.serverConfig.environment.capabilities,
              requiredWorktreeBootstrap: true,
              projectPreferences: true,
            },
          },
          providers: value.serverConfig.providers.map((provider) => ({ ...provider, models })),
        };
      },
    });
    try {
      await waitForComposerEditor();
      const drafts = useComposerDraftStore.getState();
      drafts.setPrompt(THREAD_REF, "Compare this same initial prompt");
      drafts.setModelSelection(
        THREAD_REF,
        createModelSelection(ProviderInstanceId.make("codex"), "candidate-a"),
      );
      await waitForLayout();
      await page.getByRole("button", { name: "Compare models…" }).click();
      drafts.setModelSelection(
        THREAD_REF,
        createModelSelection(ProviderInstanceId.make("codex"), "candidate-b"),
      );
      await waitForLayout();
      await page.getByRole("button", { name: "Add current selection" }).click();
      drafts.setModelSelection(
        THREAD_REF,
        createModelSelection(ProviderInstanceId.make("codex"), "candidate-c"),
      );
      await waitForLayout();
      await page.getByRole("button", { name: "Add current selection" }).click();
      const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
      let failBeforeDispatch = true;
      const readPreferences = vi.fn(async () => ({
        initialModelSelection: {
          value: createModelSelection(ProviderInstanceId.make("codex"), "project-preset"),
          source: "project" as const,
        },
        defaultThreadEnvMode: { value: "local" as const, source: "node" as const },
        worktreeBranchPrefix: { value: "project/comparison", source: "project" as const },
        runSetupScript: { value: false, source: "project" as const },
        worktreeRoot: { value: "/fixture/project-worktrees", source: "project" as const },
        overrides: { runSetupScript: false },
      }));
      const commands: Array<
        Extract<
          Parameters<EnvironmentApi["orchestration"]["dispatchCommand"]>[0],
          { type: "thread.turn.start" }
        >
      > = [];
      const override: EnvironmentApi = {
        ...api,
        server: {
          ...api.server!,
          getProjectPreferences: readPreferences,
          getConfig: async () => {
            if (failBeforeDispatch && commands.length === 2)
              throw new Error("Disconnected before dispatch");
            return fixture.serverConfig;
          },
        },
        orchestration: {
          ...api.orchestration,
          dispatchCommand: async (command) => {
            if (command.type !== "thread.turn.start") throw new Error("Unexpected mutation");
            commands.push(command);
            if (command.modelSelection?.model === "candidate-b")
              throw new Error("Lost acknowledgement");
            return { sequence: fixture.snapshot.snapshotSequence + 1 };
          },
          getThreadWindow: async ({ threadId }) => {
            const thread = {
              ...addThreadToSnapshot(fixture.snapshot, threadId).threads.at(-1)!,
              worktreePath: `/fixture/worktrees/${threadId}`,
              messages: [
                {
                  ...createUserMessage({
                    id: "assistant-latest" as MessageId,
                    text: "Assistant output after ack loss",
                    offsetSeconds: 1,
                  }),
                  role: "assistant" as const,
                },
              ],
            };
            return toThreadWindowSnapshot(fixture.snapshot.snapshotSequence, thread);
          },
          getThreadHistoryPage: async ({ mode }) => ({
            collection: "messages" as const,
            snapshotSequence: fixture.snapshot.snapshotSequence,
            items:
              mode.kind === "around"
                ? [
                    createUserMessage({
                      id: mode.anchorId,
                      text: "Compare this same initial prompt",
                      offsetSeconds: 0,
                    }),
                  ]
                : [],
            page: {
              hasMoreBefore: false,
              hasMoreAfter: false,
              oldestCursor: null,
              newestCursor: null,
            },
          }),
        },
      };
      __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, override);
      (await waitForSendButton()).click();
      await vi.waitFor(() =>
        expect(
          batchLaunchStore.useStore
            .getState()
            .batches[0]?.destinations.map((target) => target.status),
        ).toEqual(["launched", "launched", "failed"]),
      );
      expect(commands).toHaveLength(2);
      expect(commands[0]!.bootstrap?.requireWorktree).toBe(true);
      expect(commands[1]!.bootstrap?.requireWorktree).toBe(true);
      expect(commands[0]!.commandId).not.toBe(commands[1]!.commandId);
      expect(
        commands.every((command) => command.message.text === "Compare this same initial prompt"),
      ).toBe(true);
      // The normal runtime reconnect owner replaces the shell generation. Retry
      // must capture that generation rather than keep the original send closure.
      await readEnvironmentConnection(LOCAL_ENVIRONMENT_ID)!.reconnect();
      await waitForAppBootstrap();
      failBeforeDispatch = false;
      await page.getByRole("button", { name: "Retry safe failures" }).click();
      await vi.waitFor(() => expect(commands).toHaveLength(3));
      await expect.element(page.getByText("Model comparison · 3/3 launched")).toBeVisible();
      expect(new Set(commands.map((command) => command.commandId)).size).toBe(3);
      expect(readPreferences).toHaveBeenCalledTimes(3);
      expect(commands.map((command) => command.modelSelection?.model)).toEqual([
        "candidate-a",
        "candidate-b",
        "candidate-c",
      ]);
      for (const command of commands) {
        expect(command.bootstrap?.requireWorktree).toBe(true);
        expect(command.bootstrap?.runSetupScript).toBe(false);
        expect(command.bootstrap?.prepareWorktree?.branch).toMatch(/^project\/comparison\//);
      }
      expect(drafts.getComposerDraft(THREAD_REF)?.prompt).toBe("Compare this same initial prompt");
      drafts.addImage(THREAD_REF, createBrowserComposerImage({ id: "retained-context-image" }));
      drafts.addSourceControlContext(THREAD_REF, createSourceControlContext("retained-context"));
      await waitForLayout();
      const sourceBeforeRelease = drafts.getComposerDraft(THREAD_REF);
      const savedLedger = localStorage.getItem("ryco:batch-launches:v1");
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => {
        unhandled.push(event.reason);
      };
      window.addEventListener("unhandledrejection", onUnhandled);
      const setItem = Storage.prototype.setItem;
      const failingWrite = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
          if (key === "ryco:batch-launches:v1") throw new Error("Fixture ledger write failure");
          return setItem.call(this, key, value);
        });
      try {
        await page.getByRole("button", { name: "Start another comparison" }).click();
        await expect
          .element(page.getByText("Comparison draft could not be released"))
          .toBeVisible();
        expect(batchLaunchStore.useStore.getState().storageError).not.toBeNull();
        expect(drafts.getComposerDraft(THREAD_REF)).toMatchObject({
          prompt: sourceBeforeRelease!.prompt,
          images: sourceBeforeRelease!.images,
          sourceControlContexts: sourceBeforeRelease!.sourceControlContexts,
        });
        expect(localStorage.getItem("ryco:batch-launches:v1")).toBe(savedLedger);
        await waitForLayout();
        expect(unhandled).toEqual([]);
      } finally {
        failingWrite.mockRestore();
        window.removeEventListener("unhandledrejection", onUnhandled);
        batchLaunchStore.useStore.setState({ storageError: null });
      }
    } finally {
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });
});
