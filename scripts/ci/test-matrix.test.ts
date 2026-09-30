import { describe, expect, it } from "vite-plus/test";
import { testJobs, testPackages, validationScope } from "./test-matrix.ts";

describe("CI test selection", () => {
  it("shards only the selected server and covers every other selected package once", () => {
    const jobs = testJobs([
      "@ryco/new-package",
      "ryco-cli",
      "@ryco/web",
      "@ryco/shared",
      "@ryco/shared",
    ]);
    expect(jobs.filter((job) => job.name.startsWith("server-")).map((job) => job.shard)).toEqual([
      "--shard=1/3",
      "--shard=2/3",
      "--shard=3/3",
    ]);
    expect(jobs.find((job) => job.name === "rest")?.filters).toBe(
      "--filter=@ryco/new-package --filter=@ryco/shared",
    );
    expect(jobs.find((job) => job.name === "web")?.filters).toBe("--filter=@ryco/web");
    expect(testJobs(["@ryco/shared"]).map((job) => job.name)).toEqual(["rest"]);
    expect(testJobs([])).toEqual([]);
  });

  it("omits build dependencies and workspaces without a test command", () => {
    expect(
      testPackages({
        tasks: [
          { task: "build", package: "@ryco/contracts", command: "tsdown" },
          { task: "test", package: "@ryco/native-module", command: "<NONEXISTENT>" },
          { task: "test", package: "@ryco/shared", command: "vp test run" },
        ],
      }),
    ).toEqual(["@ryco/shared"]);
    expect(() => testPackages({})).toThrow("task plan");
    expect(() => testJobs(["@ryco/web; echo unsafe"])).toThrow("Invalid test package");
  });

  it("keeps documentation and unit-only edits off expensive browser and desktop jobs", () => {
    expect(
      validationScope(
        ["docs/guide.md", "apps/web/src/composer-logic.test.ts"],
        ["@ryco/web", "ryco-cli", "@ryco/desktop"],
      ),
    ).toEqual({ browser: false, desktop: false, release: false });
    expect(
      validationScope(["apps/web/src/components/ChatView.Composer.browser.tsx"], ["@ryco/web"]),
    ).toMatchObject({ browser: true });
    expect(validationScope(["apps/web/src/pwa/lifecycle.test.ts"], ["@ryco/web"])).toMatchObject({
      browser: true,
    });
  });

  it("uses affected dependents for runtime changes and retains infrastructure fallbacks", () => {
    expect(
      validationScope(["packages/ssh/src/auth.ts"], ["@ryco/ssh", "ryco-cli", "@ryco/desktop"]),
    ).toEqual({ browser: false, desktop: true, release: false });
    expect(
      validationScope(
        ["packages/client-runtime/src/authorization/state.ts"],
        ["@ryco/client-runtime", "@ryco/web", "ryco-cli", "@ryco/desktop"],
      ),
    ).toMatchObject({ browser: true, desktop: true });
    for (const path of [
      "bun.lock",
      "vitest.config.ts",
      ".github/workflows/_validation.yml",
      "scripts/ci/test-matrix.ts",
      "scripts/lib/brand-assets.ts",
      "scripts/lib/resolve-catalog.ts",
      "patches/effect.patch",
    ]) {
      expect(validationScope([path], [])).toEqual({ browser: true, desktop: true, release: true });
    }
    expect(validationScope([".github/workflows/release.yml"], []).release).toBe(true);
    expect(
      validationScope(["apps/desktop/scripts/mac-launcher-bootstrap.test.mjs"], ["@ryco/desktop"])
        .release,
    ).toBe(false);
  });
});
