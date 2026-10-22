import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem } from "effect";

import type { ProjectCopyChildProcess } from "../Services/ProjectCopyProcess.ts";
import type { ProjectSetupCommandInput } from "../Services/ProjectSetupCommand.ts";
import {
  makeProjectSetupCommand,
  PROJECT_SETUP_OUTPUT_TAIL_LINES,
  PROJECT_SETUP_OUTPUT_TAIL_MAX_BYTES,
  type ProjectSetupCommandOptions,
} from "./ProjectSetupCommandLive.ts";

const isWindows = process.platform === "win32";

/** A project folder, and an environment whose login shell reads no profile of the user's. */
const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-setup-command-" });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root };
  return { root, env };
});

const runSetup = (
  input: Omit<ProjectSetupCommandInput, "projectRoot"> & { readonly projectRoot: string },
  options: ProjectSetupCommandOptions,
) =>
  Effect.gen(function* () {
    const setup = yield* makeProjectSetupCommand({ shellResolver: () => "/bin/sh", ...options });
    return yield* setup.run(input);
  });

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls until `check` holds, failing the test after `timeoutMs`. */
const waitUntil = (label: string, check: () => boolean, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`Timed out waiting: ${label}`));
      yield* Effect.sleep("20 millis");
    }
  });

const readPid = (file: string): number => Number(NodeFs.readFileSync(file, "utf8").trim());

it.layer(NodeServices.layer, { excludeTestServices: true })("ProjectSetupCommandLive", (it) => {
  it.effect.skipIf(isWindows)("reports the command's exit code", () =>
    Effect.gen(function* () {
      const { root, env } = yield* makeFixture;
      const succeeded = yield* runSetup({ command: "echo ready", projectRoot: root }, { env });
      assert.deepEqual(succeeded, { outcome: "succeeded", exitCode: 0, outputTail: "ready" });

      const failed = yield* runSetup(
        { command: "echo 'installing' && echo 'no such tool' >&2 && exit 7", projectRoot: root },
        { env },
      );
      assert.deepEqual(failed, {
        outcome: "failed",
        exitCode: 7,
        outputTail: "installing\nno such tool",
      });

      const signalled = yield* runSetup({ command: "kill -KILL $$", projectRoot: root }, { env });
      assert.equal(signalled.outcome, "failed");
      assert.equal(signalled.exitCode, null);
    }),
  );

  it.effect.skipIf(isWindows)("runs in the project root with the project script variables", () =>
    Effect.gen(function* () {
      const { root, env } = yield* makeFixture;
      const result = yield* runSetup(
        {
          command:
            'pwd -P; echo "$RYCO_PROJECT_ROOT"; echo "$RYCO_WORKTREE_PATH"; read -r line; echo "stdin:$?"',
          projectRoot: root,
        },
        { env },
      );
      const realRoot = NodeFs.realpathSync(root);
      assert.equal(result.outcome, "succeeded");
      // stdin is closed: `read` sees end of input at once instead of waiting.
      assert.equal(result.outputTail, [realRoot, root, root, "stdin:1"].join("\n"));
    }),
  );

  it.effect.skipIf(isWindows)("keeps the server's own variables away from the command", () =>
    Effect.gen(function* () {
      const { root, env } = yield* makeFixture;
      const planted: NodeJS.ProcessEnv = {
        ...env,
        RYCO_AGENT_CONTROL_TOKEN: "agent-control-secret",
        RYCO_PORT: "3773",
        ryco_home: "/state",
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        PORT: "3000",
        ELECTRON_RUN_AS_NODE: "1",
        RYCO_SETUP_TEST_KEEP: undefined,
        SETUP_TEST_KEEP: "kept",
      };
      const result = yield* runSetup(
        {
          command: [
            'env | grep -i -E "^(ryco_|vite_|port=|electron_run_as_node=)" | grep -v -E "^RYCO_(PROJECT_ROOT|WORKTREE_PATH)=" || echo none',
            'echo "token:${RYCO_AGENT_CONTROL_TOKEN-unset} keep:${SETUP_TEST_KEEP-unset}"',
          ].join("; "),
          projectRoot: root,
        },
        { env: planted },
      );
      assert.equal(result.outcome, "succeeded");
      assert.equal(result.outputTail, "none\ntoken:unset keep:kept");
    }),
  );

  it.effect.skipIf(isWindows)("ends a command that runs past its timeout", () =>
    Effect.gen(function* () {
      const { root, env } = yield* makeFixture;
      const startedAt = Date.now();
      const result = yield* runSetup(
        { command: "echo started; sleep 30", projectRoot: root, timeoutMs: 300 },
        { env },
      );
      assert.deepEqual(result, { outcome: "timed-out", exitCode: null, outputTail: "started" });
      assert.isBelow(Date.now() - startedAt, 5_000);
    }),
  );

  it.effect.skipIf(isWindows)("bounds the output tail by lines and by bytes", () =>
    Effect.gen(function* () {
      const { root, env } = yield* makeFixture;
      const lines = yield* runSetup(
        {
          command: 'i=1; while [ $i -le 500 ]; do echo "line $i"; i=$((i+1)); done',
          projectRoot: root,
        },
        { env },
      );
      const tailLines = lines.outputTail.split("\n");
      assert.equal(tailLines.length, PROJECT_SETUP_OUTPUT_TAIL_LINES);
      assert.equal(tailLines[0], `line ${500 - PROJECT_SETUP_OUTPUT_TAIL_LINES + 1}`);
      assert.equal(tailLines.at(-1), "line 500");

      // 200 two-byte characters a line: the line limit alone would keep about 16 KiB.
      const wide = "é".repeat(200);
      const bytes = yield* runSetup(
        {
          command: `i=1; while [ $i -le 60 ]; do echo "$i ${wide}"; i=$((i+1)); done`,
          projectRoot: root,
        },
        { env },
      );
      assert.isAtMost(
        Buffer.byteLength(bytes.outputTail, "utf8"),
        PROJECT_SETUP_OUTPUT_TAIL_MAX_BYTES,
      );
      const kept = bytes.outputTail.split("\n");
      assert.isBelow(kept.length, PROJECT_SETUP_OUTPUT_TAIL_LINES);
      assert.equal(kept.at(-1), `60 ${wide}`);
    }),
  );

  it.effect.skipIf(isWindows)("reports its child and streams its output to the observer", () =>
    Effect.gen(function* () {
      const { root, env } = yield* makeFixture;
      const children: Array<ProjectCopyChildProcess | null> = [];
      const chunks: Array<string> = [];
      const result = yield* runSetup(
        {
          command: "echo one; echo two >&2",
          projectRoot: root,
          observer: {
            onChild: (child) => Effect.sync(() => children.push(child)),
            onOutput: (chunk) => Effect.sync(() => chunks.push(chunk)),
          },
        },
        { env },
      );
      assert.equal(result.outcome, "succeeded");
      assert.equal(children.length, 2);
      const child = children[0]!;
      assert.isAbove(child.pid, 0);
      assert.equal(child.pgid, child.pid);
      assert.isFalse(Number.isNaN(Date.parse(child.startedAt)));
      assert.isNull(children[1]);
      const output = chunks.join("");
      assert.include(output, "one\n");
      assert.include(output, "two\n");
    }),
  );

  it.effect.skipIf(isWindows)("ends the whole process group when it is interrupted", () =>
    Effect.gen(function* () {
      const { root, env } = yield* makeFixture;
      const pidFile = NodePath.join(root, "grandchild.pid");
      const children: Array<ProjectCopyChildProcess | null> = [];
      const fiber = yield* runSetup(
        {
          command: `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`,
          projectRoot: root,
          observer: { onChild: (child) => Effect.sync(() => children.push(child)) },
        },
        { env },
      ).pipe(Effect.forkChild);
      yield* waitUntil(
        "the grandchild's pid",
        () => NodeFs.existsSync(pidFile) && readPid(pidFile) > 0,
      );
      const grandchild = readPid(pidFile);
      const shell = children[0]!.pid;
      assert.isTrue(isAlive(grandchild));

      yield* Fiber.interrupt(fiber);
      // The interrupt returned once the group was gone; the reaper may lag a little.
      yield* waitUntil("the grandchild to end", () => !isAlive(grandchild), 2_000);
      assert.isFalse(isAlive(shell));
      assert.deepEqual(children.at(-1), null);
    }),
  );

  it.effect.skipIf(isWindows)("kills a group that ignores SIGTERM after the grace", () =>
    Effect.gen(function* () {
      const { root, env } = yield* makeFixture;
      const pidFile = NodePath.join(root, "stubborn.pid");
      const fiber = yield* runSetup(
        {
          command: `sh -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 60' & wait`,
          projectRoot: root,
        },
        { env, forceKillAfterMs: 300 },
      ).pipe(Effect.forkChild);
      yield* waitUntil(
        "the stubborn pid",
        () => NodeFs.existsSync(pidFile) && readPid(pidFile) > 0,
      );
      const stubborn = readPid(pidFile);

      const startedAt = Date.now();
      yield* Fiber.interrupt(fiber);
      assert.isAtLeast(Date.now() - startedAt, 250);
      yield* waitUntil("the stubborn process to end", () => !isAlive(stubborn), 2_000);
    }),
  );

  it.effect.skipIf(isWindows)("ends background processes the command leaves behind", () =>
    Effect.gen(function* () {
      const { root, env } = yield* makeFixture;
      const pidFile = NodePath.join(root, "leftover.pid");
      // The leftover keeps the output pipes open: the run does not wait for it.
      const result = yield* runSetup(
        { command: `sleep 60 & echo $! > ${pidFile}; echo done`, projectRoot: root },
        { env },
      );
      assert.deepEqual(result, { outcome: "succeeded", exitCode: 0, outputTail: "done" });
      yield* waitUntil("the leftover to end", () => !isAlive(readPid(pidFile)), 2_000);
    }),
  );

  it.effect.skipIf(isWindows)("falls back to another shell when the resolved one is missing", () =>
    Effect.gen(function* () {
      const { root, env } = yield* makeFixture;
      const result = yield* runSetup(
        { command: "echo fallback", projectRoot: root },
        { env, shellResolver: () => "/nonexistent/ryco-shell" },
      );
      assert.deepEqual(result, { outcome: "succeeded", exitCode: 0, outputTail: "fallback" });
    }),
  );

  it.effect.skipIf(isWindows)("fails to start without the project folder or a command", () =>
    Effect.gen(function* () {
      const { root, env } = yield* makeFixture;
      const missingRoot = yield* runSetup(
        { command: "echo never", projectRoot: NodePath.join(root, "missing") },
        { env },
      ).pipe(Effect.flip);
      assert.equal(missingRoot.reason, "cwd-missing");

      const empty = yield* runSetup({ command: "  ", projectRoot: root }, { env }).pipe(
        Effect.flip,
      );
      assert.equal(empty.reason, "internal");
    }),
  );
});
