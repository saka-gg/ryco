import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import plugin from "./index.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
// The `vp` that `bun run lint` and CI run. It hands oxlint the root vite.config.ts lint block,
// which a bare oxlint run never reads.
const vpBin = path.join(
  path.dirname(createRequire(import.meta.url).resolve("vite-plus/package.json")),
  "bin",
  "vp",
);

describe("ryco oxlint plugin wiring", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "ryco-oxlint-wiring-"));
  afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

  it("loads through the root lint config and reports a planted violation", () => {
    const unexplained = path.join(fixtureDir, "unexplained.ts");
    const explained = path.join(fixtureDir, "explained.ts");
    writeFileSync(unexplained, `// eslint-disable-next-line no-console\nconsole.log("x");\n`);
    writeFileSync(
      explained,
      `// eslint-disable-next-line no-console -- the fixture prints\nconsole.log("x");\n`,
    );

    // Node runs the TypeScript plugin with type stripping, as the lint step in CI does.
    const result = spawnSync(process.execPath, [vpBin, "lint", unexplained, explained], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(output).not.toContain("Failed to parse oxlint configuration file");
    expect(output).toContain(`${unexplained}:1:1: error ryco(require-suppression-reason)`);
    expect(output).not.toContain(explained);
    expect(result.status).toBe(1);
  });

  it("enables every plugin rule, and only those, in the root lint config", () => {
    const config = readFileSync(path.join(repoRoot, "vite.config.ts"), "utf8");
    expect(config).toContain(`jsPlugins: ["./scripts/oxlint-plugin/index.ts"]`);
    const configured = new Set(Array.from(config.matchAll(/"ryco\/([\w-]+)"/gu), (m) => m[1]));
    expect([...configured].toSorted()).toEqual(Object.keys(plugin.rules).toSorted());
  });
});
