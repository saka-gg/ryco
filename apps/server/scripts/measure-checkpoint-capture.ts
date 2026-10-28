/**
 * Measures checkpoint capture latency and robustness; run with Node (server runtime).
 *
 *   GIT_CONFIG_GLOBAL=/dev/null node apps/server/scripts/measure-checkpoint-capture.ts \
 *     [--files 1,50,500] [--runs 7] [--nested] [--out results.json]
 *   GIT_CONFIG_GLOBAL=/dev/null node apps/server/scripts/measure-checkpoint-capture.ts \
 *     --churn [--captures 50] [--churn-pause-ms 0] [--out results.json]
 *
 * Latency: per entry of `--files`, builds a repository of 2,000 committed files in 40
 * directories, captures once to warm up, then per run rewrites that many files with new
 * content (so every run writes that many new blobs) and times one `captureCheckpoint` of
 * `CheckpointStoreLive`. Prints the median and p95 per file count. `--nested` adds an
 * untracked embedded repository without a commit (`git init empty`), which `git add -A`
 * refuses, so every capture pays for the failed add and the search for such repositories.
 *
 * Churn: while `--captures` captures run back to back in such a repository, a separate
 * process keeps creating and deleting 300 untracked files in `churn/` and rewriting a
 * tracked 15 KB file in place (truncate, then write), pausing `--churn-pause-ms` after each
 * round (0: constant churn). Prints how many captures failed, the first line of each distinct
 * failure, and how many transient failures the store retried.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@ryco/contracts";
import { Effect, Layer, Logger, ManagedRuntime, References } from "effect";

import { CheckpointStoreLive } from "../src/checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../src/checkpointing/Services/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import * as VcsDriverRegistry from "../src/vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";

const { values: args } = parseArgs({
  options: {
    files: { type: "string", default: "1,50,500" },
    runs: { type: "string", default: "7" },
    churn: { type: "boolean", default: false },
    nested: { type: "boolean", default: false },
    captures: { type: "string", default: "50" },
    "churn-pause-ms": { type: "string", default: "0" },
    out: { type: "string" },
  },
});

const DIRECTORIES = 40;
const FILES_PER_DIRECTORY = 50;

const gitEnv = { ...process.env, LC_ALL: "C" };
function git(cwd: string, gitArgs: ReadonlyArray<string>): string {
  const result = spawnSync("git", gitArgs, { cwd, env: gitEnv, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(" ")} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function makeRepository(root: string, name: string): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "measure"]);
  git(repo, ["config", "user.email", "measure@example.com"]);
  for (let directory = 0; directory < DIRECTORIES; directory++) {
    mkdirSync(join(repo, `dir${directory}`), { recursive: true });
    for (let file = 0; file < FILES_PER_DIRECTORY; file++) {
      writeFileSync(
        join(repo, `dir${directory}`, `f${file}.txt`),
        `tracked ${directory}/${file}\n`,
      );
    }
  }
  writeFileSync(join(repo, "log.txt"), "x".repeat(15_000));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

let round = 0;
function rewriteFiles(repo: string, count: number): void {
  round += 1;
  for (let index = 0; index < count; index++) {
    const directory = index % DIRECTORIES;
    const file = Math.floor(index / DIRECTORIES) % FILES_PER_DIRECTORY;
    writeFileSync(join(repo, `dir${directory}`, `f${file}.txt`), `round ${round} file ${index}\n`);
  }
}

const quantile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const round1 = (value: number) => Math.round(value * 10) / 10;

const logMessages: Array<string> = [];
const CaptureLogger = Logger.layer(
  [
    Logger.make((options) => {
      const message = Array.isArray(options.message) ? options.message[0] : options.message;
      logMessages.push(String(message));
    }),
  ],
  { mergeWithExisting: false },
);

const VcsProcessLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessLayer));
const runtime = ManagedRuntime.make(
  CheckpointStoreLive.pipe(
    Layer.provideMerge(VcsDriverLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(CaptureLogger),
    Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")),
  ),
);
const store = await runtime.runPromise(Effect.service(CheckpointStore));

let turn = 0;
async function capture(repo: string): Promise<{ ms: number; error: string | null }> {
  turn += 1;
  const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("measure"), turn);
  const started = performance.now();
  const exit = await runtime.runPromiseExit(store.captureCheckpoint({ cwd: repo, checkpointRef }));
  const ms = performance.now() - started;
  if (exit._tag === "Success") return { ms, error: null };
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  const detail =
    failure && failure._tag === "Fail" && "detail" in failure.error
      ? String(failure.error.detail)
      : String(exit.cause);
  return { ms, error: detail.split("\n")[0] ?? detail };
}

const root = mkdtempSync(join(tmpdir(), "ryco-measure-checkpoint-"));
const environment = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  git: git(root, ["--version"]),
};
console.log(JSON.stringify(environment));

try {
  if (args.churn) {
    const captures = Number(args.captures);
    const repo = makeRepository(root, "churn");
    // A separate process, so its synchronous file churn cannot stall the captures' event loop.
    const churner = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
         const path = require("node:path");
         const repo = process.argv[1];
         const dir = path.join(repo, "churn");
         fs.mkdirSync(dir, { recursive: true });
         const pauseMs = Number(process.argv[2]);
         const sleeper = new Int32Array(new SharedArrayBuffer(4));
         const data = Buffer.alloc(15000, 97);
         for (;;) {
           for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, "f" + i), String(Math.random()));
           for (let i = 0; i < 300; i++) fs.rmSync(path.join(dir, "f" + i), { force: true });
           fs.writeFileSync(path.join(repo, "log.txt"), data);
           if (pauseMs > 0) Atomics.wait(sleeper, 0, 0, pauseMs);
         }`,
        repo,
        args["churn-pause-ms"],
      ],
      { stdio: "ignore" },
    );
    const results: Array<{ ms: number; error: string | null }> = [];
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (let index = 0; index < captures; index++) results.push(await capture(repo));
    } finally {
      // It never stops on its own.
      churner.kill("SIGTERM");
    }
    const failures = results.filter((result) => result.error !== null);
    const distinct = [...new Set(failures.map((result) => result.error))];
    const retries = logMessages.filter((message) => message.includes("retrying")).length;
    const summary = {
      captures,
      churnPauseMs: Number(args["churn-pause-ms"]),
      failed: failures.length,
      retriedTransientFailures: retries,
      medianMs: round1(
        quantile(
          results.map((result) => result.ms),
          0.5,
        ),
      ),
      distinctFailures: distinct,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (args.out) writeFileSync(args.out, JSON.stringify({ environment, churn: summary }, null, 2));
  } else {
    const runs = Number(args.runs);
    const latency: Array<{ files: number; medianMs: number; p95Ms: number; runsMs: number[] }> = [];
    for (const files of args.files.split(",").map(Number)) {
      const repo = makeRepository(root, `files-${files}`);
      if (args.nested) git(repo, ["init", "-q", "empty"]);
      rewriteFiles(repo, files);
      const warmUp = await capture(repo);
      if (warmUp.error) throw new Error(`warm-up capture failed: ${warmUp.error}`);
      const timings: Array<number> = [];
      for (let run = 0; run < runs; run++) {
        rewriteFiles(repo, files);
        const result = await capture(repo);
        if (result.error) throw new Error(`capture failed: ${result.error}`);
        timings.push(result.ms);
      }
      const row = {
        files,
        medianMs: round1(quantile(timings, 0.5)),
        p95Ms: round1(quantile(timings, 0.95)),
        runsMs: timings.map(round1),
      };
      latency.push(row);
      console.log(`files=${files} median=${row.medianMs} ms p95=${row.p95Ms} ms`);
    }
    if (args.out) {
      writeFileSync(
        args.out,
        JSON.stringify({ environment, nested: args.nested, latency }, null, 2),
      );
    }
  }
} finally {
  await runtime.dispose();
  rmSync(root, { recursive: true, force: true });
}
