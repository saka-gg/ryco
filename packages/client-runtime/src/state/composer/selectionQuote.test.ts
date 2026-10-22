import { describe, expect, it } from "vitest";
import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@ryco/contracts";
import {
  collectQuoteCitationTokens,
  createQuoteCitation,
  QUOTE_CITATION_MAX_TEXT_LENGTH,
  serializeQuoteCitation,
} from "@ryco/shared/quoteCitations";
import {
  appendQuoteCitation,
  appendSelectionQuote,
  MAX_SELECTION_QUOTE_LENGTH,
  stripSelectionQuotes,
} from "./selectionQuote.ts";
import { createComposerDraftStore, DraftId } from "./draftStore.ts";

const source = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("thread") };
const quote = {
  source,
  messageId: MessageId.make("message"),
  text: '  code();\n\n> nested "quote"',
};

describe("quote citations in a prompt", () => {
  const citation = createQuoteCitation({
    source,
    messageId: MessageId.make("message"),
    selector: { exact: "The passage.", prefix: "", suffix: "", start: 0, end: 12 },
  });
  const token = serializeQuoteCitation(citation);

  it("appends the draft token after the text, apart from it, with room to type on", () => {
    expect(appendQuoteCitation("", citation)).toBe(`${token} `);
    expect(appendQuoteCitation("Explain", citation)).toBe(`Explain ${token} `);
    expect(appendQuoteCitation("Explain\n", citation)).toBe(`Explain\n${token} `);
    const twice = appendQuoteCitation(appendQuoteCitation("Compare", citation), citation);
    expect(collectQuoteCitationTokens(twice).map((match) => match.citation)).toStrictEqual([
      citation,
      citation,
    ]);
  });
});

describe("selection quotes", () => {
  it("preserves existing text, whitespace and quote boundaries, with scoped attribution", () => {
    expect(appendSelectionQuote("My unsent draft", quote)).toBe(
      'My unsent draft\n\nQuoted assistant text ({"environmentId":"remote","threadId":"thread","messageId":"message"}):\n>   code();\n> \n> > nested "quote"\n\n',
    );
  });
  it("strips the quotes it appended and keeps the text around them", () => {
    const draft = appendSelectionQuote("My unsent draft", quote);
    expect(stripSelectionQuotes(draft)).toBe("My unsent draft");
    expect(stripSelectionQuotes(`${appendSelectionQuote(draft, quote)}Why?`)).toBe(
      "My unsent draft\n\nWhy?",
    );
    expect(stripSelectionQuotes(appendSelectionQuote("", quote))).toBe("");
    expect(stripSelectionQuotes("> my own\n\nQuoted assistant text (note):\n> x")).toBe(
      "> my own\n\nQuoted assistant text (note):\n> x",
    );
  });
  it("rejects blank or oversized excerpts without truncating them", () => {
    expect(() => appendSelectionQuote("draft", { ...quote, text: " \n " })).toThrow();
    expect(() =>
      appendSelectionQuote("draft", { ...quote, text: "x".repeat(MAX_SELECTION_QUOTE_LENGTH + 1) }),
    ).toThrow();
    expect(() =>
      appendSelectionQuote("draft", { ...quote, text: "x".repeat(MAX_SELECTION_QUOTE_LENGTH) }),
    ).not.toThrow();
  });
  it("takes the same selections as a quote chip, so Add to Side never refuses one", () => {
    expect(MAX_SELECTION_QUOTE_LENGTH).toBe(QUOTE_CITATION_MAX_TEXT_LENGTH);
    const longest = "x".repeat(QUOTE_CITATION_MAX_TEXT_LENGTH);
    expect(() =>
      createQuoteCitation({
        source,
        messageId: MessageId.make("message"),
        selector: { exact: longest, prefix: "", suffix: "", start: 0, end: longest.length },
      }),
    ).not.toThrow();
    expect(() => appendSelectionQuote("", { ...quote, text: longest })).not.toThrow();
    expect(() => appendSelectionQuote("", { ...quote, text: `${longest}x` })).toThrow(
      "Select between 1 and 4,000 characters.",
    );
  });
  it("keeps detached drafts and the original project draft through persistence and promotion", async () => {
    const data = new Map<string, string>();
    const create = () =>
      createComposerDraftStore({
        storage: {
          getItem: (key) => data.get(key) ?? null,
          setItem: (key, value) => data.set(key, value),
          removeItem: (key) => data.delete(key),
        },
        flushStorage: () => {},
        revokePreviewUrl: () => {},
        hydrateImages: () => [],
        readPersistedAttachmentIds: () => [],
      }).useComposerDraftStore;
    const store = create();
    const project = { environmentId: source.environmentId, projectId: ProjectId.make("project") };
    const original = DraftId.make("original");
    const fresh = DraftId.make("selection");
    store.getState().setLogicalProjectDraftThreadId("project-key", project, original);
    store.getState().setPrompt(original, "Keep this project draft");
    store.getState().createDetachedDraftSession("project-key", project, fresh, {
      threadId: source.threadId,
      envMode: "worktree",
      branch: "main",
    });
    store.getState().setPrompt(fresh, appendSelectionQuote("Explain", quote));
    store.getState().createDetachedDraftSession("project-key", project, fresh, { branch: "other" });
    expect(store.getState().getDraftSession(fresh)?.branch).toBe("main");
    const restored = create();
    await restored.persist.rehydrate();
    expect(restored.getState().getComposerDraft(fresh)?.prompt).toContain(quote.messageId);
    expect(restored.getState().getDraftSessionByLogicalProjectKey("project-key")?.draftId).toBe(
      original,
    );
    restored.getState().markDraftThreadPromoting(fresh, source);
    restored.getState().finalizePromotedDraftThread(fresh);
    expect(restored.getState().getComposerDraft(original)?.prompt).toBe("Keep this project draft");
    expect(restored.getState().getDraftSessionByLogicalProjectKey("project-key")?.draftId).toBe(
      original,
    );
  });
});
