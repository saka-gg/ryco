import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { USAGE, isImportGraphBlind, parseOptions, partitionTests } from "./check-changed.ts";

const repoFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const ssh = { name: "@ryco/ssh", path: "packages/ssh" };
const acp = { name: "effect-acp", path: "packages/effect-acp" };
const server = { name: "ryco-cli", path: "apps/server" };
const web = { name: "@ryco/web", path: "apps/web" };
const mobile = { name: "@ryco/mobile", path: "apps/mobile" };
const markdown = {
  name: "@ryco/mobile-markdown-text",
  path: "apps/mobile/modules/ryco-markdown-text",
};

describe("check:changed", () => {
  it("parses modes and rejects unknown ones", () => {
    expect(parseOptions([])).toEqual({
      base: undefined,
      fmt: true,
      lint: true,
      types: "full",
      tests: "related",
    });
    expect(
      parseOptions([
        "--base",
        "origin/main",
        "--no-fmt",
        "--no-lint",
        "--types=fast",
        "--tests=none",
      ]),
    ).toEqual({ base: "origin/main", fmt: false, lint: false, types: "fast", tests: "none" });
    expect(() => parseOptions(["--types=slow"])).toThrow("--types must be one of");
    expect(() => parseOptions(["--tests", "everything"])).toThrow("--tests must be one of");
    expect(() => parseOptions(["--fast"])).toThrow();
  });

  it("prints usage for --help and for a bad flag instead of a stack trace", () => {
    // Both exit before touching git, so the real entry point is cheap to run.
    const script = fileURLToPath(new URL("check-changed.ts", import.meta.url));
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    for (const flag of ["--help", "-h"]) {
      const help = cli("--tests=affected", flag);
      expect(help.status).toBe(0);
      expect(help.stdout).toBe(USAGE);
    }
    const bad = cli("--fast");
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toMatch(/^check:changed: Unknown option '--fast'/u);
    expect(bad.stderr).toContain(USAGE);
    expect(bad.stderr).not.toMatch(/^\s+at /mu);
    expect(cli("--types=slow").stderr).toMatch(/^check:changed: --types must be one of/u);
  });

  it("selects related tests for code changes and escalates files tests read from disk", () => {
    expect(partitionTests(["packages/ssh/src/command.ts"], [ssh, server], "related")).toEqual({
      all: [],
      related: [ssh, server],
    });
    expect(
      partitionTests(
        ["packages/ssh/README.md", "apps/server/src/fixtures/session.json"],
        [ssh, server],
        "related",
      ),
    ).toEqual({ all: [server], related: [ssh] });
    // Tests read or spawn code fixtures by path, so Vitest's import graph never selects them.
    expect(
      partitionTests(
        [
          "apps/web/test/fixtures/reactCompiler/CounterList.tsx",
          "packages/effect-acp/test/fixtures/acp-mock-peer.ts",
          "apps/server/src/provider/testFixtures/codexCollabMockPeer.mjs",
        ],
        [web, acp, ssh, server],
        "related",
      ),
    ).toEqual({ all: [web, acp, server], related: [ssh] });
    // Only vitest.config.ts imports the pure and timing test lists.
    for (const path of ["apps/server/test/pureTests.ts", "apps/server/test/timingTests.ts"]) {
      expect(partitionTests([path], [ssh, server], "related")).toEqual({
        all: [server],
        related: [ssh],
      });
    }
    // Look-alike sources still follow the import graph.
    expect(
      partitionTests(
        [
          "apps/web/src/fixturesHelper.ts",
          "apps/web/src/components/pureTests.ts",
          "apps/server/src/threadFork/forkHistory.fixtures.ts",
        ],
        [web, server],
        "related",
      ),
    ).toEqual({ all: [], related: [web, server] });
    // The nested native module owns its asset, not the app around it.
    expect(
      partitionTests(
        ["apps/mobile/modules/ryco-markdown-text/ios/View.swift"],
        [mobile, markdown],
        "related",
      ),
    ).toEqual({ all: [markdown], related: [mobile] });
  });

  it("runs everything affected for global test inputs or on request", () => {
    for (const path of [
      "bun.lock",
      "patches/effect@4.0.5.patch",
      "tsconfig.base.json",
      "vitest.pure-projects.ts",
    ]) {
      expect(partitionTests([path], [ssh, server], "related")).toEqual({
        all: [ssh, server],
        related: [],
      });
    }
    // A package's own Vitest config reruns its suite through Vitest's rerun triggers.
    expect(partitionTests(["apps/server/vitest.config.ts"], [server], "related")).toEqual({
      all: [],
      related: [server],
    });
    // Root files outside every package (workflows, docs) escalate nothing.
    expect(partitionTests([".github/workflows/ci.yml"], [], "related")).toEqual({
      all: [],
      related: [],
    });
    expect(partitionTests(["packages/ssh/src/command.ts"], [ssh], "affected").all).toEqual([ssh]);
    expect(partitionTests(["bun.lock"], [ssh], "none")).toEqual({ all: [], related: [] });
  });

  it("finds tests the import graph cannot see", () => {
    // Loads web sources through `@vite-ignore` imports.
    expect(
      isImportGraphBlind(
        repoFile("apps/server/src/hubConnector/HostedRelaySessionIntegration.test.ts"),
      ),
    ).toBe(true);
    // Reads the package's sources from disk.
    expect(isImportGraphBlind(repoFile("packages/client-runtime/test/boundary.test.ts"))).toBe(
      true,
    );
    // Spawns a mock agent located by path, never imported.
    expect(
      isImportGraphBlind(repoFile("apps/server/src/provider/Layers/CursorAdapter.test.ts")),
    ).toBe(true);
    expect(
      isImportGraphBlind(
        'const agent = path.fromFileUrl(new URL("../../scripts/mock-agent.ts", import.meta.url));',
      ),
    ).toBe(true);
    // Temp-directory tests read what they write, not repo sources.
    expect(
      isImportGraphBlind(
        'const dir = mkdtempSync(path.join(tmpdir(), "x")); readFileSync(path.join(dir, "a.json"));' +
          " const here = import.meta.dirname;",
      ),
    ).toBe(false);
    expect(isImportGraphBlind('import { parse } from "./parse.ts";')).toBe(false);
    expect(isImportGraphBlind('vi.mock("./parse.ts", () => ({}));')).toBe(false);
  });
});
