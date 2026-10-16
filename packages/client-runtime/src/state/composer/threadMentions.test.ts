import { ThreadId } from "@ryco/contracts/base-schemas";
import { MAX_THREAD_REFERENCES_PER_MESSAGE } from "@ryco/contracts/orchestration";
import { describe, expect, it } from "vite-plus/test";

import { splitPromptIntoComposerSegments } from "./editorMentions.ts";
import { expandCollapsedComposerCursor } from "./logic.ts";
import {
  extractThreadReferences,
  formatThreadMentionPath,
  isThreadMentionableId,
  matchThreadMentions,
  threadIdFromMentionPath,
} from "./threadMentions.ts";

describe("thread mentions", () => {
  it("round-trips a thread id through its mention path", () => {
    const path = formatThreadMentionPath(ThreadId.make("8bcb2141-e044-41ac-be6c-d5f7707ba4dc"));
    expect(path).toBe("thread:8bcb2141-e044-41ac-be6c-d5f7707ba4dc");
    expect(threadIdFromMentionPath(path)).toBe("8bcb2141-e044-41ac-be6c-d5f7707ba4dc");
  });

  it("leaves file mentions alone", () => {
    expect(threadIdFromMentionPath("src/thread.ts")).toBeNull();
    expect(threadIdFromMentionPath("thread:")).toBeNull();
    expect(threadIdFromMentionPath("thread:a/b")).toBeNull();
  });

  it("only accepts ids that never need quoting", () => {
    expect(isThreadMentionableId("thread-1_A")).toBe(true);
    expect(isThreadMentionableId("has space")).toBe(false);
    expect(isThreadMentionableId('quo"te')).toBe(false);
    expect(isThreadMentionableId("")).toBe(false);
  });

  it("parses as an ordinary mention segment, so chips and cursors behave like file chips", () => {
    const prompt = "See @thread:abc for context";
    expect(splitPromptIntoComposerSegments(prompt)).toEqual([
      { type: "text", text: "See " },
      { type: "mention", path: "thread:abc" },
      { type: "text", text: " for context" },
    ]);
    // The chip is one collapsed character; after it the expanded cursor sits right past the token.
    expect(expandCollapsedComposerCursor(prompt, 5)).toBe("See @thread:abc".length);
  });

  it("matches tokens at the end of a trimmed message, not inside words", () => {
    expect(matchThreadMentions("ask@thread:nope then @thread:yes")).toEqual([
      { threadId: "yes", start: 21, end: 32 },
    ]);
  });

  it("extracts each mentioned thread once, in order, without the sending thread", () => {
    expect(
      extractThreadReferences("@thread:b @thread:self @thread:a @thread:b", ThreadId.make("self")),
    ).toEqual(["b", "a"]);
  });

  it("caps the references one message carries", () => {
    const text = Array.from(
      { length: MAX_THREAD_REFERENCES_PER_MESSAGE + 2 },
      (_, index) => `@thread:t${index}`,
    ).join(" ");
    expect(extractThreadReferences(text)).toHaveLength(MAX_THREAD_REFERENCES_PER_MESSAGE);
  });
});
