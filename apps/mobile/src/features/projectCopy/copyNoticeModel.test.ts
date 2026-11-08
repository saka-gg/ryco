import type { ProjectCopyJobRecord } from "@ryco/client-runtime/projectCopy";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { copyNoticeLinkPath, copyNoticeTone } from "./copyNoticeModel";

const MINI = "env-mini" as EnvironmentId;
const LAPTOP = "env-laptop" as EnvironmentId;
const NOTES = "project-notes" as ProjectId;

const record = (overrides: Partial<ProjectCopyJobRecord>) =>
  ({
    sourceEnvironmentId: null,
    sourceProjectId: null,
    targetEnvironmentId: LAPTOP,
    projectId: "project-new",
    ...overrides,
  }) as ProjectCopyJobRecord;

describe("copyNoticeLinkPath", () => {
  it("opens the copy screen on the checkout the copy started from", () => {
    expect(
      copyNoticeLinkPath(null, {
        sourceRef: { environmentId: MINI, projectId: NOTES },
        targetEnvironmentId: LAPTOP,
        project: null,
      }),
    ).toBe("projects/env-mini/project-notes/copy");
    expect(
      copyNoticeLinkPath(record({ sourceEnvironmentId: MINI, sourceProjectId: NOTES }), null),
    ).toBe("projects/env-mini/project-notes/copy");
  });

  it("falls back to the project the copy makes on its destination", () => {
    expect(copyNoticeLinkPath(record({}), null)).toBe("projects/env-laptop/project-new/copy");
    expect(copyNoticeLinkPath(null, null)).toBeNull();
  });
});

describe("copyNoticeTone", () => {
  const view = (kind: "progress" | "done" | "failed" | "cancelled", percent: number | null) => ({
    kind,
    title: "Copying notes to Laptop",
    description: "Uploading",
    percent,
    keepOpen: false,
    retryLabel: null,
  });

  it("adds the percent while the copy runs", () => {
    expect(copyNoticeTone({ kind: "progress", view: view("progress", 41.6) })).toEqual({
      symbol: "arrow.triangle.2.circlepath",
      detail: "Uploading · 42%",
    });
  });

  it("marks how a copy ended", () => {
    expect(copyNoticeTone({ kind: "result", view: view("done", null) }).symbol).toBe(
      "checkmark.circle",
    );
    expect(copyNoticeTone({ kind: "result", view: view("failed", null) }).symbol).toBe(
      "exclamationmark.triangle",
    );
    expect(
      copyNoticeTone({
        kind: "interrupted",
        view: { title: "A copy stopped", description: "Resume sends the rest." },
      }).symbol,
    ).toBe("pause.circle");
  });
});
