import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import type { ProjectImportId } from "@ryco/contracts/project-copy";

import {
  copyDestinationUsable,
  copyFormBlockedReason,
  copyResumeNotice,
  legacySourceHints,
  requestedCopyTarget,
  resumableCopyRecord,
  type CopyFormReadinessInput,
} from "./form.ts";
import { createProjectCopyJobRecord } from "./jobRecord.ts";
import type { CopyDestinationSuggestion } from "./plan.ts";

const READY: CopyFormReadinessInput = {
  title: "notes",
  sourceLabel: "Mac mini",
  targetLabel: "Laptop",
  hasSource: true,
  sourceError: null,
  sourceChecked: true,
  targetHoldError: null,
  targetSupport: "yes",
  options: null,
  destination: { status: "available" } as CopyDestinationSuggestion,
  destinationError: null,
  capReason: null,
  setupInvalid: false,
  followUpProblem: null,
};

describe("copyFormBlockedReason", () => {
  it("is null once everything was read and nothing refuses", () => {
    expect(copyFormBlockedReason(READY)).toBeNull();
  });

  it("names an offline project first", () => {
    expect(copyFormBlockedReason({ ...READY, hasSource: false, sourceError: "x" })).toBe(
      "Every checkout of notes is offline.",
    );
  });

  it("waits for the source, then for the destination", () => {
    expect(copyFormBlockedReason({ ...READY, sourceChecked: false })).toBe("Checking Mac mini…");
    expect(copyFormBlockedReason({ ...READY, destination: null })).toBe("Checking Laptop…");
    // A node without project copy is not checked for a destination.
    expect(copyFormBlockedReason({ ...READY, destination: null, targetSupport: "no" })).toBeNull();
  });

  it("puts errors before the form's own problems", () => {
    expect(
      copyFormBlockedReason({ ...READY, targetHoldError: "Laptop is offline", setupInvalid: true }),
    ).toBe("Laptop is offline");
    expect(copyFormBlockedReason({ ...READY, setupInvalid: true })).toBe(
      "Enter the setup command, or turn setup off.",
    );
    expect(copyFormBlockedReason({ ...READY, followUpProblem: "Pick a model." })).toBe(
      "Pick a model.",
    );
  });
});

describe("copyDestinationUsable", () => {
  it("refuses a blocked folder and an existing project", () => {
    expect(copyDestinationUsable(null)).toBe(false);
    expect(copyDestinationUsable({ status: "blocked" } as CopyDestinationSuggestion)).toBe(false);
    expect(copyDestinationUsable({ status: "existing-project" } as CopyDestinationSuggestion)).toBe(
      false,
    );
    expect(copyDestinationUsable({ status: "link" } as CopyDestinationSuggestion)).toBe(true);
  });
});

describe("legacySourceHints", () => {
  it("infers the home and separator from the path", () => {
    expect(legacySourceHints({ cwd: "/Users/ada/code/notes" })).toEqual({
      homeDirectory: "/Users/ada",
      pathSeparator: "/",
    });
    expect(legacySourceHints({ cwd: "C:\\Users\\ada\\notes" })).toEqual({
      homeDirectory: "C:\\Users\\ada",
      pathSeparator: "\\",
    });
    expect(legacySourceHints({ cwd: "/srv/notes" })).toBeNull();
  });
});

describe("resuming a stopped copy", () => {
  const MINI = "env-mini" as EnvironmentId;
  const LAPTOP = "env-laptop" as EnvironmentId;
  const SERVER = "env-server" as EnvironmentId;
  const NOTES = "project-notes" as ProjectId;
  const stopped = createProjectCopyJobRecord({
    copyId: "copy-stopped",
    at: 1_000,
    sourceEnvironmentId: MINI,
    sourceProjectId: NOTES,
    targetEnvironmentId: LAPTOP,
    projectId: "project-new" as ProjectId,
    importId: "import-1" as ProjectImportId,
  });
  const source = { environmentId: MINI, projectId: NOTES };

  it("goes on only with the same checkout to the same node", () => {
    expect(resumableCopyRecord(stopped, { sourceRef: source, targetEnvironmentId: LAPTOP })).toBe(
      stopped,
    );
    expect(
      resumableCopyRecord(stopped, { sourceRef: source, targetEnvironmentId: SERVER }),
    ).toBeNull();
    expect(
      resumableCopyRecord(stopped, {
        sourceRef: { environmentId: SERVER, projectId: NOTES },
        targetEnvironmentId: LAPTOP,
      }),
    ).toBeNull();
    expect(
      resumableCopyRecord(stopped, { sourceRef: null, targetEnvironmentId: LAPTOP }),
    ).toBeNull();
    expect(
      resumableCopyRecord(null, { sourceRef: source, targetEnvironmentId: LAPTOP }),
    ).toBeNull();
  });

  it("starts the form on the stopped copy's node unless another was asked for", () => {
    expect(requestedCopyTarget(null, stopped)).toBe(LAPTOP);
    expect(requestedCopyTarget(SERVER, stopped)).toBe(SERVER);
    expect(requestedCopyTarget(null, null)).toBeNull();
  });

  it("says what is not sent again", () => {
    expect(copyResumeNotice("Laptop")).toContain("what already reached Laptop is not sent again");
  });
});
