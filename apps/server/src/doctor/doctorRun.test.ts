import { EventEmitter } from "node:events";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import packageJson from "../../package.json" with { type: "json" };
import { defaultBaseDir } from "../os-jank.ts";
import { doctorRerunCommand, interruptOnHangup } from "./doctorRun.ts";

describe("doctorRun", () => {
  it("tells an npx run to run the same version again, for the same data directory", () => {
    const npx = NodePath.join(NodeOS.homedir(), ".npm", "_npx", "0123abcd", "node_modules", ".bin");
    const installed = NodePath.join(NodePath.sep, "usr", "local", "bin", "ryco");
    const home = { baseDir: defaultBaseDir(), devUrl: undefined };
    // An unpinned `npx ryco-cli` runs the newest release, which may refuse this schema.
    assert.equal(
      doctorRerunCommand(home, NodePath.join(npx, "ryco")),
      `npx ryco-cli@${packageJson.version} doctor --apply`,
    );
    assert.equal(doctorRerunCommand(home, installed), "ryco doctor --apply");
    assert.equal(doctorRerunCommand(home, undefined), "ryco doctor --apply");
    if (process.platform !== "win32") {
      assert.equal(
        doctorRerunCommand({ baseDir: "/srv/ryco node", devUrl: undefined }, installed),
        "ryco doctor --apply --base-dir '/srv/ryco node'",
      );
    }
  });

  it.effect("puts the listeners back once a run without a hangup ends", () =>
    Effect.gen(function* () {
      const signals = new EventEmitter();
      const output = new EventEmitter();
      const value = yield* interruptOnHangup(
        Effect.sync(() => {
          assert.equal(signals.listenerCount("SIGHUP"), 1);
          // A write error meanwhile (a closed pipe) does not end the run.
          output.emit("error", new Error("write EPIPE"));
          return 42;
        }),
        { signals, output: [output] },
      );
      assert.equal(value, 42);
      assert.equal(signals.listenerCount("SIGHUP"), 0);
      assert.equal(output.listenerCount("error"), 0);
    }),
  );
});
