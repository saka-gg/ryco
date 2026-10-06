import type { ProjectListRow } from "./projectsModel.logic";
import { projectMotionDirection } from "./projectsModel.logic";
import type {
  ProjectsNavigation,
  ProjectsSelection,
  ProjectsSelectionMotion,
} from "./ProjectsPageContext";
import { resolveProjectsView, type ProjectsSearch } from "./projectsSearch";

export interface ProjectsNavigationDeps {
  readonly getSearch: () => ProjectsSearch;
  /** Every row, sidebar order (motion direction is measured on it). */
  readonly getRows: () => readonly ProjectListRow[];
  /** Rows as the list shows them (filtered), for `j` / `k`. */
  readonly getVisibleRows: () => readonly ProjectListRow[];
  readonly getSelection: () => ProjectsSelection | null;
  /** The URL is the single source of truth: push for clicks, replace for keys. */
  readonly commit: (next: ProjectsSearch, options: { readonly push: boolean }) => void;
  readonly setSelectionMotion: (
    update: (current: ProjectsSelectionMotion) => ProjectsSelectionMotion,
  ) => void;
  readonly closeDrawer: () => void;
}

/**
 * The page's navigation actions, shared by the router-backed page and the test
 * provider so both follow one set of rules.
 */
export function createProjectsNavigation(
  deps: ProjectsNavigationDeps,
): Omit<ProjectsNavigation, "search"> {
  const selectProject: ProjectsNavigation["selectProject"] = (row, options) => {
    const selection = deps.getSelection();
    deps.closeDrawer();
    if (selection?.snapshot.projectKey === row.key) return;
    const rows = deps.getRows();
    const direction = projectMotionDirection(
      selection
        ? rows.findIndex((candidate) => candidate.key === selection.snapshot.projectKey)
        : -1,
      rows.findIndex((candidate) => candidate.key === row.key),
    );
    deps.setSelectionMotion((current) => ({ direction, token: current.token + 1 }));
    // The reader stays in the view they were using (map or settings).
    deps.commit(
      {
        env: row.snapshot.environmentId,
        project: row.snapshot.id,
        view: resolveProjectsView(deps.getSearch()),
      },
      { push: options?.via !== "keyboard" },
    );
  };

  return {
    selectProject,
    selectCheckout: (checkout) => {
      const search = deps.getSearch();
      if (search.env === checkout.environmentId && search.project === checkout.projectId) return;
      deps.commit(
        {
          env: checkout.environmentId,
          project: checkout.projectId,
          view: resolveProjectsView(search),
        },
        { push: false },
      );
    },
    setView: (view) => {
      const search = deps.getSearch();
      if (resolveProjectsView(search) === view) return;
      deps.commit({ env: search.env, project: search.project, view }, { push: true });
    },
    showSettings: (input) => {
      const search = deps.getSearch();
      deps.commit(
        {
          env: input?.checkout?.environmentId ?? search.env,
          project: input?.checkout?.projectId ?? search.project,
          view: "settings",
          ...(input?.section ? { section: input.section } : {}),
        },
        { push: true },
      );
    },
    revealSection: (section) => {
      const search = deps.getSearch();
      deps.commit({ ...search, view: "settings", section }, { push: false });
    },
    // In-page: the reader is already looking at the row, so the section does
    // not land again (deep links from menus name the section themselves).
    openWorkspaceReview: (workspace, review) => {
      const search = deps.getSearch();
      deps.commit({ ...search, view: "map", workspace, review }, { push: false });
    },
    consumeWorkspaceTarget: () => {
      const search = deps.getSearch();
      if (search.workspace === undefined && search.review === undefined) return;
      deps.commit({ ...search, workspace: undefined, review: undefined }, { push: false });
    },
    closeWorkspaceReview: () => {
      const search = deps.getSearch();
      if (search.review === undefined) return;
      deps.commit({ ...search, review: undefined }, { push: false });
    },
    stepProject: (delta) => {
      const rows = deps.getVisibleRows();
      if (rows.length === 0) return;
      const selection = deps.getSelection();
      const index = selection
        ? rows.findIndex((row) => row.key === selection.snapshot.projectKey)
        : -1;
      const next =
        index < 0
          ? rows[delta > 0 ? 0 : rows.length - 1]
          : rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
      if (next) selectProject(next, { via: "keyboard" });
    },
    planCheckoutRemoval: () => {
      const selection = deps.getSelection();
      const sibling = selection?.snapshot.memberProjects.find(
        (member) =>
          member.id !== selection.member.id ||
          member.environmentId !== selection.member.environmentId,
      );
      const view = resolveProjectsView(deps.getSearch());
      const next: ProjectsSearch = sibling
        ? { env: sibling.environmentId, project: sibling.id, view }
        : {};
      return () => deps.commit(next, { push: false });
    },
  };
}
