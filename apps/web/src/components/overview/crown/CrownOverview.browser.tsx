import "../../../index.css";

import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorktreeId,
  type EnvironmentApi,
} from "@ryco/contracts";
import { useNotesStore } from "@ryco/client-runtime/state/notes";
import { createPortal } from "react-dom";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { PaneFocusContext } from "../../chat/PaneFocus";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../../environmentApi";
import { useWorktreeNotes, type WorktreeNotesTarget } from "../notes/useWorktreeNotes";

import {
  resetAppearancePreference,
  setAppearancePreference,
} from "../../../themes/appearancePreferences";
import type { OverviewPullRequestCheckRun, OverviewPullRequestState } from "../overviewTypes";
import { CROWN_FLYOUT_CLOSE_DELAY_MS } from "./crownLayout";
import {
  createFakeNotesNode,
  crownLayoutFixture,
  crownPullRequestFixture,
  makeCheckStatus,
  makeSubagent,
} from "./crownTestFixtures";
import type { CrownOverviewProps } from "./crownTypes";
import { CrownOverview } from "./CrownOverview";

const RUNNING_RUNS: ReadonlyArray<OverviewPullRequestCheckRun> = [
  { id: "fmt", name: "Format", statusLabel: "Succeeded", statusKind: "passed", tone: "success" },
  {
    id: "types",
    name: "Typecheck",
    statusLabel: "Running",
    statusKind: "running",
    tone: "running",
  },
  {
    id: "test",
    name: "Unit tests",
    statusLabel: "Pending",
    statusKind: "pending",
    tone: "pending",
  },
];

const FAILING_RUNS: ReadonlyArray<OverviewPullRequestCheckRun> = [
  RUNNING_RUNS[0]!,
  { id: "types", name: "Typecheck", statusLabel: "Failed", statusKind: "failed", tone: "failure" },
  RUNNING_RUNS[2]!,
];

function runningPullRequest(
  overrides: Partial<OverviewPullRequestState> = {},
): OverviewPullRequestState {
  return {
    ...crownPullRequestFixture,
    latestRuns: RUNNING_RUNS,
    checkStatus: makeCheckStatus("running", { headSha: "sha-1" }),
    ...overrides,
  };
}

const failingPullRequest = () =>
  runningPullRequest({
    latestRuns: FAILING_RUNS,
    checkStatus: makeCheckStatus("failed", { headSha: "sha-1", failed: ["Typecheck"] }),
  });

/** A portaled popup opened from inside the card (like a branch picker menu). */
function PortalProbe() {
  return createPortal(
    <button type="button" data-testid="portal-probe">
      Portaled item
    </button>,
    document.body,
  );
}

function crownProps(overrides: Partial<CrownOverviewProps> = {}): CrownOverviewProps {
  return {
    ...crownLayoutFixture({
      pullRequest: runningPullRequest(),
      branchControl: <PortalProbe />,
    }),
    threadTitle: "Overview rail",
    readiness: { remoteStatus: true, pullRequestLookup: true },
    isGitRepo: true,
    latestTurn: null,
    turnSettled: true,
    agentRunning: true,
    scopeKey: "thread-1|/repo",
    userGitActionActive: false,
    ...overrides,
  };
}

const NOTES_ENV = EnvironmentId.make("env-crown-notes");
const NOTES_PROJECT = ProjectId.make("project-crown-notes");
const NOTES_WORKTREE = WorktreeId.make("wt-crown");
const notesNode = createFakeNotesNode(NOTES_PROJECT);
const NOTES_TARGET: WorktreeNotesTarget = {
  environmentId: NOTES_ENV,
  projectId: NOTES_PROJECT,
  checkout: { worktreeId: NOTES_WORKTREE, origin: "branch" },
  threadId: ThreadId.make("thread-crown"),
  available: true,
};

/** The crown bound to the fake node's notes through the real hook, as ChatOverviewPanel binds it. */
function CrownWithNotes(props: CrownOverviewProps & { readonly target: WorktreeNotesTarget }) {
  const { target, ...rest } = props;
  const notes = useWorktreeNotes(target);
  return <CrownOverview {...rest} notes={notes} />;
}

const mounts: Array<{ unmount: () => Promise<void> | void; host: HTMLElement }> = [];

async function mountCrown(
  initial: CrownOverviewProps = crownProps(),
  options: {
    headerClearancePx?: number;
    paneFocused?: boolean;
    notesTarget?: WorktreeNotesTarget;
  } = {},
) {
  const host = document.createElement("div");
  host.style.position = "relative";
  host.style.width = "1200px";
  host.style.height = "800px";
  host.style.setProperty("--chat-header-clearance", `${options.headerClearancePx ?? 0}px`);
  const outside = document.createElement("button");
  outside.type = "button";
  outside.textContent = "Outside";
  outside.style.position = "absolute";
  outside.style.left = "20px";
  outside.style.top = "400px";
  document.body.append(host, outside);
  let props = initial;
  const paneFocused = options.paneFocused ?? true;
  const notesTarget = options.notesTarget;
  const view = (next: CrownOverviewProps) => (
    <PaneFocusContext value={paneFocused}>
      {notesTarget ? (
        <CrownWithNotes {...next} target={notesTarget} />
      ) : (
        <CrownOverview {...next} />
      )}
    </PaneFocusContext>
  );
  const screen = await render(view(props), { container: host });
  mounts.push({ unmount: () => screen.unmount(), host });
  mounts.push({ unmount: () => {}, host: outside });
  const root = () => host.querySelector<HTMLElement>('[data-slot="crown-overview"]')!;
  return {
    host,
    outside,
    root,
    island: () => host.querySelector<HTMLElement>('[data-slot="crown-island"]')!,
    rail: () => host.querySelector<HTMLElement>('[data-slot="crown-rail"]')!,
    flyout: () => host.querySelector<HTMLElement>('[data-slot="crown-flyout"]')!,
    railButton: (key: string) =>
      host.querySelector<HTMLElement>(`[data-slot="crown-rail"] [data-nav-key="${key}"]`)!,
    update: async (next: Partial<CrownOverviewProps>) => {
      props = { ...props, ...next };
      await screen.rerender(view(props));
    },
  };
}

const railKeys = (rail: HTMLElement) =>
  [...rail.querySelectorAll<HTMLElement>("[data-nav-key]")].map((button) => button.dataset.navKey);

const currentFlyoutLayer = (flyout: HTMLElement) =>
  flyout.querySelector<HTMLElement>('[data-slot="crown-flyout-layer"]:not([data-phase="leave"])');

describe("CrownOverview", () => {
  beforeEach(async () => {
    notesNode.reset();
    __setEnvironmentApiOverrideForTests(NOTES_ENV, {
      notes: notesNode.api,
    } as unknown as EnvironmentApi);
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    await page.viewport(1200, 800);
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetAppearancePreference("motion");
    for (const mount of mounts.splice(0).toReversed()) {
      await mount.unmount();
      mount.host.remove();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    useNotesStore.setState({ byKey: {} });
    __resetEnvironmentApiOverridesForTests();
  });

  it("renders the rail icons in order and hides the git group outside a repository", async () => {
    const crown = await mountCrown();
    expect(railKeys(crown.rail())).toEqual([
      "branch",
      "changes",
      "checks",
      "plan",
      "agents",
      "pr",
      "ship",
    ]);
    expect(crown.rail().querySelectorAll(".crown-rail-sep")).toHaveLength(1);
    await expect
      .element(page.getByRole("navigation", { name: "Overview", exact: true }))
      .toBeVisible();

    await crown.update({ isGitRepo: false });
    expect(railKeys(crown.rail())).toEqual(["plan", "agents"]);
    expect(crown.rail().querySelectorAll(".crown-rail-sep")).toHaveLength(0);
  });

  it("glides one flyout between hovered icons and closes it after the pointer leaves", async () => {
    const crown = await mountCrown();
    await page.getByRole("button", { name: "Checks", exact: true }).hover();

    await expect.poll(() => crown.flyout().dataset.open).toBe("true");
    expect(document.querySelectorAll('[data-slot="crown-flyout"]')).toHaveLength(1);
    expect(
      currentFlyoutLayer(crown.flyout())?.querySelector('[data-section="checks"]'),
    ).not.toBeNull();
    const checksTop = crown.flyout().style.top;

    await page.getByRole("button", { name: "Plan", exact: true }).hover();
    await expect
      .poll(() => currentFlyoutLayer(crown.flyout())?.querySelector('[data-section="plan"]'))
      .not.toBeNull();
    expect(document.querySelectorAll('[data-slot="crown-flyout"]')).toHaveLength(1);
    expect(crown.flyout().dataset.open).toBe("true");
    await expect.poll(() => crown.flyout().style.top).not.toBe(checksTop);
    expect(crown.railButton("plan").dataset.active).toBe("true");

    const leftAt = performance.now();
    await page.getByRole("button", { name: "Outside" }).hover();
    await expect.poll(() => crown.flyout().dataset.open).toBeUndefined();
    expect(performance.now() - leftAt).toBeGreaterThanOrEqual(CROWN_FLYOUT_CLOSE_DELAY_MS - 40);
  });

  it("labels the flyout as a preview and shows the branch read-only", async () => {
    const crown = await mountCrown();
    await page.getByRole("button", { name: "Branch", exact: true }).hover();
    await expect.poll(() => crown.flyout().dataset.open).toBe("true");

    expect(crown.flyout().hasAttribute("aria-hidden")).toBe(false);
    expect(crown.flyout().inert).toBe(false);
    await expect.element(page.getByRole("group", { name: "Branch preview" })).toBeVisible();
    // The stateful picker (here the portal probe) only mounts in the card.
    expect(document.querySelector('[data-testid="portal-probe"]')).toBeNull();
    expect(crown.flyout().textContent).toContain("Click to commit or push");

    await page.getByRole("button", { name: "Outside" }).hover();
    await expect.poll(() => crown.flyout().dataset.open).toBeUndefined();
    expect(crown.flyout().inert).toBe(true);
  });

  it("keeps a tall flyout below the chat header's clearance", async () => {
    const files = Array.from({ length: 60 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      insertions: 1,
      deletions: 0,
    }));
    const crown = await mountCrown(
      crownProps({ changes: { ...crownLayoutFixture().changes!, files } }),
      { headerClearancePx: 52 },
    );
    await page.getByRole("button", { name: "Push", exact: true }).hover();
    await page.getByRole("button", { name: "Changes", exact: true }).hover();
    await expect.poll(() => crown.flyout().dataset.open).toBe("true");
    await expect
      .poll(() => crown.flyout().getBoundingClientRect().top)
      .toBeGreaterThanOrEqual(crown.root().getBoundingClientRect().top - 0.5);
    expect(crown.flyout().getBoundingClientRect().top).toBeGreaterThanOrEqual(
      crown.host.getBoundingClientRect().top + 52,
    );
  });

  it("returns focus to the rail icon when a mouse-opened card collapses on Escape", async () => {
    const crown = await mountCrown();
    await page.getByRole("button", { name: "Checks", exact: true }).click();
    await expect.poll(() => crown.island().dataset.mode).toBe("card");

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => crown.island().dataset.mode).toBe("dot");
    await expect.poll(() => document.activeElement).toBe(crown.railButton("checks"));
  });

  it("ignores Escape in a split pane that does not have focus", async () => {
    const crown = await mountCrown(crownProps(), { paneFocused: false });
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await expect.poll(() => crown.island().dataset.mode).toBe("card");

    await userEvent.keyboard("{Escape}");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(crown.island().dataset.mode).toBe("card");
  });

  it("describes each rail icon's state to assistive tech", async () => {
    const crown = await mountCrown();
    expect(crown.railButton("checks").getAttribute("aria-description")).toBe(
      "Running, 1 of 3 passed",
    );
    expect(crown.railButton("changes").getAttribute("aria-description")).toBe("4 files changed");
    expect(crown.railButton("ship").getAttribute("aria-description")).toBe("2 commits to push");
  });

  it("opens the card from a rail icon and switches sections on the spine", async () => {
    const crown = await mountCrown();
    await page.getByRole("button", { name: "Changes", exact: true }).click();

    await expect.poll(() => crown.island().dataset.mode).toBe("card");
    await expect.element(page.getByRole("region", { name: "Changes" })).toBeVisible();
    expect(crown.rail().hasAttribute("inert")).toBe(true);
    expect(crown.flyout().dataset.open).toBeUndefined();
    const spine = page.getByRole("navigation", { name: "Overview sections" });
    await expect
      .element(spine.getByRole("button", { name: "Changes", exact: true }))
      .toHaveAttribute("aria-current", "true");

    await spine.getByRole("button", { name: "Plan", exact: true }).click();
    await expect.element(page.getByRole("region", { name: "Plan" })).toBeVisible();
    await expect
      .element(spine.getByRole("button", { name: "Plan", exact: true }))
      .toHaveAttribute("aria-current", "true");
    expect(
      crown.host.querySelector('[data-slot="crown-card-detail"] [data-section="plan"]'),
    ).not.toBeNull();
  });

  it("collapses the card on Escape, the close button and an outside press", async () => {
    const crown = await mountCrown();
    const openOn = async (name: string) => {
      await page.getByRole("button", { name, exact: true }).click();
      await expect.poll(() => crown.island().dataset.mode).toBe("card");
    };

    await openOn("Changes");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => crown.island().dataset.mode).toBe("dot");
    expect(crown.rail().hasAttribute("inert")).toBe(false);

    await openOn("Plan");
    await page.getByRole("button", { name: "Collapse overview" }).click();
    await expect.poll(() => crown.island().dataset.mode).toBe("dot");

    // A press inside a popup portaled out of the card still counts as inside.
    await openOn("Branch");
    await page.getByTestId("portal-probe").click();
    expect(crown.island().dataset.mode).toBe("card");

    await page.getByRole("button", { name: "Outside" }).click();
    await expect.poll(() => crown.island().dataset.mode).toBe("dot");
  });

  it("moves focus into a keyboard-opened card and back to its icon on collapse", async () => {
    const crown = await mountCrown();
    crown.railButton("checks").focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => crown.island().dataset.mode).toBe("card");
    await expect.element(page.getByRole("button", { name: "Collapse overview" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.activeElement).toBe(crown.railButton("checks"));
  });

  it("morphs into a queued alert on a check failure and opens its section from View", async () => {
    const crown = await mountCrown();
    await crown.update({ pullRequest: failingPullRequest() });

    await expect.poll(() => crown.island().dataset.mode).toBe("alert");
    const alert = crown.host.querySelector<HTMLElement>('[data-slot="crown-alert"]')!;
    expect(alert.dataset.visible).toBe("true");
    expect(alert.textContent).toContain("1 check failing");
    expect(alert.textContent).toContain("Typecheck · just now");
    // Screen readers hear the alert through the live region.
    await expect.element(page.getByRole("status")).toHaveTextContent("1 check failing");
    expect(crown.island().style.width).not.toBe("48px");

    await crown.update({
      subagents: [
        ...crownLayoutFixture().subagents!,
        makeSubagent("subagent:a", "running", "Fixer"),
        makeSubagent("subagent:b", "running", "Reviewer"),
      ],
    });
    await expect
      .poll(() => crown.host.querySelector('[data-slot="crown-queue"]')?.textContent)
      .toBe("+2");

    await page.getByRole("button", { name: "View 1 check failing" }).click();
    await expect.poll(() => crown.island().dataset.mode).toBe("card");
    await expect.element(page.getByRole("region", { name: "Checks" })).toBeVisible();
    // Opening the card drops the queue.
    expect(crown.host.querySelector('[data-slot="crown-queue"]')).toBeNull();
  });

  it("holds an alert while its View button has focus, then hands focus to the face", async () => {
    const crown = await mountCrown();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await crown.update({ pullRequest: failingPullRequest() });
    await expect.poll(() => crown.island().dataset.mode).toBe("alert");

    const view = crown.host.querySelector<HTMLElement>(".crown-alert-view")!;
    view.focus();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(crown.island().dataset.mode).toBe("alert");
    vi.useRealTimers();

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => crown.island().dataset.mode).toBe("dot");
    await expect
      .poll(() => document.activeElement)
      .toBe(crown.host.querySelector('[data-slot="crown-face"]'));
  });

  it("folds an alert back into the face when its dwell expires", async () => {
    const crown = await mountCrown();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await crown.update({ pullRequest: failingPullRequest() });
    await expect.poll(() => crown.island().dataset.mode).toBe("alert");

    await vi.advanceTimersByTimeAsync(2_800);
    expect(crown.island().dataset.mode).toBe("alert");
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    await expect.poll(() => crown.island().dataset.mode).toBe("dot");
  });

  it("pops badges out while keeping their last value and colours the PR icon by state", async () => {
    const crown = await mountCrown();
    const badge = () => crown.railButton("changes").querySelector<HTMLElement>(".crown-badge")!;
    expect(badge().dataset.empty).toBeUndefined();
    expect(badge().textContent).toBe("4");

    await crown.update({ changes: { ...crownLayoutFixture().changes!, files: [] } });
    expect(badge().dataset.empty).toBe("true");
    expect(badge().textContent).toBe("4");

    expect(crown.railButton("pr").dataset.state).toBe("open");
    await crown.update({ pullRequest: runningPullRequest({ isDraft: true }) });
    expect(crown.railButton("pr").dataset.state).toBe("draft");
    await crown.update({ pullRequest: runningPullRequest({ state: "merged" }) });
    expect(crown.railButton("pr").dataset.state).toBe("merged");
    await crown.update({ pullRequest: runningPullRequest({ hasMergeConflicts: true }) });
    expect(crown.railButton("pr").dataset.state).toBe("conflict");
  });

  it("stays island-dark in the light theme", async () => {
    const crown = await mountCrown();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(getComputedStyle(crown.island()).backgroundColor).toBe("rgb(13, 13, 14)");
    expect(getComputedStyle(crown.rail()).backgroundColor).toBe("rgb(13, 13, 14)");

    // Colour utilities inside the island resolve against the pinned dark tokens.
    const probe = (parent: HTMLElement) => {
      const span = document.createElement("span");
      span.className = "text-muted-foreground";
      parent.append(span);
      const color = getComputedStyle(span).color;
      span.remove();
      return color;
    };
    expect(probe(crown.root())).not.toBe(probe(document.body));
  });

  it("drops every animation under the in-app reduced motion preference", async () => {
    setAppearancePreference("motion", "reduce");
    const crown = await mountCrown();
    expect(crown.root().dataset.motion).toBe("reduced");

    const glyph = crown.host.querySelector<HTMLElement>(".crown-face-glyph")!;
    expect(glyph.dataset.glyph).toBe("spinner");
    await crown.update({ pullRequest: failingPullRequest() });
    await expect.poll(() => glyph.dataset.glyph).toBe("x");
    await expect.poll(() => crown.island().dataset.mode).toBe("alert");

    const running = crown
      .root()
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running");
    expect(running).toEqual([]);
  });

  describe("notes", () => {
    const notesItems = (host: HTMLElement) =>
      [...host.querySelectorAll<HTMLElement>('[data-slot="crown-card-detail"] [data-note-id]')].map(
        (item) => item.dataset.noteId,
      );

    it("shows the Notes icon with a note-coloured count only while notes are available", async () => {
      notesNode.seed("pinned", { scope: "project" });
      notesNode.seed("here", { worktreeId: NOTES_WORKTREE });
      notesNode.seed("elsewhere", { worktreeId: WorktreeId.make("wt-other") });
      const crown = await mountCrown(crownProps(), { notesTarget: NOTES_TARGET });

      await expect.poll(() => railKeys(crown.rail())).toContain("notes");
      expect(railKeys(crown.rail()).slice(-2)).toEqual(["notes", "ship"]);
      const badge = () => crown.railButton("notes").querySelector<HTMLElement>(".crown-badge")!;
      await expect.poll(() => badge().textContent).toBe("2");
      expect(badge().dataset.variant).toBe("note");
      expect(badge().dataset.empty).toBeUndefined();

      const unavailable = await mountCrown(crownProps(), {
        notesTarget: { ...NOTES_TARGET, available: false },
      });
      expect(railKeys(unavailable.rail())).not.toContain("notes");
    });

    it("opens the Notes section, re-reads the notes and saves through the composer", async () => {
      notesNode.seed("here", { worktreeId: NOTES_WORKTREE, body: "Existing note" });
      const crown = await mountCrown(crownProps(), { notesTarget: NOTES_TARGET });
      await expect.poll(() => railKeys(crown.rail())).toContain("notes");
      const readsBefore = notesNode.node.reads;

      await page.getByRole("button", { name: "Notes", exact: true }).click();
      await expect.poll(() => crown.island().dataset.mode).toBe("card");
      await expect.element(page.getByRole("region", { name: "Notes" })).toBeVisible();
      await expect.poll(() => notesNode.node.reads).toBeGreaterThan(readsBefore);
      const composer = page.getByRole("textbox", { name: "New note" });
      await expect.element(composer).toHaveFocus();
      expect(notesItems(crown.host)).toEqual(["here"]);

      await composer.fill("[ ] Wire the crown");
      await userEvent.keyboard("{ControlOrMeta>}{Enter}{/ControlOrMeta}");
      await expect.poll(() => notesNode.node.commands.length).toBe(1);
      const created = notesNode.node.commands[0]!;
      expect(created).toMatchObject({
        kind: "create",
        worktreeId: NOTES_WORKTREE,
        scope: "worktree",
        body: "[ ] Wire the crown",
      });
      await expect.poll(() => notesItems(crown.host)).toEqual([created.noteId, "here"]);
      await expect
        .poll(() => crown.railButton("notes").querySelector(".crown-badge")?.textContent)
        .toBe("2");
      // Escape in the composer only blurs; the card stays open.
      await composer.click();
      await userEvent.keyboard("{Escape}");
      expect(crown.island().dataset.mode).toBe("card");
      expect(document.activeElement).not.toBe(composer.element());
    });

    it("announces a note saved elsewhere and opens it highlighted from View", async () => {
      notesNode.seed("here", { worktreeId: NOTES_WORKTREE });
      const crown = await mountCrown(crownProps(), { notesTarget: NOTES_TARGET });
      await expect.poll(() => notesNode.node.reads).toBe(1);
      await expect.poll(() => railKeys(crown.rail())).toContain("notes");

      const remote = notesNode.seed("remote", {
        worktreeId: NOTES_WORKTREE,
        body: "Hosted service worker must never cache notes",
      });
      window.dispatchEvent(new Event("focus"));

      await expect.poll(() => crown.island().dataset.mode).toBe("alert");
      const alert = crown.host.querySelector<HTMLElement>('[data-slot="crown-alert"]')!;
      expect(alert.textContent).toContain("Note saved");
      expect(alert.textContent).toContain("Hosted service worker must never cache…");

      // The island must never scroll while it morphs into the card (only the detail may).
      const islandScrollTops: number[] = [];
      let frame = 0;
      const sample = () => {
        islandScrollTops.push(crown.island().scrollTop);
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      await page.getByRole("button", { name: "View Note saved" }).click();
      await expect.poll(() => crown.island().dataset.mode).toBe("card");
      await expect.element(page.getByRole("region", { name: "Notes" })).toBeVisible();
      await expect
        .poll(() =>
          crown.host
            .querySelector<HTMLElement>(`[data-note-id="${remote.noteId}"]`)
            ?.hasAttribute("data-highlight"),
        )
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 900));
      cancelAnimationFrame(frame);
      expect(islandScrollTops.length).toBeGreaterThan(10);
      expect(Math.max(...islandScrollTops, crown.island().scrollTop)).toBe(0);
    });

    it("does not announce this client's own save", async () => {
      const crown = await mountCrown(crownProps(), { notesTarget: NOTES_TARGET });
      await expect.poll(() => notesNode.node.reads).toBe(1);
      await expect.poll(() => railKeys(crown.rail())).toContain("notes");

      await page.getByRole("button", { name: "Notes", exact: true }).hover();
      await expect.poll(() => crown.flyout().dataset.open).toBe("true");
      const composer = crown.flyout().querySelector<HTMLTextAreaElement>("textarea")!;
      // The preview keeps the pane's own header.
      expect(crown.flyout().querySelector(".notes-compact")).toBeNull();
      await userEvent.click(composer);
      await userEvent.type(composer, "Mine");
      // Leaving the flyout while composing keeps it open.
      await page.getByRole("button", { name: "Outside" }).hover();
      await new Promise((resolve) => setTimeout(resolve, CROWN_FLYOUT_CLOSE_DELAY_MS + 120));
      expect(crown.flyout().dataset.open).toBe("true");
      // Tabbing on to Save (keyboard focus inside) keeps holding it, draft and all.
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement?.classList.contains("notes-save")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, CROWN_FLYOUT_CLOSE_DELAY_MS + 120));
      expect(crown.flyout().dataset.open).toBe("true");
      expect(composer.value).toBe("Mine");
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      expect(document.activeElement).toBe(composer);

      await userEvent.keyboard("{ControlOrMeta>}{Enter}{/ControlOrMeta}");
      await expect.poll(() => notesNode.node.notes.length).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(crown.island().dataset.mode).toBe("dot");

      // Focus leaving the composer lets the preview close.
      await page.getByRole("button", { name: "Outside" }).click();
      await expect.poll(() => crown.flyout().dataset.open).toBeUndefined();
    });
  });
});
