import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { ProjectAvatarStore, ProjectAvatarStoreError } from "../Services/ProjectAvatarStore.ts";
import { ProjectAvatarStoreLive } from "./ProjectAvatarStore.ts";

// 1×1 transparent PNG generated via sharp
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000970485973000003e8000003e801b57b526b0000000d49444154789c636060" +
    "6060000000050001a5f645400000000049454e44ae426082",
  "hex",
);

it.layer(NodeServices.layer)("ProjectAvatarStoreLive", (it) => {
  it.effect("writes, reads, and deletes an avatar by projectId", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-project-avatars-test-",
      });

      const layer = ProjectAvatarStoreLive({ dataDir });
      yield* Effect.gen(function* () {
        const store = yield* ProjectAvatarStore;
        const written = yield* store.write({
          projectId: "proj_test" as unknown as never,
          bytes: PNG_1X1,
          contentType: "image/png",
        });
        expect(written.contentHash).toMatch(/^[0-9a-f]{64}$/);

        const read = yield* store.read("proj_test" as unknown as never);
        expect(read).not.toBeNull();
        expect(read?.contentHash).toBe(written.contentHash);

        yield* store.remove("proj_test" as unknown as never);
        const afterDelete = yield* store.read("proj_test" as unknown as never);
        expect(afterDelete).toBeNull();
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("fails on unsupported content type", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-project-avatars-test-",
      });

      const layer = ProjectAvatarStoreLive({ dataDir });
      yield* Effect.gen(function* () {
        const store = yield* ProjectAvatarStore;
        const result = yield* Effect.result(
          store.write({
            projectId: "proj_test" as unknown as never,
            bytes: PNG_1X1,
            contentType: "image/gif",
          }),
        );
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("fails with its typed error, not a defect, for bytes that do not decode", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-project-avatars-test-",
      });

      const layer = ProjectAvatarStoreLive({ dataDir });
      yield* Effect.gen(function* () {
        const store = yield* ProjectAvatarStore;
        // The PNG signature over garbage: the content type passes, sharp rejects the bytes.
        const corrupt = Buffer.concat([PNG_1X1.subarray(0, 8), Buffer.from("not an image")]);
        const result = yield* Effect.result(
          store.write({
            projectId: "proj_test" as unknown as never,
            bytes: corrupt,
            contentType: "image/png",
          }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(ProjectAvatarStoreError);
          expect(result.failure.message).toContain("could not be processed");
        }
        expect(yield* store.read("proj_test" as unknown as never)).toBeNull();
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("refuses project ids that are not a plain file name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-project-avatars-test-",
      });

      const layer = ProjectAvatarStoreLive({ dataDir });
      yield* Effect.gen(function* () {
        const store = yield* ProjectAvatarStore;
        const escaping = "../../outside" as unknown as never;
        const result = yield* Effect.result(
          store.write({ projectId: escaping, bytes: PNG_1X1, contentType: "image/png" }),
        );
        expect(result._tag).toBe("Failure");
        expect(yield* fileSystem.exists(`${dataDir}/outside.png`)).toBe(false);
        expect(yield* store.read(escaping)).toBeNull();
        yield* store.remove(escaping);
      }).pipe(Effect.provide(layer));
    }),
  );
});
