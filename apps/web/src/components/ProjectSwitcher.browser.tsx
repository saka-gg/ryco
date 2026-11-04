import "../index.css";

import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { WorkspaceMachineCatalogEntry } from "@ryco/client-runtime/state/workspace";
import { DraftId } from "@ryco/client-runtime/state/composer";
import { ProjectId, ThreadId, type VcsStatusResult } from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, render } from "vitest-browser-react";

// Spied, not replaced: every export keeps its real behaviour unless a test
// stubs it (the hosted test reads a ready Hub workspace through it).
vi.mock("../hostedHub/hostedConnectionCoordinator", { spy: true });

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import {
  readHostedWorkspaceState,
  type HostedWorkspaceSnapshot,
} from "../hostedHub/hostedConnectionCoordinator";
import { hostedDraftTargetController } from "../hooks/useHostedDraftExecutionTarget";
import { refreshGitStatus, resetGitStatusStateForTests } from "../lib/gitStatusState";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { defaultQueryClient } from "../rpc/queryClient";
import { NewThreadWorkLocation } from "./chat/NewThreadWorkLocation";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { nodePathHintsQueryKey } from "./projectNodes/nodePathQueries";
import {
  requestProjectSelectorOpen,
  resetProjectNodesDialogStoreForTests,
  useProjectNodesDialogStore,
} from "./projectNodes/projectNodesDialogStore";
import {
  defaultFixtureEnvironments,
  FIXTURE_NOW_ISO,
  fixtureProject,
  HUB_LOCAL,
  LOCAL_ENV,
  RYCO_IDENTITY,
  RYCO_LOCAL,
  RYCO_STUDIO,
  STUDIO_ENV,
  resetProjectsFixtureState,
  seedProjectsFixtureStore,
} from "./projects/testing/projectFixtures";

const DRAFT_ID = DraftId.make("draft-project-selector");
const PROMPT = "Keep this unsent prompt while switching projects.";

function seedDraft() {
  const drafts = useComposerDraftStore.getState();
  drafts.setLogicalProjectDraftThreadId(
    "github.com/sak0a/ryco",
    scopeProjectRef(LOCAL_ENV, RYCO_LOCAL),
    DRAFT_ID,
    { branch: "main", envMode: "local" },
  );
  drafts.setPrompt(DRAFT_ID, PROMPT);
}

function resetDrafts() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

function setStudioOffline() {
  useSavedEnvironmentRuntimeStore.setState((state) => ({
    byId: {
      ...state.byId,
      [STUDIO_ENV]: {
        ...state.byId[STUDIO_ENV]!,
        connectionState: "disconnected",
        disconnectedAt: FIXTURE_NOW_ISO,
      },
    },
  }));
}

async function renderSelector(
  options: {
    readonly openOnRequest?: boolean;
    readonly activeProjectId?: typeof RYCO_LOCAL;
    /** Lays the headline out as the new-thread hero does: centered, as wide as its text. */
    readonly hero?: boolean;
    readonly viewportWidth?: number;
  } = {},
) {
  await page.viewport(options.viewportWidth ?? 1100, 800);
  const screen = await render(
    <AppAtomRegistryProvider>
      <div className={options.hero ? "flex flex-col items-center p-10" : "p-10"}>
        <h1 className={options.hero ? "text-balance text-center text-3xl" : "text-2xl"}>
          What should we do in{" "}
          <ProjectSwitcher
            activeProjectId={options.activeProjectId ?? RYCO_LOCAL}
            activeProjectEnvironmentId={LOCAL_ENV}
            appearance="headline"
            draftId={DRAFT_ID}
            label="ryco"
            openOnRequest={options.openOnRequest ?? false}
          />
          ?
        </h1>
      </div>
    </AppAtomRegistryProvider>,
  );
  return screen;
}

/** Status some other surface already streamed for a checkout (no watch is opened). */
async function seedLoadedStatus(environmentId: typeof LOCAL_ENV, cwd: string) {
  const status: VcsStatusResult = {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "task/copy-clone",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [
        { path: "a.ts", insertions: 1, deletions: 0 },
        { path: "b.ts", insertions: 2, deletions: 1 },
      ],
      insertions: 3,
      deletions: 1,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 3,
    pr: null,
  };
  await refreshGitStatus(
    { environmentId, cwd },
    { refreshStatus: async () => status, onStatus: () => () => undefined },
  );
}

async function openSelector() {
  await page.getByRole("combobox", { name: "Switch project (currently ryco)" }).click();
  await expect.element(page.getByTestId("project-selector")).toBeVisible();
}

/** Each option's visible text, without the monograms' initials (SVG text). */
function optionTexts(): string[] {
  return Array.from(
    document.querySelectorAll('[data-testid="project-selector"] [role="option"]'),
  ).map((option) => {
    const copy = option.cloneNode(true) as HTMLElement;
    for (const svg of copy.querySelectorAll("svg")) svg.remove();
    return copy.textContent?.replace(/\s+/g, " ").trim() ?? "";
  });
}

/** The highlighted row's own text (see `optionTexts`); null with nothing highlighted. */
function highlightedText(): string | null {
  const index = Array.from(
    document.querySelectorAll('[data-testid="project-selector"] [role="option"]'),
  ).findIndex((option) => option.hasAttribute("data-highlighted"));
  return index === -1 ? null : (optionTexts()[index] ?? null);
}

/** The background a row is painted with. */
function backgroundOf(element: Element): string {
  return getComputedStyle(element).backgroundColor;
}

/** Presses a key `times` times, one press after the other as a person would. */
async function press(key: string, times = 1) {
  for (let count = 0; count < times; count += 1) await userEvent.keyboard(`{${key}}`);
}

function draftSession() {
  return useComposerDraftStore.getState().getDraftSession(DRAFT_ID);
}

describe("ProjectSwitcher", () => {
  beforeEach(() => {
    seedProjectsFixtureStore();
    seedDraft();
  });
  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    resetDrafts();
    resetProjectsFixtureState();
    resetProjectNodesDialogStoreForTests();
    resetGitStatusStateForTests();
    // Status atoms outlive the reset above once their keys are forgotten; a
    // fresh registry drops the status seeded for one test.
    resetAppAtomRegistryForTests();
    useCommandPaletteStore.setState({ open: false, openIntent: null });
  });

  it("lists the repository once across both nodes, with each node's checkout", async () => {
    const screen = await renderSelector();
    await openSelector();
    // The draft's own project starts expanded into one row per node.
    await expect
      .poll(optionTexts)
      .toEqual([
        "ryco2 nodes · ~/Code/ryco",
        "MacBook Pro~/Code/ryco",
        "Studio~/src/ryco",
        "ryco-hubMacBook Pro · ~/Code/ryco-hub",
        "scratchMacBook Pro · ~/tmp/scratch",
      ]);
    const checkouts = screen.container.ownerDocument.querySelectorAll(
      '[data-testid="project-selector-checkout"]',
    );
    expect(checkouts[0]?.getAttribute("aria-selected")).toBe("true");
    expect(checkouts[0]?.querySelector("svg.lucide-check")).not.toBeNull();
    const ryco = page.getByRole("option", { name: /^ryco 2 nodes/ });
    await expect.element(ryco).toHaveAttribute("aria-expanded", "true");
    await expect.element(ryco).toHaveAttribute("aria-selected", "false");
    // Collapsing folds the per-node rows away; the project row then stands for the draft.
    await page.getByTestId("project-selector-expand").click();
    await expect.poll(() => optionTexts().length).toBe(3);
    await expect.element(ryco).toHaveAttribute("aria-expanded", "false");
    await expect.element(ryco).toHaveAttribute("aria-selected", "true");
    // A project on one node has nothing to expand.
    const hub = page.getByRole("option", { name: /^ryco-hub/ });
    expect(hub.element().hasAttribute("aria-expanded")).toBe(false);
    await expect.element(hub).toHaveAttribute("aria-selected", "false");
  });

  it("marks the draft's own row selected when its project is on one node", async () => {
    await renderSelector({ activeProjectId: HUB_LOCAL });
    await openSelector();
    const hub = page.getByRole("option", { name: /^ryco-hub/ });
    await expect.element(hub).toHaveAttribute("aria-selected", "true");
    const selected = document.querySelectorAll(
      '[data-testid="project-selector"] [role="option"][aria-selected="true"]',
    );
    expect(selected).toHaveLength(1);
    expect(hub.element().hasAttribute("data-selected")).toBe(true);

    // Selected is for assistive tech: at rest the row is painted like any
    // other (only its bold name says current), so it never reads as a
    // keyboard highlight that is not there.
    const ryco = page.getByRole("option", { name: /^ryco 2 nodes/ });
    const scratch = page.getByRole("option", { name: /^scratch/ });
    expect(highlightedText()).toBeNull();
    expect(backgroundOf(hub.element())).toBe(backgroundOf(scratch.element()));
    expect(hub.element().querySelector(".font-semibold")?.textContent).toBe("ryco-hub");

    // Highlighted, it takes the same tint as any other highlighted row.
    await press("ArrowDown");
    await expect.poll(highlightedText).toBe("ryco2 nodes · ~/Code/ryco");
    const highlightBackground = backgroundOf(ryco.element());
    expect(highlightBackground).not.toBe(backgroundOf(scratch.element()));
    await press("ArrowDown");
    await expect.poll(highlightedText).toBe("ryco-hubMacBook Pro · ~/Code/ryco-hub");
    expect(backgroundOf(hub.element())).toBe(highlightBackground);
  });

  it("opens when the add-project dialog asks to show its project there", async () => {
    await renderSelector({ openOnRequest: true });
    // A request for another checkout leaves this selector closed.
    requestProjectSelectorOpen(scopeProjectRef(STUDIO_ENV, RYCO_STUDIO));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector('[data-testid="project-selector"]')).toBeNull();

    requestProjectSelectorOpen(scopeProjectRef(LOCAL_ENV, RYCO_LOCAL));
    await expect.element(page.getByTestId("project-selector")).toBeVisible();
    await expect.poll(() => optionTexts()[0]).toBe("ryco2 nodes · ~/Code/ryco");

    // Closing ends the request, so the selector stays closed afterwards.
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector('[data-testid="project-selector"]')).toBeNull();
    expect(useProjectNodesDialogStore.getState().projectSelectorOpenRequest).toBeNull();
  });

  it("centers the headline's popup under the headline and keeps it on screen", async () => {
    for (const viewportWidth of [1100, 360]) {
      const screen = await renderSelector({ hero: true, viewportWidth });
      await openSelector();
      const popup = page.getByTestId("project-selector").element();
      const headline = document.querySelector("h1")!.getBoundingClientRect();
      const headlineCenter = headline.left + headline.width / 2;
      const popupBox = () => popup.getBoundingClientRect();
      if (viewportWidth === 1100) {
        // Centered under the headline, not opened from the project name's start
        // (which sits right of center).
        await expect
          .poll(() => Math.abs(popupBox().left + popupBox().width / 2 - headlineCenter))
          .toBeLessThanOrEqual(1);
        // Its own 440 px (the list inside its border), not the (wider) headline's.
        expect(popupBox().width).toBeGreaterThan(430);
        expect(popupBox().width).toBeLessThanOrEqual(440);
      }
      await expect.poll(() => popupBox().left).toBeGreaterThanOrEqual(0);
      expect(popupBox().right).toBeLessThanOrEqual(viewportWidth);
      await userEvent.keyboard("{Escape}");
      await screen.unmount();
    }
  });

  it("disables an offline node's checkout with the reason", async () => {
    setStudioOffline();
    await renderSelector();
    await openSelector();
    const studio = page.getByRole("option", { name: /^Studio/ });
    await expect.element(studio).toHaveAttribute("aria-disabled", "true");
    await expect.element(studio).toHaveAttribute("title", "Studio is offline");
    expect(studio.element().textContent).toContain("offline");
    await studio.click({ force: true });
    expect(draftSession()?.environmentId).toBe(LOCAL_ENV);
    expect(draftSession()?.projectId).toBe(RYCO_LOCAL);
  });

  it("shows branch, changes and commits behind only from status already loaded", async () => {
    await seedLoadedStatus(LOCAL_ENV, "/Users/me/Code/ryco");
    await renderSelector();
    await openSelector();
    await expect.poll(optionTexts).toContain("MacBook Pro~/Code/rycotask/copy-clone2 changed↓3");
    // Nothing is loaded for the Studio checkout, so it shows no meta at all.
    expect(optionTexts()).toContain("Studio~/src/ryco");
  });

  it("filters by node with chips and with an @node word", async () => {
    await renderSelector();
    await openSelector();
    const chips = page.getByRole("radiogroup", { name: "Filter by node" });
    await expect.element(chips.getByRole("radio", { name: /All\s*3/ })).toBeChecked();
    await expect.element(chips.getByRole("radio", { name: /MacBook Pro\s*3/ })).toBeVisible();
    await chips.getByRole("radio", { name: /Studio\s*1/ }).click();
    await expect.poll(optionTexts).toEqual(["rycoStudio · ~/src/ryco"]);
    await chips.getByRole("radio", { name: /All/ }).click();
    await expect.poll(() => optionTexts().length).toBe(5);

    const search = page.getByRole("combobox", { name: "Search projects" });
    await userEvent.fill(search, "@stu");
    await expect.poll(optionTexts).toEqual(["rycoStudio · ~/src/ryco"]);
    await expect.element(chips.getByRole("radio", { name: /Studio/ })).toBeChecked();
    await userEvent.fill(search, "@nowhere");
    await expect.element(page.getByText("No project matches.")).toBeVisible();
  });

  it("matches checkout paths, expanding the project and marking the match", async () => {
    await renderSelector();
    await openSelector();
    await page.getByTestId("project-selector-expand").click();
    await expect.poll(() => optionTexts().length).toBe(3);
    await userEvent.fill(page.getByRole("combobox", { name: "Search projects" }), "src/ry");
    await expect
      .poll(optionTexts)
      .toEqual(["ryco2 nodes · ~/Code/ryco", "MacBook Pro~/Code/ryco", "Studio~/src/ryco"]);
    const marks = Array.from(
      document.querySelectorAll('[data-testid="project-selector-checkout"] mark'),
    ).map((mark) => mark.textContent);
    expect(marks).toEqual(["src/ry"]);
  });

  it("ranks matches best first, by letters in order too", async () => {
    await renderSelector();
    await openSelector();
    const search = page.getByRole("combobox", { name: "Search projects" });
    await userEvent.fill(search, "hub");
    await expect.poll(optionTexts).toEqual(["ryco-hubMacBook Pro · ~/Code/ryco-hub"]);
    await userEvent.fill(search, "scr");
    await expect.poll(optionTexts).toEqual(["scratchMacBook Pro · ~/tmp/scratch"]);
    // Letters in order, with gaps between them.
    await userEvent.fill(search, "rhb");
    await expect.poll(optionTexts).toEqual(["ryco-hubMacBook Pro · ~/Code/ryco-hub"]);
    // The exact name first; a longer name it starts comes after.
    await userEvent.fill(search, "ryco");
    await expect
      .poll(optionTexts)
      .toEqual([
        "ryco2 nodes · ~/Code/ryco",
        "MacBook Pro~/Code/ryco",
        "Studio~/src/ryco",
        "ryco-hubMacBook Pro · ~/Code/ryco-hub",
      ]);
  });

  it("fits the node column to the longest name and cuts paths at their start", async () => {
    const environments = defaultFixtureEnvironments();
    seedProjectsFixtureStore({
      ...environments,
      [STUDIO_ENV]: {
        ...environments[STUDIO_ENV]!,
        projects: [
          fixtureProject({
            id: RYCO_STUDIO,
            environmentId: STUDIO_ENV,
            name: "ryco",
            cwd: "/root/code/clients/acme/monorepo/services/gateway/ryco",
            repositoryIdentity: RYCO_IDENTITY,
          }),
        ],
      },
    });
    useSavedEnvironmentRegistryStore.setState((state) => ({
      byId: {
        ...state.byId,
        [STUDIO_ENV]: { ...state.byId[STUDIO_ENV]!, label: "Mac Studio M4 Max von Laurin" },
      },
    }));
    // The node's path hints, as a picker already read them: the selector asks for nothing.
    defaultQueryClient.setQueryData(nodePathHintsQueryKey(STUDIO_ENV), {
      homeDirectory: "/root",
      pathSeparator: "/",
      defaultProjectDirectory: "/root/code",
      defaultProjectDirectorySource: "well-known",
      codeRoots: [],
      workspaceAccessRoot: null,
    });
    try {
      await renderSelector();
      await openSelector();
      const rows = () =>
        Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="project-selector-checkout"]'),
        );
      await expect.poll(() => rows().length).toBe(2);
      const labels = rows().map((row) => row.querySelector<HTMLElement>("[data-node-label]")!);
      const paths = rows().map((row) => row.querySelector<HTMLElement>('[data-slot="node-path"]')!);
      // One column for both rows, wider than the old 92 px, at most 160 px.
      const widths = labels.map((label) => label.getBoundingClientRect().width);
      expect(widths[0]).toBe(widths[1]);
      expect(widths[0]).toBeGreaterThan(92);
      expect(widths[0]).toBeLessThanOrEqual(160);
      // "MacBook Pro" fits whole; only a name past the cap is cut.
      expect(labels[0]!.scrollWidth).toBeLessThanOrEqual(labels[0]!.clientWidth);
      // Home-relative under the node's own home, cut at the start: the folder's name shows.
      expect(paths[1]!.textContent).toBe("~/code/clients/acme/monorepo/services/gateway/ryco");
      expect(paths[1]!.title).toBe("/root/code/clients/acme/monorepo/services/gateway/ryco");
      expect(paths[1]!.scrollWidth).toBeGreaterThan(paths[1]!.clientWidth);
      expect(getComputedStyle(paths[1]!).direction).toBe("rtl");
      const box = paths[1]!.getBoundingClientRect();
      const text = paths[1]!.firstElementChild!.getBoundingClientRect();
      // The text's end lines up with the box's end; its start runs off the box's start.
      expect(Math.abs(text.right - box.right)).toBeLessThan(2);
      expect(text.left).toBeLessThan(box.left);
    } finally {
      defaultQueryClient.clear();
    }
  });

  it("moves the draft to another node's checkout, keeping what was typed", async () => {
    await renderSelector();
    await openSelector();
    await page.getByRole("option", { name: /^Studio/ }).click();
    await vi.waitFor(() => {
      expect(draftSession()).toMatchObject({
        environmentId: STUDIO_ENV,
        projectId: RYCO_STUDIO,
        branch: null,
      });
    });
    expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toBe(PROMPT);
  });

  it("picks with the keyboard and folds a project with ←", async () => {
    await renderSelector();
    await openSelector();
    const search = page.getByRole("combobox", { name: "Search projects" });
    await expect.poll(() => optionTexts().length).toBe(5);
    // Opening moves focus into the search field, which owns the keyboard.
    await expect.element(search).toHaveFocus();
    // ↓ highlights a row of the expanded project; ← folds the project.
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .poll(() => document.querySelector("[data-highlighted][data-selector-item]") !== null)
      .toBe(true);
    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => optionTexts().length).toBe(3);
    await userEvent.fill(search, "hub");
    await expect.poll(optionTexts).toEqual(["ryco-hubMacBook Pro · ~/Code/ryco-hub"]);
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(draftSession()?.projectId).toBe(HUB_LOCAL));
  });

  it("folds a project with ← from one of its checkout rows onto the project row", async () => {
    await renderSelector();
    await openSelector();
    await expect.poll(() => optionTexts().length).toBe(5);
    await expect.element(page.getByRole("combobox", { name: "Search projects" })).toHaveFocus();
    // The first ↓ lands on the first row once the list has settled.
    await press("ArrowDown");
    await expect.poll(highlightedText).toBe("ryco2 nodes · ~/Code/ryco");
    // From the Studio checkout, below the MacBook Pro one, folding leaves the
    // highlight on its project, not on whichever row slides into its place.
    await press("ArrowDown", 2);
    await expect.poll(highlightedText).toBe("Studio~/src/ryco");
    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => optionTexts().length).toBe(3);
    await expect.poll(highlightedText).toBe("ryco2 nodes · ~/Code/ryco");

    // → shows the checkouts again, ← from the first one folds onto the project too.
    await press("ArrowRight");
    await expect.poll(() => optionTexts().length).toBe(5);
    await press("ArrowDown");
    await expect.poll(highlightedText).toBe("MacBook Pro~/Code/ryco");
    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => optionTexts().length).toBe(3);
    await expect.poll(highlightedText).toBe("ryco2 nodes · ~/Code/ryco");

    // Enter picks the row the highlight is on: the draft stays where it is.
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => document.querySelector('[data-testid="project-selector"]')).toBeNull();
    expect(draftSession()).toMatchObject({ environmentId: LOCAL_ENV, projectId: RYCO_LOCAL });
    expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toBe(PROMPT);
  });

  it("never starts an open on a row the last open's rows put there", async () => {
    // Two more projects below ryco-hub, so an index kept from a longer list stays in bounds.
    const environments = defaultFixtureEnvironments();
    const local = environments[LOCAL_ENV]!;
    environments[LOCAL_ENV] = {
      ...local,
      projects: [
        ...local.projects,
        ...["notes", "dotfiles"].map((name) =>
          fixtureProject({
            id: ProjectId.make(`project-${name}-local`),
            environmentId: LOCAL_ENV,
            name,
            cwd: `/Users/me/${name}`,
          }),
        ),
      ],
    };
    resetProjectsFixtureState();
    seedProjectsFixtureStore(environments);
    await renderSelector({ activeProjectId: HUB_LOCAL });
    await openSelector();
    await expect.poll(() => optionTexts().length).toBe(5);
    // ryco expanded above the draft's row moves that row from the second to the fourth.
    await page.getByTestId("project-selector-expand").click();
    await expect.poll(() => optionTexts().length).toBe(7);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector('[data-testid="project-selector"]')).toBeNull();

    await openSelector();
    await expect.poll(() => optionTexts().length).toBe(5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The fourth row now is "notes"; the highlight is on no row, or on the draft's own.
    expect([null, "ryco-hubMacBook Pro · ~/Code/ryco-hub"]).toContain(highlightedText());
  });

  it("adds a project, or copies this one to another node, from the footer", async () => {
    await renderSelector();
    await openSelector();
    await page.getByRole("button", { name: "Copy ryco to another node…" }).click();
    expect(useProjectNodesDialogStore.getState().copyProject).toMatchObject({
      open: true,
      request: { source: { environmentId: LOCAL_ENV, projectId: RYCO_LOCAL }, origin: "selector" },
    });
    await expect.element(page.getByTestId("project-selector")).not.toBeInTheDocument();

    await openSelector();
    await page.getByRole("button", { name: "Add project…" }).click();
    // The add-project dialog, not the palette's views, off the phone tier.
    expect(useProjectNodesDialogStore.getState().addProject).toMatchObject({
      open: true,
      request: { environmentId: null, mode: null, projectRef: null },
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("switches to another Hub node's checkout through the hosted draft-target controller", async () => {
    const machine = (
      environmentId: typeof LOCAL_ENV,
      label: string,
    ): WorkspaceMachineCatalogEntry =>
      ({
        environmentId,
        nodeId: `node-${label.toLowerCase()}`,
        label,
        canReadMetadata: true,
        canConnect: true,
        canMutate: true,
      }) as WorkspaceMachineCatalogEntry;
    const hosted = {
      ...readHostedWorkspaceState(),
      status: "ready",
      machines: [machine(LOCAL_ENV, "MacBook Pro"), machine(STUDIO_ENV, "Studio")],
    } satisfies HostedWorkspaceSnapshot;
    vi.mocked(readHostedWorkspaceState).mockReturnValue(hosted);
    const beginProject = vi
      .spyOn(hostedDraftTargetController, "beginProject")
      .mockImplementation(() => undefined);

    await renderSelector();
    await openSelector();
    await page.getByRole("option", { name: /^Studio/ }).click();
    expect(beginProject).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: DRAFT_ID,
        sourceEnvironmentId: LOCAL_ENV,
        sourceProjectId: RYCO_LOCAL,
        environmentId: STUDIO_ENV,
        projectId: RYCO_STUDIO,
        label: "Studio",
      }),
    );
    // The controller owns the move: nothing is retargeted behind its back.
    expect(draftSession()?.environmentId).toBe(LOCAL_ENV);
  });

  it("ends the work-location row with the other nodes the project is on", async () => {
    await render(
      <AppAtomRegistryProvider>
        <NewThreadWorkLocation
          draftId={DRAFT_ID}
          environmentId={LOCAL_ENV}
          threadId={ThreadId.make(DRAFT_ID)}
          projectId={RYCO_LOCAL}
          projectEnvironmentId={LOCAL_ENV}
          projectName="ryco"
          envLocked={false}
          onComposerFocusRequest={undefined}
          onCheckoutPullRequestRequest={undefined}
          cwd="/Users/me/Code/ryco"
          alsoOnLabels={["Studio"]}
        />
      </AppAtomRegistryProvider>,
    );
    await expect
      .element(page.getByTestId("new-thread-also-on"))
      .toHaveTextContent("· also on Studio");
  });
});
