import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { PULL_REQUESTS_LIST_LIMIT } from "@ryco/client-runtime/state/pull-request-review";
import { useEffect, useMemo, useState } from "react";

import { readEnvironmentApi, readRpcClient } from "../../connection/environmentApi";
import { issueListQuery, workItemListQuery } from "../../rpc/projectExplorerAtoms";
import { pullRequestListQuery } from "../../rpc/pullRequestAtoms";
import { vcsRefsQuery } from "../../rpc/sourceControlAtoms";
import { useMobileQuery } from "../../rpc/useMobileQuery";
import { ISSUE_LIST_LIMIT } from "../projectExplorer/issuesModel";
import { WORK_ITEM_LIST_LIMIT } from "../projectExplorer/workItemsModel";
import {
  branchSourceRows,
  filterSourceRows,
  issueSourceRows,
  pullRequestSourceRows,
  workItemSourceRows,
  type NewTaskSourceKind,
  type NewTaskSourceRow,
} from "./newTaskSourceModel";

const LIST_LIMIT = 50;
const SEARCH_DELAY_MS = 250;
/** A search the list did not answer asks the node (pull requests, issues, Jira) from here on. */
const REMOTE_SEARCH_MIN_CHARS = 2;

export interface NewTaskSourceRowsState {
  readonly rows: ReadonlyArray<NewTaskSourceRow>;
  readonly loading: boolean;
  readonly error: string | null;
}

/** What the node finds for `query` beyond the first page. */
async function searchSourceRows(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly kind: NewTaskSourceKind;
  readonly query: string;
}): Promise<NewTaskSourceRow[]> {
  const { environmentId, cwd, query } = input;
  if (input.kind === "branch") {
    const api = readEnvironmentApi(environmentId);
    if (!api) return [];
    return branchSourceRows((await api.vcs.listRefs({ cwd, query, limit: LIST_LIMIT })).refs);
  }
  const client = readRpcClient(environmentId);
  if (client === null) return [];
  switch (input.kind) {
    case "pr":
      return pullRequestSourceRows(
        await client.sourceControl.searchChangeRequests({ cwd, query, limit: LIST_LIMIT }),
      );
    case "issue":
      return issueSourceRows(
        await client.sourceControl.searchIssues({ cwd, query, limit: LIST_LIMIT }),
      );
    case "workItem":
      return workItemSourceRows(
        await client.workItems.search({
          projectId: input.projectId,
          cwd,
          query,
          limit: LIST_LIMIT,
        }),
      );
  }
}

function failureText(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "The list could not be loaded.";
}

/**
 * The rows a source list shows: the first page, filtered as the user types, and the node's own
 * search once the page has nothing for a query of two characters or more.
 */
export function useNewTaskSourceRows(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
  readonly kind: NewTaskSourceKind | null;
  readonly query: string;
}): NewTaskSourceRowsState {
  const { environmentId, projectId, cwd, kind, query } = input;
  const [search, setSearch] = useState<{
    readonly key: string;
    readonly rows: ReadonlyArray<NewTaskSourceRow>;
  } | null>(null);
  const pageKey =
    environmentId && projectId && cwd && kind ? `${environmentId}|${cwd}|${kind}` : null;

  // Each kind's first page is the same saved read its own screen shows (branch
  // picker, pull requests, issues, Jira): the last one shows at once, and is
  // read again behind it.
  const branchPage = useMobileQuery(
    vcsRefsQuery,
    { environmentId, cwd, enabled: kind === "branch" },
    environmentId,
  );
  const pullRequestPage = useMobileQuery(
    pullRequestListQuery,
    {
      environmentId,
      cwd,
      state: "open",
      limit: PULL_REQUESTS_LIST_LIMIT,
      enabled: kind === "pr",
    },
    environmentId,
  );
  const issuePage = useMobileQuery(
    issueListQuery,
    { environmentId, cwd, state: "open", limit: ISSUE_LIST_LIMIT, enabled: kind === "issue" },
    environmentId,
  );
  const workItemPage = useMobileQuery(
    workItemListQuery,
    {
      environmentId,
      projectId,
      state: "open",
      limit: WORK_ITEM_LIST_LIMIT,
      enabled: kind === "workItem",
    },
    environmentId,
  );
  const branchRefs = branchPage.data?.refs;
  const pullRequests = pullRequestPage.data;
  const issues = issuePage.data;
  const workItems = workItemPage.data;
  const pageRows = useMemo(() => {
    switch (kind) {
      case "branch":
        return branchRefs ? branchSourceRows(branchRefs) : null;
      case "pr":
        return pullRequests ? pullRequestSourceRows(pullRequests) : null;
      case "issue":
        return issues ? issueSourceRows(issues) : null;
      case "workItem":
        return workItems ? workItemSourceRows(workItems) : null;
      default:
        return null;
    }
  }, [branchRefs, issues, kind, pullRequests, workItems]);
  const pageRead =
    kind === "branch"
      ? branchPage
      : kind === "pr"
        ? pullRequestPage
        : kind === "issue"
          ? issuePage
          : workItemPage;
  const pageError = pageRead.error ? failureText(pageRead.error) : null;
  const page =
    pageKey === null
      ? null
      : pageRows !== null
        ? { rows: pageRows, error: pageError }
        : pageError !== null
          ? { rows: [] as ReadonlyArray<NewTaskSourceRow>, error: pageError }
          : null;

  const loadedPage = page;
  const filtered = loadedPage ? filterSourceRows(loadedPage.rows, query) : [];
  const trimmed = query.trim();
  const searchKey =
    pageKey !== null &&
    loadedPage !== null &&
    filtered.length === 0 &&
    trimmed.length >= REMOTE_SEARCH_MIN_CHARS
      ? `${pageKey}|${trimmed}`
      : null;

  useEffect(() => {
    if (searchKey === null || !environmentId || !projectId || !cwd || !kind) return;
    let current = true;
    const timer = setTimeout(() => {
      void searchSourceRows({ environmentId, projectId, cwd, kind, query: trimmed })
        .catch(() => [] as NewTaskSourceRow[])
        .then((rows) => {
          if (current) setSearch({ key: searchKey, rows });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [cwd, environmentId, kind, projectId, searchKey, trimmed]);

  if (pageKey === null) return { rows: [], loading: false, error: null };
  if (loadedPage === null) return { rows: [], loading: true, error: null };
  if (searchKey !== null) {
    const searched = search !== null && search.key === searchKey ? search.rows : null;
    return { rows: searched ?? [], loading: searched === null, error: null };
  }
  return { rows: filtered, loading: false, error: loadedPage.error };
}
