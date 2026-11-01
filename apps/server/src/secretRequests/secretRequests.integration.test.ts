import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type AgentControlCapability,
} from "@ryco/contracts";
import { Effect, Fiber, Layer, Logger, Option, Stream, Tracer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { afterAll } from "vite-plus/test";

import { threadWakeSource, waitUntil } from "../agentControl/eventDrivenWait.ts";
import { withSecretRequestTools } from "../agentControl/Mcp/secretRequestTools.ts";
import type { AgentControlMcpTools } from "../agentControl/Mcp/tools.ts";
import type { AgentControlSessionRecord } from "../agentControl/Services/AgentControlSessionRegistry.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import { findThreadInArray } from "../orchestration/threadIndex.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../project/Services/ProjectAvatarStore.ts";
import type { RpcConnectionFacts } from "../ws/RpcPrincipal.ts";
import { LEFTOVER_TEMPORARY_MIN_AGE_MS } from "./dotenvSink.ts";
import {
  answerSecretRequest,
  secretRequestIdFor,
  sweepSecretRequestLeftovers,
} from "./secretRequests.ts";

// Built from parts, so no fixture looks like a real credential.
const SECRET = ["ryco", "integration", "secret", "c0ffee"].join("-");

const NO_FORWARDING = {
  forwardedFor: undefined,
  forwarded: undefined,
  forwardedProto: undefined,
  realIp: undefined,
};
/** The card on this machine, straight to the node's loopback listener. */
const LOOPBACK: RpcConnectionFacts = {
  kind: "direct",
  remote: "loopback",
  remoteAddress: "127.0.0.1",
  localAddress: "127.0.0.1",
  tls: false,
  forwarding: NO_FORWARDING,
};

const layer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("unused"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-secret-requests-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A Git checkout that ignores `.env`. */
function gitCheckout(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ryco-secret-request-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(path.join(root, ".gitignore"), ".env\n");
  return root;
}

const noTools: AgentControlMcpTools = {
  descriptors: [],
  descriptorsFor: () => Effect.succeed([]),
  hasTool: () => false,
  isWriteTool: () => false,
  callTool: () => Effect.die("not used"),
};

const session = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<AgentControlCapability> = [AGENT_CONTROL_CAPABILITIES.requestSecrets],
): AgentControlSessionRecord => ({
  sessionId: `lease-${threadId}`,
  issuedAt: "2026-10-31T08:00:00.000Z",
  threadId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime-1"),
  grantedCapabilities: capabilities,
  injectionMode: "codex-http",
});

const setup = (key: string, options: { readonly worktree?: boolean } = {}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const root = gitCheckout();
    // A thread in a worktree of its own: another checkout than the project's folder.
    const worktree = options.worktree === true ? gitCheckout() : null;
    const threadId = ThreadId.make(`thread-${key}`);
    const projectId = ProjectId.make(`project-${key}`);
    const createdAt = new Date().toISOString();
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${key}`),
      projectId,
      title: "Secrets",
      workspaceRoot: root,
      defaultModelSelection: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${key}`),
      threadId,
      projectId,
      title: "Secrets",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: worktree,
      createdAt,
    });
    const tools = withSecretRequestTools(noTools, {
      policy: {
        isEnabled: Effect.succeed(true),
        authorize: (request: {
          readonly grantedCapabilities: ReadonlyArray<AgentControlCapability>;
          readonly requiredCapability: AgentControlCapability;
        }) =>
          request.grantedCapabilities.includes(request.requiredCapability)
            ? Effect.void
            : Effect.fail({ _tag: "AgentControlCapabilityDeniedError" }),
      } as never,
      registry: {
        getTurnAuthority: (sessionId) =>
          Effect.succeed(
            Option.some({
              sessionId,
              threadId,
              turnId: TurnId.make("turn-1"),
              boundAt: createdAt,
            }),
          ),
      },
      engine,
      projections,
      helpers: { findThreadInArray, waitUntil, threadWakeSource },
    });
    const deps = { engine, projections, findThreadInArray };
    return { engine, projections, root, worktree, threadId, tools, deps };
  });

const hasPendingUserInput = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    return Option.getOrThrow(yield* projections.getThreadShellById(threadId)).hasPendingUserInput;
  });

layer("secret requests", (it) => {
  it.effect(
    "asks on a card, writes the owner's answer to the dotenv file, and records only the request",
    () => {
      const logged: string[] = [];
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const logger = Logger.layer([
        Logger.make((options) => {
          logged.push(JSON.stringify([options.message, String(options.cause)]));
        }),
      ]);
      return Effect.gen(function* () {
        const { engine, root, threadId, tools, deps } = yield* setup("flow");
        const caller = session(threadId);
        const ask = (waitMs: number) =>
          tools.callTool(caller, AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL, {
            requestId: "stripe",
            key: "STRIPE_KEY",
            purpose: "Charge test cards",
            waitMs,
          });

        const asked = yield* ask(0);
        assert.isUndefined(asked.isError);
        assert.deepInclude(asked.structuredContent as object, {
          requestId: "stripe",
          key: "STRIPE_KEY",
          file: ".env",
          status: "pending",
        });
        // A pending request holds the thread like an unanswered question.
        assert.isTrue(yield* hasPendingUserInput(threadId));

        // An agent waiting on the card wakes when the owner saves it.
        const waiting = yield* Effect.forkChild(ask(20_000));
        const requestId = secretRequestIdFor(threadId, "stripe");
        const answered = yield* answerSecretRequest(
          deps,
          {
            threadId,
            requestId,
            answer: { type: "provide", value: `  ${SECRET}\n` },
          },
          LOOPBACK,
        );
        assert.deepEqual(answered, { status: "provided", file: ".env", key: "STRIPE_KEY" });
        const woken = yield* Fiber.join(waiting);
        assert.strictEqual((woken.structuredContent as { status: string }).status, "provided");

        assert.deepEqual(parseEnv(readFileSync(path.join(root, ".env"), "utf8")), {
          STRIPE_KEY: SECRET,
        });
        assert.isFalse(yield* hasPendingUserInput(threadId));
        // Answered once.
        const again = yield* Effect.flip(
          answerSecretRequest(deps, { threadId, requestId, answer: { type: "decline" } }, LOOPBACK),
        );
        assert.strictEqual(again.reason, "already-answered");

        // The value is nowhere but the file: not in an event, a projection row, a tool result,
        // a log line or a span.
        const events = yield* Stream.runCollect(engine.readEvents(0));
        const recorded = JSON.stringify(events);
        assert.include(recorded, "secret.requested");
        assert.include(recorded, "secret.resolved");
        assert.notInclude(recorded, SECRET);
        const sql = yield* SqlClient.SqlClient;
        const tables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'`;
        assert.isAbove(tables.length, 10);
        for (const { name } of tables) {
          const rows = yield* sql.unsafe(`SELECT * FROM "${name}"`);
          assert.notInclude(JSON.stringify(rows), SECRET, name);
        }
        assert.notInclude(JSON.stringify([asked, woken]), SECRET);
        assert.notInclude(logged.join("\n"), SECRET);
        assert.notInclude(
          JSON.stringify(spans.map((span) => [span.name, [...span.attributes]])),
          SECRET,
        );
      }).pipe(Effect.withTracer(tracer), Effect.provide(logger));
    },
  );

  it.effect(
    "takes a value only over an encrypted connection, and a decline over any connection",
    () => {
      const logged: string[] = [];
      const logger = Logger.layer([
        Logger.make((options) => {
          logged.push(JSON.stringify([options.message, String(options.cause)]));
        }),
      ]);
      return Effect.gen(function* () {
        const { engine, root, threadId, tools, deps } = yield* setup("channel");
        const ask = (requestId: string) =>
          tools.callTool(session(threadId), AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL, {
            requestId,
            key: "DEPLOY_TOKEN",
            purpose: "Deploy previews",
            waitMs: 0,
          });
        yield* ask("deploy");
        const requestId = secretRequestIdFor(threadId, "deploy");
        const provide = (connection: RpcConnectionFacts | undefined) =>
          answerSecretRequest(
            deps,
            { threadId, requestId, answer: { type: "provide", value: SECRET } },
            connection,
          );
        const relay = (encrypted: boolean): RpcConnectionFacts => ({
          kind: "relay",
          endToEndEncrypted: () => encrypted,
        });
        const lan: RpcConnectionFacts = {
          ...LOOPBACK,
          remote: "other",
          remoteAddress: "192.168.1.20",
          localAddress: "192.168.1.10",
        };
        // Refused on a relay channel without E2EE, on plain ws:// from another machine, with
        // forged forwarding headers from that machine, on a pod network numbered in Tailscale's
        // range when the node cannot name its own Tailscale addresses, and without any facts.
        for (const connection of [
          relay(false),
          lan,
          { ...lan, forwarding: { ...NO_FORWARDING, forwardedProto: "https" } },
          { ...lan, remote: "tailscale", remoteAddress: "100.96.1.2", localAddress: "100.96.1.3" },
          undefined,
        ] satisfies ReadonlyArray<RpcConnectionFacts | undefined>) {
          const refused = yield* Effect.flip(provide(connection));
          assert.strictEqual(refused.reason, "unencrypted-connection");
        }
        assert.isFalse(existsSync(path.join(root, ".env")));
        assert.isTrue(yield* hasPendingUserInput(threadId));

        // An encrypted relay channel saves it.
        assert.deepEqual(yield* provide(relay(true)), {
          status: "provided",
          file: ".env",
          key: "DEPLOY_TOKEN",
        });
        assert.deepEqual(parseEnv(readFileSync(path.join(root, ".env"), "utf8")), {
          DEPLOY_TOKEN: SECRET,
        });

        // A decline carries no value: taken over plain ws:// too.
        yield* ask("other");
        const declined = yield* answerSecretRequest(
          deps,
          {
            threadId,
            requestId: secretRequestIdFor(threadId, "other"),
            answer: { type: "decline" },
          },
          lan,
        );
        assert.strictEqual(declined.status, "declined");

        // The refused value went nowhere: no event, no log line.
        const events = yield* Stream.runCollect(engine.readEvents(0));
        assert.notInclude(JSON.stringify(events), SECRET);
        assert.notInclude(logged.join("\n"), SECRET);
      }).pipe(Effect.provide(logger));
    },
  );

  it.effect("declines, refuses a bad file before any card, and ties a requestId to its key", () =>
    Effect.gen(function* () {
      const { root, threadId, tools, deps, projections } = yield* setup("decline");
      const call = (args: Record<string, unknown>) =>
        tools.callTool(session(threadId), AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL, {
          purpose: "Sign webhooks",
          waitMs: 0,
          ...args,
        });

      // Not ignored by Git: refused, and no card is opened.
      const refused = yield* call({
        requestId: "bad",
        key: "HOOK_SECRET",
        file: ".env.production",
      });
      assert.isTrue(refused.isError);
      assert.include(JSON.stringify(refused.content), "Git does not ignore that file");
      const escaped = yield* call({ requestId: "bad2", key: "HOOK_SECRET", file: "../.env" });
      assert.isTrue(escaped.isError);
      assert.isFalse(yield* hasPendingUserInput(threadId));

      const asked = yield* call({ requestId: "hook", key: "HOOK_SECRET" });
      assert.strictEqual((asked.structuredContent as { status: string }).status, "pending");
      const reused = yield* call({ requestId: "hook", key: "OTHER_KEY" });
      assert.isTrue(reused.isError);

      const declined = yield* answerSecretRequest(
        deps,
        {
          threadId,
          requestId: secretRequestIdFor(threadId, "hook"),
          answer: { type: "decline" },
        },
        LOOPBACK,
      );
      assert.strictEqual(declined.status, "declined");
      const after = yield* call({ requestId: "hook", key: "HOOK_SECRET" });
      assert.strictEqual((after.structuredContent as { status: string }).status, "declined");
      assert.isFalse(yield* hasPendingUserInput(threadId));
      assert.isTrue(Option.isSome(yield* projections.getThreadShellById(threadId)));
      // Declining writes nothing.
      assert.throws(() => readFileSync(path.join(root, ".env"), "utf8"));
    }),
  );

  it.effect("never writes into another checkout than the one the request was opened for", () =>
    Effect.gen(function* () {
      const { engine, root, worktree, threadId, tools, deps } = yield* setup("moved", {
        worktree: true,
      });
      const asked = yield* tools.callTool(
        session(threadId),
        AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL,
        {
          requestId: "moved",
          key: "API_KEY",
          purpose: "Call the API",
          waitMs: 0,
        },
      );
      assert.strictEqual((asked.structuredContent as { status: string }).status, "pending");
      // The worktree is gone: the thread falls back to the project's folder, which also ignores
      // `.env`. The answer must not land there.
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-moved-worktree"),
        threadId,
        worktreePath: null,
      });
      const refused = yield* Effect.flip(
        answerSecretRequest(
          deps,
          {
            threadId,
            requestId: secretRequestIdFor(threadId, "moved"),
            answer: { type: "provide", value: SECRET },
          },
          LOOPBACK,
        ),
      );
      assert.strictEqual(refused.reason, "checkout-changed");
      assert.isFalse(existsSync(path.join(root, ".env")));
      assert.isFalse(existsSync(path.join(worktree!, ".env")));
      assert.isTrue(yield* hasPendingUserInput(threadId));
    }),
  );

  it.effect("holds a thread to 5 unanswered requests, also when the agent asks in parallel", () =>
    Effect.gen(function* () {
      const { threadId, tools, engine } = yield* setup("parallel");
      const results = yield* Effect.forEach(
        Array.from({ length: 7 }, (_, index) => index),
        (index) =>
          tools.callTool(session(threadId), AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL, {
            requestId: `parallel-${index}`,
            key: `KEY_${index}`,
            purpose: "Call the API",
            waitMs: 0,
          }),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter((result) => result.isError !== true).length, 5);
      const events = yield* Stream.runCollect(engine.readEvents(0));
      const opened = Array.from(events).filter(
        (event) =>
          event.type === "thread.activity-appended" &&
          event.payload.threadId === threadId &&
          event.payload.activity.kind === "secret.requested",
      );
      assert.strictEqual(opened.length, 5);
    }),
  );

  it.effect(
    "sweeps what a crashed answer left in the checkout's Git directory after a restart",
    () =>
      Effect.gen(function* () {
        const { engine, root, threadId, tools, deps } = yield* setup("sweep");
        yield* tools.callTool(session(threadId), AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL, {
          requestId: "sweep",
          key: "API_KEY",
          purpose: "Call the API",
          waitMs: 0,
        });
        const leftover = path.join(
          root,
          ".git",
          `ryco-secret-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.tmp`,
        );
        writeFileSync(leftover, `API_KEY='${SECRET}'\n`);
        const then = new Date(Date.now() - LEFTOVER_TEMPORARY_MIN_AGE_MS - 1_000);
        utimesSync(leftover, then, then);
        const model = yield* engine.getReadModel!();
        yield* sweepSecretRequestLeftovers(deps, model.threads);
        assert.deepEqual(
          readdirSync(path.join(root, ".git")).filter((name) => name.startsWith("ryco-")),
          [],
        );
      }),
  );

  it.effect("refuses an answer to an unknown request and a blank value", () =>
    Effect.gen(function* () {
      const { threadId, tools, deps } = yield* setup("blank");
      yield* tools.callTool(session(threadId), AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL, {
        requestId: "blank",
        key: "TOKEN",
        purpose: "Read the API",
        waitMs: 0,
      });
      const unknown = yield* Effect.flip(
        answerSecretRequest(
          deps,
          {
            threadId,
            requestId: secretRequestIdFor(threadId, "never-asked"),
            answer: { type: "decline" },
          },
          LOOPBACK,
        ),
      );
      assert.strictEqual(unknown.reason, "not-found");
      const blank = yield* Effect.flip(
        answerSecretRequest(
          deps,
          {
            threadId,
            requestId: secretRequestIdFor(threadId, "blank"),
            answer: { type: "provide", value: "  \n " },
          },
          LOOPBACK,
        ),
      );
      assert.strictEqual(blank.reason, "empty-value");
      assert.isTrue(yield* hasPendingUserInput(threadId));
    }),
  );
});
