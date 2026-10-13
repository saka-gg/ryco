import "../../index.css";
// The feature stylesheet loads with its page or dialog chunk in the app.
import "./projects.css";

import {
  ProjectId,
  WorktreeId,
  type DispatchableClientOrchestrationCommand,
  type EnvironmentApi,
  type WorkspaceDiskUsageInput,
  type WorkspaceLifecycleApplyInput,
  type WorkspaceLifecyclePreview,
  type WorkspaceLifecycleRequest,
  type WorkspaceLifecycleResult,
  type WorkspaceLifecycleSummary,
} from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock(
  "~/components/automations/useAutomationCentre",
  async () =>
    (await import("~/components/projects/testing/automationFixtures")).automationCentreMock,
);
vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
  readEnvironmentApi,
} from "../../environmentApi";
import { isMacPlatform } from "../../lib/utils";
import { toastManager } from "../ui/toast";
import { WorkspaceReviewDialog } from "../worktrees/WorkspaceReviewDialog";
import { openWorkspaceReviewDialog, useWorkspaceReviewDialog } from "../../workspaceLifecycle";
import { sourceControlRpcMock } from "../pullRequests/testing/sourceControlRpcMock";
import {
  resetAutomationsDialogStoreForTests,
  useAutomationsDialogStore,
} from "../automations/automationsDialogStore";
import { automationCentreFixture } from "./testing/automationFixtures";
import type { ProjectsSearch } from "./projectsSearch";
import {
  FIXTURE_NOW_ISO,
  FIXTURE_NOW_MS,
  LOCAL_ENV,
  RYCO_LOCAL,
  RYCO_STUDIO,
  STUDIO_ENV,
  resetProjectsFixtureState,
  seedProjectsFixtureStore,
} from "./testing/projectFixtures";
import { ProjectsTestHarness, projectsTestSearchLog } from "./testing/ProjectsTestHarness";

let dispatched: DispatchableClientOrchestrationCommand[] = [];

function workspaceSummary(
  overrides: Partial<WorkspaceLifecycleSummary> = {},
): WorkspaceLifecycleSummary {
  return {
    worktreeId: WorktreeId.make("worktree-projects"),
    projectId: ProjectId.make(RYCO_LOCAL),
    title: "projects-page",
    branch: "projects-page",
    path: "/Users/me/.ryco/worktrees/ryco/projects-page__abcde",
    origin: "pr",
    main: false,
    archivedAt: null,
    checkoutRemovedAt: null,
    checkout: "present",
    gitRegistered: true,
    branchExists: true,
    unmerged: false,
    changes: {
      modified: 0,
      untracked: 0,
      protectedIgnored: 0,
      protectedIgnoredSample: [],
      regenerableIgnored: 0,
      regenerableIgnoredSample: [],
      truncated: false,
    },
    conversations: { active: 1, archived: 0, trashed: 0 },
    activeWork: [],
    actions: [
      { action: "archive", available: true, blockers: [] },
      { action: "restore", available: false, blockers: [] },
      { action: "remove-checkout", available: true, blockers: [] },
      { action: "remove-stale-record", available: false, blockers: [] },
      { action: "recreate-checkout", available: false, blockers: [] },
    ],
    inspectedAt: FIXTURE_NOW_ISO,
    ...overrides,
  };
}

/** The server's lifecycle service, scripted per test. */
const lifecycle = {
  summaries: [] as WorkspaceLifecycleSummary[],
  blockers: [] as string[],
  results: [] as WorkspaceLifecycleResult[],
  previews: [] as WorkspaceLifecycleRequest[],
  applied: [] as WorkspaceLifecycleApplyInput[],
  diskRequests: [] as WorkspaceDiskUsageInput[],
  reset() {
    this.summaries = [
      workspaceSummary({
        worktreeId: WorktreeId.make("worktree-main"),
        title: "ryco",
        branch: "main",
        path: "/Users/me/Code/ryco",
        origin: "main",
        main: true,
        actions: [],
      }),
      workspaceSummary(),
      workspaceSummary({
        worktreeId: WorktreeId.make("worktree-old"),
        title: "old-experiment",
        branch: "old-experiment",
        archivedAt: "2026-09-01T09:00:00.000Z",
      }),
    ];
    this.blockers = [];
    this.results = [];
    this.previews = [];
    this.applied = [];
    this.diskRequests = [];
  },
};

const MB = 1024 * 1024;
const diskUsageOf = (worktreeId: string, main: boolean, bytes: number) => ({
  worktreeId: WorktreeId.make(worktreeId),
  main,
  bytes,
  partial: false,
  measuredAt: FIXTURE_NOW_ISO,
});

function installDispatch() {
  dispatched = [];
  lifecycle.reset();
  const dispatchCommand = vi.fn(async (command: DispatchableClientOrchestrationCommand) => {
    dispatched.push(command);
    return { sequence: dispatched.length };
  });
  __setEnvironmentApiOverrideForTests(LOCAL_ENV, {
    orchestration: { dispatchCommand },
    lifecycle: {
      listWorkspaces: async () => lifecycle.summaries,
      suggestions: async () => ({ generatedAt: FIXTURE_NOW_ISO, threads: [], checkouts: [] }),
      previewWorkspace: async (request: WorkspaceLifecycleRequest) => {
        lifecycle.previews.push(request);
        const workspace = lifecycle.summaries.find(
          (summary) => summary.worktreeId === request.worktreeId,
        )!;
        if (request.discard)
          return {
            request,
            workspace,
            effects: {
              archiveWorkspace: false,
              restoreWorkspace: false,
              removeCheckout: true,
              recreateCheckout: false,
              recordCheckoutRemoval: true,
              stopSessionThreadIds: [],
              archiveConversationIds: [],
              unchangedConversations: 0,
              discardedRegenerableIgnored: 0,
              deleteBranch: request.deleteBranch === true,
              branch: workspace.branch,
              discard: true,
              trashConversationIds: [],
              discardsWork: true,
            },
            summary: `Delete 1 workspace: remove its checkout, ${request.deleteBranch ? "delete" : "keep"} branch ${workspace.branch}. Work that exists only here is lost.`,
            details: ["Discards uncommitted changes to 48 tracked files."],
            blockers: [],
            fingerprint: `fp-${lifecycle.previews.length}`,
          } satisfies WorkspaceLifecyclePreview;
        const archive = request.archiveConversations !== false;
        return {
          request,
          workspace,
          effects: {
            archiveWorkspace: false,
            restoreWorkspace: false,
            removeCheckout: true,
            recreateCheckout: false,
            recordCheckoutRemoval: true,
            stopSessionThreadIds: [],
            archiveConversationIds: [],
            unchangedConversations: 0,
            discardedRegenerableIgnored: 0,
            deleteBranch: false,
            branch: workspace.branch,
          },
          summary: archive
            ? "Remove 1 checkout, archive 1 conversation, keep history and branch."
            : "Remove 1 checkout, keep 1 conversation, history and branch.",
          details: ["The branch projects-page is kept."],
          blockers: lifecycle.blockers,
          fingerprint: `fp-${lifecycle.previews.length}`,
        } satisfies WorkspaceLifecyclePreview;
      },
      applyWorkspace: async (input: WorkspaceLifecycleApplyInput) => {
        lifecycle.applied.push(input);
        return (
          lifecycle.results.shift() ?? {
            outcome: "completed",
            message: "Removed 1 checkout; history and branch kept.",
            steps: [],
          }
        );
      },
      listTrash: async () => ({ threads: [], truncated: false }),
      diskUsage: async (input: WorkspaceDiskUsageInput) => {
        lifecycle.diskRequests.push(input);
        return {
          workspaces: [
            diskUsageOf("worktree-main", true, 1536 * MB),
            diskUsageOf("worktree-projects", false, 512 * MB),
            diskUsageOf("worktree-old", false, 100 * MB),
          ],
        };
      },
    },
  } as unknown as EnvironmentApi);
}

/** Settings is the editor under test unless a search names the map. */
async function renderPage(search: ProjectsSearch, width = 1280) {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(width, 820);
  return render(
    <ProjectsTestHarness
      width={width}
      height={820}
      initialSearch={{ view: search.workspace ? "map" : "settings", ...search }}
    />,
  );
}

function mapNode(kind: string, text: string): HTMLElement {
  const node = [
    ...document.querySelectorAll<HTMLElement>(`[data-map-node="${kind}"][data-state="live"]`),
  ].find((candidate) => candidate.textContent?.includes(text));
  if (!node) throw new Error(`No ${kind} node with "${text}"`);
  return node;
}

async function clickNode(kind: string, text: string) {
  await expect.poll(() => mapNode(kind, text)).toBeTruthy();
  await userEvent.click(mapNode(kind, text));
}

/** The map's toggle key: ⌘ on macOS, ctrl elsewhere. */
const TOGGLE_KEY = isMacPlatform(navigator.platform) ? "Meta" : "Control";

async function clickNodeWith(key: string, kind: string, text: string) {
  await expect.poll(() => mapNode(kind, text)).toBeTruthy();
  await userEvent.keyboard(`{${key}>}`);
  await userEvent.click(mapNode(kind, text));
  await userEvent.keyboard(`{/${key}}`);
}

const selectedNodes = () =>
  [...document.querySelectorAll<HTMLElement>('[data-map-node][data-state="live"][data-selected]')]
    .map((node) => node.dataset.key)
    .toSorted();

function scrollRegion(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-projects-focus-anchor]");
}

describe("Project page sections", () => {
  beforeEach(() => {
    seedProjectsFixtureStore();
    installDispatch();
    automationCentreFixture.reset();
    resetAutomationsDialogStoreForTests();
  });
  afterEach(() => {
    resetProjectsFixtureState();
    __resetEnvironmentApiOverridesForTests();
    sourceControlRpcMock.reset();
    projectsTestSearchLog.clear();
    navigate.mockClear();
    useWorkspaceReviewDialog.getState().close();
    vi.useRealTimers();
  });

  describe("Hero", () => {
    it("renames the project in place when the name commits", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL });
      const name = screen.getByRole("textbox", { name: "Project name" });
      await expect.element(name).toHaveValue("ryco");
      await userEvent.fill(name, "Ryco app");
      await userEvent.keyboard("{Enter}");
      await expect
        .poll(() => dispatched.find((command) => command.type === "project.meta.update"))
        .toMatchObject({ type: "project.meta.update", projectId: RYCO_LOCAL, title: "Ryco app" });
      // The new name shows before the checkout catches up.
      await expect.element(name).toHaveValue("Ryco app");
    });

    it("puts the name back on Escape without saving", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL });
      const name = screen.getByRole("textbox", { name: "Project name" });
      await userEvent.fill(name, "Something else");
      await userEvent.keyboard("{Escape}");
      await expect.element(name).toHaveValue("ryco");
      await expect.poll(() => document.activeElement === name.element()).toBe(false);
      expect(dispatched).toEqual([]);
    });

    it("links to the project's pull requests", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL });
      await screen.getByRole("button", { name: "Pull requests" }).click();
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/pull-requests",
          search: expect.objectContaining({ env: LOCAL_ENV, project: RYCO_LOCAL }),
        }),
      );
    });
  });

  describe("Devices", () => {
    it("lists every checkout and edits another one from its row", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL });
      const checkouts = screen.getByRole("group", { name: "Checkouts" });
      await expect
        .element(checkouts.getByRole("button", { name: /This device/ }))
        .toHaveAttribute("aria-current", "true");
      await expect.element(checkouts.getByText("~/Code/ryco")).toBeVisible();
      await checkouts.getByRole("button", { name: /Studio/ }).click();
      expect(projectsTestSearchLog.last()).toMatchObject({ env: STUDIO_ENV, project: RYCO_STUDIO });
    });

    it("says how much disk each checkout takes, and breaks it down by workspace", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL });
      const checkouts = screen.getByRole("group", { name: "Checkouts" });
      await expect
        .poll(() => checkouts.getByRole("button", { name: /This device/ }).element().textContent)
        .toContain("2.1 GB on disk");

      const fold = screen.getByRole("button", { name: "On disk · 2.1 GB" });
      await fold.click();
      const rows = screen.getByRole("list", { name: "Disk usage by workspace" });
      await expect
        .poll(() =>
          [...rows.element().querySelectorAll('[role="listitem"]')].map((row) => row.textContent),
        )
        .toEqual(["Main checkout1.5 GB", "projects-page512 MB", "old-experimentArchived100 MB"]);

      await screen.getByRole("button", { name: "Measure again" }).click();
      await expect
        .poll(() => lifecycle.diskRequests.at(-1))
        .toEqual({ projectId: RYCO_LOCAL, refresh: true });
    });
  });

  describe("Section navigation", () => {
    it("jumps to a section, records it, and marks it current", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL });
      const nav = screen.getByRole("navigation", { name: "Project sections" });
      const workspaces = nav.getByRole("link", { name: "Workspaces" });
      await workspaces.click();
      expect(projectsTestSearchLog.last()).toMatchObject({
        env: LOCAL_ENV,
        project: RYCO_LOCAL,
        section: "workspaces",
      });
      await expect.element(workspaces).toHaveAttribute("aria-current", "location");
      await expect.poll(() => scrollRegion()?.scrollTop ?? 0).toBeGreaterThan(0);
    });

    it("lands a deep link on its section", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, section: "danger" });
      await expect.element(screen.getByText("Remove from this device")).toBeVisible();
      await expect.poll(() => scrollRegion()?.scrollTop ?? 0).toBeGreaterThan(0);
    });

    it("folds away on a narrow detail", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL }, 1000);
      await expect
        .element(screen.getByRole("textbox", { name: "Project name" }))
        .toBeInTheDocument();
      expect(document.querySelector('nav[aria-label="Project sections"]')).toBeNull();
    });
  });

  describe("Automations", () => {
    it("says the checkout's schedules in one line and opens the Automations dialog on them", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL });
      await expect
        .element(screen.getByText(/^3 schedules · 1 waiting for approval$/))
        .toBeInTheDocument();
      await screen.getByRole("button", { name: "Open automations" }).click();
      const state = useAutomationsDialogStore.getState();
      expect(state.open).toBe(true);
      expect(state.request).toMatchObject({
        project: { kind: "checkout", environmentId: LOCAL_ENV, projectId: RYCO_LOCAL },
        mode: "view",
      });
      expect(state.origin?.textContent).toBe("Open automations");
    });
  });

  describe("Agent instructions", () => {
    it("shows Save and Revert only while the draft differs", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL });
      const instructions = screen.getByRole("textbox", { name: "Agent instructions" });
      await expect.element(instructions).toHaveValue("Prefer Effect Schema over zod.");
      await expect.element(screen.getByRole("button", { name: "Revert" })).not.toBeInTheDocument();
      await userEvent.fill(instructions, "Prefer Effect Schema over zod. Run tests.");
      await expect.element(screen.getByRole("button", { name: "Revert" })).toBeVisible();
      await screen.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(() => dispatched.at(-1))
        .toMatchObject({
          type: "project.meta.update",
          customSystemPrompt: "Prefer Effect Schema over zod. Run tests.",
        });
    });
  });

  describe("Map", () => {
    it("shows the project across its devices, with workspaces and the automations each device runs", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await expect.poll(() => mapNode("device", "This device")).toBeTruthy();
      expect(mapNode("device", "Studio")).toBeTruthy();
      expect(mapNode("workspace", "projects-page")).toBeTruthy();
      expect(mapNode("automation", "Triage new issues")).toBeTruthy();
      expect(mapNode("automation", "Summarise relay logs").dataset.muted).toBe("");
      // A due run asks for approval right on its node.
      await expect.element(screen.getByRole("button", { name: "Approve run" })).toBeVisible();
      // Threads are folded into their workspace's tally until asked for.
      expect(document.querySelector('[data-map-node="thread"]')).toBeNull();
    });

    it("states what the inspection found, once, on the workspace's node", async () => {
      lifecycle.summaries[1] = workspaceSummary({
        unmerged: true,
        changes: { ...workspaceSummary().changes!, modified: 2, untracked: 1 },
      });
      await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await expect
        .poll(() => mapNode("workspace", "projects-page").textContent)
        .toContain("2 modified, 1 untracked");
      expect(mapNode("workspace", "projects-page").textContent).toContain("Unmerged commits");
    });

    it("says how much disk the project takes on each device, and measures again on request", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      // Studio cannot measure here, so the project's total is a lower bound.
      await expect.poll(() => mapNode("project", "on disk").textContent).toContain("≥ 2.1 GB");
      expect(mapNode("device", "This device").textContent).toContain("2.1 GB");
      expect(mapNode("workspace", "projects-page").textContent).toContain("512 MB");
      expect(lifecycle.diskRequests).toEqual([{ projectId: RYCO_LOCAL, refresh: false }]);

      await clickNode("project", "on disk");
      const inspector = screen.getByRole("complementary", { name: "Details" });
      await expect.element(inspector.getByText("On disk · At least 2.1 GB")).toBeVisible();
      await inspector.getByRole("button", { name: "Measure again" }).click();
      await expect
        .poll(() => lifecycle.diskRequests.at(-1))
        .toEqual({ projectId: RYCO_LOCAL, refresh: true });
    });

    it("fans a workspace's threads out from its tally, and folds them back", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      const toggle = screen.getByRole("button", { name: /Show 1 thread/ }).first();
      await toggle.click();
      await expect.poll(() => mapNode("thread", "Fix the relay reconnect")).toBeTruthy();
      await screen
        .getByRole("button", { name: /Fold 1 thread/ })
        .first()
        .click();
      await expect
        .poll(() => document.querySelector('[data-map-node="thread"][data-state="live"]'))
        .toBeNull();
    });

    it("approves a due run from its node through the shared approval path", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await screen.getByRole("button", { name: "Approve run" }).click();
      expect(automationCentreFixture.decisions).toEqual([
        { environmentId: LOCAL_ENV, proposalId: "proposal-due", decision: "accept" },
      ]);
    });

    it("inspects an automation: schedule, where it runs, and its recent runs", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await clickNode("automation", "Nightly dependency check");
      const inspector = screen.getByRole("complementary", { name: "Details" });
      await expect.element(inspector.getByText("Nightly dependency check")).toBeVisible();
      await expect.element(inspector.getByText(/A new worktree off/)).toBeVisible();
      await expect.element(inspector.getByText("Dispatched")).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect
        .poll(() => document.querySelector(".map-inspector")?.hasAttribute("data-open"))
        .toBe(false);
    });

    it("reviews a checkout removal inside the inspector and applies exactly the reviewed preview", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await clickNode("workspace", "projects-page");
      const inspector = screen.getByRole("complementary", { name: "Details" });
      await inspector.getByRole("button", { name: "Remove checkout…" }).click();
      const review = inspector.getByRole("region", { name: /Remove checkout/ });
      await expect
        .element(
          review.getByText("Remove 1 checkout, archive 1 conversation, keep history and branch."),
        )
        .toBeVisible();
      // Options re-inspect: the summary always matches what Confirm will do.
      await review
        .getByRole("checkbox", { name: /Archive this workspace's conversations/ })
        .click();
      await expect
        .element(review.getByText("Remove 1 checkout, keep 1 conversation, history and branch."))
        .toBeVisible();
      await review.getByRole("button", { name: "Remove checkout" }).click();
      await expect.poll(() => lifecycle.applied).toHaveLength(1);
      expect(lifecycle.applied[0]).toMatchObject({
        worktreeId: "worktree-projects",
        action: "remove-checkout",
        archiveConversations: false,
        expectedFingerprint: `fp-${lifecycle.previews.length}`,
      });
      // Completed: the review closes back to the workspace's details.
      await expect
        .element(inspector.getByRole("button", { name: "Remove checkout…" }))
        .toBeVisible();
    });

    it("lands a menu's review deep link in the inspector and refuses to confirm while blocked", async () => {
      lifecycle.blockers = ["The checkout has 2 modified files."];
      const screen = await renderPage({
        env: LOCAL_ENV,
        project: RYCO_LOCAL,
        view: "map",
        workspace: "worktree-projects",
        review: "remove-checkout",
      });
      const review = screen.getByRole("region", { name: /Remove checkout/ });
      await expect.element(review.getByText("Nothing will change:")).toBeVisible();
      await expect.element(review.getByText("The checkout has 2 modified files.")).toBeVisible();
      await expect.element(review.getByRole("button", { name: "Remove checkout" })).toBeDisabled();
      expect(lifecycle.applied).toEqual([]);
    });

    it("keeps a partial run in the inspector with what happened, and retries by inspecting again", async () => {
      lifecycle.results = [
        {
          outcome: "partial",
          message: "The checkout directory was removed, but Git still registers it.",
          steps: [{ id: "update-record", status: "failed", detail: "Run git worktree prune." }],
        },
      ];
      const screen = await renderPage({
        env: LOCAL_ENV,
        project: RYCO_LOCAL,
        view: "map",
        workspace: "worktree-projects",
        review: "remove-checkout",
      });
      const review = screen.getByRole("region", { name: /Remove checkout/ });
      await review.getByRole("button", { name: "Remove checkout" }).click();
      await expect.element(review.getByText("Remove checkout partly completed")).toBeVisible();
      await expect.element(review.getByText("Run git worktree prune.")).toBeVisible();
      const previewsBefore = lifecycle.previews.length;
      await review.getByRole("button", { name: "Retry" }).click();
      await expect.poll(() => lifecycle.previews.length).toBeGreaterThan(previewsBefore);
      await expect.element(review.getByRole("button", { name: "Remove checkout" })).toBeEnabled();
    });

    it("reports a run that settles after its review closed as a toast, not a navigation", async () => {
      let finish: (result: WorkspaceLifecycleResult) => void = () => undefined;
      const pending = new Promise<WorkspaceLifecycleResult>((resolve) => {
        finish = resolve;
      });
      const screen = await renderPage({
        env: LOCAL_ENV,
        project: RYCO_LOCAL,
        view: "map",
        workspace: "worktree-projects",
        review: "remove-checkout",
      });
      const api = readEnvironmentApi(LOCAL_ENV)!;
      const toast = vi.spyOn(toastManager, "add");
      const applyWorkspace = vi
        .spyOn(api.lifecycle!, "applyWorkspace")
        .mockImplementation(async () => pending);
      const review = screen.getByRole("region", { name: /Remove checkout/ });
      await review.getByRole("button", { name: "Remove checkout" }).click();
      await expect.poll(() => applyWorkspace.mock.calls.length).toBe(1);
      screen.unmount();
      finish({
        outcome: "partial",
        message: "The checkout directory was removed, but Git still registers it.",
        steps: [{ id: "update-record", status: "failed", detail: "Run git worktree prune." }],
      });
      await expect
        .poll(() => toast.mock.calls.map(([options]) => options.title))
        .toContain("Remove checkout partly completed");
      toast.mockRestore();
    });

    it("takes a menu's deep link once: it lands, then leaves the URL so dismissing it sticks", async () => {
      const screen = await renderPage({
        env: LOCAL_ENV,
        project: RYCO_LOCAL,
        view: "map",
        workspace: "worktree-projects",
        review: "remove-checkout",
      });
      await expect.element(screen.getByRole("region", { name: /Remove checkout/ })).toBeVisible();
      await expect
        .poll(() => projectsTestSearchLog.last())
        .toEqual({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await userEvent.keyboard("{Escape}");
      await expect
        .poll(() => document.querySelector(".map-inspector")?.hasAttribute("data-open"))
        .toBe(false);
    });

    it("keeps a lit automation's run wire in its own colour", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await screen
        .getByRole("button", { name: /Show 1 thread/ })
        .first()
        .click();
      await clickNode("automation", "Nightly dependency check");
      await expect
        .poll(() =>
          document.querySelector<SVGPathElement>('.map-wire[data-kind="run"][data-lit="on"]'),
        )
        .not.toBeNull();
      const wire = document.querySelector<SVGPathElement>(
        '.map-wire[data-kind="run"][data-lit="on"]',
      )!;
      expect(getComputedStyle(wire).stroke).not.toBe("none");
      expect(wire.getAttribute("d")).toMatch(/^M /);
    });

    it("deletes a workspace whose removal is blocked by its own work, after an explicit yes", async () => {
      lifecycle.blockers = ["48 tracked files have uncommitted changes."];
      lifecycle.summaries = lifecycle.summaries.map((summary) =>
        summary.worktreeId === "worktree-projects"
          ? { ...summary, unmerged: true, discardBlockers: [] }
          : summary,
      );
      const screen = await renderPage({
        env: LOCAL_ENV,
        project: RYCO_LOCAL,
        view: "map",
        workspace: "worktree-projects",
        review: "remove-checkout",
      });
      const blocked = screen.getByRole("region", { name: /Remove checkout/ });
      await expect.element(blocked.getByText("Nothing will change:")).toBeVisible();
      await blocked.getByRole("button", { name: "Delete workspace instead…" }).click();

      const review = screen.getByRole("region", { name: /Delete workspace/ });
      await expect
        .element(review.getByText(/Delete 1 workspace: remove its checkout, delete branch/))
        .toBeVisible();
      expect(lifecycle.previews.at(-1)).toMatchObject({
        action: "remove-checkout",
        discard: true,
        deleteBranch: true,
      });
      // Losing work needs a yes to this exact preview.
      const confirm = review.getByRole("button", { name: "Delete workspace" });
      await expect.element(confirm).toBeDisabled();
      await review
        .getByRole("checkbox", { name: /work which exists only in this workspace/ })
        .click();
      await confirm.click();
      await expect.poll(() => lifecycle.applied).toHaveLength(1);
      expect(lifecycle.applied[0]).toMatchObject({
        worktreeId: "worktree-projects",
        action: "remove-checkout",
        discard: true,
        deleteBranch: true,
        expectedFingerprint: `fp-${lifecycle.previews.length}`,
      });
    });

    it("edits the project in its card: name and settings, without leaving the map", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await clickNode("project", "ryco");
      const inspector = screen.getByRole("complementary", { name: "Details" });
      const settings = inspector.getByRole("region", { name: "Settings" });
      await expect.element(settings.getByRole("heading", { name: "Location" })).toBeVisible();
      await expect
        .element(settings.getByRole("heading", { name: "Agent instructions" }))
        .toBeVisible();
      const name = inspector.getByRole("textbox", { name: "Project name" });
      await name.fill("ryco app");
      await userEvent.keyboard("{Enter}");
      await expect
        .poll(() => dispatched.find((command) => command.type === "project.meta.update"))
        .toMatchObject({ title: "ryco app" });
      expect(projectsTestSearchLog.last()).not.toMatchObject({ view: "settings" });
    });

    it("pauses an automation from its card, as a change to approve", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await clickNode("automation", "Nightly dependency check");
      const inspector = screen.getByRole("complementary", { name: "Details" });
      await inspector.getByRole("button", { name: "Pause" }).click();
      await expect.poll(() => automationCentreFixture.commands).toHaveLength(1);
      expect(automationCentreFixture.commands[0]).toMatchObject({
        environmentId: LOCAL_ENV,
        input: {
          kind: "save",
          automationId: "auto-nightly",
          expectedRevision: 1,
          definition: { enabled: false },
        },
      });
    });

    it("reaches the Automations dialog from its cards: the project's line, a device's New schedule, a schedule's Edit", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await clickNode("project", "ryco");
      const inspector = screen.getByRole("complementary", { name: "Details" });
      const entry = inspector.getByTestId("map-automations-entry");
      await expect.element(entry).toMatchTextContent(/3 schedules.*1 waiting/);
      await entry.click();
      expect(useAutomationsDialogStore.getState().request).toMatchObject({
        project: { kind: "key" },
        mode: "view",
      });

      resetAutomationsDialogStoreForTests();
      await clickNode("device", "This device");
      await inspector.getByRole("button", { name: "New schedule" }).click();
      expect(useAutomationsDialogStore.getState().request).toMatchObject({
        project: { kind: "checkout", environmentId: LOCAL_ENV, projectId: RYCO_LOCAL },
        mode: "new",
        environmentId: LOCAL_ENV,
      });

      resetAutomationsDialogStoreForTests();
      await clickNode("automation", "Nightly dependency check");
      await inspector.getByRole("button", { name: "Edit" }).click();
      expect(useAutomationsDialogStore.getState().request).toMatchObject({
        project: { kind: "checkout", environmentId: LOCAL_ENV, projectId: RYCO_LOCAL },
        automationId: "auto-nightly",
        mode: "edit",
      });
    });

    it("renames a thread from its card", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await screen
        .getByRole("button", { name: /Show 1 thread/ })
        .first()
        .click();
      await clickNode("thread", "Fix the relay reconnect");
      const inspector = screen.getByRole("complementary", { name: "Details" });
      await expect.element(inspector.getByRole("button", { name: "Archive thread" })).toBeVisible();
      await inspector.getByRole("textbox", { name: "Thread title" }).fill("Fix relay reconnects");
      await userEvent.keyboard("{Enter}");
      await expect
        .poll(() => dispatched.find((command) => command.type === "thread.meta.update"))
        .toMatchObject({ threadId: "thread-relay", title: "Fix relay reconnects" });
    });

    it("gathers workspaces like a file browser and archives them together", async () => {
      lifecycle.summaries[2] = workspaceSummary({
        worktreeId: WorktreeId.make("worktree-old"),
        title: "old-experiment",
        branch: "old-experiment",
        archivedAt: "2026-09-01T09:00:00.000Z",
        actions: [
          { action: "archive", available: false, blockers: [] },
          { action: "restore", available: true, blockers: [] },
          { action: "remove-checkout", available: true, blockers: [] },
          { action: "remove-stale-record", available: false, blockers: [] },
          { action: "recreate-checkout", available: false, blockers: [] },
        ],
      });
      const toast = vi.spyOn(toastManager, "add");
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await clickNode("workspace", "projects-page");
      await clickNodeWith(TOGGLE_KEY, "workspace", "old-experiment");
      const inspector = screen.getByRole("complementary", { name: "Details" });
      await expect.element(inspector.getByText("2 items selected")).toBeVisible();
      expect(selectedNodes()).toEqual([
        mapNode("workspace", "old-experiment").dataset.key,
        mapNode("workspace", "projects-page").dataset.key,
      ]);
      // Each action counts the cards it applies to; checkout changes stay one at a time.
      await expect
        .element(inspector.getByRole("button", { name: "Restore 1 workspace" }))
        .toBeVisible();
      await expect.element(inspector.getByText(/reviewed one workspace at a time/)).toBeVisible();
      await inspector.getByRole("button", { name: "Archive 1 workspace" }).click();
      await expect.poll(() => lifecycle.applied).toHaveLength(1);
      expect(lifecycle.applied[0]).toMatchObject({
        worktreeId: "worktree-projects",
        action: "archive",
      });
      await expect
        .poll(() => toast.mock.calls.map(([options]) => options.title))
        .toContain("Archived 1 workspace");
      toast.mockRestore();
      // Toggling a card out leaves the other inspected on its own.
      await clickNodeWith(TOGGLE_KEY, "workspace", "old-experiment");
      await expect.element(inspector.getByText("2 items selected")).not.toBeInTheDocument();
      expect(selectedNodes()).toEqual([mapNode("workspace", "projects-page").dataset.key]);
    });

    it("selects a run with shift-click, acts on each schedule it can, and every card with ⌘/ctrl-A", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await clickNode("automation", "Triage new issues");
      await clickNodeWith("Shift", "automation", "Summarise relay logs");
      const inspector = screen.getByRole("complementary", { name: "Details" });
      await expect.element(inspector.getByText("3 items selected")).toBeVisible();
      await expect
        .element(inspector.getByRole("button", { name: "Approve 1 due run" }))
        .toBeVisible();
      await expect
        .element(inspector.getByRole("button", { name: "Resume 1 schedule" }))
        .toBeVisible();
      await inspector.getByRole("button", { name: "Pause 2 schedules" }).click();
      await expect.poll(() => automationCentreFixture.commands).toHaveLength(2);
      expect(automationCentreFixture.commands.map((command) => command.input)).toMatchObject([
        { kind: "save", automationId: "auto-triage", definition: { enabled: false } },
        { kind: "save", automationId: "auto-nightly", definition: { enabled: false } },
      ]);

      await userEvent.keyboard(`{${TOGGLE_KEY}>}a{/${TOGGLE_KEY}}`);
      const cards = document.querySelectorAll(
        '[data-map-node="workspace"][data-state="live"], [data-map-node="automation"][data-state="live"]',
      ).length;
      await expect.poll(() => selectedNodes().length).toBe(cards);
      await expect.element(inspector.getByText(`${cards} items selected`)).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect
        .poll(() => document.querySelector(".map-inspector")?.hasAttribute("data-open"))
        .toBe(false);
      expect(selectedNodes()).toEqual([]);
    });

    it("moves several threads to Trash after one confirmation", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await screen.getByRole("button", { name: "Threads" }).click();
      await clickNode("thread", "Fix the relay reconnect");
      await clickNodeWith(TOGGLE_KEY, "thread", "Add a projects page");
      const inspector = screen.getByRole("complementary", { name: "Details" });
      await expect.element(inspector.getByText("2 items selected")).toBeVisible();
      await inspector.getByRole("button", { name: "Move 2 threads to Trash" }).click();
      // One question for the whole selection, not one per thread. (The fixture
      // seeds sidebar summaries only, so the trash itself has no thread to resolve.)
      await expect.poll(() => confirm.mock.calls.length).toBe(1);
      expect(confirm.mock.calls[0]?.[0]).toMatch(/^Move 2 threads to Trash\?/);
      confirm.mockRestore();
    });

    it("reaches the Danger zone from the bar's menu while on the map", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await screen.getByRole("button", { name: "Project actions" }).click();
      await page.getByRole("menuitem", { name: /Remove from this device/ }).click();
      expect(projectsTestSearchLog.last()).toMatchObject({ view: "settings", section: "danger" });
      await expect.element(screen.getByText("Remove from this device")).toBeVisible();
      await expect.poll(() => scrollRegion()?.scrollTop ?? 0).toBeGreaterThan(0);
    });

    it("switches to Settings from the bar and back to the map from Workspaces", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL, view: "map" });
      await screen.getByRole("radio", { name: "Settings" }).click();
      expect(projectsTestSearchLog.last()).toMatchObject({ view: "settings" });
      await expect.element(screen.getByRole("textbox", { name: "Project name" })).toBeVisible();
      await screen.getByRole("button", { name: "Open map" }).click();
      expect(projectsTestSearchLog.last()).toMatchObject({ view: "map" });
    });
  });

  describe("Review dialog", () => {
    it("reviews a menu's checkout change in a dialog, without leaving the page", async () => {
      await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL });
      await render(<WorkspaceReviewDialog />);
      const searches = projectsTestSearchLog.entries.length;
      openWorkspaceReviewDialog({
        environmentId: LOCAL_ENV,
        projectId: ProjectId.make(RYCO_LOCAL),
        worktreeId: WorktreeId.make("worktree-projects"),
        action: "remove-checkout",
        title: "projects-page",
      });
      const popup = page.getByTestId("workspace-review-dialog");
      await expect
        .element(
          popup.getByText("Remove 1 checkout, archive 1 conversation, keep history and branch."),
        )
        .toBeVisible();
      await popup.getByRole("button", { name: "Remove checkout" }).click();
      await expect.poll(() => lifecycle.applied).toHaveLength(1);
      await expect.poll(() => useWorkspaceReviewDialog.getState().target).toBeNull();
      expect(projectsTestSearchLog.entries).toHaveLength(searches);
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  describe("Danger zone", () => {
    it("is reachable from the bar's menu", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL });
      await screen.getByRole("button", { name: "Project actions" }).click();
      await page.getByRole("menuitem", { name: /Remove from this device/ }).click();
      expect(projectsTestSearchLog.last()).toMatchObject({ section: "danger" });
      await expect.poll(() => scrollRegion()?.scrollTop ?? 0).toBeGreaterThan(0);
    });

    it("removes the project after confirming, then moves to its other checkout", async () => {
      const screen = await renderPage({ env: LOCAL_ENV, project: RYCO_LOCAL });
      await screen.getByRole("button", { name: "Remove project" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect.element(dialog.getByText(/delete its 2 threads/)).toBeVisible();
      await dialog.getByRole("button", { name: "Remove project" }).click();
      await expect
        .poll(() => dispatched.at(-1))
        .toMatchObject({ type: "project.delete", projectId: RYCO_LOCAL, force: true });
      await expect
        .poll(() => projectsTestSearchLog.last())
        .toEqual({ env: STUDIO_ENV, project: RYCO_STUDIO, view: "settings" });
    });
  });
});
