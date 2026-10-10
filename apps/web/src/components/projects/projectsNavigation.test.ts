import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { classifyEnvironmentPresence, type ProjectListRow } from "./projectsModel.logic";
import { createProjectsNavigation } from "./projectsNavigation";
import {
  deriveProjectsLayout,
  type ProjectsSelection,
  type ProjectsSelectionMotion,
} from "./ProjectsPageContext";
import type { ProjectsSearch } from "./projectsSearch";

function row(key: string, environmentId: string, id: string, remote = true): ProjectListRow {
  const member = {
    id: id as ProjectId,
    environmentId: environmentId as EnvironmentId,
    name: key,
    cwd: `/${key}`,
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity: remote
      ? {
          canonicalKey: key,
          locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: key },
          remotes: [],
        }
      : null,
    physicalProjectKey: `${environmentId}:/${key}`,
    environmentLabel: null,
  };
  const snapshot = {
    ...member,
    projectKey: key,
    displayName: key,
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    memberProjects: [member],
    memberProjectRefs: [{ environmentId: member.environmentId, projectId: member.id }],
    remoteEnvironmentLabels: [],
  } as SidebarProjectSnapshot;
  return {
    key,
    snapshot,
    name: key,
    subtitle: key,
    devices: [],
    lastActivityAt: null,
    running: false,
    searchText: key,
  };
}

function setup(input: { search: ProjectsSearch; rows: ProjectListRow[]; selected: number | null }) {
  let search = input.search;
  let motion: ProjectsSelectionMotion = { direction: 0, token: 0 };
  const commits: Array<{ next: ProjectsSearch; push: boolean }> = [];
  const selection = (): ProjectsSelection | null => {
    if (input.selected === null) return null;
    const selected = input.rows[input.selected]!;
    return {
      index: input.selected,
      snapshot: selected.snapshot,
      member: selected.snapshot.memberProjects[0]!,
      checkoutKey: `${selected.snapshot.environmentId}\0${selected.snapshot.id}`,
    };
  };
  const closeDrawer = vi.fn();
  const nav = createProjectsNavigation({
    getSearch: () => search,
    getRows: () => input.rows,
    getVisibleRows: () => input.rows,
    getSelection: selection,
    commit: (next, options) => {
      commits.push({ next, push: options.push });
      search = next;
    },
    setSelectionMotion: (update) => {
      motion = update(motion);
    },
    closeDrawer,
  });
  return { nav, commits, closeDrawer, motion: () => motion };
}

describe("createProjectsNavigation", () => {
  const rows = [row("a", "e1", "p1"), row("b", "e1", "p2"), row("c", "e1", "p3", false)];

  it("opens a project with a push, keeping the view but dropping the section, and records the direction", () => {
    const harness = setup({
      search: { env: "e1", project: "p1", section: "actions" },
      rows,
      selected: 0,
    });
    harness.nav.selectProject(rows[1]!);
    expect(harness.commits).toEqual([
      { next: { env: "e1", project: "p2", view: "settings" }, push: true },
    ]);
    expect(harness.motion()).toEqual({ direction: 1, token: 1 });
    expect(harness.closeDrawer).toHaveBeenCalled();
  });

  it("opens a project from the keyboard with a replace", () => {
    const harness = setup({ search: { env: "e1", project: "p1" }, rows, selected: 0 });
    harness.nav.selectProject(rows[2]!, { via: "keyboard" });
    expect(harness.commits).toEqual([
      { next: { env: "e1", project: "p3", view: "map" }, push: false },
    ]);
  });

  it("ignores re-selecting the current project", () => {
    const harness = setup({ search: { env: "e1", project: "p1" }, rows, selected: 0 });
    harness.nav.selectProject(rows[0]!);
    expect(harness.commits).toEqual([]);
  });

  it("steps through the visible rows and clamps at the ends", () => {
    const harness = setup({ search: { env: "e1", project: "p3" }, rows, selected: 2 });
    harness.nav.stepProject(1);
    expect(harness.commits).toEqual([]);
    harness.nav.stepProject(-1);
    expect(harness.commits.at(-1)).toEqual({
      next: { env: "e1", project: "p2", view: "map" },
      push: false,
    });
  });

  it("records a revealed section on the current checkout with a replace", () => {
    const harness = setup({ search: { env: "e1", project: "p1" }, rows, selected: 0 });
    harness.nav.revealSection("danger");
    expect(harness.commits.at(-1)).toEqual({
      next: { env: "e1", project: "p1", view: "settings", section: "danger" },
      push: false,
    });
  });

  it("opens a workspace review on the map, and closes it in place", () => {
    const harness = setup({ search: { env: "e1", project: "p1" }, rows, selected: 0 });
    harness.nav.openWorkspaceReview("wt-1", "remove-checkout");
    expect(harness.commits.at(-1)).toEqual({
      next: { env: "e1", project: "p1", view: "map", workspace: "wt-1", review: "remove-checkout" },
      push: false,
    });
    // Moving between sections keeps the review open.
    harness.nav.revealSection("danger");
    expect(harness.commits.at(-1)?.next).toMatchObject({
      workspace: "wt-1",
      review: "remove-checkout",
    });
    harness.nav.closeWorkspaceReview();
    expect(harness.commits.at(-1)?.next).toMatchObject({ workspace: "wt-1", review: undefined });
    const count = harness.commits.length;
    harness.nav.closeWorkspaceReview();
    expect(harness.commits).toHaveLength(count);
  });

  it("switches views with a push and opens settings on any checkout or section", () => {
    const harness = setup({ search: { env: "e1", project: "p1" }, rows, selected: 0 });
    harness.nav.setView("map");
    expect(harness.commits).toEqual([]);
    harness.nav.setView("settings");
    expect(harness.commits.at(-1)).toEqual({
      next: { env: "e1", project: "p1", view: "settings" },
      push: true,
    });
    harness.nav.showSettings({
      section: "automations",
      checkout: { environmentId: "e2" as EnvironmentId, projectId: "p9" as ProjectId },
    });
    expect(harness.commits.at(-1)).toEqual({
      next: { env: "e2", project: "p9", view: "settings", section: "automations" },
      push: true,
    });
  });

  it("re-scopes to another checkout with a replace, keeping the view but dropping the section", () => {
    const harness = setup({
      search: { env: "e1", project: "p1", section: "danger" },
      rows,
      selected: 0,
    });
    harness.nav.selectCheckout({
      environmentId: "e2" as EnvironmentId,
      projectId: "p9" as ProjectId,
    });
    expect(harness.commits).toEqual([
      { next: { env: "e2", project: "p9", view: "settings" }, push: false },
    ]);
  });

  it("plans removal to nothing when the removed checkout had no siblings", () => {
    const harness = setup({
      search: { env: "e1", project: "p1", section: "danger" },
      rows,
      selected: 0,
    });
    const leave = harness.nav.planCheckoutRemoval();
    expect(harness.commits).toEqual([]);
    leave();
    expect(harness.commits).toEqual([{ next: {}, push: false }]);
  });

  it("plans removal to the project's other checkout before the selection goes away", () => {
    const twoCheckouts = row("a", "e1", "p1");
    const other = {
      ...twoCheckouts.snapshot.memberProjects[0]!,
      environmentId: "e2" as EnvironmentId,
      id: "p9" as ProjectId,
    };
    const grouped: ProjectListRow = {
      ...twoCheckouts,
      snapshot: {
        ...twoCheckouts.snapshot,
        memberProjects: [twoCheckouts.snapshot.memberProjects[0]!, other],
      } as SidebarProjectSnapshot,
    };
    const input = {
      search: { env: "e1", project: "p1", section: "danger" } as ProjectsSearch,
      rows: [grouped],
      selected: 0 as number | null,
    };
    const harness = setup(input);
    const leave = harness.nav.planCheckoutRemoval();
    // The delete's shell event can clear the selection before its reply.
    input.selected = null;
    leave();
    expect(harness.commits).toEqual([
      { next: { env: "e2", project: "p9", view: "settings" }, push: false },
    ]);
  });
});

describe("deriveProjectsLayout", () => {
  const base = { drawerOpen: true, setDrawerOpen: () => undefined };
  it("docks the list on wide pages and folds the section navigation by detail width", () => {
    const wide = deriveProjectsLayout({ ...base, pageWidth: 1300, hasDetail: true });
    expect(wide).toMatchObject({
      listDocked: true,
      listFillsPage: false,
      detailWidth: 1012,
      tocDocked: true,
      barCompact: false,
      leadingRegion: "list",
      drawerOpen: false,
    });
    const mid = deriveProjectsLayout({ ...base, pageWidth: 1000, hasDetail: true });
    expect(mid).toMatchObject({ tocDocked: false });
  });
  it("uses a drawer below the breakpoint and fills the page with nothing to show", () => {
    expect(deriveProjectsLayout({ ...base, pageWidth: 800, hasDetail: true })).toMatchObject({
      listDocked: false,
      listFillsPage: false,
      leadingRegion: "detail",
      drawerOpen: true,
    });
    expect(deriveProjectsLayout({ ...base, pageWidth: 800, hasDetail: false })).toMatchObject({
      listFillsPage: true,
      leadingRegion: "list",
      drawerOpen: false,
    });
  });
});

describe("classifyEnvironmentPresence", () => {
  const base = {
    isPrimary: false,
    bootstrapComplete: false,
    hydratedFromCache: false,
    connectionState: null,
    disconnectedAt: null,
  };
  it("is online once a live snapshot is in", () => {
    expect(classifyEnvironmentPresence({ ...base, isPrimary: true, bootstrapComplete: true })).toBe(
      "online",
    );
    expect(
      classifyEnvironmentPresence({
        ...base,
        connectionState: "connected",
        bootstrapComplete: true,
      }),
    ).toBe("online");
  });
  it("is connecting while live but not yet synced", () => {
    expect(classifyEnvironmentPresence({ ...base, isPrimary: true })).toBe("connecting");
    expect(classifyEnvironmentPresence({ ...base, connectionState: "connecting" })).toBe(
      "connecting",
    );
  });
  it("is cached or offline after the connection is lost", () => {
    expect(classifyEnvironmentPresence({ ...base, connectionState: "error" })).toBe("offline");
    expect(
      classifyEnvironmentPresence({ ...base, connectionState: "error", hydratedFromCache: true }),
    ).toBe("cached");
    expect(
      classifyEnvironmentPresence({
        ...base,
        connectionState: "disconnected",
        disconnectedAt: "2026-10-03T00:00:00.000Z",
      }),
    ).toBe("offline");
    expect(classifyEnvironmentPresence({ ...base, hydratedFromCache: true })).toBe("cached");
  });
});
