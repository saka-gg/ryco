import {
  ORCHESTRATION_WS_METHODS,
  ProviderInstanceId,
  RuntimeSessionId,
  type EnvironmentApi,
  type EventId,
  type MessageId,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
  readEnvironmentApi,
} from "../environmentApi";
import { isMacPlatform } from "../lib/utils";
import { useMessageQueueStore } from "../messageQueueStore";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  THREAD_ID,
  THREAD_KEY,
  THREAD_REF,
  createSnapshotForTargetUser,
  mountChatView,
  rpcHarness,
  setupChatViewBrowserSuite,
  toThreadWindowSnapshot,
  waitForComposerEditor,
  waitForComposerText,
  waitForLayout,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

type RecordedCommand = { readonly type: string } & Record<string, unknown>;

const RUNTIME = "runtime-redirect";
const TURN = "redirect-turn" as TurnId;
const REQUEST_ID = "req-redirect";
const IDENTITY = { requestEventId: "activity-redirect-approval", runtimeSessionId: RUNTIME };

const approvalRequested: OrchestrationThreadActivity = {
  id: "activity-redirect-approval" as EventId,
  tone: "approval",
  kind: "approval.requested",
  summary: "Command approval requested",
  payload: {
    requestId: REQUEST_ID,
    requestKind: "command",
    detail: "Bash: rm -rf build",
    runtimeSessionId: RUNTIME,
    approvalIdentity: IDENTITY,
  },
  turnId: TURN,
  sequence: 1,
  createdAt: NOW_ISO,
};

async function mountThreadWaitingOnApproval(options: { readonly failDecline?: boolean }) {
  const base = createSnapshotForTargetUser({
    targetMessageId: "msg-redirect-existing" as MessageId,
    targetText: "Existing turn",
    sessionStatus: "running",
  });
  const snapshot: OrchestrationReadModel = {
    ...base,
    threads: base.threads.map((thread) =>
      Object.assign({}, thread, {
        activities: [approvalRequested],
        session: {
          ...thread.session!,
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeSessionId: RuntimeSessionId.make(RUNTIME),
          activeTurnId: TURN,
        },
      }),
    ),
  };
  const thread = snapshot.threads.find((candidate) => candidate.id === THREAD_ID)!;
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
  await waitForComposerEditor();
  const commands: RecordedCommand[] = [];
  const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
  const dispatchCommand: EnvironmentApi["orchestration"]["dispatchCommand"] = async (command) => {
    commands.push(command as unknown as RecordedCommand);
    if (options.failDecline && command.type === "thread.approval.respond") {
      throw new Error("Approval is no longer pending.");
    }
    return { sequence: snapshot.snapshotSequence + 1 };
  };
  __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
    ...api,
    orchestration: { ...api.orchestration, dispatchCommand },
  });
  return {
    declines: () => commands.filter((command) => command.type === "thread.approval.respond"),
    steers: () => commands.filter((command) => command.type === "thread.turn.steer"),
    /** The node projects the provider taking the decline: the approval leaves the list. */
    settleApproval: () =>
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThreadWindow, {
        kind: "snapshot",
        snapshot: toThreadWindowSnapshot(snapshot.snapshotSequence + 10, {
          ...thread,
          activities: [
            approvalRequested,
            {
              id: "approval-settled:redirect" as EventId,
              tone: "info",
              kind: "approval.resolved",
              summary: "Approval response delivered",
              payload: {
                requestId: REQUEST_ID,
                runtimeSessionId: RUNTIME,
                approvalIdentity: IDENTITY,
                decision: "decline",
              },
              turnId: null,
              sequence: 2,
              createdAt: NOW_ISO,
            },
          ],
        }),
      }),
    cleanup: async () => {
      useMessageQueueStore.getState().clear(THREAD_KEY);
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    },
  };
}

async function sendFromComposer(text: string, options: { readonly invert?: boolean } = {}) {
  useComposerDraftStore.getState().setPrompt(THREAD_REF, text);
  await waitForComposerText(text);
  const editor = await waitForComposerEditor();
  editor.focus();
  const mac = isMacPlatform(navigator.platform);
  editor.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: options.invert === true && mac,
      ctrlKey: options.invert === true && !mac,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const queued = () => useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY] ?? [];
const draftPrompt = () => useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt;

describe("ChatView sending while an approval waits (full app)", () => {
  setupChatViewBrowserSuite();

  it("keeps the composer usable and redirects: declines first, steers once that settled", async () => {
    const harness = await mountThreadWaitingOnApproval({});
    try {
      const editor = await waitForComposerEditor();
      expect(editor.getAttribute("contenteditable")).toBe("true");
      await vi.waitFor(() =>
        expect(editor.getAttribute("aria-placeholder") ?? editor.textContent).toContain(
          "Send a message to decline and redirect",
        ),
      );
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Use the cache instead");
      await expect
        .element(page.getByRole("button", { name: "Decline and redirect" }))
        .toBeEnabled();

      await sendFromComposer("Use the cache instead");
      await vi.waitFor(() => expect(harness.declines()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(harness.declines()[0]).toMatchObject({
        requestId: REQUEST_ID,
        decision: "decline",
        approvalIdentity: IDENTITY,
      });
      // Nothing is steered before the provider took the decline.
      await waitForLayout();
      expect(harness.steers()).toEqual([]);
      expect(queued()).toEqual([]);

      harness.settleApproval();
      await vi.waitFor(() => expect(harness.steers()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(harness.steers()[0]).toMatchObject({
        expectedTurnId: TURN,
        message: { text: "Use the cache instead" },
      });
      await waitForComposerText("");
    } finally {
      await harness.cleanup();
    }
  });

  it("sends nothing and keeps the draft when the decline is refused", async () => {
    const harness = await mountThreadWaitingOnApproval({ failDecline: true });
    try {
      await sendFromComposer("Try another way");
      await expect.element(page.getByText("Couldn't decline the approval")).toBeVisible();
      expect(harness.steers()).toEqual([]);
      expect(queued()).toEqual([]);
      expect(draftPrompt()).toBe("Try another way");
    } finally {
      await harness.cleanup();
    }
  });

  it("sends nothing when the draft changed while the decline settled", async () => {
    const harness = await mountThreadWaitingOnApproval({});
    try {
      await sendFromComposer("First thought");
      await vi.waitFor(() => expect(harness.declines()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Second thought");
      await waitForComposerText("Second thought");
      harness.settleApproval();
      await expect.element(page.getByText("Approval declined, message not sent")).toBeVisible();
      expect(harness.steers()).toEqual([]);
      expect(queued()).toEqual([]);
      expect(draftPrompt()).toBe("Second thought");
    } finally {
      await harness.cleanup();
    }
  });

  it("queues with the alternate shortcut and leaves the approval alone", async () => {
    const harness = await mountThreadWaitingOnApproval({});
    try {
      await sendFromComposer("After you're done", { invert: true });
      await vi.waitFor(() => expect(queued()).toHaveLength(1), { timeout: 8_000, interval: 16 });
      await waitForLayout();
      expect(harness.declines()).toEqual([]);
      expect(harness.steers()).toEqual([]);
      await expect.element(page.getByRole("button", { name: "Approve once" })).toBeEnabled();
    } finally {
      await harness.cleanup();
    }
  });
});
