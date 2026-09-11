import "../../index.css";

import { Schema } from "effect";
import { ServerProvider } from "@ryco/contracts";
import type { EnvironmentApi } from "@ryco/contracts";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { InboxSidebar } from "./InboxSidebar";

const ENVIRONMENT_ID = EnvironmentId.make("environment-hover-card");
const PROJECT_ID = ProjectId.make("project-hover-card");
const THREAD_ID = ThreadId.make("thread-hover-card");

describe("Inbox sidebar rendering and settlement", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    document.body.innerHTML = "";
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
              { id: "close", label: "Delete thread", destructive: true },
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
        const contextHeader = rowElement.firstElementChild as HTMLElement;
        const deviceIcon = contextHeader.querySelector("[data-device-icon]")!;
        for (const width of [240, 280, 320, 480]) {
          host.style.width = `${width}px`;
          const headerBounds = contextHeader.getBoundingClientRect();
          const iconBounds = deviceIcon.getBoundingClientRect();
          expect(headerBounds.height).toBeLessThanOrEqual(18);
          expect(iconBounds.top).toBeGreaterThanOrEqual(headerBounds.top);
          expect(iconBounds.bottom).toBeLessThanOrEqual(headerBounds.bottom);
          const iconCenter = (iconBounds.top + iconBounds.bottom) / 2;
          for (const label of [
            deviceIcon.parentElement!.firstElementChild!,
            deviceIcon.nextElementSibling!,
          ]) {
            const labelBounds = label.getBoundingClientRect();
            expect(Math.abs(iconCenter - (labelBounds.top + labelBounds.bottom) / 2)).toBeLessThan(
              0.5,
            );
          }
          expect(rowElement.scrollWidth).toBeLessThanOrEqual(rowElement.clientWidth);
        }
        host.style.width = "320px";
        expect(getComputedStyle(rowElement).willChange).toBe("auto");
        expect(getComputedStyle(rowShell).contentVisibility).toBe("auto");
        expect(getComputedStyle(rowShell).containIntrinsicBlockSize).toContain("76px");
        expect(
          [...rowElement.children].some(
            (child) => child.classList.contains("absolute") && child.classList.contains("left-0"),
          ),
        ).toBe(false);
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
        expect(previewStatus.textContent).toBeTruthy();
        expect(previewTitle.getBoundingClientRect().right).toBeLessThan(
          previewStatus.getBoundingClientRect().left,
        );
        expect(getComputedStyle(previewTitle).textOverflow).toBe("ellipsis");
        expect(
          rowElement.querySelector(isWorktree ? ".lucide-git-fork" : ".lucide-git-branch"),
        ).not.toBeNull();
        expect(popup.textContent).not.toContain("gpt-5.4");
        expect(rowElement.textContent).toContain("Ryco");
        expect(rowElement.querySelector('[aria-label="PR #42 · Draft"]') !== null).toBe(isWorktree);
        expect(popup.textContent).toContain("Codex · GPT-5.4");
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
