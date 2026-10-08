import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { extractZipArchive, safeZipEntryPath } from "./zipArchive.ts";
import { makeZip, type ZipFixtureEntry } from "./zipArchive.fixtures.ts";

const ROOT = "bundle-fixture/";
const posix = process.platform !== "win32";

const harness = Effect.fn("test.zipHarness")(function* (entries: ReadonlyArray<ZipFixtureEntry>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-zip-test-" });
  const archivePath = path.join(directory, "archive.zip");
  yield* fs.writeFile(archivePath, makeZip(entries));
  const destination = path.join(directory, "out");
  const extract = (
    options: { readonly maxEntries?: number; readonly maxTotalBytes?: number } = {},
  ) =>
    extractZipArchive({
      archivePath,
      destination,
      stripPrefix: ROOT,
      maxEntries: options.maxEntries ?? 100,
      maxTotalBytes: options.maxTotalBytes ?? 1024 * 1024,
    });
  return { fs, path, directory, destination, extract };
});

it.layer(NodeServices.layer)("extractZipArchive", (it) => {
  it.effect("unpacks stored and deflated members with their modes, creating parents", () =>
    Effect.gen(function* () {
      const big = "chart ".repeat(20_000);
      const { fs, path, destination, extract } = yield* harness([
        // No directory entries at all, like Chrome for Testing's macOS archive.
        { name: `${ROOT}bin/tool`, data: "#!/bin/sh\n", mode: 0o100755 },
        { name: `${ROOT}data/big.txt`, data: big, method: 8, mode: 0o100644 },
        { name: `${ROOT}empty`, mode: 0o100644 },
        { name: `${ROOT}locales/`, mode: 0o40755 },
        { name: `${ROOT}locales/en-US.pak`, data: "strings", method: 8 },
        // World-writable and setuid bits never survive extraction.
        { name: `${ROOT}lib.so`, data: "library", mode: 0o104777 },
      ]);

      const files = yield* extract();

      expect(files).toEqual(["bin/tool", "data/big.txt", "empty", "locales/en-US.pak", "lib.so"]);
      expect(yield* fs.readFileString(path.join(destination, "bin", "tool"))).toBe("#!/bin/sh\n");
      expect(yield* fs.readFileString(path.join(destination, "data", "big.txt"))).toBe(big);
      expect(yield* fs.readFileString(path.join(destination, "empty"))).toBe("");
      expect(yield* fs.readFileString(path.join(destination, "locales", "en-US.pak"))).toBe(
        "strings",
      );
      if (posix) {
        const mode = (file: string) =>
          fs.stat(path.join(destination, file)).pipe(Effect.map((info) => info.mode & 0o7777));
        expect(yield* mode("bin/tool")).toBe(0o755);
        expect(yield* mode("data/big.txt")).toBe(0o644);
        expect(yield* mode("lib.so")).toBe(0o755);
      }
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "a parent-directory entry", entry: { name: `${ROOT}../escape`, data: "x" } },
    { name: "an absolute entry", entry: { name: "/escape", data: "x" } },
    { name: "an entry outside the top directory", entry: { name: "escape", data: "x" } },
    { name: "a backslash path", entry: { name: `${ROOT}..\\escape`, data: "x" } },
    { name: "a drive path", entry: { name: `${ROOT}C:escape`, data: "x" } },
    {
      name: "a symlink",
      entry: { name: `${ROOT}link`, data: "/etc/passwd", mode: 0o120777 },
    },
    { name: "a device", entry: { name: `${ROOT}device`, mode: 0o020644 } },
    { name: "an encrypted entry", entry: { name: `${ROOT}secret`, data: "x", flags: 1 } },
    { name: "an unsupported method", entry: { name: `${ROOT}bzip`, data: "x", method: 12 } },
    {
      name: "a duplicate entry",
      entry: { name: `${ROOT}bin/tool`, data: "replacement", mode: 0o100755 },
    },
  ] satisfies ReadonlyArray<{ name: string; entry: ZipFixtureEntry }>)(
    "rejects an archive with $name before writing anything",
    (testCase) =>
      Effect.gen(function* () {
        const { fs, path, directory, destination, extract } = yield* harness([
          { name: `${ROOT}bin/tool`, data: "#!/bin/sh\n", mode: 0o100755 },
          testCase.entry,
        ]);

        const error = yield* extract().pipe(Effect.flip);

        expect(error).toMatchObject({ _tag: "ZipArchiveError", kind: "invalid" });
        expect(yield* fs.exists(destination)).toBe(false);
        expect(yield* fs.exists(path.join(directory, "escape"))).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "a deflated member larger than recorded",
      entry: { name: `${ROOT}bomb`, data: "a".repeat(100_000), method: 8, uncompressedSize: 10 },
    },
    {
      name: "a CRC mismatch",
      entry: { name: `${ROOT}tampered`, data: "payload", method: 8, crc32: 1234 },
    },
    {
      name: "a stored member whose sizes disagree",
      entry: { name: `${ROOT}short`, data: "payload", uncompressedSize: 3 },
    },
  ] satisfies ReadonlyArray<{ name: string; entry: ZipFixtureEntry }>)(
    "rejects $name",
    (testCase) =>
      Effect.gen(function* () {
        const { extract } = yield* harness([testCase.entry]);
        expect(yield* extract().pipe(Effect.flip)).toMatchObject({
          _tag: "ZipArchiveError",
          kind: "invalid",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("enforces the entry count and unpacked size limits", () =>
    Effect.gen(function* () {
      const { extract } = yield* harness([
        { name: `${ROOT}a`, data: "x".repeat(600) },
        { name: `${ROOT}b`, data: "x".repeat(600) },
      ]);
      expect((yield* extract({ maxEntries: 1 }).pipe(Effect.flip)).detail).toBe(
        "The archive has too many entries.",
      );
      expect((yield* extract({ maxTotalBytes: 1000 }).pipe(Effect.flip)).detail).toBe(
        "The archive unpacks too large.",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a file that is not a ZIP and reports a missing archive as I/O", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-zip-test-" });
      const archivePath = path.join(directory, "archive.zip");
      yield* fs.writeFileString(archivePath, "not a zip at all");
      const extract = (source: string) =>
        extractZipArchive({
          archivePath: source,
          destination: path.join(directory, "out"),
          maxEntries: 10,
          maxTotalBytes: 1024,
        }).pipe(Effect.flip);
      expect(yield* extract(archivePath)).toMatchObject({ kind: "invalid" });
      expect(yield* extract(path.join(directory, "missing.zip"))).toMatchObject({ kind: "io" });
    }).pipe(Effect.scoped),
  );
});

it("accepts only plain relative member paths", () => {
  expect(safeZipEntryPath("a/b.txt")).toBe("a/b.txt");
  expect(safeZipEntryPath("dir/")).toBe("dir");
  for (const name of ["", "/", "/a", "a/../b", "./a", "a//b", "a\\b", "c:a", "a\u0000b", "a/."]) {
    expect(safeZipEntryPath(name)).toBeUndefined();
  }
});
