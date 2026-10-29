import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ComputerUseBridgeConfig } from "./computerUse.ts";

describe("ComputerUseBridgeConfig", () => {
  const binding = { url: "http://127.0.0.1:4000/control", token: "a".repeat(43) };
  const decode = Schema.decodeUnknownSync(ComputerUseBridgeConfig);

  it("decodes a binding from a desktop without browser uploads", () => {
    expect(decode(binding)).toEqual(binding);
  });

  it("carries the desktop's private browser upload directory", () => {
    const withUploads = { ...binding, uploadDir: "/state/computer-use-browser-uploads" };
    expect(decode(withUploads)).toEqual(withUploads);
  });

  it("refuses an empty or oversized upload directory", () => {
    expect(() => decode({ ...binding, uploadDir: "" })).toThrow();
    expect(() => decode({ ...binding, uploadDir: `/${"x".repeat(4096)}` })).toThrow();
  });
});
