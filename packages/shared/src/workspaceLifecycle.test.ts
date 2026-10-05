import { DEFAULT_LIFECYCLE_SUGGESTION_POLICY, DEFAULT_SERVER_SETTINGS } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyIgnoredPath,
  parseWorktreeStatus,
  planLifecycleSuggestions,
  resolveLifecycleSuggestionPolicy,
  threadPendingWork,
  type LifecycleThreadLike,
} from "./workspaceLifecycle.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe("ignored content classification", () => {
  it.each([
    "node_modules/",
    "packages/web/node_modules/",
    "dist/",
    ".turbo/",
    "target/",
    "src/__pycache__/",
    "app.tsbuildinfo",
    "module.pyc",
  ])("treats %s as a regenerable cache or build output", (entry) => {
    expect(classifyIgnoredPath(entry)).toBe("regenerable");
  });

  it.each([
    ".env",
    ".env.local",
    "secrets.json",
    "data/app.sqlite",
    "local.db",
    "id_rsa",
    "certs/server.pem",
    "outputs/",
    "notes.txt",
    "dist/.env",
    "../escape/",
  ])("protects %s: credentials, databases, outputs and unknown content", (entry) => {
    expect(classifyIgnoredPath(entry)).toBe("protected");
  });

  it("parses porcelain v1 -z output, including renames", () => {
    const output = [
      " M src/a.ts",
      "R  src/new.ts",
      "src/old.ts",
      "?? scratch.txt",
      "!! node_modules/",
      "!! .env",
      "",
    ].join("\0");
    expect(parseWorktreeStatus(output)).toEqual({
      modified: 2,
      untracked: 1,
      protectedIgnored: [".env"],
      regenerableIgnored: ["node_modules/"],
    });
    expect(parseWorktreeStatus("")).toEqual({
      modified: 0,
      untracked: 0,
      protectedIgnored: [],
      regenerableIgnored: [],
    });
  });
});

describe("lifecycle suggestion policy", () => {
  it("defaults to 30 inactive days and 7 archived days, with per-project overrides", () => {
    expect(DEFAULT_SERVER_SETTINGS.lifecycleSuggestions).toEqual({
      archiveInactiveThreadsDays: 30,
      removeArchivedCheckoutsDays: 7,
    });
    expect(DEFAULT_SERVER_SETTINGS.projectLifecycleSuggestions).toEqual({});
    const override = { archiveInactiveThreadsDays: null, removeArchivedCheckoutsDays: 14 };
    const settings = {
      lifecycleSuggestions: DEFAULT_LIFECYCLE_SUGGESTION_POLICY,
      projectLifecycleSuggestions: { p2: override },
    };
    expect(resolveLifecycleSuggestionPolicy(settings, "p1")).toEqual(
      DEFAULT_LIFECYCLE_SUGGESTION_POLICY,
    );
    expect(resolveLifecycleSuggestionPolicy(settings, "p2")).toEqual(override);
  });

  it("never auto-purges Trash: there is no purge setting at all", () => {
    expect(Object.keys(DEFAULT_SERVER_SETTINGS).some((key) => /purge|trash/i.test(key))).toBe(
      false,
    );
  });
});

const thread = (id: string, overrides: Partial<LifecycleThreadLike> = {}): LifecycleThreadLike => ({
  id,
  projectId: "p",
  title: id,
  createdAt: ago(60),
  updatedAt: ago(40),
  archivedAt: null,
  worktreeId: "w",
  worktreePath: "/repo-w",
  latestUserMessageAt: ago(40),
  session: null,
  latestTurn: null,
  ...overrides,
});

const plan = (threads: LifecycleThreadLike[], excluded: string[] = []) =>
  planLifecycleSuggestions({
    threads,
    worktrees: [
      {
        worktreeId: "w",
        projectId: "p",
        branch: "topic",
        worktreePath: "/repo-w",
        origin: "branch",
      },
      { worktreeId: "main", projectId: "p", branch: "main", worktreePath: null, origin: "main" },
    ],
    projectRoots: new Map([["p", "/repo"]]),
    policyFor: () => DEFAULT_LIFECYCLE_SUGGESTION_POLICY,
    excludedThreadIds: new Set(excluded),
    samePath: (a, b) => a === b,
    nowMs: NOW,
  });

describe("lifecycle suggestions", () => {
  it("suggests archiving after 30 inactive days only", () => {
    expect(plan([thread("old"), thread("recent", { updatedAt: ago(29) })]).threads).toEqual([
      { threadId: "old", projectId: "p", title: "old", lastActivityAt: ago(40) },
    ]);
  });

  it.each<[string, Partial<LifecycleThreadLike>]>([
    ["running session", { session: { status: "running", activeTurnId: "t" } }],
    ["settling turn", { latestTurn: { state: "running" } }],
    ["background work", { backgroundLiveness: "working" }],
    ["pending approval", { hasPendingApprovals: true }],
    ["pending question", { hasPendingUserInput: true }],
    ["proposed plan", { hasActionableProposedPlan: true }],
    ["unfinished goal", { goal: { status: "paused" } }],
    ["snoozed (deferred)", { snoozedUntil: new Date(NOW + DAY).toISOString() }],
    ["usage-limit resume", { usageLimit: { limitId: "l" } }],
    ["never used", { latestUserMessageAt: null }],
  ])("never suggests a thread with %s", (_label, overrides) => {
    expect(plan([thread("t", overrides)]).threads).toEqual([]);
  });

  it("excludes pinned threads and threads with live terminals", () => {
    expect(plan([thread("pinned")], ["pinned"]).threads).toEqual([]);
  });

  it("suggests removing a checkout 7 days after all its conversations were archived", () => {
    const archived = (id: string, days: number) => thread(id, { archivedAt: ago(days) });
    expect(plan([archived("a", 10), archived("b", 8)]).checkouts).toEqual([
      {
        worktreeId: "w",
        projectId: "p",
        title: "topic",
        branch: "topic",
        archivedSince: ago(8),
        conversations: 2,
      },
    ]);
    // The newest archive counts; one active conversation blocks the suggestion.
    expect(plan([archived("a", 10), archived("b", 6)]).checkouts).toEqual([]);
    expect(plan([archived("a", 10), thread("b")]).checkouts).toEqual([]);
    expect(plan([archived("a", 10)], ["a"]).checkouts).toEqual([]);
    // Never the main checkout, and never a workspace with no conversations.
    expect(plan([]).checkouts).toEqual([]);
  });

  it("reports pending work reasons for the confirmation and blockers", () => {
    expect(
      threadPendingWork(
        thread("t", { backgroundLiveness: "monitoring", hasPendingApprovals: true }),
        NOW,
      ),
    ).toEqual(["background work is still running", "an approval is pending"]);
  });
});
