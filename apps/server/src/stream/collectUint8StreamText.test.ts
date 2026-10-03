import { assert, describe, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import { collectUint8StreamText } from "./collectUint8StreamText.ts";

const encoder = new TextEncoder();

describe("collectUint8StreamText", () => {
  it.effect("collects Uint8Array chunks into decoded text", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("hello "), encoder.encode("world")),
      });

      assert.deepStrictEqual(result, {
        text: "hello world",
        bytes: 11,
        truncated: false,
      });
    }),
  );

  it.effect("truncates by bytes and appends an optional marker once", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("abcdef"), encoder.encode("ghij")),
        maxBytes: 5,
        truncatedMarker: "[truncated]",
      });

      assert.deepStrictEqual(result, {
        text: "abcde[truncated]",
        bytes: 5,
        truncated: true,
      });
    }),
  );

  it.effect("keeps the last bytes in tail mode, starting on a whole character", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        // "é" is two bytes; the last 4 bytes start inside it.
        stream: Stream.make(
          encoder.encode("start "),
          encoder.encode("mid é"),
          encoder.encode("end"),
        ),
        maxBytes: 4,
        keepTail: true,
        truncatedMarker: "[truncated]",
      });

      assert.deepStrictEqual(result, { text: "end", bytes: 3, truncated: true });

      const whole = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("ab"), encoder.encode("cd")),
        maxBytes: 4,
        keepTail: true,
      });
      assert.deepStrictEqual(whole, { text: "abcd", bytes: 4, truncated: false });
    }),
  );
});
