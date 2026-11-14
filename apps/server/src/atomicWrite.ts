import { Effect, FileSystem, Path } from "effect";

/**
 * Writes through a temp file in the target directory and renames it into place, so a reader
 * sees the old contents or the new ones, never a half-written file.
 *
 * - `mode`: the file's permission bits, set exactly (the umask cannot narrow them) before the
 *   rename, so the file never appears under its name with other permissions.
 * - `durable`: flushes the temp file before the rename (a failure fails the write) and the
 *   directory after it (best effort: the rename is already done), so the new contents survive a
 *   crash or power loss once this returns. Off by default: most callers
 *   write caches and preferences where losing the last write is acceptable.
 *
 * `fsDurability.ts` has the promise-based twin (`replaceFileAtomically`) for code outside
 * Effect.
 */
export const writeFileAtomically = (input: {
  readonly filePath: string;
  readonly contents: string | Uint8Array;
  readonly mode?: number;
  readonly durable?: boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempFileId = yield* Effect.sync(() => crypto.randomUUID());
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, `${tempFileId}.tmp`);

      const options = input.mode === undefined ? undefined : { mode: input.mode };
      yield* typeof input.contents === "string"
        ? fs.writeFileString(tempPath, input.contents, options)
        : fs.writeFile(tempPath, input.contents, options);
      if (input.mode !== undefined) yield* fs.chmod(tempPath, input.mode);
      if (input.durable === true) {
        // Writable on purpose: Windows refuses to flush a read-only handle.
        yield* Effect.scoped(
          Effect.flatMap(fs.open(tempPath, { flag: "r+" }), (file) => file.sync),
        );
      }
      yield* fs.rename(tempPath, input.filePath);
      if (input.durable === true && process.platform !== "win32") {
        // Windows cannot open a directory for this and flushes directory entries itself. Best
        // effort, like the boot guard's marker write: the rename is done, so the new contents are
        // in place; some file systems (network and FUSE mounts) refuse fsync on a directory.
        yield* Effect.scoped(
          Effect.flatMap(fs.open(targetDirectory, { flag: "r" }), (directory) => directory.sync),
        ).pipe(Effect.ignore);
      }
    }),
  );

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  readonly mode?: number;
  readonly durable?: boolean;
}) => writeFileAtomically(input);
