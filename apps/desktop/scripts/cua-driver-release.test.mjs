import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import release from "../../../packages/shared/src/cuaDriverRelease.json" with { type: "json" };

const patch = (name) => readFileSync(new URL(`../patches/cua-driver/${name}`, import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const LITERAL = /^[+ ]\s*metadata\["synara_native_revision"\] = serde_json::json!\((\d+)\);$/;
const literals = (text, prefix) =>
  text
    .split("\n")
    .filter((line) => line.startsWith(prefix) && LITERAL.test(line))
    .map((line) => Number(LITERAL.exec(line)[1]));

describe("pinned Cua native patches", () => {
  it("match the release manifest checksums", () => {
    expect(sha256(patch("0001-synara-native.patch"))).toBe(release.patchSha256);
    expect(sha256(patch("0002-synara-linux-browser.patch"))).toBe(release.linuxBrowserPatchSha256);
  });

  it("stamp the manifest's native revision into daemon metadata", () => {
    // Later hunks rewrite earlier ones; the last added literal is what the daemon reports.
    expect(literals(patch("0001-synara-native.patch").toString("utf8"), "+").at(-1)).toBe(
      release.nativeRevision,
    );
    // 0002 applies after 0001 and carries the literal as context.
    expect(literals(patch("0002-synara-linux-browser.patch").toString("utf8"), " ")).toEqual([
      release.nativeRevision,
    ]);
  });
});
