import {
  CheckpointRef,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  TurnId,
  type ClientOrchestrationCommand,
  type OrchestrationReadModel,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { setGitStatusForTests } from "../../test/gitStatusStateMock";
import { useComposerDraftStore } from "../composerDraftStore";
import { __setEnvironmentApiOverrideForTests, readEnvironmentApi } from "../environmentApi";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  THREAD_ID,
  THREAD_REF,
  clickEnabledButton,
  createSnapshotForTargetUser,
  fixture,
  isoAt,
  mountChatView,
  rpcHarness,
  serverThreadPath,
  setupChatViewBrowserSuite,
  toThreadWindowSnapshot,
  waitForComposerEditor,
  waitForComposerText,
  waitForElement,
  waitForServerConfigToApply,
  waitForURL,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const TURN_1 = TurnId.make("turn-edit-1");
const TURN_2 = TurnId.make("turn-edit-2");
const USER_1 = MessageId.make("msg-edit-user-1");
const REPLY_1 = MessageId.make("msg-edit-reply-1");
const USER_2 = MessageId.make("msg-edit-user-2");
const REPLY_2 = MessageId.make("msg-edit-reply-2");
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

type ReadModelThread = OrchestrationReadModel["threads"][number];

function message(input: {
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId: TurnId | null;
  readonly offsetSeconds: number;
  readonly attachments?: ReadModelThread["messages"][number]["attachments"];
}): ReadModelThread["messages"][number] {
  return {
    id: input.id,
    role: input.role,
    text: input.text,
    turnId: input.turnId,
    streaming: false,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    createdAt: isoAt(input.offsetSeconds),
    updatedAt: isoAt(input.offsetSeconds + 1),
  };
}

function checkpoint(turnId: TurnId, count: number, reply: MessageId, offsetSeconds: number) {
  return {
    turnId,
    checkpointTurnCount: count,
    checkpointRef: CheckpointRef.make(`refs/ryco/checkpoints/thread/turn/${count}`),
    status: "ready" as const,
    files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
    assistantMessageId: reply,
    completedAt: isoAt(offsetSeconds),
  };
}

/** Two completed turns with checkpoints; the second prompt carries an image. */
function createThreadSnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: MessageId.make("msg-edit-unused"),
    targetText: "unused",
  });
  const thread = snapshot.threads[0]!;
  return {
    ...snapshot,
    threads: [
      {
        ...thread,
        messages: [
          message({
            id: USER_1,
            role: "user",
            text: "Plan the refactor",
            turnId: null,
            offsetSeconds: 0,
          }),
          message({
            id: REPLY_1,
            role: "assistant",
            text: "Here is the plan.",
            turnId: TURN_1,
            offsetSeconds: 5,
          }),
          message({
            id: USER_2,
            role: "user",
            text: "Now split the auth module",
            turnId: null,
            offsetSeconds: 10,
            attachments: [
              {
                type: "image",
                id: "attachment-edit-1",
                name: "sketch.png",
                mimeType: "image/png",
                sizeBytes: IMAGE_BYTES.length,
              },
            ],
          }),
          message({
            id: REPLY_2,
            role: "assistant",
            text: "Done, the module is split.",
            turnId: TURN_2,
            offsetSeconds: 15,
          }),
        ],
        latestTurn: {
          turnId: TURN_2,
          state: "completed",
          requestedAt: isoAt(10),
          startedAt: isoAt(10),
          completedAt: isoAt(16),
          assistantMessageId: REPLY_2,
        },
        checkpoints: [checkpoint(TURN_1, 1, REPLY_1, 6), checkpoint(TURN_2, 2, REPLY_2, 16)],
      },
    ],
  };
}

const REPO_STATUS = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
} as const;

async function mountThread(input: { readonly conversationRevert: boolean }) {
  setGitStatusForTests(REPO_STATUS);
  const mounted = await mountChatView({
    viewport: DEFAULT_VIEWPORT,
    snapshot: createThreadSnapshot(),
    configureFixture: (nextFixture) => {
      nextFixture.serverConfig = {
        ...nextFixture.serverConfig,
        environment: {
          ...nextFixture.serverConfig.environment,
          capabilities: {
            ...nextFixture.serverConfig.environment.capabilities,
            ...(input.conversationRevert ? { conversationRevert: true } : {}),
          },
        },
      };
    },
  });
  await waitForServerConfigToApply();
  await waitForComposerEditor();
  return mounted;
}

/** Records dispatched commands and serves the image's bytes over the attachment transport. */
function interceptNode() {
  const commands: ClientOrchestrationCommand[] = [];
  const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
  __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
    ...api,
    orchestration: {
      ...api.orchestration,
      dispatchCommand: async (command) => {
        commands.push(command);
        return { sequence: fixture.snapshot.snapshotSequence + 1 };
      },
    },
    attachments: {
      ...api.attachments,
      readChunk: async (input) => ({
        dataBase64: btoa(String.fromCharCode(...IMAGE_BYTES)),
        offset: input.offset,
        totalBytes: IMAGE_BYTES.length,
      }),
    },
  });
  return {
    reverts: () =>
      commands.filter(
        (command) =>
          command.type === "thread.conversation.revert" ||
          command.type === "thread.checkpoint.revert",
      ),
  };
}

let windowSequence = 100;
/**
 * The node finishes the revert: the dropped turn leaves, and its journal row says how it
 * ended. A node from before the journal (`journal: false`) only rewinds the thread.
 */
function emitRevertOutcome(
  commandId: string,
  status: "completed" | "failed",
  options: {
    readonly restoreFiles?: false;
    readonly detail?: string;
    readonly journal?: false;
  } = {},
) {
  const thread = fixture.snapshot.threads[0]!;
  const reverted = status === "completed";
  windowSequence += 1;
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThreadWindow, {
    kind: "snapshot",
    snapshot: toThreadWindowSnapshot(windowSequence, {
      ...thread,
      messages: reverted ? thread.messages.slice(0, 2) : thread.messages,
      checkpoints: reverted ? thread.checkpoints.slice(0, 1) : thread.checkpoints,
      latestTurn: reverted
        ? { ...thread.latestTurn!, turnId: TURN_1, assistantMessageId: REPLY_1 }
        : thread.latestTurn,
      activities:
        options.journal === false
          ? []
          : [
              {
                id: EventId.make(`checkpoint-revert:${commandId}`),
                tone: reverted ? "info" : "error",
                kind: "checkpoint.revert",
                summary: reverted ? "Reverted to checkpoint 1" : "Revert failed",
                payload: {
                  schemaVersion: 1,
                  revertRequestId: commandId,
                  turnCount: 1,
                  status,
                  ...(options.restoreFiles === false ? { restoreFiles: false } : {}),
                  ...(options.detail ? { detail: options.detail } : {}),
                },
                turnId: null,
                createdAt: isoAt(30),
              },
            ],
    }),
  });
}

async function openEditFromHere(messageId: MessageId) {
  const button = await waitForElement(
    () =>
      document
        .querySelector(`[data-message-id="${messageId}"]`)
        ?.querySelector<HTMLButtonElement>('button[aria-label="Edit from here"]') ?? null,
    "Unable to find Edit from here.",
  );
  await clickEnabledButton(button, "Edit from here stayed disabled.");
  await expect.element(page.getByText("Edit from here?")).toBeVisible();
}

function composerDraft() {
  return useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
}

describe("Edit from here (full app)", () => {
  setupChatViewBrowserSuite();

  it("rewinds the conversation, keeps the files, and returns the prompt and image", async () => {
    const mounted = await mountThread({ conversationRevert: true });
    try {
      const node = interceptNode();
      await openEditFromHere(USER_2);
      await page.getByRole("button", { name: "Revert and keep changes" }).click();

      await vi.waitFor(() => expect(node.reverts()).toHaveLength(1));
      const [command] = node.reverts();
      expect(command).toMatchObject({ type: "thread.conversation.revert", turnCount: 1 });
      // Nothing returns before the node has rewound the thread.
      expect(composerDraft()?.prompt ?? "").toBe("");

      emitRevertOutcome(command!.commandId, "completed", {
        restoreFiles: false,
        detail: "The removed turns' changes stay in src/app.ts.",
      });
      await vi.waitFor(() => expect(composerDraft()?.prompt).toBe("Now split the auth module"));
      expect(composerDraft()?.images.map((image) => [image.type, image.name])).toEqual([
        ["image", "sketch.png"],
      ]);
      expect(composerDraft()?.images[0]?.file?.size).toBe(IMAGE_BYTES.length);
      // The revert's row stays out of the timeline, so the kept files show in a toast.
      await expect
        .element(page.getByText("The removed turns' changes stay in src/app.ts."))
        .toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("restores the files too when asked, and keeps an unsent draft first", async () => {
    const mounted = await mountThread({ conversationRevert: true });
    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Unsent idea");
      const node = interceptNode();
      await openEditFromHere(USER_2);
      await page.getByRole("button", { name: "Revert files too" }).click();

      await vi.waitFor(() => expect(node.reverts()).toHaveLength(1));
      const [command] = node.reverts();
      expect(command).toMatchObject({ type: "thread.checkpoint.revert", turnCount: 1 });
      emitRevertOutcome(command!.commandId, "completed");
      await vi.waitFor(() =>
        expect(composerDraft()?.prompt).toBe("Unsent idea\n\nNow split the auth module"),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a draft typed in a view that remounted while the revert waited", async () => {
    const mounted = await mountThread({ conversationRevert: true });
    try {
      const node = interceptNode();
      await openEditFromHere(USER_2);
      await page.getByRole("button", { name: "Revert and keep changes" }).click();
      await vi.waitFor(() => expect(node.reverts()).toHaveLength(1));

      // Leaving for another page unmounts the view that started the revert.
      await mounted.router.navigate({ to: "/settings" });
      await waitForURL(mounted.router, (path) => path === "/settings", "Settings should open.");
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="composer-editor"]')).toBeNull(),
      );
      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(THREAD_ID),
        "The thread should open again.",
      );
      await page.getByTestId("composer-editor").fill("also fix the tests");
      await waitForComposerText("also fix the tests");

      emitRevertOutcome(node.reverts()[0]!.commandId, "completed", { restoreFiles: false });
      await vi.waitFor(() =>
        expect(composerDraft()?.prompt).toBe("also fix the tests\n\nNow split the auth module"),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves the composer alone when the node refuses the revert", async () => {
    const mounted = await mountThread({ conversationRevert: true });
    try {
      const node = interceptNode();
      await openEditFromHere(USER_2);
      await page.getByRole("button", { name: "Revert and keep changes" }).click();
      await vi.waitFor(() => expect(node.reverts()).toHaveLength(1));

      const editButton = () =>
        document
          .querySelector(`[data-message-id="${USER_2}"]`)
          ?.querySelector<HTMLButtonElement>('button[aria-label="Edit from here"]');
      await vi.waitFor(() => expect(editButton()?.disabled).toBe(true));
      emitRevertOutcome(node.reverts()[0]!.commandId, "failed", {
        detail: 'Nothing was changed. "Neighbour" is working in this checkout.',
      });
      // The verdict ends the wait: the message stays, and so does the empty composer.
      await vi.waitFor(() => expect(editButton()?.disabled).toBe(false));
      expect(composerDraft()?.prompt ?? "").toBe("");
      expect(composerDraft()?.images ?? []).toEqual([]);
      // The node's reason shows, though its row stays out of the timeline.
      await expect
        .element(
          page.getByText('Nothing was changed. "Neighbour" is working in this checkout.').first(),
        )
        .toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends nothing when cancelled", async () => {
    const mounted = await mountThread({ conversationRevert: true });
    try {
      const node = interceptNode();
      await openEditFromHere(USER_2);
      await page.getByRole("button", { name: "Cancel" }).click();
      await vi.waitFor(() =>
        expect(document.body.textContent ?? "").not.toContain("Edit from here?"),
      );
      expect(node.reverts()).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers only the file restore on a node without conversation-only reverts", async () => {
    const mounted = await mountThread({ conversationRevert: false });
    try {
      const node = interceptNode();
      await openEditFromHere(USER_2);
      expect(document.body.textContent ?? "").not.toContain("Revert and keep changes");
      await page.getByRole("button", { name: "Revert files", exact: true }).click();

      await vi.waitFor(() => expect(node.reverts()).toHaveLength(1));
      expect(node.reverts()[0]).toMatchObject({ type: "thread.checkpoint.revert" });
      // A node from before the revert journal only rewinds the thread; that is its verdict.
      emitRevertOutcome(node.reverts()[0]!.commandId, "completed", { journal: false });
      await vi.waitFor(() => expect(composerDraft()?.prompt).toBe("Now split the auth module"));
    } finally {
      await mounted.cleanup();
    }
  });
});
