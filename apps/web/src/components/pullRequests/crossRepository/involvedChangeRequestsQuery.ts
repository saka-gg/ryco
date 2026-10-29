/**
 * The reads behind All repositories: one `sourceControl.listInvolvedChangeRequests` per
 * planned target, in the shared source-control registry, so each node is read through its
 * own session (admission per environment, fenced by its generation) and paused in the
 * background like every other source-control read. Imported only by the pull requests
 * page; `sourceControlAtoms.ts` keeps just the family and its invalidations.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SourceControlInvolvedChangeRequestsResult } from "@ryco/contracts";
import { KEY_SEP } from "@ryco/client-runtime/rpc";
import {
  CROSS_REPOSITORY_INVOLVEMENTS,
  CROSS_REPOSITORY_ROW_LIMIT,
  keepCrossRepositoryRowsWhileLoading,
  type CrossRepositoryReadTarget,
} from "@ryco/client-runtime/state/pull-request-review";
import type { SourceControlRefreshMode } from "@ryco/contracts/settings";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { requireEnvironmentConnection } from "../../../environments/runtime";
import { useSettings } from "../../../hooks/useSettings";
import {
  CHANGE_REQUEST_INVOLVED_FAMILY,
  defineQuery,
  type QueryBinding,
  type SourceControlQueryState,
} from "../../../rpc/sourceControlAtoms";
import {
  resolveSourceControlRefreshDelay,
  shouldRefreshSourceControlOnLifecycle,
} from "../../../rpc/sourceControlRefreshPolicy";

/** A focus refresh rereads after this (Synara's list `staleTime`, Ryco's list stale time). */
export const CROSS_REPOSITORY_STALE_TIME_MS = 60_000;
/**
 * A source still `loading` (its read outlived the answer's deadline): ask again this soon.
 * The node's read keeps running and fills its cache, so the next answer has it.
 */
export const CROSS_REPOSITORY_LOADING_RETRY_MS = 5_000;

export interface InvolvedChangeRequestsInput {
  readonly environmentId: EnvironmentId;
  readonly sources: CrossRepositoryReadTarget["sources"];
  /** Sorted. */
  readonly cwds: ReadonlyArray<string>;
  readonly state: "open" | "closed" | "merged" | "all";
}

function inputKey(input: InvolvedChangeRequestsInput): string {
  return `${input.environmentId}${KEY_SEP}${input.state}${KEY_SEP}${input.sources}${KEY_SEP}${input.cwds.join("\u0001")}`;
}

/** Reads whose next run passes `refresh: true` (someone pressed Refresh). */
const refreshRequested = new Set<string>();

export const involvedChangeRequestsBinding: QueryBinding<
  InvolvedChangeRequestsInput,
  SourceControlInvolvedChangeRequestsResult
> = defineQuery<InvolvedChangeRequestsInput, SourceControlInvolvedChangeRequestsResult>({
  label: CHANGE_REQUEST_INVOLVED_FAMILY,
  staleTime: CROSS_REPOSITORY_STALE_TIME_MS,
  isEnabled: (input) => input.cwds.length > 0,
  buildKey: inputKey,
  resolveEnvironmentId: (input) => input.environmentId,
  // Spans checkouts: checkout-scoped invalidations name the family by environment.
  resolveCwd: () => "",
  run: async (input) => {
    const previous: SourceControlInvolvedChangeRequestsResult | null =
      involvedChangeRequestsBinding.snapshotFor(input).data;
    const refresh = refreshRequested.delete(inputKey(input));
    const result = await requireEnvironmentConnection(
      input.environmentId,
    ).client.sourceControl.listInvolvedChangeRequests({
      cwds: input.cwds,
      state: input.state,
      involvements: CROSS_REPOSITORY_INVOLVEMENTS,
      limit: CROSS_REPOSITORY_ROW_LIMIT,
      ...(input.sources === "hosts" ? { sources: "hosts" as const } : {}),
      // Nothing on screen yet: someone is waiting, so the node reads ahead of its background work.
      ...(refresh ? { refresh: true } : previous === null ? { interactive: true } : {}),
    });
    return keepCrossRepositoryRowsWhileLoading(previous, result);
  },
});

/** `CrossRepositoryReadTarget`s as the binding's inputs, for one state filter. */
export function involvedChangeRequestsInputs(
  targets: ReadonlyArray<CrossRepositoryReadTarget>,
  state: InvolvedChangeRequestsInput["state"],
): ReadonlyArray<InvolvedChangeRequestsInput> {
  return targets.map((target) => ({
    environmentId: target.environmentId,
    sources: target.sources,
    cwds: target.cwds,
    state,
  }));
}

function encodeInputs(inputs: ReadonlyArray<InvolvedChangeRequestsInput>): string {
  return JSON.stringify(
    inputs.map((input) => [input.environmentId, input.sources, input.state, input.cwds]),
  );
}

function decodeInputs(key: string): ReadonlyArray<InvolvedChangeRequestsInput> {
  return (
    JSON.parse(key) as ReadonlyArray<
      [
        EnvironmentId,
        InvolvedChangeRequestsInput["sources"],
        InvolvedChangeRequestsInput["state"],
        string[],
      ]
    >
  ).map(([environmentId, sources, state, cwds]) => ({ environmentId, sources, state, cwds }));
}

/** Every target's state in one derived atom (t3's merged environment query). */
const involvedChangeRequestsStatesAtom = Atom.family((inputsKey: string) => {
  const inputs = decodeInputs(inputsKey);
  return Atom.make((get) =>
    inputs.map((input) => get(involvedChangeRequestsBinding.atomFor(input))),
  );
});

/**
 * How soon a read polls again: soon while a source is still `loading` (finishing the first
 * answer, so even with manual refresh), else every 5 min (10 min reduced, never manual),
 * Synara's inbox poll. Running checks do not speed it up; the selected pull request's
 * reader keeps its own cadence.
 */
export function crossRepositoryPollDelay(
  mode: SourceControlRefreshMode,
  data: SourceControlInvolvedChangeRequestsResult | null,
): number | false {
  if (data?.sources.some((source) => source.status === "loading")) {
    return CROSS_REPOSITORY_LOADING_RETRY_MS;
  }
  return resolveSourceControlRefreshDelay({ mode, phase: "watching-slow" });
}

/** Watches every target and returns their states in target order. */
export function useInvolvedChangeRequests(
  inputs: ReadonlyArray<InvolvedChangeRequestsInput>,
): ReadonlyArray<SourceControlQueryState<SourceControlInvolvedChangeRequestsResult>> {
  const refreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const inputsKey = encodeInputs(inputs);
  useEffect(() => {
    const releases = decodeInputs(inputsKey).map((input) =>
      involvedChangeRequestsBinding.watch(input, {
        resolveIntervalMs: (data) => crossRepositoryPollDelay(refreshMode, data),
        shouldRefreshOnLifecycle: ({ hasData, lastFetchedAt, staleTime }) =>
          shouldRefreshSourceControlOnLifecycle({
            mode: refreshMode,
            hasData,
            invalidated: false,
            lastFetchedAtMs: lastFetchedAt,
            staleTimeMs: staleTime,
          }),
      }),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [inputsKey, refreshMode]);
  return useAtomValue(involvedChangeRequestsStatesAtom(inputsKey));
}

/** "Refresh": each read's next run passes `refresh: true`, and every one runs now. */
export function requestInvolvedChangeRequestsRefresh(
  inputs: ReadonlyArray<InvolvedChangeRequestsInput>,
): void {
  for (const input of inputs) {
    if (input.cwds.length === 0) continue;
    refreshRequested.add(inputKey(input));
    involvedChangeRequestsBinding.refresh(input);
  }
}

export function resetInvolvedChangeRequestsForTests(): void {
  refreshRequested.clear();
}
