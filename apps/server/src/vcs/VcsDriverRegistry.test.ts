import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, it, describe } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";

import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const DETECT_COMMAND = "rev-parse --is-inside-work-tree --show-toplevel --git-common-dir";

const makeLayer = (
  run: (input: VcsProcess.VcsProcessInput) => Effect.Effect<VcsProcess.VcsProcessOutput>,
) =>
  Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make()).pipe(
    Layer.provide(
      Layer.mock(VcsProjectConfig.VcsProjectConfig)({
        resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
      }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run })),
  );

describe("VcsDriverRegistry", () => {
  it.effect("routes directly by VCS driver kind for non-repository workflows", () => {
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make()).pipe(
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: () => Effect.succeed(processOutput("")),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const driver = yield* registry.get("git");

      assert.strictEqual(driver.capabilities.kind, "git");
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches repository detection for repeated resolves in the same cwd and kind", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make()).pipe(
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              calls.push(input);
              const command = input.args.join(" ");
              if (command === DETECT_COMMAND) {
                return processOutput("true\n/repo\n/repo/.git\n");
              }
              return processOutput("");
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const first = yield* registry.resolve({ cwd: "/repo", requestedKind: "git" });
      const second = yield* registry.resolve({ cwd: "/repo", requestedKind: "git" });

      assert.equal(first.repository.rootPath, "/repo");
      assert.equal(second.repository.rootPath, "/repo");
      assert.deepStrictEqual(
        calls.map((call) => call.args.join(" ")),
        [DETECT_COMMAND],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats a failed or bare detection as no repository", () => {
    const layer = makeLayer(() =>
      Effect.succeed({
        ...processOutput(""),
        exitCode: ChildProcessSpawner.ExitCode(128),
        stderr: "fatal: not a git repository",
      }),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      assert.strictEqual(yield* registry.detect({ cwd: "/not-a-repo" }), null);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a detected checkout until its .git identity changes", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ryco-vcs-registry-"));
    mkdirSync(path.join(root, ".git"));
    mkdirSync(path.join(root, "nested"));
    let detections = 0;
    const layer = makeLayer((input) =>
      Effect.sync(() => {
        if (input.args.join(" ") !== DETECT_COMMAND) return processOutput("");
        detections += 1;
        const toplevel = input.cwd.endsWith("nested") && detections > 3 ? input.cwd : root;
        return processOutput(`true\n${toplevel}\n${toplevel}/.git\n`);
      }),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      yield* registry.detect({ cwd: root });
      yield* registry.detect({ cwd: root });
      assert.strictEqual(detections, 1);

      // A re-initialized checkout gets a new `.git`, so the cached answer is dropped.
      // (The old one stays until the new one exists, so its inode cannot be reused.)
      renameSync(path.join(root, ".git"), path.join(root, ".git-old"));
      mkdirSync(path.join(root, ".git"));
      rmSync(path.join(root, ".git-old"), { recursive: true });
      yield* registry.detect({ cwd: root });
      assert.strictEqual(detections, 2);

      const nested = path.join(root, "nested");
      const outer = yield* registry.detect({ cwd: nested });
      assert.strictEqual(outer?.repository.rootPath, root);
      assert.strictEqual(detections, 3);

      // `git init` below the root makes the folder its own repository.
      mkdirSync(path.join(nested, ".git"));
      const inner = yield* registry.detect({ cwd: nested });
      assert.strictEqual(inner?.repository.rootPath, nested);
      assert.strictEqual(detections, 4);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("keeps the answer for a folder whose own .git Git skips as invalid", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ryco-vcs-registry-"));
    mkdirSync(path.join(root, ".git"));
    // An empty `.git` directory is not a repository; discovery moves on to the root.
    mkdirSync(path.join(root, "nested", ".git"), { recursive: true });
    let detections = 0;
    const layer = makeLayer((input) =>
      Effect.sync(() => {
        if (input.args.join(" ") !== DETECT_COMMAND) return processOutput("");
        detections += 1;
        return processOutput(`true\n${root}\n${root}/.git\n`);
      }),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const nested = path.join(root, "nested");
      for (let read = 0; read < 3; read += 1) {
        const handle = yield* registry.detect({ cwd: nested });
        assert.strictEqual(handle?.repository.rootPath, root);
      }
      assert.strictEqual(detections, 1);

      // Replacing it (now a real `git init`, say) is a change and detects again.
      renameSync(path.join(nested, ".git"), path.join(nested, ".git-old"));
      mkdirSync(path.join(nested, ".git"));
      rmSync(path.join(nested, ".git-old"), { recursive: true });
      yield* registry.detect({ cwd: nested });
      assert.strictEqual(detections, 2);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });
});
