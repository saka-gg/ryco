import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { makeNodeAutoSkipList, NODE_AUTO_SKIP_MAX_VERSIONS } from "./nodeAutoSkip.ts";

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "node-auto-skip-" });
  const filePath = path.join(dir, "node-update", "auto-skip.json");
  return { fileSystem, filePath, list: makeNodeAutoSkipList({ filePath, fileSystem, path }) };
});

describe("nodeAutoSkip", () => {
  it.live("records releases across restarts, and takes one off again", () =>
    Effect.gen(function* () {
      const { fileSystem, filePath, list } = yield* setup;
      expect(yield* list.has("0.1.36")).toBe(false);
      yield* list.add("0.1.36");
      yield* list.add("0.1.36");
      yield* list.add("0.1.37");
      expect(yield* fileSystem.readFileString(filePath)).toBe('{"versions":["0.1.36","0.1.37"]}\n');
      // What the next process reads.
      const reopened = makeNodeAutoSkipList({
        filePath,
        fileSystem,
        path: yield* Path.Path,
      });
      expect(yield* reopened.has("0.1.36")).toBe(true);
      yield* reopened.remove("0.1.36");
      expect(yield* list.has("0.1.36")).toBe(false);
      expect(yield* list.has("0.1.37")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the newest releases only", () =>
    Effect.gen(function* () {
      const { list } = yield* setup;
      for (let index = 0; index <= NODE_AUTO_SKIP_MAX_VERSIONS; index += 1) {
        yield* list.add(`0.2.${index}`);
      }
      expect(yield* list.has("0.2.0")).toBe(false);
      expect(yield* list.has(`0.2.${NODE_AUTO_SKIP_MAX_VERSIONS}`)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("skips everything while the file cannot be read, and starts over when damaged", () =>
    Effect.gen(function* () {
      const { fileSystem, filePath, list } = yield* setup;
      // A folder where the file belongs: it exists but cannot be read as a file.
      yield* fileSystem.makeDirectory(filePath, { recursive: true });
      expect(yield* list.has("0.1.36")).toBe(true);
      const refused = yield* Effect.flip(list.add("0.1.36"));
      expect(refused._tag).toBe("NodeAutoSkipError");
      yield* fileSystem.remove(filePath, { recursive: true });

      yield* fileSystem.writeFileString(filePath, "{not json");
      expect(yield* list.has("0.1.36")).toBe(false);
      yield* list.add("0.1.36");
      expect(yield* list.has("0.1.36")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
