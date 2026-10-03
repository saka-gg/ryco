import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES,
  SOURCE_CONTROL_DETAIL_MAX_COMMENTS,
  ThreadId,
  WorktreeId,
  type ComposerSourceControlContext,
  type EnvironmentApi,
  type GitCreateWorktreeForProjectInput,
  type ModelSelection,
} from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { fixtureDetail } from "../testing/pullRequestFixtures";
import { capHandoffContextDetail, dispatchHandoffThread } from "./agentHandoffDispatch";

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  options: [],
};

function fakeApi(options: { readonly canCreateWorktree?: boolean } = {}) {
  const commands: Array<Record<string, unknown>> = [];
  const worktrees: GitCreateWorktreeForProjectInput[] = [];
  const createWorktreeForProject = async (input: GitCreateWorktreeForProjectInput) => {
    worktrees.push(input);
    return {
      worktreeId: WorktreeId.make("worktree-pr-703"),
      sessionId: ThreadId.make("thread-from-worktree"),
    };
  };
  const api = {
    git: options.canCreateWorktree === false ? {} : { createWorktreeForProject },
    orchestration: {
      dispatchCommand: async (command: Record<string, unknown>) => {
        commands.push(command);
        return { sequence: commands.length };
      },
    },
  } as unknown as EnvironmentApi;
  return { api, commands, worktrees };
}

const context = {
  id: "ctx",
  kind: "change-request",
  provider: "github",
  reference: "github#703",
  detail: fixtureDetail(703),
} as unknown as ComposerSourceControlContext;

function input(
  api: EnvironmentApi,
  location: Parameters<typeof dispatchHandoffThread>[0]["location"],
) {
  let ids = 0;
  return {
    api,
    projectId: ProjectId.make("project-ryco"),
    projectCwd: "/repo",
    pullRequestNumber: 703,
    location,
    title: "Fix the failing check",
    prompt: "Fix the failing check, then push the fix.",
    context,
    modelSelection,
    tokenMode: "off" as const,
    newThreadId: () => ThreadId.make("thread-new"),
    newMessageId: () => MessageId.make("message-1"),
    newCommandId: () => CommandId.make(`command-${++ids}`),
    now: () => new Date("2026-10-03T08:00:00.000Z"),
  };
}

describe("dispatchHandoffThread", () => {
  it("checks the pull request out first, then sends the first turn into that thread", async () => {
    const { api, commands, worktrees } = fakeApi();
    const result = await dispatchHandoffThread(input(api, { kind: "new-worktree" }));

    expect(worktrees).toEqual([{ projectId: "project-ryco", intent: { kind: "pr", number: 703 } }]);
    expect(result.threadId).toBe("thread-from-worktree");
    const turn = commands.find((command) => command.type === "thread.turn.start");
    expect(turn).toMatchObject({
      threadId: "thread-from-worktree",
      message: { role: "user", text: "Fix the failing check, then push the fix." },
      modelSelection,
      sourceControlContexts: [context],
    });
    // The worktree already made the thread: nothing left for a bootstrap to create.
    expect(turn).not.toHaveProperty("bootstrap");
    // A server thread is retitled from its prompt, as a sent draft would be.
    expect(commands[0]).toMatchObject({
      type: "thread.meta.update",
      threadId: "thread-from-worktree",
      title: "Fix the failing check",
    });
  });

  it("bootstraps the thread on an existing checkout and starts it in the same command", async () => {
    const { api, commands, worktrees } = fakeApi();
    const result = await dispatchHandoffThread(
      input(api, {
        kind: "existing-worktree",
        worktreePath: "/worktrees/pr-703",
        branch: "ryco/stack-3-web-rail",
      }),
    );
    expect(worktrees).toEqual([]);
    expect(result.threadId).toBe("thread-new");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: "thread-new",
      bootstrap: {
        createThread: {
          projectId: "project-ryco",
          title: "Fix the failing check",
          branch: "ryco/stack-3-web-rail",
          worktreePath: "/worktrees/pr-703",
          modelSelection,
        },
      },
      sourceControlContexts: [context],
    });
    expect(commands[0]?.bootstrap).not.toHaveProperty("prepareWorktree");
  });

  it("runs on the project checkout when it is already on the head", async () => {
    const { api, commands } = fakeApi();
    await dispatchHandoffThread(
      input(api, { kind: "project-root", branch: "ryco/stack-3-web-rail" }),
    );
    expect(commands[0]).toMatchObject({
      bootstrap: { createThread: { branch: "ryco/stack-3-web-rail", worktreePath: null } },
    });
  });

  it("refuses a new checkout where worktrees cannot be created", async () => {
    const { api, commands } = fakeApi({ canCreateWorktree: false });
    await expect(dispatchHandoffThread(input(api, { kind: "new-worktree" }))).rejects.toThrow(
      "Worktree creation is unavailable",
    );
    expect(commands).toEqual([]);
  });
});

describe("capHandoffContextDetail", () => {
  it("bounds the page's full detail to the composer's caps and drops files and commits", () => {
    const detail = {
      ...fixtureDetail(703),
      body: "x".repeat(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES * 3),
      comments: Array.from({ length: SOURCE_CONTROL_DETAIL_MAX_COMMENTS + 4 }, (_, index) => ({
        ...fixtureDetail(703).comments[0]!,
        body: `comment ${index}`,
      })),
      truncated: false,
    };
    const capped = capHandoffContextDetail(detail);
    expect(new TextEncoder().encode(capped.body).byteLength).toBeLessThanOrEqual(
      SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES,
    );
    expect(capped.comments).toHaveLength(SOURCE_CONTROL_DETAIL_MAX_COMMENTS);
    expect(capped.truncated).toBe(true);
    expect(capped).not.toHaveProperty("files");
    expect(capped).not.toHaveProperty("commits");
    expect(capped.number).toBe(703);
  });
});
