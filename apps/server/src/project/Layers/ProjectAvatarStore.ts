import { createHash } from "node:crypto";
import { Effect, FileSystem, Layer, Path } from "effect";
import { loadSharp } from "../../loadSharp.ts";

import {
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

    const filePath = (projectId: string) => path.join(avatarsDir, `${projectId}.png`);

    const write: ProjectAvatarStoreShape["write"] = (input) =>
      Effect.gen(function* () {
        if (!ALLOWED_INPUT_TYPES.has(input.contentType)) {
          return yield* Effect.fail(
            new ProjectAvatarStoreError(`unsupported content type ${input.contentType}`),
          );
        }
        const resized = yield* Effect.promise(async () =>
          (await loadSharp())(input.bytes)
            .rotate()
            .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
            .png({ quality: 90, compressionLevel: 9 })
            .toBuffer(),
        );
        const contentHash = createHash("sha256").update(resized).digest("hex");
        yield* fileSystem
          .writeFile(filePath(input.projectId as unknown as string), resized)
          .pipe(
            Effect.mapError(
              (err) => new ProjectAvatarStoreError(`failed to write avatar: ${err.message}`),
            ),
          );
        return { contentHash };
      });

    const read: ProjectAvatarStoreShape["read"] = (projectId) =>
      Effect.gen(function* () {
        const target = filePath(projectId as unknown as string);
        const exists = yield* fileSystem.exists(target);
        if (!exists) return null;
        const bytes = yield* fileSystem.readFile(target);
        const buffer = Buffer.from(bytes);
        const contentHash = createHash("sha256").update(buffer).digest("hex");
        return { bytes: buffer, contentHash };
      }).pipe(Effect.catch(() => Effect.succeed(null)));

    const remove: ProjectAvatarStoreShape["remove"] = (projectId) =>
      fileSystem
        .remove(filePath(projectId as unknown as string))
        .pipe(Effect.catch(() => Effect.void));

    return { write, read, remove } satisfies ProjectAvatarStoreShape;
  });

export const ProjectAvatarStoreLive = (options: { readonly dataDir: string }) =>
  Layer.effect(ProjectAvatarStore, makeProjectAvatarStore(options));
