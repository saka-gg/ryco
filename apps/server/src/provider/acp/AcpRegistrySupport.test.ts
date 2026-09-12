// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { makeRegistryAcpRuntime } from "./AcpRegistrySupport.ts";

const fixture = (capabilities: object = {}, protocolVersion = 1) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "ryco-registry-runtime-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    const script = join(dir, "agent.mjs");
    const log = join(dir, "requests.jsonl");
    yield* Effect.promise(() =>
      writeFile(
        script,
        `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line); appendFileSync(log, JSON.stringify(request)+'\\n');
 if (request.id === undefined) return;
 let result={};
 if(request.method==='initialize') result={protocolVersion:${protocolVersion},agentCapabilities:${JSON.stringify(capabilities)},authMethods:[{id:'login',name:'Login'}]};
 if(request.method==='session/new' && ${"silentStart" in capabilities}) return;
 if(request.method==='session/new') result={sessionId:'registry-test',models:{currentModelId:'a',availableModels:[{modelId:'a',name:'A'}]}};
 if(request.method==='session/load' || (request.method==='session/resume' && ${"failResume" in capabilities})) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'Cannot load'}})+'\\n'); return; }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});
`,
      ),
    );
    const runtime = yield* makeRegistryAcpRuntime({
      settings: { agentId: "test", version: "1.0.0", authMethodId: "login" },
      installed: { command: process.execPath, args: [script], env: {} },
      options: {
        cwd: dir,
        clientInfo: { name: "test", version: "1" },
        ...(capabilities && "resume" in capabilities ? { resumeSessionId: "old" } : {}),
      },
    });
    const requests = Effect.promise(async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params?: unknown }),
    );
    return { runtime, requests };
  });

it.effect("registry start never authenticates even when a method preference is configured", () =>
  Effect.gen(function* () {
    const { runtime, requests } = yield* fixture();
    const started = yield* runtime.start();
    assert.equal(started.sessionId, "registry-test");
    assert.deepStrictEqual(
      (yield* requests).map((r) => r.method),
      ["initialize", "session/new"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("authentication accepts only a currently advertised method", () =>
  Effect.gen(function* () {
    const { runtime, requests } = yield* fixture();
    const rejected = yield* runtime.authenticate("untrusted").pipe(Effect.result);
    assert.isTrue(Result.isFailure(rejected));
    yield* runtime.authenticate("login");
    assert.deepStrictEqual(
      (yield* requests).map((r) => r.method),
      ["initialize", "authenticate"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("strict resume rejects unsupported load without silently creating a session", () =>
  Effect.gen(function* () {
    const { runtime, requests } = yield* fixture({ resume: true });
    const result = yield* runtime.start().pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.deepStrictEqual(
      (yield* requests).map((r) => r.method),
      ["initialize"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("strict resume propagates load failures without starting a fresh conversation", () =>
  Effect.gen(function* () {
    const { runtime, requests } = yield* fixture({ resume: true, loadSession: true });
    const result = yield* runtime.start().pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.deepStrictEqual(
      (yield* requests).map((r) => r.method),
      ["initialize", "session/load"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("strict registry resume selects advertised session/resume before legacy loading", () =>
  Effect.gen(function* () {
    const { runtime, requests } = yield* fixture({
      resume: true,
      loadSession: true,
      sessionCapabilities: { resume: {} },
    });
    const started = yield* runtime.start();
    assert.equal(started.sessionId, "old");
    assert.deepStrictEqual(
      (yield* requests).map((request) => request.method),
      ["initialize", "session/resume"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("registry refuses incompatible protocol versions before session or auth requests", () =>
  Effect.gen(function* () {
    const { runtime, requests } = yield* fixture({}, 2);
    const started = yield* runtime.start().pipe(Effect.result);
    assert.isTrue(Result.isFailure(started));
    assert.deepStrictEqual(
      (yield* requests).map((request) => request.method),
      ["initialize"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("failed advertised resume never falls back to load or a fresh session", () =>
  Effect.gen(function* () {
    const { runtime, requests } = yield* fixture({
      resume: true,
      failResume: true,
      loadSession: true,
      sessionCapabilities: { resume: {} },
    });
    const started = yield* runtime.start().pipe(Effect.result);
    assert.isTrue(Result.isFailure(started));
    assert.deepStrictEqual(
      (yield* requests).map((request) => request.method),
      ["initialize", "session/resume"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("registry startup times out when the agent never responds to session creation", () =>
  Effect.gen(function* () {
    const { runtime, requests } = yield* fixture({ silentStart: true });
    const start = yield* runtime.start().pipe(Effect.result, Effect.forkChild);
    // Wait for the real subprocess handshake before advancing Effect's virtual clock.
    yield* Effect.promise(async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const captured = await Effect.runPromise(requests).catch(() => []);
        if (captured.some((request) => request.method === "session/new")) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("Mock agent did not receive session/new");
    });
    yield* TestClock.adjust("30 seconds");
    const result = yield* Fiber.join(start);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.equal(result.failure._tag, "AcpTransportError");
      if (result.failure._tag === "AcpTransportError")
        assert.include(result.failure.detail, "timed out");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
