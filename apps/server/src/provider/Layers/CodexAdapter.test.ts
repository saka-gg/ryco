import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalRequestId,
  CodexSettings,
  EventId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  RuntimeSessionId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnSteerResult,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";

import { Context, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { ServerConfig } from "../../config.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { buildAgentTokenModeInstructions } from "../../tokenReduction.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeSteerTurnInput,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";
import { makeCodexAdapter } from "./CodexAdapter.ts";

// Test-local service tag so the rest of the file can keep using `yield* CodexAdapter`.
class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "test/CodexAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private readonly now = new Date().toISOString();

  public readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
  );

  public readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
      }),
  );

  public readonly steerTurnImpl = vi.fn(
    (input: CodexSessionRuntimeSteerTurnInput): Promise<ProviderTurnSteerResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: input.expectedTurnId,
      }),
  );

  public readonly interruptTurnImpl = vi.fn((_turnId?: TurnId): Promise<void> =>
    Promise.resolve(undefined),
  );
  public interruptTurnEffect: Effect.Effect<void> | null = null;

  public readonly readThreadImpl = vi.fn((): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: "provider-thread-1",
      turns: [],
    }),
  );

  public readonly rollbackThreadImpl = vi.fn((_numTurns: number): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: "provider-thread-1",
      turns: [],
    }),
  );

  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly respondToUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));

  readonly options: CodexSessionRuntimeOptions;

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }

  start() {
    return Effect.promise(() => this.startImpl());
  }

  getSession = Effect.promise(() => this.startImpl());

  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
    return Effect.promise(() => this.sendTurnImpl(input));
  }

  steerTurn(input: CodexSessionRuntimeSteerTurnInput) {
    return Effect.promise(() => this.steerTurnImpl(input));
  }

  interruptTurn(turnId?: TurnId) {
    return this.interruptTurnEffect ?? Effect.promise(() => this.interruptTurnImpl(turnId));
  }

  readThread = Effect.promise(() => this.readThreadImpl());

  rollbackThread(numTurns: number) {
    return Effect.promise(() => this.rollbackThreadImpl(numTurns));
  }

  setGoal(input: Omit<EffectCodexSchema.V2ThreadGoalSetParams, "threadId">) {
    const timestamp = Math.floor(Date.now() / 1_000);
    return Effect.succeed({
      goal: {
        threadId: "provider-thread-1",
        objective: input.objective ?? "Test goal",
        status: input.status ?? "active",
        tokenBudget: input.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  }

  getGoal: CodexSessionRuntimeShape["getGoal"] = Effect.succeed({ goal: null });

  clearGoal = Effect.succeed({ cleared: true });

  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision));
  }

  respondToUserInput(requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) {
    return Effect.promise(() => this.respondToUserInputImpl(requestId, answers));
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.promise(() => this.closeImpl());

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}

function makeRuntimeFactory() {
  const runtimes: Array<FakeCodexRuntime> = [];
  const factory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    runtimes.push(runtime);
    return Effect.succeed(runtime);
  });

  return {
    factory,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

function makeScopedRuntimeFactory(options?: { readonly failConstruction?: boolean }) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const releasedThreadIds: Array<ThreadId> = [];

  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
    Effect.gen(function* () {
      yield* Scope.Scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releasedThreadIds.push(runtimeOptions.threadId);
        }),
      );

      if (options?.failConstruction) {
        return yield* new CodexErrors.CodexAppServerSpawnError({
          command: `${runtimeOptions.binaryPath} app-server`,
          cause: new Error("runtime construction failed"),
        });
      }

      const runtime = new FakeCodexRuntime(runtimeOptions);
      runtimes.push(runtime);
      return runtime;
    }),
  );

  return {
    factory,
    releasedThreadIds,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

function makeCodexAdapterTestLayer(input: {
  readonly runtimeFactory: ReturnType<typeof makeRuntimeFactory>;
  readonly prefix: string;
}) {
  return Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = Schema.decodeSync(CodexSettings)({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: input.runtimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: input.prefix })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const validationRuntimeFactory = makeRuntimeFactory();
const validationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = Schema.decodeSync(CodexSettings)({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          runtimeSessionId: RuntimeSessionId.make("test-codexadapter-1"),
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("codex"),
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      assert.equal(validationRuntimeFactory.factory.mock.calls.length, 0);
    }),
  );
  it.effect("returns validation error for a mismatched provider instance", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          runtimeSessionId: RuntimeSessionId.make("test-codexadapter-instance-mismatch"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex-other"),
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderAdapterValidationError");
      assert.match(result.failure.issue, /Expected provider instance 'codex'/);
      assert.equal(validationRuntimeFactory.factory.mock.calls.length, 0);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-codexadapter-2"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "fastMode", value: true },
        ]),
        runtimeMode: "full-access",
      });

      const runtimeOptions = validationRuntimeFactory.factory.mock.calls[0]?.[0];
      const { tokenReductionInstructions, ...stableRuntimeOptions } = runtimeOptions ?? {};
      assert.deepStrictEqual(stableRuntimeOptions, {
        binaryPath: "codex",
        cwd: process.cwd(),
        model: "gpt-5.3-codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeSessionId: RuntimeSessionId.make("test-codexadapter-2"),
        serviceTier: "fast",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
        tokenMode: "balanced",
      });
      assert.ok(
        tokenReductionInstructions?.includes(buildAgentTokenModeInstructions("balanced") ?? ""),
      );
    }),
  );
});

const sessionRuntimeFactory = makeRuntimeFactory();
const sessionErrorLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = Schema.decodeSync(CodexSettings)({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: sessionRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps missing adapter sessions to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      assert.equal(result.failure.provider, "codex");
      assert.equal(result.failure.threadId, "sess-missing");
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-codexadapter-3"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-missing"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "max" },
            { id: "fastMode", value: true },
          ]),
          attachments: [],
        }),
      );

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "max",
        serviceTier: "fast",
      });
    }),
  );

  it.effect("steers the exact active Codex turn with the stable message id", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-steer");
      const expectedTurnId = asTurnId("turn-active");
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-codexadapter-steer"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.steerTurnImpl.mockClear();

      const result = yield* adapter.steerTurn!({
        threadId,
        expectedTurnId,
        messageId: MessageId.make("message-steer"),
        input: "Check this before continuing",
        attachments: [],
      });

      assert.deepStrictEqual(runtime.steerTurnImpl.mock.calls[0]?.[0], {
        expectedTurnId,
        messageId: MessageId.make("message-steer"),
        input: "Check this before continuing",
      });
      assert.equal(result.turnId, expectedTurnId);
    }),
  );

  it.effect("maps codex model options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("codex_personal");
    const customRuntimeFactory = makeRuntimeFactory();
    const customLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = Schema.decodeSync(CodexSettings)({});
        return yield* makeCodexAdapter(codexConfig, {
          instanceId: customInstanceId,
          makeRuntime: customRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-codexadapter-4"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-custom-instance"),
        runtimeMode: "full-access",
      });
      const runtime = customRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-custom-instance"),
          input: "hello",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex_personal"),
            "gpt-5.3-codex",
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ),
          attachments: [],
        }),
      );

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "fast",
      });
    }).pipe(Effect.provide(customLayer));
  });

  it.effect("stats and embeds small image attachments before sending a turn", () => {
    const attachmentRuntimeFactory = makeRuntimeFactory();
    const attachmentLayer = makeCodexAdapterTestLayer({
      runtimeFactory: attachmentRuntimeFactory,
      prefix: "ryco-codex-attachment-small-",
    });

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const attachment = {
        type: "image" as const,
        id: "thread-codex-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment)!);
      fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
      fs.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-codexadapter-5"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-attachment-small"),
        runtimeMode: "full-access",
      });
      const runtime = attachmentRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* adapter.sendTurn({
        threadId: asThreadId("sess-attachment-small"),
        input: "What's in this image?",
        attachments: [attachment],
      });

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "What's in this image?",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,AQIDBA==",
          },
        ],
      });
    }).pipe(Effect.provide(attachmentLayer));
  });

  it.effect("appends on-disk path lines for file attachments instead of native ingestion", () => {
    const attachmentRuntimeFactory = makeRuntimeFactory();
    const attachmentLayer = makeCodexAdapterTestLayer({
      runtimeFactory: attachmentRuntimeFactory,
      prefix: "ryco-codex-attachment-file-",
    });

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const fileAttachment = {
        type: "file" as const,
        id: "thread-codex-file-12345678-1234-1234-1234-123456789abc",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 123456,
      };
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-codexadapter-file"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-attachment-file"),
        runtimeMode: "full-access",
      });
      const runtime = attachmentRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* adapter.sendTurn({
        threadId: asThreadId("sess-attachment-file"),
        input: "Review the report",
        attachments: [fileAttachment],
      });

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: `Review the report\n\n[Attached file] report.pdf (application/pdf, 123456 bytes) saved at: ${path.join(
          attachmentsDir,
          attachmentRelativePath(fileAttachment)!,
        )}`,
      });
    }).pipe(Effect.provide(attachmentLayer));
  });

  it.effect("appends path-less lines for unknown attachments", () => {
    const attachmentRuntimeFactory = makeRuntimeFactory();
    const attachmentLayer = makeCodexAdapterTestLayer({
      runtimeFactory: attachmentRuntimeFactory,
      prefix: "ryco-codex-attachment-unknown-",
    });

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const unknownAttachment = {
        type: "vendor-secret",
        name: "mystery.bin",
        mimeType: "application/octet-stream",
      };
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-codexadapter-unknown"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-attachment-unknown"),
        runtimeMode: "full-access",
      });
      const runtime = attachmentRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* adapter.sendTurn({
        threadId: asThreadId("sess-attachment-unknown"),
        input: "What is this?",
        attachments: [unknownAttachment],
      });

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: `What is this?\n\n[Attached file] mystery.bin (application/octet-stream, size unknown bytes)`,
      });
    }).pipe(Effect.provide(attachmentLayer));
  });

  it.effect("rejects turns that exceed the provider attachment count before reading files", () => {
    const attachmentRuntimeFactory = makeRuntimeFactory();
    const attachmentLayer = makeCodexAdapterTestLayer({
      runtimeFactory: attachmentRuntimeFactory,
      prefix: "ryco-codex-attachment-count-",
    });

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-codexadapter-6"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-attachment-count"),
        runtimeMode: "full-access",
      });
      const runtime = attachmentRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      const attachments = Array.from(
        { length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 },
        (_, index) => ({
          type: "image" as const,
          id: `thread-codex-count-${index}`,
          name: `image-${index}.png`,
          mimeType: "image/png",
          sizeBytes: 1,
        }),
      );
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-attachment-count"),
          input: "too many",
          attachments,
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderAdapterRequestError");
      assert.match(result.failure.detail, /Turn has 9 attachments; limit is 8\./);
      assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
    }).pipe(Effect.provide(attachmentLayer));
  });

  it.effect(
    "rejects persisted attachments that exceed the provider byte limit before base64",
    () => {
      const attachmentRuntimeFactory = makeRuntimeFactory();
      const attachmentLayer = makeCodexAdapterTestLayer({
        runtimeFactory: attachmentRuntimeFactory,
        prefix: "ryco-codex-attachment-large-",
      });

      return Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const { attachmentsDir } = yield* ServerConfig;
        const attachment = {
          type: "image" as const,
          id: "thread-codex-large-12345678-1234-1234-1234-123456789abc",
          name: "large.png",
          mimeType: "image/png",
          sizeBytes: 1,
        };
        const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment)!);
        fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
        fs.writeFileSync(attachmentPath, Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1));

        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("test-codexadapter-7"),
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("sess-attachment-large"),
          runtimeMode: "full-access",
        });
        const runtime = attachmentRuntimeFactory.lastRuntime;
        assert.ok(runtime);
        runtime.sendTurnImpl.mockClear();

        const result = yield* adapter
          .sendTurn({
            threadId: asThreadId("sess-attachment-large"),
            input: "too large",
            attachments: [attachment],
          })
          .pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        assert.equal(result.failure._tag, "ProviderAdapterRequestError");
        assert.match(
          result.failure.detail,
          new RegExp(
            `Attachment 'large\\.png' is ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1} bytes; limit is ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES} bytes\\.`,
          ),
        );
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
      }).pipe(Effect.provide(attachmentLayer));
    },
  );
});

const lifecycleRuntimeFactory = makeRuntimeFactory();
const lifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = Schema.decodeSync(CodexSettings)({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

it.effect("CodexAdapter keeps a late A1 exit stamped A1 after starting A2", () => {
  const runtimeFactory = makeRuntimeFactory();
  const layer = makeCodexAdapterTestLayer({
    runtimeFactory,
    prefix: "ryco-codex-runtime-epoch-",
  });
  const threadId = asThreadId("thread-codex-runtime-epoch");
  const runtimeA1 = RuntimeSessionId.make("runtime-codex-a1");
  const runtimeA2 = RuntimeSessionId.make("runtime-codex-a2");

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      runtimeSessionId: runtimeA1,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      runtimeMode: "full-access",
    });
    const firstRuntime = runtimeFactory.lastRuntime;
    assert.ok(firstRuntime);

    const lateEventFiber = yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.eventId === asEventId("evt-codex-late-a1-exit")),
      Stream.runHead,
      Effect.forkChild,
    );
    firstRuntime.closeImpl.mockImplementation(async () => {
      await Effect.runPromise(
        firstRuntime.emit({
          id: asEventId("evt-codex-late-a1-exit"),
          kind: "session",
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: new Date().toISOString(),
          method: "session/closed",
          message: "Late A1 exit",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    yield* adapter.stopSession(threadId);
    yield* adapter.startSession({
      runtimeSessionId: runtimeA2,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      runtimeMode: "full-access",
    });

    const lateEvent = yield* Fiber.join(lateEventFiber).pipe(Effect.timeout("1 second"));
    assert.equal(lateEvent._tag, "Some");
    if (lateEvent._tag === "Some") {
      assert.equal(lateEvent.value.runtimeSessionId, runtimeA1);
      assert.notEqual(lateEvent.value.runtimeSessionId, runtimeA2);
    }
  }).pipe(Effect.provide(layer));
});

let lifecycleRuntimeSequence = 0;

function startLifecycleRuntime() {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    if (yield* adapter.hasSession(asThreadId("thread-1"))) {
      yield* adapter.stopSession(asThreadId("thread-1"));
    }
    const session = yield* adapter.startSession({
      runtimeSessionId: RuntimeSessionId.make(
        `test-codexadapter-lifecycle-${++lifecycleRuntimeSequence}`,
      ),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
    });
    const runtime = lifecycleRuntimeFactory.lastRuntime;
    assert.ok(runtime);
    return { adapter, runtime, session };
  });
}

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  // Production calls startSession from a request fiber that finishes as soon as
  // the session exists. Starting it in a fiber that finishes reproduces that
  // lifecycle instead of keeping the event consumer alive under the test fiber.
  it.effect("keeps consuming runtime events after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-outlives-start");
      const startSessionFiber = yield* adapter
        .startSession({
          runtimeSessionId: RuntimeSessionId.make("test-codexadapter-outlives-start"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber);

      const runtime = lifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-after-start-session"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId,
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_after_start"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-outlives-start",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_after_start",
            text: "emitted after startSession returned",
          },
        },
      });

      const firstEvent = yield* Fiber.join(firstEventFiber).pipe(Effect.timeout("10 seconds"));
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag === "Some") {
        assert.equal(firstEvent.value.type, "item.completed");
      }
    }).pipe(TestClock.withLive),
  );

  it.effect("recycles a provider session when its interrupt RPC never settles", () =>
    Effect.gen(function* () {
      const { adapter, runtime, session } = yield* startLifecycleRuntime();
      runtime.interruptTurnEffect = Effect.never;

      const interruptFiber = yield* adapter.interruptTurn(session.threadId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("15 seconds");
      yield* Fiber.join(interruptFiber);

      assert.equal(runtime.closeImpl.mock.calls.length, 1);
      assert.equal(yield* adapter.hasSession(session.threadId), false);
    }),
  );

  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const { adapter, runtime, session } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "done",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      assert.equal(firstEvent.value.providerInstanceId, ProviderInstanceId.make("codex"));
      assert.equal(firstEvent.value.runtimeSessionId, session.runtimeSessionId);
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: new Date().toISOString(),
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "plan_1",
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "session/closed",
        message: "Session stopped",
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.class, "provider_error");
      assert.equal(
        firstEvent.value.payload.message,
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestKind: "command",
        requestId: ApprovalRequestId.make("req-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestKind: "file-read",
        requestId: ApprovalRequestId.make("req-file-read-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-file-read-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: {
              answers: [],
            },
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          mode: "unelevated",
          success: false,
          error: "unsupported environment",
        },
      };

      yield* runtime.emit(event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      assert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        assert.equal(firstEvent.payload.state, "error");
        assert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      assert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        assert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            itemId: "item-user-input-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          assert.equal(events[0].requestId, "req-user-input-1");
          assert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
          assert.equal(events[0].payload.questions[0]?.multiSelect, false);
        }

        assert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          assert.equal(events[1].requestId, "req-user-input-1");
          assert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      assert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
    }),
  );

  it.effect("uses native mutation responses and omits the objective on status-only edits", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const native = {
        threadId: "provider-thread-1",
        objective: "Ship the migration",
        status: "complete" as const,
        tokenBudget: 1000,
        tokensUsed: 750,
        timeUsedSeconds: 60,
        createdAt: 1_787_011_200,
        updatedAt: 1_787_011_275,
      };
      runtime.getGoal = Effect.succeed({ goal: native });
      const setGoal = vi
        .spyOn(runtime, "setGoal")
        .mockImplementation(() => Effect.succeed({ goal: native }));
      const canonical = yield* adapter.getThreadGoal!(asThreadId("thread-1"));
      assert.equal(canonical?.tokensUsed, 750);
      assert.ok(canonical);
      const result = yield* adapter.setThreadGoal!(asThreadId("thread-1"), {
        ...canonical,
        status: "paused",
        synchronization: {
          requestId: "pause",
          state: "pending",
          action: "set",
          fields: ["status"],
        },
      });
      assert.equal(result.tokensUsed, 750);
      assert.equal(result.status, "complete");
      assert.deepEqual(setGoal.mock.calls[0]?.[0], { status: "paused" });
      yield* adapter.setThreadGoal!(asThreadId("thread-1"), {
        ...canonical,
        status: "active",
        createdAt: "2026-08-19T00:00:00.000Z",
        synchronization: {
          requestId: "replace",
          state: "pending",
          action: "set",
          fields: ["objective", "status"],
        },
      });
      assert.equal(setGoal.mock.calls[1]?.[0].objective, native.objective);
      yield* adapter.setThreadGoal!(asThreadId("thread-1"), {
        ...canonical,
        tokenBudget: 2000,
        synchronization: {
          requestId: "budget",
          state: "pending",
          action: "set",
          fields: ["tokenBudget"],
        },
      });
      assert.deepEqual(setGoal.mock.calls[2]?.[0], { tokenBudget: 2000 });
    }),
  );

  it.effect("maps Codex goal updates to the canonical thread goal", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-thread-goal-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/goal/updated",
        payload: {
          threadId: "provider-thread-1",
          goal: {
            threadId: "provider-thread-1",
            objective: "Finish the integration",
            status: "active",
            tokenBudget: 40_000,
            tokensUsed: 1_200,
            timeUsedSeconds: 75,
            createdAt: 1_787_011_200,
            updatedAt: 1_787_011_275,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "thread.goal.updated") return;
      assert.deepEqual(firstEvent.value.payload.goal, {
        objective: "Finish the integration",
        status: "active",
        tokenBudget: 40_000,
        tokensUsed: 1_200,
        timeUsedSeconds: 75,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:01:15.000Z",
      });
    }),
  );
});

const scopedLifecycleRuntimeFactory = makeScopedRuntimeFactory();
const scopedLifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = Schema.decodeSync(CodexSettings)({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedLifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedLifecycleLayer("CodexAdapterLive scoped lifecycle", (it) => {
  it.effect("closes the externally owned session scope on stopSession", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-codexadapter-9"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-stop"),
        runtimeMode: "full-access",
      });

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      yield* adapter.stopSession(asThreadId("thread-stop"));

      assert.equal(runtime.closeImpl.mock.calls.length, 1);
      assert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-stop"),
      ]);
      assert.equal(yield* adapter.hasSession(asThreadId("thread-stop")), false);
    }),
  );
});

const scopedFailureRuntimeFactory = makeScopedRuntimeFactory({ failConstruction: true });
const scopedFailureLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = Schema.decodeSync(CodexSettings)({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedFailureRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedFailureLayer("CodexAdapterLive scoped startup failure", (it) => {
  it.effect("closes the externally owned session scope when startSession fails", () =>
    Effect.gen(function* () {
      scopedFailureRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      const result = yield* adapter
        .startSession({
          runtimeSessionId: RuntimeSessionId.make("test-codexadapter-10"),
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-fail"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderAdapterProcessError");
      assert.deepStrictEqual(scopedFailureRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-fail"),
      ]);
      assert.equal(yield* adapter.hasSession(asThreadId("thread-fail")), false);
    }),
  );
});

it.effect("flushes managed native logs when the adapter layer shuts down", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-codex-adapter-native-log-"));
    const basePath = path.join(tempDir, "provider-native.ndjson");
    const runtimeFactory = makeRuntimeFactory();
    const scope = yield* Scope.make("sequential");
    let scopeClosed = false;

    try {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = Schema.decodeSync(CodexSettings)({});
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: runtimeFactory.factory,
            nativeEventLogPath: basePath,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context));

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-codexadapter-11"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      assert.ok(runtime);

      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-native-log"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        message: "native flush test",
      } satisfies ProviderEvent);
      yield* Fiber.join(firstEventFiber);

      yield* Scope.close(scope, Exit.void);
      scopeClosed = true;

      const threadLogPath = path.join(tempDir, "thread-logger.native.log");
      assert.equal(fs.existsSync(threadLogPath), true);
      const contents = fs.readFileSync(threadLogPath, "utf8");
      assert.match(contents, /NTIVE: .*"message":"native flush test"/);
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);
