import { describe, expect, it } from "vitest";

import { changeRequestFileTier, orderChangeRequestFiles } from "./fileOrder.ts";

describe("changeRequestFileTier", () => {
  it.each([
    ["src/app.ts", "source"],
    ["src/app.test.ts", "test"],
    ["src/__tests__/app.ts", "test"],
    ["pkg/server_test.go", "test"],
    ["tests/test_api.py", "test"],
    ["README.md", "docs"],
    ["docs/guide/setup.ts", "docs"],
    ["LICENSE", "docs"],
    ["package.json", "config"],
    ["apps/web/tsconfig.node.json", "config"],
    ["vite.config.ts", "config"],
    [".github/workflows/ci.yml", "config"],
    ["apps/web/.eslintrc.json", "config"],
    ["bun.lock", "generated"],
    ["pnpm-lock.yaml", "generated"],
    ["src/__snapshots__/app.test.ts.snap", "generated"],
    ["src/routeTree.gen.ts", "generated"],
    ["dist/index.js", "generated"],
    ["public/vendor.min.js", "generated"],
  ] as const)("classifies %s as %s", (path, tier) => {
    expect(changeRequestFileTier(path)).toBe(tier);
  });
});

describe("orderChangeRequestFiles", () => {
  it("reads source, related tests, docs, config, then generated output", () => {
    const files = [
      "bun.lock",
      "src/zeta.test.ts",
      "package.json",
      "README.md",
      "src/zeta.ts",
      "tests/unrelated.test.ts",
      "src/alpha.test.ts",
      "src/alpha.ts",
      "src/__snapshots__/alpha.test.ts.snap",
    ].map((path) => ({ path }));

    expect(orderChangeRequestFiles(files).map((file) => file.path)).toEqual([
      "src/alpha.ts",
      "src/zeta.ts",
      "src/alpha.test.ts",
      "src/zeta.test.ts",
      "tests/unrelated.test.ts",
      "README.md",
      "package.json",
      "bun.lock",
      "src/__snapshots__/alpha.test.ts.snap",
    ]);
  });

  it("accepts a path accessor and keeps the input untouched", () => {
    const files = [{ name: "b.ts" }, { name: "a.ts" }];
    expect(orderChangeRequestFiles(files, (file) => file.name).map((file) => file.name)).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(files.map((file) => file.name)).toEqual(["b.ts", "a.ts"]);
  });
});
