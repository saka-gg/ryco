/** Heap one live provider session keeps through a long turn, driven through the real adapter.
 * node --expose-gc apps/server/scripts/measure-adapter-retention.ts <claude|copilot> [rounds=2000] [bytes=20000]
 * claude: each round is a root assistant message (1 KB text + tool_use) and a tool_result of
 * `bytes` chars. copilot: each round is a tool start and a tool completion with a `bytes`-char
 * result. Payloads are unique flat strings; runtime events are drained, never kept. Prints one
 * JSON line; "retained*Mb" is heapUsed after full GCs minus heapUsed before the turn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { Effect, Layer, Schema } from "effect";
import { ServerConfig } from "../src/config.ts";
import { makeClaudeAdapter } from "../src/provider/Layers/ClaudeAdapter.ts";
import { makeCopilotAdapter } from "../src/provider/Layers/CopilotAdapter.ts";
import {
  drainRuntimeEvents,
  makeRetentionProbe,
  settleHeap,
  type RetentionProbe,
} from "../src/provider/testUtils/adapterRetention.ts";
import {
  makeFakeCopilotClient,
  type FakeCopilotClient,
} from "../src/provider/testUtils/fakeCopilotClient.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";

const adapterName = process.argv[2];
const rounds = Number(process.argv[3] ?? 2000);
const bytes = Number(process.argv[4] ?? 20_000);
if (adapterName !== "claude" && adapterName !== "copilot") {
  throw new Error("usage: measure-adapter-retention.ts <claude|copilot> [rounds] [bytes]");
}
if (!Number.isSafeInteger(rounds) || rounds < 1 || !Number.isSafeInteger(bytes) || bytes < 1) {
  throw new Error("rounds and bytes must be positive integers");
}

const mb = (value: number) => Math.round((value / 1_048_576) * 10) / 10;
const heapUsed = async () => {
  await settleHeap();
  return process.memoryUsage().heapUsed;
};

/** An SDK query that yields what the script emits; enough of the Query surface for a turn. */
class FakeClaudeQuery {
  readonly queue: Array<unknown> = [];
  readonly waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  done = false;
  emit(message: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.queue.push(message);
  }
  finish(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  interrupt = async () => undefined;
  stopTask = async () => undefined;
  setModel = async () => undefined;
  setPermissionMode = async () => undefined;
  setMaxThinkingTokens = async () => undefined;
  close = () => this.finish();
  mcpServerStatus = async () => [];
  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        if (this.queue.length > 0)
          return Promise.resolve({ done: false, value: this.queue.shift() });
        if (this.done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// Plain functions: an Effect.gen frame would keep its last round's payloads alive.
function emitClaudeRound(
  query: FakeClaudeQuery,
  results: RetentionProbe,
  bodies: RetentionProbe,
  round: number,
): void {
  const toolUseId = `toolu_${round}`;
  query.emit({
    type: "assistant",
    session_id: "measure-session",
    uuid: `assistant-${round}`,
    parent_tool_use_id: null,
    message: bodies.track({
      id: `msg-${round}`,
      role: "assistant",
      model: "claude-measure",
      content: [
        { type: "text", text: bodies.payload(1_000) },
        { type: "tool_use", id: toolUseId, name: "Read", input: { file_path: `/f${round}` } },
      ],
    }),
  });
  query.emit({
    type: "user",
    session_id: "measure-session",
    uuid: `user-${round}`,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        results.track({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: results.payload(bytes),
        }),
      ],
    },
  });
}

const claudeSentinel = (tag: string) => ({
  type: "stream_event",
  session_id: "measure-session",
  uuid: `sentinel-${tag}`,
  parent_tool_use_id: null,
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: `sentinel-${tag}` },
  },
});

interface Samples {
  readonly before: number;
  readonly midTurn: number;
  readonly whileLive: number;
  readonly afterStop: number;
  readonly reachableMidTurn: Record<string, number>;
  readonly reachableWhileLive: Record<string, number>;
}

const isDelta = (text: string) => (event: ProviderRuntimeEvent) =>
  event.type === "content.delta" && event.payload.delta === text;
const isTurnCompleted = (event: ProviderRuntimeEvent) => event.type === "turn.completed";

const measureClaude = Effect.gen(function* () {
  const query = new FakeClaudeQuery();
  const results = makeRetentionProbe();
  const bodies = makeRetentionProbe();
  const adapter = yield* makeClaudeAdapter(Schema.decodeSync(ClaudeSettings)({}), {
    createQuery: () => query as never,
  });
  const events = yield* drainRuntimeEvents(adapter.streamEvents);
  const threadId = ThreadId.make("measure-claude-thread");
  yield* adapter.startSession({
    runtimeSessionId: RuntimeSessionId.make("measure-claude-runtime"),
    threadId,
    provider: ProviderDriverKind.make("claudeAgent"),
    runtimeMode: "full-access",
  });
  const before = yield* Effect.promise(heapUsed);
  yield* adapter.sendTurn({ threadId, input: "go", attachments: [] });
  const sentinelSeen = events.expect(isDelta("sentinel-mid"));
  for (let round = 0; round < rounds; round += 1) emitClaudeRound(query, results, bodies, round);
  query.emit(claudeSentinel("mid"));
  yield* sentinelSeen;
  const midTurn = yield* Effect.promise(heapUsed);
  const reachableMidTurn = {
    toolResults: yield* Effect.promise(results.reachable),
    assistantBodies: yield* Effect.promise(bodies.reachable),
  };
  const completed = events.expect(isTurnCompleted);
  query.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    errors: [],
    session_id: "measure-session",
    uuid: "result-1",
  });
  yield* completed;
  const whileLive = yield* Effect.promise(heapUsed);
  const reachableWhileLive = {
    toolResults: yield* Effect.promise(results.reachable),
    assistantBodies: yield* Effect.promise(bodies.reachable),
  };
  yield* adapter.stopSession(threadId);
  const afterStop = yield* Effect.promise(heapUsed);
  return { before, midTurn, whileLive, afterStop, reachableMidTurn, reachableWhileLive };
});

function sendCopilotRound(
  copilot: FakeCopilotClient,
  results: RetentionProbe,
  round: number,
): void {
  const toolCallId = `call-${round}`;
  copilot.send("tool.execution_start", {
    toolCallId,
    toolName: "bash",
    arguments: { command: `cat f${round}` },
  });
  results.track(
    copilot.send("tool.execution_complete", {
      toolCallId,
      success: true,
      result: { content: results.payload(bytes) },
    }),
  );
}

const measureCopilot = Effect.gen(function* () {
  const copilot = makeFakeCopilotClient("measure-copilot-session");
  const results = makeRetentionProbe();
  const instanceId = ProviderInstanceId.make("copilot");
  const adapter = yield* makeCopilotAdapter(
    { binaryPath: "copilot" },
    { instanceId, clientFactory: () => copilot.client as never },
  );
  const events = yield* drainRuntimeEvents(adapter.streamEvents);
  const threadId = ThreadId.make("measure-copilot-thread");
  yield* adapter.startSession({
    provider: ProviderDriverKind.make("copilot"),
    providerInstanceId: instanceId,
    runtimeSessionId: RuntimeSessionId.make("measure-copilot-runtime"),
    threadId,
    runtimeMode: "full-access",
  });
  const before = yield* Effect.promise(heapUsed);
  copilot.send("assistant.turn_start", { turnId: "turn-1" });
  // Mid-turn: every tool completion was seen on the drained stream, before assistant.turn_end.
  const toolsCompleted = events.expect(
    (event) => event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
    rounds,
  );
  const sentinelSeen = events.expect(isDelta("sentinel-mid"));
  for (let round = 0; round < rounds; round += 1) sendCopilotRound(copilot, results, round);
  copilot.send("assistant.message_delta", { messageId: "m-1", deltaContent: "sentinel-mid" });
  yield* toolsCompleted;
  yield* sentinelSeen;
  const midTurn = yield* Effect.promise(heapUsed);
  const reachableMidTurn = { toolResults: yield* Effect.promise(results.reachable) };
  const completed = events.expect(isTurnCompleted);
  copilot.send("assistant.turn_end", { turnId: "turn-1" });
  copilot.send("session.idle", {});
  yield* completed;
  const whileLive = yield* Effect.promise(heapUsed);
  const reachableWhileLive = { toolResults: yield* Effect.promise(results.reachable) };
  yield* adapter.stopSession(threadId);
  const afterStop = yield* Effect.promise(heapUsed);
  return { before, midTurn, whileLive, afterStop, reachableMidTurn, reachableWhileLive };
});

const sum = (counts: Record<string, number>) =>
  Object.values(counts).reduce((total, count) => total + count, 0);

const home = mkdtempSync(join(tmpdir(), "ryco-measure-adapter-retention-"));
try {
  const samples: Samples = await Effect.runPromise(
    (adapterName === "claude" ? measureClaude : measureCopilot).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(ServerConfig.layerTest(home, home), ServerSettingsService.layerTest()).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
  console.log(
    JSON.stringify({
      adapter: adapterName,
      node: process.version,
      rounds,
      bytesPerResult: bytes,
      payloadMb: mb(rounds * bytes),
      retainedMidTurnMb: mb(samples.midTurn - samples.before),
      retainedWhileLiveMb: mb(samples.whileLive - samples.before),
      retainedAfterStopMb: mb(samples.afterStop - samples.before),
      reachableMidTurn: sum(samples.reachableMidTurn),
      reachableWhileLive: sum(samples.reachableWhileLive),
      reachableMidTurnByKind: samples.reachableMidTurn,
      reachableWhileLiveByKind: samples.reachableWhileLive,
    }),
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exit(0);
