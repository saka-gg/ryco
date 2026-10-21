import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { defaultExclude } from "vite-plus/test/config";

import { pureAndIsolatedProjects } from "../vitest.pure-projects.ts";

let root: string | undefined;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function packageWith(...files: string[]): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-pure-projects-test-"));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "");
  }
  return root;
}

describe("pureAndIsolatedProjects", () => {
  it("runs the allowlist without isolation and every other test file isolated", () => {
    const pure = ["src/a.test.ts", "src/b.test.ts"];
    const [pureProject, isolatedProject, ...rest] = pureAndIsolatedProjects(
      packageWith(...pure),
      pure,
      { pureOverrides: { testTimeout: 5_000 } },
    );

    expect(pureProject).toEqual({
      extends: true,
      test: { name: "pure", include: pure, isolate: false, testTimeout: 5_000 },
    });
    expect(isolatedProject).toEqual({
      extends: true,
      test: { name: "isolated", exclude: [...defaultExclude, ...pure] },
    });
    // No timing files, no timing project: an empty include would not mean "none".
    expect(rest).toEqual([]);
  });

  it("runs timing files one at a time after the other projects, and only there", () => {
    const pure = ["src/a.test.ts"];
    const timing = ["src/slow.test.ts"];
    const [, isolatedProject, timingProject] = pureAndIsolatedProjects(
      packageWith(...pure, ...timing),
      pure,
      { timingTestFiles: timing },
    );

    expect(isolatedProject?.test?.exclude).toEqual([...defaultExclude, ...pure, ...timing]);
    expect(timingProject).toEqual({
      extends: true,
      test: {
        name: "timing",
        include: timing,
        fileParallelism: false,
        sequence: { groupOrder: 1 },
      },
    });
  });

  it("rejects an entry that is not a file, so a renamed test cannot go stale", () => {
    const packageRoot = packageWith("src/a.test.ts");
    expect(() => pureAndIsolatedProjects(packageRoot, ["src/renamed.test.ts"])).toThrow(
      /src\/renamed\.test\.ts is not a file/,
    );
    expect(() => pureAndIsolatedProjects(packageRoot, ["src/*.test.ts"])).toThrow(/not a file/);
    expect(() => pureAndIsolatedProjects(packageRoot, ["src"])).toThrow(/not a file/);
    expect(() =>
      pureAndIsolatedProjects(packageRoot, [], { timingTestFiles: ["src/renamed.test.ts"] }),
    ).toThrow(/Timing test list entry src\/renamed\.test\.ts is not a file/);
  });

  it("rejects a duplicate entry", () => {
    const packageRoot = packageWith("src/a.test.ts");
    expect(() => pureAndIsolatedProjects(packageRoot, ["src/a.test.ts", "src/a.test.ts"])).toThrow(
      /lists src\/a\.test\.ts twice/,
    );
    expect(() =>
      pureAndIsolatedProjects(packageRoot, [], {
        timingTestFiles: ["src/a.test.ts", "src/a.test.ts"],
      }),
    ).toThrow(/Timing test list lists src\/a\.test\.ts twice/);
  });

  it("rejects a file in both lists, which would run it twice", () => {
    const packageRoot = packageWith("src/a.test.ts");
    expect(() =>
      pureAndIsolatedProjects(packageRoot, ["src/a.test.ts"], {
        timingTestFiles: ["src/a.test.ts"],
      }),
    ).toThrow(/src\/a\.test\.ts is in both/);
  });
});
