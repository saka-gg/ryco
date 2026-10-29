import type { Command } from "@opencode-ai/sdk/v2";
import { ProviderProjectCommands } from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { openCodeCommandsToSlashCommands } from "./openCodeCommands.ts";

const encodeProjectCommands = Schema.encodeUnknownSync(ProviderProjectCommands);

describe("openCodeCommandsToSlashCommands", () => {
  it("keeps the name, description and joined hints, never the template, agent or model", () => {
    const review: Command = {
      name: "review",
      description: " Review changes ",
      source: "command",
      hints: ["$1", "$ARGUMENTS"],
      template: "Review $1 with $ARGUMENTS",
      agent: "plan",
      model: "anthropic/claude-sonnet-4-5",
      subtask: true,
    };
    const commands = openCodeCommandsToSlashCommands([
      review,
      { name: "init", description: "create AGENTS.md", hints: [] },
    ]);
    expect(commands).toEqual([
      { name: "review", description: "Review changes", input: { hint: "$1 $ARGUMENTS" } },
      { name: "init", description: "create AGENTS.md" },
    ]);
    expect(JSON.stringify(commands)).not.toMatch(/template|plan|claude/u);
    expect(() => encodeProjectCommands({ skills: [], slashCommands: commands })).not.toThrow();
  });

  it("skips skills and keeps MCP prompts and commands without a source", () => {
    expect(
      openCodeCommandsToSlashCommands([
        { name: "brainstorm", source: "skill", hints: [] },
        { name: "mcp-prompt", source: "mcp", hints: [] },
        { name: "legacy", hints: [] },
      ]).map((command) => command.name),
    ).toEqual(["mcp-prompt", "legacy"]);
  });

  it("dedupes names ignoring case and tolerates a server without hints", () => {
    const withoutHints = { name: "old" } as Command;
    expect(
      openCodeCommandsToSlashCommands([
        { name: "Deploy", description: "first", hints: [] },
        { name: "deploy", description: "second", hints: ["$ARGUMENTS"] },
        withoutHints,
      ]),
    ).toEqual([{ name: "Deploy", description: "first" }, { name: "old" }]);
  });
});
