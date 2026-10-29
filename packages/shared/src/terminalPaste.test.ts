import { describe, expect, it } from "vite-plus/test";

import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  bracketedTerminalSnippet,
  encodeTerminalPaste,
} from "./terminalPaste.ts";

describe("encodeTerminalPaste", () => {
  it("sends line breaks as the carriage return Enter sends", () => {
    expect(encodeTerminalPaste("echo a\necho b\r\n", false)).toBe("echo a\recho b\r");
  });

  it("wraps the paste in the markers while bracketed paste mode is on", () => {
    expect(encodeTerminalPaste("ls\n", true)).toBe(
      `${BRACKETED_PASTE_START}ls\r${BRACKETED_PASTE_END}`,
    );
  });

  it("removes embedded markers so pasted bytes cannot end the paste early", () => {
    const hostile = `safe${BRACKETED_PASTE_END}rm -rf ~\n`;
    expect(encodeTerminalPaste(hostile, true)).toBe(
      `${BRACKETED_PASTE_START}saferm -rf ~\r${BRACKETED_PASTE_END}`,
    );
    // Removing one marker must not join the bytes around it into another.
    const nested = `a\u001b[20${BRACKETED_PASTE_END}1~b`;
    expect(encodeTerminalPaste(nested, true)).toBe(
      `${BRACKETED_PASTE_START}ab${BRACKETED_PASTE_END}`,
    );
  });

  it("leaves text untouched outside bracketed paste mode apart from line breaks", () => {
    expect(encodeTerminalPaste(`a${BRACKETED_PASTE_END}b`, false)).toBe(`a${BRACKETED_PASTE_END}b`);
  });
});

describe("bracketedTerminalSnippet", () => {
  it("shares the paste markers", () => {
    expect(bracketedTerminalSnippet("ls")).toBe(`${BRACKETED_PASTE_START}ls${BRACKETED_PASTE_END}`);
  });
});
