import { describe, expect, it } from "vite-plus/test";

import {
  deriveLiveThought,
  firstThoughtSentence,
  isLiveWorkStep,
  isReasoningWorkEntry,
  isWorkNoticeEntry,
  reasoningEntryHeadline,
  reasoningEntryText,
  reasoningTail,
  resolveWorkEntryStatus,
} from "./liveWorkSteps.ts";
import type { WorkLogEntry } from "./session-logic.ts";

function entry(id: string, overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return { id, createdAt: "2026-01-01T00:00:00Z", label: "Tool call", tone: "tool", ...overrides };
}

function thought(id: string, output: string, overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return entry(id, {
    tone: "thinking",
    itemType: "reasoning",
    label: "Reasoning",
    output,
    ...overrides,
  });
}

const tool = (id: string, overrides: Partial<WorkLogEntry> = {}) =>
  entry(id, { itemType: "dynamic_tool_call", toolTitle: "Read", ...overrides });

describe("resolveWorkEntryStatus", () => {
  it("fails on an error tone or a non-zero exit, else runs until the lifecycle settles", () => {
    expect(resolveWorkEntryStatus({ tone: "tool" })).toBe("running");
    expect(resolveWorkEntryStatus({ tone: "tool", completed: true })).toBe("completed");
    expect(resolveWorkEntryStatus({ tone: "tool", completed: true, exitCode: 0 })).toBe(
      "completed",
    );
    expect(resolveWorkEntryStatus({ tone: "tool", completed: true, exitCode: 2 })).toBe("failed");
    expect(resolveWorkEntryStatus({ tone: "error" })).toBe("failed");
  });
});

describe("live work steps", () => {
  it("never counts notices or approval rows as running", () => {
    const notice = entry("warn", { tone: "info", label: "Runtime warning" });
    expect(isWorkNoticeEntry(notice)).toBe(true);
    expect(isLiveWorkStep(notice)).toBe(false);
    expect(isLiveWorkStep(tool("approval", { approvalLifecycle: true }))).toBe(false);
    expect(isWorkNoticeEntry(tool("read"))).toBe(false);
  });

  it("counts unsettled tool calls and streaming reasoning, not settled or failed ones", () => {
    expect(isLiveWorkStep(tool("read"))).toBe(true);
    expect(isLiveWorkStep(thought("think", "Hmm"))).toBe(true);
    expect(isLiveWorkStep(tool("done", { completed: true }))).toBe(false);
    expect(isLiveWorkStep(tool("failed", { completed: true, exitCode: 1 }))).toBe(false);
  });
});

describe("reasoning readers", () => {
  it("reads a block's text, headline and tail", () => {
    const block = thought("think", "  Weighing the order.  ", { detail: " Ordering " });
    expect(isReasoningWorkEntry(block)).toBe(true);
    expect(isReasoningWorkEntry(tool("read"))).toBe(false);
    expect(reasoningEntryText(block)).toBe("Weighing the order.");
    expect(reasoningEntryHeadline(block)).toBe("Ordering");
    expect(reasoningEntryHeadline(thought("plain", "x"))).toBeNull();
    expect(reasoningTail("short thought")).toBe("short thought");
    expect(reasoningTail(`${"lead ".repeat(40)}final words`, 20)).toBe("…lead final words");
  });
});

describe("firstThoughtSentence", () => {
  it("takes the first sentence of the text, on one line and without markdown", () => {
    expect(firstThoughtSentence("I should check the **relay** client first. Then the tests.")).toBe(
      "I should check the relay client first.",
    );
    expect(firstThoughtSentence("Looking at `ws.ts`\nfor the handshake")).toBe("Looking at ws.ts");
    expect(firstThoughtSentence("Does the cache expire? Probably not.")).toBe(
      "Does the cache expire?",
    );
    expect(firstThoughtSentence("Reading relay/client.ts to see how it reconnects")).toBe(
      "Reading relay/client.ts to see how it reconnects",
    );
    expect(firstThoughtSentence("   ")).toBeNull();
  });

  it("skips the cut-off fragment a streaming tail starts with", () => {
    expect(firstThoughtSentence("…the socket closes. Now I'll patch the retry. Then test.")).toBe(
      "Now I'll patch the retry.",
    );
    // No whole sentence after the cut yet: the fragment is all there is.
    expect(firstThoughtSentence("…and then the socket closes")).toBe("…and then the socket closes");
  });

  it("caps a long sentence at a word with an ellipsis", () => {
    const line = firstThoughtSentence(`${"word ".repeat(60)}end.`);
    expect(line?.length).toBeLessThanOrEqual(140);
    expect(line?.endsWith("word…")).toBe(true);
  });
});

describe("deriveLiveThought", () => {
  it("sits the newest thought above the step still running after it", () => {
    expect(
      deriveLiveThought([
        thought("t1", "First I read the config."),
        tool("read", { completed: true }),
        thought("t2", "The retry loop never backs off. I'll add a delay."),
        tool("edit", { completed: true }),
        tool("test", { itemType: "command_execution", command: "bun run test" }),
      ]),
    ).toEqual({
      text: "The retry loop never backs off.",
      reasoningEntryId: "t2",
      runningStepId: "test",
    });
  });

  it("closes the list when nothing runs after the thought", () => {
    expect(
      deriveLiveThought([
        tool("old", { itemType: "command_execution", command: "bun dev" }),
        thought("t1", "Next I compare both clients."),
      ]),
    ).toEqual({
      text: "Next I compare both clients.",
      reasoningEntryId: "t1",
      runningStepId: null,
    });
  });

  it("prefers the provider's headline and keeps the last thought while a new block is empty", () => {
    expect(
      deriveLiveThought([
        thought("t1", "**Inspecting the relay**\n\nLong text.", { detail: "Inspecting the relay" }),
        thought("t2", ""),
        tool("read"),
      ]),
    ).toEqual({ text: "Inspecting the relay", reasoningEntryId: "t1", runningStepId: "read" });
  });

  it("is null without readable reasoning", () => {
    expect(deriveLiveThought([tool("read"), thought("t1", "  ")])).toBeNull();
    expect(deriveLiveThought([])).toBeNull();
  });
});
