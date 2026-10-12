import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { fromLenientJson } from "./schemaJson.ts";

const decode = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));

describe("fromLenientJson", () => {
  it("strips comments and trailing commas outside strings", () => {
    expect(
      decode(`{
        // comment
        "list": [1, 2,],
        /* block */ "nested": { "a": 1, },
      }`),
    ).toEqual({ list: [1, 2], nested: { a: 1 } });
  });

  it("leaves commas, brackets and comment markers inside strings untouched", () => {
    const value = { a: "x,}", b: "y, ]", c: "// not a comment", d: 'quote \\",}' };
    expect(decode(JSON.stringify(value))).toEqual(value);
  });
});
