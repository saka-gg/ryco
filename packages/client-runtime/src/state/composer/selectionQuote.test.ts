import { describe, expect, it } from "vitest";
import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@ryco/contracts";
import { appendSelectionQuote, MAX_SELECTION_QUOTE_LENGTH } from "./selectionQuote.ts";
import { createComposerDraftStore, DraftId } from "./draftStore.ts";

const source = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("thread") };
const quote = {
  source,
  messageId: MessageId.make("message"),
  text: '  code();\n\n> nested "quote"',
};

describe("selection quotes", () => {
  it("preserves existing text, whitespace and quote boundaries, with scoped attribution", () => {
    expect(appendSelectionQuote("My unsent draft", quote)).toBe(
      'My unsent draft\n\nQuoted assistant text ({"environmentId":"remote","threadId":"thread","messageId":"message"}):\n>   code();\n> \n> > nested "quote"\n\n',
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
