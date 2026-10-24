import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../config.ts";
import { stallingChildSpawner } from "../testing/eventLoopStall.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";

const TestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ryco-git-vcs-driver-stall-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.live("a server stall does not time out a git command that exited during it", () => {
  // git exits 250 ms in, while the loop is blocked for 600 ms; its exit is read
  // only after the stall, past the 300 ms budget's plain timer.
  const { kills, spawner } = stallingChildSpawner({ exitAfterMs: 250, stallMs: 600 });
  return Effect.gen(function* () {
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const result = yield* driver.execute({
      operation: "GitVcsDriverCore.stall.test",
      cwd: process.cwd(),
      args: ["status"],
      timeoutMs: 300,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "out");
    assert.equal(kills.count, 0);
  }).pipe(Effect.provide(TestLayer));
});
