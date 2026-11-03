// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  MAX_SQLITE_WORKER_FAILURES,
  makeSqliteWorkerThread,
  type SqliteWorkerFailure,
} from "./sqliteWorkerThread.ts";

const READY_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (message) => {
  if (message === "crash") process.exit(7);
  parentPort.postMessage({ echo: message });
});
parentPort.postMessage({ ready: true });
`;

const nextMessage = (messages: unknown[], count: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const poll = () => (messages.length >= count ? resolve() : setTimeout(poll, 5));
        poll();
      }),
  );

it.effect("does not keep the process alive", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-sqlite-worker-thread-"));
  const script = NodePath.join(tempDir, "child.mjs");
  // The worker keeps an interval running, so only `unref` lets the process end.
  NodeFS.writeFileSync(
    script,
    `
import { makeSqliteWorkerThread } from ${JSON.stringify(new URL("./sqliteWorkerThread.ts", import.meta.url).href)};
const thread = makeSqliteWorkerThread({
  source: 'require("node:worker_threads").parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000);',
  workerData: null,
  onMessage: () => {},
  onFailure: (failure) => {
    console.error("failure", failure);
    process.exitCode = 3;
  },
});
console.log((await thread.start()) ? "ready" : "not ready");
// Never fires unless something else keeps the process alive: then it ends a hung child.
setTimeout(() => process.exit(9), 20_000).unref();
`,
  );
  return Effect.promise(
    () =>
      new Promise<{ readonly code: number | null; readonly stdout: string }>((resolve, reject) => {
        const child = NodeChildProcess.spawn(process.execPath, [script], {
          stdio: ["ignore", "pipe", "inherit"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, stdout }));
      }),
  ).pipe(
    Effect.map(({ code, stdout }) => {
      assert.equal(stdout.trim(), "ready");
      assert.equal(code, 0);
    }),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.live("restarts after a crash and gives up after three consecutive failures", () =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    const failures: SqliteWorkerFailure[] = [];
    const healthy = makeSqliteWorkerThread({
      source: READY_SOURCE,
      workerData: null,
      onMessage: (message) => messages.push(message),
      onFailure: (failure) => failures.push(failure),
    });
    assert.isTrue(yield* Effect.promise(healthy.start));
    healthy.current()?.postMessage("hello");
    yield* nextMessage(messages, 1);
    assert.deepEqual(messages, [{ echo: "hello" }]);

    healthy.current()?.postMessage("crash");
    yield* nextMessage(failures, 1);
    assert.deepEqual(failures, [{ kind: "exit", code: 7 }]);
    assert.isUndefined(healthy.current());
    assert.isFalse(healthy.disabled());
    // A crash is not the end: the next start brings up a new worker.
    assert.isTrue(yield* Effect.promise(healthy.start));
    healthy.current()?.postMessage("again");
    yield* nextMessage(messages, 2);
    assert.deepEqual(messages[1], { echo: "again" });
    yield* Effect.promise(healthy.close);

    const broken: SqliteWorkerFailure[] = [];
    const failing = makeSqliteWorkerThread({
      source: "throw new Error('no worker here')",
      workerData: null,
      onMessage: () => undefined,
      onFailure: (failure) => broken.push(failure),
    });
    for (let attempt = 0; attempt < MAX_SQLITE_WORKER_FAILURES; attempt += 1) {
      assert.isFalse(yield* Effect.promise(failing.start));
    }
    assert.isTrue(failing.disabled());
    assert.isFalse(yield* Effect.promise(failing.start));
    // One report per failed start: the thread's exit after its error is not counted twice.
    assert.equal(broken.length, MAX_SQLITE_WORKER_FAILURES);
    assert.isTrue(broken.every((failure) => failure.kind === "error"));
  }),
);

it.live("close terminates and disables", () =>
  Effect.gen(function* () {
    const failures: SqliteWorkerFailure[] = [];
    const thread = makeSqliteWorkerThread({
      source: READY_SOURCE,
      workerData: null,
      onMessage: () => undefined,
      onFailure: (failure) => failures.push(failure),
    });
    assert.isTrue(yield* Effect.promise(thread.start));
    const worker = thread.current();
    assert.isDefined(worker);
    const exited = new Promise<number>((resolve) => worker?.once("exit", resolve));
    yield* Effect.promise(thread.close);
    yield* Effect.promise(() => exited);
    assert.isUndefined(thread.current());
    assert.isTrue(thread.disabled());
    assert.isFalse(yield* Effect.promise(thread.start));
    // Closing on purpose is not a failure.
    assert.deepEqual(failures, []);
  }),
);
