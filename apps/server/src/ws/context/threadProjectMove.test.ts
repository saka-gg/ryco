import {
  CommandId,
  type DiagnosticsTerminalProcess,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ProjectId,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  automationMoveBlockerMessage,
  dispatchThreadProjectMove,
  type ThreadProjectMoveCommand,
  type ThreadProjectMoveDependencies,
} from "./threadProjectMove.ts";

const threadId = ThreadId.make("thread-move");
const createdAt = "2026-11-01T12:00:00.000Z";
const chatFolder = "/chats/2026-11-01-wrong-project-0123abcd";

const terminal = (
  overrides: Partial<DiagnosticsTerminalProcess> = {},
): DiagnosticsTerminalProcess => ({
  threadId,
  terminalId: "default",
  cwd: "/tmp/project-a",
  worktreePath: null,
  status: "running",
  pid: 42,
  hasRunningSubprocess: false,
  exitCode: null,
  exitSignal: null,
  updatedAt: createdAt,
  ...overrides,
});

const command = (overrides: Partial<ThreadProjectMoveCommand> = {}): ThreadProjectMoveCommand => ({
  type: "thread.project.move",
  commandId: CommandId.make("move-1"),
  threadId,
  expectedProjectId: ProjectId.make("project-a"),
  projectId: ProjectId.make("project-b"),
  createdAt,
  ...overrides,
});

const harness = (input?: {
  readonly automations?: ReadonlyArray<string>;
  readonly terminals?: ReadonlyArray<DiagnosticsTerminalProcess>;
  readonly refuseMove?: boolean;
}) => {
  const calls = {
    dispatched: [] as OrchestrationCommand[],
    closed: [] as string[],
    allocated: 0,
    removed: [] as string[],
  };
  const deps: ThreadProjectMoveDependencies = {
    automations: {
      listActiveTitlesTargetingThread: () => Effect.succeed(input?.automations ?? []),
    },
    terminals: {
      listDiagnostics: Effect.succeed(input?.terminals ?? []),
      close: ({ threadId: closed }) =>
        Effect.sync(() => {
          calls.closed.push(closed);
        }),
    },
    chatBootstrap: {
      chatFolders: {
        allocateChatFolder: () =>
          Effect.sync(() => {
            calls.allocated += 1;
            return chatFolder;
          }),
        ensureChatFolder: () => Effect.succeed({ created: false }),
        removeEmptyChatFolder: (path) =>
          Effect.sync(() => {
            calls.removed.push(path);
            return true;
          }),
      },
      projects: {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      },
      projectRecords: { getById: () => Effect.succeed(Option.none()) },
      dispatch: (created) =>
        Effect.sync(() => {
          calls.dispatched.push(created);
          return { sequence: calls.dispatched.length };
        }),
      serverCommandId: (tag) => CommandId.make(`server:${tag}`),
    },
    dispatch: (moved) =>
      input?.refuseMove
        ? Effect.fail(new OrchestrationDispatchCommandError({ message: "Refused by the decider." }))
        : Effect.sync(() => {
            calls.dispatched.push(moved);
            return { sequence: calls.dispatched.length };
          }),
  };
  return { deps, calls };
};

const run = (deps: ThreadProjectMoveDependencies, input: ThreadProjectMoveCommand) =>
  Effect.runPromise(dispatchThreadProjectMove(deps, input));

describe("dispatchThreadProjectMove", () => {
  it("moves the thread and closes its idle shells in the old directory", async () => {
    const { deps, calls } = harness({ terminals: [terminal()] });
    await run(deps, command());
    expect(calls.dispatched.map((entry) => entry.type)).toEqual(["thread.project.move"]);
    expect(calls.closed).toEqual([threadId]);
  });

  it("keeps a chat an automation continues where it is", async () => {
    const { deps, calls } = harness({ automations: ["Nightly triage"] });
    await expect(run(deps, command())).rejects.toThrow(
      'The automation "Nightly triage" continues this chat',
    );
    expect(calls.dispatched).toEqual([]);
    expect(automationMoveBlockerMessage(["A", "B", "C"])).toMatch(/"A" and 2 more/);
  });

  it("refuses while a terminal of the thread runs a command", async () => {
    const { deps, calls } = harness({
      terminals: [terminal({ hasRunningSubprocess: true })],
    });
    await expect(run(deps, command())).rejects.toThrow(/terminal of this thread is running/);
    expect(calls.dispatched).toEqual([]);
    expect(calls.closed).toEqual([]);
  });

  it("ignores other threads' terminals and exited shells", async () => {
    const { deps, calls } = harness({
      terminals: [
        terminal({ threadId: "other-thread", hasRunningSubprocess: true }),
        terminal({ status: "exited", pid: null }),
      ],
    });
    await run(deps, command());
    expect(calls.closed).toEqual([]);
  });

  it("creates the new chat before a move to No project, and removes its folder when refused", async () => {
    const chatId = ProjectId.make("chat-new");
    const toChat = command({
      projectId: chatId,
      createChatProject: { projectId: chatId, titleSeed: "Wrong project" },
    });
    const moved = harness();
    await run(moved.deps, toChat);
    expect(moved.calls.dispatched.map((entry) => entry.type)).toEqual([
      "project.create",
      "thread.project.move",
    ]);
    expect(moved.calls.dispatched[0]).toMatchObject({ kind: "chat", workspaceRoot: chatFolder });

    const refused = harness({ refuseMove: true });
    await expect(run(refused.deps, toChat)).rejects.toThrow("Refused by the decider.");
    expect(refused.calls.removed).toEqual([chatFolder]);
  });
});
