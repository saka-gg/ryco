import "../../index.css";

import { Schema } from "effect";
import { ServerProvider } from "@ryco/contracts";
import type { EnvironmentApi } from "@ryco/contracts";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorktreeId,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { PANE_DRAG_TYPE } from "../../chatPanes.logic";
import { readPaneDragSource } from "../../chatPanesStore";
import { InboxSidebar, type InboxSidebarProps } from "./InboxSidebar";

vi.mock("../../sidebarUndo", () => ({
  sidebarUndo: {
    dispatch: (target: { environmentId: EnvironmentId }, command: unknown) =>
      import("../../environmentApi").then(({ readEnvironmentApi }) =>
        readEnvironmentApi(target.environmentId)!.orchestration.dispatchCommand(command as never),
      ),
  },
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-hover-card");
const PROJECT_ID = ProjectId.make("project-hover-card");
const THREAD_ID = ThreadId.make("thread-hover-card");

describe("Inbox sidebar rendering and settlement", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    document.body.innerHTML = "";
  });

  it("renders Pinned above Recent and removes the section after unpinning", async () => {
    const props: InboxSidebarProps = {
      projects: [],
      worktrees: [],
      environments: [],
      threads: ["Pinned task", "Recent task"].map((title) => ({
        id: ThreadId.make(title),
        environmentId: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        title,
        interactionMode: "default",
        session: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        archivedAt: null,
        latestTurn: null,
        branch: null,
        worktreePath: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      })),
      deliveryUnknownThreadKeys: new Set(),
      localQueuedThreadKeys: new Set(),
      activeThreadKey: null,
      aiFocusEnabled: false,
      autoSettleAfterDays: null,
      pinnedThreadKeys: new Set([`${ENVIRONMENT_ID}:Pinned task`]),
      onOpenThread: vi.fn(),
    };
    const mounted = await render(<InboxSidebar {...props} />);
    try {
      const sections = () => [
        ...document.querySelectorAll('[data-testid="inbox-sidebar"] section'),
      ];
      expect(sections().map((section) => section.querySelector("h2")?.textContent)).toEqual([
        "Pinned",
        "Recent",
      ]);
      expect(sections()[0]?.textContent).toContain("Pinned task");
      expect(sections()[1]?.textContent).not.toContain("Pinned task");
      await mounted.rerender(<InboxSidebar {...props} pinnedThreadKeys={new Set()} />);
      expect(sections().map((section) => section.querySelector("h2")?.textContent)).toEqual([
        "Recent",
      ]);
      expect(document.querySelectorAll('[data-testid="inbox-thread-row"]')).toHaveLength(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("offers Add project from the empty state only while no project exists", async () => {
    const onAddProject = vi.fn();
    const props: InboxSidebarProps = {
      projects: [],
      worktrees: [],
      environments: [],
      threads: [],
      deliveryUnknownThreadKeys: new Set(),
      localQueuedThreadKeys: new Set(),
      activeThreadKey: null,
      aiFocusEnabled: false,
      autoSettleAfterDays: null,
      pinnedThreadKeys: new Set(),
      onOpenThread: vi.fn(),
      onAddProject,
    };
    const mounted = await render(<InboxSidebar {...props} />);
    try {
      await expect.element(page.getByText("No projects yet")).toBeInTheDocument();
      await page.getByRole("button", { name: "Add project" }).click();
      expect(onAddProject).toHaveBeenCalledTimes(1);

      // Adding is unavailable (e.g. a hosted role without projects.add): no dead button.
      await mounted.rerender(<InboxSidebar {...props} onAddProject={undefined} />);
      expect(document.querySelector('[data-testid="inbox-add-project-button"]')).toBeNull();

      await mounted.rerender(
        <InboxSidebar
          {...props}
          projects={[
            {
              id: PROJECT_ID,
              environmentId: ENVIRONMENT_ID,
              name: "Project",
              cwd: "/repo",
              defaultModelSelection: null,
              scripts: [],
            },
          ]}
        />,
      );
      await expect.element(page.getByText("No tasks yet")).toBeInTheDocument();
      expect(document.querySelector('[data-testid="inbox-add-project-button"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("drags a row into a split pane as its thread", async () => {
    const props: InboxSidebarProps = {
      projects: [],
      worktrees: [],
      environments: [],
      threads: [
        {
          id: THREAD_ID,
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          title: "Draggable task",
          interactionMode: "default",
          session: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          archivedAt: null,
          latestTurn: null,
          branch: null,
          worktreePath: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
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
    // Desktop only: the phone tier has no split panes to drop into.
    await page.viewport(1280, 800);
    const mounted = await render(<InboxSidebar {...props} />);
    try {
      const row = document.querySelector<HTMLElement>('[data-testid="inbox-thread-row"]')!;
      // The tier settles from a media-query event after the viewport change.
      await expect.poll(() => row.draggable).toBe(true);
      const transfer = new DataTransfer();
      row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
      expect(JSON.parse(transfer.getData(PANE_DRAG_TYPE))).toEqual({
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
      });
      // Split panes read the source during dragover; dragend clears it.
      expect(readPaneDragSource()).toEqual({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID });
      row.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
      expect(readPaneDragSource()).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("glides a finishing thread into Recent and morphs its glyph, but paints still on mount", async () => {
    const base = {
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      interactionMode: "default" as const,
      session: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      archivedAt: null,
      branch: "main",
      worktreePath: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    const turn = (state: "running" | "completed") => ({
      turnId: TurnId.make("turn-busy"),
      state,
      requestedAt: "2026-09-01T00:00:00.000Z",
      startedAt: "2026-09-01T00:00:01.000Z",
      completedAt: state === "completed" ? "2026-09-01T00:05:00.000Z" : null,
      assistantMessageId: null,
    });
    const threads = (busyState: "running" | "completed") => [
      { ...base, id: ThreadId.make("busy"), title: "Busy task", latestTurn: turn(busyState) },
      // Finished later and never opened: first in Recent, the busy row travels
      // below it, and its completed check is already there on mount.
      {
        ...base,
        id: ThreadId.make("older"),
        title: "Older task",
        latestTurn: {
          ...turn("completed"),
          turnId: TurnId.make("turn-older"),
          completedAt: "2026-09-01T00:10:00.000Z",
        },
        latestCompletedTurnAt: "2026-09-01T00:10:00.000Z",
      },
    ];
    const props: InboxSidebarProps = {
      projects: [],
      worktrees: [],
      environments: [],
      threads: threads("running"),
      deliveryUnknownThreadKeys: new Set(),
      localQueuedThreadKeys: new Set(),
      activeThreadKey: null,
      aiFocusEnabled: false,
      autoSettleAfterDays: null,
      pinnedThreadKeys: new Set(),
      onOpenThread: vi.fn(),
    };
    const mounted = await render(<InboxSidebar {...props} />);
    try {
      const busyShell = () =>
        document.querySelector<HTMLElement>(`[data-inbox-row-key="${ENVIRONMENT_ID}:busy"]`)!;
      const glyph = () => busyShell().querySelector<HTMLElement>("[data-inbox-glyph]")!;
      expect(glyph().dataset.inboxGlyph).toBe("working");
      // A fresh sidebar paints still: nothing animates in on mount, including
      // the completed check's stroke (the working spinner is a loop, not entry).
      const olderGlyph = document.querySelector<HTMLElement>(
        `[data-inbox-row-key="${ENVIRONMENT_ID}:older"] [data-inbox-glyph]`,
      )!;
      expect(olderGlyph.dataset.inboxGlyph).toBe("completed");
      expect(olderGlyph.getAnimations({ subtree: true })).toHaveLength(0);
      expect(glyph().getAnimations()).toHaveLength(0);
      expect(busyShell().closest("section")?.querySelector("h2")?.textContent).toBe("Active now");

      await mounted.rerender(<InboxSidebar {...props} threads={threads("completed")} />);
      expect(busyShell().closest("section")?.querySelector("h2")?.textContent).toBe("Recent");
      expect(busyShell().previousElementSibling?.getAttribute("data-inbox-row-key")).toBe(
        `${ENVIRONMENT_ID}:older`,
      );
      expect(glyph().dataset.inboxGlyph).toBe("completed");
      expect(glyph().getAttribute("aria-label")).toBe("Completed");
      expect(glyph().getAnimations().length).toBeGreaterThan(0);
      expect(busyShell().getAnimations().length).toBeGreaterThan(0);
    } finally {
      await mounted.unmount();
    }
  });

  it("says what each state needs on line 2 and keeps resting rows to one line", async () => {
    const base = {
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      interactionMode: "default" as const,
      session: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      archivedAt: null,
      latestTurn: null,
      branch: "feat/glyph",
      worktreePath: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    const props: InboxSidebarProps = {
      projects: [],
      worktrees: [],
      environments: [
        {
          environmentId: ENVIRONMENT_ID,
          label: "This device",
          connectionState: "connected",
          stale: false,
          role: "owner",
          trust: "unverified",
          deliveryUnknown: false,
          threadSettlementSupported: true,
          threadSnoozeSupported: true,
          mutationReady: true,
          shellCurrent: true,
        },
      ],
      threads: [
        { ...base, id: ThreadId.make("ask"), title: "Ask task", hasPendingApprovals: true },
        {
          ...base,
          id: ThreadId.make("broken"),
          title: "Broken task",
          session: {
            provider: ProviderDriverKind.make("codex"),
            status: "error",
            orchestrationStatus: "error",
            lastError: "Provider exited (code 1)",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        },
        {
          ...base,
          id: ThreadId.make("done"),
          title: "Done task",
          settledOverride: "settled",
          settledAt: "2026-09-01T00:00:00.000Z",
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
    const mounted = await render(<InboxSidebar {...props} />);
    try {
      const row = (id: string) =>
        document.querySelector<HTMLElement>(
          `[data-inbox-row-key="${ENVIRONMENT_ID}:${id}"] [data-testid="inbox-thread-row"]`,
        )!;
      expect(row("ask").textContent).toContain("Needs approval");
      expect(row("ask").querySelector("[data-inbox-glyph]")?.getAttribute("aria-label")).toBe(
        "Needs approval",
      );
      expect(row("broken").textContent).toContain("Provider exited (code 1)");
      // Trust warnings stay on the row, not only in the card.
      expect(row("ask").querySelector('[aria-label="Not verified"]')).not.toBeNull();
      // Blocked settlement still explains itself.
      await page.getByRole("button", { name: "Settle Ask task" }).hover();
      await expect
        .element(page.getByText("Resolve the pending approval first."))
        .toBeInTheDocument();

      await page.getByRole("button", { name: /Settled/ }).click();
      const resting = row("done");
      expect(resting.querySelector("[data-inbox-glyph]")).toBeNull();
      expect(resting.textContent).toContain("Done task");
      expect(resting.textContent).not.toContain("feat/glyph");
      expect(resting.getBoundingClientRect().height).toBeLessThan(32);
    } finally {
      await mounted.unmount();
    }
  });

  it.each([false, true])(
    "preserves inbox detail and settlement (worktree: %s)",
    async (isWorktree) => {
      await page.viewport(1_280, 800);
      const now = Date.now();
      const performThreadMenuAction = vi.fn(async () => undefined);
      const onOpenThread = vi.fn();
      const dispatchCommand = vi.fn(async (_command: unknown) => undefined);
      const getThreadWindow = vi.fn(async () => ({
        thread: {
          activities: [
            {
              id: "handoff-latest",
              kind: "context-handoff",
              tone: "info",
              summary: "Context handoff",
              turnId: null,
              createdAt: "2026-08-25T00:00:00.000Z",
              payload: {
                schemaVersion: 1,
                handoffId: "handoff-latest",
                mode: "full-context-fresh-session",
                targetMessageId: "message",
                sourceSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
                targetSelection: { instanceId: "codex", model: "gpt-5.4" },
                sources: [
                  {
                    providerInstanceId: "claudeAgent",
                    driverKind: "claudeAgent",
                    modelSlug: "claude-opus-5",
                    modelDisplayName: "Claude Opus 5",
                  },
                ],
                target: {
                  providerInstanceId: "codex",
                  driverKind: "codex",
                  modelSlug: "gpt-5.4",
                  modelDisplayName: "GPT-5.4",
                },
                status: "consumed",
                contextVersion: 1,
                contextDigest: "a".repeat(64),
              },
            },
          ],
        },
        history: { activities: { hasMoreBefore: false, oldestCursor: null, newestCursor: null } },
      }));
      __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
        orchestration: { dispatchCommand, getThreadWindow },
      } as unknown as EnvironmentApi);
      const host = document.createElement("div");
      host.style.width = "320px";
      host.style.height = "720px";
      document.body.append(host);

      const mounted = await render(
        <InboxSidebar
          projects={[
            {
              environmentId: ENVIRONMENT_ID,
              id: PROJECT_ID,
              name: "Ryco",
              cwd: "/repo/ryco",
              defaultModelSelection: null,
              scripts: [],
            },
          ]}
          worktrees={
            isWorktree
              ? [
                  {
                    id: WorktreeId.make("pr-worktree"),
                    environmentId: ENVIRONMENT_ID,
                    projectId: PROJECT_ID,
                    title: null,
                    branch: "feat/settle",
                    worktreePath: "/repo/worktrees/settle",
                    origin: "pr",
                    prNumber: 42,
                    issueNumber: null,
                    prTitle: "Inbox PR",
                    issueTitle: null,
                    prState: "open",
                    prIsDraft: true,
                    issueState: null,
                    workItemProvider: null,
                    workItemKey: null,
                    workItemTitle: null,
                    workItemState: null,
                    workItemStateName: null,
                    workItemUrl: null,
                    createdAt: "2026-08-25T00:00:00.000Z",
                    updatedAt: "2026-08-25T00:00:00.000Z",
                    archivedAt: null,
                    manualPosition: 0,
                  },
                ]
              : []
          }
          threads={[
            {
              environmentId: ENVIRONMENT_ID,
              id: THREAD_ID,
              projectId: PROJECT_ID,
              title: "Hover target",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.4",
              },
              interactionMode: "default",
              session: null,
              createdAt: "2026-08-25T00:00:00.000Z",
              archivedAt: null,
              updatedAt: "2026-08-25T00:00:00.000Z",
              latestTurn: null,
              branch: "feat/settle",
              worktreePath: isWorktree ? "/repo/worktrees/settle" : null,
              latestUserMessageAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
              priority: {
                tier: "now",
                confidence: "high",
                reason: "A release decision is waiting on this task.",
                inputFingerprint: "fingerprint" as never,
                batchId: "batch" as never,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                },
                rankedAt: new Date(now - 60_000).toISOString(),
                usableUntil: new Date(now + 10 * 60_000).toISOString(),
              },
            },
          ]}
          environments={[
            {
              environmentId: ENVIRONMENT_ID,
              label: "This device",
              providers: [
                Schema.decodeUnknownSync(ServerProvider)({
                  instanceId: "codex",
                  driver: "codex",
                  enabled: true,
                  installed: true,
                  version: "1.0.0",
                  status: "ready",
                  auth: { status: "authenticated" },
                  checkedAt: "2026-08-25T00:00:00.000Z",
                  models: [
                    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
                  ],
                }),
              ],
              connectionState: "connected",
              stale: false,
              role: "owner",
              trust: "not-required",
              deliveryUnknown: false,
              threadSettlementSupported: true,
              threadSnoozeSupported: true,
              mutationReady: true,
              shellCurrent: true,
            },
          ]}
          deliveryUnknownThreadKeys={new Set()}
          localQueuedThreadKeys={new Set()}
          activeThreadKey={null}
          aiFocusEnabled
          autoSettleAfterDays={null}
          pinnedThreadKeys={new Set()}
          onOpenThread={onOpenThread}
          threadActions={{
            listThreadMenuActions: () => [
              { id: "pin", label: "Pin thread" },
              { id: "rename", label: "Rename thread" },
              { id: "trash", label: "Move to Trash", destructive: true },
            ],
            performThreadMenuAction,
          }}
        />,
        { container: host },
      );

      try {
        const row = page.getByTestId("inbox-thread-row");
        expect(document.body.textContent).toContain("Focus");
        expect(getThreadWindow).not.toHaveBeenCalled();
        await row.hover();
        await vi.waitFor(() => {
          expect(document.querySelector('[data-slot="tooltip-popup"]')).not.toBeNull();
        });
        const rowElement = document.querySelector<HTMLElement>('[data-testid="inbox-thread-row"]')!;
        const rowShell = document.querySelector<HTMLElement>(
          '[data-testid="inbox-thread-row-shell"]',
        )!;
        const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')!;
        // Glyph row: the status glyph and the project icon share one column,
        // and the second line starts where the title starts.
        const glyph = rowElement.querySelector<HTMLElement>("[data-inbox-glyph]")!;
        expect(glyph.getAttribute("aria-label")).toBe("Idle");
        const [glyphCell, title, secondLine] = [...rowElement.children] as HTMLElement[];
        const projectCell = secondLine!.firstElementChild as HTMLElement;
        const lineContent = secondLine!.lastElementChild as HTMLElement;
        for (const width of [240, 280, 320, 480]) {
          host.style.width = `${width}px`;
          const glyphBounds = glyphCell!.getBoundingClientRect();
          const projectBounds = projectCell.getBoundingClientRect();
          expect(Math.abs(glyphBounds.left - projectBounds.left)).toBeLessThan(0.5);
          expect(
            Math.abs(
              title!.getBoundingClientRect().left - lineContent.getBoundingClientRect().left,
            ),
          ).toBeLessThan(0.5);
          expect(title!.getBoundingClientRect().height).toBeLessThanOrEqual(18);
          expect(rowElement.scrollWidth).toBeLessThanOrEqual(rowElement.clientWidth);
        }
        host.style.width = "320px";
        expect(rowElement.getBoundingClientRect().height).toBeLessThan(56);
        expect(getComputedStyle(rowElement).willChange).toBe("auto");
        expect(getComputedStyle(rowShell).contentVisibility).toBe("auto");
        expect(getComputedStyle(rowShell).containIntrinsicBlockSize).toContain("52px");
        // One machine: the machine is implicit on the row and named in the card.
        expect(rowElement.textContent).not.toContain("This device");
        expect(rowElement.querySelector("[data-device-icon]")).toBeNull();
        await vi.waitFor(() =>
          expect(popup.querySelector('[data-testid="inbox-context-handoff"]')).not.toBeNull(),
        );
        const handoff = popup.querySelector('[data-testid="inbox-context-handoff"]')!;
        expect(handoff.textContent).toContain("Opus 5");
        expect(handoff.textContent).toContain("GPT-5.4");
        expect(handoff.textContent).not.toContain("Claude Opus");
        expect(handoff.querySelectorAll("svg").length).toBeGreaterThanOrEqual(3);
        expect(getThreadWindow).toHaveBeenCalledOnce();
        expect(popup.textContent).toContain("Hover target");
        expect(popup.textContent).toContain("This device");
        expect(
          popup.querySelector("[data-device-icon]")?.parentElement?.querySelectorAll("svg").length,
        ).toBe(1);
        expect(popup.textContent).toContain("feat/settle");
        expect(popup.textContent).not.toContain("Worktree");
        expect(popup.textContent).not.toContain("Original directory");
        expect(popup.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
          isWorktree ? "Worktree" : "Original directory",
        );
        const previewTitle = popup.querySelector<HTMLElement>(
          '[data-testid="inbox-preview-title"]',
        )!;
        const previewStatus = popup.querySelector<HTMLElement>(
          '[data-testid="inbox-preview-status"]',
        )!;
        expect(previewStatus.textContent).toBe("Idle");
        expect(previewStatus.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          previewTitle.getBoundingClientRect().top,
        );
        expect(getComputedStyle(previewTitle).webkitLineClamp).toBe("2");
        expect(
          rowElement.querySelector(isWorktree ? ".lucide-git-fork" : ".lucide-git-branch"),
        ).not.toBeNull();
        expect(popup.textContent).not.toContain("gpt-5.4");
        expect(popup.textContent).toContain("Ryco");
        expect(rowElement.querySelector('[aria-label="PR #42 · Draft"]') !== null).toBe(isWorktree);
        // The provider logo names the agent; the text is just the model.
        expect(popup.textContent).toContain("GPT-5.4");
        expect(popup.textContent).not.toContain("Codex ·");
        expect(popup.querySelector('[aria-label="Codex"]')).not.toBeNull();
        expect(popup.textContent).toContain("Why focused? Now.");
        expect(popup.textContent).toContain("A release decision is waiting on this task.");
        expect(popup.textContent).toContain("GPT-5.4 · ranked");
        expect(getComputedStyle(popup).width).toBe("320px");
        expect(popup.getBoundingClientRect().left).toBeGreaterThanOrEqual(
          rowElement.getBoundingClientRect().right,
        );

        await page.getByRole("button", { name: "Settle Hover target" }).click();
        await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledTimes(1));
        expect(dispatchCommand.mock.calls[0]![0]).toMatchObject({
          type: "thread.settle",
          threadId: THREAD_ID,
        });
        await row.click({ button: "right" });
        await page.getByRole("menuitem", { name: "Pin thread", exact: true }).click();
        expect(performThreadMenuAction).toHaveBeenCalledWith(
          { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
          "pin",
        );
        expect(onOpenThread).not.toHaveBeenCalled();
        await vi.waitFor(() =>
          expect(document.querySelector('[data-slot="context-menu-popup"]')).toBeNull(),
        );
        await page.getByRole("button", { name: "Thread actions for Hover target" }).click();
        await page.getByRole("menuitem", { name: "Snooze", exact: true }).hover();
        await page.getByRole("menuitem", { name: /In 1 hour/ }).click();
        await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledTimes(2));
        expect(dispatchCommand.mock.calls[1]![0]).toMatchObject({
          type: "thread.snooze",
          threadId: THREAD_ID,
        });
        expect(onOpenThread).not.toHaveBeenCalled();
      } finally {
        await mounted.unmount();
        host.remove();
      }
    },
  );
});

describe("Inbox sidebar delegated threads", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    document.body.innerHTML = "";
  });

  const coordinatorId = ThreadId.make("Coordinator");
  const workerId = ThreadId.make("Worker");
  const delegatedProps = (activeThreadKey: string | null): InboxSidebarProps => ({
    projects: [],
    worktrees: [],
    environments: [],
    threads: [coordinatorId, workerId].map((id) => ({
      id,
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      title: `${id} task`,
      interactionMode: "default",
      session: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      archivedAt: null,
      latestTurn: null,
      branch: null,
      worktreePath: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      lineage:
        id === workerId
          ? {
              parentThreadId: coordinatorId,
              rootThreadId: coordinatorId,
              relationship: "delegated",
            }
          : null,
    })),
    deliveryUnknownThreadKeys: new Set(),
    localQueuedThreadKeys: new Set(),
    activeThreadKey,
    aiFocusEnabled: false,
    autoSettleAfterDays: null,
    pinnedThreadKeys: new Set(),
    onOpenThread: vi.fn(),
  });
  const rowTitles = () =>
    [...document.querySelectorAll('[data-testid="inbox-thread-row"]')].map((row) =>
      row.querySelector(".inbox-row-title")?.textContent?.trim(),
    );

  it("folds a quiet delegated child behind a collapsed disclosure under its host", async () => {
    await page.viewport(1280, 800);
    const mounted = await render(<InboxSidebar {...delegatedProps(null)} />);
    try {
      const disclosure = page.getByRole("button", {
        name: "Show 1 delegated thread from Coordinator task",
      });
      await expect.element(disclosure).toBeInTheDocument();
      await expect.element(disclosure).toMatchTextContent("1 delegated");
      await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(rowTitles()).toEqual(["Coordinator task"]);

      await disclosure.click();
      await expect.element(disclosure).toHaveAttribute("aria-expanded", "true");
      expect(rowTitles()).toEqual(["Coordinator task", "Worker task"]);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps a host open while its delegated child is the open thread", async () => {
    await page.viewport(1280, 800);
    const mounted = await render(
      <InboxSidebar {...delegatedProps(`${ENVIRONMENT_ID}:${workerId}`)} />,
    );
    try {
      await expect
        .element(
          page.getByRole("button", { name: "Show 1 delegated thread from Coordinator task" }),
        )
        .toHaveAttribute("aria-expanded", "true");
      expect(rowTitles()).toEqual(["Coordinator task", "Worker task"]);
    } finally {
      await mounted.unmount();
    }
  });
});
