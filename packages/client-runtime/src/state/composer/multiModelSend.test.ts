import {
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentApi,
  type ModelSelection,
  type ServerProvider,
  type ThreadId,
} from "@ryco/contracts";
import { createModelCapabilities, createModelSelection } from "@ryco/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { RpcRequestRefusedError } from "../../rpc/protocol.ts";
import { modelMultiSelectKey } from "./modelMultiSelect.ts";
import {
  MULTI_MODEL_SEND_UNCERTAIN_MESSAGE,
  classifyMultiModelSendFailure,
  createMultiModelSendTracker,
  deriveMultiModelSendThreadId,
  planMultiModelSend,
  resolveMultiModelSendTarget,
  summarizeMultiModelSend,
  type MultiModelSendInput,
  type MultiModelSendTargetInput,
} from "./multiModelSend.ts";
import { deriveProviderInstanceEntries } from "./providerInstances.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const gpt = createModelSelection(codex, "gpt-5", [{ id: "reasoningEffort", value: "high" }]);
const opus = createModelSelection(claude, "claude-opus-4-6");
const sonnet = createModelSelection(claude, "claude-sonnet-4-6");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function target(selection: ModelSelection): MultiModelSendTargetInput {
  return {
    modelSelection: selection,
    outgoingMessageText: `Fix the flaky test (${selection.model})`,
    interactionMode: "default",
  };
}

function sendInput(overrides: Partial<MultiModelSendInput> = {}): MultiModelSendInput {
  return {
    draftId: "draft-1",
    submissionId: "submission-1",
    projectId: ProjectId.make("project-1"),
    projectCwd: "/repo",
    baseBranch: "main",
    worktreeBranchPrefix: "ryco",
    title: "Fix the flaky test",
    runtimeMode: "full-access",
    tokenMode: "balanced",
    turnAttachments: [],
    sourceControlContexts: [],
    createdAt: "2026-10-22T10:00:00.000Z",
    targets: [target(gpt), target(opus), target(sonnet)],
    ...overrides,
  };
}

type TurnStart = Extract<
  Parameters<EnvironmentApi["orchestration"]["dispatchCommand"]>[0],
  { type: "thread.turn.start" }
>;
type NodeAnswer = "accept" | "accept-then-drop" | Error;

/**
 * A node that keeps receipts by command id and refuses a second thread under one id,
 * as the real one does, so a test can count what a retry really created.
 */
function makeNode(answer: (command: TurnStart, call: number) => NodeAnswer = () => "accept") {
  const commands: TurnStart[] = [];
  const receipts = new Set<string>();
  const threads = new Set<string>();
  let calls = 0;
  const api = {
    orchestration: {
      dispatchCommand: async (command: TurnStart) => {
        commands.push(command);
        calls += 1;
        if (receipts.has(command.commandId)) return { sequence: calls };
        const outcome = answer(command, calls);
        if (outcome instanceof Error) throw outcome;
        if (threads.has(command.threadId)) {
          throw new OrchestrationDispatchCommandError({
            message: `Thread '${command.threadId}' already exists and cannot be created twice.`,
          });
        }
        threads.add(command.threadId);
        receipts.add(command.commandId);
        if (outcome === "accept-then-drop") throw new Error("Socket closed");
        return { sequence: calls };
      },
    },
  } as unknown as EnvironmentApi;
  return { api, commands, threads };
}

const noThreads = () => false;

describe("multi-model send — plan", () => {
  it("starts each model in its own fresh worktree off the base branch", () => {
    const plans = planMultiModelSend(sendInput({ fetchOrigin: true, runSetupScript: true }));
    expect(plans.map((plan) => plan.key)).toEqual([gpt, opus, sonnet].map(modelMultiSelectKey));
    expect(new Set(plans.map((plan) => plan.threadId)).size).toBe(3);
    expect(new Set(plans.map((plan) => plan.bootstrap.prepareWorktree?.branch)).size).toBe(3);
    for (const plan of plans) {
      expect(plan.threadId).toMatch(UUID);
      expect(plan.messageId).toMatch(UUID);
      expect(plan.commandId).toBe(`multi-model-send:${plan.threadId}:${plan.messageId}`);
      expect(plan.bootstrap.requireWorktree).toBe(true);
      expect(plan.bootstrap.runSetupScript).toBe(true);
      expect(plan.bootstrap.createThread).toMatchObject({
        projectId: "project-1",
        title: "Fix the flaky test",
        modelSelection: plan.modelSelection,
        branch: null,
        worktreePath: null,
        createdAt: "2026-10-22T10:00:00.000Z",
      });
      expect(plan.bootstrap.prepareWorktree).toMatchObject({
        projectCwd: "/repo",
        baseBranch: "main",
        fetchOrigin: true,
      });
      expect(plan.bootstrap.prepareWorktree?.branch).toMatch(/^ryco\/[0-9a-f]{8}$/);
    }
    // Setup follows the node's project preference unless the caller says otherwise.
    expect(planMultiModelSend(sendInput())[0]!.bootstrap).not.toHaveProperty("runSetupScript");
  });

  it("derives the same threads for a submission and new ones for the next", () => {
    const first = planMultiModelSend(sendInput());
    expect(planMultiModelSend(sendInput()).map((plan) => plan.threadId)).toEqual(
      first.map((plan) => plan.threadId),
    );
    expect(
      deriveMultiModelSendThreadId({
        draftId: "draft-1",
        submissionId: "submission-1",
        target: opus,
      }),
    ).toBe(first[1]!.threadId);
    const next = planMultiModelSend(sendInput({ submissionId: "submission-2" }));
    expect(next.some((plan) => first.some((earlier) => earlier.threadId === plan.threadId))).toBe(
      false,
    );
    const otherDraft = planMultiModelSend(sendInput({ draftId: "draft-2" }));
    expect(otherDraft[0]!.threadId).not.toBe(first[0]!.threadId);
  });

  it("refuses a send it cannot carry out before anything goes out", () => {
    expect(() => planMultiModelSend(sendInput({ targets: [] }))).toThrow("at least one");
    expect(() =>
      planMultiModelSend(
        sendInput({
          targets: [
            gpt,
            opus,
            sonnet,
            createModelSelection(codex, "gpt-5-mini"),
            createModelSelection(claude, "claude-haiku-4-5"),
          ].map(target),
        }),
      ),
    ).toThrow("at most 4");
    expect(() => planMultiModelSend(sendInput({ baseBranch: " " }))).toThrow("base branch");
    expect(() =>
      planMultiModelSend(
        sendInput({
          targets: [
            target(opus),
            target(createModelSelection(claude, opus.model, [{ id: "effort", value: "max" }])),
          ],
        }),
      ),
    ).toThrow("once");
  });

  it("never shares a streamed upload between models", () => {
    const upload = (token: string) => ({
      type: "file" as const,
      name: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      uploadToken: token,
    });
    expect(() => planMultiModelSend(sendInput({ turnAttachments: [upload("token-1")] }))).toThrow(
      "Upload 'spec.pdf' once for each model.",
    );
    const plans = planMultiModelSend(
      sendInput({
        turnAttachments: [upload("shared")],
        targets: [
          { ...target(gpt), turnAttachments: [upload("token-1")] },
          { ...target(opus), turnAttachments: [upload("token-2")] },
        ],
      }),
    );
    expect(plans.map((plan) => plan.turnAttachments[0]?.uploadToken)).toEqual([
      "token-1",
      "token-2",
    ]);
    // Inline attachments are shared as they are.
    const inline = {
      type: "image" as const,
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,AA==",
    };
    expect(
      planMultiModelSend(sendInput({ turnAttachments: [inline] })).every(
        (plan) => plan.turnAttachments[0] === inline,
      ),
    ).toBe(true);
  });
});

describe("multi-model send — targets", () => {
  const capabilities = createModelCapabilities({
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [
          { id: "medium", label: "Medium", isDefault: true },
          { id: "max", label: "Max" },
        ],
      },
    ],
  });
  const providers: ServerProvider[] = [
    {
      instanceId: claude,
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-22T00:00:00.000Z",
      models: [{ slug: "claude-opus-4-6", name: "Opus", isCustom: false, capabilities }],
      slashCommands: [],
      skills: [],
    },
    {
      instanceId: codex,
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      enabled: false,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-22T00:00:00.000Z",
      models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities }],
      slashCommands: [],
      skills: [],
    },
  ];
  const entries = deriveProviderInstanceEntries(providers);

  it("resolves the exact model with the options it dispatches", () => {
    const resolved = resolveMultiModelSendTarget({
      selection: createModelSelection(claude, "claude-opus-4-6", [{ id: "effort", value: "max" }]),
      entries,
      prompt: "hi",
    });
    expect(resolved).toMatchObject({
      ok: true,
      modelSelection: {
        instanceId: claude,
        model: "claude-opus-4-6",
        options: [{ id: "effort", value: "max" }],
      },
      promptEffort: "max",
    });
  });

  it("never moves a target to another instance or model", () => {
    expect(resolveMultiModelSendTarget({ selection: gpt, entries, prompt: "" })).toEqual({
      ok: false,
      reason: "Codex is unavailable.",
    });
    expect(
      resolveMultiModelSendTarget({
        selection: createModelSelection(claude, "claude-sonnet-4-6"),
        entries,
        prompt: "",
      }),
    ).toEqual({ ok: false, reason: "claude-sonnet-4-6 is not available on Claude." });
    expect(
      resolveMultiModelSendTarget({
        selection: createModelSelection(ProviderInstanceId.make("gone"), "x"),
        entries,
        prompt: "",
      }),
    ).toEqual({ ok: false, reason: "gone is unavailable." });
  });
});

describe("multi-model send — outcomes", () => {
  it("classifies what a failed attempt may have left on the node", () => {
    const pending = { kind: "pending" } as const;
    const uncertain = { kind: "uncertain", message: "earlier" } as const;
    expect(
      classifyMultiModelSendFailure({ error: new Error("stale"), sent: false, previous: pending }),
    ).toEqual({ kind: "not-created", message: "stale" });
    expect(
      classifyMultiModelSendFailure({
        error: new OrchestrationDispatchCommandError({ message: "Worktree failed" }),
        sent: true,
        previous: pending,
      }),
    ).toEqual({ kind: "not-created", message: "Worktree failed" });
    expect(
      classifyMultiModelSendFailure({
        error: new Error("Socket closed"),
        sent: true,
        previous: pending,
      }),
    ).toEqual({ kind: "uncertain", message: MULTI_MODEL_SEND_UNCERTAIN_MESSAGE });
    // A refusal ran nothing, so it says nothing about an earlier attempt.
    const refused = new RpcRequestRefusedError("awaiting-acknowledgement");
    expect(classifyMultiModelSendFailure({ error: refused, sent: true, previous: uncertain })).toBe(
      uncertain,
    );
    expect(
      classifyMultiModelSendFailure({ error: refused, sent: true, previous: pending }).kind,
    ).toBe("not-created");
    expect(
      classifyMultiModelSendFailure({
        error: { _tag: "AuthRpcError", message: "x" },
        sent: true,
        previous: pending,
      }).kind,
    ).toBe("not-created");
  });
});

describe("multi-model send — tracker", () => {
  it("starts every target at once with its own isolated worktree bootstrap", async () => {
    const node = makeNode();
    const tracker = createMultiModelSendTracker(sendInput());
    const snapshot = await tracker.send({ api: node.api, threadExists: noThreads });
    expect(snapshot.targets.map((target) => target.status.kind)).toEqual([
      "started",
      "started",
      "started",
    ]);
    expect(node.commands).toHaveLength(3);
    for (const [index, command] of node.commands.entries()) {
      const plan = snapshot.targets[index]!.plan;
      expect(command).toMatchObject({
        type: "thread.turn.start",
        commandId: plan.commandId,
        threadId: plan.threadId,
        modelSelection: plan.modelSelection,
        message: { messageId: plan.messageId, text: plan.outgoingMessageText },
        bootstrap: plan.bootstrap,
      });
    }
    // Started targets are never sent again.
    await tracker.send({ api: node.api, threadExists: noThreads });
    expect(node.commands).toHaveLength(3);
  });

  it("resends only what the node did not create, under the same thread and a new command", async () => {
    const node = makeNode((command, call) => {
      if (call > 3) return "accept";
      if (command.modelSelection?.instanceId === codex) {
        return new OrchestrationDispatchCommandError({ message: "Could not create the worktree." });
      }
      return command.modelSelection?.model === opus.model ? "accept-then-drop" : "accept";
    });
    let clock = 0;
    const tracker = createMultiModelSendTracker(sendInput(), {
      now: () => `2026-10-22T10:0${(clock += 1)}:00.000Z`,
    });
    const first = await tracker.send({ api: node.api, threadExists: noThreads });
    expect(first.targets.map((target) => target.status)).toEqual([
      { kind: "not-created", message: "Could not create the worktree." },
      { kind: "uncertain", message: MULTI_MODEL_SEND_UNCERTAIN_MESSAGE },
      { kind: "started" },
    ]);
    const summary = summarizeMultiModelSend(first);
    expect(
      [summary.started, summary.notCreated, summary.uncertain, summary.unsettled].map(
        (list) => list.length,
      ),
    ).toEqual([1, 1, 1, 0]);

    const second = await tracker.send({ api: node.api, threadExists: noThreads });
    expect(node.commands).toHaveLength(4);
    const resent = node.commands[3]!;
    const before = first.targets[0]!.plan;
    const after = second.targets[0]!.plan;
    expect(after.attempt).toBe(2);
    expect(resent.threadId).toBe(before.threadId);
    expect(resent.commandId).not.toBe(before.commandId);
    expect(resent.message.messageId).not.toBe(before.messageId);
    expect(resent.bootstrap?.prepareWorktree?.branch).not.toBe(
      before.bootstrap.prepareWorktree?.branch,
    );
    expect(resent.createdAt).toBe("2026-10-22T10:01:00.000Z");
    expect(resent.bootstrap?.createThread?.createdAt).toBe("2026-10-22T10:00:00.000Z");
    // The uncertain target waits for an explicit retry.
    expect(second.targets.map((target) => target.status.kind)).toEqual([
      "started",
      "uncertain",
      "started",
    ]);
  });

  it("retries an uncertain target as the identical command and never makes a second thread", async () => {
    const node = makeNode((command, call) =>
      call === 1 && command.modelSelection?.model === gpt.model ? "accept-then-drop" : "accept",
    );
    const tracker = createMultiModelSendTracker(
      sendInput({ targets: [target(gpt), target(opus)] }),
    );
    const first = await tracker.send({ api: node.api, threadExists: noThreads });
    expect(first.targets[0]!.status.kind).toBe("uncertain");

    const key = modelMultiSelectKey(gpt);
    const retried = await tracker.retryUncertain(key, { api: node.api, threadExists: noThreads });
    expect(retried.targets[0]!.status).toEqual({ kind: "started" });
    expect(node.commands.at(-1)).toEqual(node.commands[0]);
    expect(node.threads.size).toBe(2);
    // Nothing left to retry.
    await tracker.retryUncertain(key, { api: node.api, threadExists: noThreads });
    expect(node.commands).toHaveLength(3);
  });

  it("keeps a target uncertain when its retry was refused before it was sent", async () => {
    let refuse = false;
    const node = makeNode((_command, call) => (call === 1 ? new Error("Socket closed") : "accept"));
    const api = {
      orchestration: {
        dispatchCommand: (command: TurnStart) => {
          if (refuse) throw new RpcRequestRefusedError("awaiting-acknowledgement");
          return node.api.orchestration.dispatchCommand(command);
        },
      },
    } as unknown as EnvironmentApi;
    const tracker = createMultiModelSendTracker(sendInput({ targets: [target(gpt)] }));
    await tracker.send({ api, threadExists: noThreads });
    refuse = true;
    const snapshot = await tracker.retryUncertain(modelMultiSelectKey(gpt), {
      api,
      threadExists: noThreads,
    });
    expect(snapshot.targets[0]!.status).toEqual({
      kind: "uncertain",
      message: MULTI_MODEL_SEND_UNCERTAIN_MESSAGE,
    });
  });

  it("sends nothing when the connection changed before the turn start", async () => {
    const node = makeNode();
    const tracker = createMultiModelSendTracker(
      sendInput({ targets: [target(gpt), target(opus)] }),
    );
    const snapshot = await tracker.send({
      api: node.api,
      threadExists: noThreads,
      assertMutationReady: () => {
        throw new Error("The connection changed.");
      },
    });
    expect(node.commands).toHaveLength(0);
    expect(snapshot.targets.map((target) => target.status)).toEqual([
      { kind: "not-created", message: "The connection changed." },
      { kind: "not-created", message: "The connection changed." },
    ]);
  });

  it("treats a target whose thread the client sees as started", async () => {
    const node = makeNode(() => new Error("Socket closed"));
    const tracker = createMultiModelSendTracker(
      sendInput({ targets: [target(gpt), target(opus)] }),
    );
    const first = await tracker.send({ api: node.api, threadExists: noThreads });
    const gptThread = first.targets[0]!.plan.threadId;
    const seen = new Set<ThreadId>([gptThread]);
    const listener = { calls: 0 };
    const unsubscribe = tracker.subscribe(() => {
      listener.calls += 1;
    });
    tracker.reconcile((threadId) => seen.has(threadId));
    expect(tracker.read().targets.map((target) => target.status.kind)).toEqual([
      "started",
      "uncertain",
    ]);
    expect(listener.calls).toBe(1);
    // An unchanged reconcile publishes nothing.
    tracker.reconcile((threadId) => seen.has(threadId));
    expect(listener.calls).toBe(1);
    unsubscribe();
    // A retry first checks for the thread: the opus one exists now, so nothing is sent.
    seen.add(first.targets[1]!.plan.threadId);
    await tracker.retryUncertain(modelMultiSelectKey(opus), {
      api: node.api,
      threadExists: (threadId) => seen.has(threadId),
    });
    expect(node.commands).toHaveLength(2);
    expect(tracker.read().targets[1]!.status.kind).toBe("started");
  });

  it("does not send a target twice while it is in flight", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const node = makeNode();
    const api = {
      orchestration: {
        dispatchCommand: async (command: TurnStart) => {
          await held;
          return node.api.orchestration.dispatchCommand(command);
        },
      },
    } as unknown as EnvironmentApi;
    const tracker = createMultiModelSendTracker(
      sendInput({ targets: [target(gpt), target(opus)] }),
    );
    const first = tracker.send({ api, threadExists: noThreads });
    expect(tracker.read().targets.map((target) => target.status.kind)).toEqual([
      "dispatching",
      "dispatching",
    ]);
    const second = tracker.send({ api, threadExists: noThreads });
    release();
    await Promise.all([first, second]);
    expect(node.commands).toHaveLength(2);
  });
});
