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
import { APPROVAL_REDIRECT_MIN_VISIBLE_MS } from "@ryco/client-runtime/state/composer";
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
const IDENTITY = { requestEventId: `activity-${REQUEST_ID}`, runtimeSessionId: RUNTIME };

function approvalRequestedActivity(requestId: string, sequence: number) {
  const activity: OrchestrationThreadActivity = {
    id: `activity-${requestId}` as EventId,
    tone: "approval",
    kind: "approval.requested",
    summary: "Command approval requested",
    payload: {
      requestId,
      requestKind: "command",
      detail: "Bash: rm -rf build",
      runtimeSessionId: RUNTIME,
      approvalIdentity: { requestEventId: `activity-${requestId}`, runtimeSessionId: RUNTIME },
    },
    turnId: TURN,
    sequence,
    createdAt: NOW_ISO,
  };
  return activity;
}

function approvalResolvedActivity(requestId: string, sequence: number) {
  const activity: OrchestrationThreadActivity = {
    id: `approval-settled:${requestId}` as EventId,
    tone: "info",
    kind: "approval.resolved",
    summary: "Approval response delivered",
    payload: {
      requestId,
      runtimeSessionId: RUNTIME,
      approvalIdentity: { requestEventId: `activity-${requestId}`, runtimeSessionId: RUNTIME },
      decision: "decline",
    },
    turnId: null,
    sequence,
    createdAt: NOW_ISO,
  };
  return activity;
}

const approvalRequested = approvalRequestedActivity(REQUEST_ID, 1);

/** A send declines only an approval that has been on screen long enough to have been read. */
const waitUntilApprovalReadable = () =>
  new Promise((resolve) => setTimeout(resolve, APPROVAL_REDIRECT_MIN_VISIBLE_MS + 50));

async function mountThreadWaitingOnApproval(options: {
  readonly failDecline?: boolean;
  /** The session's runtime; another one than the approval's ended it. */
  readonly sessionRuntime?: string;
}) {
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
          runtimeSessionId: RuntimeSessionId.make(options.sessionRuntime ?? RUNTIME),
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
    /**
     * The node projects the provider taking the decline: the approval leaves the list. The
     * activities after it are what the provider did next.
     */
    settleApproval: (next: ReadonlyArray<OrchestrationThreadActivity> = []) =>
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThreadWindow, {
        kind: "snapshot",
        snapshot: toThreadWindowSnapshot(snapshot.snapshotSequence + 10 + next.length, {
          ...thread,
          activities: [approvalRequested, approvalResolvedActivity(REQUEST_ID, 2), ...next],
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

      await waitUntilApprovalReadable();
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

  it("declines the next approval the redirected turn opens, then steers", async () => {
    const harness = await mountThreadWaitingOnApproval({});
    try {
      await waitUntilApprovalReadable();
      await sendFromComposer("Stop running tools");
      await vi.waitFor(() => expect(harness.declines()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      // The provider takes the decline and asks about the next tool of the same batch.
      harness.settleApproval([approvalRequestedActivity("req-next-tool", 3)]);
      await vi.waitFor(() => expect(harness.declines()).toHaveLength(2), {
        timeout: 8_000,
        interval: 16,
      });
      expect(harness.declines()[1]).toMatchObject({
        requestId: "req-next-tool",
        decision: "decline",
      });
      await waitForLayout();
      expect(harness.steers()).toEqual([]);

      harness.settleApproval([
        approvalRequestedActivity("req-next-tool", 3),
        approvalResolvedActivity("req-next-tool", 4),
      ]);
      await vi.waitFor(() => expect(harness.steers()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(harness.steers()[0]).toMatchObject({ message: { text: "Stop running tools" } });
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps the draft when the approval appeared just before the send", async () => {
    const harness = await mountThreadWaitingOnApproval({});
    try {
      await sendFromComposer("Meant for later");
      await expect.element(page.getByText("An approval just arrived")).toBeVisible();
      expect(harness.declines()).toEqual([]);
      expect(queued()).toEqual([]);
      expect(draftPrompt()).toBe("Meant for later");
    } finally {
      await harness.cleanup();
    }
  });

  it("sends nothing and keeps the draft when the decline is refused", async () => {
    const harness = await mountThreadWaitingOnApproval({ failDecline: true });
    try {
      await waitUntilApprovalReadable();
      await sendFromComposer("Try another way");
      await expect.element(page.getByText("Couldn't decline the approval")).toBeVisible();
      expect(harness.steers()).toEqual([]);
      expect(queued()).toEqual([]);
      expect(draftPrompt()).toBe("Try another way");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not send a draft changed while the decline settled, and steers it once resent", async () => {
    const harness = await mountThreadWaitingOnApproval({});
    try {
      await waitUntilApprovalReadable();
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

      // The approval is gone, but the redirect still owns this turn: the resend steers instead
      // of following the queue setting.
      await sendFromComposer("Second thought");
      await vi.waitFor(() => expect(harness.steers()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(harness.steers()[0]).toMatchObject({ message: { text: "Second thought" } });
      expect(harness.declines()).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not offer a redirect for an approval of an ended runtime", async () => {
    const harness = await mountThreadWaitingOnApproval({ sessionRuntime: "runtime-restarted" });
    try {
      const editor = await waitForComposerEditor();
      await vi.waitFor(() =>
        expect(editor.getAttribute("aria-placeholder") ?? editor.textContent).toContain(
          "Queue a follow-up",
        ),
      );
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Carry on");
      await waitForComposerText("Carry on");
      expect(page.getByRole("button", { name: "Decline and redirect" }).elements()).toEqual([]);

      await waitUntilApprovalReadable();
      await sendFromComposer("Carry on");
      await vi.waitFor(() => expect(queued()).toHaveLength(1), { timeout: 8_000, interval: 16 });
      await waitForLayout();
      expect(harness.declines()).toEqual([]);
      expect(harness.steers()).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("queues with the alternate shortcut and leaves the approval alone", async () => {
    const harness = await mountThreadWaitingOnApproval({});
    try {
      await waitUntilApprovalReadable();
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
