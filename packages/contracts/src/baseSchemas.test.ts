import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleUnion,
  isUnknownUnionMember,
  NonNegativeInt,
  TrimmedNonEmptyString,
  UnknownUnionMember,
} from "./baseSchemas.ts";

const Shape = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("circle"),
    sequence: NonNegativeInt,
    label: TrimmedNonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literals(["square", "box"]), sequence: NonNegativeInt }),
]);
/** How clients decode a stream chunk: the JSON wire codec over the runtime schema. */
const fromWire = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(Schema.NonEmptyArray(schema)) as never) as (
    value: unknown,
  ) => ReadonlyArray<S["Type"]>;

describe("ForwardCompatibleUnion", () => {
  const Wire = ForwardCompatibleUnion(Shape.members, "kind", { sequence: NonNegativeInt });
  const decode = fromWire(Wire);

  it("decodes a member a newer node added to a placeholder with the kept fields", () => {
    const [decoded] = decode([{ kind: "triangle", sequence: 4, corners: 3 }]);
    expect(isUnknownUnionMember(decoded)).toBe(true);
    expect(decoded).toEqual(
      Object.assign(new UnknownUnionMember("kind", "triangle"), { sequence: 4 }),
    );
    expect(decoded).not.toHaveProperty("corners");
  });

  it("decodes known members in full, transformations and literal sets included", () => {
    const decoded = decode([
      { kind: "circle", sequence: 1, label: "  round  " },
      { kind: "box", sequence: 2 },
    ]);
    expect(decoded).toEqual([
      { kind: "circle", sequence: 1, label: "round" },
      { kind: "box", sequence: 2 },
    ]);
    expect(decoded.some(isUnknownUnionMember)).toBe(false);
  });

  it("still fails a known member whose payload is broken", () => {
    expect(() => decode([{ kind: "circle", sequence: 1, label: "" }])).toThrow(
      /A known kind must decode in full/,
    );
  });

  it("fails an unknown member without the fields every member keeps", () => {
    expect(() => decode([{ kind: "triangle" }])).toThrow();
  });

  it("refuses to encode an unknown member", () => {
    const encode = Schema.encodeUnknownSync(Schema.toCodecJson(Wire));
    expect(() =>
      encode(Object.assign(new UnknownUnionMember("kind", "triangle"), { sequence: 4 })),
    ).toThrow(/never sent/);
  });

  it("encodes known members as the strict union does", () => {
    const encode = Schema.encodeUnknownSync(Schema.toCodecJson(Wire));
    const circle = { kind: "circle", sequence: 1, label: "round" };
    expect(encode(circle)).toEqual(Schema.encodeUnknownSync(Schema.toCodecJson(Shape))(circle));
  });

  it("rejects kept fields that would shadow the placeholder", () => {
    expect(() =>
      ForwardCompatibleUnion(Shape.members, "kind", { value: Schema.String } as never),
    ).toThrow();
    expect(() =>
      ForwardCompatibleUnion([Schema.Struct({ kind: Schema.String })] as never, "kind"),
    ).toThrow(/string literal kind/);
  });
});
