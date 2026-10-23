import { describe, expect, it } from "vite-plus/test";
import { deepMerge } from "./Struct.ts";

describe("deepMerge", () => {
  it("merges nested records and skips undefined values", () => {
    const current: { a: { b: number; c: number }; d?: number | undefined } = {
      a: { b: 1, c: 2 },
      d: 3,
    };
    expect(deepMerge(current, { a: { c: 4 }, d: undefined })).toEqual({ a: { b: 1, c: 4 }, d: 3 });
  });

  it("ignores __proto__ keys from a parsed patch", () => {
    const patch = JSON.parse(
      '{"__proto__":{"polluted":true},"nested":{"__proto__":{"polluted":true},"kept":1}}',
    ) as Record<string, unknown>;
    const merged = deepMerge<Record<string, unknown>>({ nested: { existing: 0 } }, patch);

    expect(merged).toEqual({ nested: { existing: 0, kept: 1 } });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(merged.nested)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, "__proto__")).toBe(false);
    expect((merged as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("keeps constructor and prototype keys as data", () => {
    // Both are valid provider instance ids.
    const patch = JSON.parse(
      '{"providerInstances":{"prototype":{"driver":"codex"},"constructor":{"driver":"claudeAgent","prototype":{"polluted":true}}}}',
    ) as Record<string, unknown>;
    const merged = deepMerge<Record<string, unknown>>(
      { providerInstances: { codex: { driver: "codex" } } },
      patch,
    );

    expect(merged).toEqual({
      providerInstances: {
        codex: { driver: "codex" },
        prototype: { driver: "codex" },
        constructor: { driver: "claudeAgent", prototype: { polluted: true } },
      },
    });
    const instances = merged.providerInstances as Record<string, unknown>;
    expect(Object.hasOwn(instances, "constructor")).toBe(true);
    expect(Object.getPrototypeOf(instances)).toBe(Object.prototype);
    expect(Object.prototype.constructor).toBe(Object);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
