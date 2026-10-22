import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts/base-schemas";
import {
  createQuoteCitation,
  expandQuoteCitations,
  serializeQuoteCitation,
} from "@ryco/shared/quoteCitations";
import { describe, expect, it } from "vite-plus/test";

import { createFileReference } from "./fileReference.ts";
import { composeOutgoingPrompt } from "./sendEngine.ts";
import type { TerminalContextSelection } from "./terminalContext.ts";
import { deriveDisplayedUserMessage, expandOutgoingQuoteCitations } from "./userMessageQuotes.ts";

const citation = createQuoteCitation({
  source: { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") },
  messageId: MessageId.make("assistant-1"),
  selector: { exact: "Quoted words.", prefix: "", suffix: "", start: 0, end: 13 },
  comment: "First point\nSecond point",
});
const terminalContext: TerminalContextSelection = {
  terminalId: "t-1",
  terminalLabel: "Terminal 1",
  lineStart: 3,
  lineEnd: 4,
  text: "ls\nok",
};
const fileReference = createFileReference({
  path: "src/a.ts",
  lineStart: 1,
  lineEnd: 1,
  lines: ["const a = 1;"],
})!;

// The send order: quotes expand first, the context blocks are appended after.
const sent = composeOutgoingPrompt({
  prompt: expandQuoteCitations(`Explain ${serializeQuoteCitation(citation)} please`),
  fileReferences: [fileReference],
  terminalContexts: [terminalContext],
});

describe("deriveDisplayedUserMessage", () => {
  it("shows the prompt without its quote and context blocks, and copies it as sent", () => {
    const displayed = deriveDisplayedUserMessage(sent);

    expect(displayed.visibleText).toBe("Explain [Quote 1] please");
    expect(displayed.quotes).toStrictEqual([{ number: 1, citation }]);
    expect(displayed.contexts).toHaveLength(1);
    expect(displayed.fileReferences).toStrictEqual([fileReference]);
    expect(displayed.copyText).toBe(sent);
  });

  it("leaves a message without quotes as before", () => {
    const displayed = deriveDisplayedUserMessage("Just a question.");
    expect(displayed.visibleText).toBe("Just a question.");
    expect(displayed.quotes).toEqual([]);
  });
});

describe("expandOutgoingQuoteCitations", () => {
  it("expands tokens ahead of context blocks already appended, once", () => {
    const draft = composeOutgoingPrompt({
      prompt: `Explain ${serializeQuoteCitation(citation)} please`,
      fileReferences: [fileReference],
      terminalContexts: [terminalContext],
    });

    expect(expandOutgoingQuoteCitations(draft)).toBe(sent);
    expect(expandOutgoingQuoteCitations(sent)).toBe(sent);
    expect(deriveDisplayedUserMessage(expandOutgoingQuoteCitations(draft)).quotes).toHaveLength(1);
  });

  it("returns text without tokens unchanged", () => {
    expect(expandOutgoingQuoteCitations("Plain words.")).toBe("Plain words.");
  });
});
