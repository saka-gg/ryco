import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "@ryco/shared/terminalPaste";
import { describe, expect, it } from "vite-plus/test";

import {
  chunkTerminalInput,
  planTerminalPaste,
  TERMINAL_ACCESSORY_ROW,
  terminalAccessorySequence,
  terminalControlSequence,
} from "./terminalInput";

describe("terminal input", () => {
  it("maps accessory keys to PTY sequences", () => {
    expect(terminalAccessorySequence("escape")).toBe("\u001b");
    expect(terminalAccessorySequence("arrow-up")).toBe("\u001b[A");
    expect(terminalAccessorySequence("arrow-left")).toBe("\u001b[D");
    expect(terminalAccessorySequence("pipe")).toBe("|");
  });

  it("puts the arrow keys first in the accessory row, before Esc, Ctrl and Tab", () => {
    expect(TERMINAL_ACCESSORY_ROW.map((item) => item.label)).toEqual([
      "←",
      "↑",
      "↓",
      "→",
      "Esc",
      "Ctrl",
      "Tab",
      "|",
      "/",
      "-",
    ]);
  });

  it("maps one-shot control keys and rejects unsupported input", () => {
    expect(terminalControlSequence("c")).toBe("\u0003");
    expect(terminalControlSequence("C")).toBe("\u0003");
    expect(terminalControlSequence("[")).toBe("\u001b");
    expect(terminalControlSequence("?")).toBe("\u007f");
    expect(terminalControlSequence("😀")).toBeNull();
    expect(terminalControlSequence("ab")).toBeNull();
  });

  it("chunks input within the contract without splitting emoji", () => {
    expect(chunkTerminalInput("ab😀cd", 4)).toEqual(["ab😀", "cd"]);
    expect(chunkTerminalInput("😀", 1)).toEqual(["😀"]);
    expect(chunkTerminalInput("")).toEqual([]);
  });
});

describe("terminal paste", () => {
  it("sends a plain paste with Enter's carriage returns and no closing sequence", () => {
    expect(planTerminalPaste("echo a\necho b", false)).toEqual({
      chunks: ["echo a\recho b"],
      closeSequence: null,
    });
  });

  it("wraps a paste in the markers while the program has bracketed paste on", () => {
    expect(planTerminalPaste("ls\n", true)).toEqual({
      chunks: [`${BRACKETED_PASTE_START}ls\r${BRACKETED_PASTE_END}`],
      closeSequence: BRACKETED_PASTE_END,
    });
  });

  it("chunks a long paste within the write limit and keeps every byte in order", () => {
    const text = "x".repeat(150_000);
    const plan = planTerminalPaste(text, true);
    expect(plan.chunks.length).toBe(3);
    for (const chunk of plan.chunks) expect(chunk.length).toBeLessThanOrEqual(65_536);
    expect(plan.chunks.join("")).toBe(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
  });

  it("plans nothing for an empty clipboard", () => {
    expect(planTerminalPaste("", true)).toEqual({ chunks: [], closeSequence: null });
  });
});
