import type {
  ChangeRequest,
  EnvironmentId,
  SourceControlAssigneeCandidate,
  SourceControlIssueSummary,
  SourceControlLabel,
} from "@ryco/contracts";
import { useEffect, useState } from "react";

import { readRpcClient } from "../../connection/environmentApi";
import {
  pullRequestRepositoryLabelsQuery,
  pullRequestRepositoryPeopleQuery,
} from "../../rpc/pullRequestAtoms";
import { useMobileQuery } from "../../rpc/useMobileQuery";
import {
  rankPeople,
  rankReferences,
  type CompletionSuggestion,
  type CompletionToken,
} from "./pullRequestCompletionModel";

/**
 * The repository's people and labels for the pickers and `@` completion, read
 * through the bounded pull request cache (`pullRequestRepositoryPeopleQuery`),
 * and `#` references searched on the host.
 */

export interface LoadState<T> {
  readonly data: T | null;
  readonly error: string | null;
}

function loadState<T>(result: { readonly data: T | null; readonly error: Error | null }) {
  return { data: result.data, error: result.error?.message ?? null } satisfies LoadState<T>;
}

export function useRepositoryPeople(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  enabled: boolean,
): LoadState<ReadonlyArray<SourceControlAssigneeCandidate>> {
  return loadState(
    useMobileQuery(
      pullRequestRepositoryPeopleQuery,
      { environmentId, cwd, enabled },
      environmentId,
    ),
  );
}

export function useRepositoryLabels(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  enabled: boolean,
): LoadState<ReadonlyArray<SourceControlLabel>> {
  return loadState(
    useMobileQuery(
      pullRequestRepositoryLabelsQuery,
      { environmentId, cwd, enabled },
      environmentId,
    ),
  );
}

const REFERENCE_DELAY_MS = 250;

/** Suggestions for the token at the cursor; empty outside a token. */
export function usePullRequestCompletions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly token: CompletionToken | null;
}): ReadonlyArray<CompletionSuggestion> {
  const { environmentId, cwd, token } = input;
  const people = useRepositoryPeople(environmentId, cwd, token !== null && token.trigger === "@");
  const [references, setReferences] = useState<{
    readonly query: string;
    readonly items: ReadonlyArray<CompletionSuggestion>;
  } | null>(null);
  const referenceQuery = token !== null && token.trigger === "#" ? token.query : null;
  useEffect(() => {
    if (referenceQuery === null || environmentId === null || cwd === null) return;
    if (referenceQuery.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const client = readRpcClient(environmentId);
      if (client === null) return;
      const query = referenceQuery;
      void Promise.allSettled([
        client.sourceControl.searchChangeRequests({ cwd, query, limit: 6 }),
        client.sourceControl.searchIssues({ cwd, query, limit: 6 }),
      ]).then(([pulls, issues]) => {
        if (cancelled) return;
        const items = [
          ...(pulls.status === "fulfilled"
            ? pulls.value
            : ([] as ReadonlyArray<ChangeRequest>)
          ).map((entry) => ({
            number: entry.number,
            title: entry.title,
            kind: "pull request" as const,
          })),
          ...(issues.status === "fulfilled"
            ? issues.value
            : ([] as ReadonlyArray<SourceControlIssueSummary>)
          ).map((entry) => ({ number: entry.number, title: entry.title, kind: "issue" as const })),
        ].toSorted((left, right) => right.number - left.number);
        setReferences({ query, items: rankReferences(items, query) });
      });
    }, REFERENCE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cwd, environmentId, referenceQuery]);
  if (token === null) return [];
  if (token.trigger === "@") return people.data ? rankPeople(people.data, token.query) : [];
  return references !== null && references.query === token.query ? references.items : [];
}
