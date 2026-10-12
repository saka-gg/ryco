import { Effect, FileSystem, Path } from "effect";

/** Writes through a temp file in the target directory and renames it into place. */
export const writeFileAtomically = (input: {
  readonly filePath: string;
  readonly contents: string | Uint8Array;
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

      yield* typeof input.contents === "string"
        ? fs.writeFileString(tempPath, input.contents)
        : fs.writeFile(tempPath, input.contents);
      yield* fs.rename(tempPath, input.filePath);
    }),
  );

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) => writeFileAtomically(input);
