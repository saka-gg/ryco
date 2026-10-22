import { describe, expect, it } from "vite-plus/test";

import { createFileReference, type FileReference } from "./fileReference.ts";
import {
  composeOutgoingPrompt,
  deriveDisplayedUserMessageContext,
  extractTrailingPromptContexts,
} from "./promptContext.ts";
import {
  appendTerminalContextsToPrompt,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextSelection,
} from "./terminalContext.ts";

function fileReference(lines: string[], path = "docs/files-to-chat.md"): FileReference {
  const created = createFileReference({ path, lineStart: 10, lineEnd: 9 + lines.length, lines });
  if (!created) throw new Error("Expected a file reference.");
  return created;
}

const terminal: TerminalContextSelection = {
  terminalId: "t1",
  terminalLabel: "Terminal 1",
  lineStart: 1,
  lineEnd: 2,
  text: "$ bun run check\nerror",
};

describe("composeOutgoingPrompt", () => {
  it("sends the prompt, then the file block, then the terminal block", () => {
    const sent = composeOutgoingPrompt({
      prompt: `Please look ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} \n`,
      fileReferences: [fileReference(["one"])],
      terminalContexts: [terminal],
    });
    expect(sent).toBe(
      [
        "Please look @terminal-1:1-2",
        "",
        "<file_context>",
        "- docs/files-to-chat.md line 10:",
        "  10 | one",
        "</file_context>",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 1-2:",
        "  1 | $ bun run check",
        "  2 | error",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("matches the terminal-only composition when no file is referenced", () => {
    for (const [prompt, contexts] of [
      ["Fix it", [terminal]],
      [`${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} why?`, [terminal]],
      ["  just text  ", []],
      ["", [terminal]],
      [`stray ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}`, []],
    ] as const) {
      expect(composeOutgoingPrompt({ prompt, terminalContexts: contexts })).toBe(
        appendTerminalContextsToPrompt(prompt, contexts),
      );
    }
  });

  it("resolves terminal placeholders in the user's text only", () => {
    const snippet = fileReference([`const marker = '${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}';`]);
    for (const terminalContexts of [[], [terminal]]) {
      const sent = composeOutgoingPrompt({
        prompt: "Look",
        fileReferences: [snippet],
        terminalContexts,
      });
      expect(sent).toContain(`  10 | const marker = '${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}';`);
      expect(extractTrailingPromptContexts(sent).fileReferences).toEqual([snippet]);
    }
  });
});

describe("extractTrailingPromptContexts", () => {
  it("reads a file excerpt that mentions a terminal block back whole", () => {
    // Lines of a doc that itself shows a terminal block.
    const doc = fileReference(["```text", "<terminal_context>", "- Terminal 1 line 1:"]);
    const sent = composeOutgoingPrompt({
      prompt: "Please look",
      fileReferences: [doc],
      terminalContexts: [terminal],
    });
    const extracted = extractTrailingPromptContexts(sent);
    expect(extracted.promptText).toBe("Please look");
    expect(extracted.fileReferences).toEqual([doc]);
    expect(extracted.contextCount).toBe(1);
    expect(extracted.contexts).toEqual([
      { header: "Terminal 1 lines 1-2", body: "1 | $ bun run check\n2 | error" },
    ]);
  });

  it("round-trips every combination of blocks", () => {
    const files = [fileReference(["a", "b"]), fileReference(["c"], "src/app.ts")];
    for (const fileReferences of [[], files]) {
      for (const terminalContexts of [[], [terminal]]) {
        const extracted = extractTrailingPromptContexts(
          composeOutgoingPrompt({ prompt: "Hi there", fileReferences, terminalContexts }),
        );
        expect(extracted.promptText).toBe("Hi there");
        expect(extracted.fileReferences).toEqual(fileReferences);
        expect(extracted.contextCount).toBe(terminalContexts.length);
      }
    }
  });

  it("keeps a terminal tag that does not start a line as text", () => {
    const prompt = "Why does <terminal_context>\nappear here?\n</terminal_context>";
    expect(extractTrailingPromptContexts(prompt)).toMatchObject({
      promptText: prompt,
      contextCount: 0,
      fileReferences: [],
    });
  });
});

describe("deriveDisplayedUserMessageContext", () => {
  it("shows and searches the user's own text, with both kinds of context beside it", () => {
    const doc = fileReference(["needle in a file"]);
    const sent = composeOutgoingPrompt({
      prompt: "Find the bug",
      fileReferences: [doc],
      terminalContexts: [terminal],
    });
    const displayed = deriveDisplayedUserMessageContext(sent);
    expect(displayed.visibleText).toBe("Find the bug");
    expect(displayed.visibleText).not.toContain("needle");
    expect(displayed.copyText).toBe(sent);
    expect(displayed.fileReferences).toEqual([doc]);
    expect(displayed.contextCount).toBe(1);
    expect(displayed.previewTitle).toBe("Terminal 1 lines 1-2\n1 | $ bun run check\n2 | error");
  });
});
