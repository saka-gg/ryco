import { FileSystem, Path, Effect } from "effect";
import { assert, it } from "@effect/vitest";

import { NodePtyProcess, ensureNodePtySpawnHelperExecutable, loadNodePty } from "./NodePTY.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const fakePty = (readProcess: () => unknown, kill?: (signal?: string) => void) =>
  ({
    pid: 4242,
    kill,
    get process() {
      return readProcess();
    },
  }) as unknown as import("node-pty").IPty;

it("names the foreground process the wrapped pty reports on macOS", () => {
  assert.equal(
    new NodePtyProcess(
      fakePty(() => "vim"),
      "darwin",
    ).foregroundProcessName(),
    "vim",
  );
});

it("cannot name the foreground process when the pty throws or reports nothing", () => {
  const throwing = fakePty(() => {
    throw new Error("pty is gone");
  });
  assert.isUndefined(new NodePtyProcess(throwing, "darwin").foregroundProcessName());
  assert.isUndefined(
    new NodePtyProcess(
      fakePty(() => ""),
      "darwin",
    ).foregroundProcessName(),
  );
  assert.isUndefined(
    new NodePtyProcess(
      fakePty(() => undefined),
      "darwin",
    ).foregroundProcessName(),
  );
});

it("leaves Linux and Windows to the process table", () => {
  for (const platform of ["linux", "win32"] as const) {
    assert.isUndefined(
      new NodePtyProcess(
        fakePty(() => "zsh"),
        platform,
      ).foregroundProcessName(),
    );
  }
});

// node-pty 1.1.0's WindowsTerminal.kill: `if (signal) throw new Error('Signals not supported
// on windows.')`, and otherwise ends the conpty agent and its console tree.
const fakeKillablePty = (platform: NodeJS.Platform) => {
  const kills: Array<string | undefined> = [];
  const pty = fakePty(
    () => undefined,
    (signal) => {
      if (platform === "win32" && signal) throw new Error("Signals not supported on windows.");
      kills.push(signal);
    },
  );
  return { pty, kills };
};

it("kills a Windows pty without a signal, once, through the SIGTERM and SIGKILL steps", () => {
  const { pty, kills } = fakeKillablePty("win32");
  const terminal = new NodePtyProcess(pty, "win32");
  terminal.kill("SIGTERM");
  terminal.kill("SIGKILL");
  assert.deepEqual(kills, [undefined]);
});

it("passes the signal through to node-pty outside Windows", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const { pty, kills } = fakeKillablePty(platform);
    const terminal = new NodePtyProcess(pty, platform);
    terminal.kill("SIGTERM");
    terminal.kill("SIGKILL");
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  }
});

it.layer(NodeServices.layer)("ensureNodePtySpawnHelperExecutable", (it) => {
  it.effect("adds executable bits when helper exists but is not executable", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
      const helperPath = path.join(dir, "spawn-helper");
      yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(helperPath, 0o644);

      yield* ensureNodePtySpawnHelperExecutable(helperPath);

      const mode = (yield* fs.stat(helperPath)).mode & 0o777;
      assert.equal(mode & 0o111, 0o111);
    }),
  );

  it.effect("keeps executable helper as executable", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
      const helperPath = path.join(dir, "spawn-helper");
      yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(helperPath, 0o755);

      yield* ensureNodePtySpawnHelperExecutable(helperPath);

      const mode = (yield* fs.stat(helperPath)).mode & 0o777;
      assert.equal(mode & 0o111, 0o111);
    }),
  );
});

it.effect("leaves terminals unavailable, with the reason, when node-pty cannot load", () =>
  Effect.gen(function* () {
    const loaded = yield* loadNodePty(() =>
      Promise.reject(
        new Error("Failed to load native module: pty.node\nRequire stack:\n- lib/utils.js"),
      ),
    );
    assert.isNull(loaded.nodePty);
    const error = yield* Effect.flip(
      loaded.unavailable!.spawn({ shell: "/bin/sh", cwd: "/", cols: 80, rows: 24, env: {} }),
    );
    assert.equal(error._tag, "PtySpawnError");
    assert.include(error.message, "Terminals are unavailable");
    assert.include(error.message, "(Failed to load native module: pty.node).");
  }),
);
