import { EnvironmentId, MessageId, ThreadId, type OrchestrationReadModel } from "@ryco/contracts";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  PASTED_TEXT_ATTACHMENT_THRESHOLD,
  appendSelectionQuote,
  appendTerminalContextsToPrompt,
} from "@ryco/client-runtime/state/composer";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { isMacPlatform } from "../lib/utils";
import {
  DEFAULT_VIEWPORT,
  THREAD_KEY,
  THREAD_REF,
  createSnapshotForTargetUser,
  createUserMessage,
  isoAt,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
  waitForComposerText,
  waitForLayout,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const NEWEST_PROMPT = "Run the migration again";

/** A thread whose user prompts are `prompts`, oldest first, each with an assistant reply. */
function snapshotWithPrompts(prompts: ReadonlyArray<string>): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: MessageId.make("msg-user-recall-target"),
    targetText: "unused",
  });
  const messages = prompts.flatMap((text, index) => [
    createUserMessage({
      id: MessageId.make(`msg-recall-user-${index}`),
      text,
      offsetSeconds: index * 6,
    }),
    {
      id: MessageId.make(`msg-recall-assistant-${index}`),
      role: "assistant" as const,
      text: `Reply ${index}`,
      turnId: null,
      streaming: false,
      createdAt: isoAt(index * 6 + 3),
      updatedAt: isoAt(index * 6 + 4),
    },
  ]);
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) => Object.assign({}, thread, { messages })),
  };
}

const PROMPTS = [
  "Explain the failing test",
  appendTerminalContextsToPrompt(`Why does ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} fail?`, [
    {
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 4,
      lineEnd: 5,
      text: "npm test\nFAIL app.test.ts",
    },
  ]),
  appendSelectionQuote("Make it shorter", {
    source: {
      environmentId: EnvironmentId.make("environment-local"),
      threadId: ThreadId.make("t"),
    },
    messageId: MessageId.make("msg-recall-assistant-0"),
    text: "A long explanation.",
  }).trim(),
  NEWEST_PROMPT,
];

async function pressArrow(key: "ArrowUp" | "ArrowDown"): Promise<boolean> {
  const editor = await waitForComposerEditor();
  editor.focus();
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  editor.dispatchEvent(event);
  await waitForLayout();
  return event.defaultPrevented;
}

async function waitForTranscriptText(text: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(document.body.textContent ?? "").toContain(text);
    },
    { timeout: 8_000, interval: 16 },
  );
}

function pasteIntoComposer(editor: HTMLElement, text: string): void {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  editor.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
  );
}

function draftAttachments() {
  return useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.images ?? [];
}

describe("ChatView prompt recall", () => {
  setupChatViewBrowserSuite();

  it("walks back through the thread's prompts with ArrowUp and forward to an empty composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithPrompts(PROMPTS),
    });
    try {
      await waitForTranscriptText(NEWEST_PROMPT);

      expect(await pressArrow("ArrowUp")).toBe(true);
      await waitForComposerText(NEWEST_PROMPT);
      expect(await pressArrow("ArrowUp")).toBe(true);
      // The quoted assistant text the send carried stays out of the recall.
      await waitForComposerText("Make it shorter");
      expect(await pressArrow("ArrowUp")).toBe(true);
      // So do the terminal context and the inline label that stood for it.
      await waitForComposerText("Why does fail?");
      expect(await pressArrow("ArrowUp")).toBe(true);
      await waitForComposerText("Explain the failing test");
      // Past the oldest prompt the key is not claimed.
      expect(await pressArrow("ArrowUp")).toBe(false);
      await waitForComposerText("Explain the failing test");

      expect(await pressArrow("ArrowDown")).toBe(true);
      await waitForComposerText("Why does fail?");
      expect(await pressArrow("ArrowDown")).toBe(true);
      expect(await pressArrow("ArrowDown")).toBe(true);
      await waitForComposerText(NEWEST_PROMPT);
      expect(await pressArrow("ArrowDown")).toBe(true);
      await waitForComposerText("");
      expect(await pressArrow("ArrowDown")).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves the arrows to the caret for a typed draft and once a recall is edited", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithPrompts(PROMPTS),
    });
    try {
      await waitForTranscriptText(NEWEST_PROMPT);
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "my own draft");
      await waitForComposerText("my own draft");
      expect(await pressArrow("ArrowUp")).toBe(false);
      await waitForComposerText("my own draft");

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "");
      await waitForComposerText("");
      expect(await pressArrow("ArrowUp")).toBe(true);
      await waitForComposerText(NEWEST_PROMPT);
      const editor = await waitForComposerEditor();
      editor.focus();
      document.execCommand("insertText", false, "!");
      await waitForComposerText(`${NEWEST_PROMPT}!`);
      expect(await pressArrow("ArrowDown")).toBe(false);
      expect(await pressArrow("ArrowUp")).toBe(false);
      await waitForComposerText(`${NEWEST_PROMPT}!`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not recall into a composer that holds an attachment", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithPrompts(PROMPTS),
    });
    try {
      await waitForTranscriptText(NEWEST_PROMPT);
      const editor = await waitForComposerEditor();
      editor.focus();
      pasteIntoComposer(editor, "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD));
      await vi.waitFor(() => expect(draftAttachments()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(await pressArrow("ArrowUp")).toBe(false);
      await waitForComposerText("");
    } finally {
      await mounted.cleanup();
    }
  });
});

describe("ChatView large pastes", () => {
  setupChatViewBrowserSuite();

  it("folds a large paste into a pasted-text attachment and keeps small ones inline", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithPrompts([NEWEST_PROMPT]),
    });
    try {
      await waitForTranscriptText(NEWEST_PROMPT);
      const editor = await waitForComposerEditor();
      editor.focus();
      pasteIntoComposer(editor, "short snippet");
      await waitForComposerText("short snippet");
      expect(draftAttachments()).toHaveLength(0);

      const large = "log line\n".repeat(Math.ceil(PASTED_TEXT_ATTACHMENT_THRESHOLD / 9));
      pasteIntoComposer(editor, large);
      await vi.waitFor(() => expect(draftAttachments()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      await waitForLayout();
      pasteIntoComposer(editor, large);
      await vi.waitFor(
        () => {
          expect(
            draftAttachments().map(({ type, name, mimeType, sizeBytes }) => ({
              type,
              name,
              mimeType,
              sizeBytes,
            })),
          ).toEqual([
            {
              type: "file",
              name: "pasted-text.txt",
              mimeType: "text/plain",
              sizeBytes: large.length,
            },
            {
              type: "file",
              name: "pasted-text-2.txt",
              mimeType: "text/plain",
              sizeBytes: large.length,
            },
          ]);
        },
        { timeout: 8_000, interval: 16 },
      );
      // The folded text never reaches the prompt.
      await waitForComposerText("short snippet");
      await vi.waitFor(
        () => {
          expect(document.body.textContent ?? "").toContain("Pasted text · ");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a large paste inline when pasted with the paste-as-text shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithPrompts([NEWEST_PROMPT]),
    });
    try {
      await waitForTranscriptText(NEWEST_PROMPT);
      const editor = await waitForComposerEditor();
      editor.focus();
      const mac = isMacPlatform(navigator.platform);
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "v",
          shiftKey: true,
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true,
          cancelable: true,
        }),
      );
      const large = "a".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD);
      pasteIntoComposer(editor, large);
      await waitForComposerText(large);
      expect(draftAttachments()).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });
});
