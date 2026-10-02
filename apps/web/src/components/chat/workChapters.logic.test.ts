import { describe, expect, it } from "vite-plus/test";

import { type WorkLogEntry } from "../../session-logic";
import {
  chapterFallbackTitle,
  chapterTitleFromMessage,
  classifyChapterStep,
  deriveChapterStepDisplay,
  deriveChapterTallies,
  formatChapterDuration,
  reasoningTail,
  selectTickerEntries,
} from "./workChapters.logic";

function entry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "entry",
    createdAt: "2026-01-01T00:00:00Z",
    label: "Tool",
    tone: "tool",
    ...overrides,
  };
}

const running = { completed: false } as const;
const done = { completed: true } as const;

describe("deriveChapterStepDisplay", () => {
  it("rolls a command's verb from present to past tense", () => {
    const live = deriveChapterStepDisplay(
      entry({
        ...running,
        command: "bun run test relay",
        itemType: "command_execution",
        startedAt: "2026-01-01T00:00:00Z",
      }),
      undefined,
    );
    expect(live).toMatchObject({ kind: "run", verb: "Running", targetIsCode: true });
    expect(live.meta).toEqual({ type: "live", startedAt: "2026-01-01T00:00:00Z" });

    const settled = deriveChapterStepDisplay(
      entry({
        ...done,
        command: "bun run test relay",
        itemType: "command_execution",
        startedAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:06Z",
      }),
      undefined,
    );
    expect(settled).toMatchObject({ verb: "Ran", status: "completed" });
    expect(settled.meta).toEqual({ type: "text", text: "6.0s", failed: false });
  });

  it("labels a command from its normalized form, not the shell wrapper", () => {
    const display = deriveChapterStepDisplay(
      entry({
        ...done,
        itemType: "command_execution",
        command: "sed -n '1,40p' src/relay/client.ts",
        rawCommand: `/bin/zsh -lc "sed -n '1,40p' src/relay/client.ts"`,
      }),
      undefined,
    );
    expect(display).toMatchObject({ kind: "read", verb: "Read" });
    expect(display.target).not.toContain("/bin/zsh");
  });

  it("reports a failed command by its exit code", () => {
    const display = deriveChapterStepDisplay(
      entry({ ...done, command: "bun lint", itemType: "command_execution", exitCode: 2 }),
      undefined,
    );
    expect(display.status).toBe("failed");
    expect(display.meta).toEqual({ type: "text", text: "exit 2", failed: true });
  });

  it("shows an edit's workspace-relative path and diff", () => {
    const display = deriveChapterStepDisplay(
      entry({
        ...done,
        itemType: "file_change",
        changedFiles: ["/repo/packages/relay/client.ts"],
        changedFileStats: [{ path: "/repo/packages/relay/client.ts", additions: 11, deletions: 2 }],
      }),
      "/repo",
    );
    expect(display).toMatchObject({ kind: "edit", verb: "Edited", target: "relay/client.ts" });
    expect(display.meta).toEqual({ type: "diff", additions: 11, deletions: 2 });
  });

  it("recognises provider read tools by name", () => {
    const display = deriveChapterStepDisplay(
      entry({ ...done, toolTitle: "Read", detail: '{"file_path":"/repo/src/app.ts"}' }),
      "/repo",
    );
    expect(display).toMatchObject({ kind: "read", verb: "Read", target: "app.ts" });
  });

  it("labels reasoning with its headline, live tail and duration", () => {
    const live = deriveChapterStepDisplay(
      entry({
        ...running,
        tone: "thinking",
        itemType: "reasoning",
        output: "checking whether the counter resets after a handshake",
        startedAt: "2026-01-01T00:00:00Z",
      }),
      undefined,
    );
    expect(live).toMatchObject({
      kind: "think",
      verb: "Thinking",
      target: "checking whether the counter resets after a handshake",
    });

    const settled = deriveChapterStepDisplay(
      entry({
        ...done,
        tone: "thinking",
        itemType: "reasoning",
        detail: "Tracing reconnects",
        output: "full text",
        startedAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:06.400Z",
      }),
      undefined,
    );
    expect(settled).toMatchObject({ verb: "Thought for 6.4s", target: "Tracing reconnects" });
  });
});

describe("chapter summaries", () => {
  it("tallies steps by kind, failures and diff, ignoring reasoning", () => {
    const tallies = deriveChapterTallies([
      entry({ toolTitle: "Read", ...done }),
      entry({ command: "rg -n reconnect src", itemType: "command_execution", ...done }),
      entry({ command: "bun lint", itemType: "command_execution", exitCode: 1, ...done }),
      entry({
        itemType: "file_change",
        changedFiles: ["a.ts"],
        changedFileStats: [{ path: "a.ts", additions: 4, deletions: 1 }],
        ...done,
      }),
      entry({ tone: "thinking", itemType: "reasoning", ...done }),
    ]);
    expect(tallies.counts).toMatchObject({ read: 1, search: 1, run: 1, edit: 1 });
    expect(tallies).toMatchObject({ failed: 1, additions: 4, deletions: 1, hasDiff: true });
  });

  it("titles a folded chapter from its paragraph without markdown syntax", () => {
    expect(
      chapterTitleFromMessage(
        "## Plan\n\nI'll **fix** the [fixture](http://x) and keep `readiness` intact.\n\nMore.",
      ),
    ).toBe("Plan");
    expect(
      chapterTitleFromMessage("I'll **fix** the [fixture](http://x) and keep `readiness`."),
    ).toBe("I'll fix the fixture and keep `readiness`.");
  });

  it("falls back to the work done when a chapter has no paragraph", () => {
    const steps = [
      entry({ toolTitle: "Read", ...done }),
      entry({ toolTitle: "Read", ...done }),
      entry({ command: "bun test", itemType: "command_execution", ...done }),
    ];
    expect(chapterFallbackTitle(steps, deriveChapterTallies(steps))).toBe(
      "Read 2 files, Ran 1 command",
    );
    const thoughts = [
      entry({
        ...done,
        tone: "thinking",
        itemType: "reasoning",
        startedAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:05Z",
      }),
    ];
    expect(chapterFallbackTitle(thoughts, deriveChapterTallies(thoughts))).toBe("Thought for 5.0s");
    const titled = [{ ...thoughts[0]!, detail: "Weighing the ordering" }];
    expect(chapterFallbackTitle(titled, deriveChapterTallies(titled))).toBe(
      "Weighing the ordering",
    );
  });

  it("keeps the newest steps in the ticker window", () => {
    expect(selectTickerEntries([1, 2], 3)).toEqual({ hiddenCount: 0, visible: [1, 2] });
    expect(selectTickerEntries([1, 2, 3, 4, 5], 3)).toEqual({ hiddenCount: 2, visible: [3, 4, 5] });
  });

  it("formats chapter durations and reasoning tails", () => {
    expect(formatChapterDuration("2026-01-01T00:00:00Z", "2026-01-01T00:01:49Z")).toBe("1m 49s");
    expect(formatChapterDuration("2026-01-01T00:00:00Z", null)).toBeNull();
    expect(reasoningTail("short thought")).toBe("short thought");
    expect(reasoningTail(`${"lead ".repeat(40)}final words`, 20)).toBe("…lead final words");
  });

  it("classifies web and subagent steps", () => {
    expect(classifyChapterStep(entry({ itemType: "web_search" }))).toBe("web");
    expect(classifyChapterStep(entry({ itemType: "collab_agent_tool_call" }))).toBe("agent");
  });
});
