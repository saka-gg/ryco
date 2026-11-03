import { ProviderProjectCommands } from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  acpAvailableCommandsToSlashCommands,
  makeRecentProjectCommands,
  MAX_PROVIDER_SLASH_COMMANDS,
  MAX_SLASH_COMMAND_DESCRIPTION,
  MAX_SLASH_COMMAND_NAME,
  normalizeProviderSlashCommands,
  parseSlashCommandInput,
} from "./providerSlashCommands.ts";

const encodeProjectCommands = Schema.encodeUnknownSync(ProviderProjectCommands);

describe("normalizeProviderSlashCommands", () => {
  it("trims, strips one leading slash and omits blank descriptions and hints", () => {
    const commands = normalizeProviderSlashCommands([
      { name: "  /review ", description: "  Review a PR ", hint: " <pr> " },
      { name: "plain", description: "   ", hint: "" },
      { name: "nulls", description: null, hint: null },
    ]);
    expect(commands).toEqual([
      { name: "review", description: "Review a PR", input: { hint: "<pr>" } },
      { name: "plain" },
      { name: "nulls" },
    ]);
    // What the RPC encodes: an untrimmed or blank string would fail here.
    expect(() => encodeProjectCommands({ skills: [], slashCommands: commands })).not.toThrow();
  });

  it("drops empty and overlong names and names with whitespace or a slash", () => {
    expect(
      normalizeProviderSlashCommands([
        { name: "" },
        { name: "   " },
        { name: "/" },
        { name: "//double" },
        { name: "two words" },
        { name: "tab\tname" },
        { name: "path/like" },
        { name: "ok-name_1:x" },
        { name: "x".repeat(MAX_SLASH_COMMAND_NAME + 1) },
        { name: "y".repeat(MAX_SLASH_COMMAND_NAME) },
      ]).map((command) => command.name),
    ).toEqual(["ok-name_1:x", "y".repeat(MAX_SLASH_COMMAND_NAME)]);
  });

  it("keeps the first of names equal ignoring case", () => {
    expect(
      normalizeProviderSlashCommands([
        { name: "Review", description: "first" },
        { name: "/review", description: "second" },
        { name: "REVIEW", description: "third" },
      ]),
    ).toEqual([{ name: "Review", description: "first" }]);
  });

  it("drops hidden names whatever their case", () => {
    expect(
      normalizeProviderSlashCommands(
        [{ name: "Always-Approve" }, { name: "/context" }, { name: "review" }],
        { hidden: new Set(["always-approve", "context"]) },
      ).map((command) => command.name),
    ).toEqual(["review"]);
  });

  it("caps the count and the description and hint length", () => {
    const many = Array.from({ length: MAX_PROVIDER_SLASH_COMMANDS + 50 }, (_, index) => ({
      name: `command-${index}`,
    }));
    const capped = normalizeProviderSlashCommands(many);
    expect(capped).toHaveLength(MAX_PROVIDER_SLASH_COMMANDS);
    expect(capped.at(-1)?.name).toBe(`command-${MAX_PROVIDER_SLASH_COMMANDS - 1}`);

    const [long] = normalizeProviderSlashCommands([
      { name: "long", description: "x".repeat(1_000), hint: "y".repeat(1_000) },
    ]);
    expect(long?.description).toHaveLength(MAX_SLASH_COMMAND_DESCRIPTION);
    expect(long?.description?.endsWith("…")).toBe(true);
    expect(long?.input?.hint).toHaveLength(MAX_SLASH_COMMAND_DESCRIPTION);
    expect(
      normalizeProviderSlashCommands([
        { name: "exact", description: "z".repeat(MAX_SLASH_COMMAND_DESCRIPTION) },
      ])[0]?.description,
    ).toBe("z".repeat(MAX_SLASH_COMMAND_DESCRIPTION));
  });

  it("never cuts a surrogate pair in half", () => {
    const description = `${"a".repeat(MAX_SLASH_COMMAND_DESCRIPTION - 2)}😀${"b".repeat(10)}`;
    const [command] = normalizeProviderSlashCommands([{ name: "emoji", description }]);
    expect(command?.description).toBe(`${"a".repeat(MAX_SLASH_COMMAND_DESCRIPTION - 2)}…`);
  });
});

describe("acpAvailableCommandsToSlashCommands", () => {
  it("maps ACP commands and copies no metadata", () => {
    expect(
      acpAvailableCommandsToSlashCommands([
        {
          name: "review",
          description: " Review ",
          input: { hint: "<pr>", _meta: { secret: true } },
          _meta: { source: "agent" },
        },
        { name: "plain", description: "", input: null },
      ]),
    ).toEqual([
      { name: "review", description: "Review", input: { hint: "<pr>" } },
      { name: "plain" },
    ]);
  });
});

describe("parseSlashCommandInput", () => {
  it("splits a command from its arguments", () => {
    expect(parseSlashCommandInput("/review a b")).toEqual({ name: "review", arguments: "a b" });
    expect(parseSlashCommandInput("/review")).toEqual({ name: "review", arguments: "" });
    expect(parseSlashCommandInput("  /x")).toEqual({ name: "x", arguments: "" });
    expect(parseSlashCommandInput("/fix line one\nline two  ")).toEqual({
      name: "fix",
      arguments: "line one\nline two",
    });
  });

  it("rejects paths, a bare slash and text that does not start with a command", () => {
    expect(parseSlashCommandInput("/Users/x y")).toBeUndefined();
    expect(parseSlashCommandInput("/")).toBeUndefined();
    expect(parseSlashCommandInput("hello /x")).toBeUndefined();
    expect(parseSlashCommandInput("")).toBeUndefined();
    expect(parseSlashCommandInput(undefined)).toBeUndefined();
  });
});

describe("makeRecentProjectCommands", () => {
  it("serves the newest list per directory", () => {
    const recent = makeRecentProjectCommands();
    expect(recent.read("/repo")).toBeUndefined();
    recent.record("/repo", [{ name: "old" }]);
    recent.record("/repo", [{ name: "new" }]);
    recent.record("/other", []);
    expect(recent.read("/repo")).toEqual({ skills: [], slashCommands: [{ name: "new" }] });
    expect(recent.read("/other")).toEqual({ skills: [], slashCommands: [] });
  });

  it("evicts the least recently recorded directory beyond its capacity", () => {
    const recent = makeRecentProjectCommands();
    for (let index = 0; index < 16; index += 1) {
      recent.record(`/repo-${index}`, [{ name: `c${index}` }]);
    }
    // A record refreshes recency: /repo-0 is now the newest.
    recent.record("/repo-0", [{ name: "c0-again" }]);
    recent.record("/repo-16", [{ name: "c16" }]);
    expect(recent.read("/repo-1")).toBeUndefined();
    expect(recent.read("/repo-0")?.slashCommands).toEqual([{ name: "c0-again" }]);
    expect(recent.read("/repo-2")).toBeDefined();
    expect(recent.read("/repo-16")).toBeDefined();
  });

  it("honours a custom capacity", () => {
    const recent = makeRecentProjectCommands(1);
    recent.record("/a", [{ name: "a" }]);
    recent.record("/b", [{ name: "b" }]);
    expect(recent.read("/a")).toBeUndefined();
    expect(recent.read("/b")).toBeDefined();
  });
});
