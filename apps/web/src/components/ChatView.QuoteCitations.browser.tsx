import {
  MessageId,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type OrchestrationReadModel,
} from "@ryco/contracts";
import { composeOutgoingPrompt } from "@ryco/client-runtime/state/composer";
import {
  collectQuoteCitationTokens,
  createQuoteCitation,
  serializeQuoteCitation,
  type QuoteCitation,
} from "@ryco/shared/quoteCitations";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { cssHighlightRegistry } from "../lib/cssHighlights";
import {
  DEFAULT_VIEWPORT,
  THREAD_KEY,
  THREAD_REF,
  createSnapshotForTargetUser,
  createUserMessage,
  fixture,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
  waitForComposerText,
  waitForElement,
  waitForLayout,
  wsRequests,
} from "./ChatView.browser.helpers";
import { PENDING_QUOTE_HIGHLIGHT_NAME } from "./chat/usePendingQuoteHighlight";
import { QUOTE_SOURCE_HIGHLIGHT_NAME } from "./chat/useQuoteSourceHighlight";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const ANSWER_ID = MessageId.make("msg-quote-answer");
const ANSWER = "The cache key is the request path. Clear it after every deploy.";
const QUOTED = "request path";

/** A thread whose last reply is `ANSWER`, after `userText` when given. */
function snapshotWithAnswer(userText = "How does the cache work?"): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: MessageId.make("msg-quote-target"),
    targetText: "unused",
  });
  const createdAt = snapshot.threads[0]!.createdAt;
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      Object.assign({}, thread, {
        messages: [
          createUserMessage({
            id: MessageId.make("msg-quote-user"),
            text: userText,
            offsetSeconds: 0,
          }),
          {
            id: ANSWER_ID,
            role: "assistant" as const,
            text: ANSWER,
            turnId: null,
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        ],
      }),
    ),
  };
}

const citation: QuoteCitation = createQuoteCitation({
  source: THREAD_REF,
  messageId: ANSWER_ID,
  selector: {
    exact: QUOTED,
    prefix: "The cache key is the ",
    suffix: ". Clear it after every deploy.",
    start: 21,
    end: 33,
  },
});

const acceptDispatch = (body: { _tag: string }) =>
  body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
    ? { sequence: fixture.snapshot.snapshotSequence + 1 }
    : undefined;

const turnStarts = () =>
  wsRequests.filter(
    (request) =>
      request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
      request.type === "thread.turn.start",
  ) as unknown as ReadonlyArray<{ readonly message: { readonly text: string } }>;

const draftPrompt = () => useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt;

const composerChip = () =>
  document.querySelector<HTMLElement>("[data-chat-composer-form] [data-composer-quote-chip]");

/** The text the named highlight paints now, one entry per range. */
function highlightedTexts(name: string): string[] {
  const highlight = cssHighlightRegistry()?.get(name);
  return highlight ? [...highlight].map((range) => (range as Range).toString()) : [];
}

/** Selects `QUOTED` inside the answer and opens the selection actions from the keyboard. */
async function selectQuotedPassage(): Promise<void> {
  const answer = await waitForElement<HTMLElement>(
    () => document.querySelector(`[data-selection-message-id="${ANSWER_ID}"]`),
    "The answer to quote",
  );
  const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node && !node.data.includes(QUOTED)) node = walker.nextNode() as Text | null;
  if (!node) throw new Error("The quoted passage is not rendered.");
  const start = node.data.indexOf(QUOTED);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + QUOTED.length);
  answer.focus();
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await userEvent.keyboard("{Alt>}{Enter}{/Alt}");
  await expect.element(page.getByRole("toolbar", { name: "Selection actions" })).toBeVisible();
}

async function pressEnterInComposer(): Promise<void> {
  const editor = await waitForComposerEditor();
  editor.focus();
  editor.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
}

describe("ChatView quote citations", () => {
  setupChatViewBrowserSuite();

  it("adds a quote as a chip, edits its comment and sends it expanded once", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithAnswer(),
      resolveRpc: acceptDispatch,
    });
    try {
      await waitForComposerEditor();
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Why");
      await waitForComposerText("Why");
      await selectQuotedPassage();
      await page.getByRole("button", { name: "Add to chat", exact: true }).click();

      // The chip's text is its token, after the draft's own text.
      await vi.waitFor(() =>
        expect(draftPrompt()).toBe(`Why ${serializeQuoteCitation(citation)} `),
      );
      await vi.waitFor(() => expect(composerChip()).not.toBeNull());
      expect(composerChip()?.textContent).toContain(QUOTED);
      // The passage it quotes stays marked in the answer while the draft holds it.
      await vi.waitFor(() =>
        expect(highlightedTexts(PENDING_QUOTE_HIGHLIGHT_NAME)).toEqual([QUOTED]),
      );

      // The pencil opens the comment; Enter saves it there and sends nothing.
      await page.getByRole("button", { name: `Add comment to ${QUOTED}` }).click();
      const field = page.getByRole("textbox", { name: "Comment on quote" });
      await expect.element(field).toHaveFocus();
      await userEvent.keyboard("Is this per tenant?{Shift>}{Enter}{/Shift}Or global?{Enter}");
      await expect.element(field).not.toBeInTheDocument();
      const commented = { ...citation, comment: "Is this per tenant?\nOr global?" };
      await vi.waitFor(() =>
        expect(draftPrompt()).toBe(`Why ${serializeQuoteCitation(commented)} `),
      );
      expect(turnStarts()).toHaveLength(0);
      await expect
        .element(page.getByRole("button", { name: `Edit comment on ${QUOTED}` }))
        .toBeVisible();

      await pressEnterInComposer();
      await vi.waitFor(() => expect(turnStarts()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      const sent = turnStarts()[0]!.message.text;
      expect(sent).toBe(
        composeOutgoingPrompt({ prompt: `Why ${serializeQuoteCitation(commented)}` }),
      );
      expect(sent).toContain("Why [Quote 1]\n\n<assistant_quotes>");
      expect(sent).toContain("> request path\nComment:\n  Is this per tenant?\n  Or global?");
      expect(sent).not.toContain("?text=");

      // The sent message shows the chip, and the mark goes with the draft.
      await vi.waitFor(() =>
        expect(document.querySelector("[data-quote-citation-chip]")?.textContent).toContain(QUOTED),
      );
      await vi.waitFor(() => expect(highlightedTexts(PENDING_QUOTE_HIGHLIGHT_NAME)).toEqual([]));
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves the comment as it was on Escape, and the cross takes the quote out", async () => {
    const token = serializeQuoteCitation(citation);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithAnswer(),
    });
    try {
      await waitForComposerEditor();
      useComposerDraftStore.getState().setPrompt(THREAD_REF, `Explain ${token} `);
      await vi.waitFor(() => expect(composerChip()).not.toBeNull());

      await page.getByRole("button", { name: `Add comment to ${QUOTED}` }).click();
      await userEvent.keyboard("Never mind{Escape}");
      await expect
        .element(page.getByRole("textbox", { name: "Comment on quote" }))
        .not.toBeInTheDocument();
      expect(draftPrompt()).toBe(`Explain ${token} `);
      expect(turnStarts()).toHaveLength(0);

      await page.getByRole("button", { name: `Remove quote ${QUOTED}` }).click();
      await vi.waitFor(() => expect(draftPrompt()).toBe("Explain  "));
      expect(composerChip()).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("turns a pasted token into a chip whose text stays the token", async () => {
    const token = serializeQuoteCitation(citation);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithAnswer(),
    });
    try {
      const editor = await waitForComposerEditor();
      editor.focus();
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", `See ${token} and this`);
      editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() => expect(composerChip()).not.toBeNull());
      await vi.waitFor(() => expect(draftPrompt()).toBe(`See ${token} and this`));
      expect(editor.textContent).not.toContain("ryco-quote:");
      // Typing goes on after the chip.
      document.execCommand("insertText", false, "!");
      await vi.waitFor(() => expect(draftPrompt()).toBe(`See ${token} and this!`));
    } finally {
      await mounted.cleanup();
    }
  });

  it("recalls a sent quote as its chip with ArrowUp", async () => {
    const draft = `Explain ${serializeQuoteCitation({ ...citation, comment: "Briefly" })}`;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithAnswer(composeOutgoingPrompt({ prompt: draft })),
    });
    try {
      await vi.waitFor(() =>
        expect(document.querySelector("[data-quote-citation-chip]")?.textContent).toContain(QUOTED),
      );
      const editor = await waitForComposerEditor();
      editor.focus();
      const arrowUp = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(arrowUp);
      expect(arrowUp.defaultPrevented).toBe(true);
      await waitForComposerText(draft);
      await vi.waitFor(() => expect(composerChip()).not.toBeNull());
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the passage when the composer chip is clicked", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithAnswer(),
    });
    try {
      await waitForComposerEditor();
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_REF, `Explain ${serializeQuoteCitation(citation)} `);
      await vi.waitFor(() => expect(composerChip()).not.toBeNull());
      await page
        .getByRole("button", { name: `Show quoted text in conversation: ${QUOTED}` })
        .click();
      await vi.waitFor(() =>
        expect(highlightedTexts(QUOTE_SOURCE_HIGHLIGHT_NAME)).toEqual([QUOTED]),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a draft whose quotes would take it past the input limit", async () => {
    const token = serializeQuoteCitation(citation);
    // Within the limit as a draft; the quote block the send adds takes it over.
    const prompt = `${"x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - token.length - 10)} ${token}`;
    expect(prompt.length).toBeLessThan(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    const overflow = composeOutgoingPrompt({ prompt }).length - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
    expect(overflow).toBeGreaterThan(0);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithAnswer(),
      resolveRpc: acceptDispatch,
    });
    try {
      await waitForComposerEditor();
      useComposerDraftStore.getState().setPrompt(THREAD_REF, prompt);
      await waitForComposerText(prompt);
      await pressEnterInComposer();
      await expect.element(page.getByText("Message is too long")).toBeVisible();
      await expect
        .element(
          page.getByText(`It is ${overflow.toLocaleString()} characters over`, { exact: false }),
        )
        .toBeVisible();
      await waitForLayout();
      expect(turnStarts()).toHaveLength(0);
      expect(draftPrompt()).toBe(prompt);
      expect(collectQuoteCitationTokens(draftPrompt() ?? "")).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });
});
