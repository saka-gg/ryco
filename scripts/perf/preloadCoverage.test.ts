import { assert, describe, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readBundleGraph } from "./bundleGraph.ts";
import { checkBundleBudgets } from "./bundleBudget.ts";
import { checkPreloadCoverage, parseDynamicImportPreloads } from "./preloadCoverage.ts";

const MAP_DEPS = (files: ReadonlyArray<string>) =>
  `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=${JSON.stringify(files.map((file) => `assets/${file}`))})))=>i.map(i=>d[i]);\n`;

function withAssets(files: Record<string, string>, run: (distDir: string) => void): void {
  const distDir = mkdtempSync(path.join(os.tmpdir(), "ryco-preload-coverage-"));
  try {
    const assetsDir = path.join(distDir, "assets");
    mkdirSync(assetsDir);
    for (const [file, code] of Object.entries(files)) {
      writeFileSync(path.join(assetsDir, file), code);
      writeFileSync(
        path.join(assetsDir, `${file}.map`),
        JSON.stringify({ version: 3, sources: [], mappings: "" }),
      );
    }
    run(distDir);
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
}

describe("parseDynamicImportPreloads", () => {
  it("reads the files each preload-managed import() loads", () => {
    const source = `${MAP_DEPS(["Page-a1B2c3D4.js", "dep-a1B2c3D4.js", "Page-a1B2c3D4.css"])}const a=()=>t(()=>import(\`./Page-a1B2c3D4.js\`),__vite__mapDeps([0,1,2]));const b=()=>t(()=>import("./Tiny-a1B2c3D4.js"),[]);const c=import("./Worker-a1B2c3D4.js");`;

    const imports = parseDynamicImportPreloads("host-a1B2c3D4.js", source);

    assert.deepStrictEqual(
      imports.map((entry) => [entry.target, [...entry.preloaded]]),
      [
        ["Page-a1B2c3D4.js", ["Page-a1B2c3D4.js", "dep-a1B2c3D4.js"]],
        ["Tiny-a1B2c3D4.js", []],
      ],
    );
  });
});

describe("checkPreloadCoverage", () => {
  const files = {
    "main-a1B2c3D4.js": `import"./shared-a1B2c3D4.js";${MAP_DEPS(["Page-a1B2c3D4.js", "level1-a1B2c3D4.js", "level2-a1B2c3D4.js"])}export const go=()=>t(()=>import(\`./Page-a1B2c3D4.js\`),__vite__mapDeps([0,1,2]));export const partial=()=>t(()=>import(\`./Other-a1B2c3D4.js\`),__vite__mapDeps([1]));`,
    "shared-a1B2c3D4.js": "export const shared=1;",
    "Page-a1B2c3D4.js": `import"./level1-a1B2c3D4.js";import"./shared-a1B2c3D4.js";export const page=1;`,
    "Other-a1B2c3D4.js": `import"./level1-a1B2c3D4.js";export const other=1;`,
    "level1-a1B2c3D4.js": `import"./level2-a1B2c3D4.js";export const level1=1;`,
    "level2-a1B2c3D4.js": "export const level2=1;",
  };

  it("accepts imports that preload their whole closure beyond what the host already loaded", () => {
    withAssets(files, (distDir) => {
      const assetsDir = path.join(distDir, "assets");
      const report = checkPreloadCoverage(readBundleGraph(assetsDir), assetsDir);
      assert.strictEqual(report.checkedImports, 2);
      assert.deepStrictEqual(
        report.uncovered.map((entry) => entry.target),
        ["Other-a1B2c3D4.js"],
      );
    });
  });

  it("reports the levels an import would discover one round at a time", () => {
    withAssets(files, (distDir) => {
      const assetsDir = path.join(distDir, "assets");
      const [uncovered] = checkPreloadCoverage(readBundleGraph(assetsDir), assetsDir).uncovered;
      assert.deepStrictEqual(uncovered, {
        host: "main-a1B2c3D4.js",
        target: "Other-a1B2c3D4.js",
        missing: ["level2-a1B2c3D4.js"],
      });

      const report = checkBundleBudgets(distDir, { bootChunk: "main", closures: [] });
      assert.deepStrictEqual(
        report.violations.map((violation) => violation.closure),
        ["preload depth"],
      );
      assert.match(report.violations[0]!.message, /Other-a1B2c3D4\.js from main-a1B2c3D4\.js/u);
    });
  });

  it("fails instead of passing vacuously when the preload output format is unreadable", () => {
    withAssets(
      {
        // A preload map whose imports no longer match the parser's shape.
        "main-a1B2c3D4.js": `${MAP_DEPS(["Page-a1B2c3D4.js"])}export const go=()=>t(()=>import(new URL("./Page-a1B2c3D4.js",import.meta.url).href),__vite__mapDeps([0]));`,
        "Page-a1B2c3D4.js": "export const page=1;",
      },
      (distDir) => {
        const assetsDir = path.join(distDir, "assets");
        const coverage = checkPreloadCoverage(readBundleGraph(assetsDir), assetsDir);
        assert.strictEqual(coverage.checkedImports, 0);
        assert.strictEqual(coverage.hasPreloadMaps, true);

        const report = checkBundleBudgets(distDir, { bootChunk: "main", closures: [] });
        assert.deepStrictEqual(
          report.violations.map((violation) => violation.closure),
          ["preload depth"],
        );
        assert.match(report.violations[0]!.message, /no import\(\) the check can read/u);
      },
    );
  });
});
