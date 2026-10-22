/**
 * The pure parts of the import job: its input digest, the snapshot transitions subscribers see,
 * the bounded and credential-redacted output tail, the staging directory's name, and the
 * deterministic ids every orchestration command of a job derives from its `importId`.
 *
 * @module projectImportSnapshot
 */
import path from "node:path";

import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import {
  PROJECT_IMPORT_OUTPUT_TAIL_MAX_BYTES,
  ProjectImportStartInput,
  ProjectImportStepId,
  type ProjectImportError,
  type ProjectImportId,
  type ProjectImportSnapshot,
  type ProjectImportStatus,
  type ProjectImportStep,
} from "@ryco/contracts/project-copy";
import { redactGitCredentials } from "@ryco/shared/gitRemoteUrl";
import { Schema } from "effect";

import { canonicalJson, sha256Hex } from "../canonicalJson.ts";

/** Every step of a job, in the order it runs. */
export const PROJECT_IMPORT_STEP_IDS: ReadonlyArray<ProjectImportStepId> =
  ProjectImportStepId.literals;

/** The steps after `register` that are idempotent, so startup recovery replays them. */
export type ProjectImportReplayedStepId = Extract<ProjectImportStepId, "settings" | "avatar">;

export const PROJECT_IMPORT_REPLAYED_STEPS: ReadonlyArray<ProjectImportReplayedStepId> = [
  "settings",
  "avatar",
];

const REPLAYED_STEP_LOSS: Record<ProjectImportReplayedStepId, string> = {
  settings: "The project's scripts and preferred remote were not copied",
  avatar: "The project's avatar was not copied",
};

/** The warning a replayed step leaves when it fails: what was not copied, and why. */
export const replayedImportStepWarning = (
  id: ProjectImportReplayedStepId,
  reason: string,
): string => `${REPLAYED_STEP_LOSS[id]}: ${reason}`;

/** Bounds messages, details and warnings, like `ProjectCopyError.message`. */
export const PROJECT_IMPORT_MESSAGE_MAX_CHARS = 2_000;
/** Lines of output the snapshot keeps; each is at most 240 characters, so about 10 KiB. */
export const PROJECT_IMPORT_OUTPUT_TAIL_LINES = 40;

const encodeInput = Schema.encodeSync(ProjectImportStartInput);

/**
 * sha-256 over the canonical wire form of a start input: the same importId with an input of
 * another digest is a different request (`conflict`), never a retry.
 */
export const projectImportInputDigest = (input: ProjectImportStartInput): string =>
  sha256Hex(`project-import-v1:${canonicalJson(encodeInput(input))}`);

/** Redacted, trimmed and at most `maxChars` (the start kept); `fallback` when nothing is left. */
export const boundImportText = (
  text: string,
  fallback: string,
  maxChars: number = PROJECT_IMPORT_MESSAGE_MAX_CHARS,
): string => {
  const redacted = redactGitCredentials(text).trim();
  if (redacted.length === 0) return fallback;
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars - 1).trimEnd()}…` : redacted;
};

const utf8 = new TextEncoder();

/**
 * The visible output lines as the snapshot's `outputTail`: redacted, and at most
 * `PROJECT_IMPORT_OUTPUT_TAIL_MAX_BYTES` of UTF-8, keeping the newest lines.
 */
export const renderImportOutputTail = (lines: ReadonlyArray<string>): string => {
  const kept: Array<string> = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = redactGitCredentials(lines[index]!);
    const size = utf8.encode(line).length + (kept.length > 0 ? 1 : 0);
    if (bytes + size > PROJECT_IMPORT_OUTPUT_TAIL_MAX_BYTES) break;
    kept.unshift(line);
    bytes += size;
  }
  return kept.join("\n");
};

export const isTerminalImportStatus = (status: ProjectImportStatus): boolean =>
  status !== "running";

export const initialProjectImportSnapshot = (
  input: ProjectImportStartInput,
  now: string,
): ProjectImportSnapshot => ({
  importId: input.importId,
  projectId: input.projectId,
  title: input.title,
  destinationPath: input.destinationPath,
  status: "running",
  steps: PROJECT_IMPORT_STEP_IDS.map((id) => ({
    id,
    status: "pending",
    progressPercent: null,
    detail: null,
  })),
  outputTail: "",
  error: null,
  warnings: [],
  preflight: null,
  leftoverPath: null,
  followUpThreadId: null,
  origin: input.origin,
  createdAt: now,
  updatedAt: now,
});

export type ProjectImportStepPatch = Partial<Omit<ProjectImportStep, "id">>;

export const importStepOf = (
  snapshot: ProjectImportSnapshot,
  id: ProjectImportStepId,
): ProjectImportStep | undefined => snapshot.steps.find((step) => step.id === id);

export const withImportStep = (
  snapshot: ProjectImportSnapshot,
  id: ProjectImportStepId,
  patch: ProjectImportStepPatch,
  now: string,
): ProjectImportSnapshot => ({
  ...snapshot,
  steps: snapshot.steps.map((step) =>
    step.id === id
      ? {
          ...step,
          ...patch,
          ...(typeof patch.detail === "string"
            ? { detail: boundImportText(patch.detail, patch.detail) }
            : {}),
        }
      : step,
  ),
  updatedAt: now,
});

export const withImportWarning = (
  snapshot: ProjectImportSnapshot,
  warning: string,
  now: string,
): ProjectImportSnapshot => {
  const bounded = boundImportText(warning, "Warning");
  return snapshot.warnings.includes(bounded)
    ? snapshot
    : { ...snapshot, warnings: [...snapshot.warnings, bounded], updatedAt: now };
};

/** The step that is running, else the first one still pending: where a failure belongs. */
export const currentImportStep = (snapshot: ProjectImportSnapshot): ProjectImportStepId =>
  (
    snapshot.steps.find((step) => step.status === "running") ??
    snapshot.steps.find((step) => step.status === "pending") ??
    snapshot.steps.at(-1)!
  ).id;

/**
 * The replayed steps a registered job still owes: the pending ones. A step a crash or a stop cut
 * short went back to pending when its job was marked interrupted (`keepPending`), and so does a
 * replay a stop cut short. Each is idempotent by command id, so it runs again from the start.
 * One still running in an interrupted job is not owed: see `failCutShortReplays`.
 */
export const dueReplayedImportSteps = (
  snapshot: ProjectImportSnapshot,
): ReadonlyArray<ProjectImportReplayedStepId> =>
  PROJECT_IMPORT_REPLAYED_STEPS.filter((id) => importStepOf(snapshot, id)?.status === "pending");

const CUT_SHORT_REPLAY = "Ryco stopped while it retried this step after a restart.";

/**
 * Fails, with a warning, each replayed step still running in an interrupted job. Settling a job
 * puts its running replayed steps back to pending, so such a step was cut short by a crash
 * during its own replay. That replay may be what crashed the node (a native crash or an out of
 * memory on the avatar's bytes, say): replaying it again could crash every later start, so a
 * step runs at most twice, once in the job and once in a replay.
 */
export const failCutShortReplays = (
  snapshot: ProjectImportSnapshot,
  now: string,
): ProjectImportSnapshot => {
  if (snapshot.status !== "interrupted") return snapshot;
  let next = snapshot;
  for (const id of PROJECT_IMPORT_REPLAYED_STEPS) {
    if (importStepOf(next, id)?.status !== "running") continue;
    next = withImportStep(
      next,
      id,
      { status: "failed", progressPercent: null, detail: CUT_SHORT_REPLAY },
      now,
    );
    next = withImportWarning(next, replayedImportStepWarning(id, CUT_SHORT_REPLAY), now);
  }
  return next;
};

/**
 * Ends a job: a failure fails the step that was running, a cancel or an interruption skips it,
 * and every step still pending is skipped. `keepPending` (the post-register steps startup
 * recovery replays) stay pending, and go back to pending when they were running.
 */
export const settleImportSnapshot = (
  snapshot: ProjectImportSnapshot,
  outcome: {
    readonly status: Exclude<ProjectImportStatus, "running">;
    readonly error: ProjectImportError | null;
    readonly leftoverPath: string | null;
    readonly keepPending?: ReadonlyArray<ProjectImportStepId> | undefined;
  },
  now: string,
): ProjectImportSnapshot => {
  const stopped =
    outcome.status === "cancelled"
      ? "Cancelled"
      : outcome.status === "interrupted"
        ? "Interrupted by a restart"
        : null;
  return {
    ...snapshot,
    status: outcome.status,
    error:
      outcome.error === null
        ? null
        : {
            ...outcome.error,
            message: boundImportText(outcome.error.message, "The import failed."),
          },
    leftoverPath: outcome.leftoverPath,
    steps: snapshot.steps.map((step) => {
      const kept = (outcome.keepPending ?? []).includes(step.id);
      if (step.status === "running") {
        if (kept)
          return { ...step, status: "pending" as const, progressPercent: null, detail: null };
        return stopped === null
          ? { ...step, status: "failed" as const, progressPercent: null }
          : { ...step, status: "skipped" as const, progressPercent: null, detail: stopped };
      }
      if (step.status === "pending" && !kept) {
        return { ...step, status: "skipped" as const };
      }
      return step;
    }),
    updatedAt: now,
  };
};

// ── Deterministic ids ─────────────────────────────────────────────────

/** Each orchestration command of a job; a replay after a restart is answered by its receipt. */
export const projectImportCommandId = (importId: ProjectImportId, step: string): CommandId =>
  CommandId.make(`project-import:${importId}:${step}`);

export const projectImportThreadId = (importId: ProjectImportId): ThreadId =>
  ThreadId.make(`thread-project-import-${importId}`);

export const projectImportMessageId = (importId: ProjectImportId): MessageId =>
  MessageId.make(`project-import:${importId}:follow-up`);

export const projectImportWorktreeId = (importId: ProjectImportId): WorktreeId =>
  WorktreeId.make(`worktree-project-import-${importId}`);

// ── Staging ───────────────────────────────────────────────────────────

const STAGING_SUFFIX = ".ryco-import-";

/**
 * The job's staging directory, a hidden sibling of the destination:
 * `<parent>/.<name>.ryco-import-<importId>`. The job clones into it and publishes it by rename.
 */
export const projectImportStagingPath = (
  destinationPath: string,
  importId: ProjectImportId,
): string =>
  path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}${STAGING_SUFFIX}${importId}`,
  );

/** Where a staging directory publishes to; null for a path that is not one of this job's. */
export const projectImportPublishedPath = (
  stagingPath: string,
  importId: ProjectImportId,
): string | null => {
  const name = path.basename(stagingPath);
  const suffix = `${STAGING_SUFFIX}${importId}`;
  if (!name.startsWith(".") || !name.endsWith(suffix) || name.length <= suffix.length + 1) {
    return null;
  }
  return path.join(path.dirname(stagingPath), name.slice(1, -suffix.length));
};

// ── Follow-up prompt ──────────────────────────────────────────────────

export interface ProjectImportSetupFailure {
  readonly command: string;
  readonly outcome: string;
  readonly exitCode: number | null;
  readonly outputTail: string;
}

/** The follow-up thread's first message: the prompt, plus the setup's result when it failed. */
export const projectImportFollowUpPrompt = (
  prompt: string,
  setupFailure: ProjectImportSetupFailure | null,
): string => {
  if (setupFailure === null) return prompt;
  const status =
    setupFailure.exitCode === null
      ? `ended without an exit code (${setupFailure.outcome})`
      : `exited with code ${setupFailure.exitCode}`;
  const note = [
    "",
    "",
    `Note: the setup command \`${setupFailure.command}\` ${status} when this project was copied here.`,
    ...(setupFailure.outputTail.trim().length > 0
      ? ["Its last output:", "```", redactGitCredentials(setupFailure.outputTail), "```"]
      : []),
  ].join("\n");
  const room = PROVIDER_SEND_TURN_MAX_INPUT_CHARS - prompt.length;
  return room <= 0 ? prompt : `${prompt}${note.slice(0, room)}`;
};
