import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { pinnedTurboVersion, testJobs, testPackages, validationScope } from "./test-matrix.ts";

describe("CI test selection", () => {
  it("shards only the selected server and covers every other selected package once", () => {
    const jobs = testJobs([
      "@ryco/new-package",
      "ryco-cli",
      "@ryco/web",
      "@ryco/shared",
      "@ryco/shared",
    ]);
    const server = jobs.filter((job) => job.name.startsWith("server-"));
    expect(server.map((job) => job.shard)).toEqual(["--shard=1/3", "--shard=2/3", "--shard=3/3"]);
    // The server's CI worker count (four, capped at the runner's cores) is
    // sized for the 4-vCPU GitHub-hosted runner.
    expect(new Set(server.map((job) => job.runner))).toEqual(new Set(["ubuntu-24.04"]));
    expect(jobs.find((job) => job.name === "rest")?.filters).toBe(
      "--filter=@ryco/new-package --filter=@ryco/shared",
    );
    expect(jobs.find((job) => job.name === "web")?.filters).toBe("--filter=@ryco/web");
    expect(testJobs(["@ryco/shared"]).map((job) => job.name)).toEqual(["rest"]);
    expect(testJobs([])).toEqual([]);
  });

  it("gives GitHub's cache backend exactly one Bun cache writer, on a leg that ends early", () => {
    const writers = (packages: string[]) =>
      testJobs(packages)
        .filter((job) => job.bunCache === "write")
        .map((job) => job.name);
    // Every leg is GitHub-hosted; Static alone writes Blacksmith's backend.
    expect(
      new Set(testJobs(["ryco-cli", "@ryco/web", "@ryco/shared"]).map((job) => job.runner)),
    ).toEqual(new Set(["ubuntu-24.04"]));
    expect(writers(["ryco-cli", "@ryco/web", "@ryco/shared"])).toEqual(["rest"]);
    expect(writers(["ryco-cli", "@ryco/web"])).toEqual(["web"]);
    expect(writers(["ryco-cli"])).toEqual(["server-1"]);
    expect(writers(["@ryco/web"])).toEqual(["web"]);
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
    ).toEqual({ browser: false, desktop: false, release: false, mobile: false });
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
    ).toEqual({ browser: false, desktop: true, release: false, mobile: false });
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
      expect(validationScope([path], [])).toEqual({
        browser: true,
        desktop: true,
        release: true,
        mobile: true,
      });
    }
    expect(validationScope([".github/workflows/release.yml"], []).release).toBe(true);
    expect(
      validationScope(["apps/desktop/scripts/mac-launcher-bootstrap.test.mjs"], ["@ryco/desktop"])
        .release,
    ).toBe(false);
  });

  it("bundles mobile for the app, the workspaces it consumes, and patches", () => {
    // Turbo lists the app as an affected dependent of a shared workspace edit.
    expect(
      validationScope(
        ["packages/client-runtime/src/authorization/state.ts"],
        ["@ryco/client-runtime", "@ryco/mobile", "@ryco/web"],
      ).mobile,
    ).toBe(true);
    for (const path of [
      "apps/mobile/src/features/threads/ThreadComposer.tsx",
      "apps/mobile/modules/ryco-device-key/index.ts",
      "patches/@legendapp%2Flist@3.3.10.patch",
      "bun.lock",
    ]) {
      expect(validationScope([path], []).mobile, path).toBe(true);
    }
    // Unit tests and docs never reach the bundle, and the other apps do not feed it.
    for (const [path, packages] of [
      ["apps/mobile/src/lib/adaptive-navigation.test.ts", ["@ryco/mobile"]],
      ["apps/mobile/README.md", ["@ryco/mobile"]],
      ["apps/server/src/ws.ts", ["ryco-cli", "@ryco/desktop"]],
      ["apps/web/src/components/ChatView.tsx", ["@ryco/web", "@ryco/desktop"]],
    ] as const) {
      expect(validationScope([path], packages).mobile, path).toBe(false);
    }
  });

  it("runs the lockfile's exact Turbo when dependencies are not installed", () => {
    expect(
      pinnedTurboVersion(
        [
          '      "devDependencies": { "turbo": "^2.10.12" },',
          '    "turbo": ["turbo@2.10.12", "", { "bin": { "turbo": "bin/turbo" } }, "sha512-x"],',
          '    "@turbo/linux-64": ["@turbo/linux-64@2.10.12", "", { "os": "linux" }, "sha512-y"],',
        ].join("\n"),
      ),
    ).toBe("2.10.12");
    expect(() => pinnedTurboVersion('"turbo": "^2.10.12"')).toThrow("exact turbo version");
    expect(() => pinnedTurboVersion('    "turbo": ["turbo@latest", ""]')).toThrow(
      "exact turbo version",
    );
    // The slim job's plan must come from the Turbo the workspace installs.
    const root = new URL("../../", import.meta.url);
    const installed = JSON.parse(
      readFileSync(new URL("node_modules/turbo/package.json", root), "utf8"),
    ) as { version: string };
    expect(pinnedTurboVersion(readFileSync(new URL("bun.lock", root), "utf8"))).toBe(
      installed.version,
    );
  });
});
