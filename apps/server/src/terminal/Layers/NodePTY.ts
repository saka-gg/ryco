import { createRequire } from "node:module";

import { Effect, FileSystem, Layer, Path } from "effect";
import { PtyAdapter } from "../Services/PTY.ts";
import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
} from "../Services/PTY.ts";

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const requireForNodePty = createRequire(import.meta.url);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

export const ensureNodePtySpawnHelperExecutable = Effect.fn(function* (explicitPath?: string) {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform === "win32") return;
  if (!explicitPath && didEnsureSpawnHelperExecutable) return;

  const helperPath = explicitPath ?? (yield* resolveNodePtySpawnHelperPath);
  if (!helperPath) return;
  if (!explicitPath) {
    didEnsureSpawnHelperExecutable = true;
  }

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  // Best-effort: avoid FileSystem.stat in packaged mode where some fs metadata can be missing.
  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

export class NodePtyProcess implements PtyProcess {
  private readonly process: import("node-pty").IPty;
  private readonly platform: NodeJS.Platform;

  constructor(
    process: import("node-pty").IPty,
    platform: NodeJS.Platform = globalThis.process.platform,
  ) {
    this.process = process;
    this.platform = platform;
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }

  /**
   * The tty's foreground process, read with one syscall on macOS, where the alternative is
   * spawning `ps`. Elsewhere callers use the process table: Linux lists a shell's children
   * from procfs without spawning anything (and node-pty reports the shell's own path there
   * whenever the foreground group's leader is gone), and Windows has no foreground group.
   */
  foregroundProcessName(): string | undefined {
    if (this.platform !== "darwin") return undefined;
    try {
      const name = this.process.process;
      return typeof name === "string" && name.length > 0 ? name : undefined;
    } catch {
      return undefined;
    }
  }
}

/** What a node without node-pty's native module needs, for the boot warning. */
const NODE_PTY_UNAVAILABLE_HINT =
  "reinstall ryco-cli where a C/C++ toolchain and Python are available (Debian/Ubuntu: build-essential python3), so node-pty can build its native module";

/**
 * Loads node-pty, or explains why terminals are unavailable. A native module that is missing or
 * does not load (no prebuild for this platform and no toolchain at install time) must not stop the
 * server: it starts, logs why once, and every terminal spawn fails with that reason.
 */
export const loadNodePty = (load: () => Promise<typeof import("node-pty")>) =>
  Effect.tryPromise({
    try: load,
    catch: (cause) =>
      new PtySpawnError({
        adapter: "node-pty",
        message: `Terminals are unavailable on this node: node-pty could not be loaded (${
          // Its first line; node-pty appends the require stack.
          (cause instanceof Error ? cause.message : String(cause)).split("\n")[0]
        }).`,
        cause,
      }),
  }).pipe(
    Effect.map((nodePty) => ({ nodePty, unavailable: null })),
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(error.message, { hint: NODE_PTY_UNAVAILABLE_HINT });
        const unavailable: PtyAdapterShape = { spawn: () => Effect.fail(error) };
        return { nodePty: null, unavailable };
      }),
    ),
  );

export const layer = Layer.effect(
  PtyAdapter,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const { nodePty, unavailable } = yield* loadNodePty(() => import("node-pty"));
    if (nodePty === null) return unavailable;

    const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
      ensureNodePtySpawnHelperExecutable().pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed(() => undefined),
      ),
    );

    return {
      spawn: Effect.fn(function* (input) {
        yield* ensureNodePtySpawnHelperExecutableCached;
        const ptyProcess = yield* Effect.try({
          try: () =>
            nodePty.spawn(input.shell, input.args ?? [], {
              cwd: input.cwd,
              cols: input.cols,
              rows: input.rows,
              env: input.env,
              name: globalThis.process.platform === "win32" ? "xterm-color" : "xterm-256color",
            }),
          catch: (cause) =>
            new PtySpawnError({
              adapter: "node-pty",
              message: cause instanceof Error ? cause.message : "Failed to spawn PTY process",
              cause,
            }),
        });
        return new NodePtyProcess(ptyProcess);
      }),
    } satisfies PtyAdapterShape;
  }),
);
