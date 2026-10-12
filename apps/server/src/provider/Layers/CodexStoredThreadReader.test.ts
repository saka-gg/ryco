import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { assert, describe } from "vite-plus/test";

import { makeCodexStoredThreadReader } from "./CodexStoredThreadReader.ts";
import { parseCodexSkillsListResponse } from "./CodexProvider.ts";
import { requestStoredCodexThread } from "./CodexSessionRuntime.ts";

const peerPath = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");

const writeScript = (script: Record<string, unknown>) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-codex-reader-"));
  const scriptPath = NodePath.join(dir, "script.json");
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
      ...script,
    }),
    "utf8",
  );
  return {
    scriptPath,
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
});
