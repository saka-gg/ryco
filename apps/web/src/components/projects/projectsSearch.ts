/**
 * URL state for `/projects`. The URL names one checkout (`env` + `project`):
 * the project as it exists on one environment, which the page edits. A
 * `section` lands the page on one part of it; `workspace` (and `review`) point
 * at one of its workspaces and, for checkout changes, open that review.
 */
import {
  isWorkspaceReviewAction,
  WORKSPACE_REVIEW_ACTIONS,
  type WorkspaceReviewAction,
} from "@ryco/client-runtime/state/lifecycle";

export { isWorkspaceReviewAction, type WorkspaceReviewAction };

/** Every section of a project's page, in page order. */
export const PROJECT_SECTIONS = [
  "devices",
  "location",
  "repository",
  "workspaces",
  "defaults",
  "actions",
  "instructions",
  "automations",
  "integrations",
  "danger",
] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

/** Map: the project across its devices (canvas). Settings: the one-scroll editor. */
export type ProjectsView = "map" | "settings";

export interface ProjectsSearch {
  readonly env?: string | undefined;
  readonly project?: string | undefined;
  readonly view?: ProjectsView | undefined;
  /** Where to land on the project's page. */
  readonly section?: ProjectSection | undefined;
  /** A workspace (worktree id) of the checkout to bring into view. */
  readonly workspace?: string | undefined;
  /** The checkout change under review for `workspace`. */
  readonly review?: WorkspaceReviewAction | undefined;
}

const REVIEW_ACTIONS: ReadonlySet<string> = new Set(WORKSPACE_REVIEW_ACTIONS);

const SECTION_SET: ReadonlySet<string> = new Set(PROJECT_SECTIONS);

/** The page opens on the map unless a settings section (or the view) says otherwise. */
export function resolveProjectsView(search: ProjectsSearch): ProjectsView {
  return search.view ?? (search.section ? "settings" : "map");
}
const MAX_ID_LENGTH = 256;

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH ? trimmed : undefined;
}

export function parseProjectsSearch(raw: Record<string, unknown>): ProjectsSearch {
  const project = optionalString(raw.project);
  // An environment without a project names nothing.
  const env = project === undefined ? undefined : optionalString(raw.env);
  const section =
    typeof raw.section === "string" && SECTION_SET.has(raw.section)
      ? (raw.section as ProjectSection)
      : undefined;
  // A workspace belongs to the named checkout; a review needs its workspace.
  const workspace = project === undefined ? undefined : optionalString(raw.workspace);
  const review =
    workspace !== undefined && typeof raw.review === "string" && REVIEW_ACTIONS.has(raw.review)
      ? (raw.review as WorkspaceReviewAction)
      : undefined;
  const view = raw.view === "map" || raw.view === "settings" ? raw.view : undefined;
  return {
    ...(env !== undefined ? { env } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(view !== undefined ? { view } : {}),
    ...(section !== undefined ? { section } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(review !== undefined ? { review } : {}),
  };
}
