/**
 * Change requests involving the viewer across a node's repositories
 * (`sourceControl.listInvolvedChangeRequests`). Loaded with `import()` by the
 * handler, so none of it is on the server's boot path.
 *
 * A host that searches across repositories (GitHub) is read with one search per
 * involvement through any one of its checkouts, instead of one list per
 * repository; every other repository reads its own involvement lists. Reads are
 * cached per host or repository for a few minutes and dropped by change request
 * mutations (`GitManager.cachedInvolvedList`). The reads run in one pool, at most
 * four at a time; the answer waits for them up to a deadline, and reads still
 * running then are reported as `loading` and keep filling the cache for the next
 * call, so slow or unreachable forges never hold the answer back. A failed source
 * is reported in `sources` and never fails the call.
 */
import { Cause, DateTime, Deferred, Effect, Exit, Option } from "effect";
import {
  INVOLVED_CHANGE_REQUESTS_MAX_LIMIT,
  type ChangeRequest,
  type ChangeRequestInvolvement,
  type ChangeRequestState,
  type SourceControlInvolvedChangeRequest,
  type SourceControlInvolvedChangeRequestsResult,
  type SourceControlInvolvedChangeRequestsSource,
  type SourceControlListInvolvedChangeRequestsInput,
  type SourceControlProviderError,
} from "@ryco/contracts";
// Only helpers the boot path already loads, plus `checkoutRepositoryKey` (about 0.3 KB, built
// from them): anything else from this module would land in the shared boot chunk.
import { changeRequestRepositoryKey, checkoutRepositoryKey } from "@ryco/shared/git";

import type { GitManagerShape } from "../git/GitManager.ts";
import { inBackgroundProcessLane } from "../processGovernor.ts";
import {
  changeRequestHostKey,
  changeRequestHostName,
  pullRequestIndexRepositoryKey,
} from "./pullRequestIndex.ts";
import type {
  SourceControlInvolvedSearchPage,
  SourceControlProviderShape,
} from "./SourceControlProvider.ts";
import type { SourceControlProviderHandle } from "./SourceControlProviderRegistry.ts";

/** Rows in one answer, newest activity first (two full involvements of one host fit). */
export const INVOLVED_RESPONSE_MAX_ROWS = 300;
/** Lifetime of a cached host search or repository list (Synara's inbox snapshot TTL). */
export const INVOLVED_CACHE_TTL_MS = 4 * 60_000;
/** A refresh reads again what is older than this (Synara's force-refresh cooldown). */
export const INVOLVED_REFRESH_MAX_AGE_MS = 10_000;
/** Lifetime of a host search stored soon after a mutation: search indexes lag behind writes. */
export const INVOLVED_SETTLE_TTL_MS = 15_000;
/** Reads started at once (the forge process pool's size). */
export const INVOLVED_READ_CONCURRENCY = 4;
/**
 * How long one answer waits for its reads, however many there are; reads still running
 * then are reported as `loading` and keep filling the cache.
 */
export const INVOLVED_ANSWER_DEADLINE_MS = 20_000;
/** An answer's reads still running this long after it started are given up. */
const INVOLVED_READS_MAX_MS = 120_000;
const FAILURE_MESSAGE_MAX_CHARS = 300;

export interface InvolvedChangeRequestsDeps {
  readonly resolveHandle: (
    cwd: string,
  ) => Effect.Effect<SourceControlProviderHandle, SourceControlProviderError>;
  readonly cachedInvolvedList: GitManagerShape["cachedInvolvedList"];
}

/**
 * One sentence for a failed read: the first line of the provider's detail, without a
 * `gh:`-style prefix or a command echo, at most 300 characters.
 */
export function summarizeSourceControlFailure(error: unknown): string {
  const detail =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null
        ? "detail" in error && typeof error.detail === "string"
          ? error.detail
          : "message" in error && typeof error.message === "string"
            ? error.message
            : ""
        : "";
  const line =
    detail
      .split(/\r?\n/u)
      .map((part) =>
        part
          .trim()
          .replace(/^(?:gh|glab|az|graphql):\s*/iu, "")
          .replace(/\s+/gu, " "),
      )
      .find((part) => part.length > 0 && !part.startsWith("$")) ?? "";
  const text = line.length > 0 ? line : "The host did not answer.";
  return text.length > FAILURE_MESSAGE_MAX_CHARS
    ? `${text.slice(0, FAILURE_MESSAGE_MAX_CHARS - 1).trimEnd()}…`
    : text;
}

/** `acme/app` for a repository key: the path after the host, `project/repo` on Azure DevOps. */
function labelOfRepositoryKey(key: string): string {
  const path = key.startsWith("azure:")
    ? key.slice("azure:".length).split("/").slice(1).join("/")
    : key.slice(key.indexOf("/") + 1);
  return path.length > 0 && path !== key ? path : key;
}

/**
 * The repository label of a checkout's remote (`acme/tools`), for a source without rows,
 * whatever the remote's SSH user (`gitea@host:acme/tools.git`).
 */
function labelOfRemote(remoteUrl: string): string {
  return labelOfRepositoryKey(checkoutRepositoryKey(remoteUrl) ?? remoteUrl);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * `Acme/App` for a change request URL: the key's repository path as the URL spells it (keys
 * are lowercase). Azure DevOps keeps `project/repo`; Bitbucket Data Center's
 * `projects/{key}/repos/{slug}` reads `{key}/{slug}`.
 */
function labelOfChangeRequestUrl(url: string, repositoryKey: string): string {
  if (repositoryKey.startsWith("azure:")) return labelOfRepositoryKey(repositoryKey);
  const keyPath = labelOfRepositoryKey(repositoryKey);
  const length = keyPath.split("/").length;
  let segments: string[];
  try {
    segments = new URL(url).pathname.split("/").filter(Boolean).slice(0, length).map(decodeSegment);
  } catch {
    segments = [];
  }
  const spelled = segments.join("/");
  const path = spelled.toLowerCase() === keyPath ? spelled : keyPath;
  const dataCenter = /^projects\/([^/]+)\/repos\/([^/]+)$/iu.exec(path);
  return dataCenter ? `${dataCenter[1]}/${dataCenter[2]}` : path;
}

function updatedAtMs(changeRequest: ChangeRequest): number {
  return Option.match(changeRequest.updatedAt, {
    onNone: () => Number.NEGATIVE_INFINITY,
    onSome: (updatedAt) => DateTime.toEpochMillis(updatedAt),
  });
}

interface SourcePlan {
  readonly scope: "host" | "repository";
  readonly cwd: string;
  readonly provider: SourceControlProviderShape;
  /** The host name, or the repository label from the checkout's remote. */
  readonly name: string;
}

type ReadOutcome =
  | { readonly kind: "ok"; readonly page: SourceControlInvolvedSearchPage }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "loading" };

const LOADING: ReadOutcome = { kind: "loading" };

function outcomeOf(
  exit: Exit.Exit<SourceControlInvolvedSearchPage, SourceControlProviderError>,
): ReadOutcome {
  if (Exit.isSuccess(exit)) return { kind: "ok", page: exit.value };
  return {
    kind: "failed",
    message: Cause.hasInterruptsOnly(exit.cause)
      ? "The read was cancelled."
      : summarizeSourceControlFailure(Cause.squash(exit.cause)),
  };
}

/**
 * Run every read in one detached pool, at most four at a time and given up after two
 * minutes, and wait for them until the answer's deadline. However many reads hang, the
 * answer comes by then; a read still running keeps going and fills the cache, so the next
 * call has it.
 */
function readAll(
  reads: ReadonlyArray<Effect.Effect<SourceControlInvolvedSearchPage, SourceControlProviderError>>,
): Effect.Effect<ReadonlyArray<ReadOutcome>> {
  return Effect.gen(function* () {
    const outcomes = reads.map((): ReadOutcome => LOADING);
    const done = yield* Deferred.make<void>();
    yield* Effect.forEach(
      reads,
      (read, index) =>
        read.pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.sync(() => {
              outcomes[index] = outcomeOf(exit);
            }),
          ),
        ),
      { concurrency: INVOLVED_READ_CONCURRENCY, discard: true },
    ).pipe(
      Effect.andThen(Deferred.succeed(done, undefined)),
      Effect.timeoutOption(INVOLVED_READS_MAX_MS),
      Effect.forkDetach,
    );
    yield* Deferred.await(done).pipe(Effect.timeoutOption(INVOLVED_ANSWER_DEADLINE_MS));
    // A copy: reads that finish after the deadline only fill the cache.
    return [...outcomes];
  });
}

interface MergedEntry {
  changeRequest: ChangeRequest;
  readonly repositoryKey: string;
  readonly involvements: Set<ChangeRequestInvolvement>;
}

/** One row per repository and number: involvements unioned, the later `updatedAt` wins. */
function mergeRows(
  merged: Map<string, MergedEntry>,
  items: ReadonlyArray<ChangeRequest>,
  involvement: ChangeRequestInvolvement,
): void {
  for (const changeRequest of items) {
    const repositoryKey = changeRequestRepositoryKey(changeRequest.url);
    if (repositoryKey === null) continue;
    const id = `${repositoryKey}#${changeRequest.number}`;
    const existing = merged.get(id);
    if (existing === undefined) {
      merged.set(id, { changeRequest, repositoryKey, involvements: new Set([involvement]) });
      continue;
    }
    existing.involvements.add(involvement);
    if (updatedAtMs(changeRequest) > updatedAtMs(existing.changeRequest)) {
      existing.changeRequest = changeRequest;
    }
  }
}

interface SourceSummary {
  name: string;
  viewerLogin: string | null;
  truncated: boolean;
  skippedRows: number;
  /** The first failed read's message; null when no read failed. */
  message: string | null;
  /** A read was still running when the answer was due. */
  loading: boolean;
}

function toSource(
  plan: SourcePlan,
  summary: SourceSummary,
): SourceControlInvolvedChangeRequestsSource {
  return {
    scope: plan.scope,
    provider: plan.provider.kind,
    name: summary.name,
    // The host's CLI resolved an SSH host alias: say which, so clients tie the rows to the
    // checkouts whose remotes name the alias.
    ...(plan.scope === "host" && summary.name.toLowerCase() !== plan.name.toLowerCase()
      ? { checkoutHost: plan.name }
      : {}),
    status: summary.message !== null ? "failed" : summary.loading ? "loading" : "ok",
    ...(summary.viewerLogin ? { viewerLogin: summary.viewerLogin } : {}),
    truncated: summary.truncated,
    ...(summary.skippedRows > 0 ? { skippedRows: summary.skippedRows } : {}),
    ...(summary.message !== null ? { message: summary.message } : {}),
  };
}

export const listInvolvedChangeRequests = (
  deps: InvolvedChangeRequestsDeps,
  input: SourceControlListInvolvedChangeRequestsInput,
): Effect.Effect<SourceControlInvolvedChangeRequestsResult> =>
  Effect.gen(function* () {
    const cwds = [...new Set(input.cwds)];
    const limit = Math.min(
      INVOLVED_CHANGE_REQUESTS_MAX_LIMIT,
      Math.max(1, Math.trunc(input.limit ?? INVOLVED_CHANGE_REQUESTS_MAX_LIMIT)),
    );
    const involvements = [...new Set(input.involvements)];
    const state: ChangeRequestState | "all" = input.state;
    const refresh = input.refresh === true;
    const interactive = refresh || input.interactive === true;
    // Polls queue behind the focused surfaces' git and forge children, resolution included.
    const laned = <A, E>(effect: Effect.Effect<A, E>) =>
      interactive ? effect : inBackgroundProcessLane(effect);

    const handles = yield* Effect.forEach(
      cwds,
      (cwd) =>
        laned(deps.resolveHandle(cwd)).pipe(
          Effect.map((handle) => ({ cwd, handle })),
          Effect.orElseSucceed(() => ({ cwd, handle: null })),
        ),
      { concurrency: INVOLVED_READ_CONCURRENCY },
    );

    const skippedCwds: string[] = [];
    const hosts = new Map<string, SourcePlan>();
    const repositories = new Map<string, SourcePlan>();
    for (const { cwd, handle } of handles) {
      const context = handle?.context ?? null;
      if (handle === null || context === null || handle.provider.kind === "unknown") {
        skippedCwds.push(cwd);
        continue;
      }
      const kind = handle.provider.kind;
      const hostKey = changeRequestHostKey({
        providerKind: kind,
        baseUrl: context.provider.baseUrl,
      });
      if (handle.provider.searchInvolvedChangeRequests !== undefined && hostKey !== null) {
        if (!hosts.has(hostKey)) {
          hosts.set(hostKey, {
            scope: "host",
            cwd,
            provider: handle.provider,
            name: changeRequestHostName(context.provider.baseUrl) ?? context.provider.name,
          });
        }
        continue;
      }
      const repositoryKey = pullRequestIndexRepositoryKey({
        providerKind: kind,
        remoteUrl: context.remoteUrl,
      });
      if (!repositories.has(repositoryKey)) {
        repositories.set(repositoryKey, {
          scope: "repository",
          cwd,
          provider: handle.provider,
          // The folder name, never the full path, when the remote has no readable path.
          name: labelOfRemote(context.remoteUrl) || (cwd.split(/[\\/]/u).findLast(Boolean) ?? cwd),
        });
      }
    }

    const plans = [
      ...(input.sources === "repositories" ? [] : hosts.values()),
      ...(input.sources === "hosts" ? [] : repositories.values()),
    ];
    const key = JSON.stringify(["involved", state, limit]);
    const readFor = (plan: SourcePlan, involvement: ChangeRequestInvolvement) => {
      const load: Effect.Effect<SourceControlInvolvedSearchPage, SourceControlProviderError> =
        plan.scope === "host"
          ? Effect.suspend(
              () =>
                plan.provider.searchInvolvedChangeRequests?.({
                  cwd: plan.cwd,
                  involvement,
                  state,
                  limit,
                }) ?? Effect.die("The provider lost its involved search."),
            )
          : plan.provider
              .listChangeRequests({
                cwd: plan.cwd,
                headSelector: "",
                state,
                involvement,
                limit,
                includeStackSummary: false,
              })
              .pipe(
                Effect.map((items) => ({
                  host: plan.name,
                  viewerLogin: null,
                  items,
                  truncated: items.length >= limit,
                  skippedRows: 0,
                })),
              );
      return deps.cachedInvolvedList({
        cwd: plan.cwd,
        scope: plan.scope,
        key: `${key}\u0000${involvement}`,
        load,
        ttlMs: INVOLVED_CACHE_TTL_MS,
        ...(plan.scope === "host" ? { settleTtlMs: INVOLVED_SETTLE_TTL_MS } : {}),
        ...(refresh ? { maxAgeMs: INVOLVED_REFRESH_MAX_AGE_MS } : {}),
      });
    };

    // Plan-major: the reads of plan `p` are `outcomes[p * involvements.length + i]`.
    const outcomes = yield* readAll(
      plans.flatMap((plan) => involvements.map((involvement) => laned(readFor(plan, involvement)))),
    );

    const merged = new Map<string, MergedEntry>();
    const sources = plans.map((plan, planIndex): SourceControlInvolvedChangeRequestsSource => {
      const summary: SourceSummary = {
        name: plan.name,
        viewerLogin: null,
        truncated: false,
        skippedRows: 0,
        message: null,
        loading: false,
      };
      involvements.forEach((involvement, involvementIndex) => {
        const outcome = outcomes[planIndex * involvements.length + involvementIndex]!;
        if (outcome.kind === "failed") {
          summary.message ??= outcome.message;
          return;
        }
        if (outcome.kind === "loading") {
          summary.loading = true;
          return;
        }
        const { page } = outcome;
        if (plan.scope === "host" && page.host.trim().length > 0) summary.name = page.host.trim();
        summary.viewerLogin ??= page.viewerLogin;
        summary.truncated ||= page.truncated;
        summary.skippedRows += page.skippedRows;
        mergeRows(merged, page.items, involvement);
      });
      return toSource(plan, summary);
    });

    const entries = [...merged.values()]
      .toSorted(
        (left, right) =>
          updatedAtMs(right.changeRequest) - updatedAtMs(left.changeRequest) ||
          left.repositoryKey.localeCompare(right.repositoryKey) ||
          right.changeRequest.number - left.changeRequest.number,
      )
      .map((entry): SourceControlInvolvedChangeRequest => ({
        changeRequest: entry.changeRequest,
        repositoryKey: entry.repositoryKey,
        repositoryLabel: labelOfChangeRequestUrl(entry.changeRequest.url, entry.repositoryKey),
        involvements: involvements.filter((involvement) => entry.involvements.has(involvement)),
      }));

    return {
      entries: entries.slice(0, INVOLVED_RESPONSE_MAX_ROWS),
      sources,
      skippedCwds,
      truncated: entries.length > INVOLVED_RESPONSE_MAX_ROWS,
    };
  });
