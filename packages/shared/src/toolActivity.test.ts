import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation, readToolCommandText } from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("shows the command of a Claude-shaped command tool (input.command)", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Command run",
        data: { toolName: "Bash", input: { command: "git status" } },
        fallbackSummary: "Command run",
      }),
    ).toEqual({ summary: "Ran command", detail: "git status" });
  });
});

describe("readToolCommandText", () => {
  it.each<[string, Parameters<typeof readToolCommandText>[0], string | undefined]>([
    ["Codex item.command", { data: { item: { command: "git push" } } }, "git push"],
    [
      "Codex item.input.command",
      { data: { item: { input: { command: "git pull" } } } },
      "git pull",
    ],
    [
      "Claude input.command",
      { data: { toolName: "Bash", input: { command: "git commit -m x" } } },
      "git commit -m x",
    ],
    ["ACP rawInput.command", { data: { rawInput: { command: "gh pr create" } } }, "gh pr create"],
    [
      "OpenCode state.input.command",
      { data: { state: { input: { command: "git switch main" } } } },
      "git switch main",
    ],
    [
      "an array command",
      { data: { item: { command: ["git", "checkout", "-b", "feat/x"] } } },
      "git checkout -b feat/x",
    ],
    [
      "a command_execution detail",
      { itemType: "command_execution", detail: "git push origin HEAD <exited with exit code 1>" },
      "git push origin HEAD",
    ],
    [
      "a detail of another item type",
      { itemType: "dynamic_tool_call", detail: "git push" },
      undefined,
    ],
    [
      "a Copilot tool completion (no tool input)",
      {
        itemType: "dynamic_tool_call",
        data: { toolCallId: "call-1", success: true, result: { content: "done" } },
      },
      undefined,
    ],
    ["no data", {}, undefined],
  ])("reads %s", (_label, input, expected) => {
    expect(readToolCommandText(input)).toBe(expected);
  });

  it("prefers structured data over the detail", () => {
    expect(
      readToolCommandText({
        itemType: "command_execution",
        detail: "output text",
        data: { item: { command: "git fetch" } },
      }),
    ).toBe("git fetch");
  });
});
