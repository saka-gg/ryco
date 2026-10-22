import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import {
  createQuoteCitation,
  expandQuoteCitations,
  serializeQuoteCitation,
} from "@ryco/shared/quoteCitations";
import { describe, expect, it } from "vite-plus/test";

import { appendTerminalContextsToPrompt } from "./terminalContext";
import { deriveDisplayedUserMessage } from "./userMessageDisplay";

const citation = createQuoteCitation({
  source: { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") },
  messageId: MessageId.make("assistant-1"),
  selector: { exact: "Quoted words.", prefix: "", suffix: "", start: 0, end: 13 },
  comment: "Why?",
});

describe("deriveDisplayedUserMessage", () => {
  it("shows the prompt without its quote and terminal blocks, and copies it as sent", () => {
    // The send order: quotes expand first, terminal context is appended after.
    const sent = appendTerminalContextsToPrompt(
      expandQuoteCitations(`Explain ${serializeQuoteCitation(citation)} please`),
      [
        {
          terminalId: "t-1",
          terminalLabel: "Terminal 1",
          lineStart: 3,
          lineEnd: 4,
          text: "ls\nok",
        },
      ],
    );
    const displayed = deriveDisplayedUserMessage(sent);

    expect(displayed.visibleText).toBe("Explain [Quote 1] please");
    expect(displayed.quotes).toStrictEqual([{ number: 1, citation }]);
    expect(displayed.contexts).toHaveLength(1);
    expect(displayed.copyText).toBe(sent);
  });

  it("leaves a message without quotes as before", () => {
    const displayed = deriveDisplayedUserMessage("Just a question.");
    expect(displayed.visibleText).toBe("Just a question.");
    expect(displayed.quotes).toEqual([]);
  });
});
