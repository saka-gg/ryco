import {
  composeOutgoingPrompt,
  createBrowserElementReference,
  createFileReference,
} from "@ryco/client-runtime/state/composer";
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

  describe("picked page elements", () => {
    const element = createBrowserElementReference({
      url: "http://localhost:3000/settings",
      pageTitle: "Settings",
      selector: "#save",
      tagName: "button",
      role: "button",
      name: "Save changes",
      text: "Save changes",
      box: { x: 10, y: 20, width: 120, height: 32 },
      comment: "Make it primary",
    })!;
    const file = createFileReference({
      path: "src/app.ts",
      lineStart: 3,
      lineEnd: 3,
      lines: ["const a = 1;"],
    })!;
    const withElement = composeOutgoingPrompt({
      prompt: "Restyle this",
      fileReferences: [element, file],
    });

    it("shows them as chips on the desktop tier", () => {
      const displayed = deriveDisplayedUserMessageForTier(withElement, "desktop");

      expect(displayed.visibleText).toBe("Restyle this");
      expect(displayed.browserElements).toEqual([element]);
      expect(displayed.fileReferences).toEqual([file]);
    });

    it("leaves them as sent on the frozen phone tier, which keeps its file chips", () => {
      const displayed = deriveDisplayedUserMessageForTier(withElement, "phone");

      expect(displayed.browserElements).toEqual([]);
      expect(displayed.visibleText).toBe(
        withElement.slice(0, withElement.indexOf("<file_context>")).trimEnd(),
      );
      expect(displayed.visibleText).toMatch(/^Restyle this\n\n<browser_context>\n/u);
      expect(displayed.fileReferences).toEqual([file]);
      expect(displayed.copyText).toBe(withElement);
    });

    it("leaves a message of page elements alone as sent on the phone tier", () => {
      const sent = composeOutgoingPrompt({ prompt: "", fileReferences: [element] });
      const displayed = deriveDisplayedUserMessageForTier(sent, "phone");

      expect(displayed.visibleText).toBe(sent);
      expect(displayed.browserElements).toEqual([]);
    });
  });
});
