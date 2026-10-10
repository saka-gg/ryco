import { WorkspaceAccessPolicyLayer } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { ServerConfig } from "../config.ts";
import * as Driver from "./GitVcsDriver.ts";
import { readGitImageBlob } from "./GitImageBlob.ts";
import { configureTestGitCommitIdentity } from "./testing/GitTestRepo.ts";

const layer = Driver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "image-blob-test-" })),
  Layer.provideMerge(WorkspaceAccessPolicyLayer(undefined)),
  Layer.provideMerge(NodeServices.layer),
);

// PNG signature followed by bytes that are invalid UTF-8, so any text decoding corrupts them.
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a, 0x0d,
]);

describe("image blob", () => {
  it.effect("returns exact bytes for stored image blobs and refuses everything else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-image-blob-" });
      const driver = yield* Driver.GitVcsDriver;
      const git = (args: readonly string[]) => driver.execute({ operation: "test", cwd, args });
      yield* git(["init", "-b", "main"]);
      yield* configureTestGitCommitIdentity(cwd, (_, args) => git(args));
      yield* fs.writeFile(`${cwd}/shot.png`, PNG_BYTES);
      yield* fs.writeFileString(`${cwd}/fake.png`, "not an image\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "Images"]);
      const blob = (yield* git(["rev-parse", "HEAD:shot.png"])).stdout.trim();
      const read = (oid: string) => readGitImageBlob(driver.execute, { cwd, oid });

      const expected = {
        kind: "image",
        dataBase64: Buffer.from(PNG_BYTES).toString("base64"),
        mimeType: "image/png",
        sizeBytes: PNG_BYTES.byteLength,
      };
      expect(yield* read(blob)).toEqual(expected);
      expect(yield* read(blob.slice(0, 7))).toEqual(expected);

      const text = (yield* git(["rev-parse", "HEAD:fake.png"])).stdout.trim();
      expect((yield* read(text)).kind).toBe("unavailable");
      const commit = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
      expect((yield* read(commit)).kind).toBe("unavailable");
      // A working-tree change is hashed by `git diff` but never stored.
      yield* fs.writeFile(`${cwd}/shot.png`, PNG_BYTES.toReversed());
      const unstored = (yield* git(["hash-object", "shot.png"])).stdout.trim();
      expect((yield* read(unstored)).kind).toBe("unavailable");
      expect((yield* read("0".repeat(40))).kind).toBe("unavailable");

      for (const oid of ["HEAD", "-h", "abc", `${blob}:x`]) yield* read(oid).pipe(Effect.flip);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
