import { createHash } from "node:crypto";
import { Effect, FileSystem, Layer, Path } from "effect";
import { loadSharp } from "../../loadSharp.ts";

import {
  PROJECT_AVATAR_ID_PATTERN,
  ProjectAvatarStore,
  ProjectAvatarStoreError,
  type ProjectAvatarStoreShape,
} from "../Services/ProjectAvatarStore.ts";

const ALLOWED_INPUT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_DIMENSION = 256;

export const makeProjectAvatarStore = (options: { readonly dataDir: string }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const avatarsDir = path.join(options.dataDir, "project-avatars");
    yield* fileSystem.makeDirectory(avatarsDir, { recursive: true });

    // The id names the file: one outside the pattern could name a path outside the directory.
    const filePath = (projectId: string): string | null =>
      PROJECT_AVATAR_ID_PATTERN.test(projectId) ? path.join(avatarsDir, `${projectId}.png`) : null;

    const write: ProjectAvatarStoreShape["write"] = (input) =>
      Effect.gen(function* () {
        const target = filePath(input.projectId);
        if (target === null) {
          return yield* Effect.fail(new ProjectAvatarStoreError("invalid project id"));
        }
        if (!ALLOWED_INPUT_TYPES.has(input.contentType)) {
          return yield* Effect.fail(
            new ProjectAvatarStoreError(`unsupported content type ${input.contentType}`),
          );
        }
        // Bytes that do not decode (a valid magic header over garbage) and a sharp that cannot
        // load are the caller's typed error, never a defect.
        const resized = yield* Effect.tryPromise({
          try: async () =>
            (await loadSharp())(input.bytes)
              .rotate()
              .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
              .png({ quality: 90, compressionLevel: 9 })
              .toBuffer(),
          catch: (cause) =>
            new ProjectAvatarStoreError(
              `the image could not be processed: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
        });
        const contentHash = createHash("sha256").update(resized).digest("hex");
        yield* fileSystem
          .writeFile(target, resized)
          .pipe(
            Effect.mapError(
              (err) => new ProjectAvatarStoreError(`failed to write avatar: ${err.message}`),
            ),
          );
        return { contentHash };
      });

    const read: ProjectAvatarStoreShape["read"] = (projectId) =>
      Effect.gen(function* () {
        const target = filePath(projectId);
        if (target === null) return null;
        const exists = yield* fileSystem.exists(target);
        if (!exists) return null;
        const bytes = yield* fileSystem.readFile(target);
        const buffer = Buffer.from(bytes);
        const contentHash = createHash("sha256").update(buffer).digest("hex");
        return { bytes: buffer, contentHash };
      }).pipe(Effect.catch(() => Effect.succeed(null)));

    const remove: ProjectAvatarStoreShape["remove"] = (projectId) => {
      const target = filePath(projectId);
      return target === null
        ? Effect.void
        : fileSystem.remove(target).pipe(Effect.catch(() => Effect.void));
    };

    return { write, read, remove } satisfies ProjectAvatarStoreShape;
  });

export const ProjectAvatarStoreLive = (options: { readonly dataDir: string }) =>
  Layer.effect(ProjectAvatarStore, makeProjectAvatarStore(options));
