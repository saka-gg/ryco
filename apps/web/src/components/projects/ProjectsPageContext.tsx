import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { createContext, useContext } from "react";

import type { ProjectCheckoutRequest } from "../../projectCheckouts.logic";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { ProjectListRow } from "./projectsModel.logic";
import type {
  ProjectSection,
  ProjectsSearch,
  ProjectsView,
  WorkspaceReviewAction,
} from "./projectsSearch";

/**
 * Page widths (the window minus the app sidebar) at which regions dock. Below
 * the list breakpoint the list becomes a drawer; the section navigation
 * folds away below its own.
 */
export const PROJECTS_LIST_DOCK_MIN_PAGE_WIDTH = 900;
export const PROJECTS_LIST_WIDTH = 288;
export const PROJECTS_TOC_DOCK_MIN_DETAIL_WIDTH = 960;
export const PROJECTS_BAR_COMPACT_MAX_DETAIL_WIDTH = 640;

/** The checkout the page shows, with the logical project it belongs to. */
export interface ProjectsSelection {
  /**
   * Position of the project in the (unfiltered) list; drives settle
   * direction. The list row itself is not part of the selection: rows carry
   * live thread activity, and the detail must not re-render with it.
   */
  readonly index: number;
  readonly snapshot: SidebarProjectSnapshot;
  /** The scoped checkout: every section reads and writes through it. */
  readonly member: SidebarProjectGroupMember;
  /** `${environmentId}\0${projectId}` of the scoped checkout. */
  readonly checkoutKey: string;
}

/** Why no checkout is shown. */
export type ProjectsCheckoutStatus =
  | { readonly kind: "ready" }
  | { readonly kind: "empty" }
  | {
      readonly kind: "waiting";
      readonly requested: ProjectCheckoutRequest;
      readonly environmentLabel: string | null;
      /** Waiting has gone on long enough to say so. */
      readonly stalled: boolean;
    }
  | {
      readonly kind: "unavailable";
      readonly requested: ProjectCheckoutRequest;
      readonly environmentLabel: string | null;
      readonly reason: "offline" | "missing";
    };

export interface ProjectsNavigation {
  readonly search: ProjectsSearch;
  /** Open a logical project at its representative checkout. */
  readonly selectProject: (
    row: ProjectListRow,
    options?: { readonly via?: "pointer" | "keyboard" },
  ) => void;
  /** Re-scope to another checkout of the project (another device). */
  readonly selectCheckout: (checkout: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => void;
  /** Land on one section of the page (records it in the URL). */
  readonly revealSection: (section: ProjectSection) => void;
  /** Switch between the map and the settings editor (a history entry). */
  readonly setView: (view: ProjectsView) => void;
  /** Open the settings editor, optionally at a section or on another checkout. */
  readonly showSettings: (input?: {
    readonly section?: ProjectSection;
    readonly checkout?: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
  }) => void;
  /** Open the review of a checkout change for one workspace, on the map (recorded in the URL). */
  readonly openWorkspaceReview: (workspace: string, review: WorkspaceReviewAction) => void;
  /**
   * The map took the URL's workspace (and review) as a one-shot command:
   * drop them so dismissing it sticks and the same link lands again.
   */
  readonly consumeWorkspaceTarget: () => void;
  /** Close the open review; the workspace stays in view. */
  readonly closeWorkspaceReview: () => void;
  /** `j` / `k`: the next or previous project in the visible list order. */
  readonly stepProject: (delta: 1 | -1) => void;
  /**
   * Plans leaving the scoped checkout before it is removed: resolves where to
   * go now (the project's other checkout, else nothing) and returns the commit
   * to run once the removal succeeds, so the removal's own shell event cannot
   * change the destination.
   */
  readonly planCheckoutRemoval: () => () => void;
}

export interface ProjectsLayout {
  readonly pageWidth: number;
  readonly detailWidth: number;
  readonly listDocked: boolean;
  /** Narrow page with nothing to show: the list is the page. */
  readonly listFillsPage: boolean;
  readonly tocDocked: boolean;
  readonly barCompact: boolean;
  /** Which bar owns the window's top-left corner (collapsed sidebar inset). */
  readonly leadingRegion: "list" | "detail";
  readonly drawerOpen: boolean;
  readonly openDrawer: () => void;
  readonly closeDrawer: () => void;
}

/**
 * Region docking from the page width. `hasDetail` is false only when there is
 * nothing to read (no projects at all); then a narrow page shows the list
 * alone instead of an empty detail behind a drawer.
 */
export function deriveProjectsLayout(input: {
  readonly pageWidth: number;
  readonly hasDetail: boolean;
  readonly drawerOpen: boolean;
  readonly setDrawerOpen: (open: boolean) => void;
}): ProjectsLayout {
  const listDocked = input.pageWidth >= PROJECTS_LIST_DOCK_MIN_PAGE_WIDTH;
  const listFillsPage = !listDocked && !input.hasDetail;
  const detailWidth = listDocked
    ? Math.max(0, input.pageWidth - PROJECTS_LIST_WIDTH)
    : input.pageWidth;
  return {
    pageWidth: input.pageWidth,
    detailWidth,
    listDocked,
    listFillsPage,
    tocDocked: detailWidth >= PROJECTS_TOC_DOCK_MIN_DETAIL_WIDTH,
    barCompact: detailWidth < PROJECTS_BAR_COMPACT_MAX_DETAIL_WIDTH,
    leadingRegion: listDocked || listFillsPage ? "list" : "detail",
    drawerOpen: input.drawerOpen && !listDocked && !listFillsPage,
    openDrawer: () => input.setDrawerOpen(true),
    closeDrawer: () => input.setDrawerOpen(false),
  };
}

/** Direction of the last project change (list order), for the detail settle. */
export interface ProjectsSelectionMotion {
  readonly direction: -1 | 0 | 1;
  readonly token: number;
}

export interface ProjectsPageContextValue {
  readonly status: ProjectsCheckoutStatus;
  readonly selection: ProjectsSelection | null;
  readonly nav: ProjectsNavigation;
  readonly layout: ProjectsLayout;
  readonly selectionMotion: ProjectsSelectionMotion;
  readonly primaryEnvironmentId: EnvironmentId | null;
}

export const ProjectsPageContext = createContext<ProjectsPageContextValue | null>(null);

/**
 * The list's data, apart from the page context: rows change with every thread
 * update anywhere, and only the list should re-render for that.
 */
export interface ProjectsListContextValue {
  /** Every logical project, sidebar order. */
  readonly rows: readonly ProjectListRow[];
  /** The list filter (lives in the page so `j`/`k` follow the filtered order). */
  readonly filter: string;
  readonly setFilter: (value: string) => void;
}

export const ProjectsListContext = createContext<ProjectsListContextValue | null>(null);

export function useProjectsList(): ProjectsListContextValue {
  const value = useContext(ProjectsListContext);
  if (!value) throw new Error("useProjectsList requires ProjectsListContext");
  return value;
}

export function useProjectsPage(): ProjectsPageContextValue {
  const value = useContext(ProjectsPageContext);
  if (!value) throw new Error("useProjectsPage requires ProjectsPageContext");
  return value;
}

/** The scoped checkout; throws outside a ready page (the detail only mounts when ready). */
export function useProjectsSelection(): ProjectsSelection {
  const { selection } = useProjectsPage();
  if (!selection) throw new Error("useProjectsSelection requires a resolved checkout");
  return selection;
}
