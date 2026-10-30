import type {
  ChangeRequest,
  EnvironmentId,
  SourceControlChangeRequestDetail,
  SourceControlInvolvedChangeRequestsResult,
  SourceControlLabel,
} from "@ryco/contracts";
import {
  CROSS_REPOSITORY_ROW_LIMIT,
  crossRepositoryKeyHost,
  crossRepositoryRowKey,
  pullRequestListFilter,
  rankChangeRequests,
  resolveCrossRepositoryCheckoutKey,
  resolvePullRequestsStateFilter,
  sortPullRequestGroups,
  type ChangeRequestListGroup,
  type CrossRepositoryHostAliases,
  type CrossRepositoryReadTarget,
  type CrossRepositoryRowBase,
} from "@ryco/client-runtime/state/pull-request-review";
import {
  changeRequestRepositoryKey,
  checkoutRepositoryKey,
  repositoryKeyWithoutPort,
} from "@ryco/shared/git";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type {
  CheckoutEnvironmentSync,
  ProjectCheckoutOption,
} from "../../../projectCheckouts.logic";
import type { SourceControlQueryState } from "../../../rpc/sourceControlAtoms";
import type { PullRequestsSearch } from "../pullRequestsSearch";

/**
 * The pull requests page's All repositories list: the rows every node reported
 * (merged in `@ryco/client-runtime`), each tied to a checkout it opens through,
 * filtered and ranked like one repository's list, plus the notes that say what
 * the list could not read.
 */

export type CrossRepositoryRow = CrossRepositoryRowBase & {
  /**
   * The checkout the row opens through: one on a node that reported it first, else one
   * on a node that can be read now, else the repository's representative. Null: the
   * repository is not in Ryco.
   */
  readonly checkout: ProjectCheckoutOption | null;
};

export type CrossRepositoryAnswerState =
  SourceControlQueryState<SourceControlInvolvedChangeRequestsResult>;

// ── Nodes ──────────────────────────────────────────────────────────────

export interface CrossRepositoryEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly sync: CheckoutEnvironmentSync;
  /** Its session admits source-control reads now (always outside the hosted Hub). */
  readonly admitted: boolean;
  /** Its node answers `listInvolvedChangeRequests`; null while its config is unknown. */
  readonly capable: boolean | null;
}

/**
 * - `ready`: asked for its pull requests.
 * - `pending`: still connecting, or its config is not in yet; it joins once ready.
 * - `outdated`: its Ryco predates the read.
 * - `offline`: its connection dropped or failed, or Ryco no longer knows the node (it will
 *   not connect, so the list does not wait for it).
 * - `closed`: online, but its hosted session is not open (the Hub keeps sessions for
 *   the nodes in use only); opening it includes its repositories.
 */
export type CrossRepositoryEnvironmentReadiness =
  | "ready"
  | "pending"
  | "outdated"
  | "offline"
  | "closed";

export function crossRepositoryEnvironmentReadiness(
  environment: CrossRepositoryEnvironment,
): CrossRepositoryEnvironmentReadiness {
  if (environment.sync === "offline" || environment.sync === "unknown") return "offline";
  if (environment.sync !== "synced") return "pending";
  if (!environment.admitted) return "closed";
  if (environment.capable === null) return "pending";
  return environment.capable ? "ready" : "outdated";
}

// ── Rows ───────────────────────────────────────────────────────────────

function comparableKey(repositoryKey: string): string {
  return repositoryKeyWithoutPort(repositoryKey);
}

/** The checkout's repository as rows name it: its node's SSH host alias resolved. */
function checkoutComparableKey(
  option: ProjectCheckoutOption,
  hostAliases: CrossRepositoryHostAliases | undefined,
): string | null {
  const key = checkoutRepositoryKey(option.repositoryRemoteUrl);
  return key === null
    ? null
    : resolveCrossRepositoryCheckoutKey(key, hostAliases?.get(option.environmentId));
}

function representativeFirst(left: ProjectCheckoutOption, right: ProjectCheckoutOption): number {
  return Number(right.isRepresentative) - Number(left.isRepresentative);
}

function pickCheckout(
  row: CrossRepositoryRowBase,
  candidates: ReadonlyArray<ProjectCheckoutOption> | undefined,
  readable: ReadonlySet<EnvironmentId>,
): ProjectCheckoutOption | null {
  if (!candidates || candidates.length === 0) return null;
  const ordered = candidates.toSorted(representativeFirst);
  for (const environmentId of row.reportedBy) {
    const onReporter = ordered.find((option) => option.environmentId === environmentId);
    if (onReporter) return onReporter;
  }
  return ordered.find((option) => readable.has(option.environmentId)) ?? ordered[0] ?? null;
}

function sameRowBase(row: CrossRepositoryRow, base: CrossRepositoryRowBase): boolean {
  const fields = base as unknown as Record<string, unknown>;
  const current = row as unknown as Record<string, unknown>;
  const keys = Object.keys(fields);
  // `checkout` is the one field a row adds.
  return (
    keys.length + 1 === Object.keys(current).length &&
    keys.every((key) => fields[key] === current[key])
  );
}

/**
 * Ties each row to the checkout it opens through (see `CrossRepositoryRow.checkout`). A
 * row equal to its `previous` one keeps that object.
 */
export function attachCrossRepositoryCheckouts(input: {
  readonly rows: ReadonlyMap<string, CrossRepositoryRowBase>;
  readonly checkouts: ReadonlyArray<ProjectCheckoutOption>;
  /** Nodes whose checkouts can be read now. */
  readonly readable: ReadonlySet<EnvironmentId>;
  /** Each node's SSH host aliases (`crossRepositoryHostAliases` of the answers). */
  readonly hostAliases?: CrossRepositoryHostAliases | undefined;
  readonly previous?: ReadonlyMap<string, CrossRepositoryRow> | undefined;
}): ReadonlyMap<string, CrossRepositoryRow> {
  const byRepository = new Map<string, ProjectCheckoutOption[]>();
  for (const option of input.checkouts) {
    const key = checkoutComparableKey(option, input.hostAliases);
    if (key === null) continue;
    const options = byRepository.get(key);
    if (options) options.push(option);
    else byRepository.set(key, [option]);
  }
  const rows = new Map<string, CrossRepositoryRow>();
  for (const [rowKey, base] of input.rows) {
    const checkout = pickCheckout(
      base,
      byRepository.get(comparableKey(base.repositoryKey)),
      input.readable,
    );
    const kept = input.previous?.get(rowKey);
    rows.set(
      rowKey,
      kept !== undefined && kept.checkout === checkout && sameRowBase(kept, base)
        ? kept
        : { ...base, checkout },
    );
  }
  return rows;
}

// ── Mutation results over stale answers ────────────────────────────────

/** How long a mutation result stands over the nodes' answers: their server cache's lifetime. */
export const CROSS_REPOSITORY_OVERLAY_TTL_MS = 4 * 60_000;

const OVERLAY_FIELDS = [
  "title",
  "state",
  "isDraft",
  "reviewDecision",
  "mergeability",
  "mergeStateStatus",
  "updatedAt",
] as const satisfies ReadonlyArray<keyof ChangeRequest>;

export interface CrossRepositoryOverlay {
  readonly rowKey: string;
  readonly fields: Partial<Pick<ChangeRequest, (typeof OVERLAY_FIELDS)[number]>>;
  readonly updatedAtMs: number | null;
  readonly recordedAtMs: number;
}

function updatedMillis(entry: Pick<ChangeRequest, "updatedAt">): number | null {
  return Option.match(entry.updatedAt, {
    onNone: () => null,
    onSome: (updatedAt) => DateTime.toEpochMillis(updatedAt),
  });
}

/**
 * What a fresh detail (the reader's, written by every mutation) says about its row: the
 * state, draft, review decision and merge readiness. Another node's cached answer may still
 * report the row as it was; the overlay stands over it for one cache lifetime.
 */
export function crossRepositoryOverlayFromDetail(
  detail: SourceControlChangeRequestDetail,
  nowMs: number,
): CrossRepositoryOverlay | null {
  const repositoryKey = changeRequestRepositoryKey(detail.url);
  if (repositoryKey === null) return null;
  const fields: Record<string, unknown> = {};
  for (const field of OVERLAY_FIELDS) {
    if (detail[field] !== undefined) fields[field] = detail[field];
  }
  return {
    rowKey: crossRepositoryRowKey(repositoryKey, detail.number),
    fields: fields as CrossRepositoryOverlay["fields"],
    updatedAtMs: updatedMillis(detail),
    recordedAtMs: nowMs,
  };
}

/**
 * Applies each fresh overlay to its row (matched by repository and number), unless the row
 * was updated after the overlay's detail. Rows the overlays leave alone keep their objects.
 */
export function applyCrossRepositoryOverlays(
  rows: ReadonlyMap<string, CrossRepositoryRowBase>,
  overlays: Iterable<CrossRepositoryOverlay>,
  nowMs: number,
): ReadonlyMap<string, CrossRepositoryRowBase> {
  const byComparableKey = new Map<string, string>();
  for (const rowKey of rows.keys()) byComparableKey.set(comparableKey(rowKey), rowKey);
  let next: Map<string, CrossRepositoryRowBase> | null = null;
  for (const overlay of overlays) {
    if (nowMs - overlay.recordedAtMs >= CROSS_REPOSITORY_OVERLAY_TTL_MS) continue;
    const rowKey = byComparableKey.get(comparableKey(overlay.rowKey));
    const row = rowKey === undefined ? undefined : (next ?? rows).get(rowKey);
    if (rowKey === undefined || row === undefined) continue;
    const rowUpdatedMs = updatedMillis(row);
    if (overlay.updatedAtMs !== null && rowUpdatedMs !== null && rowUpdatedMs > overlay.updatedAtMs)
      continue;
    const changes = Object.entries(overlay.fields).filter(([field, value]) =>
      field === "updatedAt"
        ? // A detail without a time never erases the row's.
          overlay.updatedAtMs !== null && rowUpdatedMs !== overlay.updatedAtMs
        : (row as unknown as Record<string, unknown>)[field] !== value,
    );
    if (changes.length === 0) continue;
    next ??= new Map(rows);
    next.set(rowKey, { ...row, ...Object.fromEntries(changes) });
  }
  return next ?? rows;
}

// ── The list ───────────────────────────────────────────────────────────

export interface CrossRepositoryListModel {
  /** Ranked, filtered groups (needs your review / yours). */
  readonly groups: ReadonlyArray<ChangeRequestListGroup<CrossRepositoryRow>>;
  /** Visible rows in display order (folded groups out), for J/K. */
  readonly ordered: ReadonlyArray<CrossRepositoryRow>;
  /** Every row that opens in Ryco, filtered out or not, by row key. */
  readonly byKey: ReadonlyMap<string, CrossRepositoryRow>;
  /** The row the URL selects (`env`/`project`/`pr`). */
  readonly selectedKey: string | null;
  readonly labels: ReadonlyArray<SourceControlLabel>;
  readonly notes: ReadonlyArray<CrossRepositoryNote>;
  /** Nothing to show yet, and a read is on its way. */
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  /** Read every node again, past the server's cache (a few seconds' cooldown). */
  readonly refresh: () => void;
}

function isOwnRow(row: CrossRepositoryRow): boolean {
  return row.involvements.has("authored");
}

function isReviewRequestedRow(row: CrossRepositoryRow): boolean {
  return row.involvements.has("review-requested");
}

/**
 * Filters and ranks the rows the way one repository's list does (`pullRequestListFilter`,
 * readiness tiers, "Recently updated"), with "Yours" and "Needs your review" from each
 * row's own involvements. Rows from repositories not in Ryco are left out and counted.
 * No stacks: stack numbers collide across repositories.
 */
export function deriveCrossRepositoryList(input: {
  readonly rows: ReadonlyMap<string, CrossRepositoryRow>;
  readonly search: PullRequestsSearch;
  readonly foldedGroups: ReadonlyArray<string>;
  /** Show rows from repositories not in Ryco (they open on the host). Default false. */
  readonly showOtherRepositories?: boolean | undefined;
}): Pick<CrossRepositoryListModel, "groups" | "ordered" | "byKey" | "labels"> & {
  readonly hiddenCount: number;
} {
  const { search } = input;
  const state = resolvePullRequestsStateFilter(search);
  const matches = pullRequestListFilter<CrossRepositoryRow>(search, {
    isOwn: isOwnRow,
    isReviewRequested: isReviewRequestedRow,
  });
  const byKey = new Map<string, CrossRepositoryRow>();
  const labels = new Map<string, SourceControlLabel>();
  const shown: CrossRepositoryRow[] = [];
  let hiddenCount = 0;
  for (const [rowKey, row] of input.rows) {
    const opens = row.checkout !== null || input.showOtherRepositories === true;
    if (opens) {
      byKey.set(rowKey, row);
      for (const label of row.labels ?? []) labels.set(label.name, label);
    }
    // A mutation overlay can move a row out of the state the nodes were asked for.
    if ((state !== "all" && row.state !== state) || !matches(row)) continue;
    if (opens) shown.push(row);
    else hiddenCount += 1;
  }
  const groups = sortPullRequestGroups(
    rankChangeRequests(shown, null, {
      isOwn: isOwnRow,
      isReviewRequested: isReviewRequestedRow,
      ...(search.q ? { query: search.q } : {}),
    }),
    search,
  );
  const folded = new Set(input.foldedGroups);
  return {
    groups,
    ordered: groups.filter((group) => !folded.has(group.key)).flatMap((group) => group.entries),
    byKey,
    labels: [...labels.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    hiddenCount,
  };
}

/** The row `env`/`project`/`pr` select: that number in the checkout's repository. */
export function resolveCrossRepositorySelectedKey(input: {
  readonly search: Pick<PullRequestsSearch, "env" | "project" | "pr">;
  readonly rows: ReadonlyMap<string, CrossRepositoryRow>;
  readonly checkouts: ReadonlyArray<ProjectCheckoutOption>;
  readonly hostAliases?: CrossRepositoryHostAliases | undefined;
}): string | null {
  const { search } = input;
  if (search.pr === undefined || search.project === undefined) return null;
  const checkout = input.checkouts.find(
    (option) =>
      option.projectId === search.project &&
      (search.env === undefined || option.environmentId === search.env),
  );
  if (!checkout) return null;
  const repositoryKey = checkoutComparableKey(checkout, input.hostAliases);
  for (const row of input.rows.values()) {
    if (row.number !== search.pr) continue;
    if (row.checkout?.key === checkout.key) return row.rowKey;
    if (repositoryKey !== null && comparableKey(row.repositoryKey) === repositoryKey) {
      return row.rowKey;
    }
  }
  return null;
}

/**
 * The row a pasted link or `#123` names: the link's repository and number, or the only
 * row with that number. Null when the list does not hold it.
 */
export function findCrossRepositoryRowForReference(
  rows: Iterable<CrossRepositoryRow>,
  target:
    | { readonly kind: "number"; readonly number: number }
    | {
        readonly kind: "url";
        readonly number: number;
        readonly url: string;
      },
): CrossRepositoryRow | null {
  const candidates = [...rows].filter((row) => row.number === target.number);
  if (target.kind === "number") return candidates.length === 1 ? (candidates[0] ?? null) : null;
  const repositoryKey = changeRequestRepositoryKey(target.url);
  if (repositoryKey === null) return null;
  const wanted = comparableKey(repositoryKey);
  return candidates.find((row) => comparableKey(row.repositoryKey) === wanted) ?? null;
}

// ── Notes ──────────────────────────────────────────────────────────────

export type CrossRepositoryNote =
  | {
      readonly kind: "source-failed";
      readonly environmentLabel: string | null;
      readonly name: string;
      readonly message: string;
    }
  | {
      readonly kind: "environment-failed";
      readonly environmentLabel: string | null;
      readonly message: string;
    }
  | {
      readonly kind: "environment-unavailable";
      readonly environmentLabel: string;
      readonly reason: "offline" | "closed";
    }
  | { readonly kind: "environment-outdated"; readonly environmentLabel: string }
  | {
      readonly kind: "account";
      readonly environmentLabel: string;
      readonly host: string;
      readonly login: string;
    }
  | { readonly kind: "paused"; readonly environmentLabel: string | null; readonly name: string }
  | { readonly kind: "loading"; readonly environmentLabel: string | null; readonly name: string }
  | { readonly kind: "truncated"; readonly name: string; readonly limit: number }
  /** A node's whole answer passed its row cap; its least recently updated rows were dropped. */
  | { readonly kind: "answer-truncated"; readonly environmentLabel: string | null }
  | { readonly kind: "skipped-rows"; readonly name: string; readonly count: number }
  | {
      readonly kind: "omitted";
      readonly environmentLabel: string | null;
      readonly count: number;
    }
  | { readonly kind: "hidden"; readonly count: number };

const NOTE_ORDER: Record<CrossRepositoryNote["kind"], number> = {
  "source-failed": 0,
  "environment-failed": 1,
  "environment-unavailable": 2,
  "environment-outdated": 3,
  account: 4,
  paused: 5,
  loading: 6,
  truncated: 7,
  "answer-truncated": 8,
  "skipped-rows": 9,
  omitted: 10,
  hidden: 11,
};

const UNNAMED_ENVIRONMENT = "another machine";

function firstLine(message: string): string {
  return (
    message
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? message
  );
}

/**
 * What the list could not read, most actionable first: failed sources and nodes, nodes it
 * cannot ask, differing accounts, sources still loading or cut short, and rows left out.
 */
export function deriveCrossRepositoryNotes(input: {
  /** Every node with a checkout on the page. */
  readonly environments: ReadonlyArray<CrossRepositoryEnvironment>;
  readonly targets: ReadonlyArray<CrossRepositoryReadTarget>;
  /** One per target, in target order. */
  readonly states: ReadonlyArray<CrossRepositoryAnswerState>;
  readonly hiddenCount: number;
}): ReadonlyArray<CrossRepositoryNote> {
  const labels = new Map(
    input.environments.map((environment) => [environment.environmentId, environment.label]),
  );
  // Name the node only when more than one is read.
  const readEnvironments = new Set(input.targets.map((target) => target.environmentId));
  const nodeOf = (environmentId: EnvironmentId): string | null =>
    readEnvironments.size > 1 ? (labels.get(environmentId) ?? UNNAMED_ENVIRONMENT) : null;
  const notes: CrossRepositoryNote[] = [];
  const seen = new Set<string>();
  const add = (note: CrossRepositoryNote) => {
    const key = JSON.stringify(note);
    if (seen.has(key)) return;
    seen.add(key);
    notes.push(note);
  };

  for (const environment of input.environments) {
    const label = environment.label ?? UNNAMED_ENVIRONMENT;
    switch (crossRepositoryEnvironmentReadiness(environment)) {
      case "offline":
        add({ kind: "environment-unavailable", environmentLabel: label, reason: "offline" });
        break;
      case "closed":
        add({ kind: "environment-unavailable", environmentLabel: label, reason: "closed" });
        break;
      case "outdated":
        add({ kind: "environment-outdated", environmentLabel: label });
        break;
      case "pending":
        // Still connecting: its repositories join the list once it answers.
        add({ kind: "loading", environmentLabel: environment.label, name: "pull requests" });
        break;
      case "ready":
        break;
    }
  }

  const logins = new Map<string, Map<EnvironmentId, string>>();
  input.targets.forEach((target, index) => {
    const state = input.states[index];
    const node = nodeOf(target.environmentId);
    if (target.omittedCwds > 0) {
      add({ kind: "omitted", environmentLabel: node, count: target.omittedCwds });
    }
    if (!state) return;
    if (state.error !== null) {
      add({
        kind: "environment-failed",
        environmentLabel: node,
        message: firstLine(state.error.message),
      });
    }
    if (state.data?.truncated) add({ kind: "answer-truncated", environmentLabel: node });
    // Checkouts the node could not open (a folder or remote since gone): a host or repository
    // whose every checkout it skipped is missing from the answer.
    const skipped = new Set(state.data?.skippedCwds ?? []);
    for (const group of skipped.size > 0 ? target.groups : []) {
      if (!group.cwds.every((cwd) => skipped.has(cwd))) continue;
      add({
        kind: "source-failed",
        environmentLabel: node,
        name: group.name,
        message:
          group.cwds.length === 1
            ? "Its checkout couldn’t be opened."
            : "None of its checkouts could be opened.",
      });
    }
    for (const source of state.data?.sources ?? []) {
      switch (source.status) {
        case "failed":
          add({
            kind: "source-failed",
            environmentLabel: node,
            name: source.name,
            message: source.message ?? "The host did not answer.",
          });
          break;
        case "paused":
          add({ kind: "paused", environmentLabel: node, name: source.name });
          break;
        case "loading":
          add({ kind: "loading", environmentLabel: node, name: source.name });
          break;
        case "ok":
          break;
      }
      if (source.truncated) {
        add({ kind: "truncated", name: source.name, limit: CROSS_REPOSITORY_ROW_LIMIT });
      }
      if ((source.skippedRows ?? 0) > 0) {
        add({ kind: "skipped-rows", name: source.name, count: source.skippedRows ?? 0 });
      }
      const host = source.scope === "host" ? crossRepositoryKeyHost(source.name) : null;
      if (host !== null && source.viewerLogin) {
        const byEnvironment = logins.get(host) ?? new Map<EnvironmentId, string>();
        byEnvironment.set(target.environmentId, source.viewerLogin);
        logins.set(host, byEnvironment);
      }
    }
  });

  // Nodes signed in to one host as different accounts: say who each reads as.
  for (const [host, byEnvironment] of logins) {
    const distinct = new Set([...byEnvironment.values()].map((login) => login.toLowerCase()));
    if (distinct.size < 2) continue;
    for (const [environmentId, login] of byEnvironment) {
      add({
        kind: "account",
        environmentLabel: labels.get(environmentId) ?? UNNAMED_ENVIRONMENT,
        host,
        login,
      });
    }
  }

  if (input.hiddenCount > 0) add({ kind: "hidden", count: input.hiddenCount });
  return notes.toSorted((left, right) => NOTE_ORDER[left.kind] - NOTE_ORDER[right.kind]);
}

const UNREAD_NOTE_KINDS: ReadonlySet<CrossRepositoryNote["kind"]> = new Set([
  "source-failed",
  "environment-failed",
  "environment-unavailable",
  "environment-outdated",
  "paused",
  "loading",
]);

/** Some repository or node could not be read (yet), so an empty list is not the whole answer. */
export function crossRepositoryNotesMissRepositories(
  notes: ReadonlyArray<CrossRepositoryNote>,
): boolean {
  return notes.some((note) => UNREAD_NOTE_KINDS.has(note.kind));
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The one line a note shows. */
export function describeCrossRepositoryNote(note: CrossRepositoryNote): string {
  const on = (label: string | null) => (label === null ? "" : ` on ${label}`);
  switch (note.kind) {
    case "source-failed":
      return `Couldn’t read ${note.name}${on(note.environmentLabel)}: ${note.message}`;
    case "environment-failed":
      return `Couldn’t read pull requests${on(note.environmentLabel)}: ${note.message}`;
    case "environment-unavailable":
      return note.reason === "offline"
        ? `${note.environmentLabel} isn’t connected`
        : `Open ${note.environmentLabel} to include its repositories`;
    case "environment-outdated":
      return `Update Ryco on ${note.environmentLabel} to include its repositories`;
    case "account":
      return `${note.environmentLabel} reads ${note.host} as ${note.login}`;
    case "paused":
      return `${note.name} is rate limited${on(note.environmentLabel)}; it’s read again when the limit resets`;
    case "loading":
      return `Still reading ${note.name}${on(note.environmentLabel)}…`;
    case "truncated":
      return `Showing the ${note.limit} most recently updated from ${note.name}`;
    case "answer-truncated":
      return `Some older pull requests${on(note.environmentLabel)} were left out`;
    case "skipped-rows":
      return `${plural(note.count, "pull request", "pull requests")} on ${note.name} ${note.count === 1 ? "is" : "are"} in organizations this login can’t read`;
    case "omitted":
      return `${plural(note.count, "more repository", "more repositories")}${on(note.environmentLabel)} ${note.count === 1 ? "wasn’t" : "weren’t"} read`;
    case "hidden":
      return `${note.count} more in repositories not added to Ryco`;
  }
}
