// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { fflateRelayPayloadInflater } from "../../../src/hostedHub/relayPayloadInflater";
import { describe, expect, it } from "vite-plus/test";

/**
 * The native inflater replaces fflate on iOS, so it must accept and refuse
 * exactly what fflate (and the web's `DecompressionStream`) does, with the
 * same messages. On a Mac this compiles `RelayInflate.swift` with `swiftc` and
 * runs both over the same cases; elsewhere the iOS build covers compilation.
 */
const MODULE_DIR = fileURLToPath(new URL("..", import.meta.url));

const swiftcAvailable =
  process.platform === "darwin" &&
  spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status === 0;

const text = new TextEncoder().encode(
  Array.from({ length: 4_000 }, (_, index) => `row ${index} ${"x".repeat(index % 37)}`).join("\n"),
);
const random = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 2_654_435_761) >>> 24);
const compressed = deflateRawSync(text);
const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const CASES: ReadonlyArray<{
  readonly name: string;
  readonly body: Uint8Array;
  readonly maxOutputBytes: number;
}> = [
  { name: "text", body: compressed, maxOutputBytes: 1 << 20 },
  { name: "exactly the cap", body: compressed, maxOutputBytes: text.byteLength },
  { name: "one byte over the cap", body: compressed, maxOutputBytes: text.byteLength - 1 },
  { name: "incompressible", body: deflateRawSync(random), maxOutputBytes: 1 << 20 },
  { name: "empty payload", body: deflateRawSync(new Uint8Array(0)), maxOutputBytes: 16 },
  { name: "trailing byte", body: concat(compressed, Uint8Array.of(0)), maxOutputBytes: 1 << 20 },
  {
    name: "second stream",
    body: concat(compressed, deflateRawSync(Uint8Array.of(1, 2, 3))),
    maxOutputBytes: 1 << 20,
  },
  {
    name: "truncated",
    body: compressed.subarray(0, compressed.byteLength - 5),
    maxOutputBytes: 1 << 20,
  },
  { name: "no body", body: new Uint8Array(0), maxOutputBytes: 16 },
  { name: "invalid block type", body: Uint8Array.of(0x07, 0x00), maxOutputBytes: 16 },
];

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

async function inflateWithFflate(body: Uint8Array, maxOutputBytes: number) {
  try {
    return { output: hex(await fflateRelayPayloadInflater.inflateRaw(body, maxOutputBytes)) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

describe.skipIf(!swiftcAvailable)("the native relay payload inflater", () => {
  it("accepts and refuses exactly what the JavaScript inflater does", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ryco-relay-inflate-"));
    try {
      const binary = join(directory, "inflate");
      execFileSync(
        "xcrun",
        [
          "swiftc",
          "-O",
          "-o",
          binary,
          join(MODULE_DIR, "ios/RelayInflate.swift"),
          join(MODULE_DIR, "test/main.swift"),
        ],
        { stdio: "pipe" },
      );
      const casesPath = join(directory, "cases.json");
      writeFileSync(
        casesPath,
        JSON.stringify(
          CASES.map((item) => ({ body: hex(item.body), maxOutputBytes: item.maxOutputBytes })),
        ),
      );
      const native = JSON.parse(
        execFileSync(binary, [casesPath], { encoding: "utf8" }),
      ) as ReadonlyArray<{ readonly output: string } | { readonly error: string }>;
      for (const [index, item] of CASES.entries()) {
        const expected = await inflateWithFflate(item.body, item.maxOutputBytes);
        const actual = native[index]!;
        if ("output" in expected) {
          expect({ name: item.name, ...actual }).toEqual({ name: item.name, ...expected });
        } else {
          // Both refuse. fflate words corrupt input its own way ("unexpected EOF").
          expect({ name: item.name, refused: "error" in actual }).toEqual({
            name: item.name,
            refused: true,
          });
          if (
            expected.error.startsWith("Compressed relay") ||
            expected.error.startsWith("Inflated")
          ) {
            expect({ name: item.name, ...actual }).toEqual({ name: item.name, ...expected });
          }
        }
      }
      expect(native[0]).toEqual({ output: hex(text) });
      expect(native[2]).toEqual({ error: "Inflated relay payload exceeds its cap." });
      expect(native[5]).toEqual({
        error: "Compressed relay payload has bytes after its DEFLATE stream.",
      });
      expect(native[6]).toEqual({
        error: "Compressed relay payload has bytes after its DEFLATE stream.",
      });
      expect(native[7]).toEqual({
        error: "Compressed relay payload ended before its DEFLATE stream.",
      });
      expect(native[9]).toEqual({
        error: "Compressed relay payload is not a valid DEFLATE stream.",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
