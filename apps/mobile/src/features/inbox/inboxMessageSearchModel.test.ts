import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeInboxMessageMatches,
  messageSearchQuery,
  splitSnippet,
} from "./inboxMessageSearchModel";

const env = (id: string) => id as EnvironmentId;
const result = (threadId: string, messageId: string, timestamp: string) => ({
  threadId: threadId as ThreadId,
  messageId: messageId as MessageId,
  snippet: `snippet ${messageId}`,
  timestamp,
});

describe("inbox message search", () => {
  it("searches only from two characters, trimmed", () => {
    expect(messageSearchQuery(" a ")).toBeNull();
    expect(messageSearchQuery("  flaky ")).toBe("flaky");
  });

  it("keeps the newest match per thread across nodes", () => {
    const matches = mergeInboxMessageMatches([
      {
        environmentId: env("a"),
        results: [
          result("t1", "old", "2026-11-01T10:00:00.000Z"),
          result("t1", "new", "2026-11-02T10:00:00.000Z"),
          result("t2", "only", "2026-11-01T10:00:00.000Z"),
        ],
      },
      {
        environmentId: env("b"),
        results: [result("t1", "other-node", "2026-11-03T10:00:00.000Z")],
      },
    ]);
    expect([...matches].map(([key, match]) => [key, match.messageId])).toEqual([
      ["a:t1", "new"],
      ["a:t2", "only"],
      ["b:t1", "other-node"],
    ]);
  });

  it("highlights every query word, case-insensitively, merging overlaps", () => {
    expect(splitSnippet("The Flaky test is flaky", "flaky")).toEqual([
      { text: "The ", highlighted: false, start: 0 },
      { text: "Flaky", highlighted: true, start: 4 },
      { text: " test is ", highlighted: false, start: 9 },
      { text: "flaky", highlighted: true, start: 18 },
    ]);
    expect(splitSnippet("abcdef", "abc bcd")).toEqual([
      { text: "abcd", highlighted: true, start: 0 },
      { text: "ef", highlighted: false, start: 4 },
    ]);
    expect(splitSnippet("nothing here", "zzz")).toEqual([
      { text: "nothing here", highlighted: false, start: 0 },
    ]);
  });
});
