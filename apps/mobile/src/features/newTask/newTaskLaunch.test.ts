import { useWorktreeLaunchStore } from "@ryco/client-runtime/state/worktree-setup";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
  type WorktreeSetupSnapshot,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createNewTaskAttempt,
  type NewTaskProjectContext,
  type NewTaskStableIds,
  type NewTaskWorktreeContext,
} from "./newTaskController";
import {
  deriveNewTaskLaunchView,
  discardNewTaskLaunch,
  newTaskLaunchKey,
  readNewTaskLaunch,
  readNewTaskLaunchDraftForEdit,
  retryNewTaskLaunch,
  startNewTaskLaunch,
  useNewTaskLaunchStore,
  type NewTaskLaunchDeps,
  type NewTaskLaunchDraft,
} from "./newTaskLaunch";

/** The node's typed refusal, as the RPC client decodes it: a definite answer. */
function nodeRefusal(message: string): Error {
  return Object.assign(new Error(message), { _tag: "OrchestrationDispatchCommandError" });
}

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project-existing");
const ids: NewTaskStableIds = {
  projectId: ProjectId.make("project-new"),
  projectCommandId: CommandId.make("command-project"),
  threadId: ThreadId.make("thread-new"),
  threadCommandId: CommandId.make("command-thread"),
  attachCommandId: CommandId.make("command-attach"),
  turnCommandId: CommandId.make("command-turn"),
  messageId: MessageId.make("message-new"),
};
const key = newTaskLaunchKey(environmentId, ids.threadId);

const NEW_WORKTREE: NewTaskWorktreeContext = {
  kind: "new",
  branch: "feat/phone",
  baseBranch: "HEAD",
  fetchOrigin: false,
};
const EXISTING_PROJECT: NewTaskProjectContext = {
  kind: "existing",
  projectId,
  workspaceRoot: "/code/ryco",
};

function attempt(input?: {
  readonly project?: NewTaskProjectContext;
  readonly worktree?: NewTaskWorktreeContext;
}) {
  return createNewTaskAttempt({
    environmentId,
    prompt: "Make the header sticky",
    project: input?.project ?? EXISTING_PROJECT,
    worktree: input?.worktree ?? { kind: "local" },
    createdAt: "2026-10-30T08:00:00.000Z",
    ids,
  });
}

const draft: NewTaskLaunchDraft = {
  environmentId,
  projectId,
  newProjectPath: "",
  newProjectTitle: "",
  worktree: { kind: "new" },
  newBranch: "feat/phone",
  baseBranch: "",
  prompt: "Make the header sticky",
  attachments: [],
  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } as never,
  runtimeMode: "full-access",
  interactionMode: "default",
};

/** A node: records commands, refuses what `refuse` names, answers the setup feed. */
function node(options?: {
  readonly refuse?: (command: ClientOrchestrationCommand) => string | null;
}) {
  const commands: ClientOrchestrationCommand[] = [];
  let pushSnapshot: ((snapshot: WorktreeSetupSnapshot) => void) | null = null;
  const onWorktreeSetup = vi.fn(
    (
      _input: { readonly threadId: ThreadId },
      listener: (snapshot: WorktreeSetupSnapshot) => void,
    ) => {
      pushSnapshot = listener;
      return () => {
        pushSnapshot = null;
      };
    },
  );
  let held: Promise<void> | null = null;
  let minted = 0;
  const deps: NewTaskLaunchDeps = {
    feedApi: { vcs: { onWorktreeSetup } } as never,
    newCommandId: () => CommandId.make(`command-fresh-${++minted}`),
    controller: {
      dispatch: async (command) => {
        commands.push(command);
        const wait = held;
        held = null;
        if (wait !== null) await wait;
        const refusal = options?.refuse?.(command) ?? null;
        // A dropped socket is no answer; anything else is the node refusing.
        if (refusal?.startsWith("SocketCloseError")) throw new Error(refusal);
        if (refusal) throw nodeRefusal(refusal);
      },
      waitForProject: async () => undefined,
      waitForThread: async () => undefined,
    },
  };
  return {
    deps,
    commands,
    onWorktreeSetup,
    push: (snapshot: WorktreeSetupSnapshot) => pushSnapshot?.(snapshot),
    /** Hold the next command open, the way a node preparing a worktree does. */
    hold: () => {
      let release!: () => void;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function view(threadHasMessages = false) {
  return deriveNewTaskLaunchView({
    launch: readNewTaskLaunch(key),
    worktreeLaunch: useWorktreeLaunchStore.getState().launchesByKey[key],
    threadHasMessages,
  });
}

afterEach(() => {
  discardNewTaskLaunch(key);
  useNewTaskLaunchStore.setState({ launchesByKey: {} });
  useWorktreeLaunchStore.setState({ launchesByKey: {} });
});

describe("New Task launch", () => {
  it("is on the thread screen before the node answers, then hands over to the thread", async () => {
    const remote = node();
    const release = remote.hold();
    startNewTaskLaunch({ attempt: attempt(), draft, deps: remote.deps });

    expect(readNewTaskLaunch(key)?.status).toBe("starting");
    expect(view()).toMatchObject({
      title: "Make the header sticky",
      prompt: "Make the header sticky",
      statusLabel: "Starting",
      failureMessage: null,
      canRetry: false,
      canEdit: false,
    });
    expect(view()?.steps.map((step) => [step.id, step.status])).toEqual([
      ["thread", "running"],
      ["turn", "pending"],
    ]);

    release();
    await settle();
    expect(readNewTaskLaunch(key)?.status).toBe("started");
    expect(remote.commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
    // The node's own messages take over the screen.
    expect(view(true)).toBeNull();
  });

  it("follows the node's setup feed for a new worktree and hands the launch off", async () => {
    const remote = node();
    const release = remote.hold();
    startNewTaskLaunch({ attempt: attempt({ worktree: NEW_WORKTREE }), draft, deps: remote.deps });

    expect(remote.onWorktreeSetup).toHaveBeenCalledWith(
      { threadId: ids.threadId },
      expect.any(Function),
      expect.anything(),
    );
    expect(useWorktreeLaunchStore.getState().launchesByKey[key]).toMatchObject({
      phase: "preparing",
      baseRef: "HEAD",
      fetchOrigin: false,
      messageId: ids.messageId,
    });
    remote.push({
      threadId: ids.threadId,
      sequence: 1,
      status: "running",
      baseRef: "HEAD",
      stages: [
        { id: "fetch", status: "skipped" },
        { id: "checkout", status: "running", percent: 40 },
        { id: "setup-script", status: "pending" },
        { id: "agent", status: "pending" },
      ],
      outputTail: [],
      startedAt: "2026-10-30T08:00:00.000Z",
      updatedAt: "2026-10-30T08:00:01.000Z",
    });
    expect(view()?.statusLabel).toBe("Setting up a worktree");
    expect(view()?.steps.map((step) => [step.id, step.status, step.percent])).toEqual([
      ["fetch", "skipped", null],
      ["checkout", "running", 40],
      ["setup-script", "pending", null],
      ["agent", "pending", null],
    ]);

    release();
    await settle();
    expect(useWorktreeLaunchStore.getState().launchesByKey[key]?.phase).toBe("handed-off");
    expect(
      view()
        ?.steps.filter((step) => step.status !== "skipped")
        .map((step) => step.status),
    ).toEqual(["done", "done", "done"]);
  });

  it("shows the node's refusal with Retry and Edit task, and Retry sends it under a fresh id", async () => {
    let refuse = true;
    const remote = node({
      refuse: () => {
        if (!refuse) return null;
        refuse = false;
        return "A branch named 'feat/phone' already exists.";
      },
    });
    startNewTaskLaunch({ attempt: attempt({ worktree: NEW_WORKTREE }), draft, deps: remote.deps });
    await settle();

    expect(readNewTaskLaunch(key)?.status).toBe("failed");
    expect(useWorktreeLaunchStore.getState().launchesByKey[key]?.phase).toBe("failed");
    expect(view()).toMatchObject({
      statusLabel: "Not started",
      failureMessage: "A branch named 'feat/phone' already exists.",
      canRetry: true,
      canEdit: true,
    });

    retryNewTaskLaunch(key, remote.deps);
    expect(readNewTaskLaunch(key)?.status).toBe("starting");
    expect(useWorktreeLaunchStore.getState().launchesByKey[key]?.phase).toBe("preparing");
    await settle();
    expect(readNewTaskLaunch(key)?.status).toBe("started");
    // The node keeps a receipt of the refused id and would refuse it again.
    expect(remote.commands.map((command) => command.commandId)).toEqual([
      ids.turnCommandId,
      "command-fresh-1",
    ]);
    expect(remote.commands[1]).toMatchObject({
      threadId: ids.threadId,
      message: { messageId: ids.messageId },
    });
  });

  it("sends a turn start that may have been delivered again under its own id", async () => {
    let lose = true;
    const remote = node({
      refuse: (command) => {
        if (command.type !== "thread.turn.start" || !lose) return null;
        lose = false;
        return "SocketCloseError: connection lost";
      },
    });
    startNewTaskLaunch({ attempt: attempt(), draft, deps: remote.deps });
    await settle();
    retryNewTaskLaunch(key, remote.deps);
    await settle();

    expect(readNewTaskLaunch(key)?.status).toBe("started");
    // The node answers a delivered id from its receipt instead of starting it twice.
    expect(
      remote.commands
        .filter((command) => command.type === "thread.turn.start")
        .map((command) => command.commandId),
    ).toEqual([ids.turnCommandId, ids.turnCommandId]);
  });

  it("offers no Edit task once the node may hold a thread for the task", async () => {
    const remote = node({
      refuse: (command) =>
        command.type === "thread.turn.start" ? "SocketCloseError: connection lost" : null,
    });
    startNewTaskLaunch({ attempt: attempt(), draft, deps: remote.deps });
    await settle();

    expect(readNewTaskLaunch(key)?.failure).toMatchObject({
      step: "turn",
      deliveryUncertain: true,
    });
    expect(view()).toMatchObject({ canRetry: true, canEdit: false });
    // Editing would start the same task a second time.
    expect(readNewTaskLaunchDraftForEdit(key)).toBeNull();
  });

  it("hands the draft back for editing, keeping a project the attempt already created", async () => {
    const remote = node({
      refuse: (command) => (command.type === "thread.create" ? "Projects are read-only." : null),
    });
    startNewTaskLaunch({
      attempt: attempt({ project: { kind: "new", workspaceRoot: "/code/fresh" } }),
      draft: { ...draft, projectId: null, newProjectPath: "/code/fresh", newProjectTitle: "Fresh" },
      deps: remote.deps,
    });
    await settle();

    expect(view()?.steps.map((step) => [step.id, step.status])).toEqual([
      ["project", "done"],
      ["thread", "failed"],
      ["turn", "pending"],
    ]);
    expect(readNewTaskLaunchDraftForEdit(key)).toMatchObject({
      prompt: "Make the header sticky",
      projectId: ids.projectId,
      newProjectPath: "",
      newProjectTitle: "",
    });
    // Reading takes nothing; the sheet discards the launch once it shows the draft.
    expect(readNewTaskLaunch(key)).not.toBeNull();
  });

  it("offers no Edit task while a new project the node took is not confirmed yet", async () => {
    const remote = node();
    startNewTaskLaunch({
      attempt: attempt({ project: { kind: "new", workspaceRoot: "/code/fresh" } }),
      draft: { ...draft, projectId: null, newProjectPath: "/code/fresh" },
      deps: {
        ...remote.deps,
        controller: {
          ...remote.deps.controller,
          waitForProject: async () => {
            throw new Error("Project was not confirmed");
          },
        },
      },
    });
    await settle();

    expect(readNewTaskLaunch(key)?.failure).toMatchObject({
      step: "project",
      deliveryUncertain: false,
    });
    // Editing would create the project a second time under another id.
    expect(view()).toMatchObject({ canRetry: true, canEdit: false });
    expect(readNewTaskLaunchDraftForEdit(key)).toBeNull();
  });

  it("keeps a running launch until its outcome lands: Remove waits for it", async () => {
    const remote = node();
    const release = remote.hold();
    startNewTaskLaunch({ attempt: attempt({ worktree: NEW_WORKTREE }), draft, deps: remote.deps });
    // Its commands may be on their way: forgetting it now would hide what lands.
    expect(discardNewTaskLaunch(key)).toBe(false);
    expect(useWorktreeLaunchStore.getState().launchesByKey[key]).toBeDefined();

    release();
    await settle();
    expect(readNewTaskLaunch(key)?.status).toBe("started");
    expect(discardNewTaskLaunch(key)).toBe(true);
    expect(readNewTaskLaunch(key)).toBeNull();
    expect(useWorktreeLaunchStore.getState().launchesByKey[key]).toBeUndefined();
  });

  it("runs a failed launch once however often Retry is pressed", async () => {
    let refusals = 1;
    const remote = node({ refuse: () => (refusals-- > 0 ? "Not now." : null) });
    startNewTaskLaunch({ attempt: attempt(), draft, deps: remote.deps });
    await settle();
    const before = remote.commands.length;

    retryNewTaskLaunch(key, remote.deps);
    retryNewTaskLaunch(key, remote.deps);
    await settle();
    expect(readNewTaskLaunch(key)?.status).toBe("started");
    // thread.create again, then the turn start: once, not twice.
    expect(remote.commands.length - before).toBe(2);
  });
});
