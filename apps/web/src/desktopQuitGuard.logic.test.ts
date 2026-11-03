import type {
  ArchivedThreadStub,
  SidebarThreadOrStub,
  SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  buildDesktopQuitRunningChatsReport,
  createDesktopQuitGuardResponder,
  DESKTOP_QUIT_LISTED_CHATS,
} from "./desktopQuitGuard.logic";

const LOCAL = EnvironmentId.make("env-local");
const REMOTE = EnvironmentId.make("env-remote");

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: LOCAL,
    projectId: ProjectId.make("project-1"),
    title: `Title ${id}`,
    interactionMode: "default",
    session: null,
    createdAt: "2026-10-04T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function stub(id: string): ArchivedThreadStub {
  return {
    shellDetail: "archived-stub",
    id: ThreadId.make(id),
    environmentId: LOCAL,
    projectId: ProjectId.make("project-1"),
    title: `Archived ${id}`,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    archivedAt: "2026-10-05T00:00:00.000Z",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    latestUserMessageAt: null,
    lineage: null,
  };
}

function session(status: "running" | "connecting" | "ready") {
  return {
    provider: "codex",
    status,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    orchestrationStatus: status === "ready" ? "ready" : "running",
  } as unknown as NonNullable<SidebarThreadSummary["session"]>;
}

function runningTurn(requestedAt: string): NonNullable<SidebarThreadSummary["latestTurn"]> {
  return {
    turnId: TurnId.make(`turn-${requestedAt}`),
    state: "running",
    requestedAt,
    startedAt: requestedAt,
    completedAt: null,
    assistantMessageId: null,
  };
}

function report(
  threads: ReadonlyArray<SidebarThreadOrStub>,
  overrides: Partial<Parameters<typeof buildDesktopQuitRunningChatsReport>[0]> = {},
) {
  return buildDesktopQuitRunningChatsReport({
    threads,
    localEnvironmentId: LOCAL,
    localEnvironmentLive: true,
    continueThreadsAfterRestart: false,
    ...overrides,
  });
}

describe("buildDesktopQuitRunningChatsReport", () => {
  it("cannot know before the local environment is known and live", () => {
    const threads = [thread("a", { session: session("running") })];
    expect(report(threads, { localEnvironmentId: null })).toEqual({ status: "unknown" });
    // Rows from the cache, or held over a reconnect, show nothing running.
    expect(report(threads, { localEnvironmentLive: false })).toEqual({ status: "unknown" });
  });

  it("lists local working, approval, input and connecting chats", () => {
    const result = report([
      thread("working", { session: session("running") }),
      thread("approval", { hasPendingApprovals: true }),
      thread("input", { hasPendingUserInput: true }),
      thread("connecting", { session: session("connecting") }),
      thread("background", { backgroundLiveness: "working" }),
    ]);
    expect(result).toMatchObject({ status: "known", runningCount: 5, resumableCount: 2 });
    expect(result.status === "known" && result.chats).toEqual(
      expect.arrayContaining([
        { threadId: "working", title: "Title working", status: "working" },
        { threadId: "approval", title: "Title approval", status: "approval" },
        { threadId: "input", title: "Title input", status: "input" },
        { threadId: "connecting", title: "Title connecting", status: "connecting" },
        { threadId: "background", title: "Title background", status: "working" },
      ]),
    );
  });

  it("leaves out idle, monitoring, plan-ready, archived and stub chats", () => {
    const settledTurn = {
      ...runningTurn("2026-10-04T01:00:00.000Z"),
      state: "completed" as const,
      completedAt: "2026-10-04T01:05:00.000Z",
    };
    const result = report([
      thread("idle", { session: session("ready") }),
      thread("monitoring", { backgroundLiveness: "monitoring" }),
      thread("plan", {
        interactionMode: "plan",
        latestTurn: settledTurn,
        hasActionableProposedPlan: true,
      }),
      thread("archived", { archivedAt: "2026-10-05T00:00:00.000Z", session: session("running") }),
      stub("stub"),
    ]);
    expect(result).toEqual({
      status: "known",
      runningCount: 0,
      resumableCount: 0,
      chats: [],
      otherNodesRunningCount: 0,
      continueThreadsAfterRestart: false,
    });
  });

  it("counts running chats on other nodes without listing them", () => {
    const result = report([
      thread("remote-1", { environmentId: REMOTE, session: session("running") }),
      thread("remote-2", { environmentId: REMOTE, hasPendingApprovals: true }),
      thread("remote-idle", { environmentId: REMOTE }),
      thread("local", { session: session("running") }),
    ]);
    expect(result).toMatchObject({ runningCount: 1, otherNodesRunningCount: 2 });
    expect(result.status === "known" && result.chats.map((chat) => chat.threadId)).toEqual([
      "local",
    ]);
  });

  it("orders by when the work started, newest first, then by id", () => {
    const result = report([
      thread("old", { latestTurn: runningTurn("2026-10-04T01:00:00.000Z") }),
      thread("b-new", { latestTurn: runningTurn("2026-10-04T03:00:00.000Z") }),
      thread("a-new", { latestTurn: runningTurn("2026-10-04T03:00:00.000Z") }),
      thread("by-message", {
        hasPendingUserInput: true,
        latestUserMessageAt: "2026-10-04T02:00:00.000Z",
      }),
      thread("by-created", { hasPendingApprovals: true }),
    ]);
    expect(result.status === "known" && result.chats.map((chat) => chat.threadId)).toEqual([
      "a-new",
      "b-new",
      "by-message",
      "old",
      "by-created",
    ]);
  });

  it("lists at most 8 chats and counts them all", () => {
    const threads = Array.from({ length: 11 }, (_, index) =>
      thread(`t-${String(index).padStart(2, "0")}`, {
        latestTurn: runningTurn(`2026-10-04T${String(index).padStart(2, "0")}:00:00.000Z`),
      }),
    );
    const result = report(threads);
    expect(result).toMatchObject({ runningCount: 11, resumableCount: 11 });
    expect(result.status === "known" && result.chats).toHaveLength(DESKTOP_QUIT_LISTED_CHATS);
    expect(result.status === "known" && result.chats[0]?.threadId).toBe("t-10");
  });

  it("passes the setting through, unknown included", () => {
    const threads = [thread("a", { session: session("running") })];
    expect(report(threads, { continueThreadsAfterRestart: true })).toMatchObject({
      continueThreadsAfterRestart: true,
    });
    expect(report(threads, { continueThreadsAfterRestart: null })).toMatchObject({
      continueThreadsAfterRestart: null,
    });
  });

  it("passes raw titles through; Desktop main sanitizes them", () => {
    const result = report([thread("a", { title: "two\nlines", session: session("running") })]);
    expect(result.status === "known" && result.chats[0]?.title).toBe("two\nlines");
  });
});

describe("createDesktopQuitGuardResponder", () => {
  it("reads the stores each time it is asked", () => {
    let threads: SidebarThreadOrStub[] = [];
    let live = false;
    let setting: boolean | null = null;
    const responder = createDesktopQuitGuardResponder({
      readThreads: () => threads,
      readLocalEnvironment: () => ({ id: LOCAL, live }),
      readContinueSetting: () => setting,
      writeContinueSetting: () => Promise.resolve(),
    });
    expect(responder.runningChats()).toEqual({ status: "unknown" });
    threads = [thread("a", { session: session("running") })];
    live = true;
    setting = true;
    expect(responder.runningChats()).toMatchObject({
      status: "known",
      runningCount: 1,
      continueThreadsAfterRestart: true,
    });
  });

  it("awaits the setting write and passes its failure on", async () => {
    const writes: boolean[] = [];
    let fail = false;
    const responder = createDesktopQuitGuardResponder({
      readThreads: () => [],
      readLocalEnvironment: () => ({ id: LOCAL, live: true }),
      readContinueSetting: () => false,
      writeContinueSetting: async (enabled) => {
        writes.push(enabled);
        if (fail) throw new Error("node offline");
      },
    });
    await expect(responder.setContinueAfterRestart(true)).resolves.toBeUndefined();
    fail = true;
    await expect(responder.setContinueAfterRestart(true)).rejects.toThrow("node offline");
    expect(writes).toEqual([true, true]);
  });
});
