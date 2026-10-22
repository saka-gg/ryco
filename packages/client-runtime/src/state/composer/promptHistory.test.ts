import { describe, expect, it } from "vitest";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { appendAttachmentPathLines } from "@ryco/shared/attachmentPrompt";
import { applyClaudePromptEffortPrefix } from "@ryco/shared/model";

import {
  buildPromptHistoryEntries,
  recallablePrompt,
  stepPromptHistory,
  type PromptHistoryEntry,
} from "./promptHistory.ts";
import { appendSelectionQuote } from "./selectionQuote.ts";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
} from "./sendEngine.ts";
import {
  appendTerminalContextsToPrompt,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
} from "./terminalContext.ts";

const terminalContext = (terminalLabel: string, lineStart: number, lineEnd: number) => ({
  terminalId: terminalLabel.toLowerCase().replace(/\s+/g, "-"),
  terminalLabel,
  lineStart,
  lineEnd,
  text: "npm test\nFAIL src/app.test.ts",
});

const quote = {
  source: { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("thread-1") },
  messageId: MessageId.make("assistant-1"),
  text: "The cache key is the\n\nrequest path.",
};

describe("recallablePrompt", () => {
  it("removes terminal contexts and the inline labels that stood for them", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    const sent = appendTerminalContextsToPrompt(
      `Why does ${placeholder} fail when ${placeholder} passes?`,
      [terminalContext("Terminal 1", 12, 13), terminalContext("Terminal 1", 1, 1)],
    );
    expect(sent).toContain("@terminal-1:12-13");
    expect(sent).toContain("<terminal_context>");
    expect(recallablePrompt(sent)).toBe("Why does fail when passes?");
  });

  it("removes a label only where it stands as a whole token", () => {
    const sent = appendTerminalContextsToPrompt(
      `Compare @terminal-1:12 with ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}`,
      [terminalContext("Terminal 1", 1, 1)],
    );
    expect(recallablePrompt(sent)).toBe("Compare @terminal-1:12 with");
  });

  it("removes quoted assistant text with the blank lines around it", () => {
    const quoted = appendSelectionQuote("Explain the selection", quote);
    expect(recallablePrompt(`${quoted}And keep it short`)).toBe(
      "Explain the selection\n\nAnd keep it short",
    );
    expect(recallablePrompt(quoted.trim())).toBe("Explain the selection");
    expect(recallablePrompt(appendSelectionQuote("", quote).trim())).toBe("");
  });

  it("keeps text that only looks like a quote header", () => {
    const prompt = 'Quoted assistant text ({"note":"mine"}):\n> my own quote';
    expect(recallablePrompt(prompt)).toBe(prompt);
  });

  it("removes the Claude effort prefix and attachment path lines", () => {
    const sent = applyClaudePromptEffortPrefix("Look at the report", "ultrathink");
    expect(sent.startsWith("Ultrathink:")).toBe(true);
    const imported = appendAttachmentPathLines(sent, [
      "[Attached file] report (final).pdf (application/pdf, 123456 bytes) saved at: /tmp/a/report.pdf",
      "[Attached file] diagram.png (image/png, size unknown bytes)",
    ]);
    expect(recallablePrompt(imported ?? "")).toBe("Look at the report");
  });

  it("keeps mentions, skills and thread mentions, which the text alone carries", () => {
    const prompt = "Use $review on @src/app.ts like in @thread:thread-2";
    expect(recallablePrompt(`  ${prompt}\n`)).toBe(prompt);
  });

  it("recalls nothing for sends the app composed", () => {
    expect(recallablePrompt(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT)).toBe("");
    expect(
      recallablePrompt(
        appendAttachmentPathLines(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT, [
          "[Attached file] a.txt (text/plain, 3 bytes)",
        ]) ?? "",
      ),
    ).toBe("");
    expect(recallablePrompt(`${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan\n\n- step`)).toBe("");
    expect(
      recallablePrompt(
        applyClaudePromptEffortPrefix(`${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan`, "ultrathink"),
      ),
    ).toBe("");
  });
});

describe("buildPromptHistoryEntries", () => {
  it("keeps user prompts in order, skips empty ones and collapses repeats onto the latest", () => {
    expect(
      buildPromptHistoryEntries([
        { id: "u1", role: "user", text: "first" },
        { id: "a1", role: "assistant", text: "answer" },
        { id: "u2", role: "user", text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT },
        { id: "u3", role: "user", text: "again" },
        { id: "u4", role: "user", text: "again " },
        { id: "s1", role: "system", text: "note" },
        { id: "u5", role: "user", text: "last" },
      ]),
    ).toEqual([
      { id: "u1", prompt: "first" },
      { id: "u4", prompt: "again" },
      { id: "u5", prompt: "last" },
    ]);
  });
});

describe("stepPromptHistory", () => {
  const entries: PromptHistoryEntry[] = [
    { id: "u1", prompt: "first" },
    { id: "u2", prompt: "second" },
    { id: "u3", prompt: "third" },
  ];

  it("walks back from an empty composer, then forward to the empty composer again", () => {
    const newest = stepPromptHistory({
      direction: "backward",
      entries,
      position: null,
      currentPrompt: "",
    });
    expect(newest).toEqual({ position: { entryId: "u3", recalled: "third" }, prompt: "third" });
    const older = stepPromptHistory({
      direction: "backward",
      entries,
      position: newest!.position,
      currentPrompt: "third",
    });
    expect(older?.prompt).toBe("second");
    const oldest = stepPromptHistory({
      direction: "backward",
      entries,
      position: { entryId: "u1", recalled: "first" },
      currentPrompt: "first",
    });
    expect(oldest).toBeNull();
    const forward = stepPromptHistory({
      direction: "forward",
      entries,
      position: older!.position,
      currentPrompt: "second",
    });
    expect(forward?.prompt).toBe("third");
    expect(
      stepPromptHistory({
        direction: "forward",
        entries,
        position: forward!.position,
        currentPrompt: "third",
      }),
    ).toEqual({ position: null, prompt: "" });
  });

  it("leaves the keys alone for a typed draft, an edited recall, or no history", () => {
    expect(
      stepPromptHistory({ direction: "backward", entries, position: null, currentPrompt: "draft" }),
    ).toBeNull();
    expect(
      stepPromptHistory({
        direction: "backward",
        entries,
        position: { entryId: "u3", recalled: "third" },
        currentPrompt: "third, edited",
      }),
    ).toBeNull();
    expect(
      stepPromptHistory({ direction: "forward", entries, position: null, currentPrompt: "" }),
    ).toBeNull();
    expect(
      stepPromptHistory({ direction: "backward", entries: [], position: null, currentPrompt: "" }),
    ).toBeNull();
  });

  it("finds the recalled prompt by text when its message was replaced", () => {
    expect(
      stepPromptHistory({
        direction: "backward",
        entries,
        position: { entryId: "optimistic-u3", recalled: "third" },
        currentPrompt: "third",
      })?.prompt,
    ).toBe("second");
  });
});
