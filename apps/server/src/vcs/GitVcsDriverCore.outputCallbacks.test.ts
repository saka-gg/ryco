/**
 * `execute`'s line callbacks around `maxOutputBytes` (real git): with
 * `keepLineCallbacksAfterTruncation` they keep receiving output the collected
 * text no longer keeps, which a long clone's progress meter needs.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-git-output-callbacks-" })),
  Layer.provideMerge(NodeServices.layer),
);

const LINE_COUNT = 3_000;
// A shell alias, so the test needs nothing but git: prints `line 0` … `line 2999` to stderr.
const SPAM_ARGS = [
  "-c",
  `alias.spam=!f() { i=0; while [ $i -lt ${LINE_COUNT} ]; do echo "line $i" >&2; i=$((i+1)); done; }; f`,
  "spam",
];

const runSpam = (keepLineCallbacksAfterTruncation: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-git-output-callbacks-cwd-" });
    const git = yield* GitVcsDriver.GitVcsDriver;
    const lines: string[] = [];
    const result = yield* git.execute({
      operation: "GitVcsDriverCore.outputCallbacks.test",
      cwd,
      args: SPAM_ARGS,
      maxOutputBytes: 2_000,
      truncateOutputAtMaxBytes: true,
      progress: {
        onStderrLine: (line) => Effect.sync(() => void lines.push(line)),
        keepLineCallbacksAfterTruncation,
      },
    });
    return { lines, result };
  });

it.layer(TestLayer)("execute line callbacks past maxOutputBytes", (it) => {
  it.effect("keeps calling line callbacks after the collected output reaches its cap", () =>
    Effect.gen(function* () {
      const { lines, result } = yield* runSpam(true);
      assert.strictEqual(lines.length, LINE_COUNT);
      assert.strictEqual(lines[0], "line 0");
      assert.strictEqual(lines.at(-1), `line ${LINE_COUNT - 1}`);
      assert.isTrue(result.stderrTruncated);
      assert.isAtMost(Buffer.byteLength(result.stderr), 2_000);
      assert.notInclude(result.stderr, `line ${LINE_COUNT - 1}`);
    }),
  );

  it.effect("stops line callbacks at the cap without the option", () =>
    Effect.gen(function* () {
      const { lines, result } = yield* runSpam(false);
      assert.isBelow(lines.length, LINE_COUNT);
      assert.isTrue(result.stderrTruncated);
    }),
  );

  it.effect("splits carriage-return redraws after the cap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-git-output-callbacks-cwd-" });
      const git = yield* GitVcsDriver.GitVcsDriver;
      const lines: string[] = [];
      const redraws = Array.from({ length: 99 }, (_, index) => `p ${index + 1}%%`).join("\\r");
      const result = yield* git.execute({
        operation: "GitVcsDriverCore.outputCallbacks.test",
        cwd,
        args: ["-c", `alias.meter=!printf "${redraws}\\rdone\\n" >&2`, "meter"],
        maxOutputBytes: 50,
        truncateOutputAtMaxBytes: true,
        progress: {
          onStderrLine: (line) => Effect.sync(() => void lines.push(line)),
          splitStderrAtCarriageReturn: true,
          keepLineCallbacksAfterTruncation: true,
        },
      });
      assert.isTrue(result.stderrTruncated);
      assert.include(lines, "p 99%");
      assert.strictEqual(lines.at(-1), "done");
      assert.strictEqual(lines.length, 100);
    }),
  );

  it.effect("passes a character the cap splits to the callbacks whole", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-git-output-callbacks-cwd-" });
      const git = yield* GitVcsDriver.GitVcsDriver;
      const lines: string[] = [];
      // 1,999 bytes of "a", then "é" (0xC3 0xA9): the 2,000-byte cap falls inside it.
      const result = yield* git.execute({
        operation: "GitVcsDriverCore.outputCallbacks.test",
        cwd,
        args: [
          "-c",
          `alias.split=!f() { printf '%1999s' '' | tr ' ' a >&2; printf '\\303\\251 end\\n' >&2; }; f`,
          "split",
        ],
        maxOutputBytes: 2_000,
        truncateOutputAtMaxBytes: true,
        progress: {
          onStderrLine: (line) => Effect.sync(() => void lines.push(line)),
          keepLineCallbacksAfterTruncation: true,
        },
      });
      assert.isTrue(result.stderrTruncated);
      assert.deepStrictEqual(lines, [`${"a".repeat(1_999)}é end`]);
      assert.notInclude(result.stderr, "�");
      assert.isAtMost(Buffer.byteLength(result.stderr), 2_000);
    }),
  );
});
