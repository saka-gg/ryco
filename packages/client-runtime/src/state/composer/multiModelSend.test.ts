import {
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentApi,
  type MessageId,
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

const noTurns = () => false;

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
    // A refusal ran nothing, so it says nothing about an earlier send.
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

  it("never takes the node's answer to an uncertain retry as nothing created", () => {
    // The first send was cut off by a node restart after its thread and branch
    // were made: the identical command fails on them, and nothing is cleaned up.
    const uncertain = { kind: "uncertain", message: MULTI_MODEL_SEND_UNCERTAIN_MESSAGE } as const;
    const branchExists = new OrchestrationDispatchCommandError({
      message: "fatal: a branch named 'ryco/1a2b3c4d' already exists",
    });
    expect(
      classifyMultiModelSendFailure({ error: branchExists, sent: true, previous: uncertain }),
    ).toBe(uncertain);
    expect(
      classifyMultiModelSendFailure({
        error: new Error("Socket closed"),
        sent: true,
        previous: uncertain,
      }),
    ).toEqual(uncertain);
  });
});

describe("multi-model send — tracker", () => {
  it("starts every target at once with its own isolated worktree bootstrap", async () => {
    const node = makeNode();
    const tracker = createMultiModelSendTracker(sendInput());
    const snapshot = await tracker.send({ api: node.api });
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
    await tracker.send({ api: node.api });
    expect(node.commands).toHaveLength(3);
  });

  it("leaves what the node did not create to the draft's next send", async () => {
    const node = makeNode((command, call) => {
      if (call > 3) return "accept";
      if (command.modelSelection?.instanceId === codex) {
        return new OrchestrationDispatchCommandError({ message: "Could not create the worktree." });
      }
      return command.modelSelection?.model === opus.model ? "accept-then-drop" : "accept";
    });
    const tracker = createMultiModelSendTracker(sendInput());
    const first = await tracker.send({ api: node.api });
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

    // Sending again sends nothing: the uncertain target waits for an explicit
    // retry, and the one not created for a new submission.
    expect(await tracker.send({ api: node.api })).toBe(first);
    expect(node.commands).toHaveLength(3);

    // That submission is built from the composer as it is then (here, an
    // edited prompt), with only the model not created, and new threads.
    const edited = { ...target(gpt), outgoingMessageText: "Fix the flaky test, edited" };
    const retry = createMultiModelSendTracker(
      sendInput({ submissionId: "submission-2", targets: [edited] }),
    );
    const retried = await retry.send({ api: node.api });
    expect(retried.targets.map((target) => target.status.kind)).toEqual(["started"]);
    const resent = node.commands.at(-1)!;
    const before = first.targets[0]!.plan;
    expect(resent.message.text).toBe("Fix the flaky test, edited");
    expect(resent.threadId).not.toBe(before.threadId);
    expect(resent.commandId).not.toBe(before.commandId);
    expect(resent.bootstrap?.prepareWorktree?.branch).not.toBe(
      before.bootstrap.prepareWorktree?.branch,
    );
  });

  it("retries an uncertain target as the identical command and never makes a second thread", async () => {
    const node = makeNode((command, call) =>
      call === 1 && command.modelSelection?.model === gpt.model ? "accept-then-drop" : "accept",
    );
    const tracker = createMultiModelSendTracker(
      sendInput({ targets: [target(gpt), target(opus)] }),
    );
    const first = await tracker.send({ api: node.api });
    expect(first.targets[0]!.status.kind).toBe("uncertain");

    const key = modelMultiSelectKey(gpt);
    const retried = await tracker.retryUncertain(key, { api: node.api, turnVisible: noTurns });
    expect(retried.targets[0]!.status).toEqual({ kind: "started" });
    expect(node.commands.at(-1)).toEqual(node.commands[0]);
    expect(node.threads.size).toBe(2);
    // Nothing left to retry.
    await tracker.retryUncertain(key, { api: node.api, turnVisible: noTurns });
    expect(node.commands).toHaveLength(3);
  });

  it("keeps a target uncertain when the node fails its retry on what the first send left", async () => {
    // Call 1 is cut off by a node restart after the thread and branch were
    // made; call 2, the identical command, finds no receipt and fails on them.
    const node = makeNode((_command, call) =>
      call === 1
        ? new Error("Socket closed")
        : new OrchestrationDispatchCommandError({
            message: "fatal: a branch named 'ryco/1a2b3c4d' already exists",
          }),
    );
    const tracker = createMultiModelSendTracker(sendInput({ targets: [target(gpt)] }));
    await tracker.send({ api: node.api });
    const key = modelMultiSelectKey(gpt);
    const retried = await tracker.retryUncertain(key, { api: node.api, turnVisible: noTurns });
    expect(retried.targets[0]!.status).toEqual({
      kind: "uncertain",
      message: MULTI_MODEL_SEND_UNCERTAIN_MESSAGE,
    });
    // Neither a new send nor the thread the first send left makes it started.
    await tracker.send({ api: node.api });
    tracker.reconcile(noTurns);
    expect(node.commands).toHaveLength(2);
    expect(tracker.read().targets[0]!.status.kind).toBe("uncertain");
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
    await tracker.send({ api });
    refuse = true;
    const snapshot = await tracker.retryUncertain(modelMultiSelectKey(gpt), {
      api,
      turnVisible: noTurns,
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

  it("treats an uncertain target whose turn the client sees as started", async () => {
    const node = makeNode(() => new Error("Socket closed"));
    const tracker = createMultiModelSendTracker(
      sendInput({ targets: [target(gpt), target(opus)] }),
    );
    const first = await tracker.send({ api: node.api });
    const turns = new Set<MessageId>([first.targets[0]!.plan.messageId]);
    const turnVisible = ({ messageId }: { readonly messageId: MessageId }) => turns.has(messageId);
    const listener = { calls: 0 };
    const unsubscribe = tracker.subscribe(() => {
      listener.calls += 1;
    });
    tracker.reconcile(turnVisible);
    expect(tracker.read().targets.map((target) => target.status.kind)).toEqual([
      "started",
      "uncertain",
    ]);
    expect(listener.calls).toBe(1);
    // An unchanged reconcile publishes nothing.
    tracker.reconcile(turnVisible);
    expect(listener.calls).toBe(1);
    unsubscribe();
    // A retry first checks for the turn: the opus one shows now, so nothing is sent.
    turns.add(first.targets[1]!.plan.messageId);
    await tracker.retryUncertain(modelMultiSelectKey(opus), { api: node.api, turnVisible });
    expect(node.commands).toHaveLength(2);
    expect(tracker.read().targets[1]!.status.kind).toBe("started");
  });

  it("never takes a thread without its turn, or a target the node answered for, as started", async () => {
    // gpt's bootstrap is still running when the connection drops: its thread
    // shows before setup and the turn start, which may yet fail and delete it.
    // opus failed fast: its thread can still show for a frame after the answer.
    const node = makeNode((command) =>
      command.modelSelection?.instanceId === codex
        ? new Error("Socket closed")
        : new OrchestrationDispatchCommandError({ message: "The turn was not started." }),
    );
    const tracker = createMultiModelSendTracker(
      sendInput({ targets: [target(gpt), target(opus)] }),
    );
    const first = await tracker.send({ api: node.api });
    // The client shows both threads, neither with a user message yet.
    const shown = new Map<ThreadId, { userMessage: boolean }>(
      first.targets.map((target) => [target.plan.threadId, { userMessage: false }]),
    );
    const turnVisible = ({ threadId }: { readonly threadId: ThreadId }) =>
      shown.get(threadId)?.userMessage === true;
    tracker.reconcile(turnVisible);
    expect(tracker.read().targets.map((target) => target.status.kind)).toEqual([
      "uncertain",
      "not-created",
    ]);
    // Once they show a turn, only the uncertain target moves: the node's answer stands.
    for (const thread of shown.values()) thread.userMessage = true;
    tracker.reconcile(turnVisible);
    expect(tracker.read().targets.map((target) => target.status.kind)).toEqual([
      "started",
      "not-created",
    ]);
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
    const first = tracker.send({ api });
    expect(tracker.read().targets.map((target) => target.status.kind)).toEqual([
      "dispatching",
      "dispatching",
    ]);
    const second = tracker.send({ api });
    release();
    await Promise.all([first, second]);
    expect(node.commands).toHaveLength(2);
  });
});
