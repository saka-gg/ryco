// FILE: projectCopyProgress.logic.ts
// Purpose: What a running or finished cross-node copy says about itself: the
//          progress toast's title, status line and percent, shared with the
//          copy dialog's progress view and the Projects page's Copies block so
//          every surface words a copy the same way.
// Layer: Pure web presentation over the coordinator's `ProjectCopyProgress`.

import type { ProjectCopyProgress } from "@ryco/client-runtime/projectCopy";
import type { ProjectImportSnapshot, ProjectImportStepId } from "@ryco/contracts/project-copy";

/**
 * What the copy runtime runs: a copy from another node, a clone of a remote (the
 * add-project dialog, an agent's repository source) or the link of a checkout
 * that is already there. Only the wording differs.
 */
export type ProjectCopyAction = "copy" | "clone" | "link";

export interface ProjectCopyLabels {
  /** The project's name; null while a resumed copy has not heard from the target yet. */
  readonly title: string | null;
  readonly sourceLabel: string | null;
  readonly targetLabel: string | null;
  /** Defaults to `copy`. */
  readonly action?: ProjectCopyAction | undefined;
}

interface ProjectCopyActionWords {
  /** "Copying" */
  readonly doing: string;
  /** "copy" (verb and noun alike) */
  readonly word: string;
  /** The preposition before the target: "to", "on". */
  readonly toTarget: string;
}

const ACTION_WORDS: Readonly<Record<ProjectCopyAction, ProjectCopyActionWords>> = {
  copy: { doing: "Copying", word: "copy", toTarget: "to" },
  clone: { doing: "Cloning", word: "clone", toTarget: "to" },
  link: { doing: "Linking", word: "link", toTarget: "on" },
};

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export type ProjectCopyViewKind = "progress" | "done" | "failed" | "cancelled";

export interface ProjectCopyView {
  readonly kind: ProjectCopyViewKind;
  readonly title: string;
  /** The status line: what runs now, or how it ended. */
  readonly description: string;
  /** 0–100 for the part that runs now; null when there is nothing to measure. */
  readonly percent: number | null;
  /** The upload still needs this client (A22): closing Ryco would stop the copy. */
  readonly keepOpen: boolean;
  /** The retry a failure offers, worded for a button; null when it offers none. */
  readonly retryLabel: string | null;
}

const STEP_LABELS: Readonly<Record<ProjectImportStepId, string>> = {
  preflight: "Checking the destination",
  clone: "Cloning the repository",
  remotes: "Adding remotes",
  commits: "Adding unpushed commits",
  checkout: "Checking out the branch",
  changes: "Applying uncommitted changes",
  submodules: "Updating submodules",
  lfs: "Fetching large files",
  register: "Adding the project",
  settings: "Copying project settings",
  avatar: "Copying the avatar",
  setup: "Running the setup command",
  "follow-up": "Starting the setup thread",
};

export function projectImportStepLabel(step: ProjectImportStepId): string {
  return STEP_LABELS[step];
}

/** The last non-empty line of an import's output tail ("Receiving objects 45% (830/1844)"). */
export function lastOutputLine(outputTail: string): string | null {
  const lines = outputTail.split(/\r?\n|\r/u).map((line) => line.trim());
  return lines.findLast((line) => line.length > 0) ?? null;
}

const MEGABYTE = 1024 * 1024;

/** "12 of 38 MB"; one decimal under 10 MB so small uploads still move. */
export function formatCopyTransfer(uploadedBytes: number, totalBytes: number): string {
  const format = (bytes: number) => {
    const megabytes = bytes / MEGABYTE;
    return megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes).toString();
  };
  return `${format(uploadedBytes)} of ${format(totalBytes)} MB`;
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

/** The step that runs now on the target, else the last one that finished. */
export function currentImportStep(
  snapshot: ProjectImportSnapshot,
): ProjectImportSnapshot["steps"][number] | null {
  return (
    snapshot.steps.find((step) => step.status === "running") ??
    snapshot.steps.findLast((step) => step.status === "done" || step.status === "failed") ??
    null
  );
}

/** The percent of the part that runs now: the upload's bytes, or the import's step. */
export function projectCopyPercent(progress: ProjectCopyProgress): number | null {
  switch (progress.phase) {
    case "upload":
      return progress.totalBytes > 0
        ? clampPercent((progress.uploadedBytes / progress.totalBytes) * 100)
        : null;
    case "import": {
      const snapshot = progress.importSnapshot;
      if (snapshot === null) return null;
      const running = snapshot.steps.find((step) => step.status === "running");
      if (running?.progressPercent != null) return clampPercent(running.progressPercent);
      const counted = snapshot.steps.filter((step) => step.status !== "skipped");
      if (counted.length === 0) return null;
      const finished = counted.filter((step) => step.status === "done" || step.status === "failed");
      return clampPercent((finished.length / counted.length) * 100);
    }
    case "done":
      return 100;
    default:
      return null;
  }
}

function progressLine(progress: ProjectCopyProgress, labels: ProjectCopyLabels): string {
  const target = labels.targetLabel ?? "the destination";
  switch (progress.phase) {
    case "acquire":
      return progress.uploadedBytes > 0 || progress.canCloseClient
        ? `Reconnecting to ${target}…`
        : `Connecting to ${target}…`;
    case "export":
      return `Preparing the files on ${labels.sourceLabel ?? "the source"}…`;
    case "upload":
      return progress.totalBytes > 0
        ? `Sending ${formatCopyTransfer(progress.uploadedBytes, progress.totalBytes)}. Keep Ryco open until the upload finishes.`
        : "Keep Ryco open until the upload finishes.";
    case "import": {
      const step = progress.importSnapshot ? currentImportStep(progress.importSnapshot) : null;
      const doing = step
        ? projectImportStepLabel(step.id)
        : `Starting the ${ACTION_WORDS[labels.action ?? "copy"].word}`;
      return progress.canCloseClient
        ? `${doing}. Runs on ${target}; you can close Ryco.`
        : `${doing}…`;
    }
    default:
      return "";
  }
}

/** The whole view of one copy, for its toast, the dialog and the Copies block. */
export function projectCopyView(
  progress: ProjectCopyProgress,
  labels: ProjectCopyLabels,
): ProjectCopyView {
  const title = labels.title ?? progress.importSnapshot?.title ?? null;
  const target = labels.targetLabel ?? "the destination";
  const name = title ?? "The project";
  const words = ACTION_WORDS[labels.action ?? "copy"];
  const onTarget = `${words.toTarget} ${target}`;
  switch (progress.phase) {
    case "done":
      return {
        kind: "done",
        title: `${name} is ready on ${target}`,
        description:
          progress.importSnapshot && progress.importSnapshot.warnings.length > 0
            ? progress.importSnapshot.warnings[0]!
            : (progress.importSnapshot?.destinationPath ?? ""),
        percent: 100,
        keepOpen: false,
        retryLabel: null,
      };
    case "failed":
      return {
        kind: "failed",
        title: title
          ? `Couldn't ${words.word} ${title} ${onTarget}`
          : `Couldn't ${words.word} ${onTarget}`,
        description: progress.error?.message ?? `The ${words.word} failed.`,
        percent: null,
        keepOpen: false,
        retryLabel:
          progress.error?.retry === "send-files"
            ? "Send files instead"
            : progress.error?.retry === "resume"
              ? "Resume"
              : null,
      };
    case "cancelled":
      return {
        kind: "cancelled",
        title: title
          ? `Stopped ${words.doing.toLowerCase()} ${title}`
          : `${capitalized(words.word)} stopped`,
        description: progress.canCloseClient
          ? `${target} cancelled the ${words.word}.`
          : "Nothing was left behind.",
        percent: null,
        keepOpen: false,
        retryLabel: null,
      };
    default:
      return {
        kind: "progress",
        title: title ? `${words.doing} ${title} ${onTarget}` : `${words.doing} ${onTarget}`,
        description: progressLine(progress, labels),
        percent: projectCopyPercent(progress),
        keepOpen: !progress.canCloseClient,
        retryLabel: null,
      };
  }
}
