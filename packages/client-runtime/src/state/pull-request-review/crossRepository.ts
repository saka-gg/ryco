import type {
  ChangeRequest,
  ChangeRequestInvolvement,
  EnvironmentId,
  SourceControlInvolvedChangeRequest,
  SourceControlInvolvedChangeRequestsResult,
  SourceControlInvolvedChangeRequestsSource,
} from "@ryco/contracts";
import {
  INVOLVED_CHANGE_REQUESTS_MAX_CWDS,
  INVOLVED_CHANGE_REQUESTS_MAX_LIMIT,
} from "@ryco/contracts/change-request-review";
import { repositoryKeyWithoutPort } from "@ryco/shared/git";
import * as Equal from "effect/Equal";

import { epochMillis } from "./internal.ts";

/**
 * Pull requests that need the viewer across repositories and nodes: which
 * node reads which checkouts, and one list out of every node's answer. Each
 * node answers through its own session (`sourceControl.listInvolvedChangeRequests`);
 * rows are display data, and every read or mutation of a selected one goes
 * through a checkout of its repository.
 */

/** The involvements the list asks for: "Needs your review" and "Yours". */
export const CROSS_REPOSITORY_INVOLVEMENTS: ReadonlyArray<ChangeRequestInvolvement> = [
  "review-requested",
  "authored",
];

/** Rows per involvement and source (one host search page). */
export const CROSS_REPOSITORY_ROW_LIMIT = INVOLVED_CHANGE_REQUESTS_MAX_LIMIT;

export interface CrossRepositoryCheckout {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** `checkoutRepositoryKey` of the checkout's remote (`github.com/acme/app`); null skips it. */
  readonly repositoryKey: string | null;
  /** The repository identity's host kind (`github`, `gitlab`, …); null when unknown. */
  readonly provider: string | null;
  /** The representative checkout of its logical repository. */
  readonly representative: boolean;
}

export interface CrossRepositoryReadTarget {
  readonly environmentId: EnvironmentId;
  /**
   * `hosts`: one search per host (GitHub checkouts, a few per host), answered apart so slow
   * repository lists never hold these rows back. `all`: every other repository; the node
   * reads each through its own lists, or searches its host when it can.
   */
  readonly sources: "hosts" | "all";
  /** Sorted, so the read's cache key is stable. */
  readonly cwds: ReadonlyArray<string>;
  /** Checkouts past `INVOLVED_CHANGE_REQUESTS_MAX_CWDS` left out. */
  readonly omittedCwds: number;
  /**
   * What the sent checkouts of a known host kind read: a host (through the first of its
   * checkouts the node resolves) or one repository. A group whose every checkout the node
   * skips (`skippedCwds`) is missing from the answer.
   */
  readonly groups: ReadonlyArray<CrossRepositoryReadGroup>;
}

export interface CrossRepositoryReadGroup {
  /** The host the checkouts' remotes name (`github.com`), or the checkout's folder name. */
  readonly name: string;
  readonly cwds: ReadonlyArray<string>;
}

/**
 * Checkouts sent per GitHub host and node. The node reads the host through the first that
 * resolves, so a checkout whose folder or remote is gone does not lose the host's rows; the
 * node resolves them in one parallel wave.
 */
export const CROSS_REPOSITORY_HOST_CHECKOUTS = 4;

/** `github.com` for `github.com/acme/app` (no port); null for keys without a host (Azure DevOps). */
export function crossRepositoryKeyHost(repositoryKey: string): string | null {
  const key = repositoryKeyWithoutPort(repositoryKey);
  if (key.startsWith("azure:")) return null;
  const slash = key.indexOf("/");
  return (slash === -1 ? key : key.slice(0, slash)) || null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/u).findLast(Boolean) ?? cwd;
}

/**
 * Which node reads which checkouts. On each capable node, GitHub checkouts contribute a few
 * cwds per host (`CROSS_REPOSITORY_HOST_CHECKOUTS`): a host search costs one request
 * whatever the repository count, and each node's own login may differ, so every node
 * searches its hosts. Every other repository costs one or more CLI processes per
 * involvement, so it is read once across nodes: through its representative checkout when
 * that node is capable, else through the preferred (primary) node's checkout, else the
 * first capable one.
 */
export function planCrossRepositoryReads(input: {
  readonly checkouts: ReadonlyArray<CrossRepositoryCheckout>;
  readonly capableEnvironments: ReadonlySet<EnvironmentId>;
  readonly preferredEnvironmentId: EnvironmentId | null;
}): ReadonlyArray<CrossRepositoryReadTarget> {
  const hostCwds = new Map<EnvironmentId, Map<string, string[]>>();
  const otherRepositories = new Map<string, CrossRepositoryCheckout[]>();
  for (const checkout of input.checkouts) {
    if (checkout.repositoryKey === null) continue;
    const host = crossRepositoryKeyHost(checkout.repositoryKey);
    if (checkout.provider === "github" && host !== null) {
      if (!input.capableEnvironments.has(checkout.environmentId)) continue;
      const byHost = hostCwds.get(checkout.environmentId) ?? new Map<string, string[]>();
      pushTo(byHost, host, checkout.cwd);
      hostCwds.set(checkout.environmentId, byHost);
      continue;
    }
    // Keys that name one repository (`repositoryKeysMatch`) share a read.
    pushTo(otherRepositories, repositoryKeyWithoutPort(checkout.repositoryKey), checkout);
  }

  const repositoryCheckouts = new Map<EnvironmentId, CrossRepositoryCheckout[]>();
  for (const checkouts of otherRepositories.values()) {
    const capable = checkouts
      .filter((checkout) => input.capableEnvironments.has(checkout.environmentId))
      .toSorted(
        (left, right) =>
          compareText(left.environmentId, right.environmentId) || compareText(left.cwd, right.cwd),
      );
    const chosen =
      capable.find((checkout) => checkout.representative) ??
      capable.find((checkout) => checkout.environmentId === input.preferredEnvironmentId) ??
      capable[0];
    if (chosen) pushTo(repositoryCheckouts, chosen.environmentId, chosen);
  }

  const environments = [...new Set([...hostCwds.keys(), ...repositoryCheckouts.keys()])].toSorted(
    compareText,
  );
  const targets: CrossRepositoryReadTarget[] = [];
  const target = (
    environmentId: EnvironmentId,
    sources: CrossRepositoryReadTarget["sources"],
    cwds: Iterable<string>,
    groups: ReadonlyArray<CrossRepositoryReadGroup>,
  ) => {
    const sorted = [...new Set(cwds)].toSorted(compareText);
    const sent = sorted.slice(0, INVOLVED_CHANGE_REQUESTS_MAX_CWDS);
    const isSent = new Set(sent);
    targets.push({
      environmentId,
      sources,
      cwds: sent,
      omittedCwds: sorted.length - sent.length,
      groups: groups.flatMap((group) => {
        const groupCwds = group.cwds.filter((cwd) => isSent.has(cwd));
        return groupCwds.length > 0 ? [{ name: group.name, cwds: groupCwds }] : [];
      }),
    });
  };
  for (const environmentId of environments) {
    const hosts = [...(hostCwds.get(environmentId) ?? [])].map(([host, cwds]) => ({
      name: host,
      cwds: cwds.toSorted(compareText).slice(0, CROSS_REPOSITORY_HOST_CHECKOUTS),
    }));
    if (hosts.length > 0) {
      target(
        environmentId,
        "hosts",
        hosts.flatMap((host) => host.cwds),
        hosts,
      );
    }
    const repositories = repositoryCheckouts.get(environmentId) ?? [];
    if (repositories.length > 0) {
      target(
        environmentId,
        "all",
        repositories.map((checkout) => checkout.cwd),
        // A checkout of an unknown host kind is read in case its node knows the host; the
        // node skipping it is no news.
        repositories.flatMap((checkout) =>
          checkout.provider === null
            ? []
            : [{ name: folderName(checkout.cwd), cwds: [checkout.cwd] }],
        ),
      );
    }
  }
  return targets;
}

// ── One list out of every answer ─────────────────────────────────────

export interface CrossRepositoryAnswer {
  readonly environmentId: EnvironmentId;
  readonly result: SourceControlInvolvedChangeRequestsResult;
}

export type CrossRepositoryRowBase = ChangeRequest & {
  /** `${repositoryKey}#${number}`. */
  readonly rowKey: string;
  /** `changeRequestRepositoryKey` of the row's URL (`github.com/acme/app`). */
  readonly repositoryKey: string;
  /** `acme/app`. */
  readonly repositoryLabel: string;
  readonly involvements: ReadonlySet<ChangeRequestInvolvement>;
  /** Nodes whose answers held this row, in answer order. */
  readonly reportedBy: ReadonlyArray<EnvironmentId>;
  /** The login the first reporting node's host search answered for; null when unsaid. */
  readonly viewerLogin: string | null;
};

export function crossRepositoryRowKey(repositoryKey: string, number: number): string {
  return `${repositoryKey}#${number}`;
}

function updatedMillis(changeRequest: Pick<ChangeRequest, "updatedAt">): number {
  return epochMillis(changeRequest.updatedAt) ?? Number.NEGATIVE_INFINITY;
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

const ROW_FIELDS = new Set([
  "rowKey",
  "repositoryKey",
  "repositoryLabel",
  "involvements",
  "reportedBy",
  "viewerLogin",
]);

function sameRow(left: CrossRepositoryRowBase, right: CrossRepositoryRowBase): boolean {
  if (
    left.rowKey !== right.rowKey ||
    left.repositoryLabel !== right.repositoryLabel ||
    left.viewerLogin !== right.viewerLogin ||
    !sameSet(left.involvements, right.involvements) ||
    left.reportedBy.length !== right.reportedBy.length ||
    left.reportedBy.some((environmentId, index) => environmentId !== right.reportedBy[index])
  ) {
    return false;
  }
  const changeRequestKeys = (row: CrossRepositoryRowBase) =>
    Object.keys(row).filter((key) => !ROW_FIELDS.has(key));
  const keys = changeRequestKeys(left);
  // Structural: decoded rows carry fresh Options, DateTimes and arrays on every answer.
  return (
    keys.length === changeRequestKeys(right).length &&
    keys.every(
      (key) =>
        key in right &&
        Equal.equals(
          (left as unknown as Record<string, unknown>)[key],
          (right as unknown as Record<string, unknown>)[key],
        ),
    )
  );
}

/** Each host source's login, by host (`github.com` → `octocat`). */
function hostLogins(
  sources: ReadonlyArray<SourceControlInvolvedChangeRequestsSource>,
): ReadonlyMap<string, string> {
  const logins = new Map<string, string>();
  for (const source of sources) {
    if (source.scope !== "host" || !source.viewerLogin) continue;
    const host = crossRepositoryKeyHost(source.name);
    if (host !== null && !logins.has(host)) logins.set(host, source.viewerLogin);
  }
  return logins;
}

interface MergingRow {
  changeRequest: ChangeRequest;
  readonly repositoryKey: string;
  repositoryLabel: string;
  readonly involvements: Set<ChangeRequestInvolvement>;
  readonly reportedBy: EnvironmentId[];
  viewerLogin: string | null;
}

/**
 * One row per (repository, number) across nodes: involvements unioned, the later
 * `updatedAt` wins the fields, `reportedBy` keeps every node. A row equal to its
 * `previous` one keeps that object, so memoized rows keep their props.
 */
export function mergeCrossRepositoryChangeRequests(
  answers: ReadonlyArray<CrossRepositoryAnswer>,
  previous?: ReadonlyMap<string, CrossRepositoryRowBase>,
): ReadonlyMap<string, CrossRepositoryRowBase> {
  const merging = new Map<string, MergingRow>();
  for (const answer of answers) {
    const logins = hostLogins(answer.result.sources);
    for (const entry of answer.result.entries) {
      const rowKey = crossRepositoryRowKey(entry.repositoryKey, entry.changeRequest.number);
      const host = crossRepositoryKeyHost(entry.repositoryKey);
      const login = host === null ? null : (logins.get(host) ?? null);
      const existing = merging.get(rowKey);
      if (existing === undefined) {
        merging.set(rowKey, {
          changeRequest: entry.changeRequest,
          repositoryKey: entry.repositoryKey,
          repositoryLabel: entry.repositoryLabel,
          involvements: new Set(entry.involvements),
          reportedBy: [answer.environmentId],
          viewerLogin: login,
        });
        continue;
      }
      for (const involvement of entry.involvements) existing.involvements.add(involvement);
      if (!existing.reportedBy.includes(answer.environmentId)) {
        existing.reportedBy.push(answer.environmentId);
      }
      existing.viewerLogin ??= login;
      if (updatedMillis(entry.changeRequest) > updatedMillis(existing.changeRequest)) {
        existing.changeRequest = entry.changeRequest;
        existing.repositoryLabel = entry.repositoryLabel;
      }
    }
  }
  const rows = new Map<string, CrossRepositoryRowBase>();
  for (const [rowKey, row] of merging) {
    const next: CrossRepositoryRowBase = {
      ...row.changeRequest,
      rowKey,
      repositoryKey: row.repositoryKey,
      repositoryLabel: row.repositoryLabel,
      involvements: row.involvements,
      reportedBy: row.reportedBy,
      viewerLogin: row.viewerLogin,
    };
    const kept = previous?.get(rowKey);
    rows.set(rowKey, kept !== undefined && sameRow(kept, next) ? kept : next);
  }
  return rows;
}

// ── SSH host aliases ─────────────────────────────────────────────────

/** Each node's SSH host aliases: alias host → the host it resolves to. */
export type CrossRepositoryHostAliases = ReadonlyMap<EnvironmentId, ReadonlyMap<string, string>>;

/**
 * Each node's SSH host aliases (`github.com-work` → `github.com`), from the host sources
 * that say which alias their checkouts' remotes name (`checkoutHost`). Per node: each
 * machine has its own SSH config.
 */
export function crossRepositoryHostAliases(
  answers: ReadonlyArray<CrossRepositoryAnswer>,
): CrossRepositoryHostAliases {
  const aliases = new Map<EnvironmentId, Map<string, string>>();
  for (const answer of answers) {
    for (const source of answer.result.sources) {
      if (source.scope !== "host" || !source.checkoutHost) continue;
      const alias = crossRepositoryKeyHost(source.checkoutHost);
      const host = crossRepositoryKeyHost(source.name);
      if (alias === null || host === null || alias === host) continue;
      const byAlias = aliases.get(answer.environmentId) ?? new Map<string, string>();
      byAlias.set(alias, host);
      aliases.set(answer.environmentId, byAlias);
    }
  }
  return aliases;
}

/**
 * A checkout's repository key as its rows' keys name it: lowercase, without a port, and
 * with its node's SSH host alias resolved (`github.com-work/acme/app` → `github.com/acme/app`).
 */
export function resolveCrossRepositoryCheckoutKey(
  repositoryKey: string,
  aliases: ReadonlyMap<string, string> | undefined,
): string {
  const key = repositoryKeyWithoutPort(repositoryKey);
  const host = crossRepositoryKeyHost(key);
  const resolved = host === null ? undefined : aliases?.get(host);
  return host === null || resolved === undefined ? key : `${resolved}${key.slice(host.length)}`;
}

function sourceHolds(
  source: SourceControlInvolvedChangeRequestsSource,
  entry: SourceControlInvolvedChangeRequest,
): boolean {
  if (source.scope === "host") {
    const host = crossRepositoryKeyHost(source.name);
    return host !== null && host === crossRepositoryKeyHost(entry.repositoryKey);
  }
  // A repository source names its label only: the host kind tells `acme/tools` apart across hosts.
  return (
    source.provider === entry.changeRequest.provider &&
    source.name.toLowerCase() === entry.repositoryLabel.toLowerCase()
  );
}

/**
 * A host source still `loading` under the SSH host alias its read was planned with, named
 * as the previous answer's resolved one (`github.com-work` → `github.com`, keeping
 * `checkoutHost`), so it holds that source's rows and its checkouts keep their alias.
 */
function resolveLoadingAlias(
  source: SourceControlInvolvedChangeRequestsSource,
  previous: SourceControlInvolvedChangeRequestsResult,
): SourceControlInvolvedChangeRequestsSource {
  if (source.scope !== "host" || source.status !== "loading" || source.checkoutHost) {
    return source;
  }
  const resolved = previous.sources.find(
    (candidate) =>
      candidate.scope === "host" &&
      candidate.checkoutHost?.toLowerCase() === source.name.toLowerCase(),
  );
  return resolved?.checkoutHost
    ? { ...source, name: resolved.name, checkoutHost: resolved.checkoutHost }
    : source;
}

/**
 * A node's new answer, keeping the previous answer's rows of every source the new one
 * reports as still `loading` (its read outlived the answer's deadline): those rows stay on
 * screen until the read lands instead of blinking out. A host source loading under an SSH
 * host alias takes the previous answer's resolved name. Everything else is the new answer's.
 */
export function keepCrossRepositoryRowsWhileLoading(
  previous: SourceControlInvolvedChangeRequestsResult | null,
  answer: SourceControlInvolvedChangeRequestsResult,
): SourceControlInvolvedChangeRequestsResult {
  if (previous === null || !answer.sources.some((source) => source.status === "loading")) {
    return answer;
  }
  const next: SourceControlInvolvedChangeRequestsResult = {
    ...answer,
    sources: answer.sources.map((source) => resolveLoadingAlias(source, previous)),
  };
  const loading = next.sources.filter((source) => source.status === "loading");
  const present = new Set(
    next.entries.map((entry) =>
      crossRepositoryRowKey(entry.repositoryKey, entry.changeRequest.number),
    ),
  );
  const kept = previous.entries.filter(
    (entry) =>
      !present.has(crossRepositoryRowKey(entry.repositoryKey, entry.changeRequest.number)) &&
      loading.some((source) => sourceHolds(source, entry)),
  );
  return kept.length === 0 ? next : { ...next, entries: [...next.entries, ...kept] };
}
