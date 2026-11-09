import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import type { ProjectImportId } from "@ryco/contracts/project-copy";

import {
  copyDestinationUsable,
  copyFormBlockedReason,
  copyExplicitDestinationPath,
  copyResumeMismatch,
  copyResumeNotice,
  copyResumePin,
  legacySourceHints,
  resumableCopyRecord,
  type CopyFormReadinessInput,
} from "./form.ts";
import type { CopyTargetCard } from "./dialog.ts";
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
    destinationPath: "/code/notes",
  });
  const source = { environmentId: MINI, projectId: NOTES };
  const same = { sourceRef: source, targetEnvironmentId: LAPTOP, destinationPath: "/code/notes" };
  const card = (environmentId: EnvironmentId, selectable: boolean, reason: string | null = null) =>
    ({ node: { environmentId }, selectable, reason }) as unknown as CopyTargetCard;

  it("goes on only with the same checkout to the same node and folder", () => {
    expect(resumableCopyRecord(stopped, same)).toBe(stopped);
    expect(resumableCopyRecord(stopped, { ...same, targetEnvironmentId: SERVER })).toBeNull();
    expect(
      resumableCopyRecord(stopped, { ...same, destinationPath: "/elsewhere/notes" }),
    ).toBeNull();
    expect(
      resumableCopyRecord(stopped, {
        ...same,
        sourceRef: { environmentId: SERVER, projectId: NOTES },
      }),
    ).toBeNull();
    expect(resumableCopyRecord(stopped, { ...same, sourceRef: null })).toBeNull();
    expect(resumableCopyRecord(null, same)).toBeNull();
  });

  it("matches a record from before copies kept their folder on its checkout and node", () => {
    const { destinationPath: _kept, ...legacy } = stopped;
    expect(resumableCopyRecord(legacy, { ...same, destinationPath: "/any/notes" })).toBe(legacy);
  });

  it("pins the form to the stopped copy's node and folder, waiting while it is away", () => {
    const pinned = copyResumePin({
      record: stopped,
      cards: [card(SERVER, true), card(LAPTOP, true)],
      targetLabel: "Laptop",
    });
    expect(pinned).toMatchObject({
      targetEnvironmentId: LAPTOP,
      destinationPath: "/code/notes",
      waitingReason: null,
    });
    const away = copyResumePin({
      record: stopped,
      cards: [card(SERVER, true), card(LAPTOP, false, "offline since 09:05")],
      targetLabel: "Laptop",
    });
    // Another node being ready never takes its place.
    expect(away?.targetEnvironmentId).toBe(LAPTOP);
    expect(away?.waitingReason).toContain("Waiting for Laptop (offline since 09:05)");
    expect(
      copyResumePin({ record: stopped, cards: [], targetLabel: "Laptop" })?.waitingReason,
    ).toContain("Waiting for Laptop");
    expect(copyResumePin({ record: null, cards: [], targetLabel: "" })).toBeNull();
  });

  it("refuses a start that is not the pinned copy instead of replacing it", () => {
    const pinned = copyResumePin({
      record: stopped,
      cards: [card(LAPTOP, true)],
      targetLabel: "Laptop",
    });
    expect(copyResumeMismatch(pinned, stopped)).toBeNull();
    expect(copyResumeMismatch(pinned, null)).toContain("Discard it to start a new one");
    expect(copyResumeMismatch(null, null)).toBeNull();
  });

  it("previews a stopped copy's own folder as it is", () => {
    expect(
      copyExplicitDestinationPath({
        exactPath: "/code/notes-2",
        manualParent: "/elsewhere",
        leaf: "notes",
        pathSeparator: "/",
      }),
    ).toBe("/code/notes-2");
    expect(
      copyExplicitDestinationPath({
        exactPath: null,
        manualParent: "/elsewhere",
        leaf: "notes",
        pathSeparator: "/",
      }),
    ).toBe("/elsewhere/notes");
    expect(
      copyExplicitDestinationPath({
        exactPath: null,
        manualParent: null,
        leaf: "notes",
        pathSeparator: "/",
      }),
    ).toBeNull();
  });

  it("says what is not sent again", () => {
    expect(copyResumeNotice("Laptop")).toContain("what already reached Laptop is not sent again");
  });
});
