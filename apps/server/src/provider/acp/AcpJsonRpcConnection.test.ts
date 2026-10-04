import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import {
  AcpSessionRuntime,
  type AcpSessionRequestLogEvent,
  type AcpSessionRuntimeOptions,
} from "./AcpSessionRuntime.ts";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const bunExe = "bun";

const runtimeAssistantItemIdPattern = (segmentIndex: number) =>
  new RegExp(`^assistant:mock-session-1:runtime:[0-9a-f-]{36}:segment:${segmentIndex}$`);

const assistantItemRuntimePrefix = (itemId: string) => itemId.replace(/:segment:\d+$/, ":");

/** Starts a scoped runtime, prompts once and returns the first assistant item id. */
const firstAssistantItemIdOfRuntime = (
  options: Pick<AcpSessionRuntimeOptions, "resumeSessionId">,
): Effect.Effect<string, EffectAcpErrors.AcpError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const runtime = yield* AcpSessionRuntime;
    yield* runtime.start();
    yield* runtime.prompt({ prompt: [{ type: "text", text: "hi" }] });
    const started = Array.from(
      yield* Stream.runCollect(
        runtime.getEvents().pipe(
          Stream.filter((event) => event._tag === "AssistantItemStarted"),
          Stream.take(1),
        ),
      ),
    )[0];
    if (started?._tag !== "AssistantItemStarted") {
      return yield* Effect.die(new Error("expected an AssistantItemStarted event"));
    }
    return started.itemId;
  }).pipe(
    Effect.provide(
      AcpSessionRuntime.layer({
        spawn: { command: bunExe, args: [mockAgentPath] },
        cwd: process.cwd(),
        clientInfo: { name: "ryco-test", version: "0.0.0" },
        authMethodId: "test",
        ...options,
      }),
    ),
    Effect.scoped,
  );

describe("AcpSessionRuntime", () => {
  it.live("quarantines session/load history replay without blocking start", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      // The replay produces more parsed events than the runtime's event queue
      // holds, and nothing drains that queue until start() resolves.
      const started = yield* runtime.start().pipe(Effect.timeout("10 seconds"));
      expect(started.sessionId).toBe("mock-session-1");

      yield* runtime.prompt({ prompt: [{ type: "text", text: "hi" }] });
      const notes = Array.from(
        yield* Stream.runCollect(Stream.take(runtime.getEvents(), 6)).pipe(
          Effect.timeout("5 seconds"),
        ),
      );

      // Startup metadata is coalesced to the latest event per kind.
      const metadata = notes.slice(0, 2);
      expect(metadata.map((note) => note._tag).toSorted()).toEqual([
        "CommandsUpdated",
        "UsageUpdated",
      ]);
      const usage = metadata.find((note) => note._tag === "UsageUpdated");
      expect(usage?._tag === "UsageUpdated" ? usage.usage.usedTokens : undefined).toBe(2500);

      // No replayed transcript output precedes the prompt's own events.
      expect(notes.slice(2).map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const assistantStarted = notes[3];
      expect(assistantStarted?._tag).toBe("AssistantItemStarted");
      if (assistantStarted?._tag === "AssistantItemStarted") {
        // The replay consumed no segment indices.
        expect(assistantStarted.itemId).toMatch(runtimeAssistantItemIdPattern(0));
      }
      const assistantDelta = notes[4];
      if (assistantDelta?._tag === "ContentDelta") {
        expect(assistantDelta.text).toBe("hello from mock");
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: { RYCO_ACP_REPLAY_HISTORY_CHUNKS: "2500" },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          clientInfo: { name: "ryco-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("mints distinct assistant item ids for each runtime of the same session", () =>
    Effect.gen(function* () {
      // Runtime A creates the session; runtime B resumes it via session/load.
      const idA = yield* firstAssistantItemIdOfRuntime({});
      const idB = yield* firstAssistantItemIdOfRuntime({ resumeSessionId: "mock-session-1" });

      expect(idA).toMatch(runtimeAssistantItemIdPattern(0));
      expect(idB).toMatch(runtimeAssistantItemIdPattern(0));
      expect(idB).not.toBe(idA);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("passes resolved MCP servers to session/new after initialize negotiation", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      const setup = requestEvents.find(
        (event) => event.method === "session/new" && event.status === "started",
      );
      expect(setup?.payload).toMatchObject({
        mcpServers: [
          {
            type: "http",
            name: "ryco",
            url: "http://127.0.0.1:45000/mcp",
          },
        ],
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: { command: bunExe, args: [mockAgentPath] },
          cwd: process.cwd(),
          clientInfo: { name: "ryco-test", version: "0.0.0" },
          authMethodId: "test",
          resolveMcpServers: () =>
            Effect.succeed([
              {
                type: "http" as const,
                name: "ryco",
                url: "http://127.0.0.1:45000/mcp",
                headers: [{ name: "Authorization", value: "Bearer test" }],
              },
            ]),
          requestLogger: (event) => Effect.sync(() => requestEvents.push(event)),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("retries session/new without Agent Control when MCP setup fails", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    let cleanupCalls = 0;
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionId).toBe("mock-session-1");
      expect(cleanupCalls).toBe(1);
      const setupPayloads = requestEvents
        .filter((event) => event.method === "session/new" && event.status === "started")
        .map((event) => event.payload as { mcpServers: ReadonlyArray<unknown> });
      expect(setupPayloads).toHaveLength(2);
      expect(setupPayloads[0]?.mcpServers).toHaveLength(1);
      expect(setupPayloads[1]?.mcpServers).toHaveLength(0);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: { RYCO_ACP_FAIL_MCP_SETUP_ONCE: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "ryco-test", version: "0.0.0" },
          authMethodId: "test",
          resolveMcpServers: () =>
            Effect.succeed([{ name: "ryco", command: "proxy", args: [], env: [] }]),
          onMcpSetupFailure: () => Effect.sync(() => cleanupCalls++),
          requestLogger: (event) => Effect.sync(() => requestEvents.push(event)),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("preserves static MCP servers when resolved Agent Control setup falls back", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    let cleanupCalls = 0;
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      const setupPayloads = requestEvents
        .filter((event) => event.method === "session/new" && event.status === "started")
        .map(
          (event) =>
            event.payload as {
              mcpServers: ReadonlyArray<{ readonly name: string }>;
            },
        );
      expect(
        setupPayloads.map((payload) => payload.mcpServers.map((server) => server.name)),
      ).toEqual([["ryco-device", "ryco"], ["ryco-device"]]);
      expect(cleanupCalls).toBe(1);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: { RYCO_ACP_FAIL_MCP_SETUP_ONCE: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "ryco-test", version: "0.0.0" },
          authMethodId: "test",
          mcpServers: [
            {
              type: "http",
              name: "ryco-device",
              url: "http://127.0.0.1:46000/mcp",
              headers: [],
            },
          ],
          resolveMcpServers: () =>
            Effect.succeed([{ name: "ryco", command: "proxy", args: [], env: [] }]),
          onMcpSetupFailure: () => Effect.sync(() => cleanupCalls++),
          requestLogger: (event) => Effect.sync(() => requestEvents.push(event)),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("merges custom initialize client capabilities into the ACP handshake", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const initializeStarted = requestEvents.find(
        (event) => event.method === "initialize" && event.status === "started",
      );
      expect(initializeStarted?.payload).toMatchObject({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { parameterizedModelPicker: true },
        },
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "ryco-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("starts a session, prompts, and emits normalized events against the mock agent", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.initializeResult).toMatchObject({ protocolVersion: 1 });
      expect(started.sessionId).toBe("mock-session-1");

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes).toHaveLength(4);
      expect(notes.map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const planUpdate = notes.find((note) => note._tag === "PlanUpdated");
      expect(planUpdate?._tag).toBe("PlanUpdated");
      if (planUpdate?._tag === "PlanUpdated") {
        expect(planUpdate.payload.plan).toHaveLength(2);
      }
      const assistantStart = notes[1];
      const assistantDelta = notes[2];
      if (
        assistantStart?._tag === "AssistantItemStarted" &&
        assistantDelta?._tag === "ContentDelta"
      ) {
        expect(assistantDelta.itemId).toBe(assistantStart.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "ryco-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("segments assistant text around ACP tool calls", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 7)));
      expect(notes.map((note) => note._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
        "ToolCallUpdated",
        "ToolCallUpdated",
        "AssistantItemStarted",
        "ContentDelta",
      ]);

      const firstStarted = notes[0];
      const firstDelta = notes[1];
      const firstCompleted = notes[2];
      const secondStarted = notes[5];
      const secondDelta = notes[6];
      expect(firstStarted?._tag).toBe("AssistantItemStarted");
      expect(firstCompleted?._tag).toBe("AssistantItemCompleted");
      expect(secondStarted?._tag).toBe("AssistantItemStarted");
      if (
        firstStarted?._tag === "AssistantItemStarted" &&
        firstDelta?._tag === "ContentDelta" &&
        firstCompleted?._tag === "AssistantItemCompleted" &&
        secondStarted?._tag === "AssistantItemStarted" &&
        secondDelta?._tag === "ContentDelta"
      ) {
        expect(firstDelta.itemId).toBe(firstStarted.itemId);
        expect(firstCompleted.itemId).toBe(firstStarted.itemId);
        expect(secondStarted.itemId).not.toBe(firstStarted.itemId);
        expect(secondDelta.itemId).toBe(secondStarted.itemId);
        expect(firstStarted.itemId).toMatch(runtimeAssistantItemIdPattern(0));
        expect(secondStarted.itemId).toMatch(runtimeAssistantItemIdPattern(1));
        // Both segments belong to one runtime, so they share its runtime prefix.
        expect(assistantItemRuntimePrefix(secondStarted.itemId)).toBe(
          assistantItemRuntimePrefix(firstStarted.itemId),
        );
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              RYCO_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "ryco-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("suppresses generic placeholder tool updates until completion", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 1)));
      expect(notes.map((note) => note._tag)).toEqual(["ToolCallUpdated"]);
      const toolCall = notes[0];
      expect(toolCall?._tag).toBe("ToolCallUpdated");
      if (toolCall?._tag === "ToolCallUpdated") {
        expect(toolCall.toolCall.status).toBe("completed");
        expect(toolCall.toolCall.title).toBe("Read file");
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              RYCO_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "ryco-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("logs ACP requests from the shared runtime", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.setModel("composer-2");
      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "succeeded",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "succeeded",
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "ryco-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("skips no-op session config writes when the requested value is already active", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.setConfigOption("model", "default");
      yield* runtime.setMode("ask");

      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "ryco-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("emits low-level ACP protocol logs for raw and decoded messages", () => {
    const protocolEvents: Array<EffectAcpProtocol.AcpProtocolLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "decoded"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "decoded"),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "ryco-test", version: "0.0.0" },
          protocolLogging: {
            logIncoming: true,
            logOutgoing: true,
            logger: (event) =>
              Effect.sync(() => {
                protocolEvents.push(event);
              }),
          },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("rejects invalid config option values before sending session/set_config_option", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "acp-runtime-"));
    const requestLogPath = path.join(tempDir, "requests.ndjson");
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const error = yield* runtime.setModel("composer-2[fast=false]").pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.code).toBe(-32602);
        expect(error.message).toContain(
          'Invalid value "composer-2[fast=false]" for session config option "model"',
        );
        expect(error.message).toContain("composer-2[fast=true]");
      }

      const recordedRequests = readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: { value?: unknown } });
      expect(
        recordedRequests.some(
          (message) =>
            message.method === "session/set_config_option" &&
            message.params?.value === "composer-2[fast=false]",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              RYCO_ACP_REQUEST_LOG_PATH: requestLogPath,
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "ryco-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(tempDir, { recursive: true, force: true }))),
    );
  });
});
