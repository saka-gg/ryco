import {
  DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
} from "@ryco/client-runtime/connection";
import type { WsConnectionStatus, WsConnectionUiState } from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";

import type { StatusTone } from "../../components/StatusPill";
import { wsUiStateForEnvironment } from "../../rpc/wsConnectionState";
import { connectionToneForEnvironment } from "./connectionTone";

// Never carries a bearer token: rows hold label/url/state only (§3-25 secret
// boundary).
export interface ConnectionRow {
  readonly record: SavedEnvironmentRecord;
  readonly runtime: SavedEnvironmentRuntimeState;
  readonly tone: StatusTone;
  readonly statusLabel: string;
}

/**
 * One saved environment's socket UI state from the subscribed statuses.
 * `useSavedEnvironmentSnapshots` lists every record's id, so a status is always
 * there; without one the environment reads as a socket that has not started.
 */
export function savedEnvironmentUiState(
  statuses: ReadonlyMap<EnvironmentId, WsConnectionStatus>,
  environmentId: EnvironmentId,
): WsConnectionUiState {
  const status = statuses.get(environmentId);
  return status ? wsUiStateForEnvironment(status) : "connecting";
}

/**
 * One row per saved environment, sorted by label, derived only from the
 * snapshots the caller subscribes to: the registry, the runtime store and each
 * environment's own socket status. Nothing here reads a store directly, so
 * React Compiler can cache the rows on these inputs and still show a node
 * dropping, reconnecting or needing re-pairing. Each row's tone reads its OWN
 * environment's socket: saved environments multi-connect, and one node
 * reconnecting must not repaint every other node's pill.
 */
export function deriveConnectionRows(input: {
  readonly records: Readonly<Record<EnvironmentId, SavedEnvironmentRecord>>;
  readonly runtimeById: Readonly<Record<EnvironmentId, SavedEnvironmentRuntimeState | undefined>>;
  readonly statuses: ReadonlyMap<EnvironmentId, WsConnectionStatus>;
}): ReadonlyArray<ConnectionRow> {
  return Object.values(input.records)
    .map((record): ConnectionRow => {
      const runtime =
        input.runtimeById[record.environmentId] ?? DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE;
      const tone = connectionToneForEnvironment(
        runtime.connectionState,
        savedEnvironmentUiState(input.statuses, record.environmentId),
      );
      const statusLabel = runtime.authState === "requires-auth" ? "Needs re-pair" : tone.label;
      return { record, runtime, tone, statusLabel };
    })
    .toSorted((left, right) =>
      left.record.label.localeCompare(right.record.label, undefined, { sensitivity: "base" }),
    );
}
