/**
 * The local record of one copy, so a reload can pick it up again (A1(5), A22): ids and stages
 * only. Artifacts never reach browser storage, and neither do paths, titles, prompts or the
 * setup command; a resumed copy reads those again from its plan or from the target's import.
 *
 * The app persists the records it is handed (`onRecord`) and passes one back to resume.
 *
 * @module projectCopy/jobRecord
 */
import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "@ryco/contracts/base-schemas";
import {
  ProjectExportId,
  ProjectImportId,
  ProjectTransferId,
  ProjectTransferPurpose,
} from "@ryco/contracts/project-copy";
import * as Schema from "effect/Schema";

/**
 * - `export`: the source export is being made.
 * - `upload`: artifacts are being sent to the target.
 * - `import-requested`: `projects.importStart` went out, its answer did not arrive yet.
 * - `importing`: the target accepted the import; it runs there on its own.
 * - `finished`: see `outcome`.
 */
export const ProjectCopyJobStage = Schema.Literals([
  "export",
  "upload",
  "import-requested",
  "importing",
  "finished",
]);
export type ProjectCopyJobStage = typeof ProjectCopyJobStage.Type;

export const ProjectCopyJobOutcome = Schema.Literals(["completed", "failed", "cancelled"]);
export type ProjectCopyJobOutcome = typeof ProjectCopyJobOutcome.Type;

export const ProjectCopyJobTransfer = Schema.Struct({
  purpose: ProjectTransferPurpose,
  transferId: ProjectTransferId,
  committed: Schema.Boolean,
});
export type ProjectCopyJobTransfer = typeof ProjectCopyJobTransfer.Type;

const STAGE_ORDER: Record<ProjectCopyJobStage, number> = {
  export: 0,
  upload: 1,
  "import-requested": 2,
  importing: 3,
  finished: 4,
};

export const ProjectCopyJobRecord = Schema.Struct({
  version: Schema.Literal(1),
  copyId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
  /** Null for a copy with no source node (an agent's repository URL). */
  sourceEnvironmentId: Schema.NullOr(EnvironmentId),
  sourceProjectId: Schema.NullOr(ProjectId),
  targetEnvironmentId: EnvironmentId,
  /** The new project's id on the target. */
  projectId: ProjectId,
  /**
   * The repository directory the copy creates on the target, as planned. A
   * stopped copy resumes only into it. Absent on records written before it was
   * kept, and on imports tracked without a plan.
   */
  destinationPath: Schema.optionalKey(Schema.String),
  exportId: Schema.NullOr(ProjectExportId),
  transfers: Schema.Array(ProjectCopyJobTransfer),
  importId: ProjectImportId,
  stage: ProjectCopyJobStage,
  /** Set once `stage` is `finished`. */
  outcome: Schema.NullOr(ProjectCopyJobOutcome),
  /**
   * For a copy an Agent Control proposal asked for: what the executor reports
   * with, and the node the proposal lives on (the agent's node), which a resumed
   * copy reports to.
   */
  agentControl: Schema.NullOr(
    Schema.Struct({
      environmentId: EnvironmentId,
      proposalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
      executorId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
      /**
       * The proposal's node took the copy's final report (`completed` / `failed`), or answered
       * that it never will. Until then a finished record still owes it ({@link projectCopyReportOwed}).
       */
      reported: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type ProjectCopyJobRecord = typeof ProjectCopyJobRecord.Type;

export function createProjectCopyJobRecord(input: {
  readonly copyId: string;
  readonly at: number;
  readonly sourceEnvironmentId: EnvironmentId | null;
  readonly sourceProjectId: ProjectId | null;
  readonly targetEnvironmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly importId: ProjectImportId;
  readonly destinationPath?: string | null | undefined;
  readonly agentControl?: ProjectCopyJobRecord["agentControl"] | undefined;
}): ProjectCopyJobRecord {
  return {
    version: 1,
    copyId: input.copyId,
    createdAt: input.at,
    updatedAt: input.at,
    sourceEnvironmentId: input.sourceEnvironmentId,
    sourceProjectId: input.sourceProjectId,
    targetEnvironmentId: input.targetEnvironmentId,
    projectId: input.projectId,
    ...(input.destinationPath ? { destinationPath: input.destinationPath } : {}),
    exportId: null,
    transfers: [],
    importId: input.importId,
    stage: "export",
    outcome: null,
    agentControl: input.agentControl ?? null,
  };
}

export type ProjectCopyJobChange =
  | { readonly type: "export-assigned"; readonly exportId: ProjectExportId }
  /** A transfer for `purpose`; replaces an earlier one for the same purpose. */
  | {
      readonly type: "transfer-assigned";
      readonly purpose: ProjectTransferPurpose;
      readonly transferId: ProjectTransferId;
    }
  | { readonly type: "transfer-committed"; readonly transferId: ProjectTransferId }
  /** A transfer the import will not carry: its export was made again without that artifact. */
  | { readonly type: "transfer-dropped"; readonly transferId: ProjectTransferId }
  | { readonly type: "import-requested" }
  | { readonly type: "import-accepted" }
  /** The same copy started over with a new export and import (Send files after a failed clone). */
  | {
      readonly type: "restarted";
      readonly importId: ProjectImportId;
      readonly projectId: ProjectId;
    }
  | { readonly type: "finished"; readonly outcome: ProjectCopyJobOutcome }
  /** An Agent Control copy's final report was taken (or refused for good) by the proposal's node. */
  | { readonly type: "reported" };

export type ProjectCopyJobEvent = ProjectCopyJobChange & { readonly at: number };

const advance = (stage: ProjectCopyJobStage, to: ProjectCopyJobStage): ProjectCopyJobStage =>
  STAGE_ORDER[to] > STAGE_ORDER[stage] ? to : stage;

/**
 * Applies one event. A finished record changes only through `restarted`, and `reported` applies
 * only to a finished Agent Control record.
 */
export function reduceProjectCopyJobRecord(
  record: ProjectCopyJobRecord,
  event: ProjectCopyJobEvent,
): ProjectCopyJobRecord {
  if (event.type === "reported") {
    if (!projectCopyReportOwed(record) || record.agentControl === null) return record;
    return {
      ...record,
      updatedAt: Math.max(record.updatedAt, event.at),
      agentControl: { ...record.agentControl, reported: true },
    };
  }
  if (record.stage === "finished" && event.type !== "restarted") return record;
  const touched = { ...record, updatedAt: Math.max(record.updatedAt, event.at) };
  switch (event.type) {
    case "export-assigned":
      return { ...touched, exportId: event.exportId };
    case "transfer-assigned":
      return {
        ...touched,
        stage: advance(record.stage, "upload"),
        transfers: [
          ...record.transfers.filter((transfer) => transfer.purpose !== event.purpose),
          { purpose: event.purpose, transferId: event.transferId, committed: false },
        ],
      };
    case "transfer-committed":
      return {
        ...touched,
        transfers: record.transfers.map((transfer) =>
          transfer.transferId === event.transferId ? { ...transfer, committed: true } : transfer,
        ),
      };
    case "transfer-dropped":
      return {
        ...touched,
        transfers: record.transfers.filter((transfer) => transfer.transferId !== event.transferId),
      };
    case "import-requested":
      return { ...touched, stage: advance(record.stage, "import-requested") };
    case "import-accepted":
      return { ...touched, stage: advance(record.stage, "importing") };
    case "restarted":
      return {
        ...touched,
        exportId: null,
        transfers: [],
        importId: event.importId,
        projectId: event.projectId,
        stage: "export",
        outcome: null,
      };
    case "finished":
      return { ...touched, stage: "finished", outcome: event.outcome };
  }
}

/**
 * What a reload can do with an unfinished record. `follow`: the import may exist on the target,
 * so look it up and follow it. `continue`: the upload had not finished; going on needs the
 * copy's plan (the Agent Control executor rebuilds it from the proposal), otherwise the leftovers
 * are cleaned up.
 */
export type ProjectCopyResumeKind = "none" | "follow" | "continue";

export function projectCopyResumeKind(record: ProjectCopyJobRecord): ProjectCopyResumeKind {
  switch (record.stage) {
    case "finished":
      return "none";
    case "import-requested":
    case "importing":
      return "follow";
    case "export":
    case "upload":
      return "continue";
  }
}

/**
 * A finished Agent Control copy whose final report the proposal's node has not taken yet (A1(4)):
 * the app keeps sending it, after a reload too, until the node takes or refuses it.
 */
export function projectCopyReportOwed(record: ProjectCopyJobRecord): boolean {
  return (
    record.stage === "finished" &&
    record.agentControl !== null &&
    record.agentControl.reported !== true
  );
}

export function projectCopyJobTransfer(
  record: ProjectCopyJobRecord,
  purpose: ProjectTransferPurpose,
): ProjectCopyJobTransfer | null {
  return record.transfers.find((transfer) => transfer.purpose === purpose) ?? null;
}

/** At most this many records are kept, the ones still in use first. */
export const PROJECT_COPY_JOB_RECORDS_MAX = 20;
/** Finished records are dropped after a week. */
export const PROJECT_COPY_FINISHED_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Unfinished, or still owing its report: the record is needed until then. */
const inUse = (record: ProjectCopyJobRecord): boolean =>
  record.stage !== "finished" || projectCopyReportOwed(record);

/**
 * Replaces the record with the same `copyId` (or adds it), newest first, drops finished records
 * past their TTL (an owed report too: the node's deadline is long gone by then) and keeps at most
 * {@link PROJECT_COPY_JOB_RECORDS_MAX}.
 */
export function upsertProjectCopyJobRecord(
  records: ReadonlyArray<ProjectCopyJobRecord>,
  record: ProjectCopyJobRecord,
  now: number,
): ReadonlyArray<ProjectCopyJobRecord> {
  const merged = [record, ...records.filter((entry) => entry.copyId !== record.copyId)].filter(
    (entry) =>
      entry.stage !== "finished" || now - entry.updatedAt <= PROJECT_COPY_FINISHED_RECORD_TTL_MS,
  );
  return [...merged.filter(inUse), ...merged.filter((entry) => !inUse(entry))]
    .slice(0, PROJECT_COPY_JOB_RECORDS_MAX)
    .toSorted((left, right) => right.updatedAt - left.updatedAt);
}

const isProjectCopyJobRecord = Schema.is(ProjectCopyJobRecord);

/** Reads stored records, dropping any that do not decode (an older or damaged entry). */
export function decodeProjectCopyJobRecords(value: unknown): ReadonlyArray<ProjectCopyJobRecord> {
  return Array.isArray(value) ? value.filter(isProjectCopyJobRecord) : [];
}
