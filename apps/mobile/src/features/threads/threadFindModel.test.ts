import { MessageId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findLoadedMessages, mergeThreadFindHits, threadFindStatus } from "./threadFindModel";

const message = (id: string, role: string, text: string, createdAt: string) => ({
  id: MessageId.make(id),
  role,
  text,
  createdAt,
});

describe("find in chat", () => {
  it("matches user and agent messages, whitespace runs loosely", () => {
    const hits = findLoadedMessages(
      [
        message("m1", "user", "Fix the  CI build", "2026-11-09T01:00:00.000Z"),
        message("m2", "assistant", "The ci\nbuild is green", "2026-11-09T01:01:00.000Z"),
        message("m3", "system", "ci build", "2026-11-09T01:02:00.000Z"),
      ],
      "ci build",
    );
    expect(hits.map((hit) => hit.messageId)).toEqual(["m1", "m2"]);
    expect(findLoadedMessages([], "  ")).toEqual([]);
  });

  it("merges loaded and server hits once each, oldest first", () => {
    const merged = mergeThreadFindHits(
      [{ messageId: MessageId.make("m2"), createdAt: "2026-11-09T01:01:00.000Z" }],
      [
        { messageId: MessageId.make("m0"), createdAt: "2026-11-08T23:00:00.000Z" },
        { messageId: MessageId.make("m2"), createdAt: "2026-11-09T01:01:00.000Z" },
      ],
    );
    expect(merged.map((hit) => hit.messageId)).toEqual(["m0", "m2"]);
  });

  it("says where in the results it is", () => {
    expect(threadFindStatus({ query: "", hits: 0, index: 0, searching: false })).toBe("");
    expect(threadFindStatus({ query: "ci", hits: 0, index: 0, searching: true })).toBe(
      "Searching…",
    );
    expect(threadFindStatus({ query: "ci", hits: 0, index: 0, searching: false })).toBe(
      "No results",
    );
    expect(threadFindStatus({ query: "ci", hits: 12, index: 2, searching: false })).toBe("3 / 12");
  });
});
