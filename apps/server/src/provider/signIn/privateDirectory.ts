/**
 * Directories a sign-in creates on the node: its working directory, and a provider home that does
 * not exist yet on a fresh node.
 *
 * @module privateDirectory
 */
import { Effect, FileSystem } from "effect";

/** Creates a missing directory for this node's user only (0700); an existing one is left as it is. */
export const ensurePrivateDirectory = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (yield* fileSystem.exists(path)) return;
    yield* fileSystem.makeDirectory(path, { recursive: true, mode: 0o700 });
  });
