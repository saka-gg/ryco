import { assert, describe, it } from "vite-plus/test";

import {
  formatNoteAge,
  noteSummaryText,
  parseNoteTodo,
  splitInlineCode,
  toggleNoteTodo,
} from "./noteText.logic";

describe("parseNoteTodo", () => {
  it("reads open and done prefixes", () => {
    assert.deepEqual(parseNoteTodo("[ ] ship it"), { todo: "open", text: "ship it" });
    assert.deepEqual(parseNoteTodo("[x] shipped"), { todo: "done", text: "shipped" });
    assert.deepEqual(parseNoteTodo("[X]  shipped"), { todo: "done", text: "shipped" });
  });

  it("leaves plain notes and mid-text brackets alone", () => {
    assert.deepEqual(parseNoteTodo("plain"), { todo: null, text: "plain" });
    assert.deepEqual(parseNoteTodo("see [ ] later"), { todo: null, text: "see [ ] later" });
    assert.deepEqual(parseNoteTodo("[y] nope"), { todo: null, text: "[y] nope" });
  });
});

describe("toggleNoteTodo", () => {
  it("flips the prefix and keeps the rest verbatim", () => {
    assert.equal(toggleNoteTodo("[ ] a  `b`\nc"), "[x] a  `b`\nc");
    assert.equal(toggleNoteTodo("[x] a"), "[ ] a");
    assert.equal(toggleNoteTodo("[X] a"), "[ ] a");
  });

  it("round-trips", () => {
    assert.equal(toggleNoteTodo(toggleNoteTodo("[ ] keep")), "[ ] keep");
  });

  it("returns non-todos unchanged", () => {
    assert.equal(toggleNoteTodo("no todo"), "no todo");
  });
});

describe("noteSummaryText", () => {
  it("strips the todo prefix and collapses whitespace", () => {
    assert.equal(noteSummaryText("[ ] fix\n  the   thing", 40), "fix the thing");
  });

  it("truncates with an ellipsis within max", () => {
    const summary = noteSummaryText("abcdefghij", 6);
    assert.equal(summary, "abcde…");
    assert.equal(summary.length, 6);
    assert.equal(noteSummaryText("abcdef", 6), "abcdef");
  });
});

describe("splitInlineCode", () => {
  it("splits code spans from text", () => {
    assert.deepEqual(splitInlineCode("run `bun fmt` then `lint`."), [
      { kind: "text", text: "run " },
      { kind: "code", text: "bun fmt" },
      { kind: "text", text: " then " },
      { kind: "code", text: "lint" },
      { kind: "text", text: "." },
    ]);
  });

  it("keeps unpaired or empty backticks literal", () => {
    assert.deepEqual(splitInlineCode("a ` b"), [{ kind: "text", text: "a ` b" }]);
    assert.deepEqual(splitInlineCode("x `` y"), [{ kind: "text", text: "x `` y" }]);
    assert.deepEqual(splitInlineCode(""), []);
    assert.deepEqual(splitInlineCode("`x`"), [{ kind: "code", text: "x" }]);
  });
});

describe("formatNoteAge", () => {
  const NOW = Date.parse("2026-10-07T12:00:00.000Z");
  const before = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

  it("says now under 45 seconds, and for a clock running ahead", () => {
    assert.equal(formatNoteAge(before(44), NOW), "now");
    assert.equal(formatNoteAge(before(-30), NOW), "now");
  });

  it("rounds to the nearest minute, hour or day", () => {
    assert.equal(formatNoteAge(before(45), NOW), "1m ago");
    assert.equal(formatNoteAge(before(89), NOW), "1m ago");
    assert.equal(formatNoteAge(before(40 * 60 + 40), NOW), "41m ago");
    assert.equal(formatNoteAge(before(90 * 60), NOW), "2h ago");
    assert.equal(formatNoteAge(before(36 * 3600), NOW), "2d ago");
  });
});
