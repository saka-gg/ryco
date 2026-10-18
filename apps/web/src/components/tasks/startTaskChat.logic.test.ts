import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  PROVIDER_SEND_TURN_MAX_SOURCE_CONTROL_CONTEXTS,
  ProviderInstanceId,
  ThreadId,
  type EffectiveProjectPreferences,
  type LocalTaskLink,
  type ModelSelection,
  type ServerConfig,
  type SourceControlChangeRequestDetail,
} from "@ryco/contracts";
import { formatThreadMentionPath } from "@ryco/client-runtime/state/composer";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTaskTurnStartCommand,
  buildTaskWhereOptions,
  changeRequestRepositoryKey,
  localRefNames,
  parseTaskWhereOptionId,
  projectRepositoryKey,
  resolveTaskStartDefaults,
  resolveTaskStartPlace,
  taskSourceControlContext,
  taskSourceControlLinks,
  taskStartCommandId,
  taskStartedMessage,
  taskWhereOptionId,
  taskWorktreeBranch,
} from "./startTaskChat.logic";

const TITLE = "Fix the login redirect loop on hosted Hub";

const pr = (number: number): LocalTaskLink => ({ kind: "pr", number });
const issue = (number: number): LocalTaskLink => ({ kind: "issue", number });
const branch = (name: string): LocalTaskLink => ({ kind: "branch", name });

function where(links: ReadonlyArray<LocalTaskLink>, overrides: { linkedWorktrees?: boolean } = {}) {
  return buildTaskWhereOptions({
    title: TITLE,
    links,
    startBranches: [],
    linkedWorktrees: overrides.linkedWorktrees ?? true,
  });
}

describe("buildTaskWhereOptions", () => {
  it("offers a new worktree on the task's branch first, then the project folder", () => {
    const options = where([]);
    expect(options.map((option) => option.id)).toEqual(["worktree", "project"]);
    expect(options[0]).toMatchObject({
      kind: "worktree",
      label: "New worktree",
      hintPrefix: "a new worktree",
      hintRef: "task/fix-login-redirect-loop",
    });
    expect(options[1]).toMatchObject({
      kind: "project",
      label: "Project folder",
      detail: "No worktree, current branch",
      hintPrefix: "the project folder",
      hintRef: null,
    });
  });

  it("puts linked pull requests, then linked branches, before the new worktree", () => {
    const options = where([branch("feature/x"), issue(3), pr(746), pr(746), pr(12)]);
    expect(options.map((option) => option.id)).toEqual([
      "pr:746",
      "pr:12",
      "branch:feature/x",
      "worktree",
      "project",
    ]);
    expect(options[0]).toMatchObject({
      label: "PR #746 worktree",
      detail: "Pushes update the pull request",
      hintPrefix: "the PR #746 worktree",
      hintRef: null,
    });
    expect(options[2]).toMatchObject({ label: "feature/x worktree", hintRef: "feature/x" });
  });

  it("names a pull request's worktree branch when one is known", () => {
    const options = buildTaskWhereOptions({
      title: TITLE,
      links: [pr(746)],
      startBranches: [],
      linkedWorktrees: true,
      pullRequestBranch: (number) => (number === 746 ? "fix/login-loop" : null),
    });
    expect(options[0]?.hintRef).toBe("fix/login-loop");
  });

  it("offers a pull request's worktree only for the project's own pull requests", () => {
    const repository = projectRepositoryKey({
      canonicalKey: "github.com/saka-gg/ryco",
      locator: {
        source: "git-remote",
        remoteName: "upstream",
        remoteUrl: "git@github.com:saka-gg/ryco.git",
      },
      remotes: [{ name: "origin", url: "https://github.com/me/ryco.git" }],
    });
    const options = buildTaskWhereOptions({
      title: TITLE,
      links: [
        { kind: "pr", number: 1234, url: "https://github.com/vercel/next.js/pull/1234" },
        { kind: "pr", number: 746, url: "https://github.com/Saka-GG/ryco/pull/746/files" },
        // A fork's #9 is not the #9 the checkout's pull requests resolve to.
        { kind: "pr", number: 9, url: "https://github.com/me/ryco/pull/9" },
        pr(12),
      ],
      projectRepository: repository,
      startBranches: [],
      linkedWorktrees: true,
    });
    expect(options.map((option) => option.id)).toEqual(["pr:746", "pr:12", "worktree", "project"]);
    // Without the project's repository known, a URL can't be told apart.
    expect(
      where([{ kind: "pr", number: 746, url: "https://github.com/saka-gg/ryco/pull/746" }]).map(
        (option) => option.id,
      ),
    ).toEqual(["worktree", "project"]);
    expect(changeRequestRepositoryKey("https://gitlab.com/a/b/c/-/merge_requests/3")).toBe(
      "gitlab.com/a/b/c",
    );
    expect(changeRequestRepositoryKey("https://example.com/spec")).toBeNull();
  });

  it("leaves linked places out when the node can't check them out", () => {
    expect(
      where([pr(746), branch("feature/x")], { linkedWorktrees: false }).map((o) => o.id),
    ).toEqual(["worktree", "project"]);
  });

  it("numbers the next worktree once the task has a worktree chat", () => {
    const options = buildTaskWhereOptions({
      title: TITLE,
      links: [],
      startBranches: ["task/fix-login-redirect-loop"],
      linkedWorktrees: true,
    });
    expect(options[0]?.hintRef).toBe("task/fix-login-redirect-loop-2");
  });

  it("keeps the first branch name when earlier chats ran without a new worktree", () => {
    const options = buildTaskWhereOptions({
      title: TITLE,
      links: [],
      startBranches: [],
      linkedWorktrees: true,
    });
    expect(options[0]?.hintRef).toBe("task/fix-login-redirect-loop");
  });
});

describe("task where option ids", () => {
  it("round-trips every place", () => {
    for (const place of [
      { kind: "pr", number: 746 },
      { kind: "branch", name: "feature/a:b" },
      { kind: "worktree" },
      { kind: "project" },
    ] as const) {
      expect(parseTaskWhereOptionId(taskWhereOptionId(place))).toEqual(place);
    }
  });

  it("rejects ids no option has", () => {
    expect(parseTaskWhereOptionId("pr:abc")).toBeNull();
    expect(parseTaskWhereOptionId("pr:0")).toBeNull();
    expect(parseTaskWhereOptionId("branch:")).toBeNull();
    expect(parseTaskWhereOptionId("elsewhere")).toBeNull();
  });

  it("resolves the default, or the option picked", () => {
    const options = where([pr(746)]);
    expect(resolveTaskStartPlace(options, undefined)).toEqual({ kind: "pr", number: 746 });
    expect(resolveTaskStartPlace(options, "project")).toEqual({ kind: "project" });
    expect(resolveTaskStartPlace(options, "pr:999")).toBeNull();
    expect(resolveTaskStartPlace([], undefined)).toBeNull();
  });
});

describe("taskWorktreeBranch", () => {
  it("moves past branches that exist and ones the task already asked for", () => {
    expect(
      taskWorktreeBranch({
        title: TITLE,
        startBranches: [],
        existingRefNames: ["task/fix-login-redirect-loop"],
      }),
    ).toBe("task/fix-login-redirect-loop-2");
    expect(
      taskWorktreeBranch({
        title: TITLE,
        startBranches: ["task/fix-login-redirect-loop"],
        existingRefNames: ["task/fix-login-redirect-loop-2"],
      }),
    ).toBe("task/fix-login-redirect-loop-3");
  });

  it("reads remote refs as their local names", () => {
    expect(
      localRefNames([
        { name: "main" },
        { name: "origin/task/x", isRemote: true, remoteName: "origin" },
        { name: "upstream/task/y", isRemote: true, remoteName: "upstream" },
      ]),
    ).toEqual(["main", "task/x", "task/y"]);
  });
});

const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5-5",
  options: [],
};

describe("resolveTaskStartDefaults", () => {
  const config = (initialModelSelection: ModelSelection | null) =>
    ({
      settings: { ...DEFAULT_SERVER_SETTINGS, initialModelSelection, defaultAgentTokenMode: "off" },
    }) as unknown as ServerConfig;

  it("takes the project's model, like a new thread's draft", () => {
    const effective = {
      initialModelSelection: { value: MODEL, source: "project" },
    } as unknown as EffectiveProjectPreferences;
    expect(resolveTaskStartDefaults({ config: config(null), effective })).toEqual({
      modelSelection: MODEL,
      tokenMode: "off",
    });
  });

  it("falls back to the node's model, and to nothing without one", () => {
    expect(resolveTaskStartDefaults({ config: config(MODEL), effective: null })).toEqual({
      modelSelection: MODEL,
      tokenMode: "off",
    });
    expect(resolveTaskStartDefaults({ config: config(null), effective: null })).toBeNull();
  });
});

describe("source control contexts", () => {
  it("attaches each linked pull request and issue once, up to the message's limit", () => {
    const links = [
      pr(1),
      issue(1),
      pr(1),
      branch("x"),
      ...Array.from({ length: 12 }, (_, i) => issue(i + 10)),
    ];
    const picked = taskSourceControlLinks(links);
    expect(picked.slice(0, 3)).toEqual([
      { kind: "change-request", number: 1, reference: "1" },
      { kind: "issue", number: 1, reference: "1" },
      { kind: "issue", number: 10, reference: "10" },
    ]);
    expect(picked).toHaveLength(PROVIDER_SEND_TURN_MAX_SOURCE_CONTROL_CONTEXTS);
  });

  it("reads a linked item by its URL, so another repository's #N is that one", () => {
    const url = "https://github.com/vercel/next.js/pull/1234";
    expect(taskSourceControlLinks([{ kind: "pr", number: 1234, url }])).toEqual([
      { kind: "change-request", number: 1234, reference: url },
    ]);
  });

  it("builds the context the composer would attach", () => {
    const detail = { provider: "github", number: 746 } as SourceControlChangeRequestDetail;
    const context = taskSourceControlContext({
      id: "ctx-1",
      kind: "change-request",
      detail,
      nowMs: Date.UTC(2026, 9, 18),
    });
    expect(context).toMatchObject({
      id: "ctx-1",
      kind: "change-request",
      provider: "github",
      reference: "github#746",
      detail,
    });
    expect(context.staleAfter.epochMilliseconds - context.fetchedAt.epochMilliseconds).toBe(
      5 * 60 * 1000,
    );
  });
});

describe("buildTaskTurnStartCommand", () => {
  const threadId = ThreadId.make("thread-new");
  const messageId = MessageId.make("message-1");
  const linked = ThreadId.make("thread-linked");

  it("starts unattended in full access with the prompt's chats as references", () => {
    const text = `${TITLE}\n\nLinked:\n- @${formatThreadMentionPath(linked)} (Old chat)`;
    const command = buildTaskTurnStartCommand({
      commandId: taskStartCommandId("task-1", messageId),
      threadId,
      messageId,
      text,
      title: TITLE,
      modelSelection: MODEL,
      tokenMode: "off",
      bootstrap: { requireWorktree: true },
      sourceControlContexts: [],
      createdAt: "2026-10-18T10:00:00.000Z",
    });
    expect(command).toEqual({
      type: "thread.turn.start",
      commandId: CommandId.make("task-start:task-1:message-1"),
      threadId,
      message: { messageId, role: "user", text, attachments: [] },
      modelSelection: MODEL,
      titleSeed: "Fix the login redirect loop on hosted Hub",
      runtimeMode: "full-access",
      interactionMode: "default",
      tokenMode: "off",
      bootstrap: { requireWorktree: true },
      threadReferences: [linked],
      createdAt: "2026-10-18T10:00:00.000Z",
    });
  });

  it("leaves out an absent bootstrap and empty lists", () => {
    const command = buildTaskTurnStartCommand({
      commandId: taskStartCommandId("task-1", messageId),
      threadId,
      messageId,
      text: "Just a title",
      title: "Just a title",
      modelSelection: MODEL,
      tokenMode: "off",
      bootstrap: undefined,
      sourceControlContexts: [],
      createdAt: "2026-10-18T10:00:00.000Z",
    });
    expect(command).not.toHaveProperty("bootstrap");
    expect(command).not.toHaveProperty("threadReferences");
    expect(command).not.toHaveProperty("sourceControlContexts");
  });
});

describe("taskStartedMessage", () => {
  it("says where the chat runs", () => {
    expect(taskStartedMessage({ kind: "worktree" }, "task/x")).toBe(
      "Chat started in worktree task/x · it keeps running in the background",
    );
    expect(taskStartedMessage({ kind: "project" }, null)).toBe(
      "Chat started in the project folder · it keeps running in the background",
    );
    expect(taskStartedMessage({ kind: "pr", number: 746 }, null)).toBe(
      "Chat started in the PR #746 worktree · it keeps running in the background",
    );
    expect(taskStartedMessage({ kind: "branch", name: "feature/x" }, null)).toBe(
      "Chat started in a worktree from feature/x · it keeps running in the background",
    );
  });
});

describe("taskStartCommandId", () => {
  it("is stable for one start", () => {
    const messageId = MessageId.make("m");
    expect(taskStartCommandId("t", messageId)).toBe(taskStartCommandId("t", messageId));
    expect(String(taskStartCommandId("t", messageId))).toBe("task-start:t:m");
  });
});
