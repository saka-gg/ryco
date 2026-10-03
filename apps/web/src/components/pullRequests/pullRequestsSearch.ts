/**
 * URL state for the `/pull-requests` page. Everything a reader would want to
 * link to — the repository, the selected change request, the tab, a commit
 * scope, a file, or a review thread — lives here; transient UI state (scroll,
 * expanded rows, draft text) does not.
 */
export type PullRequestsTab = "conversation" | "files" | "checks" | "commits";
export type PullRequestsStateFilter = "open" | "closed" | "merged" | "all";
/** Quick narrowing of the list: review requested from you, failing checks, or authored by you. */
export type PullRequestsOnlyFilter = "review" | "failing" | "mine";
export type PullRequestsSort = "readiness" | "updated";
export type PullRequestsDiffSide = "left" | "right";

export const PULL_REQUESTS_TABS: readonly PullRequestsTab[] = [
  "conversation",
  "files",
  "checks",
  "commits",
];

export interface PullRequestsSearch {
  /** Environment that owns the selected repository checkout. */
  readonly env?: string | undefined;
  /** Project id within `env`; its checkout is the repository context. */
  readonly project?: string | undefined;
  /** Selected change request number. */
  readonly pr?: number | undefined;
  readonly tab?: PullRequestsTab | undefined;
  readonly state?: PullRequestsStateFilter | undefined;
  readonly q?: string | undefined;
  readonly only?: PullRequestsOnlyFilter | undefined;
  readonly label?: readonly string[] | undefined;
  readonly sort?: PullRequestsSort | undefined;
  /** Files tab scoped to a single commit of the change request. */
  readonly commit?: string | undefined;
  /** Files tab: file path to reveal. */
  readonly file?: string | undefined;
  /** Files tab: line to reveal within `file` (with `side`, default right). */
  readonly line?: number | undefined;
  readonly side?: PullRequestsDiffSide | undefined;
  /** Review thread to reveal (Files or Conversation). */
  readonly thread?: string | undefined;
  /** Checks tab: job id to expand with its log tail. */
  readonly job?: string | undefined;
}

const TABS = new Set<string>(PULL_REQUESTS_TABS);
const STATES = new Set<string>(["open", "closed", "merged", "all"]);
const ONLY = new Set<string>(["review", "failing", "mine"]);
const SORTS = new Set<string>(["readiness", "updated"]);
const SIDES = new Set<string>(["left", "right"]);

function optionalString(value: unknown, maxLength = 512): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

function optionalPositiveInt(value: unknown): number | undefined {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  const values = (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
    .map((item) => optionalString(item, 128))
    .filter((item): item is string => item !== undefined)
    .filter((item, index, all) => all.indexOf(item) === index)
    .toSorted();
  return values.length > 0 ? values : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | undefined {
  return typeof value === "string" && allowed.has(value) ? (value as T) : undefined;
}

function optionalSha(value: unknown): string | undefined {
  const sha = optionalString(value, 64);
  return sha !== undefined && /^[0-9a-f]{7,64}$/iu.test(sha) ? sha.toLowerCase() : undefined;
}

export function parsePullRequestsSearch(raw: Record<string, unknown>): PullRequestsSearch {
  const env = optionalString(raw["env"]);
  const project = optionalString(raw["project"]);
  const pr = optionalPositiveInt(raw["pr"]);
  const tab = oneOf<PullRequestsTab>(raw["tab"], TABS);
  const state = oneOf<PullRequestsStateFilter>(raw["state"], STATES);
  const q = optionalString(raw["q"], 256);
  const only = oneOf<PullRequestsOnlyFilter>(raw["only"], ONLY);
  const label = stringArray(raw["label"]);
  const sort = oneOf<PullRequestsSort>(raw["sort"], SORTS);
  const commit = pr === undefined ? undefined : optionalSha(raw["commit"]);
  const file = pr === undefined ? undefined : optionalString(raw["file"], 1024);
  const line = file === undefined ? undefined : optionalPositiveInt(raw["line"]);
  const side = line === undefined ? undefined : oneOf<PullRequestsDiffSide>(raw["side"], SIDES);
  const thread = pr === undefined ? undefined : optionalString(raw["thread"], 256);
  const job = pr === undefined ? undefined : optionalString(raw["job"], 128);
  return {
    ...(env === undefined ? {} : { env }),
    ...(project === undefined ? {} : { project }),
    ...(pr === undefined ? {} : { pr }),
    // Defaults stay out of the URL so shared links are short and stable.
    ...(tab === undefined || tab === "conversation" ? {} : { tab }),
    ...(state === undefined || state === "open" ? {} : { state }),
    ...(q === undefined ? {} : { q }),
    ...(only === undefined ? {} : { only }),
    ...(label === undefined ? {} : { label }),
    ...(sort === undefined || sort === "readiness" ? {} : { sort }),
    ...(commit === undefined ? {} : { commit }),
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
    ...(side === undefined || side === "right" ? {} : { side }),
    ...(thread === undefined ? {} : { thread }),
    ...(job === undefined ? {} : { job }),
  };
}

export function resolvePullRequestsTab(search: PullRequestsSearch): PullRequestsTab {
  return search.tab ?? "conversation";
}

export function resolvePullRequestsStateFilter(
  search: PullRequestsSearch,
): PullRequestsStateFilter {
  return search.state ?? "open";
}

export function resolvePullRequestsSort(search: PullRequestsSearch): PullRequestsSort {
  return search.sort ?? "readiness";
}

/** List-level params survive a PR switch; everything scoped to one PR does not. */
export function selectPullRequestSearch(
  search: PullRequestsSearch,
  pr: number | undefined,
  tab?: PullRequestsTab,
): PullRequestsSearch {
  const {
    commit: _c,
    file: _f,
    line: _l,
    side: _s,
    thread: _t,
    job: _j,
    tab: currentTab,
    pr: _p,
    ...rest
  } = search;
  const nextTab = tab ?? currentTab;
  return {
    ...rest,
    ...(pr === undefined ? {} : { pr }),
    ...(pr === undefined || nextTab === undefined || nextTab === "conversation"
      ? {}
      : { tab: nextTab }),
  };
}
