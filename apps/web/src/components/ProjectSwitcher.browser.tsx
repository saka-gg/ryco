import "../index.css";

import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { WorkspaceMachineCatalogEntry } from "@ryco/client-runtime/state/workspace";
import { DraftId } from "@ryco/client-runtime/state/composer";
import { ThreadId, type VcsStatusResult } from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, render } from "vitest-browser-react";

// Spied, not replaced: every export keeps its real behaviour unless a test
// stubs it (the hosted test reads a ready Hub workspace through it).
vi.mock("../hostedHub/hostedConnectionCoordinator", { spy: true });

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import {
  readHostedWorkspaceState,
  type HostedWorkspaceSnapshot,
} from "../hostedHub/hostedConnectionCoordinator";
import { hostedDraftTargetController } from "../hooks/useHostedDraftExecutionTarget";
import { refreshGitStatus, resetGitStatusStateForTests } from "../lib/gitStatusState";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { NewThreadWorkLocation } from "./chat/NewThreadWorkLocation";
import { ProjectSwitcher } from "./ProjectSwitcher";
import {
  requestProjectSelectorOpen,
  resetProjectNodesDialogStoreForTests,
  useProjectNodesDialogStore,
} from "./projectNodes/projectNodesDialogStore";
import {
  FIXTURE_NOW_ISO,
  HUB_LOCAL,
  LOCAL_ENV,
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

async function renderSelector(options: { readonly openOnRequest?: boolean } = {}) {
  await page.viewport(1100, 800);
  const screen = await render(
    <AppAtomRegistryProvider>
      <div className="p-10">
        <h1 className="text-2xl">
          What should we do in{" "}
          <ProjectSwitcher
            activeProjectId={RYCO_LOCAL}
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
        "sak0a/ryco2 nodes · ~/Code/ryco",
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
    // Collapsing folds the per-node rows away.
    await page.getByTestId("project-selector-expand").click();
    await expect.poll(() => optionTexts().length).toBe(3);
  });

  it("opens when the add-project dialog asks to show its project there", async () => {
    await renderSelector({ openOnRequest: true });
    // A request for another checkout leaves this selector closed.
    requestProjectSelectorOpen(scopeProjectRef(STUDIO_ENV, RYCO_STUDIO));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector('[data-testid="project-selector"]')).toBeNull();

    requestProjectSelectorOpen(scopeProjectRef(LOCAL_ENV, RYCO_LOCAL));
    await expect.element(page.getByTestId("project-selector")).toBeVisible();
    await expect.poll(() => optionTexts()[0]).toBe("sak0a/ryco2 nodes · ~/Code/ryco");

    // Closing ends the request, so the selector stays closed afterwards.
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector('[data-testid="project-selector"]')).toBeNull();
    expect(useProjectNodesDialogStore.getState().projectSelectorOpenRequest).toBeNull();
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
    await expect.poll(optionTexts).toEqual(["sak0a/rycoStudio · ~/src/ryco"]);
    await chips.getByRole("radio", { name: /All/ }).click();
    await expect.poll(() => optionTexts().length).toBe(5);

    const search = page.getByRole("combobox", { name: "Search projects" });
    await userEvent.fill(search, "@stu");
    await expect.poll(optionTexts).toEqual(["sak0a/rycoStudio · ~/src/ryco"]);
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
      .toEqual(["sak0a/ryco2 nodes · ~/Code/ryco", "MacBook Pro~/Code/ryco", "Studio~/src/ryco"]);
    const marks = Array.from(
      document.querySelectorAll('[data-testid="project-selector-checkout"] mark'),
    ).map((mark) => mark.textContent);
    expect(marks).toEqual(["src/ry"]);
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
