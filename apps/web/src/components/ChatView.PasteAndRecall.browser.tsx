import {
  EnvironmentId,
  EventId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  type OrchestrationReadModel,
} from "@ryco/contracts";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  PASTED_TEXT_ATTACHMENT_THRESHOLD,
  appendSelectionQuote,
  appendTerminalContextsToPrompt,
} from "@ryco/client-runtime/state/composer";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { composerFileUploadEngine } from "../composerFileUpload";
import { PASTE_AS_TEXT_EVENT } from "../lib/desktopPasteAsText";
import { isMacPlatform } from "../lib/utils";
import {
  DEFAULT_VIEWPORT,
  THREAD_ID,
  THREAD_KEY,
  THREAD_REF,
  createBrowserComposerImage,
  createSnapshotForTargetUser,
  createUserMessage,
  isoAt,
  mountChatView,
  selectAllComposerContent,
  setComposerSelectionByTextOffsets,
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

/** `snapshot` with `activity` waiting on the thread. */
function withPendingActivity(
  snapshot: OrchestrationReadModel,
  activity: { readonly kind: string; readonly tone: string; readonly payload: unknown },
  threadPatch: Record<string, unknown> = {},
): OrchestrationReadModel {
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, threadPatch, {
            activities: [
              {
                id: EventId.make(`activity-recall-${activity.kind}`),
                summary: "Waiting",
                turnId: null,
                sequence: 1,
                createdAt: isoAt(1_000),
                ...activity,
              },
            ],
            updatedAt: isoAt(1_000),
          })
        : thread,
    ),
  };
}

const PENDING_APPROVAL = {
  kind: "approval.requested",
  tone: "approval",
  payload: {
    requestId: "req-recall-approval",
    requestKind: "command",
    detail: "Run command: bun run migrate",
  },
};

const PENDING_QUESTION = {
  kind: "user-input.requested",
  tone: "info",
  payload: {
    requestId: "req-recall-question",
    questions: [
      {
        id: "scope",
        header: "Scope",
        question: "What should this change cover?",
        options: [
          { label: "Tight", description: "Touch only the migration." },
          { label: "Broad", description: "Also update the docs." },
        ],
      },
    ],
  },
};

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

const LARGE_PASTE = "log line\n".repeat(Math.ceil(PASTED_TEXT_ATTACHMENT_THRESHOLD / 9));

/** The prompt holds `text` as typed, give or take the trailing line break a paste leaves. */
async function waitForPromptToHold(text: string): Promise<void> {
  await vi.waitFor(
    () => {
      const prompt = useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "";
      expect(prompt.trimEnd()).toBe(text.trimEnd());
    },
    { timeout: 8_000, interval: 16 },
  );
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

  it("leaves the arrows to a waiting approval", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withPendingActivity(snapshotWithPrompts(PROMPTS), PENDING_APPROVAL),
    });
    try {
      await waitForTranscriptText(NEWEST_PROMPT);
      await waitForTranscriptText("Approve once");
      expect(await pressArrow("ArrowUp")).toBe(false);
      await waitForLayout();
      await waitForComposerText("");
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves the arrows and a large paste to a waiting question's answer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withPendingActivity(snapshotWithPrompts(PROMPTS), PENDING_QUESTION, {
        interactionMode: "plan",
      }),
    });
    try {
      await waitForTranscriptText("What should this change cover?");
      const editor = await waitForComposerEditor();
      await pressArrow("ArrowUp");
      await waitForLayout();
      await waitForComposerText("");
      expect(editor.textContent ?? "").toBe("");
      editor.focus();
      // The answer is the editor's text, so the paste goes into it whatever its size.
      pasteIntoComposer(editor, LARGE_PASTE);
      await vi.waitFor(() => expect(editor.textContent ?? "").toContain("log linelog line"), {
        timeout: 8_000,
        interval: 16,
      });
      expect(draftAttachments()).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("moves the caret through a multi-line recall before stepping past it", async () => {
    const multiLine = "First line of the plan\nSecond line of the plan";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithPrompts(["Explain the failing test", multiLine]),
    });
    try {
      await waitForTranscriptText("Second line of the plan");
      expect(await pressArrow("ArrowUp")).toBe(true);
      await waitForComposerText(multiLine);
      // The recall leaves the caret at its end: ArrowUp moves it up a line first.
      expect(await pressArrow("ArrowUp")).toBe(false);
      await setComposerSelectionByTextOffsets({ start: 0, end: 0 });
      // On the first line, ArrowDown moves the caret, and ArrowUp steps back.
      expect(await pressArrow("ArrowDown")).toBe(false);
      expect(await pressArrow("ArrowUp")).toBe(true);
      await waitForComposerText("Explain the failing test");
      expect(await pressArrow("ArrowDown")).toBe(true);
      await waitForComposerText(multiLine);
      expect(await pressArrow("ArrowDown")).toBe(true);
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

      pasteIntoComposer(editor, LARGE_PASTE);
      await vi.waitFor(() => expect(draftAttachments()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      await waitForLayout();
      pasteIntoComposer(editor, LARGE_PASTE);
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
              sizeBytes: LARGE_PASTE.length,
            },
            {
              type: "file",
              name: "pasted-text-2.txt",
              mimeType: "text/plain",
              sizeBytes: LARGE_PASTE.length,
            },
          ]);
        },
        { timeout: 8_000, interval: 16 },
      );
      // The folded text never reaches the prompt, and the fold says where it went.
      await waitForComposerText("short snippet");
      await vi.waitFor(
        () => {
          const text = document.body.textContent ?? "";
          expect(text).toContain("Pasted text · ");
          expect(text).toContain("Large paste attached as pasted-text.txt");
          expect(text).toContain("to keep it as text.");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a folded paste's bytes with the draft instead of streaming them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithPrompts([NEWEST_PROMPT]),
      // An environment that streams file attachments under upload tokens that expire.
      configureFixture: (nextFixture) => {
        const capabilities = {
          ...nextFixture.serverConfig.environment.capabilities,
          fileAttachments: { maxUploadBytes: 10 * 1024 * 1024 },
        };
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          environment: { ...nextFixture.serverConfig.environment, capabilities },
        };
        nextFixture.welcome = {
          ...nextFixture.welcome,
          environment: { ...nextFixture.welcome.environment, capabilities },
        };
      },
    });
    try {
      await waitForTranscriptText(NEWEST_PROMPT);
      const editor = await waitForComposerEditor();
      editor.focus();
      // A file pasted from disk streams.
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
      editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() => expect(draftAttachments()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(composerFileUploadEngine.get(draftAttachments()[0]!.id)).not.toBeNull();

      // Pasted text has no file to pick again once a token expires or the app restarts.
      pasteIntoComposer(editor, LARGE_PASTE);
      await vi.waitFor(() => expect(draftAttachments()).toHaveLength(2), {
        timeout: 8_000,
        interval: 16,
      });
      const pasted = draftAttachments()[1]!;
      expect(pasted.name).toBe("pasted-text.txt");
      expect(composerFileUploadEngine.get(pasted.id)).toBeNull();
      expect(await pasted.file!.text()).toBe(LARGE_PASTE);
      await vi.waitFor(
        () => {
          const persisted =
            useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.persistedAttachments ??
            [];
          expect(persisted.find((attachment) => attachment.id === pasted.id)).toMatchObject({
            type: "file",
            name: "pasted-text.txt",
            bytes: "local",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.querySelectorAll('[data-composer-file-state="reattach"]').length).toBe(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("replaces the selection it was pasted over", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithPrompts([NEWEST_PROMPT]),
    });
    try {
      await waitForTranscriptText(NEWEST_PROMPT);
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "an old draft");
      await waitForComposerText("an old draft");
      await selectAllComposerContent();
      pasteIntoComposer(await waitForComposerEditor(), LARGE_PASTE);
      await vi.waitFor(() => expect(draftAttachments()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      await waitForComposerText("");
    } finally {
      await mounted.cleanup();
    }
  });

  it("stays text when the message has no room for another attachment", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithPrompts([NEWEST_PROMPT]),
    });
    try {
      await waitForTranscriptText(NEWEST_PROMPT);
      useComposerDraftStore.getState().addImages(
        THREAD_REF,
        Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) =>
          createBrowserComposerImage({ id: `full-${index}` }),
        ),
      );
      await vi.waitFor(
        () => expect(draftAttachments()).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
        { timeout: 8_000, interval: 16 },
      );
      const editor = await waitForComposerEditor();
      editor.focus();
      pasteIntoComposer(editor, LARGE_PASTE);
      await waitForPromptToHold(LARGE_PASTE);

      // Past the input limit it cannot stay text either: it is refused, and says why. The text
      // it was pasted over stays, since nothing took its place.
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "keep this draft");
      await waitForComposerText("keep this draft");
      await selectAllComposerContent();
      pasteIntoComposer(editor, "a".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1));
      await waitForTranscriptText(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
      );
      await waitForLayout();
      await waitForComposerText("keep this draft");
      await waitForPromptToHold("keep this draft");
      expect(draftAttachments()).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
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

  it("keeps a large paste inline when the desktop menu pastes it as text", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithPrompts([NEWEST_PROMPT]),
    });
    try {
      await waitForTranscriptText(NEWEST_PROMPT);
      const editor = await waitForComposerEditor();
      editor.focus();
      window.dispatchEvent(new Event(PASTE_AS_TEXT_EVENT));
      const large = "b".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD);
      pasteIntoComposer(editor, large);
      await waitForComposerText(large);
      expect(draftAttachments()).toHaveLength(0);
      // Only that one paste.
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "");
      await waitForComposerText("");
      pasteIntoComposer(editor, large);
      await vi.waitFor(() => expect(draftAttachments()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
