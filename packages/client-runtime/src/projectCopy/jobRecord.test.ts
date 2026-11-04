import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { ProjectExportId, ProjectImportId, ProjectTransferId } from "@ryco/contracts/project-copy";
import { describe, expect, it } from "vite-plus/test";

import {
  createProjectCopyJobRecord,
  decodeProjectCopyJobRecords,
  PROJECT_COPY_FINISHED_RECORD_TTL_MS,
  PROJECT_COPY_JOB_RECORDS_MAX,
  projectCopyReportOwed,
  projectCopyResumeKind,
  reduceProjectCopyJobRecord,
  upsertProjectCopyJobRecord,
  type ProjectCopyJobRecord,
} from "./jobRecord.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const record = (copy = 1, at = 1_000): ProjectCopyJobRecord =>
  createProjectCopyJobRecord({
    copyId: uuid(copy),
    at,
    sourceEnvironmentId: "env-a" as EnvironmentId,
    sourceProjectId: "project-a" as ProjectId,
    targetEnvironmentId: "env-b" as EnvironmentId,
    projectId: "project-new" as ProjectId,
    importId: ProjectImportId.make(uuid(100 + copy)),
  });

describe("reduceProjectCopyJobRecord", () => {
  it("moves through the stages and keeps only ids", () => {
    let current = record();
    const exportId = ProjectExportId.make(uuid(2));
    const first = ProjectTransferId.make(uuid(3));
    const second = ProjectTransferId.make(uuid(4));
    current = reduceProjectCopyJobRecord(current, { type: "export-assigned", exportId, at: 1_001 });
    current = reduceProjectCopyJobRecord(current, {
      type: "transfer-assigned",
      purpose: "commits-bundle",
      transferId: first,
      at: 1_002,
    });
    expect(current.stage).toBe("upload");
    expect(projectCopyResumeKind(current)).toBe("continue");
    current = reduceProjectCopyJobRecord(current, {
      type: "transfer-assigned",
      purpose: "commits-bundle",
      transferId: second,
      at: 1_003,
    });
    current = reduceProjectCopyJobRecord(current, {
      type: "transfer-committed",
      transferId: second,
      at: 1_004,
    });
    expect(current.transfers).toEqual([
      { purpose: "commits-bundle", transferId: second, committed: true },
    ]);
    // A transfer the import will not carry (an earlier export's) leaves the record.
    const patch = ProjectTransferId.make(uuid(5));
    current = reduceProjectCopyJobRecord(current, {
      type: "transfer-assigned",
      purpose: "changes-patch",
      transferId: patch,
      at: 1_004,
    });
    current = reduceProjectCopyJobRecord(current, {
      type: "transfer-dropped",
      transferId: patch,
      at: 1_004,
    });
    expect(current.transfers).toEqual([
      { purpose: "commits-bundle", transferId: second, committed: true },
    ]);
    current = reduceProjectCopyJobRecord(current, { type: "import-requested", at: 1_005 });
    expect(projectCopyResumeKind(current)).toBe("follow");
    current = reduceProjectCopyJobRecord(current, { type: "import-accepted", at: 1_006 });
    // A late transfer event never moves the stage back.
    current = reduceProjectCopyJobRecord(current, {
      type: "transfer-assigned",
      purpose: "avatar",
      transferId: first,
      at: 1_007,
    });
    expect(current.stage).toBe("importing");
    current = reduceProjectCopyJobRecord(current, {
      type: "finished",
      outcome: "completed",
      at: 1_008,
    });
    expect(current).toMatchObject({ stage: "finished", outcome: "completed", updatedAt: 1_008 });
    expect(projectCopyResumeKind(current)).toBe("none");
    expect(reduceProjectCopyJobRecord(current, { type: "import-requested", at: 1_009 })).toBe(
      current,
    );
  });

  it("starts the same copy over with new ids", () => {
    const finished = reduceProjectCopyJobRecord(
      reduceProjectCopyJobRecord(record(), {
        type: "export-assigned",
        exportId: ProjectExportId.make(uuid(2)),
        at: 1_001,
      }),
      { type: "finished", outcome: "failed", at: 1_002 },
    );
    const restarted = reduceProjectCopyJobRecord(finished, {
      type: "restarted",
      importId: ProjectImportId.make(uuid(9)),
      projectId: "project-retry" as ProjectId,
      at: 1_003,
    });
    expect(restarted).toMatchObject({
      copyId: finished.copyId,
      stage: "export",
      outcome: null,
      exportId: null,
      transfers: [],
      importId: uuid(9),
      projectId: "project-retry",
    });
  });
});

describe("Agent Control reports", () => {
  const agentControl = {
    environmentId: "env-agent" as EnvironmentId,
    proposalId: "proposal-1",
    executorId: uuid(50),
  };

  it("owes the final report from the finish until the node took it", () => {
    const running = createProjectCopyJobRecord({
      copyId: uuid(1),
      at: 1_000,
      sourceEnvironmentId: null,
      sourceProjectId: null,
      targetEnvironmentId: "env-b" as EnvironmentId,
      projectId: "project-new" as ProjectId,
      importId: ProjectImportId.make(uuid(101)),
      agentControl,
    });
    expect(projectCopyReportOwed(running)).toBe(false);
    // A finished record stays resumable for its report only, not for the copy.
    const finished = reduceProjectCopyJobRecord(running, {
      type: "finished",
      outcome: "completed",
      at: 1_001,
    });
    expect(projectCopyReportOwed(finished)).toBe(true);
    expect(projectCopyResumeKind(finished)).toBe("none");
    // Reporting before the end does nothing: there is nothing final to report yet.
    expect(reduceProjectCopyJobRecord(running, { type: "reported", at: 1_002 })).toBe(running);

    const reported = reduceProjectCopyJobRecord(finished, { type: "reported", at: 1_003 });
    expect(reported).toMatchObject({ agentControl: { reported: true }, updatedAt: 1_003 });
    expect(projectCopyReportOwed(reported)).toBe(false);
    // A copy of the user's own never owes one.
    expect(
      projectCopyReportOwed(
        reduceProjectCopyJobRecord(record(), { type: "finished", outcome: "failed", at: 1_004 }),
      ),
    ).toBe(false);
    // Stored and read back, the flag survives.
    expect(decodeProjectCopyJobRecords(JSON.parse(JSON.stringify([reported])))).toEqual([reported]);
  });

  it("keeps a record that owes its report ahead of finished ones when the list is full", () => {
    const now = 10_000;
    const owed = reduceProjectCopyJobRecord(
      { ...record(1, now - 100), agentControl },
      { type: "finished", outcome: "completed", at: now - 100 },
    );
    let records = upsertProjectCopyJobRecord([], owed, now);
    for (let index = 0; index < PROJECT_COPY_JOB_RECORDS_MAX + 5; index += 1) {
      records = upsertProjectCopyJobRecord(
        records,
        reduceProjectCopyJobRecord(record(10 + index, now), {
          type: "finished",
          outcome: "completed",
          at: now,
        }),
        now,
      );
    }
    expect(records).toHaveLength(PROJECT_COPY_JOB_RECORDS_MAX);
    expect(records.map((entry) => entry.copyId)).toContain(owed.copyId);
  });
});

describe("stored records", () => {
  it("keeps unfinished records first, drops expired finished ones and caps the list", () => {
    const now = 10 * PROJECT_COPY_FINISHED_RECORD_TTL_MS;
    const old = reduceProjectCopyJobRecord(record(1, 1), {
      type: "finished",
      outcome: "completed",
      at: 1,
    });
    let records = upsertProjectCopyJobRecord([], old, now);
    expect(records).toEqual([]);
    for (let index = 0; index < PROJECT_COPY_JOB_RECORDS_MAX + 5; index += 1) {
      records = upsertProjectCopyJobRecord(records, record(10 + index, now - index), now);
    }
    expect(records).toHaveLength(PROJECT_COPY_JOB_RECORDS_MAX);
    const updated = { ...records[3]!, updatedAt: now };
    records = upsertProjectCopyJobRecord(records, updated, now);
    expect(records[0]).toEqual(updated);
    expect(new Set(records.map((entry) => entry.copyId)).size).toBe(records.length);
  });

  it("decodes stored records and drops damaged entries", () => {
    const stored = JSON.parse(JSON.stringify([record(1), { ...record(2), importId: "nope" }, 3]));
    expect(decodeProjectCopyJobRecords(stored)).toEqual([record(1)]);
    expect(decodeProjectCopyJobRecords({})).toEqual([]);
  });
});
