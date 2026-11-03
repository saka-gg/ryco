import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import { AgentControlNodeDirectory } from "../Services/AgentControlNodeDirectory.ts";
import {
  type AgentControlNodeDirectoryModule,
  makeAgentControlNodeDirectoryDeferred,
} from "./AgentControlNodeDirectoryDeferred.ts";

const THIS_NODE = EnvironmentId.make("node-self");

const node = (id: string) => ({
  environmentId: EnvironmentId.make(id),
  label: `Node ${id}`,
  platformOs: "linux" as const,
  online: true,
  projectCopySupport: "yes" as const,
});

/** Runs `use` with the deferred directory built on a temp state dir and the given loader. */
const withDeferred = <A, E>(
  load: () => Promise<AgentControlNodeDirectoryModule>,
  use: Effect.Effect<A, E, AgentControlNodeDirectory>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-node-directory-deferred-" });
    const layer = Layer.effect(
      AgentControlNodeDirectory,
      makeAgentControlNodeDirectoryDeferred(load),
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), baseDir),
          Layer.succeed(
            ServerEnvironment,
            ServerEnvironment.of({
              getEnvironmentId: Effect.succeed(THIS_NODE),
              getDescriptor: Effect.die("unused"),
            }),
          ),
        ),
      ),
    );
    return yield* use.pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

const realModule = () => import("./AgentControlNodeDirectoryLive.ts");

it.layer(NodeServices.layer)("AgentControlNodeDirectoryDeferred", (it) => {
  it.effect("loads the store once, with the first call, for every concurrent caller", () => {
    let loads = 0;
    const load = () => {
      loads += 1;
      return realModule();
    };
    return withDeferred(
      load,
      Effect.gen(function* () {
        assert.strictEqual(loads, 0);
        const directory = yield* AgentControlNodeDirectory;
        yield* Effect.all(
          [
            directory.publish({ publisherKey: "a", nodes: [node("a")] }),
            directory.publish({ publisherKey: "b", nodes: [node("b")] }),
            directory.list(),
          ],
          { concurrency: "unbounded" },
        );
        const listed = yield* directory.list();
        assert.deepStrictEqual(listed.nodes.map((entry) => entry.environmentId).toSorted(), [
          "a",
          "b",
        ]);
        assert.strictEqual(loads, 1);
      }),
    );
  });

  it.effect("fails a call whose load failed and loads again on the next one", () => {
    let loads = 0;
    const load = () => {
      loads += 1;
      return loads === 1 ? Promise.reject(new Error("chunk missing")) : realModule();
    };
    return withDeferred(
      load,
      Effect.gen(function* () {
        const directory = yield* AgentControlNodeDirectory;
        const failure = yield* Effect.flip(directory.list());
        assert.strictEqual(failure._tag, "AgentControlNodeDirectoryError");
        assert.strictEqual(failure.reason, "unavailable");
        const accepted = yield* directory.publish({ publisherKey: "a", nodes: [node("a")] });
        assert.deepStrictEqual(accepted, { accepted: 1 });
        assert.strictEqual(loads, 2);
      }),
    );
  });
});
