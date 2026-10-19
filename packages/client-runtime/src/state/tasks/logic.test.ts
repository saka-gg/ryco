import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type LocalTaskDelegation,
  type LocalTaskLink,
  type OrchestrationLatestTurn,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { extractThreadReferences } from "../composer/threadMentions.ts";
import type { ThreadSession } from "../threads/types.ts";
import {
  buildTaskStartPrompt,
  countTasksNeedingUser,
  delegatedThreadSignature,
  hasTaskLink,
  listTaskChats,
  nextTaskBranchName,
  resolveLinkedChatStatus,
  resolveTaskChatStatus,
  sortDoneTasks,
  sortOpenTasks,
  taskBranchSlug,
  taskLinkKey,
  taskLiveStatus,
  taskProjectLocked,
  taskStartFailed,
} from "./logic.ts";
import type { LocalTaskOptimisticStart, LocalTaskThreadSummary } from "./types.ts";

const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const THREAD_C = ThreadId.make("thread-c");

function session(status: ThreadSession["status"]): ThreadSession {
  return {
    provider: ProviderDriverKind.make("codex"),
    status,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    orchestrationStatus: status === "running" ? "running" : "ready",
  };
}

function turn(state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make("turn-1"),
    state,
    requestedAt: "2026-10-18T00:00:00.000Z",
    startedAt: "2026-10-18T00:00:01.000Z",
    completedAt: state === "running" ? null : "2026-10-18T00:00:02.000Z",
    assistantMessageId: null,
  };
}

function summary(overrides: Partial<LocalTaskThreadSummary> = {}): LocalTaskThreadSummary {
  return {
    session: session("ready"),
    latestTurn: turn("completed"),
    interactionMode: "default",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    branch: "task/live-branch",
    ...overrides,
  };
}

function delegation(
  threadId: ThreadId,
  status: LocalTaskDelegation["status"],
  sequence = 1,
): LocalTaskDelegation {
  return {
    commandId: CommandId.make(`command-${threadId}`),
    threadId,
    messageId: MessageId.make(`message-${threadId}`),
    sequence,
    branch: sequence === 1 ? "task/first" : null,
    dispatched: true,
    status,
    error: status === "failed" ? "Interrupted by a restart." : null,
    createdAt: "2026-10-18T00:00:00.000Z",
  };
}

function start(threadId: ThreadId): LocalTaskOptimisticStart {
  return {
    commandId: CommandId.make(`optimistic-${threadId}`),
    threadId,
    status: "starting",
    branch: "task/optimistic",
    createdAt: "2026-10-18T00:01:00.000Z",
  };
}

const noSummaries = () => undefined;

describe("resolveTaskChatStatus", () => {
  it("falls back to the node's word without a live summary", () => {
    expect(resolveTaskChatStatus("running", undefined)).toBe("running");
    expect(resolveTaskChatStatus("unavailable", null)).toBe("unavailable");
  });

  it("maps the live activity onto the task's words", () => {
    expect(resolveTaskChatStatus("running", summary({ hasPendingApprovals: true }))).toBe(
      "needs-you",
    );
    expect(resolveTaskChatStatus("running", summary({ hasPendingUserInput: true }))).toBe(
      "needs-you",
    );
    expect(
      resolveTaskChatStatus(
        "review",
        summary({ interactionMode: "plan", hasActionableProposedPlan: true }),
      ),
    ).toBe("needs-you");
    expect(
      resolveTaskChatStatus(
        "starting",
        summary({ session: session("running"), latestTurn: turn("running") }),
      ),
    ).toBe("running");
    expect(resolveTaskChatStatus("review", summary({ backgroundLiveness: "monitoring" }))).toBe(
      "running",
    );
    expect(resolveTaskChatStatus("running", summary({ session: session("connecting") }))).toBe(
      "starting",
    );
  });

  it("reads a settled chat as failed, starting or review", () => {
    expect(resolveTaskChatStatus("failed", summary())).toBe("failed");
    expect(resolveTaskChatStatus("review", summary({ latestTurn: turn("error") }))).toBe("failed");
    expect(resolveTaskChatStatus("review", summary({ session: session("error") }))).toBe("failed");
    expect(resolveTaskChatStatus("starting", summary({ latestTurn: null }))).toBe("starting");
    expect(resolveTaskChatStatus("running", summary())).toBe("review");
    expect(resolveTaskChatStatus("running", summary({ latestTurn: turn("interrupted") }))).toBe(
      "review",
    );
  });

  it("lets a failed start go once the chat runs a turn of its own after it", () => {
    const failed = { ...delegation(THREAD_A, "failed"), createdAt: "2026-10-17T23:00:00.000Z" };
    const later = { ...turn("completed"), userMessageId: MessageId.make("follow-up") };
    expect(resolveTaskChatStatus("failed", summary({ latestTurn: later }), failed)).toBe("review");
    // The start's own turn, or one from before it, says nothing new.
    expect(
      resolveTaskChatStatus(
        "failed",
        summary({ latestTurn: { ...later, userMessageId: failed.messageId } }),
        failed,
      ),
    ).toBe("failed");
    expect(
      resolveTaskChatStatus(
        "failed",
        summary({ latestTurn: { ...later, requestedAt: "2026-10-17T22:00:00.000Z" } }),
        failed,
      ),
    ).toBe("failed");
    expect(resolveTaskChatStatus("failed", summary({ latestTurn: later }))).toBe("failed");
    const chats = listTaskChats({ delegations: [failed], links: [] }, () =>
      summary({ latestTurn: later }),
    );
    expect(chats[0]?.status).toBe("review");
  });
});

describe("taskStartFailed", () => {
  it("is true only for a start the node recorded as failed before it ran", () => {
    const failed = { ...delegation(THREAD_A, "failed"), dispatched: false };
    const ran = delegation(THREAD_B, "failed", 2);
    const task = { delegations: [failed, ran] };
    expect(taskStartFailed(task, failed.commandId)).toBe(true);
    expect(taskStartFailed(task, ran.commandId)).toBe(false);
    expect(taskStartFailed(task, CommandId.make("unknown"))).toBe(false);
  });
});

describe("taskProjectLocked", () => {
  const none = () => false;
  it("frees the project once no start can have a chat in it", () => {
    const failed = { ...delegation(THREAD_A, "failed"), dispatched: false };
    expect(taskProjectLocked({ delegations: [failed], links: [] }, none)).toBe(false);
    expect(
      taskProjectLocked({ delegations: [delegation(THREAD_A, "unavailable")], links: [] }, none),
    ).toBe(false);
    // A failed start whose chat exists still has it in the project.
    expect(taskProjectLocked({ delegations: [failed], links: [] }, () => true)).toBe(true);
    expect(
      taskProjectLocked({ delegations: [delegation(THREAD_A, "starting")], links: [] }, none),
    ).toBe(true);
    expect(
      taskProjectLocked({ delegations: [], optimisticStarts: [start(THREAD_B)], links: [] }, none),
    ).toBe(true);
  });
});

describe("taskLinkKey", () => {
  it("names what a link points at", () => {
    const links: LocalTaskLink[] = [{ kind: "pr", number: 7, url: "https://x.dev/pull/7" }];
    expect(hasTaskLink(links, { kind: "pr", number: 7 })).toBe(true);
    expect(hasTaskLink(links, { kind: "issue", number: 7 })).toBe(false);
    expect(taskLinkKey({ kind: "thread", threadId: THREAD_A })).toBe("thread:thread-a");
    expect(taskLinkKey({ kind: "workItem", provider: "jira", key: "A-1" })).toBe(
      "workItem:jira:A-1",
    );
  });
});

describe("resolveLinkedChatStatus", () => {
  it("reads an unseen linked chat as unavailable and one without turns as review", () => {
    expect(resolveLinkedChatStatus(undefined)).toBe("unavailable");
    expect(resolveLinkedChatStatus(summary({ latestTurn: null }))).toBe("review");
    expect(resolveLinkedChatStatus(summary({ hasPendingApprovals: true }))).toBe("needs-you");
  });
});

describe("listTaskChats", () => {
  it("lists starts, then unconfirmed starts, then linked chats it did not start", () => {
    const links: LocalTaskLink[] = [
      { kind: "thread", threadId: THREAD_A },
      { kind: "pr", number: 7 },
      { kind: "thread", threadId: THREAD_C },
    ];
    const chats = listTaskChats(
      {
        delegations: [delegation(THREAD_A, "running")],
        optimisticStarts: [start(THREAD_B)],
        links,
      },
      (threadId) => (threadId === THREAD_C ? summary({ hasPendingUserInput: true }) : undefined),
    );
    expect(chats).toEqual([
      {
        key: "command-thread-a",
        threadId: THREAD_A,
        status: "running",
        branch: "task/first",
        linked: false,
        optimistic: false,
        error: null,
        startFailed: false,
      },
      {
        key: "optimistic-thread-b",
        threadId: THREAD_B,
        status: "starting",
        branch: "task/optimistic",
        linked: false,
        optimistic: true,
        error: null,
        startFailed: false,
      },
      {
        key: "thread:thread-c",
        threadId: THREAD_C,
        status: "needs-you",
        branch: "task/live-branch",
        linked: true,
        optimistic: false,
        error: null,
        startFailed: false,
      },
    ]);
  });

  it("tells a start that failed from a chat that ran and then stopped on an error", () => {
    const neverRan = { ...delegation(THREAD_A, "failed"), dispatched: false };
    const ran = delegation(THREAD_B, "review", 2);
    const chats = listTaskChats({ delegations: [neverRan, ran], links: [] }, (threadId) =>
      threadId === THREAD_B ? summary({ latestTurn: turn("error") }) : undefined,
    );
    expect(chats.map((chat) => [chat.status, chat.startFailed])).toEqual([
      ["failed", true],
      ["failed", false],
    ]);
  });

  it("drops an unconfirmed start the node already lists and falls back to the thread's branch", () => {
    const known = delegation(THREAD_A, "review", 2);
    const chats = listTaskChats(
      {
        delegations: [known],
        optimisticStarts: [{ ...start(THREAD_A), commandId: known.commandId }],
        links: [],
      },
      () => summary(),
    );
    expect(chats).toHaveLength(1);
    expect(chats[0]?.branch).toBe("task/live-branch");
  });
});

describe("taskLiveStatus", () => {
  it("is null without a chat that is still there", () => {
    expect(taskLiveStatus({ delegations: [], links: [] }, noSummaries)).toBeNull();
    expect(
      taskLiveStatus(
        { delegations: [delegation(THREAD_A, "unavailable")], links: [] },
        noSummaries,
      ),
    ).toBeNull();
  });

  it("takes the most urgent chat, unconfirmed starts and linked chats included", () => {
    expect(
      taskLiveStatus(
        {
          delegations: [delegation(THREAD_A, "running"), delegation(THREAD_B, "review", 2)],
          links: [],
        },
        noSummaries,
      ),
    ).toBe("running");
    expect(
      taskLiveStatus(
        {
          delegations: [delegation(THREAD_A, "review")],
          optimisticStarts: [start(THREAD_B)],
          links: [],
        },
        noSummaries,
      ),
    ).toBe("starting");
    expect(
      taskLiveStatus(
        {
          delegations: [delegation(THREAD_A, "running")],
          links: [{ kind: "thread", threadId: THREAD_C }],
        },
        (threadId) => (threadId === THREAD_C ? summary({ hasPendingApprovals: true }) : undefined),
      ),
    ).toBe("needs-you");
  });
});

describe("countTasksNeedingUser", () => {
  it("counts open tasks with a chat waiting on the user", () => {
    const needsYou = (threadId: ThreadId) =>
      threadId === THREAD_A ? summary({ hasPendingUserInput: true }) : summary();
    const tasks = [
      { state: "todo" as const, delegations: [delegation(THREAD_A, "running")], links: [] },
      { state: "done" as const, delegations: [delegation(THREAD_A, "running")], links: [] },
      { state: "todo" as const, delegations: [delegation(THREAD_B, "needs-you")], links: [] },
    ];
    expect(countTasksNeedingUser(tasks, needsYou)).toBe(1);
    expect(countTasksNeedingUser(tasks, noSummaries)).toBe(1);
  });
});

describe("delegatedThreadSignature", () => {
  it("changes only when an open task's chat moves between states", () => {
    const tasks = [
      {
        state: "todo" as const,
        delegations: [delegation(THREAD_A, "running")],
        links: [{ kind: "thread" as const, threadId: THREAD_B }],
      },
      { state: "done" as const, delegations: [delegation(THREAD_C, "running")], links: [] },
    ];
    let working = true;
    const summaries = (threadId: ThreadId) =>
      threadId === THREAD_A && working
        ? summary({ session: session("running"), latestTurn: turn("running") })
        : threadId === THREAD_C
          ? summary({ latestTurn: turn(working ? "running" : "completed") })
          : summary();
    const before = delegatedThreadSignature(tasks, summaries);
    expect(before).toBe("thread-a:working:running,thread-b:idle:completed,");
    expect(delegatedThreadSignature(tasks, summaries)).toBe(before);
    working = false;
    expect(delegatedThreadSignature(tasks, summaries)).toBe(
      "thread-a:idle:completed,thread-b:idle:completed,",
    );
    expect(delegatedThreadSignature(tasks, noSummaries)).toBe("thread-a:-:-,thread-b:-:-,");
  });
});

describe("buildTaskStartPrompt", () => {
  it("writes the title, the notes and one bullet per link", () => {
    const prompt = buildTaskStartPrompt({
      title: "  Fix the login redirect loop ",
      notes: "Happens after the token expires.\n",
      links: [
        { kind: "pr", number: 746, url: "https://github.com/acme/app/pull/746" },
        { kind: "issue", number: 231 },
        {
          kind: "workItem",
          provider: "jira",
          key: "ABC-123",
          url: "https://acme.atlassian.net/browse/ABC-123",
        },
        { kind: "branch", name: "feature/x" },
        { kind: "thread", threadId: THREAD_A },
        { kind: "thread", threadId: THREAD_B },
        { kind: "url", url: "https://example.com/spec", label: "Spec" },
        { kind: "url", url: "https://example.com/raw" },
      ],
      describeThread: (threadId) => (threadId === THREAD_A ? "Auth\n refactor" : undefined),
    });
    expect(prompt).toBe(
      [
        "Fix the login redirect loop",
        "",
        "Happens after the token expires.",
        "",
        "Linked:",
        "- Pull request #746 https://github.com/acme/app/pull/746",
        "- Issue #231",
        "- Jira ABC-123 https://acme.atlassian.net/browse/ABC-123",
        "- Branch feature/x",
        "- @thread:thread-a (Auth refactor)",
        "- @thread:thread-b",
        "- Spec https://example.com/spec",
        "- https://example.com/raw",
      ].join("\n"),
    );
    // Linked chats travel as the composer's thread mentions.
    expect(extractThreadReferences(prompt)).toEqual([THREAD_A, THREAD_B]);
  });

  it("is just the title when there is nothing else", () => {
    expect(buildTaskStartPrompt({ title: "Ship it", notes: "  ", links: [] })).toBe("Ship it");
  });
});

describe("taskBranchSlug", () => {
  it("keeps the first four meaningful words", () => {
    expect(taskBranchSlug("Fix the login redirect loop when the token expires")).toBe(
      "fix-login-redirect-loop",
    );
    expect(taskBranchSlug("Upgrade Effect to 4.1 in the server")).toBe("upgrade-effect-4-1");
    expect(taskBranchSlug("Idea: dark mode for the sidebar")).toBe("dark-mode-sidebar");
  });

  it("falls back to task when no word is left", () => {
    expect(taskBranchSlug("The idea")).toBe("task");
    expect(taskBranchSlug("¿¡!?")).toBe("task");
  });
});

describe("nextTaskBranchName", () => {
  it("names the first chat's branch after the task, then numbers later ones", () => {
    expect(
      nextTaskBranchName({ slug: "fix-login", delegationCount: 0, existingRefNames: [] }),
    ).toBe("task/fix-login");
    expect(
      nextTaskBranchName({ slug: "fix-login", delegationCount: 1, existingRefNames: ["main"] }),
    ).toBe("task/fix-login-2");
    expect(
      nextTaskBranchName({ slug: "fix-login", delegationCount: 2, existingRefNames: [] }),
    ).toBe("task/fix-login-3");
  });

  it("moves on to the next free name when a ref already has it", () => {
    expect(
      nextTaskBranchName({
        slug: "fix-login",
        delegationCount: 0,
        existingRefNames: ["Task/Fix-Login"],
      }),
    ).toBe("task/fix-login-2");
    expect(
      nextTaskBranchName({
        slug: "fix-login",
        delegationCount: 1,
        existingRefNames: ["task/fix-login", "task/fix-login-2"],
      }),
    ).toBe("task/fix-login-3");
  });
});

describe("task sorting", () => {
  const task = (taskId: string, createdAt: string, updatedAt: string) => ({
    taskId,
    createdAt,
    updatedAt,
  });
  const older = task("a", "2026-10-01T00:00:00.000Z", "2026-10-03T00:00:00.000Z");
  const newer = task("b", "2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.000Z");
  const tie = task("c", "2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.000Z");

  it("lists open tasks newest first and completed ones most recently changed first", () => {
    expect(sortOpenTasks([older, newer, tie]).map((entry) => entry.taskId)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(sortDoneTasks([newer, older]).map((entry) => entry.taskId)).toEqual(["a", "b"]);
  });
});
