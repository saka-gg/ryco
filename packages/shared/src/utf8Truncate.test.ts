import { describe, expect, it } from "vite-plus/test";

import { truncateUtf8, truncateUtf8Bytes } from "./utf8Truncate.ts";

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;

describe("truncateUtf8", () => {
  it("keeps text that fits", () => {
    expect(truncateUtf8("short", 100)).toEqual({ value: "short", truncated: false });
    expect(truncateUtf8("ééé", 6)).toEqual({ value: "ééé", truncated: false });
  });

  it("cuts before a character that would not fit", () => {
    expect(truncateUtf8("ééé", 5)).toEqual({ value: "éé", truncated: true });
    expect(truncateUtf8("a😀b", 4)).toEqual({ value: "a", truncated: true });
    expect(truncateUtf8("a😀b", 5)).toEqual({ value: "a😀", truncated: true });
    expect(byteLength(truncateUtf8("é".repeat(2_600), 4_096).value)).toBe(4_096);
  });

  it("answers an empty string for a zero limit", () => {
    expect(truncateUtf8("abc", 0)).toEqual({ value: "", truncated: true });
  });
});

describe("truncateUtf8Bytes", () => {
  it("cuts bytes before a split character", () => {
    expect(truncateUtf8Bytes(encoder.encode("abé"), 3)).toEqual({ text: "ab", truncated: true });
    expect(truncateUtf8Bytes(encoder.encode("ab😀"), 5)).toEqual({ text: "ab", truncated: true });
    expect(truncateUtf8Bytes(encoder.encode("abé"), 4)).toEqual({ text: "abé", truncated: false });
  });

  it("does not throw on invalid UTF-8", () => {
    expect(truncateUtf8Bytes(new Uint8Array([0x61, 0xff, 0x62]), 10)).toEqual({
      text: "a�b",
      truncated: false,
    });
  });
});
