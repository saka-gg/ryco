import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import {
  derivePullRequestsCapabilities,
  derivePullRequestSelectionChecks,
  derivePullRequestSelectionNextAction,
  isOversizedDiffError,
  type ChangeRequestChecksSummary,
  type ChangeRequestNextAction,
  type PullRequestListFilters,
} from "@ryco/client-runtime/state/pull-request-review";
import type { ChangeRequestHostCapabilities } from "@ryco/shared/changeRequestHostCapabilities";
import type {
  ChangeRequestActivity,
  EnvironmentId,
  ProjectId,
  SourceControlChangeRequestDetail,
  SourceControlProviderInfo,
} from "@ryco/contracts";
import { useEffect, useMemo, useState } from "react";

import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import {
  loadSavedPullRequestRead,
  pullRequestActivityQuery,
  pullRequestDetailQuery,
  pullRequestDiffQuery,
  pullRequestListQuery,
  type PullRequestInput,
  type PullRequestListInput,
  type PullRequestReadKind,
} from "../../rpc/pullRequestAtoms";
import { useMobileQuery, type MobileQueryResult } from "../../rpc/useMobileQuery";
import { selectProjectByRef, useStore } from "../../state/threadsRuntime";
import {
  derivePullRequestDetailItems,
  derivePullRequestHeader,
  type PullRequestDetailItem,
  type PullRequestDetailTab,
  type PullRequestDiffReadStatus,
} from "./pullRequestDetailModel";
import { splitPullRequestPatch, type PullRequestPatchFile } from "./pullRequestDiffModel";
import {
  derivePullRequestListScreen,
  pullRequestListReadInputs,
  type PullRequestListScreen,
} from "./pullRequestListModel";

/**
 * The phone's pull request reads, as hooks over the bounded pull request cache
 * (`rpc/pullRequestAtoms`). The rules live in the React-free models beside
 * this file; these only wire reads to them.
 */

export interface PullRequestCheckout {
  /** The project's checkout on the node; null until the node has published it. */
  readonly cwd: string | null;
}

export function usePullRequestCheckout(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): PullRequestCheckout {
  const project = useStore((state) =>
    environmentId !== null && projectId !== null
      ? selectProjectByRef(state, scopeProjectRef(environmentId, projectId))
      : undefined,
  );
  return { cwd: project?.cwd ?? null };
}

/** Every git status push is a new object; keep the provider's identity while it says the same. */
function sameProvider(
  left: SourceControlProviderInfo | null,
  right: SourceControlProviderInfo | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind && left.name === right.name && left.baseUrl === right.baseUrl;
}

/**
 * The checkout's hosting provider, from the node's git status summary (no
 * fetch): it decides which reads the host can serve. Held while mounted, like
 * every other mounted source-control surface (`vcs-status` scope).
 */
export function useSourceControlProvider(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): SourceControlProviderInfo | null {
  const api = useEnvironmentApi(environmentId);
  const [provider, setProvider] = useState<SourceControlProviderInfo | null>(null);
  useEffect(() => {
    if (environmentId === null || cwd === null) return;
    const release = mobileHostedConnectionScopes.retain(environmentId, { type: "vcs-status", cwd });
    if (api === undefined) return release;
    const unsubscribe = api.vcs.onStatus({ cwd, view: "summary" }, (status) => {
      const next = status.sourceControlProvider ?? null;
      setProvider((current) => (sameProvider(current, next) ? current : next));
    });
    return () => {
      unsubscribe();
      release();
    };
  }, [api, cwd, environmentId]);
  return provider;
}

/**
 * A read as the screen shows it: the live answer, or, while the screen's node
 * is offline and nothing live has come back, the copy kept on this device
 * (`persistence/pullRequestPersistence.ts`).
 */
function useWithSavedCopy<T>(
  kind: PullRequestReadKind,
  input: PullRequestListInput | PullRequestInput,
  offline: boolean,
  live: MobileQueryResult<T>,
): MobileQueryResult<T> {
  const enabled = offline && live.data === null && (input.enabled ?? true);
  // The effect reads the input back from its key, so it depends on nothing else.
  const key = JSON.stringify(input);
  const [saved, setSaved] = useState<{ readonly key: string; readonly data: T | null } | null>(
    null,
  );
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const keyed = JSON.parse(key) as PullRequestListInput | PullRequestInput;
    void loadSavedPullRequestRead(kind, keyed).then((data) => {
      if (!cancelled) setSaved({ key, data: (data ?? null) as T | null });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, kind]);
  const copy = enabled && saved !== null && saved.key === key ? saved.data : null;
  return copy === null ? live : { ...live, data: copy, error: null, isLoading: false };
}

export interface PullRequestListData {
  readonly screen: PullRequestListScreen;
  readonly refreshing: boolean;
  readonly refresh: () => void;
}

export function usePullRequestList(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly provider: SourceControlProviderInfo | null;
  readonly filters: PullRequestListFilters;
  readonly failingOnly?: boolean | undefined;
  readonly hideDrafts?: boolean | undefined;
  /** The node is not connected: show the copy kept on this device while nothing live answers. */
  readonly offline?: boolean | undefined;
}): PullRequestListData {
  const offline = input.offline === true;
  const { environmentId, cwd, provider, filters } = input;
  const failingOnly = input.failingOnly === true;
  const hideDrafts = input.hideDrafts === true;
  const reads = pullRequestListReadInputs({
    checkoutKnown: environmentId !== null && cwd !== null,
    provider,
    filters,
  });
  const stateInput = { environmentId, cwd, ...reads.state };
  const authoredInput = { environmentId, cwd, ...reads.authored };
  const reviewRequestedInput = { environmentId, cwd, ...reads.reviewRequested };
  const state = useWithSavedCopy(
    "list",
    stateInput,
    offline,
    useMobileQuery(pullRequestListQuery, stateInput, environmentId),
  );
  const authored = useWithSavedCopy(
    "list",
    authoredInput,
    offline,
    useMobileQuery(pullRequestListQuery, authoredInput, environmentId),
  );
  const reviewRequested = useWithSavedCopy(
    "list",
    reviewRequestedInput,
    offline,
    useMobileQuery(pullRequestListQuery, reviewRequestedInput, environmentId),
  );
  const screen = useMemo(
    () =>
      derivePullRequestListScreen({
        reads: { state, authored, reviewRequested },
        provider,
        filters,
        narrow: { failingOnly, hideDrafts },
      }),
    [authored, failingOnly, filters, hideDrafts, provider, reviewRequested, state],
  );
  return {
    screen,
    refreshing: state.isFetching && state.data !== null,
    refresh: () => {
      void state.refetch();
      if (reads.authored.enabled) void authored.refetch();
      if (reads.reviewRequested.enabled) void reviewRequested.refetch();
    },
  };
}

export interface PullRequestReadInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly number: number | null;
  readonly provider: SourceControlProviderInfo | null;
  /** The node is not connected: show the copy kept on this device while nothing live answers. */
  readonly offline?: boolean | undefined;
}

export interface PullRequestDetailData {
  readonly capabilities: ChangeRequestHostCapabilities;
  readonly detail: MobileQueryResult<SourceControlChangeRequestDetail>;
}

/** The pull request's detail alone, for a screen that shows none of its activity. */
export function usePullRequestDetail(input: PullRequestReadInput): PullRequestDetailData {
  const { environmentId, cwd, number, provider } = input;
  const capabilities = derivePullRequestsCapabilities(provider);
  const detailInput = { environmentId, cwd, number };
  const detail = useWithSavedCopy(
    "detail",
    detailInput,
    input.offline === true,
    useMobileQuery(pullRequestDetailQuery, detailInput, environmentId),
  );
  return { capabilities, detail };
}

export interface PullRequestData extends PullRequestDetailData {
  readonly activity: MobileQueryResult<ChangeRequestActivity>;
  readonly checks: ChangeRequestChecksSummary;
  /** Null until the detail loads. */
  readonly nextAction: ChangeRequestNextAction | null;
  readonly refresh: () => void;
  /** Reads the detail (head, checks, readiness) again, without the activity. Stable. */
  readonly refreshDetail: () => Promise<unknown>;
}

export function usePullRequest(input: PullRequestReadInput): PullRequestData {
  const { environmentId, cwd, number } = input;
  const { capabilities, detail } = usePullRequestDetail(input);
  // A host without activity reads (or one not known yet) is not asked.
  const activityInput = { environmentId, cwd, number, enabled: capabilities.activity };
  const activity = useWithSavedCopy(
    "activity",
    // Offline the host is unknown; a kept activity is shown whatever it says.
    input.offline === true ? { environmentId, cwd, number } : activityInput,
    input.offline === true,
    useMobileQuery(pullRequestActivityQuery, activityInput, environmentId),
  );
  const checks = useMemo(() => derivePullRequestSelectionChecks(detail.data, null), [detail.data]);
  const nextAction = useMemo(
    () => derivePullRequestSelectionNextAction(detail.data, activity.data, checks),
    [activity.data, checks, detail.data],
  );
  return {
    capabilities,
    detail,
    activity,
    checks,
    nextAction,
    refresh: () => {
      void detail.refetch();
      if (capabilities.activity) void activity.refetch();
    },
    refreshDetail: detail.refetch,
  };
}

export interface PullRequestDiffData {
  readonly status: PullRequestDiffReadStatus;
  /** Reading order; null until the diff is read. */
  readonly files: ReadonlyArray<PullRequestPatchFile> | null;
  readonly error: string | null;
  readonly refresh: () => void;
}

/** The diff at the detail's head; read once the detail says which head that is. */
export function usePullRequestDiff(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly number: number | null;
  readonly detail: SourceControlChangeRequestDetail | null;
  readonly enabled: boolean;
}): PullRequestDiffData {
  const { environmentId, cwd, number, detail } = input;
  const enabled = input.enabled && detail !== null;
  const query = useMobileQuery(
    pullRequestDiffQuery,
    { environmentId, cwd, number, headSha: detail?.headSha ?? null, enabled },
    environmentId,
  );
  // Split once per screen and patch. Nothing outside the bounded cache keeps
  // the patch: a module-level copy would outlive the node's teardown, a Storage
  // clear and the cache's own eviction, and Storage would not count it.
  const files = useMemo(
    () => (query.data === null ? null : splitPullRequestPatch(query.data)),
    [query.data],
  );
  const error = query.error?.message ?? null;
  const status: PullRequestDiffReadStatus = !enabled
    ? "waiting"
    : files !== null
      ? "ready"
      : error !== null
        ? isOversizedDiffError(error)
          ? "oversized"
          : "error"
        : "loading";
  return {
    status,
    files,
    error,
    refresh: () => {
      void query.refetch();
    },
  };
}

/**
 * The pull request screen's rows, derived again only when the data under them
 * changes. The reads around that data (`usePullRequest`, `usePullRequestDiff`)
 * are new objects on every render; keyed on those, any re-render of the screen
 * would rebuild every row and re-render each visible one, Markdown included.
 */
export function usePullRequestDetailItems(input: {
  readonly tab: PullRequestDetailTab;
  readonly hostName: string;
  readonly hostKnown: boolean;
  readonly pullRequest: Pick<PullRequestData, "detail" | "activity" | "capabilities" | "checks">;
  readonly diff: Pick<PullRequestDiffData, "status" | "files" | "error">;
}): ReadonlyArray<PullRequestDetailItem> {
  const { tab, hostName, hostKnown } = input;
  const detail = input.pullRequest.detail.data;
  const activity = input.pullRequest.activity.data;
  const activitySupported = input.pullRequest.capabilities.activity;
  const checks = input.pullRequest.checks;
  const { status, files, error } = input.diff;
  return useMemo(
    () =>
      derivePullRequestDetailItems({
        tab,
        header: derivePullRequestHeader(detail, null),
        hostName,
        detail,
        activity,
        activitySupported,
        hostKnown,
        checks,
        diff: { status, files, error },
      }),
    [tab, hostName, detail, activity, activitySupported, hostKnown, checks, status, files, error],
  );
}
