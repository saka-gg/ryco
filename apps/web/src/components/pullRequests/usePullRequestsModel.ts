import type { ChangeRequest } from "@ryco/contracts";
import { summarizeChangeRequestChecks } from "@ryco/client-runtime/state/pull-request-review";
import { useMemo } from "react";

import { useSettings } from "../../hooks/useSettings";
import { useGitStatus } from "../../lib/gitStatusState";
import { resolveSourceControlRefreshDelay } from "../../rpc/sourceControlRefreshPolicy";
import {
  useSourceControlChangeRequestActivity,
  useSourceControlChangeRequestDetail,
  useSourceControlChangeRequestList,
} from "../../rpc/useSourceControl";
import type { PullRequestRepositoryOption } from "./pullRequestRepositories.logic";
import { usePullRequestsLayoutStore } from "./pullRequestsLayoutStore";
import {
  assemblePullRequestSelection,
  derivePullRequestsCapabilities,
  describePullRequestsListError,
  derivePullRequestSelectionChecks,
  derivePullRequestSelectionNextAction,
  derivePullRequestSelectionThreads,
  derivePullRequestsList,
  PULL_REQUESTS_LIST_LIMIT,
  pullRequestSelectionRefreshPhase,
  type PullRequestsListModel,
  type PullRequestsModel,
  type PullRequestSelectionModel,
} from "./pullRequestsModel.logic";
import { resolvePullRequestsStateFilter, type PullRequestsSearch } from "./pullRequestsSearch";

export type { PullRequestsListModel, PullRequestsModel, PullRequestSelectionModel };

function listPollInterval(
  mode: Parameters<typeof resolveSourceControlRefreshDelay>[0]["mode"],
): (data: ReadonlyArray<ChangeRequest> | null) => number | false {
  return (data) =>
    resolveSourceControlRefreshDelay({
      mode,
      phase: (data ?? []).some(
        (entry) =>
          entry.state === "open" &&
          summarizeChangeRequestChecks(entry.checkRollup).overall === "pending",
      )
        ? "active"
        : "settled",
    });
}

function errorMessage(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) return describePullRequestsListError(error.message);
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return describePullRequestsListError(error.message);
  }
  return describePullRequestsListError(String(error));
}

/**
 * Everything the page reads for one repository: the grouped list (state read
 * plus server-side "authored" and "review requested" reads so the groups are
 * complete on first paint) and, for the selected change request, its detail,
 * activity, and the derived checks / next action / thread index.
 */
export function usePullRequestsModel(input: {
  readonly repository: PullRequestRepositoryOption | null;
  readonly search: PullRequestsSearch;
  /**
   * Read the repository's lists (default). A reader of one change request
   * (the workspace panel) skips them; the selection reads its own detail.
   */
  readonly includeList?: boolean | undefined;
}): PullRequestsModel {
  const { repository, search } = input;
  const listEnabled = repository !== null && (input.includeList ?? true);
  const environmentId = repository?.environmentId ?? null;
  const cwd = repository?.cwd ?? null;
  const refreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const gitStatus = useGitStatus({ environmentId, cwd });
  // Every git status push is a new object; keep the provider's identity while
  // what it says is unchanged, so the page context does not churn with it.
  const rawProvider = gitStatus.data?.sourceControlProvider ?? null;
  const providerKind = rawProvider?.kind ?? null;
  const providerName = rawProvider?.name ?? null;
  const providerBaseUrl = rawProvider?.baseUrl ?? null;
  const provider = useMemo(
    () =>
      providerKind !== null && providerName !== null && providerBaseUrl !== null
        ? { kind: providerKind, name: providerName, baseUrl: providerBaseUrl }
        : null,
    [providerBaseUrl, providerKind, providerName],
  );
  const capabilities = useMemo(() => derivePullRequestsCapabilities(provider), [provider]);
  const state = resolvePullRequestsStateFilter(search);
  const pollInterval = useMemo(() => listPollInterval(refreshMode), [refreshMode]);
  const listInput = { environmentId, cwd, state, limit: PULL_REQUESTS_LIST_LIMIT } as const;
  const involvementEnabled = listEnabled && capabilities.involvementFilters;
  const foldedGroups = usePullRequestsLayoutStore((state) => state.foldedGroups);

  const stateList = useSourceControlChangeRequestList(
    { ...listInput, enabled: listEnabled },
    pollInterval,
  );
  const authoredList = useSourceControlChangeRequestList(
    { ...listInput, involvement: "authored", enabled: involvementEnabled },
    pollInterval,
  );
  const reviewRequestedList = useSourceControlChangeRequestList(
    { ...listInput, involvement: "review-requested", enabled: involvementEnabled },
    pollInterval,
  );

  // The ranking re-runs only when a read returns new rows or a list-shaping
  // param changes — not on every fetch start/finish or unrelated URL change —
  // so groups, `ordered` and `byNumber` keep their identity (memoized rows
  // stay put).
  const involvementSupported =
    capabilities.involvementFilters &&
    authoredList.error === null &&
    reviewRequestedList.error === null;
  const labelKey = (search.label ?? []).join("\u0000");
  const listSearch = useMemo<PullRequestsSearch>(
    () => ({
      ...(search.q !== undefined ? { q: search.q } : {}),
      ...(search.only !== undefined ? { only: search.only } : {}),
      ...(labelKey.length > 0 ? { label: labelKey.split("\u0000") } : {}),
      ...(search.sort !== undefined ? { sort: search.sort } : {}),
    }),
    [labelKey, search.only, search.q, search.sort],
  );
  const derived = useMemo(
    () =>
      derivePullRequestsList({
        stateList: stateList.data,
        authoredList: authoredList.data,
        reviewRequestedList: reviewRequestedList.data,
        involvementSupported,
        search: listSearch,
        foldedGroups,
      }),
    [
      authoredList.data,
      foldedGroups,
      involvementSupported,
      listSearch,
      reviewRequestedList.data,
      stateList.data,
    ],
  );
  const isLoading = stateList.isLoading && stateList.data === null;
  const isFetching =
    stateList.isFetching || authoredList.isFetching || reviewRequestedList.isFetching;
  const listError = errorMessage(stateList.error);
  const list = useMemo<PullRequestsListModel>(
    () => ({ ...derived, isLoading, isFetching, error: listError }),
    [derived, isFetching, isLoading, listError],
  );

  // A selection only exists inside a resolved repository: an unresolved one
  // (waiting / unavailable) must never read `#N` through some other checkout.
  const selectedNumber = repository === null ? null : (search.pr ?? null);
  const reference = selectedNumber === null ? null : String(selectedNumber);
  const summary = selectedNumber === null ? null : (list.byNumber.get(selectedNumber) ?? null);
  const detail = useSourceControlChangeRequestDetail(
    {
      environmentId,
      cwd,
      reference,
      fullContent: true,
      enabled: repository !== null && reference !== null,
    },
    (data) =>
      resolveSourceControlRefreshDelay({
        mode: refreshMode,
        phase: pullRequestSelectionRefreshPhase({
          detail: data,
          summary,
          idleRefresh: capabilities.idleRefresh,
        }),
      }),
  );
  const activity = useSourceControlChangeRequestActivity({
    environmentId,
    cwd,
    reference,
    enabled: repository !== null && reference !== null && capabilities.activity,
    phase: pullRequestSelectionRefreshPhase({
      detail: detail.data,
      summary,
      idleRefresh: capabilities.idleRefresh,
    }),
  });

  // Each piece memoizes on data, not on the query wrappers (which change on
  // every fetch start and end), so threads and the next action keep identity.
  const checks = useMemo(
    () => derivePullRequestSelectionChecks(detail.data, summary),
    [detail.data, summary],
  );
  const threads = useMemo(() => derivePullRequestSelectionThreads(activity.data), [activity.data]);
  const nextAction = useMemo(
    () => derivePullRequestSelectionNextAction(detail.data, activity.data, checks),
    [activity.data, checks, detail.data],
  );
  const selection = useMemo<PullRequestSelectionModel | null>(
    () =>
      selectedNumber === null
        ? null
        : assemblePullRequestSelection({
            number: selectedNumber,
            summary,
            detail,
            activity,
            environmentId,
            cwd,
            checks,
            nextAction,
            threads,
          }),
    [activity, checks, cwd, detail, environmentId, nextAction, selectedNumber, summary, threads],
  );

  return useMemo(
    () => ({ environmentId, cwd, provider, capabilities, list, selection }),
    [capabilities, cwd, environmentId, list, provider, selection],
  );
}
