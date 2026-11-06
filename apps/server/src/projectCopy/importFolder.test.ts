import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as tar from "tar";

import { extractFolderArchive } from "./importFolder.ts";

const withRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryco-unpack-")))),
    use,
    (root) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
  );

describe("extractFolderArchive", () => {
  it.effect("keeps every entry of a hostile archive inside the directory", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        // The packing side: a folder whose entries name places outside, written as they are.
        const outside = path.join(root, "outside");
        const packed = path.join(root, "packed", "inner");
        fs.mkdirSync(outside, { recursive: true });
        fs.mkdirSync(packed, { recursive: true });
        fs.writeFileSync(path.join(root, "packed", "escape.txt"), "escaped\n");
        fs.writeFileSync(path.join(packed, "ok.txt"), "ok\n");
        // What the archive would write over the victim, were it allowed to.
        fs.writeFileSync(path.join(outside, "victim.txt"), "pwned\n");
        fs.symlinkSync(outside, path.join(packed, "link"));
        fs.linkSync(path.join(packed, "ok.txt"), path.join(packed, "hard.txt"));
        const archive = path.join(root, "hostile.tar.gz");
        yield* Effect.promise(() =>
          tar.create(
            { gzip: true, file: archive, cwd: packed, preservePaths: true, follow: false },
            [
              "ok.txt",
              "hard.txt",
              "../escape.txt",
              "link",
              "link/victim.txt",
              path.join(outside, "victim.txt"),
            ],
          ),
        );
        fs.writeFileSync(path.join(outside, "victim.txt"), "original\n");

        const dest = path.join(root, "dest");
        fs.mkdirSync(dest);
        const result = yield* extractFolderArchive({ archivePath: archive, directory: dest });

        expect(fs.readFileSync(path.join(dest, "ok.txt"), "utf8")).toBe("ok\n");
        expect(fs.existsSync(path.join(root, "escape.txt"))).toBe(false);
        expect(fs.readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe("original\n");
        // The hard link is not written; an absolute path never leaves the directory.
        expect(fs.existsSync(path.join(dest, "hard.txt"))).toBe(false);
        expect(result.skippedEntries).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("fails on a file that is not an archive", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const archive = path.join(root, "broken.tar.gz");
        fs.writeFileSync(archive, "not a tar at all");
        const dest = path.join(root, "dest");
        fs.mkdirSync(dest);
        const error = yield* extractFolderArchive({ archivePath: archive, directory: dest }).pipe(
          Effect.flip,
        );
        expect(error.message).toMatch(/could not be unpacked/);
      }),
    ),
  );
});
