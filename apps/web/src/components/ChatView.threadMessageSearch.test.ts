import { MessageId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadMessageSearchOccurrence } from "./chat/ThreadMessageSearch.logic";
import {
  groupThreadMessageSearchOccurrences,
  mergeThreadMessageSearchOccurrences,
} from "./ChatView.threadMessageSearch";

const loaded: ThreadMessageSearchOccurrence = {
  id: "loaded:a:0",
  messageId: MessageId.make("a"),
  occurrenceIndex: 0,
  messageOccurrenceIndex: 0,
  start: 3,
  end: 7,
  text: "find",
};

function serverResult(messageId: string) {
  return {
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make(messageId),
    snippet: "… find …",
    timestamp: "2026-11-14T09:00:00.000Z",
  };
}

describe("mergeThreadMessageSearchOccurrences", () => {
  it("appends one occurrence per server result whose message is not loaded", () => {
    const merged = mergeThreadMessageSearchOccurrences(
      [loaded],
      [serverResult("a"), serverResult("b")],
      " find ",
    );
    expect(merged).toEqual([
      loaded,
      {
        id: "server:b",
        messageId: MessageId.make("b"),
        occurrenceIndex: 1,
        messageOccurrenceIndex: 0,
        start: 0,
        end: 0,
        text: "find",
      },
    ]);
  });
});

describe("groupThreadMessageSearchOccurrences", () => {
  it("groups occurrences by message while the search is open", () => {
    const second = { ...loaded, id: "loaded:a:1", occurrenceIndex: 1, messageOccurrenceIndex: 1 };
    const grouped = groupThreadMessageSearchOccurrences([loaded, second], true);
    expect(grouped.get(MessageId.make("a"))).toEqual([loaded, second]);
  });

  it("is empty while the search is closed", () => {
    expect(groupThreadMessageSearchOccurrences([loaded], false).size).toBe(0);
  });
});
