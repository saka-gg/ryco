import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import fsPromises from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { PROJECT_READ_FILE_BINARY_MAX_BYTES } from "@ryco/contracts";

import { ServerConfig } from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceAccessPolicyLayer } from "./WorkspaceAccessPolicy.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(
    WorkspaceEntriesLive.pipe(
      Layer.provide(WorkspacePathsLive),
      Layer.provide(WorkspaceAccessPolicyLayer(undefined)),
    ),
  ),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(
    WorkspaceEntriesLive.pipe(
      Layer.provide(WorkspacePathsLive),
      Layer.provide(WorkspaceAccessPolicyLayer(undefined)),
    ),
  ),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "ryco-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

/** A real 1x1 PNG, so magic-byte acceptance is exercised against actual encoder output. */
const TINY_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function isoBaseMediaBytes(brand: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20]),
    Buffer.from(`ftyp${brand}`, "latin1"),
  ]);
}

const RASTER_SIGNATURE_FIXTURES: Readonly<
  Record<string, { readonly bytes: Buffer; readonly mimeType: string }>
> = {
  "pixel.png": { bytes: TINY_PNG_BYTES, mimeType: "image/png" },
  "photo.jpg": {
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
    mimeType: "image/jpeg",
  },
  "loop.gif": {
    bytes: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]),
    mimeType: "image/gif",
  },
  "shot.webp": {
    bytes: Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.from([0x1a, 0x00, 0x00, 0x00]),
      Buffer.from("WEBPVP8 ", "latin1"),
    ]),
    mimeType: "image/webp",
  },
  "raster.bmp": {
    bytes: Buffer.concat([Buffer.from("BM", "latin1"), Buffer.from([0x1e, 0x00, 0x00, 0x00])]),
    mimeType: "image/bmp",
  },
  "favicon.ico": {
    bytes: Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]),
    mimeType: "image/x-icon",
  },
  "modern.avif": { bytes: isoBaseMediaBytes("avif"), mimeType: "image/avif" },
  "camera.heic": { bytes: isoBaseMediaBytes("heic"), mimeType: "image/heic" },
};

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "ryco-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

const writeBinaryFile = Effect.fn("writeBinaryFile")(function* (
  cwd: string,
  relativePath: string,
  contents: Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFile(absolutePath, contents).pipe(Effect.orDie);
});

const writeDirectorySymlink = Effect.fn("writeDirectorySymlink")(function* (
  cwd: string,
  relativePath: string,
  targetPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* Effect.promise(() =>
    fsPromises.symlink(targetPath, absolutePath, process.platform === "win32" ? "junction" : "dir"),
  ).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  it.effect(
    "refuses parent-cwd writes into a removing checkout, aliases and removed descendants",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const files = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "managed-checkout/src/keep.txt", "keep");
        const checkout = yield* Effect.promise(() =>
          fsPromises.realpath(path.join(cwd, "managed-checkout")),
        );
        yield* sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('editor-guard', ${checkout}, 'worktree', '{}', ${new Date().toISOString()}, 'removing')`;
        yield* Effect.promise(() => fsPromises.symlink(checkout, path.join(cwd, "alias"), "dir"));
        for (const relativePath of [
          "managed-checkout/src/keep.txt",
          "managed-checkout/new/file.txt",
          "alias/src/keep.txt",
        ]) {
          const result = yield* files
            .writeFile({ cwd, relativePath, contents: "overwrite" })
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
        }
        expect(yield* fileSystem.readFileString(path.join(checkout, "src/keep.txt"))).toBe("keep");
        yield* fileSystem.makeDirectory(path.join(cwd, ".ryco"));
        yield* Effect.promise(() =>
          fsPromises.symlink(checkout, path.join(cwd, ".ryco/attachments"), "dir"),
        );
        expect(
          (yield* files
            .stageFileReference({
              cwd,
              scopeId: "fixture",
              name: "staged.txt",
              dataBase64: Buffer.from("keep").toString("base64"),
              sizeBytes: 4,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* fileSystem.remove(checkout, { recursive: true });
        yield* sql`UPDATE storage_owned_entries SET state = 'removed' WHERE id = 'editor-guard'`;
        expect(
          (yield* files
            .writeFile({ cwd, relativePath: "managed-checkout/new/file.txt", contents: "recreate" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* fileSystem.exists(checkout)).toBe(false);
        yield* sql`DELETE FROM storage_owned_entries WHERE id = 'editor-guard'`;
      }),
  );
  describe("readFile", () => {
    it.effect("reads files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "plans/effect-rpc.md", "# Plan\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
        });

        expect(result).toEqual({
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
          version: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          encoding: "utf8",
          lineEnding: "lf",
        });
      }),
    );

    it.effect("normalizes UTF-8 BOM and CRLF files while retaining their format metadata", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeBinaryFile(
          cwd,
          "notes/windows.txt",
          Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first\r\nsecond\r\n")]),
        );

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "notes/windows.txt",
        });

        expect(result.contents).toBe("first\nsecond\n");
        expect(result.encoding).toBe("utf8-bom");
        expect(result.lineEnding).toBe("crlf");
        expect(result.version).toMatch(/^sha256:[a-f0-9]{64}$/);
      }),
    );

    it.effect("marks mixed line endings without altering the normalized preview", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes/mixed.txt", "one\r\ntwo\nthree\r");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "notes/mixed.txt",
        });

        expect(result.contents).toBe("one\ntwo\nthree\n");
        expect(result.lineEnding).toBe("mixed");
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects files that exceed the preview size limit", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "logs/huge.log", "x".repeat(512 * 1024 + 1));

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "logs/huge.log",
          })
          .pipe(Effect.flip);

        if (!("detail" in error)) {
          throw new Error("Expected WorkspaceFileSystemError detail for oversized preview.");
        }
        expect(error.detail).toContain("File is too large to preview");
        expect(error.detail).toContain("Limit is 524288 bytes.");
      }),
    );

    it.effect("rejects binary files", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeBinaryFile(cwd, "assets/logo.bin", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]));

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "assets/logo.bin",
          })
          .pipe(Effect.flip);

        if (!("detail" in error)) {
          throw new Error("Expected WorkspaceFileSystemError detail for binary preview.");
        }
        expect(error.detail).toBe("Binary files cannot be previewed.");
      }),
    );

    it.effect("rejects symlinked paths that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;

        const externalDir = `${cwd}-outside`;
        yield* Effect.promise(() => fsPromises.mkdir(externalDir, { recursive: true })).pipe(
          Effect.orDie,
        );
        yield* Effect.promise(() =>
          fsPromises.writeFile(path.join(externalDir, "secret.txt"), "secret\n"),
        ).pipe(Effect.orDie);
        yield* writeDirectorySymlink(cwd, "linked", externalDir);

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "linked/secret.txt",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked/secret.txt",
        );
      }),
    );

    it.effect("rejects escaped symlink reads without leaking missing-target metadata", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const externalDir = `${cwd}-outside`;
        yield* Effect.promise(() => fsPromises.mkdir(externalDir, { recursive: true })).pipe(
          Effect.orDie,
        );
        yield* writeDirectorySymlink(cwd, "linked", externalDir);

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "linked/missing.txt",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked/missing.txt",
        );
        expect(String(error)).not.toContain("ENOENT");
      }),
    );

    it.effect("rejects escaped symlink reads without leaking directory metadata", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;

        const externalDir = `${cwd}-outside`;
        yield* Effect.promise(() =>
          fsPromises.mkdir(path.join(externalDir, "nested"), { recursive: true }),
        ).pipe(Effect.orDie);
        yield* writeDirectorySymlink(cwd, "linked", externalDir);

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "linked/nested",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked/nested",
        );
        if ("detail" in error) {
          expect(error.detail).not.toBe("Only regular files can be previewed.");
        }
      }),
    );

    it.effect("rejects escaped symlink reads without leaking file size metadata", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;

        const externalDir = `${cwd}-outside`;
        yield* Effect.promise(() => fsPromises.mkdir(externalDir, { recursive: true })).pipe(
          Effect.orDie,
        );
        yield* Effect.promise(() =>
          fsPromises.writeFile(path.join(externalDir, "huge.log"), "x".repeat(512 * 1024 + 1)),
        ).pipe(Effect.orDie);
        yield* writeDirectorySymlink(cwd, "linked", externalDir);

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "linked/huge.log",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked/huge.log",
        );
        if ("detail" in error) {
          expect(error.detail).not.toContain("File is too large to preview");
        }
      }),
    );
  });

  describe("readFileBinary", () => {
    it.effect("returns base64 bytes with a mime type derived from magic bytes", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeBinaryFile(cwd, "assets/pixel.png", TINY_PNG_BYTES);

        const result = yield* workspaceFileSystem.readFileBinary({
          cwd,
          relativePath: "assets/pixel.png",
        });

        expect(result.relativePath).toBe("assets/pixel.png");
        expect(result.mimeType).toBe("image/png");
        expect(result.sizeBytes).toBe(TINY_PNG_BYTES.byteLength);
        expect(Array.from(Buffer.from(result.dataBase64, "base64"))).toEqual(
          Array.from(TINY_PNG_BYTES),
        );
      }),
    );

    it.effect("trusts the bytes over the file extension", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeBinaryFile(cwd, "assets/mislabeled.jpg", TINY_PNG_BYTES);

        const result = yield* workspaceFileSystem.readFileBinary({
          cwd,
          relativePath: "assets/mislabeled.jpg",
        });

        expect(result.mimeType).toBe("image/png");
      }),
    );

    it.effect("recognizes every supported raster signature", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        for (const [name, { bytes, mimeType }] of Object.entries(RASTER_SIGNATURE_FIXTURES)) {
          yield* writeBinaryFile(cwd, `assets/${name}`, bytes);
          const result = yield* workspaceFileSystem.readFileBinary({
            cwd,
            relativePath: `assets/${name}`,
          });
          expect(result.mimeType).toBe(mimeType);
        }
      }),
    );

    it.effect("refuses bytes that are not a supported image", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes/plain.png", "# Not an image\n");

        const error = yield* workspaceFileSystem
          .readFileBinary({
            cwd,
            relativePath: "notes/plain.png",
          })
          .pipe(Effect.flip);

        if (!("detail" in error)) {
          throw new Error("Expected WorkspaceFileSystemError detail for unsupported image bytes.");
        }
        expect(error.detail).toBe("Not a supported image.");
      }),
    );

    it.effect("refuses video containers that share the ISO base-media header", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeBinaryFile(cwd, "assets/clip.heic", isoBaseMediaBytes("isom"));

        const error = yield* workspaceFileSystem
          .readFileBinary({
            cwd,
            relativePath: "assets/clip.heic",
          })
          .pipe(Effect.flip);

        if (!("detail" in error)) {
          throw new Error("Expected WorkspaceFileSystemError detail for a video container.");
        }
        expect(error.detail).toBe("Not a supported image.");
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFileBinary({
            cwd,
            relativePath: "../escape.png",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.png",
        );
      }),
    );

    it.effect("rejects symlinked images that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;

        const externalDir = `${cwd}-outside`;
        yield* Effect.promise(() => fsPromises.mkdir(externalDir, { recursive: true })).pipe(
          Effect.orDie,
        );
        yield* Effect.promise(() =>
          fsPromises.writeFile(path.join(externalDir, "secret.png"), TINY_PNG_BYTES),
        ).pipe(Effect.orDie);
        yield* writeDirectorySymlink(cwd, "linked", externalDir);

        const error = yield* workspaceFileSystem
          .readFileBinary({
            cwd,
            relativePath: "linked/secret.png",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked/secret.png",
        );
      }),
    );

    it.effect("rejects images above the binary preview limit", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const oversized = Buffer.alloc(PROJECT_READ_FILE_BINARY_MAX_BYTES + 1);
        TINY_PNG_BYTES.copy(oversized);
        yield* writeBinaryFile(cwd, "assets/huge.png", oversized);

        const error = yield* workspaceFileSystem
          .readFileBinary({
            cwd,
            relativePath: "assets/huge.png",
          })
          .pipe(Effect.flip);

        if (!("detail" in error)) {
          throw new Error("Expected WorkspaceFileSystemError detail for oversized image.");
        }
        expect(error.detail).toBe(
          `File is too large to preview (${oversized.byteLength} bytes). Limit is 4194304 bytes.`,
        );
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({
          relativePath: "plans/effect-rpc.md",
          version: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("guardedly saves while preserving BOM, CRLF, and permissions", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, "notes/windows.txt");
        yield* writeBinaryFile(
          cwd,
          "notes/windows.txt",
          Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("before\r\n")]),
        );
        if (process.platform !== "win32") {
          yield* Effect.promise(() => fsPromises.chmod(absolutePath, 0o640)).pipe(Effect.orDie);
        }
        const loaded = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "notes/windows.txt",
        });

        const saved = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "notes/windows.txt",
          contents: "after\nsecond\n",
          expectedVersion: loaded.version,
          encoding: loaded.encoding,
          lineEnding: loaded.lineEnding,
        });

        const raw = yield* Effect.promise(() => fsPromises.readFile(absolutePath)).pipe(
          Effect.orDie,
        );
        expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
        expect(raw.subarray(3).toString("utf8")).toBe("after\r\nsecond\r\n");
        expect(saved.version).not.toBe(loaded.version);
        if (process.platform !== "win32") {
          const stat = yield* Effect.promise(() => fsPromises.stat(absolutePath)).pipe(
            Effect.orDie,
          );
          expect(stat.mode & 0o777).toBe(0o640);
        }
      }),
    );

    it.effect("rejects a guarded save after the file changes", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/app.ts", "export const value = 1;\n");
        const loaded = yield* workspaceFileSystem.readFile({ cwd, relativePath: "src/app.ts" });
        yield* writeTextFile(cwd, "src/app.ts", "export const value = 2;\n");

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "src/app.ts",
            contents: "export const value = 3;\n",
            expectedVersion: loaded.version,
            encoding: loaded.encoding,
            lineEnding: loaded.lineEnding,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileConflictError");
        const persisted = yield* Effect.promise(() =>
          fsPromises.readFile(`${cwd}/src/app.ts`, "utf8"),
        ).pipe(Effect.orDie);
        expect(persisted).toBe("export const value = 2;\n");
      }),
    );

    it.effect("does not recreate a file deleted after it was opened", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, "src/app.ts");
        yield* writeTextFile(cwd, "src/app.ts", "export {};\n");
        const loaded = yield* workspaceFileSystem.readFile({ cwd, relativePath: "src/app.ts" });
        yield* Effect.promise(() => fsPromises.unlink(absolutePath)).pipe(Effect.orDie);

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "src/app.ts",
            contents: "export const restored = true;\n",
            expectedVersion: loaded.version,
            encoding: loaded.encoding,
            lineEnding: loaded.lineEnding,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileDeletedError");
        const exists = yield* Effect.promise(() =>
          fsPromises.stat(absolutePath).then(
            () => true,
            () => false,
          ),
        );
        expect(exists).toBe(false);
      }),
    );

    it.effect("rejects guarded saves with mixed line endings", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes/mixed.txt", "one\r\ntwo\n");
        const loaded = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "notes/mixed.txt",
        });

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "notes/mixed.txt",
            contents: loaded.contents,
            expectedVersion: loaded.version,
            encoding: loaded.encoding,
            lineEnding: loaded.lineEnding,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileUnsupportedEditError");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(beforeWrite).toEqual({
          entries: [],
          truncated: false,
        });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("rejects symlinked write targets that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const externalDir = `${cwd}-outside`;
        yield* Effect.promise(() => fsPromises.mkdir(externalDir, { recursive: true })).pipe(
          Effect.orDie,
        );
        yield* writeDirectorySymlink(cwd, "linked", externalDir);

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "linked/malicious.txt",
            contents: "escaped\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked/malicious.txt",
        );

        const escapedStat = yield* fileSystem
          .stat(path.join(externalDir, "malicious.txt"))
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );
  });

  describe("stageFileReference", () => {
    it.effect("writes staged binary files under a workspace attachment directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const payload = Buffer.from([0, 1, 2, 3]);

        const result = yield* workspaceFileSystem.stageFileReference({
          cwd,
          scopeId: "thread/test id",
          name: "report data.pdf",
          mimeType: "application/pdf",
          sizeBytes: payload.byteLength,
          dataBase64: payload.toString("base64"),
        });

        expect(result.relativePath).toMatch(
          /^\.ryco\/attachments\/thread-test-id\/report-data-[a-f0-9]{8}\.pdf$/,
        );
        expect(result.sizeBytes).toBe(payload.byteLength);

        const saved = yield* fileSystem
          .readFile(path.join(cwd, result.relativePath))
          .pipe(Effect.orDie);
        expect(Array.from(saved)).toEqual(Array.from(payload));
      }),
    );

    it.effect("rejects invalid staged file payloads", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .stageFileReference({
            cwd,
            scopeId: "thread-1",
            name: "data.txt",
            sizeBytes: 4,
            dataBase64: "not base64",
          })
          .pipe(Effect.flip);

        if (!("detail" in error)) {
          throw new Error("Expected WorkspaceFileSystemError detail.");
        }
        expect(error.detail).toBe("Staged file payload is invalid.");
      }),
    );
  });
});
