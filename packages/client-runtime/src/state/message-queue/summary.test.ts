import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { createQuoteCitation, serializeQuoteCitation } from "@ryco/shared/quoteCitations";
import { describe, expect, it } from "vite-plus/test";

import { summarizeQueuedMessage } from "./summary.ts";

describe("summarizeQueuedMessage", () => {
  const empty = { trimmedPrompt: "", imageCount: 0, terminalContextCount: 0 };

  it("names picked page elements after file references", () => {
    expect(summarizeQueuedMessage({ ...empty, browserElementCount: 1 })).toBe("1 page element");
    expect(summarizeQueuedMessage({ ...empty, browserElementCount: 3 })).toBe("3 page elements");
    expect(
      summarizeQueuedMessage({ ...empty, fileReferenceCount: 2, browserElementCount: 3 }),
    ).toBe("2 file references");
    expect(
      summarizeQueuedMessage({ ...empty, trimmedPrompt: "Fix it", browserElementCount: 1 }),
    ).toBe("Fix it");
    expect(summarizeQueuedMessage(empty)).toBe("Queued message");
  });

  it("reads a quote chip as its quoted passage, not as its token", () => {
    const token = serializeQuoteCitation(
      createQuoteCitation({
        source: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
        messageId: MessageId.make("message"),
        selector: { exact: "The passage.", prefix: "", suffix: "", start: 0, end: 12 },
      }),
    );
    const summary = summarizeQueuedMessage({ ...empty, trimmedPrompt: `Explain ${token}` });

    expect(summary).toContain("The passage.");
    expect(summary).not.toContain(token);
  });
});
