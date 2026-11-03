import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import {
  createQuoteCitation,
  expandQuoteCitations,
  serializeQuoteCitation,
} from "@ryco/shared/quoteCitations";
import type { TimelineEntry } from "../../session-logic";
import {
  buildThreadMessageSearchOccurrences,
  clampThreadMessageSearchIndex,
  moveThreadMessageSearchIndex,
} from "./ThreadMessageSearch.logic";

function messageEntry(input: {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}): TimelineEntry {
  return {
    id: `entry-${input.id}`,
    kind: "message",
    createdAt: "2026-04-01T12:00:00.000Z",
    message: {
      id: MessageId.make(input.id),
      role: input.role,
      text: input.text,
      createdAt: "2026-04-01T12:00:00.000Z",
      streaming: false,
    },
  };
}

describe("buildThreadMessageSearchOccurrences", () => {
  it("returns user and assistant occurrences in timeline order", () => {
    const occurrences = buildThreadMessageSearchOccurrences({
      query: "deploy",
      timelineEntries: [
        messageEntry({ id: "message-1", role: "assistant", text: "No match" }),
        messageEntry({ id: "message-2", role: "user", text: "Deploy the app" }),
        messageEntry({ id: "message-3", role: "assistant", text: "Deploy then deploy again" }),
      ],
    });

    expect(occurrences.map((occurrence) => occurrence.messageId)).toEqual([
      MessageId.make("message-2"),
      MessageId.make("message-3"),
      MessageId.make("message-3"),
    ]);
    expect(occurrences.map((occurrence) => occurrence.messageOccurrenceIndex)).toEqual([0, 0, 1]);
  });

  it("records matched text spans for exact occurrence highlighting", () => {
    const occurrences = buildThreadMessageSearchOccurrences({
      query: "fix",
      timelineEntries: [
        messageEntry({ id: "message-1", role: "assistant", text: "fix one then fix two" }),
      ],
    });

    expect(
      occurrences.map((occurrence) => ({
        start: occurrence.start,
        end: occurrence.end,
        text: occurrence.text,
      })),
    ).toEqual([
      { start: 0, end: 3, text: "fix" },
      { start: 13, end: 16, text: "fix" },
    ]);
  });

  it("normalizes case and query whitespace", () => {
    const occurrences = buildThreadMessageSearchOccurrences({
      query: "alpha beta",
      timelineEntries: [
        messageEntry({ id: "message-1", role: "assistant", text: "Alpha\n\nBeta shipped" }),
      ],
    });

    expect(occurrences.map((occurrence) => occurrence.messageId)).toEqual([
      MessageId.make("message-1"),
    ]);
    expect(occurrences[0]?.text).toBe("Alpha\n\nBeta");
  });

  it("skips system messages and non-message timeline entries", () => {
    const occurrences = buildThreadMessageSearchOccurrences({
      query: "secret",
      timelineEntries: [
        messageEntry({ id: "message-1", role: "system", text: "secret instructions" }),
        {
          id: "work-1",
          kind: "work",
          createdAt: "2026-04-01T12:00:00.000Z",
          entry: {
            id: "work-1",
            createdAt: "2026-04-01T12:00:00.000Z",
            label: "secret command",
            tone: "tool",
          },
        },
      ],
    });

    expect(occurrences).toEqual([]);
  });

  describe("quotes in a user message", () => {
    const quote = (exact: string) =>
      serializeQuoteCitation(
        createQuoteCitation({
          source: { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t-1") },
          messageId: MessageId.make("assistant-1"),
          selector: { exact, prefix: "", suffix: "", start: 0, end: exact.length },
        }),
      );
    // One sent marker and one draft token left in the text, both shown as chips.
    const sent = expandQuoteCitations(`Explain ${quote("Quote one.")}, quote the docs`).replace(
      "quote the docs",
      `quote the docs ${quote("Another quote")}`,
    );
    const entries = [messageEntry({ id: "message-1", role: "user", text: sent })];

    it("matches only the text a chip does not stand for", () => {
      const occurrences = buildThreadMessageSearchOccurrences({
        query: "quote",
        timelineEntries: entries,
        presentationTier: "desktop",
      });
      expect(occurrences.map((occurrence) => occurrence.text)).toEqual(["quote"]);
      expect(
        buildThreadMessageSearchOccurrences({
          query: "1",
          timelineEntries: entries,
          presentationTier: "desktop",
        }),
      ).toEqual([]);
      expect(
        buildThreadMessageSearchOccurrences({
          query: "explain quote",
          timelineEntries: entries,
          presentationTier: "desktop",
        }),
      ).toEqual([]);
    });

    it("searches the frozen phone tier's text as sent", () => {
      const occurrences = buildThreadMessageSearchOccurrences({
        query: "Quote one.",
        timelineEntries: entries,
        presentationTier: "phone",
      });
      expect(occurrences).toHaveLength(1);
    });
  });

  it("returns no matches for empty queries", () => {
    expect(
      buildThreadMessageSearchOccurrences({
        query: "   ",
        timelineEntries: [messageEntry({ id: "message-1", role: "user", text: "anything" })],
      }),
    ).toEqual([]);
  });
});

describe("thread message search selection", () => {
  it("clamps selected indexes to the available result range", () => {
    expect(clampThreadMessageSearchIndex(-2, 3)).toBe(0);
    expect(clampThreadMessageSearchIndex(5, 3)).toBe(2);
    expect(clampThreadMessageSearchIndex(1, 0)).toBe(0);
  });

  it("moves next and previous with wraparound", () => {
    expect(
      moveThreadMessageSearchIndex({
        currentIndex: 2,
        matchCount: 3,
        direction: "next",
      }),
    ).toBe(0);
    expect(
      moveThreadMessageSearchIndex({
        currentIndex: 0,
        matchCount: 3,
        direction: "previous",
      }),
    ).toBe(2);
  });
});
