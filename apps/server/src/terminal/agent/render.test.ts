import { describe, expect, it } from "vite-plus/test";

import {
  MAX_LINE_CHARS,
  MIN_MAX_CHARS,
  clampMaxChars,
  clipLines,
  formatClip,
  formatDuration,
  shortCommand,
} from "./render.ts";

const numbered = (count: number, width = 9) =>
  Array.from({ length: count }, (_, index) => `line ${String(index + 1).padStart(width - 5, "0")}`);

const readMore = (fromLine: number) => `ryco_terminal(read, fromLine: ${fromLine})`;

describe("clampMaxChars", () => {
  it("keeps the size within bounds", () => {
    expect(clampMaxChars(1)).toBe(MIN_MAX_CHARS);
    expect(clampMaxChars(1_000_000)).toBe(60_000);
    expect(clampMaxChars(undefined)).toBe(20_000);
  });
});

describe("clipLines", () => {
  it("keeps everything that fits", () => {
    const clip = clipLines(["a", "b", "c"]);
    expect(clip).toEqual({
      text: "a\nb\nc",
      first: 1,
      last: 3,
      total: 3,
      omittedBefore: 0,
      omittedAfter: 0,
      longLinesCut: 0,
    });
  });

  it("keeps the tail within maxChars", () => {
    // Each line is 9 characters plus a newline: 50 lines fit in 500.
    const lines = numbered(200);
    const clip = clipLines(lines, { maxChars: 500 });
    expect(clip.text.length).toBeLessThanOrEqual(500);
    expect(clip.last).toBe(200);
    expect(clip.first).toBe(151);
    expect(clip.omittedBefore).toBe(150);
    expect(clip.omittedAfter).toBe(0);
    expect(clip.text.split("\n")).toEqual(lines.slice(150));
  });

  it("pages forward from a line", () => {
    const lines = numbered(200);
    const clip = clipLines(lines, { maxChars: 500, fromLine: 11 });
    expect(clip.first).toBe(11);
    expect(clip.last).toBe(60);
    expect(clip.omittedBefore).toBe(10);
    expect(clip.omittedAfter).toBe(140);
    expect(clip.text.split("\n")).toEqual(lines.slice(10, 60));
  });

  it("shows nothing when paging past the end", () => {
    const clip = clipLines(["a", "b"], { fromLine: 10 });
    expect(clip).toMatchObject({ text: "", first: 0, last: 0, omittedBefore: 2, omittedAfter: 0 });
  });

  it("cuts a very long line in its middle", () => {
    const long = `${"a".repeat(3_000)}${"z".repeat(3_000)}`;
    const clip = clipLines(["short", long]);
    expect(clip.longLinesCut).toBe(1);
    const shown = clip.text.split("\n")[1]!;
    expect(shown).toContain(`[${long.length - MAX_LINE_CHARS} characters cut]`);
    expect(shown.startsWith("a")).toBe(true);
    expect(shown.endsWith("z")).toBe(true);
  });

  it("is never empty when there are lines", () => {
    const clip = clipLines(["x".repeat(100_000)], { maxChars: MIN_MAX_CHARS });
    expect(clip.text).not.toBe("");
    expect(clip).toMatchObject({ first: 1, last: 1, total: 1, longLinesCut: 1 });
    expect(clipLines(["x".repeat(100_000)], { maxChars: 500, fromLine: 1 }).text).not.toBe("");
  });

  it("shows nothing for no lines", () => {
    expect(clipLines([])).toMatchObject({ text: "", first: 0, last: 0, total: 0 });
  });
});

describe("formatClip", () => {
  it("names the call that reads cut lines on either side", () => {
    const lines = numbered(200);
    const before = formatClip(clipLines(lines, { maxChars: 500 }), readMore);
    expect(before).toContain(
      "[Showing lines 151-200 of 200; 150 earlier lines cut. Read them with ryco_terminal(read, fromLine: 1).]",
    );

    const after = formatClip(clipLines(lines, { maxChars: 500, fromLine: 11 }), readMore);
    expect(
      after.endsWith("[140 more lines. Continue with ryco_terminal(read, fromLine: 61).]"),
    ).toBe(true);
  });

  it("says when the output is empty, its start is lost, or lines were shortened", () => {
    expect(formatClip(clipLines([]), readMore)).toBe("(no output)");
    const text = formatClip(clipLines(["x".repeat(5_000)]), readMore, {
      startLost: true,
      historyLines: 5_000,
    });
    expect(text).toContain(
      "[The beginning of this output is no longer in the terminal's history (5000 lines).]",
    );
    expect(text).toContain("[1 very long line(s) were shortened in the middle.]");
  });

  it("adds nothing when everything is shown", () => {
    expect(formatClip(clipLines(["a", "b"]), readMore)).toBe("a\nb");
  });
});

describe("formatDuration", () => {
  it.each([
    [-5, "0 ms"],
    [250.4, "250 ms"],
    [1_500, "1.5 s"],
    [12_400, "12 s"],
    [60_000, "1 min"],
    [125_000, "2 min 5 s"],
    [3_600_000, "1 h 0 min"],
    [5_400_000, "1 h 30 min"],
  ])("%d ms reads %j", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("shortCommand", () => {
  it("keeps short commands and folds newlines", () => {
    expect(shortCommand("echo a\n  echo b")).toBe("echo a ⏎ echo b");
  });

  it("keeps both ends of a long command", () => {
    const command = `bun run build --filter=@ryco/web ${"x".repeat(100)} --last-arg`;
    const short = shortCommand(command, 40);
    expect(short).toHaveLength(40);
    expect(short.startsWith("bun run build")).toBe(true);
    expect(short.endsWith("--last-arg")).toBe(true);
    expect(short).toContain("…");
  });
});
