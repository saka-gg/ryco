import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Ref, Scope } from "effect";
import { assert, describe } from "vite-plus/test";

import { makeCodexStoredThreadReader } from "./CodexStoredThreadReader.ts";
import { parseCodexSkillsListResponse } from "./CodexProvider.ts";
import { requestStoredCodexThread } from "./CodexSessionRuntime.ts";

const peerPath = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");
const peerModulePath = NodePath.join(
  import.meta.dirname,
  "../testFixtures/codexCollabMockPeer.mjs",
);

const writeScript = (script: Record<string, unknown>) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-codex-reader-"));
  const scriptPath = NodePath.join(dir, "script.json");
  const write = (next: Record<string, unknown>) =>
    NodeFS.writeFileSync(
      scriptPath,
      JSON.stringify({
        recordRequests: true,
        historyTurns: [
          {
            id: "stored-turn",
            status: "completed",
            startedAt: 1_700_000_000,
            items: [{ id: "stored-item", type: "agentMessage", text: "Recovered result" }],
          },
        ],
        ...next,
      }),
      "utf8",
    );
  write(script);
  return {
    scriptPath,
    /** Replaces the script that processes started from now on run. */
    rewrite: write,
    requests: () =>
      NodeFS.existsSync(`${scriptPath}.requests`)
        ? NodeFS.readFileSync(`${scriptPath}.requests`, "utf8").trim().split("\n")
        : [],
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};

const makeReader = (scriptPath: string, idleTimeout = "1 minute" as const) =>
  makeCodexStoredThreadReader({
    binaryPath: peerPath,
    cwd: NodeOS.tmpdir(),
    environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
    idleTimeout,
  });

const read = (reader: Effect.Success<ReturnType<typeof makeReader>>, providerThreadId: string) =>
  reader.withClient((client) => requestStoredCodexThread(client, providerThreadId));

describe("CodexStoredThreadReader", () => {
  it.live("shares one app-server between sequential and concurrent reads", () =>
    Effect.gen(function* () {
      const script = writeScript({});
      yield* Effect.addFinalizer(() => Effect.sync(script.cleanup));
      const reader = yield* makeReader(script.scriptPath);
      assert.isFalse(reader.isRunning());

      const first = yield* read(reader, "thread-a");
      assert.equal(first.turns[0]?.status, "completed");
      yield* Effect.all(
        [read(reader, "thread-b"), read(reader, "thread-c"), read(reader, "thread-a")],
        { concurrency: "unbounded" },
      );

      assert.equal(reader.starts(), 1);
      assert.isTrue(reader.isRunning());
      assert.deepEqual(script.requests(), [
        "initialize",
        "initialized",
        "thread/read",
        "thread/read",
        "thread/read",
        "thread/read",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the process after an error answer and replaces one that exited", () =>
    Effect.gen(function* () {
      const script = writeScript({ readErrorFor: "missing", exitOnReadFor: "crash" });
      yield* Effect.addFinalizer(() => Effect.sync(script.cleanup));
      const reader = yield* makeReader(script.scriptPath);

      const missing = yield* Effect.flip(read(reader, "missing"));
      assert.equal(missing._tag, "CodexAppServerRequestError");
      yield* read(reader, "thread-a");
      assert.equal(reader.starts(), 1);

      const crashed = yield* Effect.flip(read(reader, "crash"));
      assert.notEqual(crashed._tag, "CodexAppServerRequestError");
      assert.isFalse(reader.isRunning());
      yield* read(reader, "thread-a");
      assert.equal(reader.starts(), 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("closes an idle process and starts a fresh one on the next read", () =>
    Effect.gen(function* () {
      const script = writeScript({});
      yield* Effect.addFinalizer(() => Effect.sync(script.cleanup));
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: script.scriptPath },
        idleTimeout: "50 millis",
      });
      yield* read(reader, "thread-a");
      assert.isTrue(reader.isRunning());
      // A read inside the idle window reuses the process and restarts the window.
      yield* Effect.sleep("20 millis");
      yield* read(reader, "thread-a");
      assert.equal(reader.starts(), 1);
      yield* Effect.sleep("200 millis");
      assert.isFalse(reader.isRunning());
      yield* read(reader, "thread-a");
      assert.equal(reader.starts(), 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("lists a directory's skills over the same process", () =>
    Effect.gen(function* () {
      const script = writeScript({
        projectSkills: {
          "/repo": [
            {
              name: "deploy",
              description: "Ship it",
              enabled: true,
              path: "/repo/.codex/skills/deploy/SKILL.md",
              scope: "repo",
            },
          ],
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(script.cleanup));
      const reader = yield* makeReader(script.scriptPath);
      yield* read(reader, "thread-a");
      const response = yield* reader.withClient((client) =>
        client.request("skills/list", { cwds: ["/repo"] }),
      );
      assert.deepEqual(parseCodexSkillsListResponse(response, "/repo"), [
        {
          name: "deploy",
          description: "Ship it",
          enabled: true,
          path: "/repo/.codex/skills/deploy/SKILL.md",
          scope: "repo",
        },
      ]);
      assert.equal(reader.starts(), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops the process with its owner and refuses later reads", () =>
    Effect.gen(function* () {
      const script = writeScript({});
      yield* Effect.addFinalizer(() => Effect.sync(script.cleanup));
      const scope = yield* Scope.make("sequential");
      const reader = yield* makeReader(script.scriptPath).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      yield* read(reader, "thread-a");
      assert.isTrue(reader.isRunning());
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(reader.isRunning());
      const refused = yield* Effect.flip(read(reader, "thread-a"));
      assert.equal(refused._tag, "CodexAppServerTransportError");
      assert.equal(reader.starts(), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("hands each call the initialize answer of the process serving it", () =>
    Effect.gen(function* () {
      const script = writeScript({});
      yield* Effect.addFinalizer(() => Effect.sync(script.cleanup));
      const reader = yield* makeReader(script.scriptPath);

      const userAgent = yield* reader.withClient((_client, session) =>
        Effect.succeed(session.initialize.userAgent),
      );
      assert.equal(userAgent, "t3-collab-mock/0.0.0");
      assert.equal(reader.starts(), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("retires exactly the process a call asks to retire", () =>
    Effect.gen(function* () {
      const script = writeScript({});
      yield* Effect.addFinalizer(() => Effect.sync(script.cleanup));
      const reader = yield* makeReader(script.scriptPath);

      yield* reader.withClient((_client, session) => session.retire);
      assert.isFalse(reader.isRunning());
      yield* read(reader, "thread-a");
      assert.equal(reader.starts(), 2);

      // A retire that arrives after the process was replaced leaves the replacement alone.
      const stale = yield* reader.withClient((_client, session) => Effect.succeed(session.retire));
      yield* stale;
      assert.isFalse(reader.isRunning());
      yield* read(reader, "thread-a");
      yield* stale;
      assert.isTrue(reader.isRunning());
      assert.equal(reader.starts(), 3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "retires the process once its binary identity changed and restarts on the next call",
    () =>
      Effect.gen(function* () {
        const script = writeScript({});
        yield* Effect.addFinalizer(() => Effect.sync(script.cleanup));
        const identity = yield* Ref.make("binary-a");
        const reader = yield* makeCodexStoredThreadReader({
          binaryPath: peerPath,
          cwd: NodeOS.tmpdir(),
          environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: script.scriptPath },
          binaryIdentity: Ref.get(identity),
        });

        // Nothing to retire before a process runs, and an unchanged identity keeps it.
        yield* reader.retireIfBinaryChanged;
        yield* read(reader, "thread-a");
        yield* reader.retireIfBinaryChanged;
        yield* read(reader, "thread-b");
        assert.equal(reader.starts(), 1);
        assert.isTrue(reader.isRunning());

        // A different binary retires it, and the next call starts a fresh process.
        yield* Ref.set(identity, "binary-b");
        yield* reader.retireIfBinaryChanged;
        assert.isFalse(reader.isRunning());
        yield* read(reader, "thread-a");
        assert.equal(reader.starts(), 2);

        // The new process runs the new binary: it is no longer seen as changed.
        yield* reader.retireIfBinaryChanged;
        assert.isTrue(reader.isRunning());
        assert.equal(reader.starts(), 2);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("never retires for its binary without a binary identity", () =>
    Effect.gen(function* () {
      const script = writeScript({});
      yield* Effect.addFinalizer(() => Effect.sync(script.cleanup));
      const reader = yield* makeReader(script.scriptPath);
      yield* read(reader, "thread-a");
      yield* reader.retireIfBinaryChanged;
      assert.isTrue(reader.isRunning());
      assert.equal(reader.starts(), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ends a start that never answers when its caller is interrupted", () =>
    Effect.gen(function* () {
      const script = writeScript({ hangOn: "initialize" });
      yield* Effect.addFinalizer(() => Effect.sync(script.cleanup));
      const reader = yield* makeReader(script.scriptPath);
      const awaitRequest = Effect.gen(function* () {
        for (let attempt = 0; attempt < 200 && script.requests().length === 0; attempt++) {
          yield* Effect.sleep("20 millis");
        }
        assert.deepEqual(script.requests(), ["initialize"]);
      });

      const hung = yield* read(reader, "thread-a").pipe(Effect.forkChild);
      yield* awaitRequest;
      // A second call waits for the start lock and can give up without ending the first start.
      const waiting = yield* read(reader, "thread-b").pipe(Effect.forkChild);
      yield* Effect.sleep("50 millis");
      const waitStartedAt = Date.now();
      yield* Fiber.interrupt(waiting);
      assert.isBelow(Date.now() - waitStartedAt, 2_000);
      assert.isUndefined(hung.pollUnsafe());

      const interruptStartedAt = Date.now();
      yield* Fiber.interrupt(hung);
      // The request timeout of the start is 20 seconds; interruption does not wait for it.
      assert.isBelow(Date.now() - interruptStartedAt, 5_000);
      assert.isFalse(reader.isRunning());
      assert.equal(reader.starts(), 0);

      // The start lock is free again: the next call starts a working process.
      script.rewrite({});
      const stored = yield* read(reader, "thread-a");
      assert.equal(stored.turns[0]?.status, "completed");
      assert.equal(reader.starts(), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("lets a call finish on a retired process and then closes it", () =>
    Effect.gen(function* () {
      const script = writeScript({});
      yield* Effect.addFinalizer(() => Effect.sync(script.cleanup));
      // The wrapper records the pid of every process the reader starts.
      const dir = NodePath.dirname(script.scriptPath);
      const pidsPath = NodePath.join(dir, "pids");
      const binaryPath = NodePath.join(dir, "codex");
      NodeFS.writeFileSync(
        binaryPath,
        `#!/usr/bin/env bash\nshift\necho $$ >> "${pidsPath}"\nexec node "${peerModulePath}" "$@"\n`,
        { mode: 0o755 },
      );
      const pids = () =>
        NodeFS.existsSync(pidsPath)
          ? NodeFS.readFileSync(pidsPath, "utf8").trim().split("\n").map(Number)
          : [];
      const isAlive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      const identity = yield* Ref.make("binary-a");
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath,
        cwd: NodeOS.tmpdir(),
        environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: script.scriptPath },
        binaryIdentity: Ref.get(identity),
      });
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();

      const slow = yield* reader
        .withClient((client) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(requestStoredCodexThread(client, "thread-a")),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const [retiredPid] = pids();
      assert.isDefined(retiredPid);

      // The binary changed while that call runs: nothing new uses the old process, but the
      // call on it is not cut short.
      yield* Ref.set(identity, "binary-b");
      yield* reader.retireIfBinaryChanged;
      assert.isFalse(reader.isRunning());
      yield* read(reader, "thread-b");
      assert.equal(reader.starts(), 2);
      assert.isTrue(isAlive(retiredPid!));

      yield* Deferred.succeed(gate, undefined);
      const stored = yield* Fiber.join(slow);
      assert.equal(stored.turns[0]?.status, "completed");

      // With its last call done the retired process is closed; the replacement is untouched.
      for (let attempt = 0; attempt < 100 && isAlive(retiredPid!); attempt++) {
        yield* Effect.sleep("20 millis");
      }
      assert.isFalse(isAlive(retiredPid!));
      const [, replacementPid] = pids();
      assert.isTrue(isAlive(replacementPid!));
      assert.isTrue(reader.isRunning());
      yield* read(reader, "thread-c");
      assert.equal(reader.starts(), 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
