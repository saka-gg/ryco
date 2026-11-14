import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { INVALID_TOOL_ARGUMENTS, ToolFailure, decodeToolArgs, failTool } from "./toolFailure.ts";

const Input = Schema.Struct({
  name: Schema.String,
  limit: Schema.optional(Schema.Number),
});

describe("toolFailure", () => {
  it.effect("failTool fails with a ToolFailure carrying the reason", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(failTool("Thread not found."));
      assert.instanceOf(failure, ToolFailure);
      assert.strictEqual(failure._tag, "ToolFailure");
      assert.strictEqual(failure.reason, "Thread not found.");
    }),
  );

  it.effect("decodeToolArgs returns the decoded arguments", () =>
    Effect.gen(function* () {
      const input = yield* decodeToolArgs(Input, { name: "a", limit: 3 });
      assert.deepStrictEqual(input, { name: "a", limit: 3 });
    }),
  );

  it.effect("decodeToolArgs decodes absent arguments as an empty object", () =>
    Effect.gen(function* () {
      const Empty = Schema.Struct({ limit: Schema.optional(Schema.Number) });
      assert.deepStrictEqual(yield* decodeToolArgs(Empty, undefined), {});
      assert.deepStrictEqual(yield* decodeToolArgs(Empty, null), {});
      // Absent arguments still have to satisfy required fields.
      const failure = yield* Effect.flip(decodeToolArgs(Input, undefined));
      assert.strictEqual(failure.reason, INVALID_TOOL_ARGUMENTS);
    }),
  );

  it.effect("decodeToolArgs answers any mismatch with the bounded invalid-arguments text", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(decodeToolArgs(Input, { name: 7 }));
      assert.instanceOf(failure, ToolFailure);
      assert.strictEqual(failure.reason, "Invalid tool arguments.");
    }),
  );
});
