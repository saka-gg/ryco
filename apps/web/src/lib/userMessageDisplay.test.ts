import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import {
  createQuoteCitation,
  expandQuoteCitations,
  serializeQuoteCitation,
} from "@ryco/shared/quoteCitations";
import { describe, expect, it } from "vite-plus/test";

import { appendTerminalContextsToPrompt } from "./terminalContext";
import { deriveDisplayedUserMessageForTier } from "./userMessageDisplay";

const citation = createQuoteCitation({
  source: { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") },
  messageId: MessageId.make("assistant-1"),
  selector: { exact: "Quoted words.", prefix: "", suffix: "", start: 0, end: 13 },
  comment: "Why?",
});
const quoted = expandQuoteCitations(`Explain ${serializeQuoteCitation(citation)} please`);
const sent = appendTerminalContextsToPrompt(quoted, [
  { terminalId: "t-1", terminalLabel: "Terminal 1", lineStart: 3, lineEnd: 4, text: "ls\nok" },
]);

describe("deriveDisplayedUserMessageForTier", () => {
  it("shows quotes as chips on the desktop tier", () => {
    const displayed = deriveDisplayedUserMessageForTier(sent, "desktop");

    expect(displayed.visibleText).toBe("Explain [Quote 1] please");
    expect(displayed.quotes).toStrictEqual([{ number: 1, citation }]);
    expect(displayed.contexts).toHaveLength(1);
    expect(displayed.copyText).toBe(sent);
  });

  it("leaves the frozen phone tier's quotes as sent", () => {
    const displayed = deriveDisplayedUserMessageForTier(sent, "phone");

    expect(displayed.visibleText).toBe(quoted);
    expect(displayed.quotes).toEqual([]);
    expect(displayed.contexts).toHaveLength(1);
  });
});
