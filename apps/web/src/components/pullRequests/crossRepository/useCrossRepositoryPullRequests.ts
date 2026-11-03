import type { SavedEnvironmentConnectionState } from "@ryco/client-runtime/connection";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import {
  crossRepositoryHostAliases,
  mergeCrossRepositoryChangeRequests,
  planCrossRepositoryReads,
  resolvePullRequestsStateFilter,
  type CrossRepositoryAnswer,
  type CrossRepositoryCheckout,
  type CrossRepositoryRowBase,
} from "@ryco/client-runtime/state/pull-request-review";
import { checkoutRepositoryKey } from "@ryco/shared/git";
import { useMemo, useState, useSyncExternalStore } from "react";

import {
  usePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../../../environments/primary";
import {
  hasSavedEnvironmentRegistryHydrated,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../../environments/runtime";
import { useEnvironmentServerConfigSelector } from "../../../hooks/useChatsAvailability";
import {
  classifyCheckoutEnvironmentSync,
  type ProjectCheckoutOption,
} from "../../../projectCheckouts.logic";
import { isSourceControlReadAdmitted } from "../../../rpc/sourceControlAtoms";
import { subscribeSourceControlReadAdmission } from "../../../rpc/sourceControlReadAdmission";
import { selectBootstrapCompleteForEnvironment, useStore } from "../../../store";
import { usePullRequestsLayoutStore } from "../pullRequestsLayoutStore";
import type { PullRequestsSearch } from "../pullRequestsSearch";
import {
  applyCrossRepositoryOverlays,
  attachCrossRepositoryCheckouts,
  crossRepositoryEnvironmentReadiness,
  deriveCrossRepositoryList,
  deriveCrossRepositoryNotes,
  resolveCrossRepositorySelectedKey,
  type CrossRepositoryEnvironment,
  type CrossRepositoryListModel,
  type CrossRepositoryRow,
} from "./crossRepositoryList.logic";
import {
  getCrossRepositoryOverlays,
  subscribeCrossRepositoryOverlays,
  type CrossRepositoryOverlaySnapshot,
} from "./crossRepositoryOverlays";
import {
  involvedChangeRequestsInputs,
  requestInvolvedChangeRequestsRefresh,
  useInvolvedChangeRequests,
} from "./involvedChangeRequestsQuery";

const EMPTY_ENVIRONMENT_IDS: ReadonlyArray<EnvironmentId> = [];
const EMPTY_BASE_ROWS: ReadonlyMap<string, CrossRepositoryRowBase> = new Map();
const EMPTY_ROWS: ReadonlyMap<string, CrossRepositoryRow> = new Map();

const selectCrossRepositoryCapability = (config: ServerConfig | null): boolean | null =>
  config === null ? null : config.environment.capabilities.crossRepositoryChangeRequests === true;

/**
 * Each node's sync state, label, hosted admission and capability, for the nodes with a
 * checkout on the page. Narrow subscriptions (one signature string per store), so pushes
 * about other nodes or unrelated config do not re-render the page.
 */
function useCrossRepositoryEnvironments(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<CrossRepositoryEnvironment> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryLabel = usePrimaryEnvironmentDescriptor()?.label ?? null;
  const primaryCapable = useEnvironmentServerConfigSelector(
    primaryEnvironmentId,
    selectCrossRepositoryCapability,
  );
  const runtimeSignature = useSavedEnvironmentRuntimeStore((state) =>
    environmentIds
      .map((environmentId) => {
        const runtime = state.byId[environmentId];
        return runtime
          ? [
              runtime.connectionState,
              runtime.disconnectedAt ?? "",
              String(selectCrossRepositoryCapability(runtime.serverConfig)),
              runtime.descriptor?.label ?? "",
            ].join("\u0002")
          : "";
      })
      .join("\u0001"),
  );
  const registrySignature = useSavedEnvironmentRegistryStore((state) =>
    environmentIds
      .map((environmentId) => {
        const record = state.byId?.[environmentId];
        return record ? `1\u0002${record.label ?? ""}` : "0";
      })
      .join("\u0001"),
  );
  const bootstrapSignature = useStore((state) =>
    environmentIds
      .map((environmentId) =>
        selectBootstrapCompleteForEnvironment(state, environmentId) ? "1" : "0",
      )
      .join(""),
  );
  const admissionSignature = useSyncExternalStore(subscribeSourceControlReadAdmission, () =>
    environmentIds
      .map((environmentId) => (isSourceControlReadAdmitted(environmentId) ? "1" : "0"))
      .join(""),
  );
  return useMemo(() => {
    const runtimes = runtimeSignature.split("\u0001");
    const records = registrySignature.split("\u0001");
    const registryHydrated = hasSavedEnvironmentRegistryHydrated();
    return environmentIds.map((environmentId, index): CrossRepositoryEnvironment => {
      const isPrimary = environmentId === primaryEnvironmentId;
      const [connectionState, disconnected, capability, runtimeLabel] = (
        runtimes[index] ?? ""
      ).split("\u0002");
      const [known, recordLabel] = (records[index] ?? "0").split("\u0002");
      const saved =
        !isPrimary && connectionState
          ? {
              connectionState: connectionState as SavedEnvironmentConnectionState,
              disconnectedAt: disconnected || null,
            }
          : null;
      return {
        environmentId,
        label: isPrimary ? primaryLabel : runtimeLabel || recordLabel || null,
        sync: classifyCheckoutEnvironmentSync({
          bootstrapComplete: bootstrapSignature[index] === "1",
          isPrimary,
          saved,
          savedKnown: known === "1",
          registryHydrated,
        }),
        admitted: admissionSignature[index] === "1",
        capable: isPrimary
          ? primaryCapable
          : capability === "true"
            ? true
            : capability === "false"
              ? false
              : null,
      };
    });
  }, [
    admissionSignature,
    bootstrapSignature,
    environmentIds,
    primaryCapable,
    primaryEnvironmentId,
    primaryLabel,
    registrySignature,
    runtimeSignature,
  ]);
}

function toCrossRepositoryCheckout(option: ProjectCheckoutOption): CrossRepositoryCheckout {
  return {
    environmentId: option.environmentId,
    cwd: option.cwd,
    repositoryKey: checkoutRepositoryKey(option.repositoryRemoteUrl),
    provider: option.repositoryProvider ?? null,
    representative: option.isRepresentative,
  };
}

interface RowsMemo {
  readonly answers: ReadonlyArray<CrossRepositoryAnswer>;
  readonly overlays: CrossRepositoryOverlaySnapshot;
  readonly repositories: ReadonlyArray<ProjectCheckoutOption>;
  readonly readable: ReadonlySet<EnvironmentId>;
  readonly base: ReadonlyMap<string, CrossRepositoryRowBase>;
  readonly rows: ReadonlyMap<string, CrossRepositoryRow>;
}

/**
 * All repositories on the pull requests page: plans one read per node that can answer
 * (through that node's own session; nothing here connects a node or opens a session),
 * merges the answers into one list of rows tied to checkouts, and says what it could not
 * read. Null when `enabled` is false (one repository's list).
 */
export function useCrossRepositoryPullRequests(input: {
  readonly enabled: boolean;
  readonly repositories: ReadonlyArray<ProjectCheckoutOption>;
  readonly search: PullRequestsSearch;
}): CrossRepositoryListModel | null {
  const { enabled, repositories, search } = input;
  const environmentIds = useMemo(
    () =>
      enabled
        ? [...new Set(repositories.map((option) => option.environmentId))].toSorted()
        : EMPTY_ENVIRONMENT_IDS,
    [enabled, repositories],
  );
  const environments = useCrossRepositoryEnvironments(environmentIds);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const state = resolvePullRequestsStateFilter(search);
  // Keyed by the ready nodes, so the plan holds while unrelated node state changes.
  const readableKey = environments
    .filter((environment) => crossRepositoryEnvironmentReadiness(environment) === "ready")
    .map((environment) => environment.environmentId)
    .join("\u0000");
  const readable = useMemo(
    () =>
      new Set(
        readableKey.length > 0 ? (readableKey.split("\u0000") as EnvironmentId[]) : [],
      ) as ReadonlySet<EnvironmentId>,
    [readableKey],
  );
  const targets = useMemo(
    () =>
      enabled
        ? planCrossRepositoryReads({
            checkouts: repositories.map(toCrossRepositoryCheckout),
            capableEnvironments: readable,
            preferredEnvironmentId: primaryEnvironmentId,
          })
        : [],
    [enabled, primaryEnvironmentId, readable, repositories],
  );
  const inputs = useMemo(() => involvedChangeRequestsInputs(targets, state), [state, targets]);
  const states = useInvolvedChangeRequests(inputs);
  const overlays = useSyncExternalStore(
    subscribeCrossRepositoryOverlays,
    getCrossRepositoryOverlays,
  );
  const answers = useMemo(
    () =>
      states.flatMap((queryState, index): ReadonlyArray<CrossRepositoryAnswer> => {
        const target = inputs[index];
        return queryState.data !== null && target
          ? [{ environmentId: target.environmentId, result: queryState.data }]
          : [];
      }),
    [inputs, states],
  );
  const hostAliases = useMemo(() => crossRepositoryHostAliases(answers), [answers]);

  // Rows keep their objects across answers that change nothing (memoized list rows stay
  // put); the previous rows are state from the last render.
  const [memo, setMemo] = useState<RowsMemo | null>(null);
  let rows = memo?.rows ?? EMPTY_ROWS;
  if (
    memo === null ||
    memo.answers !== answers ||
    memo.overlays !== overlays ||
    memo.repositories !== repositories ||
    memo.readable !== readable
  ) {
    const base = applyCrossRepositoryOverlays(
      mergeCrossRepositoryChangeRequests(answers, memo?.base ?? EMPTY_BASE_ROWS),
      overlays.overlays,
      overlays.nowMs,
    );
    rows = attachCrossRepositoryCheckouts({
      rows: base,
      checkouts: repositories,
      readable,
      hostAliases,
      previous: memo?.rows,
    });
    setMemo({ answers, overlays, repositories, readable, base, rows });
  }

  const foldedGroups = usePullRequestsLayoutStore((layout) => layout.foldedGroups);
  const labelKey = (search.label ?? []).join("\u0000");
  const listSearch = useMemo<PullRequestsSearch>(
    () => ({
      ...(search.state !== undefined ? { state: search.state } : {}),
      ...(search.q !== undefined ? { q: search.q } : {}),
      ...(search.only !== undefined ? { only: search.only } : {}),
      ...(labelKey.length > 0 ? { label: labelKey.split("\u0000") } : {}),
      ...(search.sort !== undefined ? { sort: search.sort } : {}),
    }),
    [labelKey, search.only, search.q, search.sort, search.state],
  );
  const derived = useMemo(
    () => deriveCrossRepositoryList({ rows, search: listSearch, foldedGroups }),
    [foldedGroups, listSearch, rows],
  );
  const notes = useMemo(
    () =>
      deriveCrossRepositoryNotes({
        environments,
        targets,
        states,
        hiddenCount: derived.hiddenCount,
      }),
    [derived.hiddenCount, environments, states, targets],
  );
  const selectedKey = useMemo(
    () =>
      resolveCrossRepositorySelectedKey({
        search: { env: search.env, project: search.project, pr: search.pr },
        rows: derived.byKey,
        checkouts: repositories,
        hostAliases,
      }),
    [derived.byKey, hostAliases, repositories, search.env, search.pr, search.project],
  );
  const hasData = answers.length > 0;
  const pending = environments.some(
    (environment) => crossRepositoryEnvironmentReadiness(environment) === "pending",
  );
  const isLoading =
    !hasData &&
    (states.some((queryState) => queryState.error === null) || (pending && targets.length === 0));
  const isFetching = states.some((queryState) => queryState.isFetching);
  return useMemo<CrossRepositoryListModel | null>(
    () =>
      enabled
        ? {
            groups: derived.groups,
            ordered: derived.ordered,
            byKey: derived.byKey,
            labels: derived.labels,
            selectedKey,
            notes,
            isLoading,
            isFetching,
            refresh: () => requestInvolvedChangeRequestsRefresh(inputs),
          }
        : null,
    [derived, enabled, inputs, isFetching, isLoading, notes, selectedKey],
  );
}
