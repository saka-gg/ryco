import {
  applyThreadForkOutcome,
  beginThreadForkAttempt,
  prepareThreadForkSubmit,
  THREAD_FORK_COPY,
  type ThreadForkAttemptController,
  type ThreadForkAttemptState,
  type ThreadForkSelection,
  type TurnDiffSummary,
} from "@ryco/client-runtime/state/threads";
import {
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ServerConfig,
  type ThreadForkKey,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildForkSheetSource,
  deriveForkSheetModel,
  forkSheetOnTarget,
  initialForkSheetSelection,
  isThreadForkOffered,
  type ForkSheetHandle,
  type ForkSheetSource,
} from "./forkDestinationModel";

const environmentId = EnvironmentId.make("env-fork");
const sourceThreadId = ThreadId.make("source-thread");
const sourceMessageId = MessageId.make("reply-1");
const turnId = TurnId.make("turn-1");

const gitSource: ForkSheetSource = {
  isChat: false,
  isGitRepo: true,
  chatsAvailable: true,
  sourceWorktreePath: null,
  sourceBranch: "main",
  checkpointAvailable: true,
};

function keys() {
  let next = 0;
  return (): ThreadForkKey => {
    next += 1;
    return `fork-${String(next).padStart(16, "0")}`;
  };
}

function attempt(
  selection: ThreadForkSelection = initialForkSheetSelection(gitSource),
): ThreadForkAttemptState {
  return beginThreadForkAttempt({
    boundary: { environmentId, sourceThreadId, sourceMessageId },
    selection,
    defaultBaseRef: "main",
    mintKey: keys(),
  });
}

function sheet(
  state: ThreadForkAttemptState,
  options: {
    readonly source?: ForkSheetSource;
    readonly opening?: boolean;
    readonly restored?: boolean;
    ready?: boolean;
  } = {},
) {
  return deriveForkSheetModel({
    source: options.source ?? gitSource,
    snapshot: {
      attempt: state,
      opening: options.opening ?? false,
      restored: options.restored ?? false,
    },
    ready: options.ready ?? true,
  });
}

function submitting(state: ThreadForkAttemptState): ThreadForkAttemptState {
  const prepared = prepareThreadForkSubmit(state, keys());
  if (!prepared.ok) throw new Error(prepared.reason);
  return prepared.state;
}

describe("isThreadForkOffered", () => {
  const open = {
    mutationReady: true,
    actionsDisabled: false,
    serverCapability: true,
    forkApiAvailable: true,
  };

  it("offers forking only while every gate is open", () => {
    expect(isThreadForkOffered(open)).toBe(true);
    // A hosted viewer, a cached thread, an older node, or a client without the method.
    expect(isThreadForkOffered({ ...open, mutationReady: false })).toBe(false);
    expect(isThreadForkOffered({ ...open, mutationReady: undefined })).toBe(false);
    expect(isThreadForkOffered({ ...open, actionsDisabled: true })).toBe(false);
    expect(isThreadForkOffered({ ...open, serverCapability: undefined })).toBe(false);
    expect(isThreadForkOffered({ ...open, forkApiAvailable: false })).toBe(false);
  });
});

describe("buildForkSheetSource", () => {
  const summary = (overrides: Partial<TurnDiffSummary>): TurnDiffSummary => ({
    turnId,
    completedAt: "2026-10-11T10:00:00.000Z",
    status: "ready",
    files: [],
    checkpointRef: CheckpointRef.make("refs/ryco/checkpoints/abc/turn/1"),
    ...overrides,
  });
  const thread = (summaries: ReadonlyArray<TurnDiffSummary>) => ({
    worktreePath: "/repo/.worktrees/feature",
    branch: "feature",
    turnDiffSummaries: summaries,
  });
  const chats = { chats: { available: true } } as Pick<ServerConfig, "chats">;
  const repo = (isRepo: boolean) => ({ data: { isRepo }, error: null });

  it("reads Git, chats and the selected turn's checkpoint through the shared rules", () => {
    expect(
      buildForkSheetSource({
        project: { kind: "project" },
        repository: repo(true),
        serverConfig: chats,
        thread: thread([summary({})]),
        turnId,
      }),
    ).toEqual({
      isChat: false,
      isGitRepo: true,
      chatsAvailable: true,
      sourceWorktreePath: "/repo/.worktrees/feature",
      sourceBranch: "feature",
      checkpointAvailable: true,
    });
  });

  it("keeps Git unknown until the status arrives, and never offers a provider-diff checkpoint", () => {
    const source = buildForkSheetSource({
      project: {},
      repository: { data: null, error: null },
      serverConfig: null,
      thread: thread([
        summary({ status: "missing", checkpointRef: CheckpointRef.make("provider-diff:turn-1") }),
      ]),
      turnId,
    });
    expect(source.isGitRepo).toBeNull();
    expect(source.chatsAvailable).toBe(false);
    expect(source.checkpointAvailable).toBe(false);
  });

  it("stops checking Git once the status read failed, offering only the folder", () => {
    const source = buildForkSheetSource({
      project: {},
      repository: { data: null, error: new Error("git status failed") },
      serverConfig: null,
      thread: thread([summary({})]),
      turnId,
    });
    expect(source.isGitRepo).toBe(false);
    const shown = sheet(attempt(), { source });
    expect(shown.destinations.map((option) => option.kind)).toEqual(["current-checkout"]);
    expect(
      shown.destinations.some(
        (option) => option.disabledReason === THREAD_FORK_COPY.destinations.checkingGit,
      ),
    ).toBe(false);
  });

  it("only uses the checkpoint of the selected turn", () => {
    const source = buildForkSheetSource({
      project: {},
      repository: repo(true),
      serverConfig: null,
      thread: thread([summary({ turnId: TurnId.make("turn-other") })]),
      turnId,
    });
    expect(source.checkpointAvailable).toBe(false);
  });

  it("treats a chat as a chat whatever its folder reports", () => {
    const source = buildForkSheetSource({
      project: { kind: "chat" },
      repository: repo(true),
      serverConfig: chats,
      thread: null,
      turnId,
    });
    expect(source).toMatchObject({ isChat: true, isGitRepo: false, chatsAvailable: true });
  });
});

describe("deriveForkSheetModel", () => {
  it("opens on the source's first destination with the base ref prefilled", () => {
    expect(initialForkSheetSelection({ isChat: false, sourceBranch: " feature " })).toEqual({
      destination: "current-checkout",
      worktreeStart: null,
      baseRef: "feature",
    });
    expect(initialForkSheetSelection({ isChat: true, sourceBranch: null })).toMatchObject({
      destination: "new-chat",
      baseRef: "HEAD",
    });
    const shown = sheet(attempt());
    expect(shown).toMatchObject({
      destination: "current-checkout",
      worktreeStarts: [],
      editable: true,
      canSubmit: true,
      canDismiss: true,
      actionLabel: THREAD_FORK_COPY.submit,
      notice: null,
    });
    expect(shown.destinations.map((option) => option.kind)).toEqual([
      "current-checkout",
      "new-worktree",
    ]);
  });

  it("starts a new worktree from the checkpoint when the turn has one, else from a ref", () => {
    const worktree = attempt({ destination: "new-worktree", baseRef: "main" });
    expect(sheet(worktree)).toMatchObject({
      worktreeStart: "checkpoint",
      showBaseRef: false,
      selection: { destination: "new-worktree", worktreeStart: "checkpoint", baseRef: "main" },
    });
    const noCheckpoint = sheet(worktree, { source: { ...gitSource, checkpointAvailable: false } });
    expect(noCheckpoint.worktreeStarts[0]).toMatchObject({ kind: "checkpoint", enabled: false });
    expect(noCheckpoint).toMatchObject({ worktreeStart: "base-ref", showBaseRef: true });
  });

  it("falls back from a worktree while Git is unknown, and keeps the pick for when it loads", () => {
    const picked = attempt({ destination: "new-worktree" });
    const loading = sheet(picked, { source: { ...gitSource, isGitRepo: null } });
    expect(loading.destinations[1]).toMatchObject({
      kind: "new-worktree",
      enabled: false,
      disabledReason: THREAD_FORK_COPY.destinations.checkingGit,
    });
    expect(loading.destination).toBe("current-checkout");
    expect(loading.selection?.destination).toBe("current-checkout");
    expect(sheet(picked).destination).toBe("new-worktree");
  });

  it("requires a base ref and says why", () => {
    const shown = sheet(
      attempt({ destination: "new-worktree", worktreeStart: "base-ref", baseRef: " " }),
    );
    expect(shown).toMatchObject({
      canSubmit: false,
      selectionError: THREAD_FORK_COPY.worktreeStarts.baseRefRequired,
    });
  });

  it("offers a chat only a new chat, and nothing when chats are off", () => {
    const chat = { ...gitSource, isChat: true, isGitRepo: false };
    const chatAttempt = attempt(initialForkSheetSelection({ isChat: true, sourceBranch: null }));
    expect(sheet(chatAttempt, { source: chat }).destination).toBe("new-chat");
    const off = sheet(chatAttempt, { source: { ...chat, chatsAvailable: false } });
    expect(off).toMatchObject({
      destination: null,
      selection: null,
      canSubmit: false,
      selectionError: THREAD_FORK_COPY.destinations.chatsUnavailable,
    });
  });

  it("cannot be dismissed or edited while a request or the fork's opening is in flight", () => {
    const sent = submitting(attempt({ destination: "new-worktree", worktreeStart: "checkpoint" }));
    expect(sheet(sent)).toMatchObject({
      busy: true,
      editable: false,
      canSubmit: false,
      canDismiss: false,
      actionLabel: THREAD_FORK_COPY.busy.preparingWorktree,
    });
    expect(sheet(attempt(), { opening: true })).toMatchObject({
      busy: true,
      canDismiss: false,
      canSubmit: false,
    });
  });

  it("says it opens a created fork, and lets a restored one's opening be cancelled", () => {
    const sent = submitting(attempt({ destination: "new-worktree", worktreeStart: "checkpoint" }));
    const created = applyThreadForkOutcome(sent, {
      status: "succeeded",
      result: {
        threadId: ThreadId.make("fork-thread"),
        projectId: ProjectId.make("project-1"),
        replayed: false,
        providerContext: "native",
        checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
        notices: [],
      },
    });
    // The fork exists: never "Preparing worktree…" or "Creating fork…" while it opens.
    expect(sheet(created, { opening: true })).toMatchObject({
      busy: true,
      canSubmit: false,
      canDismiss: false,
      actionLabel: THREAD_FORK_COPY.busy.opening,
    });
    // Created while no sheet showed it: nothing is in flight, so Cancel and back still close.
    expect(sheet(created, { opening: true, restored: true })).toMatchObject({
      busy: true,
      canDismiss: true,
      actionLabel: THREAD_FORK_COPY.busy.opening,
    });
  });

  it("shows the request the node may hold while locked, whatever the source now says", () => {
    const sent = submitting(
      attempt({ destination: "new-worktree", worktreeStart: "base-ref", baseRef: "release" }),
    );
    const uncertain = applyThreadForkOutcome(sent, {
      status: "uncertain",
      message: THREAD_FORK_COPY.uncertain,
      error: null,
    });
    // Git went unknown after a reconnect: the locked rows still show what was sent.
    const shown = sheet(uncertain, { source: { ...gitSource, isGitRepo: null } });
    expect(shown).toMatchObject({
      editable: false,
      destination: "new-worktree",
      worktreeStart: "base-ref",
      baseRef: "release",
      canSubmit: true,
      canDismiss: true,
      actionLabel: THREAD_FORK_COPY.retry,
      notice: { tone: "warning", title: THREAD_FORK_COPY.titles.uncertain },
    });
  });

  it("waits for the node to be ready again before sending", () => {
    expect(sheet(attempt(), { ready: false })).toMatchObject({ canSubmit: false, notReady: true });
    expect(sheet(submitting(attempt()), { ready: false }).notReady).toBe(false);
  });
});

describe("forkSheetOnTarget", () => {
  const handle: ForkSheetHandle = {
    request: {
      environmentId,
      sourceThreadId,
      sourceTitle: "Source",
      messageId: sourceMessageId,
      turnId,
      excerpt: "",
    },
    controller: {} as ThreadForkAttemptController,
    visible: true,
  };

  it("drops a sheet once its screen shows another thread, so it never reappears on its own", () => {
    expect(forkSheetOnTarget(handle, { environmentId, threadId: sourceThreadId })).toBe(handle);
    // Retargeted to B, then back to A: the screen already let go of A's sheet.
    const onB = forkSheetOnTarget(handle, { environmentId, threadId: ThreadId.make("thread-b") });
    expect(onB).toBeNull();
    expect(forkSheetOnTarget(onB, { environmentId, threadId: sourceThreadId })).toBeNull();
    expect(
      forkSheetOnTarget(handle, {
        environmentId: EnvironmentId.make("env-other"),
        threadId: sourceThreadId,
      }),
    ).toBeNull();
  });
});
