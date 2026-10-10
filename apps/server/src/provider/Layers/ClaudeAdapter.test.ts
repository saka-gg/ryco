import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ClaudeSettings,
  MessageId,
  ProviderDriverKind,
  ProviderItemId,
  ProviderRuntimeEvent,
  type RuntimeMode,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  RuntimeSessionId,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { assert, describe, it, vi } from "@effect/vitest";
import { TestClock } from "effect/testing";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Random,
  Redacted,
  Schema,
  Stream,
} from "effect";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { installProcessDeviceToolGateway } from "../../providerTools/deviceToolGateway.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import {
  makeClaudeAdapter,
  type ClaudeAdapterLiveOptions,
  type ClaudeTranscriptEntry,
} from "./ClaudeAdapter.ts";
import type { AgentControlProviderBridge } from "../../agentControl/ProviderInjection.ts";

// Test-local service tag so the rest of the file can keep using `yield* ClaudeAdapter`.
class ClaudeAdapter extends Context.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "test/ClaudeAdapter",
) {}

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  /** The arguments of each interrupt call; `[]` is the plain `interrupt()`. */
  public readonly interruptCalls: Array<ReadonlyArray<unknown>> = [];
  /** What interrupt resolves to (the CLI's receipt). */
  public interruptReceipt: unknown = undefined;
  /** Runs inside interrupt, before it resolves: the CLI writing frames ahead of the receipt. */
  public onInterrupt: (() => void) | undefined;
  /** While set, interrupt parks on it before resolving with the receipt. */
  public interruptGate: Promise<void> | undefined;
  public readonly stopTaskCalls: Array<string> = [];
  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  public readonly setMaxThinkingTokensCalls: Array<number | null> = [];
  public readonly applyFlagSettingsCalls: Array<Record<string, unknown>> = [];
  public readonly applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>;
  public closeCalls = 0;
  public mcpStatuses: ReadonlyArray<{ readonly name: string; readonly status: string }> = [];
  /** While set, setPermissionMode parks on it before recording the call. */
  public permissionModeGate: Promise<void> | undefined;
  private readonly permissionModeWaiters: Array<() => void> = [];

  constructor(supportsAutomaticCompaction = false) {
    if (supportsAutomaticCompaction) {
      this.applyFlagSettings = async (settings) => {
        this.applyFlagSettingsCalls.push(settings);
      };
    }
  }

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  readonly interrupt = async (...args: ReadonlyArray<unknown>): Promise<unknown> => {
    this.interruptCalls.push(args);
    const receipt = this.interruptReceipt;
    this.onInterrupt?.();
    if (this.interruptGate) await this.interruptGate;
    return receipt;
  };

  readonly stopTask = async (taskId: string): Promise<void> => {
    this.stopTaskCalls.push(taskId);
  };

  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
  };

  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    for (const notify of this.permissionModeWaiters.splice(0)) notify();
    if (this.permissionModeGate) await this.permissionModeGate;
    this.setPermissionModeCalls.push(mode);
  };

  /** Resolves once the next setPermissionMode call has started. */
  permissionModeEntered(): Promise<void> {
    return new Promise((resolve) => this.permissionModeWaiters.push(resolve));
  }

  readonly setMaxThinkingTokens = async (maxThinkingTokens: number | null): Promise<void> => {
    this.setMaxThinkingTokensCalls.push(maxThinkingTokens);
  };

  readonly close = (): void => {
    this.closeCalls += 1;
    this.finish();
  };

  readonly mcpServerStatus = async () => this.mcpStatuses;

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}

function makeHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly claudeConfig?: Partial<ClaudeSettings>;
  readonly instanceId?: ProviderInstanceId;
  readonly agentControl?: AgentControlProviderBridge;
  readonly supportsAutomaticCompaction?: boolean;
  readonly runtimeEventQueueCapacity?: number;
}) {
  const query = new FakeClaudeQuery(config?.supportsAutomaticCompaction);
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    ...(config?.instanceId ? { instanceId: config.instanceId } : {}),
    ...(config?.agentControl ? { agentControl: config.agentControl } : {}),
    ...(config?.runtimeEventQueueCapacity !== undefined
      ? { runtimeEventQueueCapacity: config.runtimeEventQueueCapacity }
      : {}),
    createQuery: (input) => {
      createInput = input;
      return query;
    },
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
  };

  return {
    layer: Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = Schema.decodeSync(ClaudeSettings)(config?.claudeConfig ?? {});
        return yield* makeClaudeAdapter(claudeConfig, adapterOptions);
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.baseDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    getLastCreateQueryInput: () => createInput,
  };
}

class ProbedFakeClaudeQuery extends FakeClaudeQuery {
  public failInit = false;
  /** While set, initializationResult waits on it. */
  public initGate: Promise<void> | undefined;
  public initCalls = 0;

  readonly initializationResult = async (): Promise<unknown> => {
    this.initCalls += 1;
    if (this.initGate) await this.initGate;
    if (this.failInit) throw new Error("Resume rejected by the test CLI.");
    return {};
  };
}

/** Every createQuery returns a new query, so session reopens can be observed. */
function makeSequencedHarness() {
  const queries: Array<ProbedFakeClaudeQuery> = [];
  const inputs: Array<{
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }> = [];
  const transcriptReads: Array<{
    readonly sessionId: string;
    readonly dir?: string;
    readonly includeSystemMessages: boolean;
  }> = [];
  let transcript: ReadonlyArray<ClaudeTranscriptEntry> = [];
  let onCreate: ((query: ProbedFakeClaudeQuery, index: number) => void) | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    createQuery: (input) => {
      const query = new ProbedFakeClaudeQuery();
      queries.push(query);
      inputs.push(input);
      onCreate?.(query, queries.length - 1);
      return query;
    },
    readSessionMessages: async (sessionId, options) => {
      transcriptReads.push({ sessionId, ...options });
      return transcript;
    },
  };

  return {
    layer: Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = Schema.decodeSync(ClaudeSettings)({});
        return yield* makeClaudeAdapter(claudeConfig, adapterOptions);
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
    queries,
    inputs,
    transcriptReads,
    setTranscript: (entries: ReadonlyArray<ClaudeTranscriptEntry>) => {
      transcript = entries;
    },
    setOnCreate: (callback: (query: ProbedFakeClaudeQuery, index: number) => void) => {
      onCreate = callback;
    },
  };
}

function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  if (typeof next.value.message.content === "string") {
    return next.value.message.content;
  }
  const content = next.value.message.content[0];
  if (!content || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}

const THREAD_ID = ThreadId.make("thread-claude-1");
const RESUME_THREAD_ID = ThreadId.make("thread-claude-resume");

function emitClaudeUsage(
  query: FakeClaudeQuery,
  input: { readonly id: string; readonly usedTokens: number },
): void {
  query.emit({
    type: "system",
    subtype: "task_progress",
    task_id: `task-${input.id}`,
    description: "Working",
    usage: { total_tokens: input.usedTokens },
    session_id: `sdk-session-${input.id}`,
    uuid: `usage-${input.id}`,
  } as unknown as SDKMessage);
}

function emitClaudeSuccessfulResult(
  query: FakeClaudeQuery,
  input: { readonly id: string; readonly usedTokens: number; readonly contextWindow?: number },
): void {
  query.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 8,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    session_id: `sdk-session-${input.id}`,
    usage: { total_tokens: input.usedTokens },
    ...(input.contextWindow
      ? {
          modelUsage: {
            "claude-opus-4-6": {
              contextWindow: input.contextWindow,
              maxOutputTokens: 64_000,
            },
          },
        }
      : {}),
  } as unknown as SDKMessage);
}

function makeAgentControlBridge() {
  const rawCredential = `rycoac_${"a".repeat(43)}`;
  const revokeLease = vi.fn(
    (_input: Parameters<AgentControlProviderBridge["revokeLease"]>[0]) => Effect.void,
  );
  const bindTurnAuthority = vi.fn(({ sessionId, turnId }) =>
    Effect.succeed({ sessionId, threadId: THREAD_ID, turnId, boundAt: new Date().toISOString() }),
  );
  const retireTurnAuthority = vi.fn(() => Effect.void);
  const bridge: AgentControlProviderBridge = {
    issueLease: () =>
      Effect.succeed(
        Option.some({
          sessionId: "claude-agent-control-session",
          endpointUrl: "http://127.0.0.1:45000/mcp",
          credential: Redacted.make(rawCredential),
        }),
      ),
    issueStdioBootstrap: () => Effect.succeed(Option.none()),
    revokeLease,
    bindTurnAuthority,
    retireTurnAuthority,
  };
  return { bridge, rawCredential, revokeLease, bindTurnAuthority, retireTurnAuthority };
}

describe("ClaudeAdapterLive", () => {
  it.effect("composes device and Agent Control MCP servers in one Claude session", () => {
    const state = makeAgentControlBridge();
    const harness = makeHarness({ agentControl: state.bridge });
    harness.query.mcpStatuses = [{ name: "ryco", status: "connected" }];
    const dispose = vi.fn(() => undefined);
    return Effect.gen(function* () {
      installProcessDeviceToolGateway({
        createBinding: () => ({
          url: "http://127.0.0.1:46000/device",
          headers: { Authorization: "Bearer device-token" },
          dispose,
        }),
        close: async () => undefined,
      });
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("runtime-claude-mcp-composition"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      const servers = harness.getLastCreateQueryInput()?.options.mcpServers;
      assert.deepStrictEqual(servers?.ryco_device, {
        type: "http",
        url: "http://127.0.0.1:46000/device",
        headers: { Authorization: "Bearer device-token" },
        alwaysLoad: true,
      });
      assert.isDefined(servers?.ryco);
      yield* adapter.stopSession(THREAD_ID);
      assert.strictEqual(dispose.mock.calls.length, 1);
    }).pipe(
      Effect.ensuring(Effect.sync(() => installProcessDeviceToolGateway(null))),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("installs native session MCP, binds turns, and revokes on teardown", () => {
    const state = makeAgentControlBridge();
    const harness = makeHarness({ agentControl: state.bridge });
    harness.query.mcpStatuses = [{ name: "ryco", status: "connected" }];
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("runtime-claude-agent-control"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      const options = harness.getLastCreateQueryInput()?.options;
      assert.deepStrictEqual(options?.mcpServers?.ryco, {
        type: "http",
        url: "http://127.0.0.1:45000/mcp",
        headers: { Authorization: `Bearer ${state.rawCredential}` },
        alwaysLoad: true,
      });
      assert.notInclude(JSON.stringify(options?.env), state.rawCredential);

      const prompt = Effect.promise(() => readFirstPromptText(harness.getLastCreateQueryInput()));
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Inspect" });
      assert.include((yield* prompt) ?? "", "Ryco Agent Control tools");
      assert.strictEqual(state.bindTurnAuthority.mock.calls.length, 1);
      yield* adapter.stopSession(THREAD_ID);
      assert.isAtLeast(state.revokeLease.mock.calls.length, 1);
      assert.strictEqual(
        state.revokeLease.mock.calls[0]?.[0].sessionId,
        "claude-agent-control-session",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("degrades to unavailable host context when Claude MCP connection fails", () => {
    const state = makeAgentControlBridge();
    const harness = makeHarness({ agentControl: state.bridge });
    harness.query.mcpStatuses = [{ name: "ryco", status: "failed" }];
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("runtime-claude-agent-control-failed"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });
      const prompt = Effect.promise(() => readFirstPromptText(harness.getLastCreateQueryInput()));
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Continue" });
      assert.include((yield* prompt) ?? "", "unavailable for this provider session");
      assert.strictEqual(state.bindTurnAuthority.mock.calls.length, 0);
      assert.isAtLeast(state.revokeLease.mock.calls.length, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter
        .startSession({
          runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-1"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("codex"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("derives bypass permission mode from full-access runtime policy", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-2"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("derives auto permission mode from auto runtime policy without skip flag", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-3"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "auto",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "auto");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("loads Claude filesystem settings sources for SDK sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-4"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, undefined);
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses bypass permissions for full-access claude sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-5"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude effort levels into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-6"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("runs Claude SDK sessions with the configured Claude HOME", () => {
    const harness = makeHarness({ claudeConfig: { homePath: "~/.claude-work" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-7"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.env?.HOME, path.join(os.homedir(), ".claude-work"));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses the Claude Opus 4.7 default xhigh effort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-8"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-7",
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "xhigh");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses high as the Claude Opus 4.8 default effort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-9"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-8",
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude Opus 4.8 ultracode as xhigh effort with settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-10"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-8",
          [{ id: "effort", value: "ultracode" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "xhigh");
      assert.deepEqual(createInput?.options.settings, {
        ultracode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude Fable 5 ultracode as xhigh effort with settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-fable-ultracode"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "effort", value: "ultracode" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "xhigh");
      assert.deepEqual(createInput?.options.settings, {
        ultracode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes xhigh effort through for Claude Opus models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-11"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-7",
          [{ id: "effort", value: "xhigh" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "xhigh");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Sonnet 4.6 max effort to the SDK-supported high value", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-12"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores adaptive effort for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-13"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-haiku-4-5",
          [{ id: "effort", value: "high" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude thinking toggle into SDK settings for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-14"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-haiku-4-5",
          [{ id: "thinking", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        alwaysThinkingEnabled: false,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores Claude thinking toggle for non-Haiku models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-15"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "thinking", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude fast mode into SDK settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-16"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        fastMode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores claude fast mode for non-opus models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-17"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("asks Claude Code for summarized thinking explicitly", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-thinking-display"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // SDK sessions fall back to omitted thinking unless the CLI flag is set.
      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.extraArgs?.["thinking-display"], "summarized");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("normalizes a retired ultrathink selection without injecting a prompt keyword", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-18"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "ultrathink" }],
        ),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Investigate the edge cases",
        attachments: [],
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "ultrathink" }],
        ),
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
      const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
      assert.equal(promptText, "Investigate the edge cases");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("embeds image attachments in Claude user messages", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment)!);
      mkdirSync(path.dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-19"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "What's in this image?",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "text",
          text: "What's in this image?",
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sends PDF file attachments as Anthropic document blocks", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-attachments-pdf-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments-pdf",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "file" as const,
        id: "thread-claude-pdf-12345678-1234-1234-1234-123456789abc",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      };
      const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment)!);
      mkdirSync(path.dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-pdf"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Summarize the report",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "text",
          text: "Summarize the report",
        },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "AQIDBA==",
          },
          title: "report.pdf",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("degrades non-native file attachments to on-disk path lines", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-attachments-pathline-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments-pathline",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const textFile = {
        type: "file" as const,
        id: "thread-claude-notes-12345678-1234-1234-1234-123456789abc",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      };
      const bitmap = {
        type: "image" as const,
        id: "thread-claude-bmp-12345678-1234-1234-1234-123456789abc",
        name: "diagram.bmp",
        mimeType: "image/bmp",
        sizeBytes: 2,
      };
      const textPath = path.join(attachmentsDir, attachmentRelativePath(textFile)!);
      mkdirSync(path.dirname(textPath), { recursive: true });
      writeFileSync(textPath, Uint8Array.from([1, 2, 3]));

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-pathline"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Use these",
        attachments: [textFile, bitmap],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      const content = promptMessage?.message.content;
      assert.isArray(content);
      assert.lengthOf(content ?? [], 1);
      const textBlock = content?.[0] as { type: string; text: string };
      assert.equal(textBlock.type, "text");
      assert.include(
        textBlock.text,
        `[Attached file] notes.txt (text/plain, 3 bytes) saved at: ${textPath}`,
      );
      assert.include(textBlock.text, "[Attached file] diagram.bmp (image/bmp, 2 bytes) saved at:");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("reports a blocking_limit success result as a usage_limit failure", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-usage-limit"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Claude AI usage limit reached",
        terminal_reason: "blocking_limit",
        api_error_status: 429,
        session_id: "sdk-session-usage-limit",
        uuid: "result-usage-limit",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(
        yield* Fiber.join(runtimeEventsFiber).pipe(Effect.timeout("1 second")),
      );
      const errorIndex = runtimeEvents.findIndex((event) => event.type === "runtime.error");
      const completedIndex = runtimeEvents.findIndex((event) => event.type === "turn.completed");
      assert.notEqual(errorIndex, -1);
      assert.ok(errorIndex < completedIndex);
      const error = runtimeEvents[errorIndex];
      if (error?.type !== "runtime.error") return;
      assert.equal(String(error.turnId), String(turn.turnId));
      assert.equal(error.payload.class, "usage_limit");
      assert.equal(error.payload.message, "Claude AI usage limit reached");
      assert.equal(error.payload.resetAt, null);
      const completed = runtimeEvents[completedIndex];
      if (completed?.type !== "turn.completed") return;
      assert.equal(completed.payload.state, "failed");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude stream/runtime messages to canonical provider runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(10),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-20"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-5",
        },
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-0",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-3",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "ls",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-4",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        uuid: "result-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(
        yield* Fiber.join(runtimeEventsFiber).pipe(Effect.timeout("1 second")),
      );
      assert.equal(
        runtimeEvents.every(
          (event) =>
            event.providerInstanceId === ProviderInstanceId.make("claudeAgent") &&
            event.runtimeSessionId === session.runtimeSessionId,
        ),
        true,
      );
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = runtimeEvents[3];
      assert.equal(turnStarted?.type, "turn.started");
      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Hi");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      const assistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      assert.equal(
        assistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          assistantCompletedIndex < toolStartedIndex,
        true,
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits a reasoning item lifecycle around each thinking block", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-thinking-items"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const streamEvent = (uuid: string, event: Record<string, unknown>) =>
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-thinking-items",
          uuid,
          parent_tool_use_id: null,
          event,
        } as unknown as SDKMessage);

      streamEvent("thinking-start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      streamEvent("thinking-delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Check the reconnect path." },
      });
      streamEvent("thinking-stop", { type: "content_block_stop", index: 0 });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-thinking-items",
        uuid: "result-thinking-items",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "item.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const started = runtimeEvents.find((event) => event.type === "item.started");
      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      const completed = runtimeEvents.find((event) => event.type === "item.completed");
      assert.equal(started?.type === "item.started" ? started.payload.itemType : null, "reasoning");
      assert.equal(
        completed?.type === "item.completed" ? completed.payload.itemType : null,
        "reasoning",
      );
      // One item id ties the block's start, its text and its end together.
      assert.ok(started?.itemId);
      assert.equal(String(delta?.itemId), String(started?.itemId));
      assert.equal(String(completed?.itemId), String(started?.itemId));
      assert.equal(String(started?.turnId), String(turn.turnId));
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.streamKind, "reasoning_text");
        assert.equal(delta.payload.delta, "Check the reconnect path.");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude reasoning deltas, streamed tool inputs, and tool results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-21"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Let",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-input-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"pattern":"foo","path":"src"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-tool-streams",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-grep-1",
              content: "src/example.ts:1:foo",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-tool-streams",
        uuid: "result-tool-streams",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "turn.completed",
        ],
      );

      const reasoningDelta = runtimeEvents.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Let");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
      }

      const toolInputUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { pattern?: string; path?: string } } | undefined)?.input
            ?.pattern === "foo",
      );
      assert.equal(toolInputUpdated?.type, "item.updated");
      if (toolInputUpdated?.type === "item.updated") {
        assert.deepEqual(toolInputUpdated.payload.data, {
          toolName: "Grep",
          input: {
            pattern: "foo",
            path: "src",
          },
        });
      }

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { result?: { tool_use_id?: string } } | undefined)?.result
            ?.tool_use_id === "tool-grep-1",
      );
      assert.equal(toolResultUpdated?.type, "item.updated");
      if (toolResultUpdated?.type === "item.updated") {
        assert.equal(
          (
            toolResultUpdated.payload.data as {
              result?: { content?: string };
            }
          ).result?.content,
          "src/example.ts:1:foo",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("shows Ryco HTML tool calls as short labels without the page markup", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-html-render"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "chart it", attachments: [] });

      const input = JSON.stringify({
        html: "<!doctype html><script>drawSecretChart()</script>",
        title: "Quarterly revenue",
        height: 420,
      });
      const stream = (uuid: string, event: unknown) =>
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-html",
          uuid,
          parent_tool_use_id: null,
          event,
        } as unknown as SDKMessage);
      stream("html-start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool-html-1",
          name: "mcp__ryco__ryco_html_render",
          input: {},
        },
      });
      stream("html-input-1", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: input.slice(0, 30) },
      });
      stream("html-input-2", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: input.slice(30) },
      });
      stream("html-stop", { type: "content_block_stop", index: 0 });
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-html",
        uuid: "html-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-html-1", content: "Shown to the reader." },
          ],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-html",
        uuid: "html-turn-result",
      } as unknown as SDKMessage);

      const toolEvents = Array.from(yield* Fiber.join(runtimeEventsFiber)).filter(
        (event) =>
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed",
      );
      assert.deepEqual(
        toolEvents.map((event) => [event.type, event.payload.title, event.payload.detail]),
        [
          ["item.started", "Rendered HTML", undefined],
          ["item.updated", "Rendered HTML", "Quarterly revenue"],
          ["item.updated", "Rendered HTML", "Quarterly revenue"],
          ["item.completed", "Rendered HTML", "Quarterly revenue"],
        ],
      );
      for (const event of toolEvents) {
        assert.equal(event.payload.itemType, "mcp_tool_call");
        assert.notInclude(JSON.stringify(event.payload), "drawSecretChart");
      }
      assert.deepEqual((toolEvents[1]!.payload.data as { input?: unknown }).input, {
        title: "Quarterly revenue",
        height: 420,
        htmlChars: 49,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("parses a streamed tool input once, when its object closes", () => {
    const harness = makeHarness();
    // Braces and escaped quotes inside the page must not look like the input closing.
    const html = `<!doctype html><style>${'.bar{fill:"red"} .x\\{}\n'.repeat(400)}</style>`;
    const input = JSON.stringify({ html, title: "Braces", height: 300 });
    const parseSpy = vi.spyOn(JSON, "parse");
    const inputParses = () =>
      parseSpy.mock.calls.filter(([text]) => typeof text === "string" && text.startsWith('{"html"'))
        .length;
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-streamed-input"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "chart it", attachments: [] });

      const stream = (uuid: string, event: unknown) =>
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-streamed-input",
          uuid,
          parent_tool_use_id: null,
          event,
        } as unknown as SDKMessage);
      stream("input-start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool-streamed-1",
          name: "mcp__ryco__ryco_html_render",
          input: {},
        },
      });
      const deltaCount = Math.ceil(input.length / 7);
      for (let index = 0; index < deltaCount; index += 1) {
        stream(`input-delta-${index}`, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: input.slice(index * 7, index * 7 + 7) },
        });
      }
      stream("input-stop", { type: "content_block_stop", index: 0 });
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-streamed-input",
        uuid: "streamed-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-streamed-1",
              content: "Shown to the reader.",
            },
          ],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-streamed-input",
        uuid: "streamed-turn-result",
      } as unknown as SDKMessage);

      const updated = Array.from(yield* Fiber.join(runtimeEventsFiber)).find(
        (event) => event.type === "item.updated",
      );
      assert.isAbove(deltaCount, 1_000);
      assert.equal(inputParses(), 1);
      assert.deepEqual((updated?.payload.data as { input?: unknown } | undefined)?.input, {
        title: "Braces",
        height: 300,
        htmlChars: html.length,
      });
      assert.equal(updated?.type === "item.updated" ? updated.payload.detail : undefined, "Braces");
    }).pipe(
      Effect.ensuring(Effect.sync(() => parseSpy.mockRestore())),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to a default plan step label for blank TodoWrite content", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(10),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-22"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-todo-1",
            name: "TodoWrite",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"todos":[{"content":"   ","status":"in_progress"},{"content":"Ship it","status":"completed"}]}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-todo-plan",
        uuid: "result-todo-plan",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(
        yield* Fiber.join(runtimeEventsFiber).pipe(Effect.timeout("1 second")),
      );
      const planUpdated = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.equal(planUpdated?.type, "turn.plan.updated");
      if (planUpdated?.type === "turn.plan.updated") {
        assert.equal(String(planUpdated.turnId), String(turn.turnId));
        assert.deepEqual(planUpdated.payload.plan, [
          { step: "Task", status: "inProgress" },
          { step: "Ship it", status: "completed" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Claude Task tool invocations as collaboration agent work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-23"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task",
        uuid: "stream-task-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-task",
        uuid: "assistant-task-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-task-1",
          content: [{ type: "text", text: "Delegated" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task",
        uuid: "result-task-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
        assert.equal(toolStarted.payload.title, "Subagent task");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats user-aborted Claude results as interrupted without a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-24"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        session_id: "sdk-session-abort",
        uuid: "result-abort",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Error: Request was aborted.");
        assert.equal(turnCompleted.payload.stopReason, "tool_use");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the session when the Claude stream aborts after a turn starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);

      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-25"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("All fibers interrupted without error"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );

      const turnCompleted = runtimeEvents[4];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude runtime interrupted.");
      }

      const sessionExited = runtimeEvents[5];
      assert.equal(sessionExited?.type, "session.exited");

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rejects a different runtime epoch until the existing session is stopped", () => {
    const queries: FakeClaudeQuery[] = [];
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = Schema.decodeSync(ClaudeSettings)({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-26"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const replacement = yield* adapter
        .startSession({
          runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-27"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
          resumePolicy: "fresh",
        })
        .pipe(Effect.result);

      assert.equal(replacement._tag, "Failure");
      if (replacement._tag === "Failure") {
        assert.equal(replacement.failure._tag, "ProviderAdapterValidationError");
      }
      assert.equal(queries.length, 1);
      assert.equal(queries[0]?.closeCalls, 0);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);

      yield* adapter.stopSession(THREAD_ID);
      assert.equal(queries[0]?.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("stopSession does not throw into the SDK prompt consumer", () => {
    // The SDK consumes user messages via `for await (... of prompt)`.
    // Stopping a session must end that loop cleanly — not throw an error.
    //
    // FakeClaudeQuery.close() masks this by resolving pending iterators
    // before the shutdown propagates. Override it to match real SDK behavior
    // where close() does not resolve the prompt consumer.
    const query = new FakeClaudeQuery();
    (query as { close: () => void }).close = () => {
      query.closeCalls += 1;
    };

    let promptConsumerError: unknown = undefined;

    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = Schema.decodeSync(ClaudeSettings)({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: (input) => {
            // Simulate the SDK consuming the prompt iterable
            (async () => {
              try {
                for await (const _message of input.prompt) {
                  /* SDK processes user messages */
                }
              } catch (error) {
                promptConsumerError = error;
              }
            })();
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);

      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, () => Effect.void),
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-28"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(THREAD_ID);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

      runtimeEventsFiber.interruptUnsafe();

      assert.equal(
        promptConsumerError,
        undefined,
        `Prompt consumer should not receive a thrown error on session stop, ` +
          `but got: "${promptConsumerError instanceof Error ? promptConsumerError.message : String(promptConsumerError)}"`,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("forwards Claude task progress summaries for subagent updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-29"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-subagent-1",
        description: "Running background teammate",
        summary: "Code reviewer checked the migration edge cases.",
        usage: {
          total_tokens: 123,
          tool_uses: 4,
          duration_ms: 987,
        },
        session_id: "sdk-session-task-summary",
        uuid: "task-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(
          progressEvent.payload.summary,
          "Code reviewer checked the migration edge cases.",
        );
        assert.equal(progressEvent.payload.description, "Running background teammate");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("projects Claude agent task lifecycle into subagent summary events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "subagent.started" ||
            event.type === "subagent.updated" ||
            event.type === "subagent.completed" ||
            event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.completed",
        ),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-30"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-agent-1",
        task_type: "agent",
        description: "Review retry handling",
        session_id: "sdk-session-agent-task",
        uuid: "task-agent-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-agent-1",
        description: "Review retry handling",
        summary: "Reviewer is checking retry paths.",
        last_tool_name: "Task",
        session_id: "sdk-session-agent-task",
        uuid: "task-agent-progress",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-agent-1",
        status: "completed",
        summary: "Retry paths reviewed.",
        session_id: "sdk-session-agent-task",
        uuid: "task-agent-completed",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(
        yield* Fiber.join(runtimeEventsFiber).pipe(Effect.timeout("1 second")),
      );
      const subagentStarted = runtimeEvents.find((event) => event.type === "subagent.started");
      const subagentUpdated = runtimeEvents.find((event) => event.type === "subagent.updated");
      const subagentCompleted = runtimeEvents.find((event) => event.type === "subagent.completed");

      assert.equal(subagentStarted?.type, "subagent.started");
      if (subagentStarted?.type === "subagent.started") {
        assert.equal(subagentStarted.payload.subagent.subagentId, "claude-task:task-agent-1");
        assert.equal(subagentStarted.payload.subagent.capability, "summary");
        assert.equal(subagentStarted.payload.subagent.providerTaskId, "task-agent-1");
      }
      assert.equal(subagentUpdated?.type, "subagent.updated");
      if (subagentUpdated?.type === "subagent.updated") {
        assert.equal(subagentUpdated.payload.status, "running");
        assert.equal(subagentUpdated.payload.summary, "Reviewer is checking retry paths.");
      }
      assert.equal(subagentCompleted?.type, "subagent.completed");
      if (subagentCompleted?.type === "subagent.completed") {
        assert.equal(subagentCompleted.payload.status, "completed");
        assert.equal(subagentCompleted.payload.summary, "Retry paths reviewed.");
      }
      assert.ok(runtimeEvents.some((event) => event.type === "task.started"));
      assert.ok(runtimeEvents.some((event) => event.type === "task.progress"));
      assert.ok(runtimeEvents.some((event) => event.type === "task.completed"));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits thread token usage updates from Claude task progress", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-31"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        },
        session_id: "sdk-session-task-usage",
        uuid: "task-usage-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 321,
            lastUsedTokens: 321,
            toolUses: 2,
            durationMs: 654,
          },
        });
      }
      assert.equal(progressEvent?.type, "task.progress");
      if (usageEvent && progressEvent) {
        assert.notStrictEqual(usageEvent.eventId, progressEvent.eventId);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores Claude thinking token system messages", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-32"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const deniedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "tool.denied",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "system",
        subtype: "thinking_tokens",
        session_id: "sdk-session-thinking",
        uuid: "thinking-tokens-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "tool-denied-1",
        decision_reason: "User denied command execution.",
        agent_id: "agent-1",
        session_id: "sdk-session-thinking",
        uuid: "permission-denied-1",
      } as unknown as SDKMessage);

      const nextEvent = yield* Fiber.join(deniedEventFiber);
      assert.equal(nextEvent._tag, "Some");
      assert.equal(nextEvent._tag === "Some" ? nextEvent.value.type : undefined, "tool.denied");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude permission_denied system messages to tool.denied", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-33"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const deniedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "tool.denied",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Edit",
        tool_use_id: "tool-denied-2",
        decision_reason: "File write was denied.",
        agent_id: "agent-2",
        session_id: "sdk-session-denied",
        uuid: "permission-denied-2",
      } as unknown as SDKMessage);

      const event = yield* Fiber.join(deniedEventFiber);
      assert.equal(event._tag, "Some");
      if (event._tag === "Some") {
        assert.equal(event.value.type, "tool.denied");
        if (event.value.type === "tool.denied") {
          assert.deepEqual(event.value.payload, {
            toolName: "Edit",
            toolUseId: "tool-denied-2",
            reason: "File write was denied.",
            agentId: "agent-2",
          });
        }
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude mirror_error system messages to runtime.error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-34"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const runtimeErrorFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "runtime.error",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "system",
        subtype: "mirror_error",
        error: "workspace mirror failed",
        session_id: "sdk-session-mirror",
        uuid: "mirror-error-1",
      } as unknown as SDKMessage);

      const event = yield* Fiber.join(runtimeErrorFiber);
      assert.equal(event._tag, "Some");
      if (event._tag === "Some") {
        assert.equal(event.value.type, "runtime.error");
        if (event.value.type === "runtime.error") {
          assert.equal(
            event.value.payload.message,
            "Claude workspace mirror error: workspace mirror failed",
          );
        }
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits Claude context window on result completion usage snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-35"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 2715,
          cache_read_input_tokens: 21144,
          output_tokens: 679,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            processedUsage: {
              scope: "turn",
              inputTokens: 23863,
              cachedInputTokens: 21144,
              outputTokens: 679,
              reasoningOutputTokens: 0,
              totalTokens: 24542,
            },
            usedTokens: 24542,
            lastUsedTokens: 24542,
            inputTokens: 23863,
            cachedInputTokens: 21144,
            outputTokens: 679,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("clamps oversized Claude usage to the reported context window", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-36"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-clamped",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            processedUsage: {
              scope: "turn",
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 535000,
            },
            usedTokens: 200000,
            lastUsedTokens: 200000,
            totalProcessedTokens: 535000,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "enables automatic compaction once at the threshold and preserves the canonical boundary lifecycle",
    () => {
      const harness = makeHarness({ supportsAutomaticCompaction: true });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-auto-compact"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
          resumeCursor: {
            threadId: THREAD_ID,
            resume: "11111111-1111-4111-8111-111111111111",
            turnCount: 2,
          },
        });

        const firstCompletionFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );

        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first", attachments: [] });
        emitClaudeUsage(harness.query, { id: "compact-first", usedTokens: 160_000 });
        emitClaudeSuccessfulResult(harness.query, {
          id: "compact-first",
          usedTokens: 160_000,
          contextWindow: 200_000,
        });
        yield* Fiber.join(firstCompletionFiber);
        yield* Effect.yieldNow;

        const secondCompletionFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "second", attachments: [] });
        emitClaudeUsage(harness.query, { id: "compact-second", usedTokens: 175_000 });
        emitClaudeSuccessfulResult(harness.query, {
          id: "compact-second",
          usedTokens: 175_000,
          contextWindow: 200_000,
        });

        yield* Fiber.join(secondCompletionFiber);
        yield* Effect.yieldNow;
        assert.deepEqual(harness.query.applyFlagSettingsCalls, [
          {
            autoCompactEnabled: true,
            autoCompactWindow: 160_000,
          },
        ]);

        const boundaryFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "thread.state.changed"),
          Stream.runHead,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "compact-status",
          session_id: "sdk-session-compact",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: {
            trigger: "auto",
            pre_tokens: 175_000,
            post_tokens: 42_000,
          },
          uuid: "compact-boundary",
          session_id: "sdk-session-compact",
        } as unknown as SDKMessage);

        const boundary = yield* Fiber.join(boundaryFiber);
        assert.equal(boundary._tag, "Some");
        if (boundary._tag === "Some") {
          assert.equal(boundary.value.type, "thread.state.changed");
          if (boundary.value.type === "thread.state.changed") {
            assert.equal(boundary.value.payload.state, "compacted");
          }
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "does not arm compaction for an interrupted turn and retries on a later success",
    () => {
      const harness = makeHarness({ supportsAutomaticCompaction: true });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-auto-compact-interrupted"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const interruptedCompletionFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "interrupt", attachments: [] });
        emitClaudeUsage(harness.query, { id: "compact-interrupted", usedTokens: 170_000 });
        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          duration_ms: 10,
          duration_api_ms: 8,
          num_turns: 1,
          stop_reason: null,
          errors: ["Interrupted by user"],
          session_id: "sdk-session-compact-interrupted",
          usage: { total_tokens: 170_000 },
          modelUsage: {
            "claude-opus-4-6": { contextWindow: 200_000, maxOutputTokens: 64_000 },
          },
        } as unknown as SDKMessage);
        yield* Fiber.join(interruptedCompletionFiber);
        yield* Effect.yieldNow;
        assert.lengthOf(harness.query.applyFlagSettingsCalls, 0);

        const resumedCompletionFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "resume", attachments: [] });
        emitClaudeUsage(harness.query, { id: "compact-resumed", usedTokens: 170_000 });
        emitClaudeSuccessfulResult(harness.query, {
          id: "compact-resumed",
          usedTokens: 170_000,
          contextWindow: 200_000,
        });

        yield* Fiber.join(resumedCompletionFiber);
        yield* Effect.yieldNow;
        assert.lengthOf(harness.query.applyFlagSettingsCalls, 1);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("degrades safely when the SDK cannot enable automatic compaction", () => {
    const harness = makeHarness({ supportsAutomaticCompaction: false });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const warningFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "runtime.warning"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-auto-compact-unsupported"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "fill context", attachments: [] });
      emitClaudeUsage(harness.query, { id: "compact-unsupported", usedTokens: 170_000 });
      emitClaudeSuccessfulResult(harness.query, {
        id: "compact-unsupported",
        usedTokens: 170_000,
        contextWindow: 200_000,
      });

      const warning = yield* Fiber.join(warningFiber);
      assert.equal(warning._tag, "Some");
      if (warning._tag === "Some") {
        assert.equal(warning.value.type, "runtime.warning");
        if (warning.value.type === "runtime.warning") {
          assert.equal(
            warning.value.payload.message,
            "Automatic context compaction is unavailable for this session. Start a new session if the context window fills.",
          );
        }
      }
      assert.deepEqual(harness.query.applyFlagSettingsCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "preserves oversized Claude result totals after task progress snapshots are recorded",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-37"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-usage-clamped",
          description: "Thinking through the patch",
          usage: {
            total_tokens: 190000,
          },
          session_id: "sdk-session-task-usage-clamped",
          uuid: "task-usage-progress-clamped",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1200,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          session_id: "sdk-session-result-usage-clamped-after-progress",
          usage: {
            total_tokens: 535000,
          },
          modelUsage: {
            "claude-opus-4-6": {
              contextWindow: 200000,
              maxOutputTokens: 64000,
            },
          },
        } as unknown as SDKMessage);
        harness.query.finish();

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const usageEvents = runtimeEvents.filter(
          (event) => event.type === "thread.token-usage.updated",
        );
        const finalUsageEvent = usageEvents.at(-1);
        assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
        if (finalUsageEvent?.type === "thread.token-usage.updated") {
          assert.deepEqual(finalUsageEvent.payload, {
            usage: {
              processedUsage: {
                scope: "turn",
                inputTokens: 0,
                cachedInputTokens: 0,
                outputTokens: 0,
                reasoningOutputTokens: 0,
                totalTokens: 535000,
              },
              usedTokens: 190000,
              lastUsedTokens: 190000,
              totalProcessedTokens: 535000,
              maxTokens: 200000,
            },
          });
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "emits completion only after turn result when assistant frames arrive before deltas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-38"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-early-assistant",
          uuid: "assistant-early",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-early",
            content: [
              { type: "tool_use", id: "tool-early", name: "Read", input: { path: "a.ts" } },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-early-assistant",
          uuid: "stream-early",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Late text",
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-early-assistant",
          uuid: "result-early",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );

        const deltaIndex = runtimeEvents.findIndex((event) => event.type === "content.delta");
        const completedIndex = runtimeEvents.findIndex((event) => event.type === "item.completed");
        assert.equal(deltaIndex >= 0 && completedIndex >= 0 && deltaIndex < completedIndex, true);

        const deltaEvent = runtimeEvents[deltaIndex];
        assert.equal(deltaEvent?.type, "content.delta");
        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Late text");
          assert.equal(String(deltaEvent.turnId), String(turn.turnId));
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("creates a fresh assistant message when Claude reuses a text block index", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-39"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Second",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-reused-text-index",
        uuid: "result-reused-text-index",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "content.delta",
          "item.completed",
        ],
      );

      const assistantDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantDeltas.length, 2);
      if (assistantDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantDeltas;
      assert.equal(firstAssistantDelta?.type, "content.delta");
      assert.equal(secondAssistantDelta?.type, "content.delta");
      if (
        firstAssistantDelta?.type !== "content.delta" ||
        secondAssistantDelta?.type !== "content.delta"
      ) {
        return;
      }
      assert.equal(firstAssistantDelta.payload.delta, "First");
      assert.equal(secondAssistantDelta.payload.delta, "Second");
      assert.notEqual(firstAssistantDelta.itemId, secondAssistantDelta.itemId);

      const assistantCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompletions.length, 2);
      assert.equal(String(assistantCompletions[0]?.itemId), String(firstAssistantDelta.itemId));
      assert.equal(String(assistantCompletions[1]?.itemId), String(secondAssistantDelta.itemId));
      assert.notEqual(
        String(assistantCompletions[0]?.itemId),
        String(assistantCompletions[1]?.itemId),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to assistant payload text when stream deltas are absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-40"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-fallback-text",
        uuid: "assistant-fallback",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-fallback",
          content: [{ type: "text", text: "Fallback hello" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-fallback-text",
        uuid: "result-fallback",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Fallback hello");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("segments Claude assistant text blocks around tool calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-41"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-interleaved-1",
            name: "Grep",
            input: {
              pattern: "assistant",
              path: "src",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-interleaved",
        uuid: "user-tool-result-interleaved",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-interleaved-1",
              content: "src/example.ts:1:assistant",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "text_delta",
            text: "Second message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 2,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-interleaved",
        uuid: "result-interleaved",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const assistantTextDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantTextDeltas.length, 2);
      if (assistantTextDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantTextDeltas;
      if (!firstAssistantDelta || !secondAssistantDelta) {
        return;
      }
      assert.notEqual(String(firstAssistantDelta.itemId), String(secondAssistantDelta.itemId));

      const firstAssistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.itemId) === String(firstAssistantDelta.itemId),
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      const secondAssistantDeltaIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          String(event.itemId) === String(secondAssistantDelta.itemId),
      );

      assert.equal(
        firstAssistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          secondAssistantDeltaIndex >= 0 &&
          firstAssistantCompletedIndex < toolStartedIndex &&
          toolStartedIndex < secondAssistantDeltaIndex,
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not fabricate provider thread ids before first SDK session_id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-42"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-real",
        uuid: "stream-thread-real",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-thread-real",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-thread-real",
        uuid: "result-thread-real",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
        ],
      );

      const sessionStarted = runtimeEvents[0];
      assert.equal(sessionStarted?.type, "session.started");
      if (sessionStarted?.type === "session.started") {
        assert.equal(sessionStarted.threadId, THREAD_ID);
      }

      const threadStarted = runtimeEvents[4];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.equal(threadStarted.threadId, THREAD_ID);
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: "sdk-thread-real",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("bridges approval request/response lifecycle through canUseTool", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-43"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-approval-1",
        uuid: "stream-approval-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-approval-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          requestId: "permission-request-1",
          suggestions: [
            {
              type: "setMode",
              mode: "default",
              destination: "session",
            },
          ],
          toolUseID: "tool-use-1",
        },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some") {
        return;
      }
      assert.equal(requested.value.type, "request.opened");
      if (requested.value.type !== "request.opened") {
        return;
      }
      assert.deepEqual(requested.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });
      const runtimeRequestId = requested.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(runtimeRequestId),
        "accept",
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }
      assert.equal(resolved.value.requestId, requested.value.requestId);
      assert.equal(resolved.value.payload.decision, "accept");
      assert.deepEqual(resolved.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Agent tools and read-only Claude tools correctly for approvals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-44"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const agentPermissionPromise = canUseTool(
        "Agent",
        {},
        {
          signal: new AbortController().signal,
          requestId: "permission-agent-1",
          toolUseID: "tool-agent-1",
        },
      );

      const agentRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(agentRequested._tag, "Some");
      if (agentRequested._tag !== "Some" || agentRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(agentRequested.value.payload.requestType, "dynamic_tool_call");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(agentRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => agentPermissionPromise);

      const grepPermissionPromise = canUseTool(
        "Grep",
        { pattern: "foo", path: "src" },
        {
          signal: new AbortController().signal,
          requestId: "permission-grep-1",
          toolUseID: "tool-grep-approval-1",
        },
      );

      const grepRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(grepRequested._tag, "Some");
      if (grepRequested._tag !== "Some" || grepRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(grepRequested.value.payload.requestType, "file_read_approval");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(grepRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => grepPermissionPromise);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("continues an imported native copy in a mapped cwd without resuming the source", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const copiedId = "22222222-2222-4222-8222-222222222222";
      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("import-runtime-fixture"),
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: "/tmp/mapped-import-target",
        resumeCursor: { threadId: RESUME_THREAD_ID, resume: copiedId, turnCount: 2 },
        runtimeMode: "approval-required",
      });
      const options = harness.getLastCreateQueryInput()?.options;
      assert.equal(options?.resume, copiedId);
      assert.equal(options?.cwd, "/tmp/mapped-import-target");
      assert.equal(options?.sessionId, undefined);
      assert.equal(options?.resumeSessionAt, undefined);
      assert.equal(session.runtimeSessionId, "import-runtime-fixture");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes Claude resume ids without pinning a stale assistant checkpoint", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-45"),
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: "550e8400-e29b-41d4-a716-446655440000",
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, RESUME_THREAD_ID);
      assert.deepEqual(session.resumeCursor, {
        threadId: RESUME_THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-99",
        turnCount: 3,
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, "550e8400-e29b-41d4-a716-446655440000");
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves durable resume ids across Claude resume hooks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const durableSessionId = "550e8400-e29b-41d4-a716-446655440000";
      const transientHookSessionId = "7368d0c7-40a3-4d8a-bcc1-ac80c49f2719";

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-46"),
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: durableSessionId,
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "hook_started",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        session_id: transientHookSessionId,
        uuid: "resume-hook-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "hook_response",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        output: "",
        stdout: "",
        stderr: "",
        outcome: "success",
        session_id: transientHookSessionId,
        uuid: "resume-hook-response",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        claude_code_version: "test",
        cwd: "/tmp/claude-adapter-test",
        tools: [],
        mcp_servers: [],
        model: "claude-sonnet-4-5",
        permissionMode: "bypassPermissions",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        session_id: durableSessionId,
        uuid: "resume-init",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const threadStartedEvents = runtimeEvents.filter((event) => event.type === "thread.started");
      assert.equal(threadStartedEvents.length, 1);
      const threadStarted = threadStartedEvents[0];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: durableSessionId,
        });
      }

      const activeSessions = yield* adapter.listSessions();
      const resumeCursor = activeSessions[0]?.resumeCursor as
        | {
            readonly resume?: string;
          }
        | undefined;
      assert.equal(resumeCursor?.resume, durableSessionId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses an app-generated Claude session id for fresh sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-47"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      const sessionResumeCursor = session.resumeCursor as {
        threadId?: string;
        resume?: string;
        turnCount?: number;
      };
      assert.equal(sessionResumeCursor.threadId, THREAD_ID);
      assert.equal(typeof sessionResumeCursor.resume, "string");
      assert.equal(sessionResumeCursor.turnCount, 0);
      assert.match(
        sessionResumeCursor.resume ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(createInput?.options.sessionId, sessionResumeCursor.resume);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  describe("checkpoint rollback", () => {
    const REWIND_SESSION_ID = "11111111-1111-4111-8111-111111111111";
    const REWIND_RUNTIME_ID = RuntimeSessionId.make("runtime-claude-rewind");
    const REWIND_CWD = "/tmp/claude-rewind";

    const startRewindSession = (
      adapter: ClaudeAdapterShape,
      runtimeMode: RuntimeMode = "full-access",
    ) =>
      adapter.startSession({
        runtimeSessionId: REWIND_RUNTIME_ID,
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: REWIND_CWD,
        runtimeMode,
        resumeCursor: { threadId: THREAD_ID, resume: REWIND_SESSION_ID, turnCount: 0 },
      });

    const collectEvents = (adapter: ClaudeAdapterShape) =>
      Effect.gen(function* () {
        const events: Array<ProviderRuntimeEvent> = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event)),
        ).pipe(Effect.forkChild);
        return events;
      });

    const waitUntil = (predicate: () => boolean) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 500; attempt++) {
          if (predicate()) return;
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)));
        }
        throw new Error("Timed out waiting for the Claude adapter.");
      });

    const runTurn = (input: {
      readonly adapter: ClaudeAdapterShape;
      readonly harness: ReturnType<typeof makeSequencedHarness>;
      readonly events: ReadonlyArray<ProviderRuntimeEvent>;
      readonly text: string;
      readonly assistantUuid: string;
      readonly subagentUuid?: string;
      readonly interrupted?: boolean;
    }) =>
      Effect.gen(function* () {
        const turn = yield* input.adapter.sendTurn({
          threadId: THREAD_ID,
          input: input.text,
          attachments: [],
        });
        const query = input.harness.queries.at(-1)!;
        query.emit({
          type: "assistant",
          session_id: REWIND_SESSION_ID,
          uuid: input.assistantUuid,
          parent_tool_use_id: null,
          message: {
            id: `message-${input.assistantUuid}`,
            content: [{ type: "text", text: input.text }],
          },
        } as unknown as SDKMessage);
        if (input.subagentUuid) {
          query.emit({
            type: "assistant",
            session_id: REWIND_SESSION_ID,
            uuid: input.subagentUuid,
            parent_tool_use_id: "tool-subagent",
            message: { id: `message-${input.subagentUuid}`, content: [] },
          } as unknown as SDKMessage);
        }
        query.emit(
          (input.interrupted
            ? {
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                errors: ["Interrupted by user"],
                session_id: REWIND_SESSION_ID,
                uuid: `result-${input.assistantUuid}`,
              }
            : {
                type: "result",
                subtype: "success",
                is_error: false,
                errors: [],
                session_id: REWIND_SESSION_ID,
                uuid: `result-${input.assistantUuid}`,
              }) as unknown as SDKMessage,
        );
        yield* waitUntil(() =>
          input.events.some(
            (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
          ),
        );
        return turn.turnId;
      });

    const transcriptEntry = (uuid: string, type = "assistant") => ({
      type,
      uuid,
      parent_tool_use_id: null,
    });

    const exitOrErrorEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
      events.filter((event) => event.type === "session.exited" || event.type === "runtime.error");

    const currentCursor = (adapter: ClaudeAdapterShape) =>
      adapter
        .listSessions()
        .pipe(
          Effect.map(
            (sessions) =>
              sessions.find((session) => session.threadId === THREAD_ID)?.resumeCursor as
                | Record<string, unknown>
                | undefined,
          ),
        );

    it.effect("reopens the transcript just before the first dropped prompt", () => {
      const harness = makeSequencedHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events = yield* collectEvents(adapter);
        yield* startRewindSession(adapter);
        const turn1 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "one",
          assistantUuid: "a1",
        });
        const turn2 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "two",
          assistantUuid: "a2",
        });
        harness.setTranscript([
          transcriptEntry(turn1, "user"),
          transcriptEntry("a1"),
          transcriptEntry(turn2, "user"),
          transcriptEntry("a2"),
        ]);

        yield* adapter.rollbackThread(THREAD_ID, {
          numTurns: 1,
          targetTurnId: turn1,
          droppedTurnIds: [turn2],
        });

        assert.equal(harness.queries[0]?.closeCalls, 1);
        assert.equal(harness.inputs.length, 2);
        const options = harness.inputs[1]?.options;
        assert.equal(options?.resume, REWIND_SESSION_ID);
        assert.equal(options?.resumeSessionAt, "a1");
        assert.equal(options?.resumeDropsTurn, undefined);
        assert.deepEqual(harness.transcriptReads[0], {
          sessionId: REWIND_SESSION_ID,
          dir: REWIND_CWD,
          includeSystemMessages: true,
        });
        const [reopened] = yield* adapter.listSessions();
        assert.equal(reopened?.runtimeSessionId, REWIND_RUNTIME_ID);
        assert.deepEqual((reopened?.resumeCursor as { rewind?: unknown } | undefined)?.rewind, {
          at: "a1",
        });
        assert.deepEqual(exitOrErrorEvents(events), []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("opens a fresh session when reverting to checkpoint 0", () => {
      const harness = makeSequencedHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events = yield* collectEvents(adapter);
        yield* startRewindSession(adapter);
        const turn1 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "one",
          assistantUuid: "a1",
        });

        yield* adapter.rollbackThread(THREAD_ID, {
          numTurns: 1,
          targetTurnId: null,
          droppedTurnIds: [turn1],
        });

        const options = harness.inputs[1]?.options;
        assert.equal(typeof options?.sessionId, "string");
        assert.notEqual(options?.sessionId, REWIND_SESSION_ID);
        assert.equal(options?.resume, undefined);
        assert.equal(options?.resumeSessionAt, undefined);
        assert.equal(harness.transcriptReads.length, 0);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("falls back to the target turn's recorded main-chain head", () => {
      const harness = makeSequencedHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events = yield* collectEvents(adapter);
        yield* startRewindSession(adapter);
        const turn1 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "one",
          assistantUuid: "a1",
          subagentUuid: "subagent-snapshot",
        });
        const turn2 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "two",
          assistantUuid: "a2",
        });
        harness.setTranscript([transcriptEntry("unrelated")]);

        yield* adapter.rollbackThread(THREAD_ID, {
          numTurns: 1,
          targetTurnId: turn1,
          droppedTurnIds: [turn2],
        });

        assert.equal(harness.inputs[1]?.options.resumeSessionAt, "a1");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("refuses to rewind while Claude is busy or without a transcript position", () => {
      const harness = makeSequencedHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events = yield* collectEvents(adapter);
        yield* startRewindSession(adapter, "approval-required");
        const turn1 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "one",
          assistantUuid: "a1",
        });
        const query = harness.queries[0]!;
        const rollback = (targetTurnId = turn1) =>
          Effect.flip(
            adapter.rollbackThread(THREAD_ID, {
              numTurns: 1,
              targetTurnId,
              droppedTurnIds: [TurnId.make("turn-dropped")],
            }),
          );

        // Unknown target and no transcript match: no position to fork at.
        const noPosition = yield* rollback(TurnId.make("turn-unknown"));
        assert.include(noPosition.message, "no recorded transcript position");

        // A background task is alive.
        query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-live",
          task_type: "agent",
          description: "Background work",
          session_id: REWIND_SESSION_ID,
          uuid: "task-live-started",
        } as unknown as SDKMessage);
        yield* waitUntil(() => events.some((event) => event.type === "task.started"));
        const liveTask = yield* rollback();
        assert.include(liveTask.message, "background tasks running");
        query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "task-live",
          status: "completed",
          summary: "done",
          output_file: "",
          session_id: REWIND_SESSION_ID,
          uuid: "task-live-done",
        } as unknown as SDKMessage);
        yield* waitUntil(() => events.some((event) => event.type === "task.completed"));

        // A pending approval.
        const canUseTool = harness.inputs[0]?.options.canUseTool;
        void canUseTool?.(
          "Bash",
          { command: "pwd" },
          {
            signal: new AbortController().signal,
            requestId: "rewind-approval",
            toolUseID: "rewind-approval-tool",
          },
        );
        yield* waitUntil(() => events.some((event) => event.type === "request.opened"));
        const pendingApproval = yield* rollback();
        assert.include(pendingApproval.message, "waiting for your answer");

        // A running turn.
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "still running", attachments: [] });
        const running = yield* rollback();
        assert.include(running.message, "A Claude turn is still running.");

        assert.equal(query.closeCalls, 0);
        assert.equal(harness.inputs.length, 1);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("restores the previous conversation silently when the reopen is refused", () => {
      const harness = makeSequencedHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events = yield* collectEvents(adapter);
        yield* startRewindSession(adapter);
        const turn1 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "one",
          assistantUuid: "a1",
        });
        const turn2 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "two",
          assistantUuid: "a2",
        });
        harness.setTranscript([
          transcriptEntry(turn1, "user"),
          transcriptEntry("a1"),
          transcriptEntry(turn2, "user"),
        ]);
        harness.setOnCreate((query, index) => {
          if (index === 1) query.failInit = true;
        });

        const error = yield* Effect.flip(
          adapter.rollbackThread(THREAD_ID, {
            numTurns: 1,
            targetTurnId: turn1,
            droppedTurnIds: [turn2],
          }),
        );

        assert.include(
          error.message,
          "Claude refused to rewind this conversation, so nothing was changed.",
        );
        // The user sees the detail; it carries no adapter prefix or thread id.
        assert.equal(error._tag, "ProviderAdapterRequestError");
        assert.equal(
          "detail" in error ? error.detail : undefined,
          "Claude refused to rewind this conversation, so nothing was changed. Resume rejected by the test CLI.",
        );
        assert.equal(harness.inputs.length, 3);
        assert.equal(harness.inputs[2]?.options.resume, REWIND_SESSION_ID);
        assert.equal(harness.inputs[2]?.options.resumeSessionAt, undefined);
        assert.deepEqual(exitOrErrorEvents(events), []);
        const cursor = yield* currentCursor(adapter);
        assert.equal(cursor?.rewind, undefined);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("reports the session ended when neither the rewind nor the restore opens", () => {
      const harness = makeSequencedHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events = yield* collectEvents(adapter);
        yield* startRewindSession(adapter);
        const turn1 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "one",
          assistantUuid: "a1",
        });
        const turn2 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "two",
          assistantUuid: "a2",
        });
        harness.setTranscript([
          transcriptEntry(turn1, "user"),
          transcriptEntry("a1"),
          transcriptEntry(turn2, "user"),
        ]);
        harness.setOnCreate((query, index) => {
          if (index === 1) {
            query.failInit = true;
            query.fail(new Error("Claude exited"));
          }
          if (index === 2) query.failInit = true;
        });

        const error = yield* Effect.flip(
          adapter.rollbackThread(THREAD_ID, {
            numTurns: 1,
            targetTurnId: turn1,
            droppedTurnIds: [turn2],
          }),
        );

        assert.include(error.message, "Claude refused to rewind this conversation");
        assert.equal(harness.inputs.length, 3);
        yield* waitUntil(() => events.some((event) => event.type === "session.exited"));
        assert.equal(events.filter((event) => event.type === "session.exited").length, 1);
        assert.equal(events.filter((event) => event.type === "runtime.error").length, 0);
        assert.deepEqual(yield* adapter.listSessions(), []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    const runTwoTurnsForRewind = (
      adapter: ClaudeAdapterShape,
      harness: ReturnType<typeof makeSequencedHarness>,
      events: ReadonlyArray<ProviderRuntimeEvent>,
    ) =>
      Effect.gen(function* () {
        const turn1 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "one",
          assistantUuid: "a1",
        });
        const turn2 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "two",
          assistantUuid: "a2",
        });
        harness.setTranscript([
          transcriptEntry(turn1, "user"),
          transcriptEntry("a1"),
          transcriptEntry(turn2, "user"),
        ]);
        return { turn1, turn2 };
      });

    for (const ending of ["fails", "ends"] as const) {
      it.effect(
        `restores silently when the reopened CLI's stream ${ending} during the probe`,
        () => {
          const harness = makeSequencedHarness();
          return Effect.gen(function* () {
            const adapter = yield* ClaudeAdapter;
            const events = yield* collectEvents(adapter);
            yield* startRewindSession(adapter);
            const { turn1, turn2 } = yield* runTwoTurnsForRewind(adapter, harness, events);
            harness.setOnCreate((query, index) => {
              if (index !== 1) return;
              // The CLI never answers the probe; only its stream exit can end it.
              query.initGate = new Promise<void>(() => undefined);
              if (ending === "fails") query.fail(new Error("Claude exited with code 1"));
              else query.finish();
            });

            const error = yield* Effect.flip(
              adapter.rollbackThread(THREAD_ID, {
                numTurns: 1,
                targetTurnId: turn1,
                droppedTurnIds: [turn2],
              }),
            );

            assert.include(
              error.message,
              "Claude refused to rewind this conversation, so nothing was changed.",
            );
            assert.equal(harness.inputs.length, 3);
            assert.equal(harness.inputs[2]?.options.resume, REWIND_SESSION_ID);
            assert.equal(harness.inputs[2]?.options.resumeSessionAt, undefined);
            assert.deepEqual(exitOrErrorEvents(events), []);
            assert.equal((yield* currentCursor(adapter))?.rewind, undefined);
          }).pipe(
            Effect.provideService(Random.Random, makeDeterministicRandomService()),
            Effect.provide(harness.layer),
          );
        },
      );
    }

    it.effect("gives up on a reopened CLI that never answers the probe", () => {
      const harness = makeSequencedHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events = yield* collectEvents(adapter);
        yield* startRewindSession(adapter);
        const { turn1, turn2 } = yield* runTwoTurnsForRewind(adapter, harness, events);
        harness.setOnCreate((query, index) => {
          if (index === 1) query.initGate = new Promise<void>(() => undefined);
        });

        const rewinding = yield* adapter
          .rollbackThread(THREAD_ID, {
            numTurns: 1,
            targetTurnId: turn1,
            droppedTurnIds: [turn2],
          })
          .pipe(Effect.flip, Effect.forkChild);
        // The probe timer is armed by the time the reopened CLI is asked to initialize.
        yield* waitUntil(() => (harness.queries[1]?.initCalls ?? 0) > 0);
        yield* TestClock.adjust("29 seconds");
        assert.equal(harness.inputs.length, 2);
        yield* TestClock.adjust("1 second");
        const error = yield* Fiber.join(rewinding);

        assert.equal(
          "detail" in error ? error.detail : undefined,
          "Claude refused to rewind this conversation, so nothing was changed. Claude did not respond while reopening the conversation.",
        );
        assert.equal(harness.inputs.length, 3);
        assert.equal(harness.inputs[2]?.options.resumeSessionAt, undefined);
        assert.deepEqual(exitOrErrorEvents(events), []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("keeps the rewind marker until a turn completes on the rewound branch", () => {
      const harness = makeSequencedHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events = yield* collectEvents(adapter);
        yield* startRewindSession(adapter);
        const turn1 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "one",
          assistantUuid: "a1",
        });
        const turn2 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "two",
          assistantUuid: "a2",
        });
        harness.setTranscript([
          transcriptEntry(turn1, "user"),
          transcriptEntry("a1"),
          transcriptEntry(turn2, "user"),
        ]);
        yield* adapter.rollbackThread(THREAD_ID, {
          numTurns: 1,
          targetTurnId: turn1,
          droppedTurnIds: [turn2],
        });

        yield* runTurn({
          adapter,
          harness,
          events,
          text: "interrupted",
          assistantUuid: "a3",
          interrupted: true,
        });
        assert.deepEqual((yield* currentCursor(adapter))?.rewind, { at: "a1" });

        yield* runTurn({ adapter, harness, events, text: "completed", assistantUuid: "a4" });
        assert.equal((yield* currentCursor(adapter))?.rewind, undefined);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("resumes a rewound cursor truncated at the rewind point", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          runtimeSessionId: REWIND_RUNTIME_ID,
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
          resumeCursor: {
            threadId: THREAD_ID,
            resume: REWIND_SESSION_ID,
            resumeSessionAt: "a9",
            rewind: { at: "a1" },
            turnCount: 1,
          },
        });
        const options = harness.getLastCreateQueryInput()?.options;
        assert.equal(options?.resume, REWIND_SESSION_ID);
        assert.equal(options?.resumeSessionAt, "a1");
        assert.deepEqual((session.resumeCursor as { rewind?: unknown }).rewind, { at: "a1" });
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("refuses to start a session while the thread is rewinding", () => {
      const harness = makeSequencedHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events = yield* collectEvents(adapter);
        yield* startRewindSession(adapter);
        const turn1 = yield* runTurn({
          adapter,
          harness,
          events,
          text: "one",
          assistantUuid: "a1",
        });
        harness.setTranscript([transcriptEntry("p0", "user"), transcriptEntry(turn1, "user")]);
        let releaseInit: () => void = () => undefined;
        harness.setOnCreate((query, index) => {
          if (index === 1) {
            query.initGate = new Promise<void>((resolve) => {
              releaseInit = resolve;
            });
          }
        });

        const rewinding = yield* adapter
          .rollbackThread(THREAD_ID, {
            numTurns: 1,
            targetTurnId: TurnId.make("turn-kept"),
            droppedTurnIds: [turn1],
          })
          .pipe(Effect.forkChild);
        yield* waitUntil(() => harness.inputs.length === 2);

        const error = yield* Effect.flip(
          adapter.startSession({
            runtimeSessionId: RuntimeSessionId.make("runtime-claude-competing"),
            threadId: THREAD_ID,
            provider: ProviderDriverKind.make("claudeAgent"),
            runtimeMode: "full-access",
          }),
        );
        assert.include(error.message, "Claude is rewinding this thread; try again in a moment.");

        releaseInit();
        yield* Fiber.join(rewinding);
        assert.equal(harness.inputs[1]?.options.resumeSessionAt, "p0");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  });

  it.effect("updates model on sendTurn when model override is provided", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-49"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6[1m]"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates model on sendTurn for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("claude_openrouter");
    const harness = makeHarness({ instanceId: customInstanceId });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-50"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: customInstanceId,
          model: "openai/gpt-5.5",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["openai/gpt-5.5"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "does not re-set the Claude model when the session already uses the same effective API model",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const modelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        };

        const session = yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-51"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          modelSelection,
          attachments: [],
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello again",
          modelSelection,
          attachments: [],
        });

        assert.deepEqual(harness.query.setModelCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("re-sets the Claude model when the effective API model changes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-52"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "1m" }],
        ),
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello again",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "200k" }],
        ),
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6[1m]", "claude-opus-4-6"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sets plan permission mode on sendTurn when interactionMode is plan", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-53"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this for me",
        interactionMode: "plan",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sets plan permission mode on sendTurn when interactionMode is ask", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-54"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "explain this to me",
        interactionMode: "ask",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.each<{ runtimeMode: RuntimeMode; expectedBase: PermissionMode }>([
    { runtimeMode: "full-access", expectedBase: "bypassPermissions" },
    { runtimeMode: "approval-required", expectedBase: "default" },
    { runtimeMode: "auto-accept-edits", expectedBase: "acceptEdits" },
    { runtimeMode: "auto", expectedBase: "auto" },
  ])(
    "restores $expectedBase permission mode after plan turn ($runtimeMode)",
    ({ runtimeMode, expectedBase }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-55"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode,
        });

        // First turn in plan mode
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
        });

        // Complete the turn so we can send another
        const turnCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: `sdk-session-${runtimeMode}`,
          uuid: `result-${runtimeMode}`,
        } as unknown as SDKMessage);

        yield* Fiber.join(turnCompletedFiber);

        // Second turn back to default
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "now do it",
          interactionMode: "default",
          attachments: [],
        });

        assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", expectedBase]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect.each<{ runtimeMode: RuntimeMode; expectedBase: PermissionMode }>([
    { runtimeMode: "full-access", expectedBase: "bypassPermissions" },
    { runtimeMode: "approval-required", expectedBase: "default" },
    { runtimeMode: "auto-accept-edits", expectedBase: "acceptEdits" },
    { runtimeMode: "auto", expectedBase: "auto" },
  ])(
    "restores $expectedBase permission mode after ask turn ($runtimeMode)",
    ({ runtimeMode, expectedBase }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-56"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode,
        });

        // First turn in ask mode
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "explain this",
          interactionMode: "ask",
          attachments: [],
        });

        // Complete the turn so we can send another
        const turnCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: `sdk-session-ask-${runtimeMode}`,
          uuid: `result-ask-${runtimeMode}`,
        } as unknown as SDKMessage);

        yield* Fiber.join(turnCompletedFiber);

        // Second turn back to default
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "now do it",
          interactionMode: "default",
          attachments: [],
        });

        assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", expectedBase]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("does not call setPermissionMode when interactionMode is absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-57"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("captures ExitPlanMode as a proposed plan and denies auto-exit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-58"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "ExitPlanMode",
        {
          plan: "# Ship it\n\n- one\n- two",
          allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
        },
        {
          signal: new AbortController().signal,
          requestId: "permission-exit-plan-1",
          toolUseID: "tool-exit-1",
        },
      );

      const proposedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Ship it\n\n- one\n- two");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "deny");
      const deniedResult = permissionResult as PermissionResult & {
        message?: string;
      };
      assert.equal(deniedResult.message?.includes("captured your proposed plan"), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("extracts proposed plans from assistant ExitPlanMode snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-59"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const proposedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.proposed.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-exit-plan",
        uuid: "assistant-exit-plan",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-6",
          id: "msg-exit-plan",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-exit-2",
              name: "ExitPlanMode",
              input: {
                plan: "# Final plan\n\n- capture it",
              },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);

      const proposedEvent = yield* Fiber.join(proposedEventFiber);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Final plan\n\n- capture it");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-2"),
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("handles AskUserQuestion via user-input.requested/resolved lifecycle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Start session in approval-required mode so canUseTool fires.
      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-60"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      // Drain the session startup events (started, configured, state.changed).
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "question turn",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-user-input-1",
        uuid: "stream-user-input-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-user-input-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      // Simulate Claude calling AskUserQuestion with structured questions.
      const askInput = {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        requestId: "permission-ask-1",
        toolUseID: "tool-ask-1",
      });

      // The adapter should emit a user-input.requested event.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some") {
        return;
      }
      assert.equal(requestedEvent.value.type, "user-input.requested");
      if (requestedEvent.value.type !== "user-input.requested") {
        return;
      }
      const requestId = requestedEvent.value.requestId;
      assert.equal(typeof requestId, "string");
      assert.equal(requestedEvent.value.payload.questions.length, 1);
      assert.equal(requestedEvent.value.payload.questions[0]?.question, "Which framework?");
      // Regression for #2388: `id` must equal the full question text so the
      // UI's draft-answer key matches what the SDK looks up downstream.
      assert.equal(requestedEvent.value.payload.questions[0]?.id, "Which framework?");
      assert.deepEqual(requestedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // Respond with the user's answers.
      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Which framework?": "React",
      });

      // The adapter should emit a user-input.resolved event.
      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some") {
        return;
      }
      assert.equal(resolvedEvent.value.type, "user-input.resolved");
      if (resolvedEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {
        "Which framework?": "React",
      });
      assert.deepEqual(resolvedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // The canUseTool promise should resolve with the answers in SDK format.
      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Which framework?": "React" });
      // Original questions should be passed through.
      assert.deepEqual(updatedInput.questions, askInput.questions);

      // Compatibility check for #2388: the answers shape we hand to the SDK
      // must produce a non-empty rendered tool_result on BOTH SDK iteration
      // patterns we have seen, so we don't regress the issue and we don't
      // break users still on the older Claude CLI.
      const sdkAnswers = updatedInput.answers as Record<string, unknown>;
      const sdkQuestions = updatedInput.questions as ReadonlyArray<{
        readonly question: string;
      }>;

      // Claude CLI 2.1.119 — key-agnostic Object.entries iteration. Any key
      // works here, but it must at least round-trip into a non-empty string.
      const v119Rendered = Object.entries(sdkAnswers)
        .map(([key, value]) => `"${key}"="${String(value)}"`)
        .join(", ");
      assert.equal(v119Rendered, '"Which framework?"="React"');

      // Claude CLI 2.1.121 — lookup by full question text. This is the path
      // that regressed in #2388 when the answers were keyed by `header`.
      const v121Rendered = sdkQuestions
        .map(({ question }) => {
          const answer = sdkAnswers[question];
          return answer === undefined ? null : `"${question}"="${String(answer)}"`;
        })
        .filter((entry): entry is string => entry !== null)
        .join(", ");
      assert.notEqual(v121Rendered, "", "Expected non-empty SDK 2.1.121 tool_result (#2388)");
      assert.equal(v121Rendered, '"Which framework?"="React"');
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes AskUserQuestion through user-input flow even in full-access mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // In full-access mode, regular tools are auto-approved.
      // AskUserQuestion should still go through the user-input flow.
      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-61"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const askInput = {
        questions: [
          {
            question: "Deploy to which env?",
            header: "Env",
            options: [
              { label: "Staging", description: "Staging environment" },
              { label: "Production", description: "Production environment" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        requestId: "permission-ask-2",
        toolUseID: "tool-ask-2",
      });

      // Should still get user-input.requested even in full-access mode.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId;

      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Deploy to which env?": "Staging",
      });

      // Drain the resolved event.
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Deploy to which env?": "Staging" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies an already-aborted question without publishing a pending callback", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("question-pre-abort"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const canUseTool = harness.getLastCreateQueryInput()!.options.canUseTool!;
      const controller = new AbortController();
      controller.abort();
      const result = yield* Effect.promise(() =>
        canUseTool(
          "AskUserQuestion",
          {
            questions: [{ question: "Continue?", header: "Continue", options: [] }],
          },
          {
            signal: controller.signal,
            requestId: "already-aborted",
            toolUseID: "already-aborted-tool",
          },
        ),
      );
      assert.deepEqual(result, { behavior: "deny", message: "User cancelled tool execution." });
      const response = yield* Effect.result(
        adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("already-aborted"), {
          "Continue?": "Yes",
        }),
      );
      assert.equal(response._tag, "Failure");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("denies AskUserQuestion when the waiting turn is aborted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-62"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const controller = new AbortController();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          requestId: "permission-ask-abort",
          toolUseID: "tool-ask-abort",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      assert.equal(requestedEvent.value.threadId, session.threadId);

      controller.abort();

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});
      assert.equal(resolvedEvent.value.payload.cancelled, true);
      assert.deepEqual(resolvedEvent.value.payload.userInputIdentity, {
        requestEventId: requestedEvent.value.eventId,
        runtimeSessionId: session.runtimeSessionId,
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopping a session settles pending user-input waits", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-user-input-stop"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: new AbortController().signal,
          requestId: "permission-ask-stop",
          toolUseID: "tool-ask-stop",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }

      // The session dies while the question is still on screen.
      yield* adapter.stopSession(session.threadId);

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});
      assert.equal(resolvedEvent.value.payload.cancelled, true);
      assert.deepEqual(resolvedEvent.value.payload.userInputIdentity, {
        requestEventId: requestedEvent.value.eventId,
        runtimeSessionId: session.runtimeSessionId,
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("writes provider-native observability records when enabled", () => {
    const nativeEvents: Array<{
      event?: {
        provider?: string;
        method?: string;
        threadId?: string;
        turnId?: string;
      };
    }> = [];
    const nativeThreadIds: Array<string | null> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-native-events",
        write: (event, threadId) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-63"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-native-log",
        uuid: "stream-native-log",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-native-log",
        uuid: "result-native-log",
      } as unknown as SDKMessage);

      const turnCompleted = yield* Fiber.join(turnCompletedFiber);
      assert.equal(turnCompleted._tag, "Some");

      assert.equal(nativeEvents.length > 0, true);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "claudeAgent"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) =>
            String(
              (record.event as { readonly providerThreadId?: string } | undefined)
                ?.providerThreadId,
            ) === "sdk-session-native-log",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => String(record.event?.turnId) === String(turn.turnId)),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.method === "claude/stream_event/content_block_delta/text_delta",
        ),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === String(THREAD_ID)),
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not emit turn.completed for a result with no active turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-resume-handshake"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 1,
        session_id: "sdk-session-1",
        uuid: "result-real",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        session_id: "sdk-session-1",
        uuid: "result-handshake",
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const completions = runtimeEvents.filter((event) => event.type === "turn.completed");
      assert.equal(completions.length, 1);
      const completed = completions[0];
      if (completed?.type === "turn.completed") {
        assert.equal(String(completed.turnId), String(turn.turnId));
        assert.equal(completed.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("interruptTurn settles every acknowledged live task before interrupting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Wait for the three task.* runtime events to prove the lifecycle
      // handlers processed the emissions (no wall-clock sleeps under the
      // test clock).
      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-stop-tasks"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn agents",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-live",
        description: "Agent A",
        task_type: "local_agent",
        uuid: "task-live-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-settled",
        description: "Agent B",
        task_type: "local_agent",
        uuid: "task-settled-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-settled",
        status: "completed",
        output_file: "/tmp/task-settled.jsonl",
        summary: "done",
        uuid: "task-settled-done-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      yield* Fiber.join(taskEventsFiber);

      const stoppedTaskEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.interruptTurn(session.threadId);

      // Only the still-live task is stopped; interrupt always fires after.
      assert.deepEqual(harness.query.stopTaskCalls, ["task-live"]);
      assert.equal(harness.query.interruptCalls.length, 1);

      const stoppedTaskEvents = Array.from(yield* Fiber.join(stoppedTaskEventFiber));
      assert.equal(stoppedTaskEvents.length, 1);
      const stoppedTaskEvent = stoppedTaskEvents[0];
      assert.equal(stoppedTaskEvent?.type, "task.completed");
      if (stoppedTaskEvent?.type === "task.completed") {
        assert.equal(String(stoppedTaskEvent.payload.taskId), "task-live");
        assert.equal(stoppedTaskEvent.payload.status, "stopped");
        assert.equal(stoppedTaskEvent.payload.taskType, "local_agent");
        assert.equal(stoppedTaskEvent.payload.title, "Agent A");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("workflow member coalescing: identical snapshots suppress, changes emit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect task.progress until member-0's tick-3 emission lands, then
      // evaluate member emissions.
      const progressFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.progress"),
        Stream.takeUntil(
          // Sentinel: member-0's tick-3 emission (tokens 20) — members are
          // emitted after the coordinator row within a tick.
          (event) =>
            (event.payload as { taskId?: string }).taskId === "wf-coalesce:wf:0" &&
            (event.payload as { typedUsage?: { totalTokens?: number } }).typedUsage?.totalTokens ===
              20,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-wf-coalesce"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run workflow",
        attachments: [],
      });

      const memberSnapshot = (tokens: number) => [
        { type: "workflow_phase", index: 0, title: "Work" },
        {
          type: "workflow_agent",
          index: 0,
          state: "running",
          label: "member-0",
          phaseIndex: 0,
          tokens,
        },
        {
          type: "workflow_agent",
          index: 1,
          state: "running",
          label: "member-1",
          phaseIndex: 0,
          tokens: 50,
        },
      ];
      const tick = (usageTotal: number, snapshot: ReturnType<typeof memberSnapshot>) =>
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "wf-coalesce",
          description: "Coalescing workflow",
          usage: { total_tokens: usageTotal, tool_uses: 1, duration_ms: 10 },
          workflow_progress: snapshot,
          uuid: `wf-tick-${usageTotal}`,
          session_id: "sdk-session",
        } as unknown as SDKMessage);

      // Tick 1: both members are new -> 2 member events.
      tick(100, memberSnapshot(10));
      // Tick 2: IDENTICAL member snapshot -> 0 member events (coordinator
      // usage changed, but members did not).
      tick(200, memberSnapshot(10));
      // Tick 3: member-0's tokens advanced -> exactly 1 member event.
      tick(300, memberSnapshot(20));

      const progressEvents = Array.from(yield* Fiber.join(progressFiber));
      const byMember = new Map<string, number>();
      for (const event of progressEvents) {
        const taskId = (event.payload as { taskId: string }).taskId;
        if (!taskId.includes(":wf:")) continue;
        byMember.set(taskId, (byMember.get(taskId) ?? 0) + 1);
      }
      // member-0: tick 1 + tick 3. member-1: tick 1 only (tick 2 identical,
      // tick 3 unchanged).
      assert.equal(byMember.get("wf-coalesce:wf:0"), 2);
      assert.equal(byMember.get("wf-coalesce:wf:1"), 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("retains the complete workflow phase roster across sparse progress ticks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const coordinatorEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "task.progress" &&
            String((event.payload as { taskId?: unknown }).taskId) === "wf-sparse-phases",
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-wf-sparse-phases"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run workflow",
        attachments: [],
      });

      const phases = [
        { type: "workflow_phase", index: 1, title: "Work" },
        { type: "workflow_phase", index: 2, title: "Review" },
        { type: "workflow_phase", index: 3, title: "Verify" },
      ];
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "wf-sparse-phases",
        description: "Work, review, then verify",
        workflow_progress: phases,
        uuid: "wf-sparse-phases-full",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      // Real Claude workflow streams interleave thin coordinator heartbeats
      // that omit workflow_progress. This second tick replaces the same
      // latest-state activity, so it must repeat the remembered phase shape.
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "wf-sparse-phases",
        description: "Work, review, then verify",
        summary: "Work is still running",
        uuid: "wf-sparse-phases-thin",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      const coordinatorEvents = Array.from(yield* Fiber.join(coordinatorEventsFiber));
      assert.equal(coordinatorEvents.length, 2);
      for (const event of coordinatorEvents) {
        assert.equal(event.type, "task.progress");
        if (event.type === "task.progress") {
          assert.deepEqual(event.payload.phases, [
            { index: 1, title: "Work" },
            { index: 2, title: "Review" },
            { index: 3, title: "Verify" },
          ]);
        }
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const foreignResult of [
    { origin: { kind: "task-notification" } },
    { origin: { kind: "human" }, user_message_uuids: ["another-prompt"] },
    { user_message_uuid: "another-prompt" },
    { origin: { kind: "task-notification" }, user_message_uuids: [] },
  ]) {
    it.effect(
      `keeps a resumed compact turn open for its own result: ${JSON.stringify(foreignResult)}`,
      () => {
        const harness = makeHarness();
        return Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "session.exited"),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* adapter.startSession({
            runtimeSessionId: RuntimeSessionId.make("result-attribution"),
            threadId: THREAD_ID,
            provider: ProviderDriverKind.make("claudeAgent"),
            runtimeMode: "full-access",
            resumeCursor: { resume: "11111111-1111-4111-8111-111111111111" },
          });
          const turn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "/compact",
            attachments: [],
          });
          const prompt = yield* Effect.promise(() =>
            readFirstPromptMessage(harness.getLastCreateQueryInput()),
          );
          harness.query.emit({
            type: "result",
            subtype: "error_during_execution",
            errors: ["background failure"],
            num_turns: 0,
            session_id: "sdk-session",
            ...foreignResult,
          } as unknown as SDKMessage);
          harness.query.emit({
            type: "system",
            subtype: "compact_boundary",
            uuid: "boundary",
            session_id: "sdk-session",
            compact_metadata: { trigger: "manual", pre_tokens: 175_000, post_tokens: 42_000 },
          } as unknown as SDKMessage);
          harness.query.emit({
            type: "result",
            subtype: "success",
            result: "compacted",
            num_turns: 1,
            session_id: "sdk-session",
            user_message_uuids: ["batched-prompt", turn.turnId],
          } as unknown as SDKMessage);
          harness.query.finish();
          const events = Array.from(yield* Fiber.join(eventsFiber));
          const completions = events.filter((event) => event.type === "turn.completed");
          assert.equal(completions.length, 1);
          assert.equal(completions[0]?.payload.state, "completed");
          assert.equal(completions[0]?.turnId, turn.turnId);
          const boundary = events.find(
            (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
          );
          assert.equal(boundary?.turnId, turn.turnId);
          assert.isBelow(events.indexOf(boundary!), events.indexOf(completions[0]!));
          assert.isFalse(events.some((event) => event.type === "runtime.error"));
          assert.equal(String(prompt?.uuid), turn.turnId);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }

  for (const resultKind of ["legacy", "human", "single-uuid", "batch-uuid", "synthetic"] as const) {
    it.effect(`completes compatible Claude results: ${resultKind}`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "session.exited"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("compatible-result"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        const turn =
          resultKind === "synthetic"
            ? undefined
            : yield* adapter.sendTurn({
                threadId: THREAD_ID,
                input: "continue",
                attachments: [],
              });
        if (resultKind === "synthetic") {
          harness.query.emit({
            type: "assistant",
            parent_tool_use_id: null,
            uuid: "background-reply",
            session_id: "sdk-session",
            message: {
              id: "background-reply",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "Background report" }],
              usage: {},
            },
          } as unknown as SDKMessage);
        }
        harness.query.emit({
          type: "result",
          subtype: "success",
          result: "done",
          num_turns: 1,
          session_id: "sdk-session",
          ...(resultKind === "human" ? { origin: { kind: "human" }, user_message_uuids: [] } : {}),
          ...(resultKind === "single-uuid" ? { user_message_uuid: turn?.turnId } : {}),
          ...(resultKind === "batch-uuid"
            ? {
                origin: { kind: "task-notification" },
                user_message_uuids: ["other-prompt", turn?.turnId],
              }
            : {}),
          ...(resultKind === "synthetic"
            ? { origin: { kind: "task-notification" }, user_message_uuids: ["provider-prompt"] }
            : {}),
        } as unknown as SDKMessage);
        harness.query.finish();
        const completions = Array.from(yield* Fiber.join(eventsFiber)).filter(
          (event) => event.type === "turn.completed",
        );
        assert.equal(completions.length, 1);
        assert.equal(completions[0]?.payload.state, "completed");
        if (turn) assert.equal(completions[0]?.turnId, turn.turnId);
      }).pipe(Effect.provide(harness.layer));
    });
  }

  it.effect(
    "publishes subagent model changes immediately and links snapshot-only nested tools",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "session.exited"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("nested-snapshot"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "delegate", attachments: [] });
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "parent-agent",
          tool_use_id: "parent-tool",
          task_type: "local_agent",
          description: "Parent",
          uuid: "parent",
          session_id: "sdk-session",
        } as unknown as SDKMessage);
        const snapshot = {
          type: "assistant",
          parent_tool_use_id: "parent-tool",
          uuid: "snapshot",
          session_id: "sdk-session",
          message: {
            model: "claude-sonnet-4-6",
            content: [
              {
                type: "tool_use",
                id: "nested-tool",
                name: "Agent",
                input: { model: "haiku", effort: "low" },
              },
              { type: "tool_use", id: "shell-tool", name: "Bash", input: { command: "sleep 1" } },
            ],
          },
        } as unknown as SDKMessage;
        harness.query.emit(snapshot);
        harness.query.emit(snapshot);
        for (const [id, toolId, type] of [
          ["nested-agent", "nested-tool", "local_agent"],
          ["nested-shell", "shell-tool", "local_bash"],
        ]) {
          harness.query.emit({
            type: "system",
            subtype: "task_started",
            task_id: id,
            tool_use_id: toolId,
            task_type: type,
            description: id,
            uuid: id,
            session_id: "sdk-session",
          } as unknown as SDKMessage);
        }
        harness.query.finish();
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const updates = events.filter((event) => event.type === "task.updated");
        assert.equal(updates.length, 1);
        assert.equal(updates[0]?.payload.model, "claude-sonnet-4-6");
        assert.equal(updates[0]?.payload.status, undefined);
        const subagentUpdates = events.filter((event) => event.type === "subagent.updated");
        assert.equal(subagentUpdates.length, 1);
        assert.equal(subagentUpdates[0]?.payload.subagent.model, "claude-sonnet-4-6");
        assert.equal(subagentUpdates[0]?.payload.status, undefined);
        const nested = events.find(
          (event) => event.type === "task.started" && event.payload.taskId === "nested-agent",
        );
        assert.equal(nested?.type, "task.started");
        if (nested?.type === "task.started") {
          assert.equal(nested.payload.agentId, "parent-agent");
          assert.equal(nested.payload.model, "haiku");
          assert.equal(nested.payload.effort, "low");
        }
        const shell = events.find(
          (event) => event.type === "task.started" && event.payload.taskId === "nested-shell",
        );
        assert.equal(shell?.type, "task.started");
        if (shell?.type === "task.started") assert.equal(shell.payload.agentId, "parent-agent");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("subagent snapshots refine model linkage without guessing from the parent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.started" || event.type === "task.progress"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-task-model"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "high" }],
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn an agent",
        attachments: [],
      });

      // No launch input is available, so model identity stays pending until
      // the subagent reports its own authoritative assistant snapshot.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-model",
        description: "Agent M",
        task_type: "local_agent",
        tool_use_id: "toolu_agent_m",
        uuid: "task-model-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      // The subagent's assistant snapshot carries the authoritative API
      // model id, which refines the linkage on later rows.
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "toolu_agent_m",
        message: {
          model: "claude-sonnet-4-6",
          content: [],
        },
        uuid: "subagent-snapshot-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-model",
        description: "Agent M",
        usage: { total_tokens: 100, tool_uses: 1, duration_ms: 10 },
        uuid: "task-model-progress-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
      const started = taskEvents[0];
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.model, undefined);
        assert.equal(started.payload.effort, "high");
      }
      const progress = taskEvents[1];
      assert.equal(progress?.type, "task.progress");
      if (progress?.type === "task.progress") {
        assert.equal(progress.payload.model, "claude-sonnet-4-6");
        assert.equal(progress.payload.effort, "high");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not race delayed subagent model identity with a later parent turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const itemStartedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "item.started"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.started" || event.type === "task.progress"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-claudeadapter-delayed-task-model"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate on a smaller model",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-delayed-task-model",
        uuid: "stream-delayed-task-model",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_delayed_agent",
            name: "Task",
            input: {
              description: "Run a focused check",
              prompt: "Check the narrow surface",
              subagent_type: "general-purpose",
              model: "claude-haiku-4-5",
            },
          },
        },
      } as unknown as SDKMessage);
      yield* Fiber.join(itemStartedFiber);

      // A later parent turn changes the mutable session model before the SDK
      // delivers task_started for the already-launched background task.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "continue on the new parent model",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
        ),
        attachments: [],
      });
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-delayed-model",
        description: "Run a focused check",
        task_type: "local_agent",
        tool_use_id: "toolu_delayed_agent",
        uuid: "task-delayed-model-started",
        session_id: "sdk-session-delayed-task-model",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "toolu_delayed_agent",
        message: {
          model: "claude-haiku-4-5-20251001",
          content: [],
        },
        uuid: "task-delayed-model-snapshot",
        session_id: "sdk-session-delayed-task-model",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-delayed-model",
        description: "Run a focused check",
        usage: { total_tokens: 50, tool_uses: 1, duration_ms: 5 },
        uuid: "task-delayed-model-progress",
        session_id: "sdk-session-delayed-task-model",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
      const started = taskEvents[0];
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.model, "claude-haiku-4-5");
      }
      const progress = taskEvents[1];
      assert.equal(progress?.type, "task.progress");
      if (progress?.type === "task.progress") {
        assert.equal(progress.payload.model, "claude-haiku-4-5-20251001");
      }
      assert.deepEqual(harness.query.setModelCalls, ["claude-sonnet-4-6[1m]"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
  it.effect(
    "normalizes detached task evidence and uses individual stop without stopping its peers",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "task.started" || event.type === "task.updated"),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("background-test"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "foreground",
          task_type: "local_bash",
          description: "Foreground command",
          session_id: "sdk",
          uuid: "bg-foreground",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            { task_id: "foreground", task_type: "local_bash", description: "Now detached" },
            { task_id: "watch", task_type: "local_bash", description: "Watch CI" },
          ],
          session_id: "sdk",
          uuid: "bg-set",
        } as unknown as SDKMessage);
        const observed = yield* Fiber.join(events);
        assert.equal(observed[0]?.type, "task.started");
        if (observed[0]?.type === "task.started")
          assert.isUndefined(observed[0].payload.isBackgrounded);
        for (const event of observed.slice(1)) {
          if (event.type === "task.started" || event.type === "task.updated") {
            assert.isTrue(event.payload.isBackgrounded);
            assert.isTrue(event.payload.canStop);
            assert.equal(event.runtimeSessionId, "background-test");
          }
        }
        yield* adapter.stopBackgroundTask!(THREAD_ID, "watch");
        assert.deepEqual(harness.query.stopTaskCalls, ["watch"]);
        assert.lengthOf(harness.query.interruptCalls, 0);
        // Acceptance does not remove the task; another request is safe until
        // the provider's lifecycle stream confirms settlement.
        yield* adapter.stopBackgroundTask!(THREAD_ID, "watch");
        assert.deepEqual(harness.query.stopTaskCalls, ["watch", "watch"]);
        const completion = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "task.completed"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "foreground", task_type: "local_bash" }],
          session_id: "sdk",
          uuid: "bg-drained",
        } as unknown as SDKMessage);
        yield* Fiber.join(completion);
        yield* adapter.stopBackgroundTask!(THREAD_ID, "watch");
        assert.deepEqual(harness.query.stopTaskCalls, ["watch", "watch"]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
  it.effect(
    "rejects a retained background stop after runtime replacement and task ID reuse",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const started = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "task.started"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("new-runtime"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "reused-task",
          task_type: "local_bash",
          is_backgrounded: true,
          description: "New task",
          session_id: "sdk",
          uuid: "reused-start",
        } as unknown as SDKMessage);
        yield* Fiber.join(started);
        const result = yield* adapter.stopBackgroundTask!(THREAD_ID, "reused-task", {
          runtimeSessionId: RuntimeSessionId.make("old-runtime"),
          attempt: 0,
        }).pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        assert.lengthOf(harness.query.stopTaskCalls, 0);
        const completed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "task.completed"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "reused-task",
          status: "completed",
          session_id: "sdk",
          uuid: "reused-completed",
        } as unknown as SDKMessage);
        yield* Fiber.join(completed);
        const restarted = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "task.started"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "reused-task",
          task_type: "local_bash",
          is_backgrounded: true,
          description: "Second activation",
          session_id: "sdk",
          uuid: "reused-again",
        } as unknown as SDKMessage);
        const events = yield* Fiber.join(restarted);
        if (events[0]?.type === "task.started") assert.equal(events[0].payload.attempt, 1);
        const oldAttempt = yield* adapter.stopBackgroundTask!(THREAD_ID, "reused-task", {
          runtimeSessionId: RuntimeSessionId.make("new-runtime"),
          attempt: 0,
        }).pipe(Effect.exit);
        assert.equal(oldAttempt._tag, "Failure");
        assert.lengthOf(harness.query.stopTaskCalls, 0);
        yield* adapter.stopBackgroundTask!(THREAD_ID, "reused-task", {
          runtimeSessionId: RuntimeSessionId.make("new-runtime"),
          attempt: 1,
        });
        assert.deepEqual(harness.query.stopTaskCalls, ["reused-task"]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
  it.effect(
    "persists main-loop cache evidence without duplicate freshness or subagent pollution",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "session.exited"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("cache-runtime"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Fixture prompt", attachments: [] });
        const assistant = {
          type: "assistant",
          uuid: "fixture-main",
          session_id: "fixture-session",
          parent_tool_use_id: null,
          message: {
            id: "fixture-request",
            model: "claude-sonnet-4-6",
            content: [],
            usage: {
              input_tokens: 12,
              cache_read_input_tokens: 50_000,
              cache_creation_input_tokens: 2_000,
              output_tokens: 1,
            },
          },
        } as unknown as SDKMessage;
        harness.query.emit(assistant);
        harness.query.emit(assistant);
        harness.query.emit({
          ...assistant,
          uuid: "fixture-child",
          parent_tool_use_id: "child-tool",
          message: {
            id: "child-request",
            model: "haiku",
            content: [],
            usage: {
              input_tokens: 9_999,
              cache_read_input_tokens: 999_999,
              cache_creation_input_tokens: 8_888,
              output_tokens: 1,
            },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "child-task",
          task_type: "local_agent",
          tool_use_id: "child-tool",
          description: "Child fixture",
          session_id: "fixture-session",
          uuid: "child-start",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "child-task",
          task_type: "local_agent",
          description: "Child progress",
          usage: {
            total_tokens: 999_999,
            input_tokens: 9_999,
            cache_read_input_tokens: 999_999,
            cache_creation_input_tokens: 8_888,
            output_tokens: 100,
          },
          session_id: "fixture-session",
          uuid: "child-progress",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 1,
          result: "done",
          session_id: "fixture-session",
          uuid: "fixture-result",
          modelUsage: {
            "claude-sonnet-4-6": { contextWindow: 200_000 },
            "claude-haiku-4-5": { contextWindow: 1_000_000 },
          },
          usage: {
            input_tokens: 120,
            cache_read_input_tokens: 100_000,
            cache_creation_input_tokens: 4_000,
            output_tokens: 600,
          },
        } as unknown as SDKMessage);
        harness.query.finish();
        const events = yield* Fiber.join(eventsFiber);
        const usageEvents = events.filter((event) => event.type === "thread.token-usage.updated");
        assert.equal(usageEvents.length, 2);
        const first = usageEvents[0]?.payload.usage.claudeCache;
        const last = usageEvents[1]?.payload.usage.claudeCache;
        assert.equal(first?.cacheReadInputTokens, 50_000);
        assert.equal(first?.directInputTokens, 12);
        assert.equal(first?.cacheWriteInputTokens, 2_000);
        assert.equal(first?.runtimeSessionId, "cache-runtime");
        assert.equal(last?.observedAt, first?.observedAt);
        assert.equal(last?.messageId, "fixture-request");
        assert.equal(last?.mainLoopTotals?.outputTokens, 600);
        assert.equal(last?.mainLoopTotals?.cacheWriteInputTokens, 4_000);
        assert.equal(usageEvents[1]?.payload.usage.usedTokens, 52_012);
        assert.equal(usageEvents[1]?.payload.usage.maxTokens, 200_000);
        const childUsage = events.find((event) => event.type === "task.progress")?.payload
          .typedUsage;
        assert.equal(childUsage?.directInputTokens, 9_999);
        assert.equal(childUsage?.cacheWriteInputTokens, 8_888);
        assert.equal(childUsage?.cachedInputTokens, 999_999);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
  it.effect(
    "sends an exact native compact command without effort or source-context decoration",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("compact-native"),
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "/compact",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-6",
            options: [{ id: "effort", value: "ultrathink" }],
          },
        });
        const prompt = yield* Effect.promise(() =>
          readFirstPromptText(harness.getLastCreateQueryInput()),
        );
        assert.equal(prompt, "/compact");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});

const GAUGE_MODEL = "claude-sonnet-4-6";
const GAUGE_SDK_SESSION = "sdk-session-gauge";

function rootAssistantFrame(
  id: string,
  usage: Record<string, number> = {},
  content: ReadonlyArray<unknown> = [],
): SDKMessage {
  return {
    type: "assistant",
    uuid: id,
    session_id: GAUGE_SDK_SESSION,
    parent_tool_use_id: null,
    message: { id, model: GAUGE_MODEL, content, usage },
  } as unknown as SDKMessage;
}

function resultFrame(
  input: {
    readonly usage?: Record<string, number>;
    readonly contextWindow?: number;
    readonly subtype?: "success" | "error_during_execution";
  } & Record<string, unknown> = {},
): SDKMessage {
  const { usage, contextWindow, subtype = "success", ...extra } = input;
  return {
    type: "result",
    subtype,
    is_error: false,
    num_turns: 1,
    session_id: GAUGE_SDK_SESSION,
    ...(subtype === "success" ? { result: "done" } : { errors: ["Claude turn failed."] }),
    ...(usage ? { usage } : {}),
    ...(contextWindow
      ? { modelUsage: { [GAUGE_MODEL]: { contextWindow, maxOutputTokens: 64_000 } } }
      : {}),
    ...extra,
  } as unknown as SDKMessage;
}

function compactBoundaryFrame(compactMetadata: Record<string, unknown>): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: compactMetadata,
    uuid: "compact-boundary",
    session_id: GAUGE_SDK_SESSION,
  } as unknown as SDKMessage;
}

function systemStatusFrame(status: "requesting" | "compacting" | null): SDKMessage {
  return {
    type: "system",
    subtype: "status",
    status,
    uuid: `status-${String(status)}`,
    session_id: GAUGE_SDK_SESSION,
  } as unknown as SDKMessage;
}

function systemInitFrame(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    model: GAUGE_MODEL,
    cwd: "/tmp/claude-adapter-test",
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    permissionMode: "bypassPermissions",
    apiKeySource: "none",
    claude_code_version: "2.1.288",
    uuid: "init",
    session_id: GAUGE_SDK_SESSION,
  } as unknown as SDKMessage;
}

/**
 * A frame that produces exactly one `hook.started` event and changes no turn state. The stream
 * fiber handles frames in order, so waiting for it proves every earlier frame was handled.
 */
function sentinelFrame(id: string): SDKMessage {
  return {
    type: "system",
    subtype: "hook_started",
    hook_id: id,
    hook_name: "sentinel",
    hook_event: "Notification",
    uuid: `sentinel-${id}`,
    session_id: GAUGE_SDK_SESSION,
  } as unknown as SDKMessage;
}

const isSentinel = (id: string) => (event: ProviderRuntimeEvent) =>
  event.type === "hook.started" && event.payload.hookId === id;

/**
 * Collects every runtime event while letting a test wait for a specific one. A closed gate parks
 * the consumer after each event, so (with a tiny adapter queue) the adapter blocks mid-emit.
 */
function makeRuntimeEventLog(adapter: ClaudeAdapterShape) {
  return Effect.gen(function* () {
    const events: Array<ProviderRuntimeEvent> = [];
    const pending = yield* Queue.unbounded<ProviderRuntimeEvent>();
    let gate: Deferred.Deferred<void> | undefined;
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Queue.offer(pending, event).pipe(
          Effect.andThen(Effect.suspend(() => (gate ? Deferred.await(gate) : Effect.void))),
        ),
      ),
      Effect.forkChild,
    );
    const closeGate = Effect.sync(() => {
      gate ??= Deferred.makeUnsafe<void>();
    });
    const openGate = Effect.suspend(() => {
      const closed = gate;
      gate = undefined;
      return closed ? Deferred.succeed(closed, undefined) : Effect.void;
    });
    const waitFor = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(pending);
          events.push(event);
          if (predicate(event)) return event;
        }
      });
    /** Moves already-delivered events into the log without waiting. */
    const drain = Effect.gen(function* () {
      for (let round = 0; round < 8; round += 1) yield* Effect.yieldNow;
      while (true) {
        const next = yield* Queue.poll(pending);
        if (Option.isNone(next)) return;
        events.push(next.value);
      }
    });
    return { events, waitFor, drain, closeGate, openGate };
  });
}

function rootToolStartFrame(index: number, toolUseId: string): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: `tool-start-${toolUseId}`,
    session_id: GAUGE_SDK_SESSION,
    event: {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: toolUseId, name: "Bash", input: {} },
    },
  } as unknown as SDKMessage;
}

const isTurnTerminal = (event: ProviderRuntimeEvent) =>
  event.type === "turn.completed" || event.type === "turn.aborted";

function assertEveryTurnTerminatesOnce(events: ReadonlyArray<ProviderRuntimeEvent>) {
  const started = events.filter((event) => event.type === "turn.started");
  assert.isAbove(started.length, 0);
  for (const turn of started) {
    const terminals = events.filter(
      (event) => isTurnTerminal(event) && event.turnId === turn.turnId,
    );
    assert.equal(terminals.length, 1, `turn ${String(turn.turnId)} terminal events`);
  }
}

const yieldTimes = (times: number) =>
  Effect.gen(function* () {
    for (let round = 0; round < times; round += 1) yield* Effect.yieldNow;
  });

const isUsageEvent = (event: ProviderRuntimeEvent) => event.type === "thread.token-usage.updated";

function lastUsageBefore(events: ReadonlyArray<ProviderRuntimeEvent>, index: number) {
  const usage = events.slice(0, index).findLast(isUsageEvent);
  return usage?.type === "thread.token-usage.updated" ? usage.payload.usage : undefined;
}

describe("ClaudeAdapterLive context meter across compaction", () => {
  const startGaugeSession = (adapter: ClaudeAdapterShape, runtimeSessionId: string) =>
    adapter.startSession({
      runtimeSessionId: RuntimeSessionId.make(runtimeSessionId),
      threadId: THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });

  /** One completed prompt turn whose main loop reported usage and a 200k window. */
  const completeFirstTurn = (
    adapter: ClaudeAdapterShape,
    query: FakeClaudeQuery,
    log: Effect.Success<ReturnType<typeof makeRuntimeEventLog>>,
  ) =>
    Effect.gen(function* () {
      const first = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "fill",
        attachments: [],
      });
      query.emit(
        rootAssistantFrame("assistant-first", {
          input_tokens: 12,
          cache_read_input_tokens: 160_000,
          cache_creation_input_tokens: 8_000,
          output_tokens: 1,
        }),
      );
      query.emit(
        resultFrame({
          usage: { input_tokens: 12, cache_read_input_tokens: 160_000, output_tokens: 900 },
          contextWindow: 200_000,
        }),
      );
      yield* log.waitFor(
        (event) => event.type === "turn.completed" && event.turnId === first.turnId,
      );
      return first;
    });

  it.effect("publishes post_tokens at a /compact boundary and never the cumulative total", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startGaugeSession(adapter, "gauge-compact-post");
      yield* completeFirstTurn(adapter, harness.query, log);

      const compact = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "/compact",
        attachments: [],
      });
      harness.query.emit(systemStatusFrame("compacting"));
      harness.query.emit(
        compactBoundaryFrame({ trigger: "manual", pre_tokens: 168_012, post_tokens: 41_999.6 }),
      );
      harness.query.emit(sentinelFrame("after-boundary"));
      const sentinelStart = log.events.length;
      yield* log.waitFor(isSentinel("after-boundary"));
      const boundaryUsage = log.events.slice(sentinelStart).find(isUsageEvent);
      assert.equal(boundaryUsage?.turnId, compact.turnId);
      if (boundaryUsage?.type === "thread.token-usage.updated") {
        assert.deepEqual(boundaryUsage.payload.usage, { usedTokens: 42_000, maxTokens: 200_000 });
      }

      harness.query.emit(
        resultFrame({
          user_message_uuids: [compact.turnId],
          usage: { input_tokens: 3, cache_read_input_tokens: 168_000, output_tokens: 4_000 },
          contextWindow: 200_000,
        }),
      );
      harness.query.finish();
      yield* log.waitFor((event) => event.type === "session.exited");

      const events = log.events;
      const completedIndex = events.findIndex(
        (event) => event.type === "turn.completed" && event.turnId === compact.turnId,
      );
      assert.isAbove(completedIndex, -1);
      const finalGauge = lastUsageBefore(events, completedIndex);
      assert.equal(finalGauge?.usedTokens, 42_000);
      assert.equal(finalGauge?.totalProcessedTokens, 172_003);
      assert.isUndefined(finalGauge?.claudeCache);
      const boundaryIndex = events.findIndex(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      for (const event of events.slice(boundaryIndex)) {
        if (event.type === "thread.token-usage.updated") {
          assert.isBelow(event.payload.usage.usedTokens, 168_000);
        }
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("publishes no gauge after a boundary that has no post_tokens", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startGaugeSession(adapter, "gauge-compact-no-post");
      yield* completeFirstTurn(adapter, harness.query, log);

      const compact = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "/compact",
        attachments: [],
      });
      harness.query.emit(systemStatusFrame("compacting"));
      harness.query.emit(compactBoundaryFrame({ trigger: "manual", pre_tokens: 168_012 }));
      harness.query.emit(
        resultFrame({
          user_message_uuids: [compact.turnId],
          usage: { input_tokens: 3, cache_read_input_tokens: 168_000, output_tokens: 4_000 },
          contextWindow: 200_000,
        }),
      );
      harness.query.finish();
      yield* log.waitFor((event) => event.type === "session.exited");

      const boundaryIndex = log.events.findIndex(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      assert.isAbove(boundaryIndex, -1);
      assert.isFalse(log.events.slice(boundaryIndex).some(isUsageEvent));
      assert.isTrue(
        log.events.some(
          (event) => event.type === "turn.completed" && event.turnId === compact.turnId,
        ),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("lets the next main-loop request replace the post-compaction gauge", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startGaugeSession(adapter, "gauge-auto-compact");
      yield* completeFirstTurn(adapter, harness.query, log);

      const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "more", attachments: [] });
      harness.query.emit(systemStatusFrame("compacting"));
      harness.query.emit(
        compactBoundaryFrame({ trigger: "auto", pre_tokens: 175_000, post_tokens: 42_000 }),
      );
      harness.query.emit(
        rootAssistantFrame("assistant-after-compact", {
          input_tokens: 7,
          cache_read_input_tokens: 40_000,
          cache_creation_input_tokens: 6_993,
          output_tokens: 1,
        }),
      );
      harness.query.emit(
        resultFrame({
          user_message_uuids: [turn.turnId],
          usage: { input_tokens: 10, cache_read_input_tokens: 215_000, output_tokens: 2_000 },
          contextWindow: 200_000,
        }),
      );
      harness.query.finish();
      yield* log.waitFor((event) => event.type === "session.exited");

      const completedIndex = log.events.findIndex(
        (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
      );
      assert.equal(lastUsageBefore(log.events, completedIndex)?.usedTokens, 47_000);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps legacy task telemetry off the gauge after a boundary", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startGaugeSession(adapter, "gauge-legacy-telemetry");
      yield* completeFirstTurn(adapter, harness.query, log);

      const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "more", attachments: [] });
      harness.query.emit(systemStatusFrame("compacting"));
      harness.query.emit(
        compactBoundaryFrame({ trigger: "auto", pre_tokens: 175_000, post_tokens: 42_000 }),
      );
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-never-started",
        status: "completed",
        output_file: "/tmp/task-never-started.jsonl",
        summary: "done",
        usage: { total_tokens: 150_000 },
        uuid: "task-never-started-done",
        session_id: GAUGE_SDK_SESSION,
      } as unknown as SDKMessage);
      harness.query.emit(
        resultFrame({
          user_message_uuids: [turn.turnId],
          usage: { input_tokens: 10, cache_read_input_tokens: 190_000, output_tokens: 2_000 },
          contextWindow: 200_000,
        }),
      );
      harness.query.finish();
      yield* log.waitFor((event) => event.type === "session.exited");

      assert.isFalse(
        log.events.some(
          (event) =>
            event.type === "thread.token-usage.updated" &&
            event.payload.usage.usedTokens === 150_000,
        ),
      );
      const completedIndex = log.events.findIndex(
        (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
      );
      assert.equal(lastUsageBefore(log.events, completedIndex)?.usedTokens, 42_000);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("publishes a boundary that arrives while no turn is open", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startGaugeSession(adapter, "gauge-idle-boundary");
      yield* completeFirstTurn(adapter, harness.query, log);

      harness.query.emit(
        compactBoundaryFrame({ trigger: "auto", pre_tokens: 175_000, post_tokens: 42_000 }),
      );
      harness.query.emit(sentinelFrame("after-idle-boundary"));
      const sentinelStart = log.events.length;
      yield* log.waitFor(isSentinel("after-idle-boundary"));
      const boundaryUsage = log.events.slice(sentinelStart).find(isUsageEvent);
      assert.isDefined(boundaryUsage);
      assert.isUndefined(boundaryUsage?.turnId);
      if (boundaryUsage?.type === "thread.token-usage.updated") {
        assert.equal(boundaryUsage.payload.usage.usedTokens, 42_000);
      }

      harness.query.emit(
        resultFrame({
          origin: { kind: "task-notification" },
          usage: { input_tokens: 10, cache_read_input_tokens: 189_990 },
          contextWindow: 200_000,
        }),
      );
      const resultUsage = yield* log.waitFor(isUsageEvent);
      assert.isUndefined(resultUsage.turnId);
      if (resultUsage.type === "thread.token-usage.updated") {
        assert.equal(resultUsage.payload.usage.usedTokens, 42_000);
        assert.equal(resultUsage.payload.usage.totalProcessedTokens, 190_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive turn ownership", () => {
  it.effect("closes a provider turn opened while sendTurn awaited the SDK", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("ownership-send-orphan"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      let releaseGate: () => void = () => undefined;
      harness.query.permissionModeGate = new Promise((resolve) => {
        releaseGate = resolve;
      });
      const entered = harness.query.permissionModeEntered();
      const sendFiber = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "user prompt", interactionMode: "default" })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => entered);

      harness.query.emit(
        rootAssistantFrame("background-reply", {}, [{ type: "text", text: "Bg" }]),
      );
      const providerStarted = yield* log.waitFor((event) => event.type === "turn.started");
      const providerTurnId = providerStarted.turnId;

      releaseGate();
      const userTurn = yield* Fiber.join(sendFiber);
      assert.notEqual(userTurn.turnId, providerTurnId);
      harness.query.emit(resultFrame({ user_message_uuids: [userTurn.turnId] }));
      harness.query.emit(sentinelFrame("after-user-result"));
      yield* log.waitFor(isSentinel("after-user-result"));
      harness.query.finish();
      yield* log.waitFor((event) => event.type === "session.exited");

      const events = log.events;
      const providerCompleted = events.findIndex(
        (event) => event.type === "turn.completed" && event.turnId === providerTurnId,
      );
      const userStarted = events.findIndex(
        (event) => event.type === "turn.started" && event.turnId === userTurn.turnId,
      );
      assert.isAbove(providerCompleted, -1);
      assert.isBelow(providerCompleted, userStarted);
      const userCompleted = events.find(
        (event) => event.type === "turn.completed" && event.turnId === userTurn.turnId,
      );
      assert.equal(
        userCompleted?.type === "turn.completed" && userCompleted.payload.state,
        "completed",
      );
      assertEveryTurnTerminatesOnce(events);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("never closes a turn twice when sendTurn races the stream's completion", () => {
    const harness = makeHarness({ runtimeEventQueueCapacity: 1 });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("ownership-double-close"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit(rootAssistantFrame("background-reply"));
      const providerStarted = yield* log.waitFor((event) => event.type === "turn.started");
      const providerTurnId = providerStarted.turnId;
      harness.query.emit(rootToolStartFrame(0, "tool-a"));
      harness.query.emit(rootToolStartFrame(1, "tool-b"));
      yield* log.waitFor(
        (event) => event.type === "item.started" && String(event.itemId) === "tool-b",
      );

      // With the consumer parked, completeTurn(S) blocks on its second or third emit.
      yield* log.closeGate;
      harness.query.emit(
        resultFrame({
          origin: { kind: "task-notification" },
          usage: { input_tokens: 10, cache_read_input_tokens: 20_000, output_tokens: 30 },
        }),
      );
      yield* log.waitFor((event) => event.type === "item.completed");
      const sendFiber = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "user prompt" })
        .pipe(Effect.forkChild);
      yield* yieldTimes(20);
      yield* log.openGate;

      const userTurn = yield* Fiber.join(sendFiber);
      harness.query.emit(resultFrame({ user_message_uuids: [userTurn.turnId] }));
      harness.query.emit(sentinelFrame("after-user-result"));
      yield* log.waitFor(isSentinel("after-user-result"));

      const events = log.events;
      const providerCompletions = events.filter(
        (event) => event.type === "turn.completed" && event.turnId === providerTurnId,
      );
      assert.equal(providerCompletions.length, 1);
      const providerCompleted = events.indexOf(providerCompletions[0]!);
      const userStarted = events.findIndex(
        (event) => event.type === "turn.started" && event.turnId === userTurn.turnId,
      );
      assert.isBelow(providerCompleted, userStarted);
      assert.isTrue(
        events.some((event) => event.type === "turn.completed" && event.turnId === userTurn.turnId),
      );
      const [session] = yield* adapter.listSessions();
      assert.isUndefined(session?.activeTurnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

function rootStreamFrame(uuid: string, event: Record<string, unknown>): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    uuid,
    session_id: GAUGE_SDK_SESSION,
    event,
  } as unknown as SDKMessage;
}

function taskNotificationFrame(taskId: string): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status: "completed",
    output_file: `/tmp/${taskId}.jsonl`,
    summary: "Background command finished",
    uuid: `task-notification-${taskId}`,
    session_id: GAUGE_SDK_SESSION,
  } as unknown as SDKMessage;
}

const WAKE_NO_OUTPUT_REASON = "Claude started a background turn but produced no output.";

describe("ClaudeAdapterLive provider wake turns", () => {
  const startWakeSession = (
    adapter: ClaudeAdapterShape,
    runtimeSessionId: string,
    resumeCursor?: Record<string, unknown>,
  ) =>
    adapter.startSession({
      runtimeSessionId: RuntimeSessionId.make(runtimeSessionId),
      threadId: THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
      ...(resumeCursor ? { resumeCursor } : {}),
    });

  type EventLog = Effect.Success<ReturnType<typeof makeRuntimeEventLog>>;

  /** Emits a sentinel and waits for it: every earlier frame has been handled. */
  const settle = (query: FakeClaudeQuery, log: EventLog, id: string) =>
    Effect.gen(function* () {
      query.emit(sentinelFrame(id));
      yield* log.waitFor(isSentinel(id));
    });

  /** One prompt turn shaped like a real CLI turn (init, optionally status, output, result). */
  const completePromptTurn = (
    adapter: ClaudeAdapterShape,
    query: FakeClaudeQuery,
    log: EventLog,
    options: { readonly emitsStatus: boolean } = { emitsStatus: true },
  ) =>
    Effect.gen(function* () {
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "prompt",
        attachments: [],
      });
      query.emit(systemInitFrame());
      if (options.emitsStatus) query.emit(systemStatusFrame("requesting"));
      query.emit(
        rootAssistantFrame(`assistant-${String(turn.turnId)}`, {}, [{ type: "text", text: "Ok" }]),
      );
      query.emit(resultFrame({ user_message_uuids: [turn.turnId] }));
      yield* log.waitFor(
        (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
      );
      return turn;
    });

  const turnStartsAfter = (log: EventLog, from: number) =>
    log.events.slice(from).filter((event) => event.type === "turn.started");

  /** Opens a wake turn through the idle `status: requesting` signal and returns its id. */
  const openWakeTurn = (query: FakeClaudeQuery, log: EventLog, id: string) =>
    Effect.gen(function* () {
      const from = log.events.length;
      query.emit(systemInitFrame());
      query.emit(systemStatusFrame("requesting"));
      yield* settle(query, log, id);
      const started = turnStartsAfter(log, from);
      assert.equal(started.length, 1, "wake turn opened at status: requesting");
      return started[0]!.turnId!;
    });

  const lifecycleFor = (log: EventLog, turnId: unknown) =>
    log.events.filter(
      (event) =>
        (event.type === "turn.started" || isTurnTerminal(event)) && event.turnId === turnId,
    );

  it.effect("opens a wake turn at the idle status: requesting, before any output", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startWakeSession(adapter, "wake-requesting");
      yield* completePromptTurn(adapter, harness.query, log);
      const idleFrom = log.events.length;

      harness.query.emit(taskNotificationFrame("bg-sleep"));
      harness.query.emit(systemInitFrame());
      yield* settle(harness.query, log, "after-idle-init");
      assert.lengthOf(turnStartsAfter(log, idleFrom), 0);

      harness.query.emit(systemStatusFrame("requesting"));
      yield* settle(harness.query, log, "after-requesting");
      const started = turnStartsAfter(log, idleFrom);
      assert.lengthOf(started, 1);
      const wakeStart = started[0]!;
      const wakeTurnId = wakeStart.turnId;
      assert.equal(
        (wakeStart.raw?.payload as { readonly openedBy?: string } | undefined)?.openedBy,
        "wake-signal",
      );
      const requesting = log.events.findLast(
        (event) =>
          event.type === "session.state.changed" && event.payload.reason === "status:requesting",
      );
      assert.equal(requesting?.turnId, wakeTurnId);
      assert.isAbove(log.events.indexOf(requesting!), log.events.indexOf(wakeStart));
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, wakeTurnId);

      harness.query.emit(
        rootStreamFrame("wake-message-start", {
          type: "message_start",
          message: { id: "wake-message", model: GAUGE_MODEL, content: [], usage: {} },
        }),
      );
      harness.query.emit(
        rootStreamFrame("wake-thinking-start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
      );
      harness.query.emit(
        rootStreamFrame("wake-thinking-delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "The sleep finished." },
        }),
      );
      yield* settle(harness.query, log, "after-thinking");
      const wakeEvents = log.events.slice(idleFrom);
      const reasoning = wakeEvents.find(
        (event) => event.type === "item.started" && event.payload.itemType === "reasoning",
      );
      assert.equal(reasoning?.turnId, wakeTurnId);
      const delta = wakeEvents.find((event) => event.type === "content.delta");
      assert.equal(delta?.turnId, wakeTurnId);
      assert.equal(
        delta?.type === "content.delta" ? delta.payload.streamKind : undefined,
        "reasoning_text",
      );

      harness.query.emit(
        rootAssistantFrame("wake-reply", {}, [{ type: "text", text: "The sleep finished." }]),
      );
      harness.query.emit(resultFrame({ origin: { kind: "task-notification" } }));
      yield* settle(harness.query, log, "after-wake-result");
      assert.deepEqual(
        lifecycleFor(log, wakeTurnId).map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
      assert.isUndefined((yield* adapter.listSessions())[0]?.activeTurnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("opens no wake turn before the first prompt of a resumed session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startWakeSession(adapter, "wake-resume-handshake", {
        threadId: THREAD_ID,
        resume: "11111111-1111-4111-8111-111111111111",
        turnCount: 2,
      });
      harness.query.emit(systemInitFrame());
      harness.query.emit(systemStatusFrame("requesting"));
      yield* settle(harness.query, log, "after-handshake");
      assert.lengthOf(turnStartsAfter(log, 0), 0);
      assert.isUndefined((yield* adapter.listSessions())[0]?.activeTurnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("opens no turn for an empty notification turn or an init on a modern CLI", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startWakeSession(adapter, "wake-empty-notification");
      yield* completePromptTurn(adapter, harness.query, log);
      const idleFrom = log.events.length;

      harness.query.emit(systemInitFrame());
      yield* settle(harness.query, log, "after-idle-init");
      assert.lengthOf(turnStartsAfter(log, idleFrom), 0);
      harness.query.emit(resultFrame({ num_turns: 0, origin: { kind: "task-notification" } }));
      yield* settle(harness.query, log, "after-empty-result");
      assert.isFalse(
        log.events
          .slice(idleFrom)
          .some((event) => event.type === "turn.started" || isTurnTerminal(event)),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("opens no wake turn while a send is installing its turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startWakeSession(adapter, "wake-install-in-flight");
      yield* completePromptTurn(adapter, harness.query, log);
      const idleFrom = log.events.length;

      let releaseGate: () => void = () => undefined;
      harness.query.permissionModeGate = new Promise((resolve) => {
        releaseGate = resolve;
      });
      const entered = harness.query.permissionModeEntered();
      const sendFiber = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "user prompt", interactionMode: "default" })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => entered);
      harness.query.emit(systemStatusFrame("requesting"));
      yield* settle(harness.query, log, "after-gated-requesting");
      releaseGate();
      const userTurn = yield* Fiber.join(sendFiber);
      yield* settle(harness.query, log, "after-install");

      const started = turnStartsAfter(log, idleFrom);
      assert.deepEqual(
        started.map((event) => event.turnId),
        [userTurn.turnId],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to init on CLIs that never emit status: requesting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startWakeSession(adapter, "wake-legacy-init");
      yield* completePromptTurn(adapter, harness.query, log, { emitsStatus: false });
      const idleFrom = log.events.length;

      harness.query.emit(systemInitFrame());
      yield* settle(harness.query, log, "after-legacy-init");
      const started = turnStartsAfter(log, idleFrom);
      assert.lengthOf(started, 1);
      assert.equal(
        (started[0]!.raw?.payload as { readonly openedBy?: string } | undefined)?.openedBy,
        "wake-signal",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("aborts a wake turn that produces no output for two minutes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startWakeSession(adapter, "wake-watchdog");
      yield* completePromptTurn(adapter, harness.query, log);
      const wakeTurnId = yield* openWakeTurn(harness.query, log, "after-wake-open");
      yield* yieldTimes(10);

      yield* TestClock.adjust("119 seconds");
      yield* log.drain;
      assert.deepEqual(
        lifecycleFor(log, wakeTurnId).map((event) => event.type),
        ["turn.started"],
      );

      yield* TestClock.adjust("1 second");
      const aborted = yield* log.waitFor(isTurnTerminal);
      assert.equal(aborted.type, "turn.aborted");
      assert.equal(aborted.turnId, wakeTurnId);
      if (aborted.type === "turn.aborted") {
        assert.equal(aborted.payload.reason, WAKE_NO_OUTPUT_REASON);
      }
      yield* log.drain;
      const [session] = yield* adapter.listSessions();
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      harness.query.finish();
      yield* log.waitFor((event) => event.type === "session.exited");
      assert.deepEqual(
        lifecycleFor(log, wakeTurnId).map((event) => event.type),
        ["turn.started", "turn.aborted"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const [label, liveness] of [
    ["the compacting heartbeat", systemStatusFrame("compacting")],
    [
      "a root message_start",
      rootStreamFrame("wake-message-start", {
        type: "message_start",
        message: { id: "wake-message", model: GAUGE_MODEL, content: [], usage: {} },
      }),
    ],
  ] as const) {
    it.effect(`keeps a wake turn alive after ${label}`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const log = yield* makeRuntimeEventLog(adapter);
        yield* startWakeSession(adapter, "wake-watchdog-alive");
        yield* completePromptTurn(adapter, harness.query, log);
        const wakeTurnId = yield* openWakeTurn(harness.query, log, "after-wake-open");
        harness.query.emit(liveness);
        yield* settle(harness.query, log, "after-liveness");
        yield* yieldTimes(10);

        yield* TestClock.adjust("130 seconds");
        yield* log.drain;
        assert.deepEqual(
          lifecycleFor(log, wakeTurnId).map((event) => event.type),
          ["turn.started"],
        );

        harness.query.emit(resultFrame({ origin: { kind: "task-notification" } }));
        yield* settle(harness.query, log, "after-wake-result");
        const terminal = lifecycleFor(log, wakeTurnId).slice(1);
        assert.lengthOf(terminal, 1);
        assert.equal(terminal[0]?.type, "turn.completed");
        assert.equal(
          terminal[0]?.type === "turn.completed" ? terminal[0].payload.state : undefined,
          "completed",
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  it.effect("finishes a provider turn locally when Stop gets no result within the grace", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startWakeSession(adapter, "wake-stop-grace");
      yield* completePromptTurn(adapter, harness.query, log);
      const wakeTurnId = yield* openWakeTurn(harness.query, log, "after-wake-open");

      yield* adapter.interruptTurn(THREAD_ID);
      assert.equal(harness.query.interruptCalls.length, 1);
      yield* log.drain;
      assert.deepEqual(
        lifecycleFor(log, wakeTurnId).map((event) => event.type),
        ["turn.started"],
      );

      yield* yieldTimes(10);
      yield* TestClock.adjust("5 seconds");
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.type, "turn.completed");
      assert.equal(completed.turnId, wakeTurnId);
      assert.equal(
        completed.type === "turn.completed" ? completed.payload.state : undefined,
        "interrupted",
      );
      yield* log.drain;
      assert.isUndefined((yield* adapter.listSessions())[0]?.activeTurnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("lets the CLI's own result end a stopped provider turn exactly once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startWakeSession(adapter, "wake-stop-result");
      yield* completePromptTurn(adapter, harness.query, log);
      const wakeTurnId = yield* openWakeTurn(harness.query, log, "after-wake-open");

      yield* adapter.interruptTurn(THREAD_ID);
      harness.query.emit(
        resultFrame({
          subtype: "error_during_execution",
          errors: ["Interrupted by user"],
          origin: { kind: "task-notification" },
        }),
      );
      yield* settle(harness.query, log, "after-stop-result");
      yield* yieldTimes(10);
      yield* TestClock.adjust("5 seconds");
      yield* log.drain;
      assert.deepEqual(
        lifecycleFor(log, wakeTurnId).map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("schedules no Stop grace for a prompt turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startWakeSession(adapter, "wake-stop-prompt");
      const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "work", attachments: [] });
      harness.query.emit(systemStatusFrame("requesting"));
      yield* settle(harness.query, log, "after-prompt-requesting");

      yield* adapter.interruptTurn(THREAD_ID);
      yield* yieldTimes(10);
      yield* TestClock.adjust("5 seconds");
      yield* log.drain;
      assert.deepEqual(
        lifecycleFor(log, turn.turnId).map((event) => event.type),
        ["turn.started"],
      );
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("never binds Agent Control authority to a provider wake turn", () => {
    const state = makeAgentControlBridge();
    const harness = makeHarness({ agentControl: state.bridge });
    harness.query.mcpStatuses = [{ name: "ryco", status: "connected" }];
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startWakeSession(adapter, "wake-agent-control");
      const promptTurn = yield* completePromptTurn(adapter, harness.query, log);
      const wakeTurnId = yield* openWakeTurn(harness.query, log, "after-wake-open");
      harness.query.emit(rootAssistantFrame("wake-reply", {}, [{ type: "text", text: "Done" }]));
      harness.query.emit(resultFrame({ origin: { kind: "task-notification" } }));
      yield* settle(harness.query, log, "after-wake-result");

      assert.deepEqual(
        lifecycleFor(log, wakeTurnId).map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
      assert.deepEqual(
        state.bindTurnAuthority.mock.calls.map(([input]) => String(input.turnId)),
        [String(promptTurn.turnId)],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
  describe("usage limits", () => {
    const rateLimitFrame = (id: string, info: Record<string, unknown>): SDKMessage =>
      ({
        type: "rate_limit_event",
        rate_limit_info: info,
        uuid: `rate-limit-${id}`,
        session_id: GAUGE_SDK_SESSION,
      }) as unknown as SDKMessage;
    // TestClock starts at the epoch, so any positive reset is in the future.
    const resetsAt = 1_900_000_000;
    const resetIso = new Date(resetsAt * 1000).toISOString();
    const usageLimitErrors = (log: EventLog) =>
      log.events.filter(
        (event) => event.type === "runtime.error" && event.payload.class === "usage_limit",
      );

    it.effect("carries the reset of a rejected window seen earlier in the turn", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const log = yield* makeRuntimeEventLog(adapter);
        yield* startWakeSession(adapter, "usage-limit-reset");
        const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "go", attachments: [] });
        harness.query.emit(
          rateLimitFrame("rejected", {
            status: "rejected",
            rateLimitType: "five_hour",
            resetsAt,
          }),
        );
        harness.query.emit(
          resultFrame({
            subtype: "error_during_execution",
            is_error: true,
            user_message_uuids: [turn.turnId],
          }),
        );
        yield* log.waitFor(
          (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
        );
        const [error] = usageLimitErrors(log);
        assert.equal(error?.turnId, turn.turnId);
        assert.equal(error?.type === "runtime.error" && error.payload.resetAt, resetIso);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("classifies a wake turn opened after the rejection with its reset", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const log = yield* makeRuntimeEventLog(adapter);
        yield* startWakeSession(adapter, "usage-limit-wake");
        yield* completePromptTurn(adapter, harness.query, log);
        harness.query.emit(
          rateLimitFrame("idle-rejected", {
            status: "rejected",
            rateLimitType: "seven_day",
            resetsAt,
          }),
        );
        const from = log.events.length;
        harness.query.emit(
          rootAssistantFrame("wake-reply", {}, [{ type: "text", text: "Limited." }]),
        );
        harness.query.emit(
          resultFrame({
            origin: { kind: "task-notification" },
            is_error: true,
            terminal_reason: "blocking_limit",
            result: "Usage limit reached for the week.",
          }),
        );
        yield* settle(harness.query, log, "after-wake-limit");
        const wakeStart = turnStartsAfter(log, from)[0];
        assert.ok(wakeStart);
        const [error] = usageLimitErrors(log);
        assert.equal(error?.turnId, wakeStart.turnId);
        assert.equal(error?.type === "runtime.error" && error.payload.resetAt, resetIso);
        assert.equal(
          error?.type === "runtime.error" && error.payload.message,
          "Usage limit reached for the week.",
        );
        const completed = lifecycleFor(log, wakeStart.turnId).at(-1);
        assert.equal(completed?.type === "turn.completed" && completed.payload.state, "failed");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("never records a limit for a result without an open turn", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const log = yield* makeRuntimeEventLog(adapter);
        yield* startWakeSession(adapter, "usage-limit-no-turn");
        harness.query.emit(
          resultFrame({ is_error: true, terminal_reason: "blocking_limit", result: "Limited" }),
        );
        yield* settle(harness.query, log, "after-orphan-result");
        assert.lengthOf(usageLimitErrors(log), 0);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("warns once per rejected window and reports the usage-limit state", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const log = yield* makeRuntimeEventLog(adapter);
        yield* startWakeSession(adapter, "usage-limit-warning");
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "go", attachments: [] });
        const rejected = { status: "rejected", rateLimitType: "five_hour", resetsAt };
        harness.query.emit(rateLimitFrame("first", rejected));
        harness.query.emit(rateLimitFrame("second", rejected));
        yield* settle(harness.query, log, "after-rejections");
        const warnings = log.events.filter(
          (event) =>
            event.type === "runtime.warning" &&
            event.payload.message === "Claude usage limit reached.",
        );
        assert.lengthOf(warnings, 1);
        const update = log.events.findLast((event) => event.type === "account.rate-limits.updated");
        assert.deepEqual(
          update?.type === "account.rate-limits.updated" ? update.payload.usageLimitState : null,
          { exhausted: true, resetAt: resetIso },
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("forgets a window once it is allowed again", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const log = yield* makeRuntimeEventLog(adapter);
        yield* startWakeSession(adapter, "usage-limit-allowed");
        const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "go", attachments: [] });
        harness.query.emit(
          rateLimitFrame("rejected", { status: "rejected", rateLimitType: "five_hour", resetsAt }),
        );
        harness.query.emit(
          rateLimitFrame("allowed", { status: "allowed", rateLimitType: "five_hour" }),
        );
        harness.query.emit(
          resultFrame({
            is_error: true,
            terminal_reason: "api_error",
            api_error_status: 500,
            result: "API Error: 500",
            user_message_uuids: [turn.turnId],
          }),
        );
        yield* log.waitFor(
          (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
        );
        assert.lengthOf(usageLimitErrors(log), 0);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  });
});

describe("ClaudeAdapterLive steering", () => {
  type EventLog = Effect.Success<ReturnType<typeof makeRuntimeEventLog>>;

  const startSteerSession = (adapter: ClaudeAdapterShape, runtimeSessionId: string) =>
    adapter.startSession({
      runtimeSessionId: RuntimeSessionId.make(runtimeSessionId),
      threadId: THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });

  /** Emits a sentinel and waits for it: every earlier frame has been handled. */
  const settle = (query: FakeClaudeQuery, log: EventLog, id: string) =>
    Effect.gen(function* () {
      query.emit(sentinelFrame(id));
      yield* log.waitFor(isSentinel(id));
    });

  const streamFrame = (
    id: string,
    event: Record<string, unknown>,
    echo?: ReadonlyArray<string>,
  ): SDKMessage =>
    ({
      type: "stream_event",
      uuid: id,
      session_id: GAUGE_SDK_SESSION,
      parent_tool_use_id: null,
      event,
      ...(echo ? { user_message_uuid: echo[echo.length - 1], user_message_uuids: echo } : {}),
    }) as unknown as SDKMessage;

  const thinkingStart = (id: string, index: number, echo?: ReadonlyArray<string>) =>
    streamFrame(
      id,
      {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      echo,
    );

  const lifecycleFor = (log: EventLog, turnId: unknown) =>
    log.events.filter(
      (event) =>
        (event.type === "turn.started" || isTurnTerminal(event)) && event.turnId === turnId,
    );

  const BOTH_CAPABILITIES = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"] as const;

  const initFrame = (capabilities: ReadonlyArray<string>): SDKMessage =>
    ({ ...systemInitFrame(), capabilities: [...capabilities] }) as unknown as SDKMessage;

  const textStart = (id: string, index: number, echo?: ReadonlyArray<string>) =>
    streamFrame(
      id,
      { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      echo,
    );
  const textDelta = (id: string, index: number, text: string) =>
    streamFrame(id, { type: "content_block_delta", index, delta: { type: "text_delta", text } });
  const blockStop = (id: string, index: number) =>
    streamFrame(id, { type: "content_block_stop", index });

  const abortedResult = (echo: ReadonlyArray<string>, extra: Record<string, unknown> = {}) =>
    resultFrame({
      subtype: "error_during_execution",
      errors: ["Request was aborted."],
      terminal_reason: "aborted_streaming",
      user_message_uuids: [...echo],
      usage: { input_tokens: 12, output_tokens: 3 },
      contextWindow: 200_000,
      ...extra,
    });

  /** Reads the SDK user messages the adapter offered, in order, through one iterator. */
  const makePromptReader = (harness: ReturnType<typeof makeHarness>) => {
    let iterator: AsyncIterator<SDKUserMessage> | undefined;
    return Effect.promise(async () => {
      iterator ??= harness.getLastCreateQueryInput()?.prompt[Symbol.asyncIterator]();
      const next = await iterator!.next();
      assert.isFalse(next.done);
      return next.value as SDKUserMessage;
    });
  };

  const promptText = (message: SDKUserMessage): string | undefined => {
    const content = message.message.content;
    if (typeof content === "string") return content;
    const first = content[0];
    return first && first.type === "text" ? first.text : undefined;
  };

  /** Starts a session and one prompt turn on a CLI with the given init capabilities. */
  const startPromptTurn = (
    adapter: ClaudeAdapterShape,
    harness: ReturnType<typeof makeHarness>,
    log: EventLog,
    id: string,
    capabilities: ReadonlyArray<string> = BOTH_CAPABILITIES,
    runtimeMode: RuntimeMode = "full-access",
  ) =>
    Effect.gen(function* () {
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make(id),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode,
      });
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "prompt",
        attachments: [],
      });
      harness.query.emit(initFrame(capabilities));
      harness.query.emit(systemStatusFrame("requesting"));
      yield* settle(harness.query, log, `${id}-started`);
      return turn;
    });

  const steer = (adapter: ClaudeAdapterShape, turnId: TurnId, input = "also check the tests") =>
    adapter.steerTurn!({
      threadId: THREAD_ID,
      expectedTurnId: turnId,
      messageId: MessageId.make(`message-${input.length}`),
      input,
    });

  /** P has an open text block (0), thinking block (1) and an in-flight tool (2). */
  const emitPromptSegment = (query: FakeClaudeQuery, promptUuid: string) => {
    query.emit(textStart("p-text-start", 0, [promptUuid]));
    query.emit(textDelta("p-text-delta", 0, "Working on it"));
    query.emit(thinkingStart("p-thinking-start", 1));
    query.emit({ ...rootToolStartFrame(2, "tool-p"), session_id: GAUGE_SDK_SESSION } as SDKMessage);
  };

  /** Emits a discarded steer's CLI turn the way the CLI runs it. */
  const emitSteerCliTurn = (
    query: FakeClaudeQuery,
    steerUuid: string,
    result: SDKMessage = resultFrame({ user_message_uuids: [steerUuid] }),
  ) => {
    query.emit(systemInitFrame());
    query.emit(systemStatusFrame("requesting"));
    query.emit(textStart("s-text-start", 0, [steerUuid]));
    query.emit(textDelta("s-text-delta", 0, "Steered reply"));
    query.emit(blockStop("s-text-stop", 0));
    query.emit(rootAssistantFrame("s-assistant", {}, [{ type: "text", text: "Steered reply" }]));
    query.emit(result);
  };

  it.effect("offers a steer as a now-priority message on the running turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const readPrompt = makePromptReader(harness);
      const turn = yield* startPromptTurn(adapter, harness, log, "steer-shape");
      assert.equal(adapter.capabilities.turnSteering, "native");

      const result = yield* steer(adapter, turn.turnId, "also check the tests");
      assert.equal(result.turnId, turn.turnId);

      const prompt = yield* readPrompt;
      assert.equal(String(prompt.uuid), String(turn.turnId));
      assert.isUndefined(prompt.priority);
      const steered = yield* readPrompt;
      assert.equal(steered.priority, "now");
      assert.isString(steered.uuid);
      assert.notEqual(String(steered.uuid), String(turn.turnId));
      assert.equal(promptText(steered), "also check the tests");
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refuses steers the running turn cannot take", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("steer-refusals"),
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "prompt",
        attachments: [],
      });
      const refusal = (turnId: TurnId, input?: string) =>
        steer(adapter, turnId, input).pipe(Effect.flip);

      const noCapability = yield* refusal(turn.turnId);
      assert.equal(noCapability._tag, "ProviderTurnNotSteerableError");
      if (noCapability._tag === "ProviderTurnNotSteerableError") {
        assert.equal(noCapability.reason, "unsupported");
      }

      harness.query.emit(initFrame(BOTH_CAPABILITIES));
      yield* settle(harness.query, log, "refusals-init");

      const wrongTurn = yield* refusal(TurnId.make("another-turn"));
      assert.equal(
        wrongTurn._tag === "ProviderTurnNotSteerableError" && wrongTurn.reason,
        "turn-ended",
      );
      const slash = yield* refusal(turn.turnId, "/review x");
      assert.equal(slash._tag === "ProviderTurnNotSteerableError" && slash.reason, "unsupported");

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.ok(canUseTool);
      const permission = canUseTool!(
        "Bash",
        { command: "pwd" },
        { signal: new AbortController().signal, toolUseID: "tool-approval", requestId: "req-1" },
      );
      const opened = yield* log.waitFor((event) => event.type === "request.opened");
      const busy = yield* refusal(turn.turnId);
      assert.equal(busy._tag === "ProviderTurnNotSteerableError" && busy.reason, "busy");
      yield* adapter.respondToRequest(
        THREAD_ID,
        ApprovalRequestId.make(String(opened.requestId)),
        "cancel",
      );
      yield* Effect.promise(() => permission);

      yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
      const stopped = yield* refusal(turn.turnId);
      assert.equal(
        stopped._tag === "ProviderTurnNotSteerableError" && stopped.reason,
        "turn-ended",
      );

      yield* adapter.stopSession(THREAD_ID);
      const closed = yield* refusal(turn.turnId);
      assert.equal(closed._tag, "ProviderAdapterSessionNotFoundError");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the turn open across a steer's aborted segment and completes it once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const readPrompt = makePromptReader(harness);
      const turn = yield* startPromptTurn(adapter, harness, log, "steer-abort-continue");
      emitPromptSegment(harness.query, turn.turnId);
      yield* settle(harness.query, log, "p-open");

      yield* steer(adapter, turn.turnId);
      yield* readPrompt;
      const steerUuid = (yield* readPrompt).uuid!;

      const sealFrom = log.events.length;
      harness.query.emit(abortedResult([turn.turnId], { queued_turn_count: 1 }));
      yield* settle(harness.query, log, "p-aborted");
      const sealed = log.events.slice(sealFrom);
      assert.isFalse(sealed.some(isTurnTerminal));
      const completedItem = (itemType: string) =>
        sealed.find(
          (event) => event.type === "item.completed" && event.payload.itemType === itemType,
        );
      const textItem = completedItem("assistant_message");
      assert.equal(textItem?.type === "item.completed" && textItem.payload.status, "completed");
      const reasoningItem = completedItem("reasoning");
      assert.equal(
        reasoningItem?.type === "item.completed" && reasoningItem.payload.status,
        "completed",
      );
      const toolItem = sealed.find(
        (event) => event.type === "item.completed" && String(event.itemId) === "tool-p",
      );
      assert.equal(toolItem?.type === "item.completed" && toolItem.payload.status, "failed");
      assert.isTrue(
        sealed.some(
          (event) => event.type === "thread.token-usage.updated" && event.turnId === turn.turnId,
        ),
      );

      const steerFrom = log.events.length;
      harness.query.emit(systemInitFrame());
      harness.query.emit(systemStatusFrame("requesting"));
      harness.query.emit(textStart("s-text-start", 0, [steerUuid]));
      harness.query.emit(textDelta("s-text-delta", 0, "Steered reply"));
      yield* settle(harness.query, log, "s-streaming");
      const steerDelta = log.events
        .slice(steerFrom)
        .find((event) => event.type === "content.delta" && event.payload.delta === "Steered reply");
      assert.ok(steerDelta?.itemId);
      assert.notEqual(String(steerDelta?.itemId), String(textItem?.itemId));
      assert.equal(steerDelta?.turnId, turn.turnId);

      harness.query.emit(resultFrame({ user_message_uuids: [steerUuid], queued_turn_count: 0 }));
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "completed");
      assert.deepEqual(
        lifecycleFor(log, turn.turnId).map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
      assert.lengthOf(
        log.events.filter((event) => event.type === "turn.started"),
        1,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("completes at once when the CLI folds the steer into the running segment", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const readPrompt = makePromptReader(harness);
      const turn = yield* startPromptTurn(adapter, harness, log, "steer-folded");
      yield* steer(adapter, turn.turnId);
      yield* readPrompt;
      const steerUuid = (yield* readPrompt).uuid!;
      harness.query.emit(resultFrame({ user_message_uuids: [turn.turnId, steerUuid] }));
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.turnId, turn.turnId);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "completed");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("accepts a result echoing only the steer and still drops foreign results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const readPrompt = makePromptReader(harness);
      const turn = yield* startPromptTurn(adapter, harness, log, "steer-correlation");
      yield* steer(adapter, turn.turnId);
      yield* readPrompt;
      const steerUuid = (yield* readPrompt).uuid!;
      harness.query.emit(resultFrame({ user_message_uuids: ["another-prompt"] }));
      harness.query.emit(resultFrame({ origin: { kind: "task-notification" } }));
      yield* settle(harness.query, log, "foreign-results");
      assert.isFalse(log.events.some(isTurnTerminal));

      harness.query.emit(resultFrame({ user_message_uuids: [steerUuid] }));
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.turnId, turn.turnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  /** P's segment aborted by S; the turn now waits for S's segment. */
  const awaitSteerSegment = (
    adapter: ClaudeAdapterShape,
    harness: ReturnType<typeof makeHarness>,
    log: EventLog,
    id: string,
    capabilities: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const readPrompt = makePromptReader(harness);
      const turn = yield* startPromptTurn(adapter, harness, log, id, capabilities);
      emitPromptSegment(harness.query, turn.turnId);
      yield* steer(adapter, turn.turnId);
      yield* readPrompt;
      const steerUuid = (yield* readPrompt).uuid!;
      harness.query.emit(abortedResult([turn.turnId], { queued_turn_count: 1 }));
      yield* settle(harness.query, log, `${id}-awaiting`);
      assert.isFalse(log.events.some(isTurnTerminal));
      return { turn, steerUuid };
    });

  it.effect("S2: Stop cancels a queued steer and closes the waiting turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { turn, steerUuid } = yield* awaitSteerSegment(
        adapter,
        harness,
        log,
        "steer-stop-s2",
        BOTH_CAPABILITIES,
      );
      harness.query.interruptReceipt = { still_queued: [], cancelled: [steerUuid] };
      yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
      assert.deepEqual(harness.query.interruptCalls, [[{ cancelQueued: true }]]);
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.turnId, turn.turnId);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "interrupted");
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("S3: Stop closes the waiting turn and drops the still-queued steer's CLI turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { turn, steerUuid } = yield* awaitSteerSegment(adapter, harness, log, "steer-stop-s3", [
        "interrupt_receipt_v1",
      ]);
      harness.query.interruptReceipt = { still_queued: [steerUuid] };
      yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
      assert.deepEqual(harness.query.interruptCalls, [[]]);
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "interrupted");

      const from = log.events.length;
      harness.query.interruptReceipt = undefined;
      emitSteerCliTurn(harness.query, steerUuid);
      yield* settle(harness.query, log, "s3-discarded");
      const after = log.events.slice(from);
      assert.isFalse(after.some((event) => event.type === "turn.started"));
      assert.isFalse(after.some((event) => event.type === "content.delta"));
      assert.isFalse(after.some(isTurnTerminal));
      yield* yieldTimes(10);
      assert.lengthOf(harness.query.interruptCalls, 2);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("S4: Stop during the prompt segment completes once and drops the steer later", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const readPrompt = makePromptReader(harness);
      const turn = yield* startPromptTurn(adapter, harness, log, "steer-stop-s4", [
        "interrupt_receipt_v1",
      ]);
      emitPromptSegment(harness.query, turn.turnId);
      yield* steer(adapter, turn.turnId);
      yield* readPrompt;
      const steerUuid = (yield* readPrompt).uuid!;
      harness.query.interruptReceipt = { still_queued: [steerUuid] };
      yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
      yield* settle(harness.query, log, "s4-after-stop");
      assert.isFalse(log.events.some(isTurnTerminal));

      harness.query.emit(abortedResult([turn.turnId], { queued_turn_count: 1 }));
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "interrupted");

      const from = log.events.length;
      emitSteerCliTurn(harness.query, steerUuid, abortedResult([steerUuid]));
      yield* settle(harness.query, log, "s4-discarded");
      const after = log.events.slice(from);
      assert.isFalse(after.some((event) => event.type === "turn.started"));
      assert.isFalse(after.some((event) => event.type === "content.delta"));
      assert.isFalse(after.some(isTurnTerminal));
      assert.deepEqual(
        lifecycleFor(log, turn.turnId).map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
      yield* yieldTimes(10);
      assert.lengthOf(harness.query.interruptCalls, 2);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "S4: Stop drops a still-queued steer when the prompt's result beats the receipt",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const log = yield* makeRuntimeEventLog(adapter);
        const readPrompt = makePromptReader(harness);
        const turn = yield* startPromptTurn(adapter, harness, log, "steer-stop-s4-race", [
          "interrupt_receipt_v1",
        ]);
        emitPromptSegment(harness.query, turn.turnId);
        yield* steer(adapter, turn.turnId);
        yield* readPrompt;
        const steerUuid = (yield* readPrompt).uuid!;

        // The CLI writes P's aborted result before Stop's receipt is handled.
        harness.query.interruptReceipt = { still_queued: [steerUuid] };
        let releaseReceipt!: () => void;
        harness.query.interruptGate = new Promise((resolve) => {
          releaseReceipt = resolve;
        });
        harness.query.onInterrupt = () =>
          harness.query.emit(abortedResult([turn.turnId], { queued_turn_count: 1 }));
        const stopping = yield* adapter
          .interruptTurn(THREAD_ID, turn.turnId)
          .pipe(Effect.forkChild);
        const completed = yield* log.waitFor(isTurnTerminal);
        assert.equal(completed.type === "turn.completed" && completed.payload.state, "interrupted");
        releaseReceipt();
        yield* Fiber.join(stopping);
        harness.query.onInterrupt = undefined;
        harness.query.interruptGate = undefined;

        const from = log.events.length;
        emitSteerCliTurn(harness.query, steerUuid, abortedResult([steerUuid]));
        yield* settle(harness.query, log, "s4-race-discarded");
        const after = log.events.slice(from);
        assert.isFalse(after.some((event) => event.type === "turn.started"));
        assert.isFalse(after.some((event) => event.type === "content.delta"));
        assert.isFalse(after.some(isTurnTerminal));
        yield* yieldTimes(10);
        assert.lengthOf(harness.query.interruptCalls, 2);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("S4 with cancel_queued: a cancelled steer leaves no discard behind", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const readPrompt = makePromptReader(harness);
      const turn = yield* startPromptTurn(adapter, harness, log, "steer-stop-s4-cancel");
      emitPromptSegment(harness.query, turn.turnId);
      yield* steer(adapter, turn.turnId);
      yield* readPrompt;
      const steerUuid = (yield* readPrompt).uuid!;

      harness.query.interruptReceipt = { still_queued: [], cancelled: [steerUuid] };
      let releaseReceipt!: () => void;
      harness.query.interruptGate = new Promise((resolve) => {
        releaseReceipt = resolve;
      });
      harness.query.onInterrupt = () => harness.query.emit(abortedResult([turn.turnId]));
      const stopping = yield* adapter.interruptTurn(THREAD_ID, turn.turnId).pipe(Effect.forkChild);
      yield* log.waitFor(isTurnTerminal);
      releaseReceipt();
      yield* Fiber.join(stopping);

      // Nothing is pending: the next background turn opens at its own signal.
      const from = log.events.length;
      harness.query.emit(systemStatusFrame("requesting"));
      yield* settle(harness.query, log, "s4-cancel-wake");
      assert.isTrue(log.events.slice(from).some((event) => event.type === "turn.started"));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("S5: a steer in transit at Stop is interrupted again and closes the turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { turn, steerUuid } = yield* awaitSteerSegment(adapter, harness, log, "steer-stop-s5", [
        "interrupt_receipt_v1",
      ]);
      harness.query.interruptReceipt = { still_queued: [] };
      yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
      yield* settle(harness.query, log, "s5-after-stop");
      assert.isFalse(log.events.some(isTurnTerminal));

      harness.query.emit(textStart("s-text-start", 0, [steerUuid]));
      yield* settle(harness.query, log, "s5-steer-started");
      yield* yieldTimes(10);
      assert.lengthOf(harness.query.interruptCalls, 2);

      harness.query.emit(abortedResult([steerUuid]));
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "interrupted");
      assert.deepEqual(
        lifecycleFor(log, turn.turnId).map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("S1: Stop without steers stays a plain interrupt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const turn = yield* startPromptTurn(adapter, harness, log, "steer-stop-s1");
      harness.query.interruptReceipt = { still_queued: [] };
      yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
      assert.deepEqual(harness.query.interruptCalls, [[]]);
      yield* settle(harness.query, log, "s1-after-stop");
      assert.isFalse(log.events.some(isTurnTerminal));
      harness.query.emit(abortedResult([turn.turnId], { queued_turn_count: 0 }));
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "interrupted");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("fails the turn on a failed segment and drops its pending steer", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const readPrompt = makePromptReader(harness);
      const turn = yield* startPromptTurn(adapter, harness, log, "steer-failed-segment");
      yield* steer(adapter, turn.turnId);
      yield* readPrompt;
      const steerUuid = (yield* readPrompt).uuid!;
      harness.query.emit(
        resultFrame({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Overloaded"],
          terminal_reason: "api_error",
          queued_turn_count: 1,
          user_message_uuids: [turn.turnId],
        }),
      );
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "failed");

      const from = log.events.length;
      emitSteerCliTurn(harness.query, steerUuid);
      yield* settle(harness.query, log, "failed-discarded");
      const after = log.events.slice(from);
      assert.isFalse(after.some((event) => event.type === "turn.started"));
      assert.isFalse(after.some((event) => event.type === "content.delta"));
      assert.isFalse(after.some(isTurnTerminal));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const apiRetryFrame = (attempt: number): SDKMessage =>
    ({
      type: "system",
      subtype: "api_retry",
      attempt,
      max_retries: 10,
      retry_delay_ms: 500,
      error_status: 529,
      error: "server_error",
      uuid: `api-retry-${attempt}`,
      session_id: GAUGE_SDK_SESSION,
    }) as unknown as SDKMessage;

  /** P fails with S pending, so S is discarded. Returns S's uuid. */
  const failSegmentWithPendingSteer = (
    adapter: ClaudeAdapterShape,
    harness: ReturnType<typeof makeHarness>,
    log: EventLog,
    id: string,
  ) =>
    Effect.gen(function* () {
      const readPrompt = makePromptReader(harness);
      const turn = yield* startPromptTurn(adapter, harness, log, id);
      yield* steer(adapter, turn.turnId);
      yield* readPrompt;
      const steerUuid = (yield* readPrompt).uuid!;
      harness.query.emit(
        resultFrame({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Overloaded"],
          terminal_reason: "api_error",
          queued_turn_count: 1,
          user_message_uuids: [turn.turnId],
        }),
      );
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "failed");
      return { turn, steerUuid, readPrompt };
    });

  /** With no discard pending, a wake signal opens a background turn at once. */
  const assertWakeOpensAtSignal = (
    harness: ReturnType<typeof makeHarness>,
    log: EventLog,
    id: string,
  ) =>
    Effect.gen(function* () {
      const from = log.events.length;
      harness.query.emit(systemStatusFrame("requesting"));
      yield* settle(harness.query, log, id);
      assert.isTrue(
        log.events.slice(from).some((event) => event.type === "turn.started"),
        "the wake signal opened a turn",
      );
    });

  it.effect("drops a discarded steer's CLI turn that retries before its first stream", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { steerUuid } = yield* failSegmentWithPendingSteer(
        adapter,
        harness,
        log,
        "steer-discard-retry",
      );

      const from = log.events.length;
      harness.query.emit(systemInitFrame());
      harness.query.emit(systemStatusFrame("requesting"));
      harness.query.emit(apiRetryFrame(1));
      harness.query.emit(textStart("s-text-start", 0, [steerUuid]));
      harness.query.emit(textDelta("s-text-delta", 0, "Steered reply"));
      harness.query.emit(blockStop("s-text-stop", 0));
      harness.query.emit(abortedResult([steerUuid]));
      yield* settle(harness.query, log, "retry-discarded");
      const after = log.events.slice(from);
      assert.isFalse(after.some((event) => event.type === "turn.started"));
      assert.isFalse(after.some((event) => event.type === "content.delta"));
      assert.isFalse(after.some(isTurnTerminal));

      yield* assertWakeOpensAtSignal(harness, log, "retry-next-wake");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drops a discarded steer's CLI turn that fails before streaming anything", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { steerUuid } = yield* failSegmentWithPendingSteer(
        adapter,
        harness,
        log,
        "steer-discard-result-only",
      );

      const from = log.events.length;
      harness.query.emit(systemInitFrame());
      harness.query.emit(systemStatusFrame("requesting"));
      harness.query.emit(apiRetryFrame(1));
      harness.query.emit(
        resultFrame({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Overloaded"],
          terminal_reason: "api_error",
          user_message_uuids: [steerUuid],
          usage: { input_tokens: 4, output_tokens: 0 },
          contextWindow: 200_000,
        }),
      );
      yield* settle(harness.query, log, "result-only-discarded");
      const after = log.events.slice(from);
      assert.isFalse(after.some((event) => event.type === "turn.started"));
      assert.isFalse(after.some(isTurnTerminal));
      assert.isFalse(after.some((event) => event.type === "runtime.error"));

      yield* assertWakeOpensAtSignal(harness, log, "result-only-next-wake");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forgets a discarded steer the CLI batched into the next prompt's turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { steerUuid } = yield* failSegmentWithPendingSteer(
        adapter,
        harness,
        log,
        "steer-discard-batched",
      );

      const next = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "next", attachments: [] });
      harness.query.emit(textStart("p2-text-start", 0, [steerUuid, next.turnId]));
      harness.query.emit(textDelta("p2-text-delta", 0, "Batched reply"));
      harness.query.emit(resultFrame({ user_message_uuids: [steerUuid, next.turnId] }));
      const completed = yield* log.waitFor(
        (event) => isTurnTerminal(event) && event.turnId === next.turnId,
      );
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "completed");
      assert.isTrue(
        log.events.some(
          (event) =>
            event.type === "content.delta" &&
            event.turnId === next.turnId &&
            event.payload.delta === "Batched reply",
        ),
      );

      yield* assertWakeOpensAtSignal(harness, log, "batched-next-wake");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("S4 with cancel_queued: a receipt handled before the prompt's result sticks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const readPrompt = makePromptReader(harness);
      const turn = yield* startPromptTurn(adapter, harness, log, "steer-stop-s4-receipt-first");
      emitPromptSegment(harness.query, turn.turnId);
      yield* steer(adapter, turn.turnId);
      yield* readPrompt;
      const steerUuid = (yield* readPrompt).uuid!;

      // The receipt takes the turn lock before the stream fiber handles P's aborted result.
      harness.query.interruptReceipt = { still_queued: [], cancelled: [steerUuid] };
      yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
      assert.deepEqual(harness.query.interruptCalls, [[{ cancelQueued: true }]]);
      yield* settle(harness.query, log, "s4-receipt-first-after-stop");
      assert.isFalse(log.events.some(isTurnTerminal));

      harness.query.emit(abortedResult([turn.turnId]));
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.turnId, turn.turnId);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "interrupted");

      // The cancelled steer never runs, so nothing is left to discard.
      yield* assertWakeOpensAtSignal(harness, log, "s4-receipt-first-wake");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("S3: a steer that started before the stale receipt closes the turn itself", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { turn, steerUuid } = yield* awaitSteerSegment(
        adapter,
        harness,
        log,
        "steer-stop-s3-started",
        ["interrupt_receipt_v1"],
      );

      // The receipt still lists S as queued, but S's CLI turn starts before it is handled.
      harness.query.interruptReceipt = { still_queued: [steerUuid] };
      let releaseReceipt!: () => void;
      harness.query.interruptGate = new Promise((resolve) => {
        releaseReceipt = resolve;
      });
      harness.query.onInterrupt = () => {
        harness.query.onInterrupt = undefined;
        harness.query.emit(textStart("s-text-start", 0, [steerUuid]));
        harness.query.emit(textDelta("s-text-delta", 0, "Steered reply"));
      };
      const stopping = yield* adapter.interruptTurn(THREAD_ID, turn.turnId).pipe(Effect.forkChild);
      yield* log.waitFor(
        (event) => event.type === "content.delta" && event.payload.delta === "Steered reply",
      );
      releaseReceipt();
      yield* Fiber.join(stopping);
      harness.query.interruptGate = undefined;
      yield* settle(harness.query, log, "s3-started-after-stop");
      assert.isFalse(log.events.some(isTurnTerminal), "a running steer keeps the turn open");

      harness.query.emit(blockStop("s-text-stop", 0));
      harness.query.emit(
        rootAssistantFrame("s-assistant", {}, [{ type: "text", text: "Steered reply" }]),
      );
      harness.query.emit(abortedResult([steerUuid]));
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.turnId, turn.turnId);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "interrupted");
      yield* settle(harness.query, log, "s3-started-closed");
      assert.lengthOf(
        log.events.filter((event) => event.type === "turn.started"),
        1,
        "no background turn took the steer's output",
      );
      assert.lengthOf(log.events.filter(isTurnTerminal), 1);
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, undefined);
      yield* yieldTimes(10);
      assert.lengthOf(harness.query.interruptCalls, 2);

      yield* assertWakeOpensAtSignal(harness, log, "s3-started-next-wake");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ends the wake turn a discarded steer's echo-less output already reached", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { steerUuid } = yield* failSegmentWithPendingSteer(
        adapter,
        harness,
        log,
        "steer-discard-leaked-wake",
      );

      // A CLI that echoes only on the result: the first stream event carries no echo.
      const from = log.events.length;
      harness.query.emit(systemInitFrame());
      harness.query.emit(systemStatusFrame("requesting"));
      harness.query.emit(textStart("s-text-start", 0));
      harness.query.emit(textDelta("s-text-delta", 0, "Steered reply"));
      harness.query.emit(blockStop("s-text-stop", 0));
      harness.query.emit(
        rootAssistantFrame("s-assistant", {}, [{ type: "text", text: "Steered reply" }]),
      );
      harness.query.emit(resultFrame({ user_message_uuids: [steerUuid] }));
      yield* settle(harness.query, log, "leaked-wake-result");
      const after = log.events.slice(from);
      const started = after.find((event) => event.type === "turn.started");
      assert.ok(started);
      assert.isTrue(
        after.some((event) => isTurnTerminal(event) && event.turnId === started?.turnId),
        "the result ends the turn the output reached",
      );
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, undefined);

      yield* assertWakeOpensAtSignal(harness, log, "leaked-wake-next-wake");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ends the assistant-output turn a discarded steer's echo-less reply opened", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { steerUuid } = yield* failSegmentWithPendingSteer(
        adapter,
        harness,
        log,
        "steer-discard-leaked-output",
      );

      // An older CLI that echoes only on the result: the reply carries no echo.
      const from = log.events.length;
      harness.query.emit(
        rootAssistantFrame("s-assistant", {}, [{ type: "text", text: "Steered reply" }]),
      );
      harness.query.emit(abortedResult([steerUuid]));
      yield* settle(harness.query, log, "leaked-output-result");
      const after = log.events.slice(from);
      const started = after.find((event) => event.type === "turn.started");
      assert.ok(started);
      const completed = after.find(
        (event) => isTurnTerminal(event) && event.turnId === started?.turnId,
      );
      assert.ok(completed, "the result ends the turn the output opened");
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, undefined);

      yield* assertWakeOpensAtSignal(harness, log, "leaked-output-next-wake");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  /** The first reply of a CLI turn that streamed nothing: the assistant frame carries the echo. */
  const echoedAssistantFrame = (
    id: string,
    echo: ReadonlyArray<string>,
    text: string,
    extra: Record<string, unknown> = {},
  ): SDKMessage =>
    ({
      ...(rootAssistantFrame(id, {}, [{ type: "text", text }]) as object),
      user_message_uuid: echo[echo.length - 1],
      user_message_uuids: [...echo],
      ...extra,
    }) as unknown as SDKMessage;

  const API_ERROR_TEXT = "API Error: 529 Overloaded";

  /** The synthetic reply of a request that failed at the API after its retries. */
  const apiErrorReply = (id: string, echo: ReadonlyArray<string>) =>
    echoedAssistantFrame(id, echo, API_ERROR_TEXT, { error: "server_error" });

  /** How the SDK reports that request: a success flagged as an error, with the error text. */
  const apiErrorResult = (echo: ReadonlyArray<string>, extra: Record<string, unknown> = {}) =>
    resultFrame({
      is_error: true,
      result: API_ERROR_TEXT,
      terminal_reason: "api_error",
      api_error_status: 529,
      user_message_uuids: [...echo],
      usage: { input_tokens: 4, output_tokens: 0 },
      contextWindow: 200_000,
      ...extra,
    });

  it.effect("fails the turn when an API error ends its segment with a steer pending", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const readPrompt = makePromptReader(harness);
      const turn = yield* startPromptTurn(adapter, harness, log, "steer-api-error-segment");
      yield* steer(adapter, turn.turnId);
      yield* readPrompt;
      const steerUuid = (yield* readPrompt).uuid!;

      // The CLI promised the steer's turn, but the steer is dropped after a failure, so the turn
      // must report the failure rather than complete with the steer unanswered.
      harness.query.emit(apiErrorReply("p-error", [turn.turnId]));
      harness.query.emit(apiErrorResult([turn.turnId], { queued_turn_count: 1 }));
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.turnId, turn.turnId);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "failed");
      assert.equal(
        completed.type === "turn.completed" && completed.payload.errorMessage,
        API_ERROR_TEXT,
      );
      const errors = log.events.filter((event) => event.type === "runtime.error");
      assert.deepEqual(
        errors.map((event) => event.type === "runtime.error" && event.payload.message),
        [API_ERROR_TEXT],
      );

      const from = log.events.length;
      emitSteerCliTurn(harness.query, steerUuid);
      yield* settle(harness.query, log, "api-error-segment-discarded");
      const after = log.events.slice(from);
      assert.isFalse(after.some((event) => event.type === "turn.started"));
      assert.isFalse(after.some((event) => event.type === "content.delta"));
      assert.isFalse(after.some(isTurnTerminal));

      yield* assertWakeOpensAtSignal(harness, log, "api-error-segment-next-wake");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drops a discarded steer's CLI turn whose echo rides its API-error reply", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { steerUuid } = yield* failSegmentWithPendingSteer(
        adapter,
        harness,
        log,
        "steer-discard-api-error-reply",
      );

      // The request fails at the API: no stream events, a synthetic error reply, then the result.
      const from = log.events.length;
      harness.query.emit(systemInitFrame());
      harness.query.emit(systemStatusFrame("requesting"));
      harness.query.emit(apiRetryFrame(1));
      harness.query.emit(
        echoedAssistantFrame("s-error", [steerUuid], "API Error: 529 Overloaded", {
          error: "server_error",
        }),
      );
      harness.query.emit(
        resultFrame({
          is_error: true,
          result: "API Error: 529 Overloaded",
          errors: ["Overloaded"],
          user_message_uuids: [steerUuid],
          usage: { input_tokens: 4, output_tokens: 0 },
          contextWindow: 200_000,
        }),
      );
      yield* settle(harness.query, log, "api-error-reply-discarded");
      const after = log.events.slice(from);
      assert.isFalse(after.some((event) => event.type === "turn.started"));
      assert.isFalse(after.some((event) => event.type === "content.delta"));
      assert.isFalse(after.some((event) => event.type === "runtime.error"));
      assert.isFalse(after.some(isTurnTerminal));
      // The error reply ends its CLI turn: an interrupt now could only reach the next one.
      yield* yieldTimes(10);
      assert.lengthOf(harness.query.interruptCalls, 0);

      yield* assertWakeOpensAtSignal(harness, log, "api-error-reply-next-wake");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drops a discarded steer's stream-less reply and interrupts its CLI turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { steerUuid } = yield* failSegmentWithPendingSteer(
        adapter,
        harness,
        log,
        "steer-discard-streamless-reply",
      );

      const from = log.events.length;
      harness.query.emit(echoedAssistantFrame("s-assistant", [steerUuid], "Steered reply"));
      harness.query.emit(
        rootAssistantFrame("s-assistant-2", {}, [{ type: "text", text: "More reply" }]),
      );
      harness.query.emit(abortedResult([steerUuid]));
      yield* settle(harness.query, log, "streamless-reply-discarded");
      const after = log.events.slice(from);
      assert.isFalse(after.some((event) => event.type === "turn.started"));
      assert.isFalse(after.some((event) => event.type === "content.delta"));
      assert.isFalse(after.some(isTurnTerminal));
      yield* yieldTimes(10);
      assert.deepEqual(harness.query.interruptCalls, [[]]);

      yield* assertWakeOpensAtSignal(harness, log, "streamless-reply-next-wake");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("S3: a steer whose stream-less reply beat the stale receipt closes the turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { turn, steerUuid } = yield* awaitSteerSegment(
        adapter,
        harness,
        log,
        "steer-stop-s3-streamless",
        ["interrupt_receipt_v1"],
      );

      harness.query.interruptReceipt = { still_queued: [steerUuid] };
      let releaseReceipt!: () => void;
      harness.query.interruptGate = new Promise((resolve) => {
        releaseReceipt = resolve;
      });
      harness.query.onInterrupt = () => {
        harness.query.onInterrupt = undefined;
        harness.query.emit(echoedAssistantFrame("s-assistant", [steerUuid], "Steered reply"));
      };
      const stopping = yield* adapter.interruptTurn(THREAD_ID, turn.turnId).pipe(Effect.forkChild);
      yield* log.waitFor(
        (event) => event.type === "content.delta" && event.payload.delta === "Steered reply",
      );
      releaseReceipt();
      yield* Fiber.join(stopping);
      harness.query.interruptGate = undefined;
      yield* settle(harness.query, log, "s3-streamless-after-stop");
      assert.isFalse(log.events.some(isTurnTerminal), "a running steer keeps the turn open");

      harness.query.emit(abortedResult([steerUuid]));
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.turnId, turn.turnId);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "interrupted");
      yield* settle(harness.query, log, "s3-streamless-closed");
      assert.lengthOf(log.events.filter(isTurnTerminal), 1);
      yield* yieldTimes(10);
      assert.lengthOf(harness.query.interruptCalls, 2);

      yield* assertWakeOpensAtSignal(harness, log, "s3-streamless-next-wake");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  /** After Stop, S's first reply is an API error; its own result must close the turn as stopped. */
  const assertStoppedSteerApiErrorCloses = (
    harness: ReturnType<typeof makeHarness>,
    log: EventLog,
    turnId: TurnId,
    steerUuid: string,
    id: string,
  ) =>
    Effect.gen(function* () {
      assert.isFalse(log.events.some(isTurnTerminal), "the running steer keeps the turn open");
      harness.query.emit(apiErrorResult([steerUuid]));
      const completed = yield* log.waitFor(isTurnTerminal);
      assert.equal(completed.turnId, turnId);
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "interrupted");
      yield* settle(harness.query, log, `${id}-closed`);
      assert.lengthOf(log.events.filter(isTurnTerminal), 1);
      assert.isFalse(log.events.some((event) => event.type === "runtime.error"));
      // The error reply ended S's CLI turn: an interrupt now could only reach the next one.
      yield* yieldTimes(10);
      assert.deepEqual(harness.query.interruptCalls, [[]], "only Stop interrupted");

      yield* assertWakeOpensAtSignal(harness, log, `${id}-next-wake`);
    });

  it.effect("S3: a steer whose API-error reply beat the stale receipt closes as stopped", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      const { turn, steerUuid } = yield* awaitSteerSegment(
        adapter,
        harness,
        log,
        "steer-stop-s3-api-error",
        ["interrupt_receipt_v1"],
      );

      harness.query.interruptReceipt = { still_queued: [steerUuid] };
      let releaseReceipt!: () => void;
      harness.query.interruptGate = new Promise((resolve) => {
        releaseReceipt = resolve;
      });
      harness.query.onInterrupt = () => {
        harness.query.onInterrupt = undefined;
        harness.query.emit(apiErrorReply("s-error", [steerUuid]));
      };
      const stopping = yield* adapter.interruptTurn(THREAD_ID, turn.turnId).pipe(Effect.forkChild);
      yield* log.waitFor(
        (event) => event.type === "content.delta" && event.payload.delta === API_ERROR_TEXT,
      );
      releaseReceipt();
      yield* Fiber.join(stopping);
      harness.query.interruptGate = undefined;
      yield* settle(harness.query, log, "s3-api-error-after-stop");

      yield* assertStoppedSteerApiErrorCloses(harness, log, turn.turnId, steerUuid, "s3-api-error");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "S5: a steer in transit whose first reply is an API error is not re-interrupted",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const log = yield* makeRuntimeEventLog(adapter);
        const { turn, steerUuid } = yield* awaitSteerSegment(
          adapter,
          harness,
          log,
          "steer-stop-s5-api-error",
          ["interrupt_receipt_v1"],
        );
        harness.query.interruptReceipt = { still_queued: [] };
        yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
        yield* settle(harness.query, log, "s5-api-error-after-stop");
        assert.isFalse(log.events.some(isTurnTerminal));

        harness.query.emit(apiErrorReply("s-error", [steerUuid]));
        yield* settle(harness.query, log, "s5-api-error-reply");
        assert.isTrue(
          log.events.some(
            (event) =>
              event.type === "content.delta" &&
              event.turnId === turn.turnId &&
              event.payload.delta === API_ERROR_TEXT,
          ),
          "the in-transit steer's reply is the stopped turn's",
        );

        yield* assertStoppedSteerApiErrorCloses(
          harness,
          log,
          turn.turnId,
          steerUuid,
          "s5-api-error",
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect.each<{
    readonly name: string;
    readonly result: (echo: ReadonlyArray<string>) => SDKMessage;
  }>([
    // Realistic: the discard's re-interrupt aborts the CLI turn the prompt was folded into.
    { name: "aborted", result: (echo) => abortedResult(echo) },
    // The re-interrupt lost the race: the CLI turn finished, but its reply was dropped.
    { name: "finished", result: (echo) => resultFrame({ user_message_uuids: [...echo] }) },
  ])(
    "fails the next prompt's turn when the CLI folds it into a dropped CLI turn ($name)",
    ({ name, result }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const log = yield* makeRuntimeEventLog(adapter);
        const { steerUuid } = yield* failSegmentWithPendingSteer(
          adapter,
          harness,
          log,
          `steer-discard-folded-prompt-${name}`,
        );

        harness.query.emit(systemInitFrame());
        harness.query.emit(systemStatusFrame("requesting"));
        harness.query.emit(textStart("s-text-start", 0, [steerUuid]));
        yield* settle(harness.query, log, `folded-prompt-${name}-discarding`);

        // Before the re-interrupt lands, the CLI folds the next prompt into the dropped CLI turn.
        const next = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "next",
          attachments: [],
        });
        harness.query.emit(textDelta("s-text-delta", 0, "Folded reply"));
        const errorsBefore = log.events.filter((event) => event.type === "runtime.error").length;
        harness.query.emit(result([steerUuid, next.turnId]));
        yield* settle(harness.query, log, `folded-prompt-${name}-result`);
        const completed = log.events.find(
          (event) => isTurnTerminal(event) && event.turnId === next.turnId,
        );
        assert.ok(completed, "the folded prompt's only result ends its turn");
        // Never a Stop: Ryco's own re-interrupt must not hold the client queue as "Paused".
        assert.equal(completed?.type === "turn.completed" && completed.payload.state, "failed");
        const reason =
          (completed?.type === "turn.completed" ? completed.payload.errorMessage : undefined) ?? "";
        assert.match(reason, /no reply is shown/);
        assert.deepEqual(
          log.events
            .filter((event) => event.type === "runtime.error")
            .slice(errorsBefore)
            .map((event) => event.type === "runtime.error" && event.payload.message),
          [reason],
        );
        assert.isFalse(
          log.events.some(
            (event) => event.type === "content.delta" && event.payload.delta === "Folded reply",
          ),
        );
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, undefined);
        yield* yieldTimes(10);
        assert.deepEqual(harness.query.interruptCalls, [[]], "the discard's re-interrupt");

        yield* assertWakeOpensAtSignal(harness, log, `folded-prompt-${name}-next-wake`);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "completes as completed when a steer aborts the segment with no result promised",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const log = yield* makeRuntimeEventLog(adapter);
        const readPrompt = makePromptReader(harness);
        const turn = yield* startPromptTurn(adapter, harness, log, "steer-abort-no-count");
        emitPromptSegment(harness.query, turn.turnId);
        yield* steer(adapter, turn.turnId);
        yield* readPrompt;
        const steerUuid = (yield* readPrompt).uuid!;

        // The steer aborted P, but the CLI reports no queued turn (or omits the count).
        const sealFrom = log.events.length;
        harness.query.emit(abortedResult([turn.turnId]));
        const completed = yield* log.waitFor(isTurnTerminal);
        assert.equal(completed.turnId, turn.turnId);
        assert.equal(completed.type === "turn.completed" && completed.payload.state, "completed");
        assert.isUndefined(completed.type === "turn.completed" && completed.payload.errorMessage);
        const sealed = log.events.slice(sealFrom);
        const toolItem = sealed.find(
          (event) => event.type === "item.completed" && String(event.itemId) === "tool-p",
        );
        assert.equal(toolItem?.type === "item.completed" && toolItem.payload.status, "failed");
        assert.isFalse(log.events.some((event) => event.type === "runtime.error"));

        // The steer is not dropped: it runs next and its reply lands in a background turn.
        const from = log.events.length;
        emitSteerCliTurn(harness.query, steerUuid);
        yield* settle(harness.query, log, "steer-abort-no-count-reply");
        const after = log.events.slice(from);
        const started = after.find((event) => event.type === "turn.started");
        assert.ok(started);
        assert.notEqual(started?.turnId, turn.turnId);
        assert.isTrue(
          after.some(
            (event) =>
              event.type === "content.delta" &&
              event.turnId === started?.turnId &&
              event.payload.delta === "Steered reply",
          ),
        );
        assert.isTrue(
          after.some((event) => isTurnTerminal(event) && event.turnId === started?.turnId),
        );
        assert.lengthOf(harness.query.interruptCalls, 0);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "never records a usage limit for a steer-aborted segment that omits terminal_reason",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const log = yield* makeRuntimeEventLog(adapter);
        const readPrompt = makePromptReader(harness);
        const turn = yield* startPromptTurn(adapter, harness, log, "steer-abort-limit-window");
        emitPromptSegment(harness.query, turn.turnId);
        // A rejected window is open, so any classified error result would read as a limit.
        harness.query.emit({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1.9e9 },
          uuid: "rate-limit-steer-abort",
          session_id: GAUGE_SDK_SESSION,
        } as unknown as SDKMessage);
        yield* steer(adapter, turn.turnId);
        yield* readPrompt;
        yield* readPrompt;

        // The steer aborted P; an older CLI reports the abort only in its error text.
        harness.query.emit(
          resultFrame({
            subtype: "error_during_execution",
            errors: ["Request was aborted."],
            user_message_uuids: [turn.turnId],
          }),
        );
        const completed = yield* log.waitFor(isTurnTerminal);
        assert.equal(completed.turnId, turn.turnId);
        assert.equal(completed.type === "turn.completed" && completed.payload.state, "completed");
        assert.isFalse(
          log.events.some(
            (event) => event.type === "runtime.error" && event.payload.class === "usage_limit",
          ),
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("closes an open reasoning block before an aborted turn completes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startSteerSession(adapter, "steer-reasoning-abort");
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "think",
        attachments: [],
      });
      harness.query.emit(thinkingStart("thinking-start", 0, [turn.turnId]));
      harness.query.emit(
        resultFrame({
          subtype: "error_during_execution",
          errors: ["Request was aborted."],
          terminal_reason: "aborted_streaming",
          user_message_uuids: [turn.turnId],
        }),
      );
      yield* log.waitFor((event) => event.type === "turn.completed");

      const reasoningStarted = log.events.find(
        (event) => event.type === "item.started" && event.payload.itemType === "reasoning",
      );
      const reasoningCompleted = log.events.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "reasoning" &&
          event.itemId === reasoningStarted?.itemId,
      );
      const completed = log.events.findIndex((event) => event.type === "turn.completed");
      assert.isAbove(reasoningCompleted, -1, "reasoning item completed");
      assert.isBelow(reasoningCompleted, completed);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps an aborted_tools result to interrupted without a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const log = yield* makeRuntimeEventLog(adapter);
      yield* startSteerSession(adapter, "steer-aborted-tools");
      const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "run", attachments: [] });
      harness.query.emit(
        resultFrame({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Tool execution stopped"],
          terminal_reason: "aborted_tools",
          user_message_uuids: [turn.turnId],
        }),
      );
      const completed = yield* log.waitFor((event) => event.type === "turn.completed");
      assert.equal(
        completed.type === "turn.completed" ? completed.payload.state : null,
        "interrupted",
      );
      assert.isFalse(log.events.some((event) => event.type === "runtime.error"));
      assert.deepEqual(
        lifecycleFor(log, turn.turnId).map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
