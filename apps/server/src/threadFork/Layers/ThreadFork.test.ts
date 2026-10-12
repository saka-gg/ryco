import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  THREAD_FORKED_ACTIVITY_KIND,
  ThreadForkError,
  type ThreadForkInput,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { readThreadForkedActivity } from "@ryco/shared/threadFork";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { makeCheckpointRevertActivity } from "../../orchestration/checkpointRevertPolicy.ts";
import { buildContextHandoffDocument } from "../../orchestration/contextHandoff/ContextHandoffBuilder.ts";
import {
  inheritedItemId,
  isInheritedItemId,
  originalItemId,
} from "../../orchestration/forkInheritance.ts";
import { isNeverUsedThread } from "../../persistence/Services/ProjectionThreads.ts";
import { threadForkIdentity } from "../forkLedger.ts";
import type { NativeForkOutcome } from "../nativeFork.ts";
import {
  createForkHarness,
  fakeNative,
  type ForkHarness,
  type ForkHarnessOptions,
  type ForkTestInstance,
  historyAt,
  seedCompletedTurn,
  seedNativeBinding,
  seedProject,
  seedThread,
  type SeededTurn,
} from "../threadFork.fixtures.ts";

const roots: string[] = [];
const harnesses: ForkHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function harness(options: ForkHarnessOptions = {}) {
  const created = await createForkHarness(options);
  harnesses.push(created);
  return created;
}

const projectId = ProjectId.make("fork-project");
const sourceId = ThreadId.make("fork-source");

async function seedSource(
  h: ForkHarness,
  input: {
    readonly workspace: string;
    readonly turns: number;
    readonly instance?: ForkTestInstance;
    readonly threadId?: ThreadId;
    readonly commentaryOnTurn?: number;
    readonly seedProjectToo?: boolean;
  },
): Promise<ReadonlyArray<SeededTurn>> {
  const threadId = input.threadId ?? sourceId;
  if (input.seedProjectToo !== false) {
    await seedProject(h, { projectId, workspaceRoot: input.workspace });
  }
  await seedThread(h, {
    threadId,
    projectId,
    ...(input.instance !== undefined ? { instance: input.instance } : {}),
  });
  const turns: SeededTurn[] = [];
  for (let index = 1; index <= input.turns; index++) {
    turns.push(
      await seedCompletedTurn(h, {
        threadId,
        index,
        ...(input.instance !== undefined ? { instance: input.instance } : {}),
        commentary: input.commentaryOnTurn === index,
      }),
    );
  }
  return turns;
}

const forkInput = (
  forkKey: string,
  sourceMessageId: MessageId,
  overrides: Partial<ThreadForkInput> = {},
): ThreadForkInput => ({
  forkKey,
  sourceThreadId: sourceId,
  sourceMessageId,
  destination: { kind: "current-checkout" },
  ...overrides,
});

const forkedActivity = async (h: ForkHarness, forkThreadId: ThreadId) => {
  const detail = await h.detail(forkThreadId);
  const activity = detail?.activities.find((entry) => entry.kind === THREAD_FORKED_ACTIVITY_KIND);
  return activity === undefined ? null : readThreadForkedActivity(activity);
};

const failure = (h: ForkHarness, input: ThreadForkInput) =>
  h.run(Effect.flip(h.forks.fork(input))).then((error) => {
    expect(error).toBeInstanceOf(ThreadForkError);
    return error;
  });

/** A Codex session running `activeTurnId`, as a provider runtime reports it. */
const runningSession = (threadId: ThreadId, activeTurnId: TurnId, updatedAt: string) => ({
  threadId,
  status: "running" as const,
  providerName: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make(`${threadId}-runtime`),
  runtimeMode: "full-access" as const,
  activeTurnId,
  lastError: null,
  updatedAt,
});

describe("ThreadFork", () => {
  it("inherits only through the selected turn, natively, with an independent binding", async () => {
    const root = await tempRoot("ryco-fork-native-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const native = fakeNative();
    const h = await harness({ service: { native: native.native } });
    const turns = await seedSource(h, { workspace, turns: 3 });
    await seedNativeBinding(h, {
      threadId: sourceId,
      instance: "codex",
      cwd: workspace,
      nativeId: "codex-source",
    });
    const startedAt = new Date().toISOString();

    const result = await h.run(h.forks.fork(forkInput("fork-key-native-0001", turns[1]!.replyId)));

    const forkId = threadForkIdentity("fork-key-native-0001").forkThreadId;
    expect(result).toMatchObject({
      threadId: forkId,
      projectId,
      replayed: false,
      providerContext: "native",
      checkout: { kind: "current-checkout", worktreePath: null, branch: null },
    });
    // The provider copy ends with the selected turn.
    expect(native.calls).toHaveLength(1);
    expect(native.calls[0]!.plan).toMatchObject({
      driver: "codex",
      sourceNativeId: "codex-source",
      turnId: turns[1]!.turnId,
    });
    expect(native.calls[0]!.targetCwd).toBe(workspace);

    const detail = await h.detail(forkId);
    expect(detail?.messages.map((message) => originalItemId(forkId, message.id))).toEqual([
      turns[0]!.promptId,
      turns[0]!.replyId,
      turns[1]!.promptId,
      turns[1]!.replyId,
    ]);
    expect(detail?.messages.every((message) => isInheritedItemId(forkId, message.id))).toBe(true);
    expect(detail?.latestTurn).toBeNull();
    expect(detail?.session).toBeNull();

    const shell = await h.shell(forkId);
    expect(shell?.lineage).toEqual({
      parentThreadId: sourceId,
      rootThreadId: sourceId,
      relationship: "forked",
      sourceMessageId: turns[1]!.replyId,
      sourceTurnId: turns[1]!.turnId,
    });
    expect(shell?.title).toBe("Source thread (fork)");
    // Recency: a fresh fork lists like a new thread, not at its inherited history's time.
    expect(shell?.latestUserMessageAt).toBeNull();
    expect(shell?.latestCompletedTurnAt ?? null).toBeNull();
    expect(shell!.createdAt >= startedAt).toBe(true);
    const row = await h.run(h.threadRows.getById({ threadId: forkId }));
    expect(Option.isSome(row) && isNeverUsedThread(row.value)).toBe(false);
    const sourceShell = await h.shell(sourceId);
    expect(sourceShell?.latestUserMessageAt).not.toBeNull();
    expect(sourceShell?.latestCompletedTurnAt ?? null).not.toBeNull();

    // Independent sessions: the fork's own stopped binding resumes the copy; the source's is
    // untouched.
    const forkBinding = Option.getOrThrow(await h.run(h.directory.getBinding(forkId)));
    expect(forkBinding).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeSessionId: threadForkIdentity("fork-key-native-0001").runtimeSessionId,
      status: "stopped",
      resumeCursor: { threadId: "copy-of-codex-source" },
      runtimePayload: { cwd: workspace },
    });
    const sourceBinding = Option.getOrThrow(await h.run(h.directory.getBinding(sourceId)));
    expect(sourceBinding.resumeCursor).toEqual({ threadId: "codex-source" });
    expect(sourceBinding.runtimeSessionId).toBe(`${sourceId}-runtime`);

    expect(await forkedActivity(h, forkId)).toMatchObject({
      providerContext: "native",
      sourceTurnId: turns[1]!.turnId,
      inheritedMessageCount: 4,
    });
    expect(await h.ledgerRows()).toEqual([{ forkKey: "fork-key-native-0001", phase: "completed" }]);
  });

  it("hands off providers without an exact native fork, without later messages", async () => {
    const root = await tempRoot("ryco-fork-handoff-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const native = fakeNative();
    const h = await harness({ service: { native: native.native } });
    const turns = await seedSource(h, { workspace, turns: 3, instance: "opencode" });

    const result = await h.run(h.forks.fork(forkInput("fork-key-handoff-001", turns[0]!.replyId)));
    expect(result.providerContext).toBe("handoff");
    expect(native.calls).toHaveLength(0);
    expect(await forkedActivity(h, result.threadId)).toMatchObject({
      providerContext: "handoff",
      handoffReason: "provider-unsupported",
    });
    expect(Option.isNone(await h.run(h.directory.getBinding(result.threadId)))).toBe(true);

    // The fork's first turn delivers its inherited conversation to a fresh session.
    const firstMessageId = MessageId.make("fork-handoff-first");
    await h.run(
      h.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("fork-handoff-first-turn"),
        threadId: result.threadId,
        message: { messageId: firstMessageId, role: "user", text: "Continue", attachments: [] },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      }),
    );
    const detail = (await h.detail(result.threadId))!;
    const handoff = detail.activities.find((activity) => activity.kind === "context-handoff");
    expect(handoff?.payload).toMatchObject({ reason: "fork", status: "requested" });
    const endpoint = {
      providerInstanceId: ProviderInstanceId.make("opencode"),
      driverKind: ProviderDriverKind.make("opencode"),
      modelSlug: "fixture-model",
    };
    const context = buildContextHandoffDocument({
      thread: detail,
      targetMessageId: firstMessageId,
      source: endpoint,
      target: endpoint,
    });
    expect(context.document.messages.map((message) => message.text)).toEqual([
      "Prompt 1",
      "Reply 1",
    ]);

    // Copilot and Cursor hand off for the same reason.
    for (const instance of ["copilot", "cursor"] as const) {
      const threadId = ThreadId.make(`fork-source-${instance}`);
      const [turn] = await seedSource(h, {
        workspace,
        turns: 1,
        instance,
        threadId,
        seedProjectToo: false,
      });
      const forked = await h.run(
        h.forks.fork(
          forkInput(`fork-key-${instance}-00001`, turn!.replyId, { sourceThreadId: threadId }),
        ),
      );
      expect(forked.providerContext).toBe("handoff");
      expect(await forkedActivity(h, forked.threadId)).toMatchObject({
        handoffReason: "provider-unsupported",
      });
    }
    expect(native.calls).toHaveLength(0);
  });

  it("keeps the boundary pinned while the source advances before publication", async () => {
    const root = await tempRoot("ryco-fork-pinned-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const native = fakeNative();
    let advanceSource: () => Promise<void> = async () => {};
    const h = await harness({
      service: {
        native: native.native,
        onRunPoint: (point) =>
          point === "accepted" ? Effect.promise(() => advanceSource()) : Effect.void,
      },
    });
    const turns = await seedSource(h, { workspace, turns: 3 });
    await seedNativeBinding(h, {
      threadId: sourceId,
      instance: "codex",
      cwd: workspace,
      nativeId: "codex-source",
    });
    let added: SeededTurn | undefined;
    advanceSource = async () => {
      added = await seedCompletedTurn(h, { threadId: sourceId, index: 4 });
    };

    const result = await h.run(h.forks.fork(forkInput("fork-key-pinned-0001", turns[1]!.replyId)));

    expect(added).toBeDefined();
    const detail = await h.detail(result.threadId);
    const inherited = detail?.messages.map((message) =>
      originalItemId(result.threadId, message.id),
    );
    expect(inherited).toEqual([
      turns[0]!.promptId,
      turns[0]!.replyId,
      turns[1]!.promptId,
      turns[1]!.replyId,
    ]);
    expect(native.calls[0]!.plan.turnId).toEqual(turns[1]!.turnId);
    expect((await h.detail(sourceId))?.messages.some((m) => m.id === added!.replyId)).toBe(true);
  });

  it("creates one thread and one native copy for a repeated key, and refuses a different request", async () => {
    const root = await tempRoot("ryco-fork-dedupe-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    // Slow enough that the second request joins the first one while it runs.
    const native = fakeNative((request) =>
      Effect.sleep("50 millis").pipe(
        Effect.as<NativeForkOutcome>({
          kind: "forked",
          nativeThreadId: "copy",
          ownedCopy: { kind: "codex-thread", threadId: "copy" },
        }),
        Effect.tap(() => Effect.sync(() => void request)),
      ),
    );
    const h = await harness({ service: { native: native.native } });
    const turns = await seedSource(h, { workspace, turns: 2 });
    await seedNativeBinding(h, {
      threadId: sourceId,
      instance: "codex",
      cwd: workspace,
      nativeId: "codex-source",
    });
    const input = forkInput("fork-key-dedupe-0001", turns[0]!.replyId);

    const [first, second] = await Promise.all([
      h.run(h.forks.fork(input)),
      h.run(h.forks.fork(input)),
    ]);
    const third = await h.run(h.forks.fork(input));

    expect(second.threadId).toBe(first.threadId);
    expect(third).toEqual({ ...first, replayed: true });
    expect(native.calls).toHaveLength(1);
    expect(await h.ledgerRows()).toHaveLength(1);
    expect((await h.threadIds()).toSorted()).toEqual([first.threadId, sourceId].toSorted());

    for (const changed of [
      forkInput("fork-key-dedupe-0001", turns[1]!.replyId),
      forkInput("fork-key-dedupe-0001", turns[0]!.replyId, {
        destination: { kind: "new-worktree", start: { kind: "checkpoint" } },
      }),
    ]) {
      const error = await failure(h, changed);
      expect(error.reason).toBe("idempotency-conflict");
      expect(error.retryable).toBe(false);
    }
    expect(native.calls).toHaveLength(1);
    expect(await h.ledgerRows()).toHaveLength(1);
  });

  it("finishes a fork whose caller went away mid-run, exactly once", async () => {
    const root = await tempRoot("ryco-fork-detach-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    // The native copy takes a while; the caller gives up long before it returns.
    const native = fakeNative(() =>
      Effect.sleep("300 millis").pipe(
        Effect.as<NativeForkOutcome>({
          kind: "forked",
          nativeThreadId: "copy",
          ownedCopy: { kind: "codex-thread", threadId: "copy" },
        }),
      ),
    );
    const h = await harness({ service: { native: native.native } });
    const turns = await seedSource(h, { workspace, turns: 2 });
    await seedNativeBinding(h, {
      threadId: sourceId,
      instance: "codex",
      cwd: workspace,
      nativeId: "codex-source",
    });
    const input = forkInput("fork-key-detach-000001", turns[0]!.replyId);

    // A disconnect interrupts the request while the provider is copying the conversation.
    const abandoned = await h.run(
      Effect.exit(h.forks.fork(input).pipe(Effect.timeout("100 millis"))),
    );
    expect(abandoned._tag).toBe("Failure");
    expect(native.calls).toHaveLength(1);
    expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "provider-forking" }]);

    // The run goes on without its caller and uses the copy it made.
    await vi.waitFor(
      async () =>
        expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "completed" }]),
      { timeout: 10_000, interval: 20 },
    );
    const replay = await h.run(h.forks.fork(input));
    expect(replay).toMatchObject({ replayed: true, providerContext: "native" });
    expect(native.calls).toHaveLength(1);
    expect(native.removed).toEqual([]);
    expect((await h.threadIds()).toSorted()).toEqual([replay.threadId, sourceId].toSorted());
  });

  it("recovers a run that stopped after claiming the native fork, without forking again", async () => {
    const root = await tempRoot("ryco-fork-crash-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const databasePath = path.join(root, "state.sqlite");
    const crashed = fakeNative();
    const first = await createForkHarness({
      databasePath,
      service: {
        native: crashed.native,
        onRunPoint: (point) =>
          point === "provider-forking" ? Effect.die(new Error("simulated crash")) : Effect.void,
      },
    });
    const input = forkInput("fork-key-crash-00001", MessageId.make(`${sourceId}-reply-1`));
    try {
      const turns = await seedSource(first, { workspace, turns: 2 });
      expect(turns[0]!.replyId).toBe(input.sourceMessageId);
      await seedNativeBinding(first, {
        threadId: sourceId,
        instance: "codex",
        cwd: workspace,
        nativeId: "codex-source",
      });
      const error = await failure(first, input);
      expect(error.retryable).toBe(true);
      expect(await first.ledgerRows()).toEqual([
        { forkKey: input.forkKey, phase: "provider-forking" },
      ]);
    } finally {
      await first.dispose();
    }
    expect(crashed.calls).toHaveLength(0);

    const restarted = fakeNative();
    const second = await harness({ databasePath, service: { native: restarted.native } });
    await second.run(second.forks.recover());
    expect(await second.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "completed" }]);
    expect(restarted.calls).toHaveLength(0);

    const replay = await second.run(second.forks.fork(input));
    expect(replay).toMatchObject({ replayed: true, providerContext: "handoff" });
    expect(replay.notices.some((notice) => notice.includes("did not repeat the copy"))).toBe(true);
    expect(await forkedActivity(second, replay.threadId)).toMatchObject({
      providerContext: "handoff",
      handoffReason: "native-fork-uncertain",
    });
    expect((await second.threadIds()).filter((id) => id === replay.threadId)).toHaveLength(1);
    expect(Option.isNone(await second.run(second.directory.getBinding(replay.threadId)))).toBe(
      true,
    );
  });

  it("refuses stale, missing, mid-turn and user-message boundaries and trashed sources without writing", async () => {
    const root = await tempRoot("ryco-fork-refused-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const native = fakeNative();
    const h = await harness({ service: { native: native.native } });
    const turns = await seedSource(h, { workspace, turns: 2, commentaryOnTurn: 1 });

    const cases: ReadonlyArray<readonly [MessageId, string]> = [
      [MessageId.make("no-such-message"), "boundary-stale"],
      [turns[1]!.promptId, "boundary-unsupported"],
      [turns[0]!.commentaryId!, "boundary-unsupported"],
    ];
    for (const [index, [messageId, reason]] of cases.entries()) {
      const error = await failure(h, forkInput(`fork-key-refused-${index}000`, messageId));
      expect(error.reason).toBe(reason);
    }

    // A reply of a turn that is still running: the agent has written it, the turn goes on.
    const midTurn = ThreadId.make("fork-source-mid-turn");
    await seedThread(h, { threadId: midTurn, projectId });
    const midTurnId = TurnId.make("fork-mid-turn-running");
    await h.run(
      h.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("fork-mid-turn-start"),
        threadId: midTurn,
        message: {
          messageId: MessageId.make("fork-mid-turn-prompt"),
          role: "user",
          text: "Still working",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: historyAt(100),
      }),
    );
    await h.run(
      h.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("fork-mid-turn-running"),
        threadId: midTurn,
        session: runningSession(midTurn, midTurnId, historyAt(101)),
        createdAt: historyAt(101),
      }),
    );
    await h.run(
      h.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("fork-mid-turn-reply"),
        threadId: midTurn,
        messageId: MessageId.make("fork-mid-turn-reply"),
        turnId: midTurnId,
        text: "Partial answer",
        createdAt: historyAt(102),
      }),
    );
    expect(
      await failure(
        h,
        forkInput("fork-key-refused-mid-turn", MessageId.make("fork-mid-turn-reply"), {
          sourceThreadId: midTurn,
        }),
      ),
    ).toMatchObject({ reason: "source-busy", retryable: true, attempt: "none" });

    // The session still names a turn active whose row already reads completed (a projection
    // that is behind): the session passed to the boundary rule refuses it.
    const behind = ThreadId.make("fork-source-session-behind");
    const [behindTurn] = await seedSource(h, {
      workspace,
      turns: 1,
      threadId: behind,
      seedProjectToo: false,
    });
    await h.run(
      h.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("fork-session-behind-running"),
        threadId: behind,
        session: runningSession(behind, behindTurn!.turnId, historyAt(200)),
        createdAt: historyAt(200),
      }),
    );
    const behindTurnRow = (await h.detail(behind))?.latestTurn;
    expect(behindTurnRow).toMatchObject({ turnId: behindTurn!.turnId, state: "completed" });
    expect(
      await failure(
        h,
        forkInput("fork-key-refused-behind", behindTurn!.replyId, { sourceThreadId: behind }),
      ),
    ).toMatchObject({ reason: "source-busy", retryable: true, attempt: "none" });

    // The original is reverting to a checkpoint: nothing it is about to drop may be forked.
    const reverting = ThreadId.make("fork-source-reverting");
    const [revertingTurn] = await seedSource(h, {
      workspace,
      turns: 1,
      threadId: reverting,
      seedProjectToo: false,
    });
    const revertRequestedAt = new Date().toISOString();
    await h.run(
      h.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("fork-source-revert-pending"),
        threadId: reverting,
        activity: makeCheckpointRevertActivity({
          revertRequestId: CommandId.make("fork-source-revert-1"),
          turnCount: 0,
          status: "requested",
          createdAt: revertRequestedAt,
        }),
        createdAt: revertRequestedAt,
      }),
    );
    const revertRefusal = await failure(
      h,
      forkInput("fork-key-refused-revert", revertingTurn!.replyId, { sourceThreadId: reverting }),
    );
    expect(revertRefusal).toMatchObject({
      reason: "source-busy",
      retryable: true,
      attempt: "none",
    });
    expect(revertRefusal.message).toContain("reverting");
    const threadsBefore = await h.threadIds();

    const trashed = ThreadId.make("fork-source-trashed");
    const [trashedTurn] = await seedSource(h, {
      workspace,
      turns: 1,
      threadId: trashed,
      seedProjectToo: false,
    });
    await h.run(
      h.engine.dispatch({
        type: "thread.trash",
        commandId: CommandId.make("trash-fork-source"),
        threadId: trashed,
      }),
    );
    const error = await failure(
      h,
      forkInput("fork-key-refused-trash", trashedTurn!.replyId, { sourceThreadId: trashed }),
    );
    expect(error.reason).toBe("source-unavailable");

    // A chat-only destination is refused for a project thread.
    const chatOnly = await failure(
      h,
      forkInput("fork-key-refused-chat", turns[0]!.replyId, { destination: { kind: "new-chat" } }),
    );
    expect(chatOnly.reason).toBe("destination-unavailable");

    expect(await h.ledgerRows()).toEqual([]);
    expect(await h.threadIds()).toEqual(threadsBefore);
    expect(native.calls).toHaveLength(0);
  });

  it("answers a completed fork whose thread was deleted since", async () => {
    const root = await tempRoot("ryco-fork-deleted-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const h = await harness({ service: { native: fakeNative().native } });
    const turns = await seedSource(h, { workspace, turns: 1, instance: "opencode" });
    const input = forkInput("fork-key-deleted-001", turns[0]!.replyId);
    const result = await h.run(h.forks.fork(input));
    await h.run(
      h.engine.dispatch({
        type: "thread.trash",
        commandId: CommandId.make("trash-fork"),
        threadId: result.threadId,
      }),
    );
    const error = await failure(h, input);
    expect(error.reason).toBe("deleted");
  });

  it("forks a chat into a new chat with an empty folder", async () => {
    const root = await tempRoot("ryco-fork-chat-");
    const chatsRoot = path.join(root, "chats");
    const sourceFolder = path.join(chatsRoot, "source-chat");
    await mkdir(sourceFolder, { recursive: true });
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path.join(sourceFolder, "notes.md"), "kept in the original chat"),
    );
    const h = await harness({ chatsRoot, service: { native: fakeNative().native } });
    const chatProject = ProjectId.make("chat-source-project");
    await seedProject(h, { projectId: chatProject, workspaceRoot: sourceFolder, kind: "chat" });
    await seedThread(h, { threadId: sourceId, projectId: chatProject, instance: "opencode" });
    const turn = await seedCompletedTurn(h, { threadId: sourceId, index: 1, instance: "opencode" });

    const refused = await failure(h, forkInput("fork-key-chat-current", turn.replyId));
    expect(refused.reason).toBe("destination-unavailable");

    const result = await h.run(
      h.forks.fork(
        forkInput("fork-key-chat-00001", turn.replyId, { destination: { kind: "new-chat" } }),
      ),
    );
    expect(result.projectId).toBe(threadForkIdentity("fork-key-chat-00001").chatProjectId);
    expect(result.checkout.kind).toBe("new-chat");
    const folder = result.checkout.kind === "new-chat" ? result.checkout.folder : "";
    const fs = await import("node:fs/promises");
    expect(await fs.readdir(folder)).toEqual([]);
    expect(await fs.readdir(sourceFolder)).toEqual(["notes.md"]);
    const project = await h.run(h.snapshots.getProjectShellById(result.projectId));
    expect(Option.getOrThrow(project)).toMatchObject({ kind: "chat", workspaceRoot: folder });
    expect((await h.shell(result.threadId))?.projectId).toBe(result.projectId);
  });

  it("orders a fork by its own activity, never by the history it inherited", async () => {
    const root = await tempRoot("ryco-fork-recency-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const h = await harness({ service: { native: fakeNative().native } });
    const turns = await seedSource(h, { workspace, turns: 2, instance: "opencode" });
    const forked = await h.run(h.forks.fork(forkInput("fork-key-recency-01", turns[1]!.replyId)));
    const fresh = await h.shell(forked.threadId);
    expect(fresh?.latestUserMessageAt).toBeNull();
    expect(fresh?.latestCompletedTurnAt ?? null).toBeNull();

    // The fork's own first turn is what moves it.
    const own = await seedCompletedTurn(h, {
      threadId: forked.threadId,
      index: 7,
      instance: "opencode",
    });
    const used = await h.shell(forked.threadId);
    const ownPrompt = (await h.detail(forked.threadId))?.messages.find(
      (message) => message.id === own.promptId,
    );
    expect(used?.latestUserMessageAt).toBe(ownPrompt?.createdAt);
    expect(used?.latestCompletedTurnAt).not.toBeNull();

    // Reverting the fork's own turn recomputes the summary from what is left: inherited only.
    await h.run(
      h.engine.dispatch({
        type: "thread.revert.complete",
        commandId: CommandId.make("fork-recency-revert"),
        threadId: forked.threadId,
        turnCount: 0,
        createdAt: new Date().toISOString(),
      }),
    );
    const reverted = await h.shell(forked.threadId);
    expect(reverted?.latestUserMessageAt).toBeNull();
    expect(reverted?.latestCompletedTurnAt ?? null).toBeNull();
    expect((await h.detail(forked.threadId))?.messages).toHaveLength(4);
    // The source keeps its own recency.
    expect((await h.shell(sourceId))?.latestUserMessageAt).toBe(
      (await h.detail(sourceId))?.messages.find((message) => message.id === turns[1]!.promptId)
        ?.createdAt,
    );
  });

  it("refuses a fork of a fork from an inherited turn that was interrupted or failed in the source", async () => {
    const root = await tempRoot("ryco-fork-of-fork-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const h = await harness({ service: { native: fakeNative().native } });
    await seedProject(h, { projectId, workspaceRoot: workspace });
    await seedThread(h, { threadId: sourceId, projectId, instance: "opencode" });
    const seed = (index: number, outcome: "completed" | "interrupted" | "error") =>
      seedCompletedTurn(h, { threadId: sourceId, index, instance: "opencode", outcome });
    // A turn that completed, one the user stopped after a partial reply, one that failed after
    // its reply, and one that completed.
    const completed = await seed(1, "completed");
    const stopped = await seed(2, "interrupted");
    const failed = await seed(3, "error");
    const last = await seed(4, "completed");
    // In the source itself, the node refuses both.
    for (const [index, turn] of [stopped, failed].entries()) {
      expect(
        await failure(h, forkInput(`fork-key-source-unfinished-${index}`, turn.replyId)),
      ).toMatchObject({ reason: "boundary-unsupported", attempt: "none" });
    }

    const parent = await h.run(h.forks.fork(forkInput("fork-key-parent-of-fork-1", last.replyId)));
    expect((await forkedActivity(h, parent.threadId))?.inheritedTurnOutcomes).toEqual([
      { turnId: stopped.turnId, state: "interrupted" },
      { turnId: failed.turnId, state: "error" },
    ]);
    // The fork's rows of its inherited turns keep how each turn ended in the source.
    const states = await h.run(
      h.sql<{ readonly turnId: string; readonly state: string }>`
        SELECT turn_id AS "turnId", state FROM projection_turns
        WHERE thread_id = ${parent.threadId} AND turn_id IS NOT NULL ORDER BY turn_id
      `,
    );
    expect(states).toEqual(
      [
        { turnId: completed.turnId, state: "completed" },
        { turnId: stopped.turnId, state: "interrupted" },
        { turnId: failed.turnId, state: "error" },
        { turnId: last.turnId, state: "completed" },
      ].toSorted((left, right) => (left.turnId < right.turnId ? -1 : 1)),
    );

    // A fork of the fork refuses those turns' inherited replies, like the source does...
    const inheritedReply = (replyId: MessageId) =>
      MessageId.make(
        inheritedItemId({
          forkThreadId: parent.threadId,
          sourceThreadId: sourceId,
          sourceItemId: replyId,
        }),
      );
    for (const [index, turn] of [stopped, failed].entries()) {
      expect(
        await failure(
          h,
          forkInput(`fork-key-fork-of-fork-no-${index}`, inheritedReply(turn.replyId), {
            sourceThreadId: parent.threadId,
          }),
        ),
      ).toMatchObject({ reason: "boundary-unsupported", attempt: "none" });
    }
    // ...and forks from an inherited turn that completed.
    const child = await h.run(
      h.forks.fork(
        forkInput("fork-key-fork-of-fork-yes-1", inheritedReply(completed.replyId), {
          sourceThreadId: parent.threadId,
        }),
      ),
    );
    expect((await h.shell(child.threadId))?.lineage).toMatchObject({
      parentThreadId: parent.threadId,
      relationship: "forked",
    });
    expect((await h.detail(child.threadId))?.messages).toHaveLength(2);
    expect((await forkedActivity(h, child.threadId))?.inheritedTurnOutcomes).toBeUndefined();
  });
});
