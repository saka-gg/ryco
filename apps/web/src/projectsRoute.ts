import type { WorkspaceActionId } from "@ryco/client-runtime/state/lifecycle";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";

import {
  isWorkspaceReviewAction,
  type ProjectSection,
  type ProjectsSearch,
  type ProjectsView,
} from "./components/projects/projectsSearch";

export const PROJECTS_ROUTE_PATH = "/projects" as const;

/**
 * Router location for the projects page: one checkout (a project on one
 * environment), optionally landing on a section, or — none given — the last
 * checkout used. The sidebar, its project and thread menus, the palette and
 * the `projects.open` command all open the page through this.
 */
export function buildProjectsPageLocation(input?: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly section?: ProjectSection | undefined;
  readonly view?: ProjectsView | undefined;
  /** A workspace of the checkout to bring into view. */
  readonly workspace?: string | undefined;
  /** Opens that workspace's review; only checkout-changing actions are reviewed. */
  readonly review?: WorkspaceActionId | undefined;
}): { readonly to: typeof PROJECTS_ROUTE_PATH; readonly search: ProjectsSearch } {
  if (!input) return { to: PROJECTS_ROUTE_PATH, search: {} };
  const review =
    input.workspace && input.review && isWorkspaceReviewAction(input.review)
      ? input.review
      : undefined;
  return {
    to: PROJECTS_ROUTE_PATH,
    search: {
      env: input.environmentId,
      project: input.projectId,
      ...(input.view ? { view: input.view } : {}),
      ...(input.section ? { section: input.section } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(review ? { review } : {}),
    },
  };
}
