import { describe, expect, it } from "vite-plus/test";

import { KEY_HELP, KeyError, describeInput, encodeKeys } from "./keys.ts";

const bytes = (key: string, applicationCursor = false) =>
  encodeKeys([key], { applicationCursor })[0]!.bytes;

describe("encodeKeys", () => {
  it("encodes named keys", () => {
    expect(bytes("Enter")).toBe("\r");
    expect(bytes("Tab")).toBe("\t");
    expect(bytes("Escape")).toBe("\u001b");
    expect(bytes("Backspace")).toBe("\u007f");
    expect(bytes("F5")).toBe("\u001b[15~");
    expect(bytes("F1")).toBe("\u001bOP");
  });

  it("encodes control keys in their spellings", () => {
    expect(bytes("Ctrl+C")).toBe("\u0003");
    expect(bytes("ctrl-c")).toBe("\u0003");
    expect(bytes("Control+D")).toBe("\u0004");
    expect(bytes("^C")).toBe("\u0003");
    expect(bytes("Ctrl+Shift+C")).toBe("\u0003");
    expect(bytes("Ctrl+[")).toBe("\u001b");
    expect(bytes("Ctrl+Left")).toBe("\u001b[1;5D");
  });

  it("follows the terminal's cursor-key mode for arrows", () => {
    expect(bytes("Up")).toBe("\u001b[A");
    expect(bytes("Up", true)).toBe("\u001bOA");
    expect(bytes("Left", true)).toBe("\u001bOD");
  });

  it("prefixes Alt keys with escape, keeping the letter's case", () => {
    expect(bytes("Alt+x")).toBe("\u001bx");
    expect(bytes("Alt+X")).toBe("\u001bX");
    expect(bytes("Option+b")).toBe("\u001bb");
    expect(bytes("Alt+Up")).toBe("\u001b[1;3A");
    expect(bytes("Alt+Enter")).toBe("\u001b\r");
  });

  it("throws a KeyError listing the keys for an unknown name", () => {
    expect(() => encodeKeys(["Hyper+Q"])).toThrow(KeyError);
    expect(() => encodeKeys(["Hyper+Q"])).toThrow(
      `Unknown key "Hyper+Q". Use one of: ${KEY_HELP}.`,
    );
  });

  it("marks only typed characters as printable", () => {
    const printable = (key: string) => encodeKeys([key])[0]!.printable;
    expect(printable("y")).toBe(true);
    expect(printable("Space")).toBe(true);
    expect(printable("Enter")).toBe(false);
    expect(printable("Ctrl+C")).toBe(false);
    expect(printable("\u0003")).toBe(false);
  });

  it("encodes several keys in order", () => {
    expect(encodeKeys(["y", "Enter"]).map((key) => key.bytes)).toEqual(["y", "\r"]);
  });
});

describe("describeInput", () => {
  it("quotes short text and lists keys", () => {
    expect(describeInput("y", ["Enter"])).toBe('"y" + Enter');
    expect(describeInput(undefined, ["Ctrl+C", "Up"])).toBe("Ctrl+C, Up");
    expect(describeInput(undefined, undefined)).toBe("nothing");
  });

  it("never repeats text longer than 60 characters", () => {
    const secretish = "s".repeat(61);
    const described = describeInput(secretish, []);
    expect(described).toBe("61 characters of text");
    expect(described).not.toContain("sss");
    expect(describeInput("s".repeat(60), [])).toBe(JSON.stringify("s".repeat(60)));
  });
});
