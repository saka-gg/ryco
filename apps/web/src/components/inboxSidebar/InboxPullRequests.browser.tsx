import "../../index.css";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type SourceControlChangeRequestDetail,
  type VcsStatusResult,
} from "@ryco/contracts";
import { Option } from "effect";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { resetGitStatusStateForTests, watchGitStatus } from "../../lib/gitStatusState";
import { InboxSidebar, type InboxSidebarProps } from "./InboxSidebar";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const harness = vi.hoisted(() => ({
  detail: null as SourceControlChangeRequestDetail | null,
  query: vi.fn(),
  openExternal: vi.fn((_url: string, _failureTitle: string) => undefined),
}));
vi.mock("../../lib/openExternalLink", () => ({
  openExternalLink: (url: string, failureTitle: string) => harness.openExternal(url, failureTitle),
}));
vi.mock("../../rpc/useSourceControl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../rpc/useSourceControl")>()),
  useSourceControlChangeRequestDetail: (input: {
    environmentId: string;
    cwd: string | null;
    reference: string | null;
    enabled: boolean;
  }) => {
    harness.query(input);
    return {
      data: input.enabled && input.reference === "42" ? harness.detail : null,
      error: null,
      isLoading: false,
      isFetching: false,
    };
  },
}));

afterEach(() => {
  resetGitStatusStateForTests();
  harness.detail = null;
  harness.query.mockClear();
  harness.openExternal.mockClear();
});

it.each([null, "/repo/worktrees/feature"])(
  "shows live PRs and colored stack states without worktree metadata (%s)",
  async (worktreePath) => {
    await page.viewport(1280, 800);
    const environmentId = EnvironmentId.make("pr-machine");
    const projectId = ProjectId.make("pr-project");
    const cwd = worktreePath ?? "/repo/root";
    const status: VcsStatusResult = {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: {
        number: 42,
        title: "Live PR",
        url: "https://github.com/acme/ryco/pull/42",
        baseRef: "main",
        headRef: "feature",
        state: "open",
      },
    };
    let emit: (status: VcsStatusResult) => void = () => undefined;
    const unwatch = watchGitStatus(
      { environmentId, cwd },
      {
        refreshStatus: async () => status,
        onStatus: (_input, listener) => {
          emit = listener;
          listener(status);
          return () => undefined;
        },
      },
    );
    const props: InboxSidebarProps = {
      projects: [
        {
          id: projectId,
          environmentId,
          name: "Repo",
          cwd: "/repo/root",
          defaultModelSelection: null,
          scripts: [],
        },
      ],
      worktrees: [],
      threads: [
        {
          id: ThreadId.make("pr-thread"),
          environmentId,
          projectId,
          title: "PR thread",
          interactionMode: "default",
          session: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          archivedAt: null,
          latestTurn: null,
          branch: "feature",
          worktreePath,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ],
      environments: [
        {
          environmentId,
          label: "Machine",
          connectionState: "connected",
          stale: false,
          role: "viewer",
          trust: "verified",
          deliveryUnknown: false,
          threadSettlementSupported: true,
          mutationReady: false,
          shellCurrent: true,
        },
      ],
      deliveryUnknownThreadKeys: new Set(),
      localQueuedThreadKeys: new Set(),
      activeThreadKey: null,
      aiFocusEnabled: false,
      autoSettleAfterDays: null,
      pinnedThreadKeys: new Set(),
      onOpenThread: vi.fn(),
    };
    const host = document.createElement("div");
    host.style.width = "240px";
    document.body.append(host);
    const mounted = await render(
      <AppAtomRegistryProvider>
        <InboxSidebar {...props} />
      </AppAtomRegistryProvider>,
      { container: host },
    );
    try {
      await expect.element(page.getByLabelText("PR #42 · Open", { exact: true })).toBeVisible();
      await vi.waitFor(() =>
        expect(harness.query).toHaveBeenCalledWith({
          environmentId,
          cwd,
          reference: "42",
          enabled: true,
        }),
      );
      // Hovering the chip names that PR, and only that: the row card stays shut.
      await page.getByLabelText("PR #42 · Open", { exact: true }).hover();
      await vi.waitFor(() => {
        const hint = [...document.querySelectorAll('[data-slot="tooltip-popup"]')].find((popup) =>
          popup.textContent?.includes("Live PR"),
        );
        expect(hint?.textContent).toContain("PR #42 · Open");
        expect(hint?.textContent).toContain("Open on");
      });
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(document.querySelector('[data-testid="inbox-preview"]')).toBeNull();
      // Clicking it opens the pull request instead of the thread.
      await page.getByLabelText("PR #42 · Open", { exact: true }).click();
      expect(harness.openExternal).toHaveBeenCalledWith(
        "https://github.com/acme/ryco/pull/42",
        "Unable to open pull request link",
      );
      expect(props.onOpenThread).not.toHaveBeenCalled();
      harness.detail = {
        provider: "github",
        number: 42,
        title: "Live PR",
        url: status.pr!.url,
        baseRefName: "main",
        headRefName: "feature",
        state: "merged",
        isDraft: false,
        updatedAt: Option.none(),
        body: "",
        comments: [],
        truncated: false,
        stack: {
          number: 7,
          size: 4,
          position: 2,
          baseRefName: "main",
          entries: [41, 42, 43, 44].map((number, index) => ({
            number,
            position: index + 1,
            title: `PR ${number}`,
            url: `https://github.com/acme/ryco/pull/${number}`,
            headRefName: `stack/${number}`,
            baseRefName: "main",
            state: number === 41 ? "closed" : number === 42 ? "merged" : "open",
            isDraft: number === 43,
            mergeability: "mergeable",
          })),
        },
      };
      emit({ ...status, pr: { ...status.pr!, state: "merged" } });
      const row = host.querySelector<HTMLElement>('[data-testid="inbox-thread-row"]')!;
      // The row carries only its own change request and the stack position.
      await expect
        .element(page.getByLabelText("Stack #7, pull request 2 of 4", { exact: true }))
        .toBeVisible();
      await expect.element(page.getByLabelText("PR #42 · Merged", { exact: true })).toBeVisible();
      expect(row.querySelector('[aria-label="PR #42 · Merged"]')?.className).toContain(
        "text-violet-",
      );
      expect(row.querySelector('[aria-label="PR #41 · Closed"]')).toBeNull();
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      // The hover card lists the whole stack in its states' colors.
      await page.getByTestId("inbox-thread-row").hover();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="inbox-preview"]')).not.toBeNull(),
      );
      const card = document.querySelector<HTMLElement>('[data-testid="inbox-preview"]')!;
      for (const [number, state, color] of [
        [41, "Closed", "rose"],
        [42, "Merged", "violet"],
        [43, "Draft", "zinc"],
        [44, "Open", "emerald"],
      ] as const) {
        const label = `PR #${number} · ${state}`;
        await vi.waitFor(() =>
          expect(card.querySelector(`[aria-label="${label}"]`)?.className).toContain(
            `text-${color}-`,
          ),
        );
      }
    } finally {
      await mounted.unmount();
      host.remove();
      unwatch();
    }
  },
);
