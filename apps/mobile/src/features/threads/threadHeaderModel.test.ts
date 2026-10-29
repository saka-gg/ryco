import type { Project, SidebarWorktreeSummary, Thread } from "@ryco/client-runtime/state/threads";
import {
  WorktreeId,
  type EnvironmentId,
  type ProjectId,
  type ThreadPullRequestWatchShell,
  type ThreadPullRequestWatchSummary,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadHeaderModel, findThreadWorktree } from "./threadHeaderModel";

const ENVIRONMENT_ID = "node-a" as EnvironmentId;
const PROJECT_ID = "project-a" as ProjectId;

function thread(
  overrides: Partial<
    Pick<
      Thread,
      | "title"
      | "archivedAt"
      | "latestTurn"
      | "session"
      | "activities"
      | "turnDiffSummaries"
      | "branch"
      | "worktreePath"
      | "settledOverride"
      | "worktreeId"
    >
  > = {},
) {
  return {
    title: "Fix mobile navigation",
    archivedAt: null,
    latestTurn: null,
    session: null,
    activities: [],
    turnDiffSummaries: [],
    branch: "feat/mobile",
    worktreePath: "/repo/.worktrees/mobile",
    ...overrides,
  } as Pick<
    Thread,
    | "title"
    | "archivedAt"
    | "latestTurn"
    | "session"
    | "activities"
    | "turnDiffSummaries"
    | "branch"
    | "worktreePath"
    | "settledOverride"
    | "worktreeId"
  >;
}

describe("buildThreadHeaderModel", () => {
  it("makes the node, project, and worktree hierarchy explicit", () => {
    const model = buildThreadHeaderModel({
      thread: thread(),
      project: { name: "Ryco" } as Project,
      worktree: { title: "Mobile redesign", branch: "feat/mobile" } as SidebarWorktreeSummary,
      nodeLabel: "Mac Studio",
      hasPendingApproval: false,
      hasPendingUserInput: false,
    });

    expect(model).toMatchObject({
      title: "Fix mobile navigation",
      nodeLabel: "Mac Studio",
      projectLabel: "Ryco",
      worktreeLabel: "Mobile redesign",
      statusLabel: "Ready",
      reviewVisible: false,
      moreActions: ["rename", "archive", "details"],
    });
    expect(model.contextAccessibilityLabel).toContain(
      "node Mac Studio, project Ryco, worktree Mobile redesign",
    );
  });

  it("labels a chat thread No project in its plain chat folder, never by folder or branch", () => {
    const model = buildThreadHeaderModel({
      thread: thread({ branch: null, worktreePath: null }),
      project: {
        name: "Fix the login bug",
        cwd: "/Users/me/.ryco/chats/2026-10-07-fix-the-login-bug-1a2b3c4d",
        kind: "chat",
      },
      worktree: null,
      nodeLabel: "Mac Studio",
      hasPendingApproval: false,
      hasPendingUserInput: false,
    });

    expect(model).toMatchObject({
      projectLabel: "No project",
      worktreeLabel: "Chat folder",
      contextHeading: "Project · Folder",
      statusLabel: "Ready",
      // The chat folder is browsable like any workspace.
      filesVisible: true,
      moreActions: ["rename", "archive", "details"],
    });
    expect(model.contextAccessibilityLabel).toBe(
      "Working in node Mac Studio, No project, in a chat folder. Ready.",
    );
  });

  it("prioritizes attention states and exposes stop/review while a turn is running", () => {
    const model = buildThreadHeaderModel({
      thread: thread({
        latestTurn: { state: "running" } as Thread["latestTurn"],
        turnDiffSummaries: [{ files: [{ path: "app.ts" }] } as never],
      }),
      project: { name: "Ryco" } as Project,
      worktree: null,
      nodeLabel: "MacBook",
      hasPendingApproval: true,
      hasPendingUserInput: false,
    });

    expect(model.statusLabel).toBe("Needs approval");
    expect(model.reviewVisible).toBe(true);
    expect(model.moreActions).toEqual(["rename", "stop", "archive", "details"]);
  });

  it("offers unarchive and falls back to understandable context names", () => {
    const model = buildThreadHeaderModel({
      thread: thread({
        title: " ",
        archivedAt: "2026-07-26T00:00:00.000Z",
        branch: null,
        worktreePath: "/repo/.worktrees/recovery",
      }),
      project: null,
      worktree: null,
      nodeLabel: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
    });

    expect(model).toMatchObject({
      title: "Untitled task",
      nodeLabel: "Node",
      projectLabel: "Project",
      worktreeLabel: "recovery",
      statusLabel: "Archived",
      moreActions: ["rename", "unarchive", "details"],
    });
  });

  it("reports a cache-provenance thread as offline however busy its snapshot looks", () => {
    // A snapshot captured mid-turn keeps `latestTurn.state === "running"`
    // forever. Without this gate the detail header renders "Running" with no
    // connection behind it, directly contradicting the inbox row for the same
    // thread, which the stale-environment rule already forces to offline.
    const model = buildThreadHeaderModel({
      thread: thread({
        latestTurn: { state: "running" } as Thread["latestTurn"],
      }),
      project: { name: "Ryco" } as Project,
      worktree: null,
      nodeLabel: "MacBook",
      hasPendingApproval: true,
      hasPendingUserInput: false,
      forcedOffline: true,
    });

    expect(model.statusLabel).toBe("Offline");
    // The status is spoken, not only coloured, so a screen reader user is not
    // the last to learn the thread is not live.
    expect(model.contextAccessibilityLabel).toContain("Offline.");
  });

  it("presents settle and unsettle independently from archive", () => {
    const base = {
      thread: thread(),
      project: { name: "Ryco", cwd: "/repo" },
      worktree: null,
      nodeLabel: "Studio",
      hasPendingApproval: false,
      hasPendingUserInput: false,
    } as const;
    const active = buildThreadHeaderModel({
      ...base,
      settlement: {
        attentionState: "active",
        canSettle: true,
        settlementBlocker: null,
        mutationEnabled: true,
        mutationBlocker: null,
      },
    });
    expect(active.settlementAction).toMatchObject({
      kind: "settle",
      label: "Settle task",
      disabled: false,
    });

    const settled = buildThreadHeaderModel({
      ...base,
      settlement: {
        attentionState: "settled",
        canSettle: true,
        settlementBlocker: null,
        mutationEnabled: true,
        mutationBlocker: null,
      },
    });
    expect(settled.settlementAction?.kind).toBe("unsettle");
  });

  it("points an unconfirmed delivery at its notice rather than at reconnecting", () => {
    const model = buildThreadHeaderModel({
      thread: thread(),
      project: { name: "Ryco", cwd: "/repo" },
      worktree: null,
      nodeLabel: "Studio",
      hasPendingApproval: false,
      hasPendingUserInput: false,
      settlement: {
        attentionState: "active",
        canSettle: false,
        settlementBlocker: "delivery-unknown",
        mutationEnabled: true,
        mutationBlocker: null,
      },
    });
    expect(model.settlementAction).toMatchObject({
      disabled: true,
      detail: "Check the unconfirmed action on this machine first.",
    });
  });
});

describe("findThreadWorktree", () => {
  const worktrees = [
    {
      id: "worktree-a" as WorktreeId,
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      branch: "feat/mobile",
      worktreePath: "/repo/.worktrees/mobile",
    } as SidebarWorktreeSummary,
  ];

  it("matches by id, then path, then branch within the same node and project", () => {
    expect(
      findThreadWorktree(
        {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          worktreeId: "worktree-a",
          worktreePath: null,
          branch: null,
        } as Pick<Thread, "environmentId" | "projectId" | "worktreeId" | "worktreePath" | "branch">,
        worktrees,
      )?.id,
    ).toBe("worktree-a");

    expect(
      findThreadWorktree(
        {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          worktreeId: null,
          worktreePath: null,
          branch: "feat/mobile",
        } as Pick<Thread, "environmentId" | "projectId" | "worktreeId" | "worktreePath" | "branch">,
        worktrees,
      )?.id,
    ).toBe("worktree-a");
  });
});

describe("thread header change-request badge", () => {
  it("carries the worktree's pull request onto the header model", () => {
    // threadHeaderModel narrowed its worktree Pick to title|branch, dropping
    // every PR field before a consumer could see it. This pins the widening.
    const model = buildThreadHeaderModel({
      thread: thread(),
      project: { name: "Ryco", cwd: "/repo" },
      worktree: {
        title: "Mobile redesign",
        branch: "feat/mobile",
        worktreePath: "/repo/.worktrees/mobile",
        prNumber: 42,
        prState: "merged",
        prIsDraft: false,
        issueNumber: null,
        issueState: null,
        workItemKey: null,
        workItemState: null,
        workItemStateName: null,
      },
      nodeLabel: "Studio",
      hasPendingApproval: false,
      hasPendingUserInput: false,
    });
    expect(model.changeRequest?.label).toBe("#42");
    expect(model.changeRequest?.tone).toBe("merged");
    expect(model.changeRequest?.accessibilityLabel).toContain("Last known state.");
  });

  it("leaves the badge null when there is no worktree at all", () => {
    const model = buildThreadHeaderModel({
      thread: thread(),
      project: { name: "Ryco", cwd: "/repo" },
      worktree: null,
      nodeLabel: "Studio",
      hasPendingApproval: false,
      hasPendingUserInput: false,
    });
    expect(model.changeRequest).toBeNull();
  });
});

describe("thread header files action", () => {
  function headerModel(
    project: { readonly name: string; readonly cwd: string } | null,
    worktree: { readonly worktreePath: string | null } | null,
    worktreePath: string | null,
  ) {
    return buildThreadHeaderModel({
      thread: thread({ worktreePath }),
      project: project as Project | null,
      worktree:
        worktree === null
          ? null
          : ({ branch: "feat/mobile", ...worktree } as SidebarWorktreeSummary),
      nodeLabel: "Studio",
      hasPendingApproval: false,
      hasPendingUserInput: false,
    });
  }

  it("offers the browser whenever any link in the workspace-root chain resolves", () => {
    expect(headerModel(null, { worktreePath: "/repo/.worktrees/a" }, null).filesVisible).toBe(true);
    expect(headerModel(null, null, "/repo/.worktrees/b").filesVisible).toBe(true);
    // The project checkout is the fallback threads started outside a worktree
    // rely on.
    expect(headerModel({ name: "Ryco", cwd: "/repo" }, null, null).filesVisible).toBe(true);
  });

  it("withholds it when the node manages the worktree without exposing a path", () => {
    expect(headerModel(null, { worktreePath: null }, null).filesVisible).toBe(false);
  });
});

describe("thread header pull request watch", () => {
  const URL_42 = "https://github.com/o/r/pull/42";

  function watchSummary(
    overrides: Partial<ThreadPullRequestWatchSummary> = {},
  ): ThreadPullRequestWatchSummary {
    return {
      watchId: "github.com/o/r#42",
      number: 42,
      url: URL_42,
      worktreeId: WorktreeId.make("worktree-a"),
      startedAt: "2026-10-28T10:00:00.000Z",
      startedBy: "user",
      news: false,
      autoFix: { status: "watching", pauseReason: null, attempts: 0, maxAttempts: 3 },
      headSha: "abc1234",
      failingChecks: 0,
      passed: false,
      conflicting: false,
      delivering: false,
      lastChangeAt: null,
      ...overrides,
    };
  }

  function worktree(
    overrides: Partial<SidebarWorktreeSummary> = {},
  ): Parameters<typeof buildThreadHeaderModel>[0]["worktree"] {
    return {
      title: "Mobile redesign",
      branch: "feat/mobile",
      worktreePath: "/repo/.worktrees/mobile",
      prNumber: 42,
      prState: "open",
      prIsDraft: false,
      issueNumber: null,
      issueState: null,
      workItemKey: null,
      workItemState: null,
      workItemStateName: null,
      pullRequests: [
        {
          number: 42,
          title: "Mobile redesign",
          url: URL_42,
          state: "open",
          isDraft: false,
          terminalAt: null,
          headRefName: "feat/mobile",
          baseRefName: "main",
          source: "discovered",
          linkedAt: null,
          dismissedAt: null,
        },
      ],
      ...overrides,
    };
  }

  function headerWatch(input: {
    readonly watches?: ThreadPullRequestWatchShell | undefined;
    readonly available?: boolean;
    readonly worktree?: Parameters<typeof buildThreadHeaderModel>[0]["worktree"];
    readonly thread?: Parameters<typeof thread>[0];
  }) {
    return buildThreadHeaderModel({
      thread: thread(input.thread),
      project: { name: "Ryco", cwd: "/repo" },
      worktree: input.worktree === undefined ? worktree() : input.worktree,
      nodeLabel: "Studio",
      hasPendingApproval: false,
      hasPendingUserInput: false,
      pullRequestWatch: { available: input.available ?? true, watches: input.watches },
    }).pullRequestWatch;
  }

  it("offers Auto-fix CI for the workspace's open pull request, with no chip until a watch is on", () => {
    expect(headerWatch({})).toEqual({
      target: { number: 42, url: URL_42 },
      startable: true,
      otherWorkspace: false,
      watches: null,
      chip: null,
    });
  });

  it("shows nothing on a node without watches, or for a task without a pull request", () => {
    expect(headerWatch({ available: false })).toBeNull();
    expect(headerWatch({ worktree: null })).toBeNull();
    expect(headerWatch({ worktree: worktree({ prNumber: null, pullRequests: [] }) })).toBeNull();
    // A node whose config has not arrived yet says nothing either.
    expect(
      buildThreadHeaderModel({
        thread: thread(),
        project: { name: "Ryco", cwd: "/repo" },
        worktree: worktree(),
        nodeLabel: "Studio",
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }).pullRequestWatch,
    ).toBeNull();
  });

  it("puts a chip per watch state beside the badge, and speaks the whole status", () => {
    const chip = (summary: ThreadPullRequestWatchSummary) =>
      headerWatch({ watches: { active: [summary], ended: [] } })?.chip;
    expect(chip(watchSummary({ news: true, autoFix: null, startedBy: "agent" }))).toEqual({
      label: "Watching",
      tone: "muted",
      accessibilityLabel:
        "Pull request 42: Watching · wakes the agent on failures, reviews and conflicts.",
    });
    expect(chip(watchSummary())).toMatchObject({ label: "Auto-fix on", tone: "muted" });
    expect(
      chip(
        watchSummary({
          autoFix: { status: "fixing", pauseReason: null, attempts: 2, maxAttempts: 3 },
          delivering: true,
        }),
      ),
    ).toEqual({
      label: "Fixing 2/3",
      tone: "active",
      accessibilityLabel: "Pull request 42: Fixing CI · attempt 2 of 3. Starting the fix turn.",
    });
    expect(
      chip(
        watchSummary({
          autoFix: { status: "paused", pauseReason: "no-push", attempts: 1, maxAttempts: 3 },
        }),
      ),
    ).toMatchObject({ label: "Auto-fix paused", tone: "warning" });
  });

  it("speaks the watch through the context bar, and mutes it while the thread is cached", () => {
    const fixing = watchSummary({
      autoFix: { status: "fixing", pauseReason: null, attempts: 1, maxAttempts: 3 },
    });
    const model = (forcedOffline: boolean) =>
      buildThreadHeaderModel({
        thread: thread(),
        project: { name: "Ryco", cwd: "/repo" },
        worktree: worktree(),
        nodeLabel: "Studio",
        hasPendingApproval: false,
        hasPendingUserInput: false,
        forcedOffline,
        pullRequestWatch: { available: true, watches: { active: [fixing], ended: [] } },
      });
    // The bar is one button: a screen reader hears its label, not the chip inside it.
    expect(model(false).contextAccessibilityLabel).toBe(
      "Working in node Studio, project Ryco, worktree Mobile redesign. Ready. " +
        "Pull request 42: Fixing CI · attempt 1 of 3. Waiting for the fix to be pushed.",
    );
    expect(model(true).pullRequestWatch?.chip).toEqual({
      label: "Fixing 1/3",
      tone: "muted",
      accessibilityLabel:
        "Pull request 42: Fixing CI · attempt 1 of 3. Waiting for the fix to be pushed. Last known.",
    });
    expect(model(true).contextAccessibilityLabel).toContain("Offline. Pull request 42:");
    // No watch: the label stays as it was.
    expect(
      buildThreadHeaderModel({
        thread: thread(),
        project: { name: "Ryco", cwd: "/repo" },
        worktree: worktree(),
        nodeLabel: "Studio",
        hasPendingApproval: false,
        hasPendingUserInput: false,
        pullRequestWatch: { available: true, watches: undefined },
      }).contextAccessibilityLabel,
    ).toBe("Working in node Studio, project Ryco, worktree Mobile redesign. Ready.");
  });

  it("targets the pull request the task watches when its workspace's own is not watched", () => {
    // A delegating task watching a pull request its child opened in another workspace.
    const childs = watchSummary({
      watchId: "github.com/o/r#77",
      number: 77,
      url: "https://github.com/o/r/pull/77",
      worktreeId: WorktreeId.make("worktree-child"),
      news: true,
      autoFix: null,
    });
    const watches = { active: [childs], ended: [] };
    expect(headerWatch({ watches })).toMatchObject({
      target: { number: 77, url: "https://github.com/o/r/pull/77" },
      startable: true,
      // The task records no workspace of its own here: the server has the last word.
      otherWorkspace: false,
      // The badge beside the chip says #42: the chip names the pull request it watches.
      chip: { label: "#77 Watching" },
    });
    // Auto-fix CI runs only in the task's own checkout.
    expect(headerWatch({ watches, thread: { worktreeId: "worktree-a" } })?.otherWorkspace).toBe(
      true,
    );
    expect(
      headerWatch({
        watches: { active: [watchSummary()], ended: [] },
        thread: { worktreeId: "worktree-a" },
      })?.otherWorkspace,
    ).toBe(false);
    // Its own one wins once both are watched.
    expect(
      headerWatch({ watches: { active: [childs, watchSummary()], ended: [] } })?.target,
    ).toEqual({ number: 42, url: URL_42 });
  });

  it("starts no watch on a merged pull request or an archived or settled task", () => {
    const merged = headerWatch({
      worktree: worktree({ prState: "merged" }),
      watches: {
        active: [],
        ended: [
          {
            watchId: "github.com/o/r#42",
            number: 42,
            reason: "merged",
            endedAt: "2026-10-28T11:00:00.000Z",
          },
        ],
      },
    });
    expect(merged).toMatchObject({ target: { number: 42 }, startable: false, chip: null });
    expect(headerWatch({ thread: { settledOverride: "settled" } })?.startable).toBe(false);
    expect(headerWatch({ thread: { archivedAt: "2026-10-28T11:00:00.000Z" } })?.startable).toBe(
      false,
    );
    // Without links (an older node) the flat number still names it, URL unknown.
    expect(headerWatch({ worktree: worktree({ pullRequests: undefined }) })?.target).toEqual({
      number: 42,
      url: null,
    });
  });
});

describe("thread header compact action", () => {
  const readyClaude = {
    provider: "claudeAgent",
    orchestrationStatus: "ready",
    status: "ready",
    runtimeSessionId: "runtime-1",
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:00:00.000Z",
  } as NonNullable<Thread["session"]>;
  const usage = (compactsAutomatically: boolean) =>
    [
      {
        kind: "context-window.updated",
        payload: { usedTokens: 150_000, maxTokens: 200_000, compactsAutomatically },
      },
    ] as unknown as Thread["activities"];

  function compactAction(
    session: Partial<NonNullable<Thread["session"]>> | null,
    advertised = true,
  ) {
    return buildThreadHeaderModel({
      thread: thread({
        session: session === null ? null : { ...readyClaude, ...session },
        activities: usage(advertised),
      }),
      project: { name: "Ryco", cwd: "/repo" },
      worktree: null,
      nodeLabel: "Studio",
      hasPendingApproval: false,
      hasPendingUserInput: false,
    }).compactAction;
  }

  it("offers it on a ready, idle Claude session whose CLI lists /compact", () => {
    expect(compactAction({})).toEqual({
      label: "Compact conversation",
      detail: "Summarize older context. The summary request itself uses tokens.",
      disabled: false,
    });
  });

  it.each([
    [
      "a running turn",
      { orchestrationStatus: "running", activeTurnId: "turn-2" },
      "Wait until the current turn finishes and the session is ready.",
    ],
    // A pending approval or question keeps the turn active on a ready session.
    [
      "a turn waiting on the user",
      { activeTurnId: "turn-2" },
      "Wait until the current turn finishes and the session is ready.",
    ],
    [
      "a stopped session",
      { orchestrationStatus: "stopped" },
      "The session is stopped. Send a message to start it, then compact.",
    ],
    [
      "a session without a runtime",
      { runtimeSessionId: undefined },
      "No session is running yet. Send a message first, then compact.",
    ],
    // A failed turn leaves nothing running: waiting would never enable it.
    [
      "a session whose last turn failed",
      { orchestrationStatus: "error", status: "error", lastError: "Turn failed" },
      "The session is not ready. Send a message to resume it, then compact.",
    ],
  ] as const)("disables it with the reason for %s", (_name, session, detail) => {
    expect(compactAction(session as Partial<NonNullable<Thread["session"]>>)).toEqual({
      label: "Compact conversation",
      detail,
      disabled: true,
    });
  });

  it("withholds it from another provider's session, live or stopped", () => {
    // Codex reports compactsAutomatically too, but cannot be asked to compact yet.
    expect(compactAction({ provider: "codex" } as never)).toBeNull();
    expect(
      compactAction({ provider: "codex", orchestrationStatus: "stopped" } as never),
    ).toBeNull();
  });

  it("withholds it until the latest context usage says the CLI lists /compact", () => {
    expect(compactAction({}, false)).toBeNull();
    const model = buildThreadHeaderModel({
      thread: thread({ session: readyClaude, activities: [] }),
      project: null,
      worktree: null,
      nodeLabel: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
    });
    expect(model.compactAction).toBeNull();
  });
});
