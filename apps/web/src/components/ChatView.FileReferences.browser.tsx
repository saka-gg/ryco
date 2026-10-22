import {
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
} from "@ryco/contracts";
import {
  composeOutgoingPrompt,
  createFileReference,
  type FileReference,
} from "@ryco/client-runtime/state/composer";
import { describe, expect, it, vi } from "vite-plus/test";

import { composerContextIntake } from "../composerContextIntake";
import { useComposerDraftStore } from "../composerDraftStore";
import { endWorkspaceFileDrag, startWorkspaceFileDrag } from "../workspaceFileDrag";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  THREAD_KEY,
  THREAD_REF,
  createSnapshotForTargetUser,
  createUserMessage,
  fixture,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
  waitForComposerText,
  waitForLayout,
  wsRequests,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

function lines(path: string, lineStart: number, comment?: string): FileReference {
  const reference = createFileReference({
    path,
    lineStart,
    lineEnd: lineStart + 1,
    side: "new",
    lines: ["for (const item of items) {", "  run(item);"],
    comment,
  });
  if (!reference) throw new Error("Expected a file reference.");
  return reference;
}

function deliver(reference: FileReference): boolean {
  return composerContextIntake.deliver(THREAD_REF, { kind: "file-reference", reference });
}

function draftReferences() {
  return useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.fileReferences ?? [];
}

async function waitForChipLabels(expected: ReadonlyArray<string>): Promise<void> {
  await vi.waitFor(
    () => {
      const labels = [
        ...document.querySelectorAll<HTMLElement>(
          "[data-chat-composer-form] [data-file-reference-chip]",
        ),
      ].map((element) => element.textContent?.trim());
      expect(labels).toEqual(expected);
    },
    { timeout: 8_000, interval: 16 },
  );
}

function snapshotWithUserText(text: string): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: MessageId.make("msg-file-reference-target"),
    targetText: "unused",
  });
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      Object.assign({}, thread, {
        messages: [
          createUserMessage({
            id: MessageId.make("msg-file-reference-user"),
            text,
            offsetSeconds: 0,
          }),
          {
            id: MessageId.make("msg-file-reference-reply"),
            role: "assistant" as const,
            text: "It runs once per item.",
            turnId: null,
            streaming: false,
            createdAt: snapshot.threads[0]!.createdAt,
            updatedAt: snapshot.threads[0]!.createdAt,
          },
        ],
      }),
    ),
  };
}

function dragFileOnto(
  target: Element,
  type: "dragover" | "drop",
  payload: { readonly environmentId: EnvironmentId; readonly workspaceRoot: string },
): DragEvent {
  const transfer = new DataTransfer();
  startWorkspaceFileDrag(transfer, { ...payload, path: "src/lib/app.ts" });
  const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
  target.dispatchEvent(event);
  return event;
}

describe("ChatView file references", () => {
  setupChatViewBrowserSuite();

  it("takes lines a panel hands in as chips, updates repeats, and removes them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.make("msg-file-reference-chips"),
        targetText: "chips",
      }),
    });
    try {
      await waitForComposerEditor();
      // The mounted composer is what makes the panels offer "Add to chat".
      await vi.waitFor(() => expect(composerContextIntake.canDeliver(THREAD_REF)).toBe(true));

      expect(deliver(lines("src/app.ts", 12, "Why twice?"))).toBe(true);
      expect(deliver(lines("src/other.ts", 3))).toBe(true);
      await waitForChipLabels(["app.ts:12-13", "other.ts:3-4"]);

      // The same lines again replace the chip's note instead of adding a second chip.
      expect(deliver(lines("src/app.ts", 12, "Still twice?"))).toBe(true);
      await waitForChipLabels(["app.ts:12-13", "other.ts:3-4"]);
      expect(draftReferences()[0]?.comment).toBe("Still twice?");

      const remove = document.querySelector<HTMLButtonElement>(
        '[data-chat-composer-form] button[aria-label="Remove other.ts:3-4"]',
      );
      expect(remove).not.toBeNull();
      remove!.click();
      await waitForChipLabels(["app.ts:12-13"]);
    } finally {
      await mounted.cleanup();
    }
    // Unmounting releases the registration, so the panels stop offering the action.
    expect(composerContextIntake.canDeliver(THREAD_REF)).toBe(false);
  });

  it("sends the references with the prompt and shows them as chips on the sent message", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.make("msg-file-reference-send"),
        targetText: "send",
      }),
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? { sequence: fixture.snapshot.snapshotSequence + 1 }
          : undefined,
    });
    const turnStarts = () =>
      wsRequests.filter(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          request.type === "thread.turn.start",
      ) as unknown as ReadonlyArray<{ readonly message: { readonly text: string } }>;
    try {
      await waitForComposerEditor();
      await vi.waitFor(() => expect(composerContextIntake.canDeliver(THREAD_REF)).toBe(true));
      const reference = lines("src/app.ts", 12, "Why twice?");
      expect(deliver(reference)).toBe(true);
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Explain this loop");
      await waitForComposerText("Explain this loop");

      const editor = await waitForComposerEditor();
      editor.focus();
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() => expect(turnStarts()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(turnStarts()[0]?.message.text).toBe(
        composeOutgoingPrompt({ prompt: "Explain this loop", fileReferences: [reference] }),
      );
      // The send cleared the chips with the prompt.
      await waitForChipLabels([]);
      expect(draftReferences()).toEqual([]);

      // The sent message shows the chip, not the raw block.
      await vi.waitFor(
        () => {
          expect(
            document.querySelector("[data-user-message-file-references] [data-file-reference-chip]")
              ?.textContent,
          ).toContain("app.ts:12-13");
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.body.textContent ?? "").not.toContain("<file_context>");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a sent block as chips and recalls the prompt without it", async () => {
    const sent = composeOutgoingPrompt({
      prompt: "Why does this run twice?",
      fileReferences: [lines("src/app.ts", 12, "Here")],
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithUserText(sent),
    });
    try {
      await vi.waitFor(
        () => expect(document.body.textContent ?? "").toContain("Why does this run twice?"),
        { timeout: 8_000, interval: 16 },
      );
      expect(document.body.textContent ?? "").not.toContain("<file_context>");
      expect(
        document.querySelector("[data-user-message-file-references] [data-file-reference-chip]")
          ?.textContent,
      ).toContain("app.ts:12-13");

      const editor = await waitForComposerEditor();
      editor.focus();
      const event = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(event);
      await waitForLayout();
      expect(event.defaultPrevented).toBe(true);
      await waitForComposerText("Why does this run twice?");
      // ArrowUp brings back the text only; the references are not re-added.
      expect(draftReferences()).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not recall a prompt into a composer that holds a reference", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithUserText("An earlier prompt"),
    });
    try {
      await waitForComposerEditor();
      await vi.waitFor(() => expect(composerContextIntake.canDeliver(THREAD_REF)).toBe(true));
      expect(deliver(lines("src/app.ts", 1))).toBe(true);
      await waitForChipLabels(["app.ts:1-2"]);
      const editor = await waitForComposerEditor();
      editor.focus();
      const event = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(event);
      await waitForLayout();
      expect(event.defaultPrevented).toBe(false);
      await waitForComposerText("");
    } finally {
      await mounted.cleanup();
    }
  });

  it("mentions a file dropped from the Files tree, and refuses one of another workspace", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.make("msg-file-reference-drop"),
        targetText: "drop",
      }),
    });
    try {
      const editor = await waitForComposerEditor();
      const zone = editor.closest("[data-thread-mention-drop]");
      expect(zone).not.toBeNull();
      const here = { environmentId: LOCAL_ENVIRONMENT_ID, workspaceRoot: "/repo/project" };

      expect(dragFileOnto(editor, "dragover", here).defaultPrevented).toBe(true);
      await vi.waitFor(() =>
        expect(document.querySelector("[data-composer-mention-drop-hint]")?.textContent).toBe(
          "Mention file",
        ),
      );
      const drop = dragFileOnto(editor, "drop", here);
      // The browser's own drop would paste the path as text: the composer takes it instead.
      expect(drop.defaultPrevented).toBe(true);
      await vi.waitFor(
        () =>
          expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe(
            "@src/lib/app.ts ",
          ),
        { timeout: 8_000, interval: 16 },
      );
      expect(document.querySelector("[data-composer-mention-drop-hint]")).toBeNull();

      const elsewhere = { environmentId: LOCAL_ENVIRONMENT_ID, workspaceRoot: "/repo/other" };
      expect(dragFileOnto(editor, "dragover", elsewhere).defaultPrevented).toBe(false);
      await vi.waitFor(() =>
        expect(document.querySelector("[data-composer-mention-drop-hint]")?.textContent).toBe(
          "This file is in another workspace",
        ),
      );
      dragFileOnto(editor, "drop", elsewhere);
      await waitForLayout();
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe(
        "@src/lib/app.ts ",
      );

      const remote = {
        environmentId: EnvironmentId.make("other-node"),
        workspaceRoot: "/repo/project",
      };
      dragFileOnto(editor, "drop", remote);
      await waitForLayout();
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe(
        "@src/lib/app.ts ",
      );
    } finally {
      endWorkspaceFileDrag();
      await mounted.cleanup();
    }
  });
});
