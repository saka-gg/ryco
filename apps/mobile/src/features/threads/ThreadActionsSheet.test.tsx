import type { ReactElement } from "react";
import {
  EnvironmentId,
  ThreadId,
  WorktreeId,
  type SourceControlSetPullRequestWatchInput,
  type SourceControlSetPullRequestWatchResult,
  type ThreadPullRequestWatchShell,
  type ThreadPullRequestWatchSummary,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// The sheet invoked as a plain function with react-native mocked (no React renderer exists in
// this suite), hooks answering their first render: what it proves is the pull request watch
// section's wiring. The switch, Resume and Stop watching send the watch RPC through the
// environment's API; the section shows each state and stays out of the way without a watch.

const api = vi.hoisted(() => ({
  setPullRequestWatch: undefined as
    | ((
        input: SourceControlSetPullRequestWatchInput,
      ) => Promise<SourceControlSetPullRequestWatchResult>)
    | undefined,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: () => undefined,
    useState: (initial: unknown) => [
      typeof initial === "function" ? (initial as () => unknown)() : initial,
      () => undefined,
    ],
  };
});
vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/DeviceIcon", () => ({ DeviceIcon: "DeviceIcon" }));
vi.mock("../../components/ErrorBanner", () => ({ ErrorBanner: "ErrorBanner" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#888888" }));
vi.mock("../../connection/environmentApi", () => ({
  readEnvironmentApi: () =>
    api.setPullRequestWatch === undefined
      ? undefined
      : { sourceControl: { setPullRequestWatch: api.setPullRequestWatch } },
}));

import { PullRequestWatchSection, ThreadActionsSheet } from "./ThreadActionsSheet";
import { buildThreadHeaderModel, type ThreadHeaderModel } from "./threadHeaderModel";

const environmentId = EnvironmentId.make("env-sheet");
const threadId = ThreadId.make("thread-sheet");
const URL_42 = "https://github.com/o/r/pull/42";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const children = element.props.children;
  return [element, ...(Array.isArray(children) ? children : [children]).flatMap(elements)];
}

function texts(nodes: ReadonlyArray<ReactElement<Record<string, unknown>>>): string[] {
  return nodes
    .filter((element) => element.type === "Text")
    .map((element) => {
      const children = element.props.children;
      return (Array.isArray(children) ? children : [children]).join("");
    });
}

function watchSummary(
  overrides: Partial<ThreadPullRequestWatchSummary> = {},
): ThreadPullRequestWatchSummary {
  return {
    watchId: "github.com/o/r#42",
    number: 42,
    url: URL_42,
    worktreeId: WorktreeId.make("worktree-sheet"),
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

function headerModel(input: {
  readonly watches?: ThreadPullRequestWatchShell;
  readonly prState?: "open" | "merged";
  readonly available?: boolean;
}): ThreadHeaderModel {
  return buildThreadHeaderModel({
    thread: {
      title: "Fix CI",
      archivedAt: null,
      latestTurn: null,
      session: null,
      activities: [],
      turnDiffSummaries: [],
      branch: "feat/ci",
      worktreePath: "/repo/.worktrees/ci",
      worktreeId: "worktree-sheet",
    },
    project: { name: "Ryco", cwd: "/repo", kind: "project" },
    worktree: {
      title: null,
      branch: "feat/ci",
      worktreePath: "/repo/.worktrees/ci",
      prNumber: 42,
      prState: input.prState ?? "open",
      prIsDraft: false,
      issueNumber: null,
      issueState: null,
      workItemKey: null,
      workItemState: null,
      workItemStateName: null,
      pullRequests: [
        {
          number: 42,
          title: "Fix CI",
          url: URL_42,
          state: input.prState ?? "open",
          isDraft: false,
          terminalAt: null,
          headRefName: "feat/ci",
          baseRefName: "main",
          source: "discovered",
          linkedAt: null,
          dismissedAt: null,
        },
      ],
    },
    nodeLabel: "Studio",
    hasPendingApproval: false,
    hasPendingUserInput: false,
    pullRequestWatch: { available: input.available ?? true, watches: input.watches },
  });
}

function render(model: ThreadHeaderModel, mutationReady = true) {
  const sheet = ThreadActionsSheet({
    visible: true,
    model,
    environmentId,
    threadId,
    mutationReady,
    busy: false,
    error: null,
    onClose: () => undefined,
    onRename: () => undefined,
    onStop: () => undefined,
    onToggleSettlement: () => undefined,
    onToggleArchive: () => undefined,
    onReview: () => undefined,
    onCompact: () => undefined,
  });
  const section = elements(sheet).find((element) => element.type === PullRequestWatchSection);
  if (!section) return null;
  const body = PullRequestWatchSection(
    section.props as Parameters<typeof PullRequestWatchSection>[0],
  );
  if (body === null) return null;
  const nodes = elements(body);
  const rows = nodes.filter((element) => typeof element.type === "function");
  return {
    texts: texts(nodes),
    switch: nodes.find((element) => element.type === "Switch") ?? null,
    row: (label: string) => rows.find((element) => element.props.label === label) ?? null,
  };
}

type Element = ReactElement<Record<string, unknown>>;

function toggle(element: Element | null | undefined, on: boolean) {
  if (!element) throw new Error("switch missing");
  (element.props.onValueChange as (value: boolean) => void)(on);
}

function press(element: Element | null | undefined) {
  if (!element) throw new Error("row missing");
  (element.props.onPress as () => void)();
}

function recordRequests() {
  const sent: SourceControlSetPullRequestWatchInput[] = [];
  api.setPullRequestWatch = async (input) => {
    sent.push(input);
    return { watch: null, now: "" };
  };
  return sent;
}

describe("thread actions sheet pull request watch", () => {
  it("turns Auto-fix CI on for the task's pull request", () => {
    const sent = recordRequests();
    const view = render(headerModel({}));
    expect(view?.texts).toEqual([
      "Pull request #42",
      "Auto-fix CI",
      "Starts a fix turn in this task when checks fail. Never merges.",
    ]);
    expect(view?.switch?.props).toMatchObject({ value: false, disabled: false });
    expect(view?.row("Stop watching")).toBeNull();

    toggle(view?.switch, true);
    expect(sent).toEqual([{ threadId, number: 42, url: URL_42, autoFix: true }]);
  });

  it("shows a fix in progress and stops watching on request", () => {
    const sent = recordRequests();
    const view = render(
      headerModel({
        watches: {
          active: [
            watchSummary({
              autoFix: { status: "fixing", pauseReason: null, attempts: 2, maxAttempts: 3 },
            }),
          ],
          ended: [],
        },
      }),
    );
    expect(view?.texts).toEqual([
      "Pull request #42",
      "Auto-fix CI",
      "Fixing CI · attempt 2 of 3",
      "Waiting for the fix to be pushed",
    ]);
    expect(view?.switch?.props.value).toBe(true);
    expect(view?.row("Resume Auto-fix CI")).toBeNull();

    press(view?.row("Stop watching"));
    expect(sent).toEqual([{ threadId, number: 42, url: URL_42, news: false, autoFix: false }]);
  });

  it("offers Resume while Auto-fix CI is paused and turns it off from the switch", () => {
    const sent = recordRequests();
    const view = render(
      headerModel({
        watches: {
          active: [
            watchSummary({
              autoFix: { status: "paused", pauseReason: "no-push", attempts: 1, maxAttempts: 3 },
            }),
          ],
          ended: [],
        },
      }),
    );
    expect(view?.texts).toContain("Auto-fix paused: the fix turn ended without a push");

    press(view?.row("Resume Auto-fix CI"));
    toggle(view?.switch, false);
    expect(sent).toEqual([
      { threadId, number: 42, url: URL_42, autoFix: true },
      { threadId, number: 42, url: URL_42, autoFix: false },
    ]);
  });

  it("watches another workspace's pull request without offering Auto-fix CI for it", () => {
    const sent = recordRequests();
    const view = render(
      headerModel({
        watches: {
          active: [
            watchSummary({
              watchId: "github.com/o/r#77",
              number: 77,
              url: "https://github.com/o/r/pull/77",
              worktreeId: WorktreeId.make("worktree-child"),
              news: true,
              autoFix: null,
              startedBy: "agent",
            }),
          ],
          ended: [],
        },
      }),
    );
    expect(view?.texts).toEqual([
      "Pull request #77",
      "Watching · wakes the agent on failures, reviews and conflicts",
      "Auto-fix CI runs in the task whose workspace has this pull request.",
    ]);
    expect(view?.switch).toBeNull();
    press(view?.row("Stop watching"));
    expect(sent).toEqual([
      {
        threadId,
        number: 77,
        url: "https://github.com/o/r/pull/77",
        news: false,
        autoFix: false,
      },
    ]);
  });

  it("keeps the controls inert until the node takes changes", () => {
    const sent = recordRequests();
    const view = render(headerModel({}), false);
    expect(view?.switch?.props.disabled).toBe(true);
    expect(view?.texts).toContain("This node can't take changes right now.");
    toggle(view?.switch, true);
    expect(sent).toEqual([]);
    // Without a switch (another workspace's pull request) Stop watching is inert too, and says why.
    const elsewhere = render(
      headerModel({
        watches: {
          active: [
            watchSummary({
              watchId: "github.com/o/r#77",
              number: 77,
              url: "https://github.com/o/r/pull/77",
              worktreeId: WorktreeId.make("worktree-child"),
              news: true,
              autoFix: null,
            }),
          ],
          ended: [],
        },
      }),
      false,
    );
    expect(elsewhere?.switch).toBeNull();
    expect(elsewhere?.texts).toContain("This node can't take changes right now.");
    expect(elsewhere?.row("Stop watching")?.props.disabled).toBe(true);
    press(elsewhere?.row("Stop watching"));
    expect(sent).toEqual([]);
  });

  it("only says why the watch of a merged pull request ended", () => {
    const view = render(
      headerModel({
        prState: "merged",
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
      }),
    );
    expect(view?.texts).toEqual(["Pull request #42", "Stopped watching: merged"]);
    expect(view?.switch).toBeNull();
    // Merged without a watch: nothing at all.
    expect(render(headerModel({ prState: "merged" }))).toBeNull();
  });

  it("is absent on a node without pull request watches", () => {
    expect(render(headerModel({ available: false }))).toBeNull();
  });
});

describe("task sheet pull request row", () => {
  function sheetRows(onOpenPullRequest?: () => void) {
    const sheet = ThreadActionsSheet({
      visible: true,
      model: headerModel({}),
      environmentId,
      threadId,
      mutationReady: true,
      busy: false,
      error: null,
      onClose: () => undefined,
      onRename: () => undefined,
      onStop: () => undefined,
      onToggleSettlement: () => undefined,
      onToggleArchive: () => undefined,
      onReview: () => undefined,
      onCompact: () => undefined,
      onOpenPullRequest,
    });
    return elements(sheet).filter((element) => typeof element.props.label === "string");
  }

  it("opens the worktree's pull request on the phone", () => {
    const opened: string[] = [];
    const row = sheetRows(() => opened.push("open")).find(
      (element) => element.props.label === "Open pull request #42",
    );
    press(row);
    expect(opened).toEqual(["open"]);
  });

  it("is absent without a project to read it through", () => {
    expect(sheetRows().some((element) => element.props.label === "Open pull request #42")).toBe(
      false,
    );
  });
});
