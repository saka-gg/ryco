import { assert, describe, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { measureWebBundle } from "./bundleMeasurement.ts";

describe("external bundle measurement", () => {
  it("counts nested assets with bounded web-delivery compression", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ryco-bundle-measurement-"));
    try {
      const nested = path.join(root, "assets");
      mkdirSync(nested);
      const first = Buffer.from("const answer = 42;\n".repeat(100));
      const second = Buffer.from("body { color: tomato; }\n".repeat(100));
      writeFileSync(path.join(root, "app.js"), first);
      writeFileSync(path.join(nested, "app.css"), second);
      // Precompressed siblings of measured assets are copies, not bundle bytes.
      writeFileSync(path.join(root, "app.js.br"), zlib.brotliCompressSync(first));
      writeFileSync(path.join(nested, "app.css.gz"), zlib.gzipSync(second));
      // The self-hosted file icon set is fetched one icon at a time, not as bundle code.
      const icons = path.join(root, "vscode-icons", "v12.17.0");
      mkdirSync(icons, { recursive: true });
      writeFileSync(path.join(icons, "file_type_ts.svg"), "<svg/>".repeat(100));
      // Only the top-level directory is on demand; a nested namesake is bundle output.
      mkdirSync(path.join(nested, "vscode-icons"));
      const nestedNamesake = Buffer.from("export const icon = 1;\n".repeat(10));
      writeFileSync(path.join(nested, "vscode-icons", "chunk.js"), nestedNamesake);

      const measured = measureWebBundle(root);
      const brotli = (bytes: Buffer) =>
        zlib.brotliCompressSync(bytes, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
        }).byteLength;

      const gzip = (bytes: Buffer) => zlib.gzipSync(bytes).byteLength;
      assert.deepStrictEqual(measured, {
        files: 3,
        rawBytes: first.byteLength + second.byteLength + nestedNamesake.byteLength,
        gzipBytes: gzip(first) + gzip(second) + gzip(nestedNamesake),
        brotliBytes: brotli(first) + brotli(second) + brotli(nestedNamesake),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
