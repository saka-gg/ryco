import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { assert, it } from "@effect/vitest";

import { classifyFile, normalizeHtmlAssetRef, readInitialAssetRefs } from "./measure-web-bundle.ts";

it("normalizes relative initial asset refs from index.html", () => {
  assert.equal(normalizeHtmlAssetRef("./assets/app.js?module"), "assets/app.js");
  assert.equal(normalizeHtmlAssetRef("/assets/app.css#hash"), "assets/app.css");
});

it("collects ./-prefixed initial assets from index.html", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "ryco-web-bundle-"));
  try {
    const assetsDir = path.join(tempRoot, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, "app.js"), "console.log('app');");
    writeFileSync(path.join(assetsDir, "app.css"), "body{}");
    writeFileSync(
      path.join(tempRoot, "index.html"),
      [
        '<script type="module" src="./assets/app.js?module"></script>',
        '<link rel="stylesheet" href="/assets/app.css#hash">',
        '<script src="https://example.com/external.js"></script>',
        '<script src="./assets/missing.js"></script>',
        "",
      ].join("\n"),
    );

    assert.deepStrictEqual([...readInitialAssetRefs(tempRoot)].toSorted(), [
      "assets/app.css",
      "assets/app.js",
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("reports the on-demand file icon set apart from bundle output", () => {
  const none = new Set<string>();
  assert.equal(classifyFile("vscode-icons/v12.17.0/file_type_ts.svg", none), "on-demand-assets");
  assert.equal(classifyFile("favicon.svg", none), "images");
  assert.equal(classifyFile("assets/vscode-icons-lookup-AAAA.js", none), "async-js");
});
