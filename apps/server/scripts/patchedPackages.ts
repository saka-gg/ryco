import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo patches (root `package.json` `patchedDependencies`) are applied by Bun to
 * the workspace install only: an npm install of the published `ryco-cli` gets
 * the upstream package. A dependency the server imports through an export a
 * patch adds must therefore be bundled, so the build carries the patched
 * sources it was built against.
 *
 * `@pierre/diffs`: its patch only adds exports (`utils/parsePatchFiles`, a
 * dependency-free module the server's checkpoint diffs import on the boot path
 * without loading shiki through the package root).
 */
export const BUNDLED_PATCHED_PACKAGES: ReadonlyArray<string> = ["@pierre/diffs"];

const packageOf = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
};

export function isBundledPatchedPackageImport(specifier: string): boolean {
  return BUNDLED_PATCHED_PACKAGES.includes(packageOf(specifier));
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The import specifiers that resolve only because a repo patch adds them to a
 * package's `exports` map (absent upstream).
 */
export function patchAddedExports(): ReadonlySet<string> {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    readonly patchedDependencies?: Readonly<Record<string, string>>;
  };
  const added = new Set<string>();
  for (const [key, patchPath] of Object.entries(manifest.patchedDependencies ?? {})) {
    const name = key.slice(0, key.lastIndexOf("@"));
    const patch = readFileSync(path.join(repoRoot, patchPath), "utf8");
    // Only the package.json section can add exports.
    for (const section of patch.split(/^diff --git /mu)) {
      if (!section.startsWith("a/package.json b/package.json")) continue;
      for (const match of section.matchAll(/^\+\s*"(\.\/[^"]+)"\s*:/gmu)) {
        added.add(`${name}/${match[1]!.slice(2)}`);
      }
    }
  }
  return added;
}
