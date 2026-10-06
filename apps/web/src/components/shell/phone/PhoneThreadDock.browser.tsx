// Production CSS is part of the behavior under test: sheet row heights and the
// dock's 44px control floor drive the touch-target assertions.
import "../../../index.css";

import { EnvironmentId, type ProjectId, type ThreadId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
const routerStub = { navigate, state: { matches: [] } };
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useRouter: () => routerStub,
}));

vi.mock("../../../lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

import { DraftId, useComposerDraftStore } from "../../../composerDraftStore";
import { setCoarsePointerEmulation } from "../../../../test/browserPointer";
import { syncDocumentPresentationTier } from "../../../lib/presentationTier";
import { SidebarProvider } from "../../ui/sidebar";
import { PhoneThreadDock } from "./PhoneThreadDock";

const ENV_ID = EnvironmentId.make("environment-local");
const DRAFT_ID = DraftId.make("draft-1");
const DRAFT_THREAD_ID = "thread-draft-1" as ThreadId;
const PROJECT_ID = "project-a" as ProjectId;
const NOW_ISO = "2026-07-20T00:00:00.000Z";

function seedDraft() {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {
      [DRAFT_ID]: {
        threadId: DRAFT_THREAD_ID,
        environmentId: ENV_ID,
        projectId: PROJECT_ID,
        logicalProjectKey: `${ENV_ID}:${PROJECT_ID}`,
        createdAt: NOW_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
      },
    },
  });
}

function sheetRow(label: string): HTMLButtonElement | null {
  const popup = document.querySelector<HTMLElement>('[data-slot="sheet-popup"]');
  if (!popup) return null;
  return (
    [...popup.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

function renderDock(
  overrides: Partial<React.ComponentProps<typeof PhoneThreadDock>> = {},
): ReturnType<typeof render> {
  return render(
    <SidebarProvider>
      {/* A plain block wrapper, mirroring the `relative isolate` box the dock
          sits in inside `ChatView`'s input bar. Without it the row would be a
          direct flex item of the sidebar wrapper, which sizes to its content
          and is not how the surface renders. */}
      <div className="w-full min-w-0">
        <PhoneThreadDock
          environmentId={ENV_ID}
          threadId={DRAFT_THREAD_ID}
          title="Empty Session"
          projectCwd="/repo/alpha"
          branch={null}
          draft={{ draftId: DRAFT_ID, projectId: PROJECT_ID, createdAt: NOW_ISO }}
          workspacePanelOpen={false}
          onToggleWorkspacePanel={() => {}}
          onOpenFindInThread={() => {}}
          onOpenSourceControl={null}
          sessionTabs={[]}
          activeSessionTabKey={null}
          onSelectSessionTab={null}
          {...overrides}
        />
      </div>
    </SidebarProvider>,
  );
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

describe("PhoneThreadDock", () => {
  beforeAll(() => {
    syncDocumentPresentationTier();
  });

  beforeEach(async () => {
    await page.viewport(390, 844);
    localStorage.clear();
    navigate.mockClear();
    seedDraft();
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    useComposerDraftStore.setState({ draftThreadsByThreadKey: {} });
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    await setCoarsePointerEmulation(false);
    await page.viewport(1_280, 720);
  });

  it("carries the workspace toggle and the overflow at 44px under coarse-pointer emulation", async () => {
    await setCoarsePointerEmulation(true);
    const onToggleWorkspacePanel = vi.fn();
    mounted = await renderDock({ onToggleWorkspacePanel });
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);

    // Both measured below the floor in the app bar: the workspace toggle at
    // 32×32 and the kebab at 36×36.
    for (const label of ["Toggle workspace panel", "Thread actions"]) {
      const control = page.getByRole("button", { name: label }).element() as HTMLElement;
      const rect = control.getBoundingClientRect();
      expect(rect.width, `${label} width`).toBeGreaterThanOrEqual(44);
      expect(rect.height, `${label} height`).toBeGreaterThanOrEqual(44);
    }

    const workspace = page.getByRole("button", { name: "Toggle workspace panel" });
    expect((workspace.element() as HTMLElement).getAttribute("aria-pressed")).toBe("false");
    await workspace.click();
    expect(onToggleWorkspacePanel).toHaveBeenCalledTimes(1);
  });

  it("exposes Discard draft for drafts in the overflow sheet and clears the draft through the shared dispatcher", async () => {
    mounted = await renderDock();

    await page.getByRole("button", { name: "Thread actions" }).click();
    const closeRow = await vi.waitFor(() => {
      const row = sheetRow("Discard draft");
      expect(row).not.toBeNull();
      return row!;
    });
    expect(closeRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    // The draft inventory is exactly the shared draft inventory: no
    // rename/pin/archive entries for a session that only exists locally.
    expect(sheetRow("Rename thread")).toBeNull();
    expect(sheetRow("Archive thread")).toBeNull();

    closeRow.click();
    await vi.waitFor(() => {
      expect(useComposerDraftStore.getState().draftThreadsByThreadKey[DRAFT_ID]).toBeUndefined();
    });
  });

  it("keeps find-in-thread and source control on the context strip, not in the top corner", async () => {
    await setCoarsePointerEmulation(true);
    const onOpenFindInThread = vi.fn();
    const onOpenSourceControl = vi.fn();
    mounted = await renderDock({ onOpenFindInThread, onOpenSourceControl, branch: "feat-x" });

    // Pills past the rail's fold are reached by scrolling the rail — the page
    // never scrolls horizontally — so each is brought into the rail's view
    // before it is measured and tapped.
    const tapPill = async (name: string): Promise<HTMLElement> => {
      const locator = page.getByRole("button", { name });
      const element = locator.element() as HTMLElement;
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      await expect.element(locator).toBeVisible();
      await locator.click();
      return element;
    };

    const find = await tapPill("Find in thread");
    expect(find.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(onOpenFindInThread).toHaveBeenCalledTimes(1);

    // The branch rides the source-control pill: changing branch is
    // consequential, so it is shown rather than concealed behind an overflow.
    const sourceControl = await tapPill("Source control feat-x");
    expect(sourceControl.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(onOpenSourceControl).toHaveBeenCalledTimes(1);
  });

  it("moves the session list into its own sheet when the worktree has more than one", async () => {
    const onSelectSessionTab = vi.fn();
    mounted = await renderDock({
      sessionTabs: [
        { key: "a", title: "Session A" },
        { key: "b", title: "Session B" },
      ] as never,
      activeSessionTabKey: "a",
      onSelectSessionTab,
    });

    const sessions = page.getByRole("button", { name: "Sessions 2" });
    (sessions.element() as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" });
    await sessions.click();
    const row = await vi.waitFor(() => {
      const found = sheetRow("Session B");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    row.click();
    expect(onSelectSessionTab).toHaveBeenCalledWith("b");
  });

  it("does not overflow the page at 320px", async () => {
    await page.viewport(320, 568);
    mounted = await renderDock({
      onOpenSourceControl: () => {},
      branch: "feature/a-very-long-branch-name-that-cannot-fit",
      sessionTabs: [
        { key: "a", title: "Session A" },
        { key: "b", title: "Session B" },
      ] as never,
      activeSessionTabKey: "a",
      onSelectSessionTab: () => {},
    });

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
    expect(document.body.scrollWidth).toBeLessThanOrEqual(320);
    for (const label of ["Toggle workspace panel", "Thread actions"]) {
      const rect = (
        page.getByRole("button", { name: label }).element() as HTMLElement
      ).getBoundingClientRect();
      expect(rect.left, `${label} off-screen left`).toBeGreaterThanOrEqual(0);
      expect(rect.right, `${label} off-screen right`).toBeLessThanOrEqual(320.5);
    }
  });
});
