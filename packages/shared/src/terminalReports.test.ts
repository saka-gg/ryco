import { describe, expect, it } from "vite-plus/test";
import { isTerminalReplyData, isTerminalReportData } from "./terminalReports.ts";

const REPLIES = [
  "\u001b[?1;2c",
  "\u001b[>0;276;0c",
  "\u001b[0n",
  "\u001b[12;1R",
  "\u001b[?12;1R",
  "\u001b[?2026;2$y",
  "\u001b[4;2$y",
  "\u001b[8;24;80t",
  "\u001b[?31u",
  "\u001b]11;rgb:0000/0000/0000\u001b\\",
  "\u001b]10;rgb:ffff/ffff/ffff\u0007",
  "\u001bP1$r0m\u001b\\",
  "\u001bP0$r\u001b\\",
  "\u001bP>|xterm.js(6.0.0)\u001b\\",
  "\u009b?1;2c",
  "\u00901+r544e=1b\u009c",
];

const FOCUS_REPORTS = ["\u001b[I", "\u001b[O", "\u009bI", "\u009bO"];

/** Typed, pasted and pointer input: never a report, alone or with reports around it. */
const USER_INPUT = [
  "l",
  "ls -la\r",
  "\r",
  "\u0003",
  "\u001b",
  "\u001b[A",
  "\u001b[1;5D",
  "\u001bOR",
  "\u001b[15~",
  "\u001b[<0;10;5M",
  "\u001b[200~echo \u001b[6n\u001b[201~",
  "\u001b[12;1Rls",
  "\u001b]11;?",
  "\u001b]11;?\u001b\\ls\u001b\\",
];

describe("isTerminalReplyData", () => {
  it("recognizes the reports xterm sends for queries", () => {
    for (const reply of REPLIES) {
      expect(isTerminalReplyData(reply), JSON.stringify(reply)).toBe(true);
    }
    expect(isTerminalReplyData(REPLIES.join(""))).toBe(true);
  });

  it("leaves typed, pasted and pointer input alone", () => {
    for (const input of ["", ...USER_INPUT, ...FOCUS_REPORTS]) {
      expect(isTerminalReplyData(input), JSON.stringify(input)).toBe(false);
    }
  });
});

describe("isTerminalReportData", () => {
  it("recognizes query replies and focus reports, alone or back to back", () => {
    for (const report of [...REPLIES, ...FOCUS_REPORTS]) {
      expect(isTerminalReportData(report), JSON.stringify(report)).toBe(true);
    }
    expect(isTerminalReportData("\u001b[O\u001b[I\u001b[?2026;2$y\u001b[12;1R")).toBe(true);
  });

  it("finds user input even next to reports", () => {
    for (const input of ["", ...USER_INPUT]) {
      expect(isTerminalReportData(input), JSON.stringify(input)).toBe(false);
      expect(isTerminalReportData(`\u001b[I${input}`), JSON.stringify(input)).toBe(
        input.length === 0,
      );
    }
  });
});
