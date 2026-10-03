import "~/index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

// No router by default (as before); the hand-off test installs one to follow "Open".
const routerMock = vi.hoisted(() => ({
  current: undefined as { navigate: (options: unknown) => Promise<void> } | undefined,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => routerMock.current,
}));

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import type { EnvironmentApi } from "@ryco/contracts";

import { toastManager } from "~/components/ui/toast";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "~/environmentApi";
import { FactsPanel } from "~/components/pullRequests/rail/FactsPanel";
import { NextActionButton } from "~/components/pullRequests/rail/NextActionButton";
import { usePullRequestRailStore } from "~/components/pullRequests/rail/railStore";
import { StackChip } from "~/components/pullRequests/rail/StackChip";
import {
  FIXTURE_703_FAILING_JOB,
  FIXTURE_703_THREADS,
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  fixtureActivity,
  fixtureRepositoryOption,
  pullRequestFixtureStore,
  pullRequestsTestNavLog,
  resetPullRequestsTestState,
  sourceControlRpcMock,
} from "~/components/pullRequests/testing/PullRequestsTestProvider";

const toasts: Array<{
  title: unknown;
  type?: string | undefined;
  action?: unknown;
  onAction?: (() => void) | undefined;
}> = [];

beforeEach(async () => {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(1100, 800);
  toasts.length = 0;
  vi.spyOn(toastManager, "add").mockImplementation((options) => {
    const onClick = options.actionProps?.onClick as (() => void) | undefined;
    toasts.push({
      title: options.title,
      type: options.type,
      action: options.actionProps?.children,
      onAction: onClick,
    });
    return "toast";
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPullRequestsTestState();
  __resetEnvironmentApiOverridesForTests();
  routerMock.current = undefined;
  // The merge method is a persisted habit; every test starts from the repository default.
  window.localStorage.removeItem("ryco:pull-requests-merge-method:v1");
  usePullRequestRailStore.setState({
    stackExpanded: {},
    mergeMethod: {},
    deleteBranch: {},
    pickerRequest: null,
  });
});

function renderRail(selected: number, layout: "rail" | "band" = "rail") {
  return render(
    <PullRequestsTestProvider selected={selected} width={1100} height={800}>
      <div className="flex min-h-0 flex-1 justify-end p-6">
        <FactsPanel layout={layout} />
      </div>
    </PullRequestsTestProvider>,
  );
}

function renderBar(selected: number) {
  return render(
    <PullRequestsTestProvider
      selected={selected}
      width={1100}
      height={600}
      search={{ tab: "files" }}
    >
      <div className="flex h-[52px] items-center justify-end gap-1.5 px-3">
        <StackChip />
        <NextActionButton size="sm" />
      </div>
    </PullRequestsTestProvider>,
  );
}

describe("merge section", () => {
  it("turns each status line into the jump it describes", async () => {
    const screen = await renderRail(703);
    await expect
      .element(screen.getByRole("region", { name: "Merge status" }).getByText("Blocked"))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Test · web/ }));
    expect(pullRequestsTestNavLog.callsTo("revealJob").at(-1)?.args).toEqual([
      FIXTURE_703_FAILING_JOB.jobId,
    ]);
    await userEvent.click(screen.getByRole("button", { name: /2 unresolved/ }));
    expect(pullRequestsTestNavLog.callsTo("revealThread").at(-1)?.args).toEqual([
      FIXTURE_703_THREADS.draftWalk,
    ]);
    // The branch line has nowhere to go, so it is not a button.
    await expect.element(screen.getByText("Branch up to date")).toBeVisible();
    expect(screen.getByRole("button", { name: /Branch up to date/ }).elements()).toHaveLength(0);
  });

  it("asks for a second click before merging, then merges with the head it showed", async () => {
    const screen = await renderRail(701);
    const button = screen.getByRole("button", { name: "Squash and merge" });
    await userEvent.click(button);
    await expect
      .element(screen.getByRole("button", { name: "Confirm squash and merge" }))
      .toBeVisible();
    expect(sourceControlRpcMock.callsTo("useMergeChangeRequestMutation")).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Confirm squash and merge" }));
    await expect.element(screen.getByText("Merged")).toBeVisible();
    expect(sourceControlRpcMock.callsTo("useMergeChangeRequestMutation")).toEqual([
      expect.objectContaining({
        args: {
          mergeMethod: "squash",
          deleteBranch: true,
          expectedHeadSha: fixtureActivity(701).headSha,
        },
      }),
    ]);
  });

  it("lets the confirmation lapse after four seconds", async () => {
    const screen = await renderRail(701);
    await userEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    await expect
      .element(screen.getByRole("button", { name: "Confirm squash and merge" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Squash and merge" }), { timeout: 6000 })
      .toBeVisible();
    expect(sourceControlRpcMock.callsTo("useMergeChangeRequestMutation")).toEqual([]);
  });

  it("picks the merge method from the menu, with reasons on disabled methods", async () => {
    const screen = await renderRail(701);
    await userEvent.click(screen.getByRole("button", { name: "More merge options" }));
    const disabled = page.getByRole("menuitemradio", { name: /Create a merge commit/ });
    await expect.element(disabled).toHaveAttribute("aria-disabled", "true");
    await expect.element(page.getByText("Not allowed in this repository")).toBeVisible();
    // The menu never repeats the button: no "Squash and merge" action item, only the method.
    expect(page.getByRole("menuitem", { name: /Squash and merge/ }).elements()).toHaveLength(0);

    await userEvent.click(page.getByRole("menuitemradio", { name: /Rebase and merge/ }));
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("button", { name: "Rebase and merge" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Rebase and merge" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm rebase and merge" }));
    await expect.element(screen.getByText("Merged")).toBeVisible();
    expect(sourceControlRpcMock.callsTo("useMergeChangeRequestMutation")[0]?.args).toMatchObject({
      mergeMethod: "rebase",
    });
  });

  it("opens the menu with M", async () => {
    const screen = await renderBar(701);
    await expect.element(screen.getByRole("button", { name: "Squash and merge" })).toBeVisible();
    await userEvent.keyboard("m");
    await expect.element(page.getByRole("menuitem", { name: /Convert to draft/ })).toBeVisible();
  });

  it("says when new commits beat the merge, and when it was queued", async () => {
    sourceControlRpcMock.mutationOverrides.useMergeChangeRequestMutation = () =>
      Promise.reject(new Error("Head branch was modified. Review and try the merge again."));
    const screen = await renderRail(701);
    await userEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm squash and merge" }));
    await vi.waitFor(() =>
      expect(toasts.map((toast) => toast.title)).toContain("New commits were pushed"),
    );

    sourceControlRpcMock.mutationOverrides.useMergeChangeRequestMutation = () =>
      Promise.resolve({ outcome: "enqueued" });
    await userEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm squash and merge" }));
    await vi.waitFor(() => expect(toasts.map((toast) => toast.title)).toContain("Queued to merge"));
  });

  it("marks a draft ready from the button and closes only after confirming", async () => {
    const screen = await renderRail(704);
    await userEvent.click(screen.getByRole("button", { name: "Mark ready for review" }));
    expect(sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation").at(-1)?.args).toEqual({
      kind: "set-draft",
      draft: false,
    });

    await userEvent.click(screen.getByRole("button", { name: "More merge options" }));
    await userEvent.click(page.getByRole("menuitem", { name: /Close pull request/ }));
    await expect.element(page.getByText("Close #704 without merging?")).toBeVisible();
    expect(
      sourceControlRpcMock
        .callsTo("useUpdateChangeRequestMutation")
        .some((call) => (call.args as { kind: string }).kind === "close"),
    ).toBe(false);
    await userEvent.click(page.getByRole("button", { name: "Close pull request" }));
    await vi.waitFor(() =>
      expect(sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation").at(-1)?.args).toEqual({
        kind: "close",
      }),
    );
  });
});

describe("merging past a step the host does not require", () => {
  it("merges from the menu past an optional failing check, still behind the confirmation", async () => {
    pullRequestFixtureStore.updateDetail(688, (detail) => ({
      ...detail,
      mergeStateStatus: "unstable",
    }));
    const screen = await renderRail(688);
    await expect.element(screen.getByText("Ready to merge")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "View failing check" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "More merge options" }));
    await userEvent.click(page.getByRole("menuitem", { name: /Squash and merge/ }));
    await expect
      .element(screen.getByRole("button", { name: "Confirm squash and merge" }))
      .toBeVisible();
    expect(sourceControlRpcMock.callsTo("useMergeChangeRequestMutation")).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Confirm squash and merge" }));
    await vi.waitFor(() =>
      expect(sourceControlRpcMock.callsTo("useMergeChangeRequestMutation")).toEqual([
        expect.objectContaining({
          args: expect.objectContaining({
            mergeMethod: "squash",
            expectedHeadSha: fixtureActivity(688).headSha,
          }),
        }),
      ]),
    );
  });

  it("lands a stack layer through the stack picker while optional checks run", async () => {
    pullRequestFixtureStore.updateDetail(702, (detail) => ({
      ...detail,
      mergeStateStatus: "unstable",
      reviewDecision: "approved",
    }));
    const screen = await renderRail(702);
    await userEvent.click(screen.getByRole("button", { name: "Merge stack (2)" }));
    // The picker names every layer that lands; nothing merges behind a one-PR label.
    await expect.element(page.getByText("Merge into main")).toBeVisible();
    expect(sourceControlRpcMock.callsTo("useMergeChangeRequestMutation")).toEqual([]);
  });
});

describe("agent hand-offs", () => {
  it("starts the thread in place and says so, without leaving the page", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const worktrees: Array<unknown> = [];
    const modelSelection = { instanceId: "codex", model: "gpt-5-codex", options: [] };
    __setEnvironmentApiOverrideForTests(FIXTURE_ENVIRONMENT_ID, {
      git: {
        createWorktreeForProject: async (input: unknown) => {
          worktrees.push(input);
          return { worktreeId: "worktree-703", sessionId: "thread-703-fix" };
        },
      },
      orchestration: {
        dispatchCommand: async (command: Record<string, unknown>) => {
          commands.push(command);
          return { sequence: commands.length };
        },
      },
      server: {
        getConfig: async () => ({
          environment: { capabilities: { projectPreferences: true } },
          settings: { defaultAgentTokenMode: "off" },
        }),
        getProjectPreferences: async () => ({ initialModelSelection: { value: modelSelection } }),
      },
    } as unknown as EnvironmentApi);
    const navigate = vi.fn(async (_options: unknown) => undefined);
    routerMock.current = { navigate };

    const screen = await renderRail(703);
    const checks = screen.getByRole("listitem").filter({ hasText: "Test · web" });
    await userEvent.hover(checks);
    await userEvent.click(checks.getByRole("button", { name: "Fix" }));

    await vi.waitFor(() =>
      expect(toasts).toContainEqual(
        expect.objectContaining({ title: "Started", type: "success", action: "Open" }),
      ),
    );
    expect(worktrees).toEqual([
      { projectId: fixtureRepositoryOption.projectId, intent: { kind: "pr", number: 703 } },
    ]);
    expect(commands.find((command) => command.type === "thread.turn.start")).toMatchObject({
      threadId: "thread-703-fix",
      modelSelection,
      message: { text: expect.stringContaining("failing on pull request #703") },
      sourceControlContexts: [expect.objectContaining({ reference: "github#703" })],
    });
    // Still on the pull request: nothing navigated until "Open".
    expect(pullRequestsTestNavLog.calls).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    toasts.find((toast) => toast.title === "Started")?.onAction?.();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/$environmentId/$threadId",
          params: expect.objectContaining({ threadId: "thread-703-fix" }),
        }),
      ),
    );
  });
});

describe("stack", () => {
  it("pushes to a layer from the bar's stack popover", async () => {
    const screen = await renderBar(703);
    await userEvent.click(screen.getByRole("button", { name: /Stack #14, layer 3 of 4/ }));
    await userEvent.click(page.getByRole("button", { name: /#701/ }));
    expect(pullRequestsTestNavLog.callsTo("selectPullRequest").at(-1)?.args).toEqual([
      701,
      { via: "stack", push: true },
    ]);
  });

  it("expands in the rail with S and offers merge-through on landable layers", async () => {
    const screen = await renderRail(703);
    await expect.element(screen.getByText("#701 can land")).toBeVisible();
    await userEvent.keyboard("s");
    const row = screen.getByRole("listitem").filter({ hasText: "#701" });
    await userEvent.hover(row);
    await userEvent.click(row.getByRole("button", { name: "Merge through" }));
    await expect.element(page.getByText("Merge into main")).toBeVisible();
    // #702 is blocked, so nothing above it can be picked.
    await expect
      .element(page.getByRole("radio", { name: "Merge through #703" }))
      .toHaveAttribute("data-disabled");
    await userEvent.click(page.getByRole("button", { name: "Merge 1 pull request" }));
    await vi.waitFor(() =>
      expect(sourceControlRpcMock.callsTo("useMergeChangeRequestMutation")).toEqual([
        expect.objectContaining({
          target: expect.objectContaining({ reference: "701" }),
          args: expect.objectContaining({ mergeMethod: "squash" }),
        }),
      ]),
    );
    expect(pullRequestFixtureStore.detail(701)?.state).toBe("merged");
  });
});

describe("stack facts, once each", () => {
  it("leaves the band's popover header to screen readers: the trigger already says it", async () => {
    const screen = await renderRail(703, "band");
    await expect.element(screen.getByText("3 of 4")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Stack #14/ }));
    await expect.element(page.getByRole("list", { name: "Stack #14" })).toBeVisible();
    expect(page.getByText("3 of 4").elements()).toHaveLength(1);
  });

  it("adds the stack and its foot under the bar chip, not the position again", async () => {
    const screen = await renderBar(703);
    await userEvent.click(screen.getByRole("button", { name: /Stack #14, layer 3 of 4/ }));
    await expect.element(page.getByText("#701 can land")).toBeVisible();
    expect(page.getByText("3 of 4").elements()).toHaveLength(0);
  });

  it("hands a layer's state word over to its ghost one after the other", async () => {
    const screen = await renderRail(703);
    await userEvent.keyboard("s");
    const row = screen.getByRole("listitem").filter({ hasText: "#701" });
    const word = row.getByText("Ready").element();
    const ghost = row.getByRole("button", { name: "Merge through" }).element();
    // At rest the word comes back only after the ghost has gone.
    expect(getComputedStyle(word).transitionDelay).toBe("0.12s");
    expect(getComputedStyle(ghost).transitionDelay).toBe("0s");

    (row.getByRole("button", { name: /#701/ }).element() as HTMLElement).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(ghost);
    // Keyboard focus: the word leaves first, the ghost arrives a chip later.
    await vi.waitFor(() => {
      expect(getComputedStyle(word).opacity).toBe("0");
      expect(getComputedStyle(ghost).opacity).toBe("1");
    });
    expect(getComputedStyle(word).transitionDelay).toBe("0s");
    expect(getComputedStyle(ghost).transitionDelay).toBe("0.12s");
  });
});

describe("people", () => {
  it("applies one reviewer edit when the picker closes", async () => {
    const screen = await renderRail(703);
    await userEvent.click(screen.getByRole("combobox", { name: "Edit reviewers" }));
    await userEvent.click(page.getByRole("option", { name: /tkessler/ }));
    await userEvent.click(page.getByRole("option", { name: /priyar/ }));
    expect(sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation")).toEqual([]);
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation")).toEqual([
        expect.objectContaining({
          args: { kind: "reviewers", add: ["tkessler", "priyar"], remove: [] },
        }),
      ]),
    );
  });

  it("removes a label, and rolls back with a toast when the host refuses", async () => {
    sourceControlRpcMock.mutationOverrides.useUpdateChangeRequestMutation = () =>
      Promise.reject(new Error("Label is protected"));
    const screen = await renderRail(703);
    await userEvent.click(screen.getByRole("combobox", { name: "Edit labels" }));
    await userEvent.click(page.getByRole("option", { name: /stacks/ }));
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation")[0]?.args).toEqual({
        kind: "labels",
        add: [],
        remove: ["stacks"],
      }),
    );
    await vi.waitFor(() =>
      expect(toasts.map((toast) => toast.title)).toContain("Couldn’t update labels"),
    );
  });

  it("sends nothing when a picker closes unchanged", async () => {
    const screen = await renderRail(703);
    await userEvent.click(screen.getByRole("combobox", { name: "Edit assignees" }));
    await expect.element(page.getByRole("option", { name: /mvogt/ })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation")).toEqual([]);
  });
});

describe("people in the band", () => {
  it("keeps empty fields editable, so Request review opens the reviewers picker", async () => {
    pullRequestFixtureStore.updateDetail(701, (detail) => ({
      ...detail,
      mergeStateStatus: "blocked",
      reviewDecision: "review_required",
      reviewers: [],
      reviewerStates: [],
      assignees: [],
      labels: [],
    }));
    const screen = await renderRail(701, "band");
    await userEvent.click(screen.getByRole("button", { name: "Request review" }));
    await expect.element(page.getByRole("option", { name: /tkessler/ })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await expect.element(screen.getByRole("button", { name: "Assign yourself" })).toBeVisible();
    await expect.element(screen.getByRole("combobox", { name: "Edit labels" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Assign yourself" }));
    await vi.waitFor(() =>
      expect(sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation").at(-1)?.args).toEqual({
        kind: "assignees",
        add: [fixtureActivity(701).viewer!.login],
        remove: [],
      }),
    );
  });
});
