/**
 * databaseCompaction - the desktop app's one-click compaction of its own database.
 *
 * A server cannot swap its own database file, so the app does what `ryco doctor --apply` asks
 * of a person: it stops its server, runs the doctor (`--apply --yes --progress-json`, its own
 * CLI as for `db restore`, `databaseRecovery.ts`), and starts the server again; the window
 * reconnects as after any restart. Every check is the doctor's: free disk, the database's
 * integrity, the copy's integrity and row counts, no other process holding the file. Until the
 * doctor reports its `swap` step, Cancel ends it (SIGTERM: its finalizers remove the copy and the
 * database file stays as it was); from then on the swap finishes. The run's record goes next to
 * the database, where the server reads it for Storage settings.
 *
 * The renderer starts a run only when its server says nothing would be cut off.
 * Electron-free, so it is testable; `main.ts` wires it.
 *
 * @module databaseCompaction
 */
import type { DesktopDatabaseCompactionState } from "@ryco/contracts";

import type { ServerCliResult } from "./databaseRecovery.ts";

/** The doctor command the app runs (`serverCliArgs` adds `--base-dir`, `--dev-url`, `--json`). */
export const DATABASE_COMPACTION_COMMAND = ["doctor", "--apply", "--yes", "--progress-json"];
/** A 10 GB database takes minutes; a stuck run ends after this. */
export const DATABASE_COMPACTION_TIMEOUT_MS = 3 * 60 * 60_000;
/** The record the server reads (`apps/server/src/storage/databaseCompaction.ts`). */
export const DATABASE_COMPACTION_RECORD_FILE = "database-compaction.json";

export type DoctorProgressEvent =
  | { readonly type: "phase"; readonly text: string; readonly step?: "swap" }
  | { readonly type: "progress"; readonly text: string; readonly fraction: number | null }
  | { readonly type: "note"; readonly text: string };

/** One `--progress-json` line, or null for anything else (a log line, a partial write). */
export function parseDoctorProgressLine(line: string): DoctorProgressEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (typeof event.text !== "string") return null;
  switch (event.type) {
    case "phase":
      return event.step === "swap"
        ? { type: "phase", text: event.text, step: "swap" }
        : { type: "phase", text: event.text };
    case "progress":
      return {
        type: "progress",
        text: event.text,
        fraction: typeof event.fraction === "number" ? event.fraction : null,
      };
    case "note":
      return { type: "note", text: event.text };
    default:
      return null;
  }
}

type RunningState = Extract<DesktopDatabaseCompactionState, { readonly phase: "running" }>;

export const startingState = (startedAt: Date): RunningState => ({
  phase: "running",
  startedAt: startedAt.toISOString(),
  text: "Stopping Ryco's server",
  detail: null,
  fraction: null,
  cancellable: true,
});

/** The running state after one doctor event. Once the swap starts it is never cancellable. */
export function applyDoctorProgress(state: RunningState, event: DoctorProgressEvent): RunningState {
  switch (event.type) {
    case "phase":
      return {
        ...state,
        text: event.text,
        detail: null,
        fraction: null,
        cancellable: state.cancellable && event.step !== "swap",
      };
    case "progress":
      return { ...state, detail: event.text, fraction: event.fraction };
    case "note":
      return { ...state, detail: event.text };
  }
}

type FinishedState = Extract<DesktopDatabaseCompactionState, { readonly phase: "finished" }>;

const STATUSES = new Set<FinishedState["status"]>([
  "repaired",
  "compacted",
  "already-compact",
  "refused",
  "failed",
]);

const lastJsonLine = (stdout: string): unknown => {
  const line = stdout.trim().split("\n").at(-1);
  if (line === undefined || line.length === 0) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** What the doctor did, from its `--json` result document and exit. */
export function readCompactionOutcome(
  result: ServerCliResult,
  cancelled: boolean,
): Pick<FinishedState, "status" | "message" | "beforeBytes" | "afterBytes"> {
  const document = lastJsonLine(result.stdout) as
    | { readonly result?: Record<string, unknown> }
    | undefined;
  const doctor = document?.result;
  if (doctor !== undefined && STATUSES.has(doctor.status as FinishedState["status"])) {
    const size = (side: unknown) => {
      const bytes = (side as { readonly fileBytes?: unknown } | null | undefined)?.fileBytes;
      return typeof bytes === "number" && bytes >= 0 ? bytes : null;
    };
    return {
      status: doctor.status as FinishedState["status"],
      message: typeof doctor.message === "string" ? doctor.message : "",
      beforeBytes: size(doctor.before),
      afterBytes: size(doctor.after),
    };
  }
  if (cancelled) {
    return {
      status: "cancelled",
      message: "Cancelled before the database file was replaced; it is unchanged.",
      beforeBytes: null,
      afterBytes: null,
    };
  }
  const errorLine = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.length > 0 && parseDoctorProgressLine(line) === null);
  return {
    status: "failed",
    message: result.timedOut
      ? "The compaction did not finish in time and was stopped. The database file was not replaced."
      : (errorLine?.replace(/^Error:\s*/, "") ??
        `The doctor stopped (exit code ${result.exitCode ?? "none"}).`),
    beforeBytes: null,
    afterBytes: null,
  };
}

/** The record the server reads after it started again. */
export const compactionRecord = (state: FinishedState) => ({
  version: 1 as const,
  runner: "desktop" as const,
  startedAt: state.startedAt,
  run: {
    runner: "desktop" as const,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    status: state.status,
    message: state.message,
    beforeBytes: state.beforeBytes,
    afterBytes: state.afterBytes,
    downtimeMs: state.downtimeMs,
  },
});
