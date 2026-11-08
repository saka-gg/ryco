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
  rankPeople,
  rankReferences,
  type CompletionSuggestion,
  type CompletionToken,
} from "./pullRequestCompletionModel";

/**
 * The repository's people and labels for the pickers and `@` completion, and
 * `#` references searched on the host. Read once per checkout while the app
 * runs (memory only), through the node's own session.
 */

const peopleByCheckout = new Map<string, Promise<ReadonlyArray<SourceControlAssigneeCandidate>>>();
const labelsByCheckout = new Map<string, Promise<ReadonlyArray<SourceControlLabel>>>();

const OFFLINE = "This node is not connected.";

function sourceControl(environmentId: EnvironmentId) {
  const client = readRpcClient(environmentId);
  if (client === null) throw new Error(OFFLINE);
  return client.sourceControl;
}

function cached<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const next = read();
  cache.set(key, next);
  // A failed read is asked again next time.
  next.catch(() => cache.delete(key));
  return next;
}

export function readRepositoryPeople(
  environmentId: EnvironmentId,
  cwd: string,
): Promise<ReadonlyArray<SourceControlAssigneeCandidate>> {
  return cached(peopleByCheckout, `${environmentId}\u0000${cwd}`, async () =>
    sourceControl(environmentId).listIssueAssignees({ cwd }),
  );
}

export function readRepositoryLabels(
  environmentId: EnvironmentId,
  cwd: string,
): Promise<ReadonlyArray<SourceControlLabel>> {
  return cached(labelsByCheckout, `${environmentId}\u0000${cwd}`, async () =>
    sourceControl(environmentId).listIssueLabels({ cwd }),
  );
}

export interface LoadState<T> {
  readonly data: T | null;
  readonly error: string | null;
}

/** One of the reads above while `enabled`, as state. */
export function useRepositoryRead<T>(
  read: (environmentId: EnvironmentId, cwd: string) => Promise<T>,
  environmentId: EnvironmentId | null,
  cwd: string | null,
  enabled: boolean,
): LoadState<T> {
  const [state, setState] = useState<{ readonly key: string; readonly value: LoadState<T> } | null>(
    null,
  );
  const key = `${environmentId}\u0000${cwd}`;
  useEffect(() => {
    if (!enabled || environmentId === null || cwd === null) return;
    let cancelled = false;
    read(environmentId, cwd).then(
      (data) => {
        if (!cancelled) setState({ key, value: { data, error: null } });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            key,
            value: { data: null, error: error instanceof Error ? error.message : String(error) },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cwd, enabled, environmentId, key, read]);
  return state?.key === key ? state.value : { data: null, error: null };
}

const REFERENCE_DELAY_MS = 250;

/** Suggestions for the token at the cursor; empty outside a token. */
export function usePullRequestCompletions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly token: CompletionToken | null;
}): ReadonlyArray<CompletionSuggestion> {
  const { environmentId, cwd, token } = input;
  const people = useRepositoryRead(
    readRepositoryPeople,
    environmentId,
    cwd,
    token !== null && token.trigger === "@",
  );
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
