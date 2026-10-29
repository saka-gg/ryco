import {
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  type EnvironmentApi,
  type FollowUpQueueHold,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type QueuedFollowUp,
  type ThreadFollowUpQueue,
  type TurnId,
} from "@ryco/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@ryco/contracts/settings";
import { selectThreadFollowUpQueue } from "@ryco/client-runtime/state/message-queue";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
  readEnvironmentApi,
} from "../environmentApi";
import { useMessageQueueStore } from "../messageQueueStore";
import { useStore } from "../store";
import {
  setupChatViewBrowserSuite,
  createSnapshotForTargetUser,
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  mountChatView,
  THREAD_ID,
  THREAD_KEY,
  THREAD_REF,
  waitForComposerEditor,
  waitForComposerText,
  waitForLayout,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

setupChatViewBrowserSuite();

const AT = "2026-10-01T10:00:00.000Z";
const RUNNING_TURN = "server-queue-turn" as TurnId;

type RecordedCommand = { readonly type: string; readonly commandId?: string } & Record<
  string,
  unknown
>;

function nodeEntry(id: string, overrides: Partial<QueuedFollowUp> = {}): QueuedFollowUp {
  return {
    messageId: MessageId.make(id),
    text: `Queued on the node: ${id}`,
    attachments: [],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
    status: "queued",
    author: "user",
    ...overrides,
  };
}

let sequence = 1_000;
/** Applies a node's queue event to the store, as its thread stream would. */
function emitQueueEvent(type: OrchestrationEvent["type"], payload: object): void {
  sequence += 1;
  useStore.getState().applyOrchestrationEvents(
    [
      {
        sequence,
        eventId: EventId.make(`server-queue-event-${sequence}`),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: AT,
        commandId: CommandId.make(`server-queue-command-${sequence}`),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type,
        payload: { threadId: THREAD_ID, ...payload },
      } as OrchestrationEvent,
    ],
    LOCAL_ENVIRONMENT_ID,
  );
}

/**
 * A running, steerable thread. `serverQueue`: its node keeps follow-up queues and starts with
 * `followUpQueue`. Commands are recorded; the node's answer to a queue add is its event.
 */
async function mountBusyThread(options: {
  readonly serverQueue: boolean;
  readonly followUpQueue?: ThreadFollowUpQueue;
  readonly refuseAdd?: string;
}) {
  localStorage.setItem(
    "ryco:client-settings:v1",
    JSON.stringify({
      ...DEFAULT_CLIENT_SETTINGS,
      followUpBehavior: "queue",
      sendShortcut: "enter",
    }),
  );
  const base = createSnapshotForTargetUser({
    targetMessageId: "msg-server-queue-existing" as MessageId,
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
        activeTurnId: RUNNING_TURN,
      },
      ...(options.followUpQueue ? { followUpQueue: options.followUpQueue } : {}),
    })),
  };
  const mounted = await mountChatView({
    viewport: DEFAULT_VIEWPORT,
    snapshot,
    configureFixture: (value) => {
      value.serverConfig = {
        ...value.serverConfig,
        environment: {
          ...value.serverConfig.environment,
          capabilities: {
            ...value.serverConfig.environment.capabilities,
            ...(options.serverQueue ? { serverFollowUpQueue: true as const } : {}),
          },
        },
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
    if (command.type === "thread.queue.add") {
      if (options.refuseAdd) throw new Error(options.refuseAdd);
      emitQueueEvent("thread.queue-entry-added", {
        entry: nodeEntry(command.entry.messageId, { text: command.entry.text }),
        beforeMessageId: null,
      });
    }
    return { sequence: snapshot.snapshotSequence + 1 };
  };
  __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
    ...api,
    orchestration: { ...api.orchestration, dispatchCommand },
  });
  return {
    commands,
    ofType: (type: string) => commands.filter((command) => command.type === type),
    cleanup: async () => {
      useMessageQueueStore.getState().clear(THREAD_KEY);
      __resetEnvironmentApiOverridesForTests();
      localStorage.removeItem("ryco:client-settings:v1");
      await mounted.cleanup();
    },
  };
}

async function submit(text: string) {
  useComposerDraftStore.getState().setPrompt(THREAD_REF, text);
  await waitForComposerText(text);
  const editor = await waitForComposerEditor();
  editor.focus();
  editor.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
}

const nodeQueue = () => selectThreadFollowUpQueue(useStore.getState(), THREAD_REF);

describe("ChatView with a node that keeps the follow-up queue", () => {
  it("queues a send while the thread is busy on the node, not in this tab", async () => {
    const harness = await mountBusyThread({ serverQueue: true });
    try {
      await submit("Fix the failing tests");
      await vi.waitFor(() => expect(harness.ofType("thread.queue.add")).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(harness.ofType("thread.queue.add")[0]).toMatchObject({
        threadId: THREAD_ID,
        entry: { text: "Fix the failing tests", runtimeMode: "full-access" },
      });
      expect(harness.ofType("thread.turn.start")).toEqual([]);
      expect(useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY] ?? []).toEqual([]);
      await waitForComposerText("");
      await expect
        .element(page.getByRole("button", { name: /^Edit queued message 1 of 1: Fix the/ }))
        .toBeVisible();
    } finally {
      await harness.cleanup();
    }
  });

  it("gives a message the node refused back to the composer", async () => {
    const harness = await mountBusyThread({
      serverQueue: true,
      refuseAdd: "The queue is full (20 follow-ups).",
    });
    try {
      await submit("Twenty-first follow-up");
      await vi.waitFor(() => expect(harness.ofType("thread.queue.add")).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      await waitForComposerText("Twenty-first follow-up");
      await expect.element(page.getByText("The queue is full (20 follow-ups).")).toBeVisible();
      expect(document.querySelector("[data-queued-message-source]")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("edits the node's entry in the composer and saves it at the revision shown", async () => {
    const harness = await mountBusyThread({
      serverQueue: true,
      followUpQueue: { entries: [nodeEntry("node-entry", { revision: 2 })], hold: null },
    });
    try {
      const edit = page.getByRole("button", { name: /^Edit queued message 1 of 1/ });
      await expect.element(edit).toBeEnabled();
      await edit.click();
      await waitForComposerText("Queued on the node: node-entry");
      await expect.element(page.getByText("Editing")).toBeVisible();

      await submit("Queued on the node, edited");
      await vi.waitFor(() => expect(harness.ofType("thread.queue.edit")).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(harness.ofType("thread.queue.edit")[0]).toMatchObject({
        messageId: "node-entry",
        expectedRevision: 2,
        text: "Queued on the node, edited",
      });
      expect(harness.ofType("thread.queue.add")).toEqual([]);
      expect(harness.ofType("thread.turn.start")).toEqual([]);
      await waitForComposerText("");
    } finally {
      await harness.cleanup();
    }
  });

  it("steers the node's entry into the running turn", async () => {
    const harness = await mountBusyThread({
      serverQueue: true,
      followUpQueue: { entries: [nodeEntry("steer-me")], hold: null },
    });
    try {
      const steer = page.getByRole("button", {
        name: /Steer queued message.*into the active turn/,
      });
      await expect.element(steer).toBeEnabled();
      await steer.click();
      await vi.waitFor(() => expect(harness.ofType("thread.queue.steer")).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(harness.ofType("thread.queue.steer")[0]).toMatchObject({
        messageId: "steer-me",
        expectedTurnId: RUNNING_TURN,
      });
      expect(harness.ofType("thread.turn.steer")).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("resumes the node's held queue with the causes it showed", async () => {
    const hold: FollowUpQueueHold = {
      reason: "interrupted",
      detail: null,
      causeKeys: ["interrupt:turn-0"],
      heldAt: AT,
    };
    const harness = await mountBusyThread({
      serverQueue: true,
      followUpQueue: { entries: [nodeEntry("held")], hold },
    });
    try {
      const resume = page.getByRole("button", { name: "Resume queued messages" });
      await expect.element(resume).toBeVisible();
      await resume.click();
      await vi.waitFor(() => expect(harness.ofType("thread.queue.resume")).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(harness.ofType("thread.queue.resume")[0]).toMatchObject({
        acknowledgeCauseKeys: ["interrupt:turn-0"],
      });
      emitQueueEvent("thread.queue-released", {
        acknowledgedCauseKeys: hold.causeKeys,
        updatedAt: AT,
      });
      await vi.waitFor(() => expect(nodeQueue()?.hold).toBeNull());
      await expect
        .element(page.getByRole("button", { name: "Pause queued messages" }))
        .toBeVisible();
    } finally {
      await harness.cleanup();
    }
  });

  it("holds the node's queue when the person stops the turn", async () => {
    const harness = await mountBusyThread({
      serverQueue: true,
      followUpQueue: { entries: [nodeEntry("after-stop")], hold: null },
    });
    try {
      await page.getByRole("button", { name: "Stop generation" }).click();
      await vi.waitFor(() => expect(harness.ofType("thread.turn.interrupt")).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(harness.ofType("thread.turn.interrupt")[0]).toMatchObject({ holdQueue: true });
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps this tab's queue on a node without the capability", async () => {
    const harness = await mountBusyThread({ serverQueue: false });
    try {
      await submit("Queued in this tab");
      await vi.waitFor(
        () => expect(useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY]).toHaveLength(1),
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();
      expect(harness.ofType("thread.queue.add")).toEqual([]);
      await page.getByRole("button", { name: "Stop generation" }).click();
      await vi.waitFor(() => expect(harness.ofType("thread.turn.interrupt")).toHaveLength(1));
      expect(harness.ofType("thread.turn.interrupt")[0]).not.toHaveProperty("holdQueue");
    } finally {
      await harness.cleanup();
    }
  });
});
