import { describe, expect, it } from "vite-plus/test";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  formatComposerFileReference,
  isLocalFilePathInsideDirectory,
  isCollapsedCursorAdjacentToInlineToken,
  parseStandaloneComposerSlashCommand,
  parseThreadGoalSlashCommand,
  replaceTextRange,
  shouldUseNativeComposerFileReference,
} from "./composer-logic";
import { serializeComposerMentionPath } from "./composerMentionSyntax";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("detectComposerTrigger", () => {
  it("detects @path trigger at cursor", () => {
    const text = "Please check @src/com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "Please check ".length,
      rangeEnd: text.length,
    });
  });

  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps /model as a slash command item", () => {
    const text = "/model";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "model",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("does not keep a subcommand trigger active after /model arguments", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("detects non-model slash commands while typing", () => {
    const text = "/pl";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "pl",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps slash command detection active for provider commands", () => {
    const text = "/rev";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects $skill trigger at cursor", () => {
    const text = "Use $gh-fi";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "skill",
      query: "gh-fi",
      rangeStart: "Use ".length,
      rangeEnd: text.length,
    });
  });

  it("detects @path trigger in the middle of existing text", () => {
    // User typed @ between "inspect " and "in this sentence"
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).toEqual({
      kind: "path",
      query: "",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterAt,
    });
  });

  it("detects @path trigger with query typed mid-text", () => {
    // User typed @sr between "inspect " and "in this sentence"
    const text = "Please inspect @srin this sentence";
    const cursorAfterQuery = "Please inspect @sr".length;

    const trigger = detectComposerTrigger(text, cursorAfterQuery);
    expect(trigger).toEqual({
      kind: "path",
      query: "sr",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterQuery,
    });
  });

  it("detects trigger with true cursor even when regex-based mention detection would false-match", () => {
    // MENTION_TOKEN_REGEX can false-match plain text like "@in" as a mention.
    // The fix bypasses it by computing the expanded cursor from the Lexical node tree.
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).not.toBeNull();
    expect(trigger?.kind).toBe("path");
    expect(trigger?.query).toBe("");
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});

describe("expandCollapsedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(expandCollapsedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps collapsed mention cursor to expanded text cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  it("maps collapsed quoted mention cursor to expanded text cursor", () => {
    const text = 'what is in @"My File.md" please';
    const collapsedCursorAfterMention = "what is in ".length + 2;
    const expandedCursorAfterMention = 'what is in @"My File.md" '.length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  it("allows path trigger detection to close after selecting a mention", () => {
    const text = "what's in my @AGENTS.md ";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursor = expandCollapsedComposerCursor(text, collapsedCursorAfterMention);

    expect(detectComposerTrigger(text, expandedCursor)).toBeNull();
  });

  it("maps collapsed skill cursor to expanded text cursor", () => {
    const text = "run $review-follow-up then";
    const collapsedCursorAfterSkill = "run ".length + 2;
    const expandedCursorAfterSkill = "run $review-follow-up ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterSkill)).toBe(
      expandedCursorAfterSkill,
    );
  });
});

describe("collapseExpandedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(collapseExpandedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps expanded mention cursor back to collapsed cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("maps expanded quoted mention cursor back to collapsed cursor", () => {
    const text = 'what is in @"My File.md" please';
    const collapsedCursorAfterMention = "what is in ".length + 2;
    const expandedCursorAfterMention = 'what is in @"My File.md" '.length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("keeps replacement cursors aligned when another mention already exists earlier", () => {
    const text = "open @AGENTS.md then @src/index.ts ";
    const expandedCursor = text.length;
    const collapsedCursor = collapseExpandedComposerCursor(text, expandedCursor);

    expect(collapsedCursor).toBe("open ".length + 1 + " then ".length + 2);
    expect(expandCollapsedComposerCursor(text, collapsedCursor)).toBe(expandedCursor);
  });

  it("maps expanded skill cursor back to collapsed cursor", () => {
    const text = "run $review-follow-up then";
    const collapsedCursorAfterSkill = "run ".length + 2;
    const expandedCursorAfterSkill = "run $review-follow-up ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterSkill)).toBe(
      collapsedCursorAfterSkill,
    );
  });
});

describe("clampCollapsedComposerCursor", () => {
  it("clamps to collapsed prompt length when mentions are present", () => {
    const text = "open @AGENTS.md then ";

    expect(clampCollapsedComposerCursor(text, text.length)).toBe(
      "open ".length + 1 + " then ".length,
    );
    expect(clampCollapsedComposerCursor(text, Number.POSITIVE_INFINITY)).toBe(
      "open ".length + 1 + " then ".length,
    );
  });
});

describe("replaceTextRange trailing space consumption", () => {
  it("double space after insertion when replacement ends with space", () => {
    // Simulates: "and then |@AG| summarize" where | marks replacement range
    // The replacement is "@AGENTS.md " (with trailing space)
    // But if we don't extend rangeEnd, the existing space stays
    const text = "and then @AG summarize";
    const rangeStart = "and then ".length;
    const rangeEnd = "and then @AG".length;

    // Without consuming trailing space: double space
    const withoutConsume = replaceTextRange(text, rangeStart, rangeEnd, "@AGENTS.md ");
    expect(withoutConsume.text).toBe("and then @AGENTS.md  summarize");

    // With consuming trailing space: single space
    const extendedEnd = text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
    const withConsume = replaceTextRange(text, rangeStart, extendedEnd, "@AGENTS.md ");
    expect(withConsume.text).toBe("and then @AGENTS.md summarize");
  });
});

describe("formatComposerFileReference", () => {
  it("leaves simple paths unquoted", () => {
    expect(formatComposerFileReference("/tmp/input.json")).toBe("/tmp/input.json");
  });

  it("quotes paths containing whitespace", () => {
    expect(formatComposerFileReference("/tmp/input data.json")).toBe('"/tmp/input data.json"');
  });

  it("uses single quotes when the path already contains double quotes", () => {
    expect(formatComposerFileReference('/tmp/"quoted" name.json')).toBe(
      "'/tmp/\"quoted\" name.json'",
    );
  });

  it("uses JSON string quoting when both quote forms are present", () => {
    expect(formatComposerFileReference("/tmp/\"quoted\" and 'single'.json")).toBe(
      '"/tmp/\\"quoted\\" and \'single\'.json"',
    );
  });
});

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("My File.md")).toBe('"My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("local composer file references", () => {
  it("detects paths inside a workspace with segment boundaries", () => {
    expect(isLocalFilePathInsideDirectory("/tmp/workspace/data.json", "/tmp/workspace")).toBe(true);
    expect(isLocalFilePathInsideDirectory("/tmp/workspace2/data.json", "/tmp/workspace")).toBe(
      false,
    );
  });

  it("treats Windows drive paths case-insensitively", () => {
    expect(isLocalFilePathInsideDirectory("C:\\Project\\data.json", "c:\\project")).toBe(true);
  });

  it("treats Windows UNC paths case-insensitively", () => {
    expect(
      isLocalFilePathInsideDirectory("\\\\Server\\Share\\data.json", "\\\\server\\share"),
    ).toBe(true);
  });

  it("allows native paths only for local readable runtime contexts", () => {
    expect(
      shouldUseNativeComposerFileReference({
        resolvedPath: "/tmp/outside/data.json",
        cwd: "/tmp/workspace",
        runtimeMode: "workspace-write",
        isLocalDesktopEnvironment: true,
      }),
    ).toBe(false);
    expect(
      shouldUseNativeComposerFileReference({
        resolvedPath: "/tmp/workspace/data.json",
        cwd: "/tmp/workspace",
        runtimeMode: "workspace-write",
        isLocalDesktopEnvironment: true,
      }),
    ).toBe(true);
    expect(
      shouldUseNativeComposerFileReference({
        resolvedPath: "/tmp/outside/data.json",
        cwd: "/tmp/workspace",
        runtimeMode: "full-access",
        isLocalDesktopEnvironment: true,
      }),
    ).toBe(true);
    expect(
      shouldUseNativeComposerFileReference({
        resolvedPath: "/tmp/workspace/data.json",
        cwd: "/tmp/workspace",
        runtimeMode: "full-access",
        isLocalDesktopEnvironment: false,
      }),
    ).toBe(false);
  });
});

describe("isCollapsedCursorAdjacentToInlineToken", () => {
  it("returns false when no mention exists", () => {
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "right")).toBe(false);
  });

  it("keeps @query typing non-adjacent while no mention pill exists", () => {
    const text = "hello @pac";
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "right")).toBe(false);
  });

  it("detects left adjacency only when cursor is directly after a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd + 1, "left")).toBe(false);
  });

  it("detects right adjacency only when cursor is directly before a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "right")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "right")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart - 1, "right")).toBe(false);
  });

  it("treats terminal pills as inline tokens for adjacency checks", () => {
    const text = `open ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} next`;
    const tokenStart = "open ".length;
    const tokenEnd = tokenStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenStart, "right")).toBe(true);
  });

  it("treats skill pills as inline tokens for adjacency checks", () => {
    const text = "run $review-follow-up next";
    const tokenStart = "run ".length;
    const tokenEnd = tokenStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenStart, "right")).toBe(true);
  });
});

describe("detectComposerTrigger – source control", () => {
  it("matches '#' at start", () => {
    const text = "#";
    const t = detectComposerTrigger(text, 1);
    expect(t).toEqual({
      kind: "source-control",
      query: "",
      rangeStart: 0,
      rangeEnd: 1,
      directAttach: false,
    });
  });
  it("matches '#42' as numeric reference", () => {
    const text = "see #42 ";
    const t = detectComposerTrigger(text, 7);
    expect(t?.kind).toBe("source-control");
    expect(t?.query).toBe("42");
  });
  it("matches '#bug ' as text query", () => {
    const text = "fixing #bug now";
    // cursor=11 is right after "bug" (at the space), so token is "#bug"
    const t = detectComposerTrigger(text, 11);
    expect(t?.kind).toBe("source-control");
    expect(t?.query).toBe("bug");
  });
  it("matches '#https://github.com/.../issues/9' as URL", () => {
    const text = "ref #https://github.com/foo/bar/issues/9";
    const t = detectComposerTrigger(text, text.length);
    expect(t?.kind).toBe("source-control");
    expect(t?.query).toBe("https://github.com/foo/bar/issues/9");
  });
  it("does NOT match '#' mid-word", () => {
    const t = detectComposerTrigger("abc#42", 6);
    expect(t?.kind).not.toBe("source-control");
  });
  it("flags pure-digit '#42' query as directAttach", () => {
    const t = detectComposerTrigger("see #42 ", 7);
    expect(t?.kind).toBe("source-control");
    if (t?.kind !== "source-control") return;
    expect(t.directAttach).toBe(true);
  });
  it("does not flag text '#bug' query as directAttach", () => {
    const t = detectComposerTrigger("fixing #bug now", 11);
    expect(t?.kind).toBe("source-control");
    if (t?.kind !== "source-control") return;
    expect(t.directAttach).toBe(false);
  });
  it("does not flag URL '#https://…/9' query as directAttach", () => {
    const text = "ref #https://github.com/foo/bar/issues/9";
    const t = detectComposerTrigger(text, text.length);
    expect(t?.kind).toBe("source-control");
    if (t?.kind !== "source-control") return;
    expect(t.directAttach).toBe(false);
  });
  it("does not flag '#0' as directAttach (positive integers only)", () => {
    const t = detectComposerTrigger("see #0 ", 6);
    expect(t?.kind).toBe("source-control");
    if (t?.kind !== "source-control") return;
    expect(t.directAttach).toBe(false);
  });
  it("does not flag leading-zero '#042' as directAttach", () => {
    const t = detectComposerTrigger("see #042 ", 8);
    expect(t?.kind).toBe("source-control");
    if (t?.kind !== "source-control") return;
    expect(t.directAttach).toBe(false);
  });
});

describe("parseStandaloneComposerSlashCommand", () => {
  it("parses standalone /plan command", () => {
    expect(parseStandaloneComposerSlashCommand(" /plan ")).toBe("plan");
  });

  it("parses standalone /default command", () => {
    expect(parseStandaloneComposerSlashCommand("/default")).toBe("default");
  });

  it("ignores slash commands with extra message text", () => {
    expect(parseStandaloneComposerSlashCommand("/plan explain this")).toBeNull();
  });
});

describe("parseThreadGoalSlashCommand", () => {
  it.each(["pause", "resume", "clear"])("parses %s as a control", (action) => {
    expect(parseThreadGoalSlashCommand(`/goal ${action}`)).toEqual({ action });
    expect(parseThreadGoalSlashCommand(` /GOAL ${action.toUpperCase()} `)).toEqual({ action });
    expect(parseThreadGoalSlashCommand(`/goal ${action} the migration`)).toEqual({
      action: "set",
      objective: `${action} the migration`,
    });
  });
  it("returns the trimmed objective", () => {
    expect(parseThreadGoalSlashCommand(" /goal  Ship a reliable reconnect flow  ")).toEqual({
      action: "set",
      objective: "Ship a reliable reconnect flow",
    });
  });

  it("shows the current goal for a bare command", () => {
    expect(parseThreadGoalSlashCommand("/goal")).toEqual({ action: "show" });
  });

  it("does not capture ordinary messages", () => {
    expect(parseThreadGoalSlashCommand("Please use /goal later")).toBeNull();
    expect(parseThreadGoalSlashCommand("/goals are useful")).toBeNull();
  });
});
