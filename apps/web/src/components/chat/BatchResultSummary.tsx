import { useEffect, useState } from "react";
import type { BatchLaunch, BatchLaunchDestination } from "@ryco/client-runtime/state/composer";
import {
  captureBatchLaunchReadiness,
  deriveBatchResultEvidence,
  readBatchResultEvidence,
} from "@ryco/client-runtime/state/composer";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { Link } from "@tanstack/react-router";
import { batchLaunchStore } from "../../batchLaunchStore";
import { readEnvironmentConnection } from "../../environments/runtime";
import { readEnvironmentApi } from "../../environmentApi";
import { useWsConnectionStatusForEnvironment } from "../../rpc/wsConnectionState";
import { availablePaneSplit, useChatPanesStore } from "../../chatPanesStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { buildOpenReviewSearch } from "../../workspaceRouteSearch";

type Evidence = NonNullable<ReturnType<typeof deriveBatchResultEvidence>>;
export function BatchResultSummary(props: {
  batch: BatchLaunch;
  onRetry?: (() => void) | undefined;
  onNew?: (() => void) | undefined;
  error?: string | null | undefined;
  retryDisabled: boolean;
}) {
  const { batch } = props;
  const connection = useWsConnectionStatusForEnvironment(batch.environmentId);
  const [refresh, setRefresh] = useState(0);
  const [evidenceState, setEvidenceState] = useState<{
    stamp: string;
    items: Record<string, Evidence>;
  }>({ stamp: "", items: {} });
  const stamp = `${batch.id}:${connection.phase}:${connection.attemptCount}:${connection.connectedAt}:${refresh}`;
  const evidence = evidenceState.stamp === stamp ? evidenceState.items : {};
  useEffect(() => {
    const api = readEnvironmentApi(batch.environmentId);
    if (connection.phase !== "connected" || !api?.orchestration.getThreadWindow) return;
    let current = true;
    const guard = captureBatchLaunchReadiness(batch.environmentId, () =>
      readEnvironmentConnection(batch.environmentId),
    );
    void Promise.all(
      batch.destinations
        .filter((target) => ["launched", "uncertain"].includes(target.status))
        .map(async (target) => {
          try {
            const item = await readBatchResultEvidence({
              api,
              batch: batch,
              destination: target,
              assertMutationReady: guard,
            });
            if (!current || !item) return;
            setEvidenceState((previous) => ({
              stamp,
              items: {
                ...(previous.stamp === stamp ? previous.items : {}),
                [target.threadId]: item,
              },
            }));
            if (target.status === "uncertain" && item.accepted && item.worktreePath)
              await batchLaunchStore.reconcile(batch.id, [item]);
          } catch {
            /* No evidence is a displayed unknown, never proof of safe retry. */
          }
        }),
    );
    return () => {
      current = false;
    };
  }, [batch, connection.phase, stamp]);
  const pending = batch.destinations.some((target) =>
    ["queued", "preparing", "dispatching", "failed"].includes(target.status),
  );
  return (
    <section
      aria-label="Batch results"
      className="mx-auto mb-2 w-full max-w-208 rounded border bg-background p-3 text-xs"
    >
      {props.error && (
        <p role="alert" className="mb-2 text-destructive">
          {props.error}
        </p>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <strong>
          Model comparison ·{" "}
          {batch.destinations.filter((target) => target.status === "launched").length}/
          {batch.destinations.length} launched
        </strong>
        {pending && (
          <button
            type="button"
            className="underline"
            onClick={() => void batchLaunchStore.cancel(batch.id).catch(() => {})}
          >
            Stop remaining launches
          </button>
        )}
        {props.onRetry && batch.destinations.some((target) => target.status === "failed") && (
          <button
            type="button"
            className="underline disabled:opacity-40"
            disabled={props.retryDisabled}
            onClick={props.onRetry}
          >
            Retry safe failures
          </button>
        )}
        <button
          type="button"
          className="underline"
          disabled={connection.phase !== "connected"}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh evidence
        </button>
        {props.onNew &&
          batch.destinations.every(
            (target) => target.status === "launched" || target.status === "cancelled",
          ) && (
            <button type="button" className="underline" onClick={props.onNew}>
              Start another comparison
            </button>
          )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-muted-foreground">
              <th className="p-1">Selection</th>
              <th className="p-1">Launch / turn</th>
              <th className="p-1">Latest diff</th>
              <th className="p-1">Reported tokens</th>
              <th className="p-1">Result</th>
            </tr>
          </thead>
          <tbody>
            {batch.destinations.map((target) => (
              <BatchResultRow
                key={target.threadId}
                batch={batch}
                target={target}
                evidence={evidence[target.threadId]}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-muted-foreground">
        Uncertain launches are never resent. Draft and context are retained. Use each thread’s
        Review panel to inspect changes; test results require the candidate’s own evidence.
      </p>
    </section>
  );
}
function BatchResultRow({
  batch,
  target,
  evidence,
}: {
  batch: BatchLaunch;
  target: BatchLaunchDestination;
  evidence?: Evidence | undefined;
}) {
  const ref = scopeThreadRef(batch.environmentId, target.threadId);
  const panes = useChatPanesStore();
  const canSplit = availablePaneSplit(panes.root, panes.activeRef, ref) !== null;
  return (
    <tr className="border-t align-top">
      <td className="max-w-64 p-1 break-words">
        {target.label}
        <div className="text-muted-foreground">
          {target.modelSelection.options
            ?.map((option) => `${option.id}: ${option.value}`)
            .join(" · ")}
        </div>
      </td>
      <td className="p-1">
        {target.status}
        {evidence ? ` / ${evidence.status}` : ""}
        {target.error && <div className="max-w-64 text-destructive">{target.error}</div>}
      </td>
      <td className="p-1">
        {evidence?.files == null
          ? "Unavailable"
          : `${evidence.files} files · +${evidence.additions} −${evidence.deletions}`}
      </td>
      <td className="p-1">
        {evidence?.tokens == null ? "Unavailable" : evidence.tokens.toLocaleString()}
      </td>
      <td className="p-1">
        {["launched", "uncertain", "dispatching"].includes(target.status) && (
          <div className="flex gap-2">
            <Link
              className="underline"
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(ref)}
            >
              Open thread
            </Link>
            <Link
              className="underline"
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(ref)}
              search={(previous) => buildOpenReviewSearch(previous)}
            >
              Review
            </Link>
            <button
              type="button"
              className="underline disabled:opacity-40"
              disabled={!canSplit}
              title="Open a candidate first, then split another result alongside it."
              onClick={() => useChatPanesStore.getState().open(ref)}
            >
              Split view
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
