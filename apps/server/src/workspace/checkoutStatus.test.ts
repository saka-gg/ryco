import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseWorktreeStatus } from "@ryco/shared/workspaceLifecycle";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkoutChangeBlockers,
  checkoutHasBlockingChanges,
  ignoredCacheDirectories,
  withoutEmptyIgnoredDirectories,
  withRegenerableByOwnNameOnly,
} from "./checkoutStatus.ts";

const status = (lines: readonly string[]) => parseWorktreeStatus(lines.join("\0"));

describe("checkout status", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  const checkout = async (layout: Record<string, string | null>) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-checkout-status-"));
    roots.push(root);
    for (const [relative, content] of Object.entries(layout)) {
      const target = path.join(root, relative);
      if (content === null) await fs.mkdir(target, { recursive: true });
      else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
    }
    return root;
  };

  it("gives one reason per kind of content a removal would lose", () => {
    const parsed = status([
      " M src/a.ts",
      "M  src/b.ts",
      "R  src/new.ts",
      "src/old.ts",
      "?? notes.md",
      "!! .env",
      "!! local.sqlite",
      "!! exports/",
      "!! out.log",
      "!! node_modules/",
      "!! tsconfig.tsbuildinfo",
    ]);
    expect(checkoutChangeBlockers({ ...parsed, truncated: true })).toEqual([
      "The checkout has too many changes to verify safely.",
      "3 tracked files has uncommitted changes.",
      "1 untracked file would be lost.",
      "4 ignored files that are not a known cache would be lost (.env, local.sqlite, exports/).",
    ]);
    expect(
      checkoutChangeBlockers({
        ...status(["!! .env.local"]),
        truncated: false,
      }),
    ).toEqual(["1 ignored file that is not a known cache would be lost (.env.local)."]);
    expect(checkoutHasBlockingChanges({ ...parsed, truncated: false })).toBe(true);
  });

  it("does not block on regenerable ignored files and lists cache folders separately", () => {
    const parsed = status([
      "!! node_modules/",
      "!! apps/web/dist/",
      "!! tsconfig.tsbuildinfo",
      "!! src/.DS_Store",
      "!! pkg/__pycache__/mod.pyc",
    ]);
    const clean = { ...parsed, truncated: false };
    expect(checkoutChangeBlockers(clean)).toEqual([]);
    expect(checkoutHasBlockingChanges(clean)).toBe(false);
    expect(ignoredCacheDirectories(parsed)).toEqual(["node_modules/", "apps/web/dist/"]);
    // Sensitive files stay protected even inside a cache folder.
    expect(checkoutChangeBlockers({ ...status(["!! dist/.env"]), truncated: false })).toEqual([
      "1 ignored file that is not a known cache would be lost (dist/.env).",
    ]);
  });

  it("without a review, counts an entry as a cache only by its own name", () => {
    const parsed = status([
      "!! build/signing.properties",
      "!! dist/out.js",
      "!! dist/sub/",
      "!! src/.DS_Store",
      "!! pkg/__pycache__/mod.pyc",
      "!! apps/web/node_modules/",
      "!! .env",
    ]);
    // The reviewed rule (Remove checkout) takes a cache-like folder above an entry as proof.
    expect(parsed.protectedIgnored).toEqual([".env"]);
    const unattended = withRegenerableByOwnNameOnly(parsed);
    expect(unattended.protectedIgnored).toEqual([
      ".env",
      "build/signing.properties",
      "dist/out.js",
      "dist/sub/",
    ]);
    expect(unattended.regenerableIgnored).toEqual([
      "src/.DS_Store",
      "pkg/__pycache__/mod.pyc",
      "apps/web/node_modules/",
    ]);
    const clean = status(["!! tsconfig.tsbuildinfo", "!! node_modules/"]);
    expect(withRegenerableByOwnNameOnly(clean)).toBe(clean);
  });

  it("drops ignored folders that hold only empty folders", async () => {
    const root = await checkout({
      "exports/nested/deeper": null,
      "archive/data.json": "{}",
      "dist/assets": null,
      "node_modules/pkg/index.js": "",
    });
    const parsed = status(["!! exports/", "!! archive/", "!! dist/", "!! node_modules/"]);
    // The lifecycle preview lists empty cache folders it discards; only protected ones drop.
    expect(await withoutEmptyIgnoredDirectories(root, parsed)).toEqual({
      ...parsed,
      protectedIgnored: ["archive/"],
    });
    expect(
      await withoutEmptyIgnoredDirectories(root, parsed, { includeRegenerable: true }),
    ).toEqual({
      ...parsed,
      protectedIgnored: ["archive/"],
      regenerableIgnored: ["node_modules/"],
    });
  });
});
