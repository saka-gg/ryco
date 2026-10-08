import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  storageLifecycleLock,
  storagePathBlocker,
  canonicalStoragePath,
} from "../../storage/lifecycle.ts";
import { createHash, randomUUID } from "node:crypto";
import { constants as NodeFsConstants, type BigIntStats } from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import { Data, Effect, FileSystem, Layer, Path, Schema, Option } from "effect";
import {
  PROJECT_READ_FILE_BINARY_MAX_BYTES,
  PROJECT_RELOCATION_PENDING_MESSAGE,
  PROJECT_STAGE_FILE_MAX_BYTES,
} from "@ryco/contracts";

import {
  WorkspaceFileConflictError,
  WorkspaceFileDeletedError,
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  WorkspaceFileUnsupportedEditError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePathOutsideRootError, WorkspacePaths } from "../Services/WorkspacePaths.ts";

const WORKSPACE_PREVIEW_MAX_BYTES = 512 * 1024;
const WORKSPACE_PREVIEW_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const STAGED_FILE_ROOT = ".ryco/attachments";
const UNSAFE_PATH_SEGMENT_CHARS = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);

const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC_BYTES = [0xff, 0xd8, 0xff];
const GIF_MAGIC_BYTES = [0x47, 0x49, 0x46, 0x38];
const BMP_MAGIC_BYTES = [0x42, 0x4d];
const ICO_MAGIC_BYTES = [0x00, 0x00, 0x01, 0x00];
const RIFF_MAGIC_BYTES = [0x52, 0x49, 0x46, 0x46];
const WEBP_MAGIC_BYTES = [0x57, 0x45, 0x42, 0x50];
const ISO_BASE_MEDIA_FTYP_BYTES = [0x66, 0x74, 0x79, 0x70];
const ISO_BASE_MEDIA_IMAGE_BRANDS: Readonly<Record<string, string>> = {
  avif: "image/avif",
  avis: "image/avif",
  heic: "image/heic",
  heim: "image/heic",
  heis: "image/heic",
  heix: "image/heic",
  hevc: "image/heic",
  hevm: "image/heic",
  hevs: "image/heic",
  hevx: "image/heic",
  mif1: "image/heic",
  msf1: "image/heic",
};

function isLikelyBinaryPreview(bytes: Uint8Array): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0);
}

function hasMagicBytes(bytes: Uint8Array, magic: ReadonlyArray<number>, offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((value, index) => bytes[offset + index] === value);
}

/**
 * Raster previews are typed by what the bytes are, never by what the path
 * claims: the client renders these bytes in an image view, so a mislabelled
 * extension must not decide the mime type. Unsupported magic numbers are
 * refused rather than guessed at.
 */
function detectRasterImageMimeType(bytes: Uint8Array): string | null {
  if (hasMagicBytes(bytes, PNG_MAGIC_BYTES)) return "image/png";
  if (hasMagicBytes(bytes, JPEG_MAGIC_BYTES)) return "image/jpeg";
  if (hasMagicBytes(bytes, GIF_MAGIC_BYTES)) return "image/gif";
  if (hasMagicBytes(bytes, RIFF_MAGIC_BYTES) && hasMagicBytes(bytes, WEBP_MAGIC_BYTES, 8)) {
    return "image/webp";
  }
  if (hasMagicBytes(bytes, BMP_MAGIC_BYTES)) return "image/bmp";
  if (hasMagicBytes(bytes, ICO_MAGIC_BYTES)) return "image/x-icon";
  if (hasMagicBytes(bytes, ISO_BASE_MEDIA_FTYP_BYTES, 4)) {
    // Video containers share the ISO base-media ftyp header, so only the
    // still-image brands are accepted; an mp4 brand falls through to refusal.
    const brand = Buffer.from(bytes.subarray(8, 12)).toString("latin1");
    return ISO_BASE_MEDIA_IMAGE_BRANDS[brand] ?? null;
  }
  return null;
}

function fileVersion(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decodePreviewContents(bytes: Uint8Array): string | null {
  try {
    return WORKSPACE_PREVIEW_TEXT_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function detectLineEnding(contents: string): "lf" | "crlf" | "cr" | "mixed" {
  const crlfCount = contents.match(/\r\n/g)?.length ?? 0;
  const lfCount = contents.match(/(?<!\r)\n/g)?.length ?? 0;
  const crCount = contents.match(/\r(?!\n)/g)?.length ?? 0;
  const styles = Number(crlfCount > 0) + Number(lfCount > 0) + Number(crCount > 0);
  if (styles > 1) return "mixed";
  if (crlfCount > 0) return "crlf";
  if (crCount > 0) return "cr";
  return "lf";
}

function normalizeLineEndings(contents: string): string {
  return contents.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function encodeWorkspaceText(
  contents: string,
  encoding: "utf8" | "utf8-bom",
  lineEnding: "lf" | "crlf" | "cr",
): Buffer {
  const normalized = normalizeLineEndings(contents);
  const text =
    lineEnding === "lf"
      ? normalized
      : normalized.replaceAll("\n", lineEnding === "crlf" ? "\r\n" : "\r");
  const encoded = Buffer.from(text, "utf8");
  return encoding === "utf8-bom" ? Buffer.concat([UTF8_BOM, encoded]) : encoded;
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function pathStaysWithinRoot(rootPath: string, targetPath: string): boolean {
  const relative = NodePath.relative(rootPath, targetPath);
  return (
    relative.length > 0 &&
    relative !== "." &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

/**
 * `maxBytes` is a parameter because text and raster previews ride different
 * budgets; the stability checks and refusal wording stay identical so clients
 * keep mapping both limits with one set of strings.
 */
async function readStableFileBytes(
  filePath: string,
  maxBytes: number,
): Promise<{
  readonly bytes: Buffer;
  readonly stat: BigIntStats;
}> {
  const handle = await NodeFs.open(filePath, "r");
  try {
    const beforeReadStat = await handle.stat({ bigint: true });
    if (!beforeReadStat.isFile()) {
      throw new Error("Only regular files can be previewed.");
    }
    if (beforeReadStat.size > BigInt(maxBytes)) {
      throw new Error(
        `File is too large to preview (${beforeReadStat.size} bytes). Limit is ${maxBytes} bytes.`,
      );
    }
    const bytes = await handle.readFile();
    const afterReadStat = await handle.stat({ bigint: true });
    const pathStat = await NodeFs.stat(filePath, { bigint: true });
    if (
      bytes.byteLength !== Number(afterReadStat.size) ||
      !sameFileState(beforeReadStat, afterReadStat) ||
      !sameFileState(afterReadStat, pathStat)
    ) {
      throw new Error("File changed while it was being read. Try again.");
    }
    return { bytes, stat: afterReadStat };
  } finally {
    await handle.close();
  }
}

async function readCurrentFileVersion(input: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly filePath: string;
}): Promise<{ readonly version: string; readonly stat: BigIntStats }> {
  try {
    const { bytes, stat } = await readStableFileBytes(input.filePath, WORKSPACE_PREVIEW_MAX_BYTES);
    return { version: fileVersion(bytes), stat };
  } catch (cause) {
    if (isEnoentError(cause)) {
      throw new WorkspaceFileDeletedError({ cwd: input.cwd, relativePath: input.relativePath });
    }
    throw cause;
  }
}

async function writeGuardedFileAtomically(input: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly logicalPath: string;
  readonly realTargetPath: string;
  readonly bytes: Buffer;
  readonly expectedVersion: string;
}): Promise<void> {
  const realRoot = await NodeFs.realpath(input.cwd);
  const initial = await readCurrentFileVersion({
    cwd: input.cwd,
    relativePath: input.relativePath,
    filePath: input.realTargetPath,
  });
  if (initial.version !== input.expectedVersion) {
    throw new WorkspaceFileConflictError({
      cwd: input.cwd,
      relativePath: input.relativePath,
    });
  }
  await NodeFs.access(input.realTargetPath, NodeFsConstants.W_OK);

  const mode = Number(initial.stat.mode & 0o777n);
  const temporaryPath = NodePath.join(
    NodePath.dirname(input.realTargetPath),
    `.${NodePath.basename(input.realTargetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: NodeFs.FileHandle | undefined;
  let temporaryIdentity: { readonly dev: bigint; readonly ino: bigint } | null = null;

  try {
    const noFollow = process.platform === "win32" ? 0 : NodeFsConstants.O_NOFOLLOW;
    handle = await NodeFs.open(
      temporaryPath,
      NodeFsConstants.O_WRONLY | NodeFsConstants.O_CREAT | NodeFsConstants.O_EXCL | noFollow,
      mode,
    );
    const handleStat = await handle.stat({ bigint: true });
    temporaryIdentity = { dev: handleStat.dev, ino: handleStat.ino };
    const pathStat = await NodeFs.stat(temporaryPath, { bigint: true });
    if (!handleStat.isFile() || !sameFileState(handleStat, pathStat)) {
      throw new Error("Workspace write temporary path changed after open.");
    }
    const realTemporaryPath = await NodeFs.realpath(temporaryPath);
    if (realTemporaryPath !== temporaryPath || !pathStaysWithinRoot(realRoot, realTemporaryPath)) {
      throw new Error("Workspace write temporary path escaped the project root.");
    }
    await handle.chmod(mode);
    await handle.writeFile(input.bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const finalRealTarget = await NodeFs.realpath(input.logicalPath).catch((cause: unknown) => {
      if (isEnoentError(cause)) {
        throw new WorkspaceFileDeletedError({
          cwd: input.cwd,
          relativePath: input.relativePath,
        });
      }
      throw cause;
    });
    if (
      finalRealTarget !== input.realTargetPath ||
      !pathStaysWithinRoot(realRoot, finalRealTarget)
    ) {
      throw new WorkspaceFileConflictError({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    }
    const current = await readCurrentFileVersion({
      cwd: input.cwd,
      relativePath: input.relativePath,
      filePath: input.realTargetPath,
    });
    if (current.version !== input.expectedVersion || !sameFileState(initial.stat, current.stat)) {
      throw new WorkspaceFileConflictError({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    }
    await NodeFs.rename(temporaryPath, input.realTargetPath);
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    const temporaryStat = await NodeFs.stat(temporaryPath, { bigint: true }).catch(() => null);
    if (
      temporaryStat !== null &&
      temporaryIdentity !== null &&
      temporaryStat.dev === temporaryIdentity.dev &&
      temporaryStat.ino === temporaryIdentity.ino
    ) {
      await NodeFs.unlink(temporaryPath).catch(() => undefined);
    }
    throw cause;
  }
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function replaceUnsafePathSegmentCharacters(input: string): string {
  let output = "";
  let previousWasReplacement = false;
  for (const char of input) {
    const unsafe = char.charCodeAt(0) < 0x20 || UNSAFE_PATH_SEGMENT_CHARS.has(char);
    if (unsafe) {
      if (!previousWasReplacement) {
        output += "-";
      }
      previousWasReplacement = true;
      continue;
    }
    output += char;
    previousWasReplacement = false;
  }
  return output;
}

function sanitizePathSegment(input: string, fallback: string): string {
  const sanitized = replaceUnsafePathSegmentCharacters(input.trim())
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/g, "")
    .replace(/[.-]+$/g, "")
    .slice(0, 80);
  return sanitized.length > 0 ? sanitized : fallback;
}

function splitSafeFileName(fileName: string): { base: string; extension: string } {
  const safeName = sanitizePathSegment(fileName, "file");
  const dotIndex = safeName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === safeName.length - 1) {
    return { base: safeName, extension: "" };
  }
  return {
    base: safeName.slice(0, dotIndex) || "file",
    extension: safeName.slice(dotIndex).slice(0, 24),
  };
}

function decodeBase64File(input: { dataBase64: string; sizeBytes: number }): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64)) {
    return null;
  }
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (bytes.byteLength !== input.sizeBytes || bytes.byteLength > PROJECT_STAGE_FILE_MAX_BYTES) {
    return null;
  }
  return bytes;
}

class MissingRealPathError extends Data.TaggedError("MissingRealPathError") {}

function isEnoentError(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const storageSql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const assertStorageWritable = (cwd: string) =>
    Effect.gen(function* () {
      if (Option.isNone(storageSql)) return;
      const canonical = yield* Effect.tryPromise(() => canonicalStoragePath(cwd)).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd,
              operation: "write",
              detail: "Cannot establish checkout readiness.",
              cause,
            }),
        ),
      );
      const blocker = yield* storagePathBlocker(storageSql.value, canonical).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd,
              operation: "write",
              detail: "Cannot establish checkout readiness.",
              cause,
            }),
        ),
      );
      if (blocker !== null) {
        return yield* new WorkspaceFileSystemError({
          cwd,
          operation: "write",
          detail:
            blocker === "project-relocation"
              ? PROJECT_RELOCATION_PENDING_MESSAGE
              : "Checkout cleanup is pending or complete. Restore it before editing.",
        });
      }
    });
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const toWorkspaceFileSystemError = (
    input: { cwd: string; relativePath: string },
    operation: string,
  ) => {
    return (cause: unknown) =>
      new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
  };

  const resolveRealWorkspaceTargetPath = Effect.fn(
    "WorkspaceFileSystem.resolveRealWorkspaceTargetPath",
  )(function* (input: { cwd: string; relativePath: string }, absolutePath: string) {
    const missingSegments: Array<string> = [];
    let candidatePath = absolutePath;

    while (true) {
      const realCandidatePath = yield* Effect.tryPromise({
        try: () => NodeFs.realpath(candidatePath),
        catch: (cause) =>
          isEnoentError(cause)
            ? new MissingRealPathError()
            : toWorkspaceFileSystemError(input, "workspaceFileSystem.realpath.target")(cause),
      }).pipe(Effect.catchTag("MissingRealPathError", () => Effect.succeed(null)));

      if (realCandidatePath !== null) {
        return missingSegments.length === 0
          ? realCandidatePath
          : path.join(realCandidatePath, ...missingSegments);
      }

      const parentPath = path.dirname(candidatePath);
      if (parentPath === candidatePath) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.realpath.target",
          detail: `Unable to resolve workspace target path: ${absolutePath}`,
        });
      }

      missingSegments.unshift(path.basename(candidatePath));
      candidatePath = parentPath;
    }
  });

  const ensureResolvedPathStaysWithinWorkspace = Effect.fn(
    "WorkspaceFileSystem.ensureResolvedPathStaysWithinWorkspace",
  )(function* (input: { cwd: string; relativePath: string }, absolutePath: string) {
    const normalizedWorkspaceRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(input.cwd)
      .pipe(
        Effect.mapError(toWorkspaceFileSystemError(input, "workspaceFileSystem.workspaceRoot")),
      );
    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFs.realpath(normalizedWorkspaceRoot),
      catch: toWorkspaceFileSystemError(input, "workspaceFileSystem.realpath.root"),
    });
    const realTargetPath = yield* resolveRealWorkspaceTargetPath(input, absolutePath);
    const relativeToRoot = toPosixPath(path.relative(realWorkspaceRoot, realTargetPath));
    if (
      relativeToRoot.length === 0 ||
      relativeToRoot === "." ||
      relativeToRoot.startsWith("../") ||
      relativeToRoot === ".." ||
      path.isAbsolute(relativeToRoot)
    ) {
      return yield* new WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    return { realWorkspaceRoot, realTargetPath };
  });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });

      const { realTargetPath } = yield* ensureResolvedPathStaysWithinWorkspace(
        input,
        target.absolutePath,
      );
      const { bytes } = yield* Effect.tryPromise({
        try: () => readStableFileBytes(realTargetPath, WORKSPACE_PREVIEW_MAX_BYTES),
        catch: toWorkspaceFileSystemError(input, "workspaceFileSystem.readFile"),
      });
      if (isLikelyBinaryPreview(bytes)) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile.binaryCheck",
          detail: "Binary files cannot be previewed.",
        });
      }

      const hasUtf8Bom = bytes.length >= UTF8_BOM.length && bytes.subarray(0, 3).equals(UTF8_BOM);
      const textBytes = hasUtf8Bom ? bytes.subarray(UTF8_BOM.length) : bytes;
      const contents = decodePreviewContents(textBytes);
      if (contents === null) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile.decode",
          detail: "Only UTF-8 text files can be previewed.",
        });
      }

      return {
        relativePath: target.relativePath,
        contents: normalizeLineEndings(contents),
        version: fileVersion(bytes),
        encoding: hasUtf8Bom ? "utf8-bom" : "utf8",
        lineEnding: detectLineEnding(contents),
      };
    },
  );

  const readFileBinary: WorkspaceFileSystemShape["readFileBinary"] = Effect.fn(
    "WorkspaceFileSystem.readFileBinary",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const { realTargetPath } = yield* ensureResolvedPathStaysWithinWorkspace(
      input,
      target.absolutePath,
    );
    const { bytes } = yield* Effect.tryPromise({
      try: () => readStableFileBytes(realTargetPath, PROJECT_READ_FILE_BINARY_MAX_BYTES),
      catch: toWorkspaceFileSystemError(input, "workspaceFileSystem.readFileBinary"),
    });
    const mimeType = detectRasterImageMimeType(bytes);
    if (mimeType === null) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.readFileBinary.magicBytes",
        detail: "Not a supported image.",
      });
    }

    return {
      relativePath: target.relativePath,
      dataBase64: bytes.toString("base64"),
      mimeType,
      sizeBytes: bytes.byteLength,
    };
  });

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const { realTargetPath } = yield* ensureResolvedPathStaysWithinWorkspace(
      input,
      target.absolutePath,
    );
    yield* assertStorageWritable(realTargetPath);
    const guarded = input.expectedVersion !== undefined;
    if (
      guarded &&
      (input.encoding === undefined ||
        input.lineEnding === undefined ||
        input.lineEnding === "mixed")
    ) {
      return yield* new WorkspaceFileUnsupportedEditError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        detail: "Explorer saves require a supported encoding and consistent line endings.",
      });
    }
    const bytes = guarded
      ? encodeWorkspaceText(
          input.contents,
          input.encoding as "utf8" | "utf8-bom",
          input.lineEnding as "lf" | "crlf" | "cr",
        )
      : Buffer.from(input.contents, "utf8");
    if (guarded && bytes.byteLength > WORKSPACE_PREVIEW_MAX_BYTES) {
      return yield* new WorkspaceFileUnsupportedEditError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        detail: "The edited file is too large to save from Explorer.",
      });
    }

    if (guarded) {
      yield* Effect.tryPromise({
        try: () =>
          writeGuardedFileAtomically({
            cwd: input.cwd,
            relativePath: input.relativePath,
            logicalPath: target.absolutePath,
            realTargetPath,
            bytes,
            expectedVersion: input.expectedVersion as string,
          }),
        catch: (cause) => {
          if (
            Schema.is(WorkspaceFileConflictError)(cause) ||
            Schema.is(WorkspaceFileDeletedError)(cause) ||
            Schema.is(WorkspaceFileUnsupportedEditError)(cause)
          ) {
            return cause;
          }
          return toWorkspaceFileSystemError(input, "workspaceFileSystem.writeFile")(cause);
        },
      });
    } else {
      yield* fileSystem
        .makeDirectory(path.dirname(realTargetPath), { recursive: true })
        .pipe(
          Effect.mapError(toWorkspaceFileSystemError(input, "workspaceFileSystem.makeDirectory")),
        );
      yield* fileSystem
        .writeFile(realTargetPath, bytes)
        .pipe(Effect.mapError(toWorkspaceFileSystemError(input, "workspaceFileSystem.writeFile")));
    }
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath, version: fileVersion(bytes) };
  });

  const stageFileReference: WorkspaceFileSystemShape["stageFileReference"] = Effect.fn(
    "WorkspaceFileSystem.stageFileReference",
  )(function* (input) {
    const bytes = decodeBase64File({
      dataBase64: input.dataBase64,
      sizeBytes: input.sizeBytes,
    });
    if (!bytes) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        operation: "workspaceFileSystem.stageFileReference.decode",
        detail: "Staged file payload is invalid.",
      });
    }

    const scopeSegment = sanitizePathSegment(input.scopeId, "draft");
    const { base, extension } = splitSafeFileName(input.name);
    const relativePath = toPosixPath(
      path.join(STAGED_FILE_ROOT, scopeSegment, `${base}-${randomUUID().slice(0, 8)}${extension}`),
    );
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath,
    });

    const { realTargetPath } = yield* ensureResolvedPathStaysWithinWorkspace(
      { cwd: input.cwd, relativePath },
      target.absolutePath,
    );
    yield* assertStorageWritable(realTargetPath);

    yield* fileSystem
      .makeDirectory(path.dirname(realTargetPath), { recursive: true })
      .pipe(
        Effect.mapError(
          toWorkspaceFileSystemError(
            { cwd: input.cwd, relativePath },
            "workspaceFileSystem.stageFileReference.makeDirectory",
          ),
        ),
      );
    yield* fileSystem
      .writeFile(realTargetPath, bytes)
      .pipe(
        Effect.mapError(
          toWorkspaceFileSystemError(
            { cwd: input.cwd, relativePath },
            "workspaceFileSystem.stageFileReference.writeFile",
          ),
        ),
      );
    yield* workspaceEntries.invalidate(input.cwd);

    return { relativePath: target.relativePath, sizeBytes: bytes.byteLength };
  });

  return {
    readFile,
    readFileBinary,
    writeFile: (input) =>
      storageLifecycleLock.withPermit(
        assertStorageWritable(input.cwd).pipe(Effect.andThen(writeFile(input))),
      ),
    stageFileReference: (input) =>
      storageLifecycleLock.withPermit(
        assertStorageWritable(input.cwd).pipe(Effect.andThen(stageFileReference(input))),
      ),
  } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
