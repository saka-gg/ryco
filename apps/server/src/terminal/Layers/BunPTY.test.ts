import { constants as osConstants } from "node:os";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PtyAdapter, type PtySpawnInput } from "../Services/PTY.ts";
import { layer } from "./BunPTY.ts";

const input: PtySpawnInput = {
  shell: "/bin/zsh",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  env: {},
};

const spawnWith = <A, E>(use: (adapter: typeof PtyAdapter.Service) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* PtyAdapter;
      return yield* use(adapter);
    }).pipe(Effect.provide(layer)),
  );

afterEach(() => vi.unstubAllGlobals());

// The layer refuses to build on Windows.
describe.skipIf(process.platform === "win32")("BunPTY", () => {
  it("turns a spawn Bun rejects into a typed PtySpawnError", async () => {
    vi.stubGlobal("Bun", {
      spawn: () => {
        throw new Error("ENOENT: no such file or directory, posix_spawn '/missing/zsh'");
      },
    });
    const error = await spawnWith((adapter) => Effect.flip(adapter.spawn(input)));
    expect(error._tag).toBe("PtySpawnError");
    expect(error.adapter).toBe("bun-pty");
    expect(error.message).toContain("ENOENT");
  });

  it("reports the signal that ended the process as its number", async () => {
    let finish!: (code: number) => void;
    const subprocess = {
      pid: 42,
      exited: new Promise<number>((resolve) => {
        finish = resolve;
      }),
      signalCode: "SIGTERM",
      terminal: undefined,
      kill: () => {},
    };
    vi.stubGlobal("Bun", { spawn: () => subprocess });
    const listener = vi.fn();
    await spawnWith((adapter) =>
      Effect.map(adapter.spawn(input), (spawned) => spawned.onExit(listener)),
    );
    finish(143);
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith({ exitCode: 143, signal: osConstants.signals.SIGTERM }),
    );
  });
});
