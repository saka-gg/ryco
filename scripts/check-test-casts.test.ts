import { describe, expect, it } from "vite-plus/test";

import {
  compareToBaseline,
  countByPackage,
  countCasts,
  isTestFile,
  loweredBaseline,
  packageOf,
} from "./check-test-casts.ts";

describe("check-test-casts", () => {
  it("counts both cast forms, across line breaks, and nothing that merely contains them", () => {
    expect(countCasts(`const id = "t" as never; const x = y as unknown as Z;`)).toBe(2);
    expect(countCasts(`const x = longExpression as unknown\n  as Shape;`)).toBe(1);
    expect(countCasts(`type A = never; const b = c as Never; const d = e as unknownish;`)).toBe(0);
  });

  it("treats test, spec and browser files and test folders as test code, but not .docs", () => {
    expect(isTestFile("apps/server/src/a.test.ts")).toBe(true);
    expect(isTestFile("apps/web/src/b.browser.tsx")).toBe(true);
    expect(isTestFile("packages/x/src/c.spec.mts")).toBe(true);
    expect(isTestFile("apps/web/test/harness.ts")).toBe(true);
    expect(isTestFile("apps/server/integration/fixtures.ts")).toBe(true);
    expect(isTestFile("apps/server/src/latest.ts")).toBe(false);
    expect(isTestFile("apps/server/src/test.json")).toBe(false);
    expect(isTestFile(".docs/lab/test/app.test.js")).toBe(false);
  });

  it("groups by workspace package", () => {
    expect(packageOf("apps/server/src/a.test.ts")).toBe("apps/server");
    expect(packageOf("packages/shared/src/a.test.ts")).toBe("packages/shared");
    expect(packageOf("evals/device-routing/a.test.ts")).toBe("evals/device-routing");
    expect(packageOf("scripts/lib/a.test.ts")).toBe("scripts");
    expect(
      countByPackage([
        { path: "apps/web/a.test.ts", source: "x as never; y as never" },
        { path: "apps/web/b.test.ts", source: "z as unknown as T" },
        { path: "scripts/c.test.ts", source: "clean" },
      ]),
    ).toEqual({ "apps/web": 3 });
  });

  it("fails only on growth, including a package that had none", () => {
    expect(compareToBaseline({ a: 3, b: 1 }, { a: 3, b: 2 })).toEqual({
      grown: [],
      shrunk: [{ pkg: "b", count: 1, baseline: 2 }],
    });
    expect(compareToBaseline({ a: 4, c: 1 }, { a: 3 }).grown).toEqual([
      { pkg: "a", count: 4, baseline: 3 },
      { pkg: "c", count: 1, baseline: 0 },
    ]);
  });

  it("only ever lowers a baseline", () => {
    expect(loweredBaseline({ a: 1, b: 9, c: 2 }, { a: 3, b: 5, d: 4 })).toEqual({ a: 1, b: 5 });
  });
});
