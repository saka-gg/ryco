// FILE: form.ts
// Purpose: What a copy form decides from what it read: the coordinator's options
//          for the user's choices, a source that predates project copy as the
//          coordinator sees it, and why the copy can't start yet. The web's copy
//          dialog and the phone's copy screen read their nodes differently and
//          share these.
// Layer: Client runtime, pure.

import { DEFAULT_PROJECT_METADATA_DIR } from "@ryco/contracts/orchestration";
import type { NodePathHints, ProjectExportInspection } from "@ryco/contracts/project-copy";
import { inferHomeDirectory } from "@ryco/shared/projectPaths";

import type { EnvironmentId, ScopedProjectRef } from "@ryco/contracts";

import type { NodeProjectCopySupport } from "../state/nodes/types.ts";
import type { Project } from "../state/threads/types.ts";
import type { CopyProgressContext, CopyTargetCard } from "./dialog.ts";
import type { ProjectCopyJobRecord } from "./jobRecord.ts";
import {
  joinNodePath,
  planProjectCopyOptions,
  type CopyDestinationSuggestion,
  type ProjectCopyChoices,
  type ProjectCopyLegacyProject,
  type ProjectCopyOptionsPlan,
  type ProjectCopyRunPlan,
  type ProjectCopySourceFacts,
  type ProjectCopyTargetFacts,
} from "./plan.ts";

/** What the user changed; unset fields follow the coordinator's defaults. */
export interface CopyUserChoices {
  readonly mode: ProjectCopyChoices["mode"] | null;
  readonly bringCommits: boolean | null;
  readonly bringChanges: boolean | null;
  readonly ignoredPaths: ReadonlyArray<string>;
  readonly copySettings: boolean | null;
}

export const DEFAULT_COPY_USER_CHOICES: CopyUserChoices = {
  mode: null,
  bringCommits: null,
  bringChanges: null,
  ignoredPaths: [],
  copySettings: null,
};

/**
 * The coordinator's options for the facts and the user's choices. Linking an
 * existing checkout of the same repository wins over a copy (A27); sending the
 * files brings the uncommitted changes with them, as the mockup shows.
 */
export function planCopyOptions(
  source: ProjectCopySourceFacts,
  target: ProjectCopyTargetFacts,
  choices: CopyUserChoices,
): ProjectCopyOptionsPlan {
  const requested = (
    mode: ProjectCopyChoices["mode"] | undefined,
  ): Partial<ProjectCopyChoices> => ({
    ...(mode ? { mode } : {}),
    bringCommits: choices.bringCommits ?? true,
    bringChanges: mode === "send-files" ? true : (choices.bringChanges ?? true),
    ignoredPaths: choices.ignoredPaths,
    copySettings: choices.copySettings ?? true,
    copyAvatar: choices.copySettings ?? true,
  });
  const linking = target.destination?.status === "link";
  const first = planProjectCopyOptions(
    { source, target },
    requested(linking ? "link" : (choices.mode ?? undefined)),
  );
  if (first.choices.mode === "send-files" && !first.choices.bringChanges) {
    return planProjectCopyOptions({ source, target }, requested("send-files"));
  }
  return first;
}

/** A source without project copy, from what the client knows of the project (A23). */
export function legacyCopyProject(project: Project): ProjectCopyLegacyProject {
  return {
    title: project.name,
    workspaceRoot: project.cwd,
    repositoryIdentity: project.repositoryIdentity ?? null,
    scripts: project.scripts,
    customSystemPrompt: project.customSystemPrompt ?? null,
    preferredRemoteName: project.preferredRemoteName ?? null,
    projectMetadataDir: project.projectMetadataDir ?? DEFAULT_PROJECT_METADATA_DIR,
    hasCustomAvatar: (project.customAvatarContentHash ?? null) !== null,
  };
}

/** Where a legacy source lives: its home inferred from the usual layouts, its separator from the path. */
export function legacySourceHints(
  project: Pick<Project, "cwd">,
): Pick<NodePathHints, "homeDirectory" | "pathSeparator"> | null {
  const separator = project.cwd.includes("\\") || /^[A-Za-z]:/u.test(project.cwd) ? "\\" : "/";
  const home = inferHomeDirectory(project.cwd);
  return home === null ? null : { homeDirectory: home, pathSeparator: separator };
}

/** A destination the copy can go to: suggested or picked, and not refused there. */
export function copyDestinationUsable(suggestion: CopyDestinationSuggestion | null): boolean {
  return (
    suggestion !== null &&
    suggestion.status !== "blocked" &&
    suggestion.status !== "existing-project"
  );
}

/**
 * The stopped copy a start goes on with: only the same checkout to the same
 * node, into the same folder. A record from before copies kept their folder
 * matches on its checkout and node alone. Anything else is not this copy: a
 * form pinned to it ({@link copyResumePin}) refuses to start rather than
 * discarding what already reached its node.
 */
export function resumableCopyRecord(
  record: ProjectCopyJobRecord | null,
  start: {
    readonly sourceRef: ScopedProjectRef | null;
    readonly targetEnvironmentId: EnvironmentId | null;
    readonly destinationPath: string | null;
  },
): ProjectCopyJobRecord | null {
  if (record === null || start.sourceRef === null) return null;
  return record.targetEnvironmentId === start.targetEnvironmentId &&
    record.sourceEnvironmentId === start.sourceRef.environmentId &&
    record.sourceProjectId === start.sourceRef.projectId &&
    (record.destinationPath === undefined || record.destinationPath === start.destinationPath)
    ? record
    : null;
}

/** A copy form opened on a stopped copy: it goes on only where it was going. */
export interface CopyResumePin {
  readonly record: ProjectCopyJobRecord;
  /** The only node the form offers. */
  readonly targetEnvironmentId: EnvironmentId;
  /** The folder it goes on into; null for a record from before copies kept it. */
  readonly destinationPath: string | null;
  /** Why it can't go on yet (its node is offline or not reachable here); null when it can. */
  readonly waitingReason: string | null;
}

/**
 * Pins a copy form to its stopped copy: its node, whether or not that node can
 * take it right now (the form waits for it rather than offering another), and
 * its folder. Starting over somewhere else takes discarding the stopped copy
 * first, which the form offers explicitly.
 */
export function copyResumePin(input: {
  readonly record: ProjectCopyJobRecord | null;
  readonly cards: ReadonlyArray<CopyTargetCard>;
  readonly targetLabel: string;
}): CopyResumePin | null {
  const { record } = input;
  if (record === null) return null;
  const card = input.cards.find((entry) => entry.node.environmentId === record.targetEnvironmentId);
  const waitingReason = card?.selectable
    ? null
    : `Waiting for ${input.targetLabel}${card?.reason ? ` (${card.reason})` : ""}. The copy goes on there once it is back, or discard it to start over.`;
  return {
    record,
    targetEnvironmentId: record.targetEnvironmentId,
    destinationPath: record.destinationPath ?? null,
    waitingReason,
  };
}

/** Why a start that should resume `pin` does not match it; null when it does (or nothing is pinned). */
export function copyResumeMismatch(
  pin: CopyResumePin | null,
  resume: ProjectCopyJobRecord | null,
): string | null {
  return pin !== null && resume === null
    ? "This is no longer the copy that stopped. Discard it to start a new one."
    : null;
}

/**
 * The exact folder a form previews on the destination: a stopped copy's own,
 * else the picked parent plus the source's folder name; null lets the node
 * suggest one.
 */
export function copyExplicitDestinationPath(input: {
  readonly exactPath: string | null;
  readonly manualParent: string | null;
  readonly leaf: string | null;
  readonly pathSeparator: "/" | "\\";
}): string | null {
  if (input.exactPath !== null) return input.exactPath;
  return input.manualParent !== null && input.leaf !== null
    ? joinNodePath(input.manualParent, [input.leaf], input.pathSeparator)
    : null;
}

/** The note a form shows over a stopped copy it was opened to resume. */
export function copyResumeNotice(targetLabel: string): string {
  return `This copy stopped when Ryco closed during the upload. Start it again to send the rest; what already reached ${targetLabel} is not sent again.`;
}

export interface CopyFormReadinessInput {
  /** The project's name, for "Every checkout of … is offline." */
  readonly title: string;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  /** A checkout of the project is reachable to copy from. */
  readonly hasSource: boolean;
  /** Reading the source failed (connecting, inspecting). */
  readonly sourceError: string | null;
  /** The source was read: its facts are known. */
  readonly sourceChecked: boolean;
  /** Holding the destination failed. */
  readonly targetHoldError: string | null;
  readonly targetSupport: NodeProjectCopySupport;
  readonly options: ProjectCopyOptionsPlan | null;
  readonly destination: CopyDestinationSuggestion | null;
  readonly destinationError: string | null;
  /** The copy needs more connections than this client may hold. */
  readonly capReason: string | null;
  readonly setupInvalid: boolean;
  /** Why the setup agent can't start as filled in; null when it can (or is off). */
  readonly followUpProblem: string | null;
}

/** Why the copy can't start yet, in the words the form shows; null when it can. */
export function copyFormBlockedReason(input: CopyFormReadinessInput): string | null {
  if (!input.hasSource) return `Every checkout of ${input.title} is offline.`;
  return (
    input.sourceError ??
    input.targetHoldError ??
    (input.sourceChecked ? null : `Checking ${input.sourceLabel}…`) ??
    input.options?.blockedReason ??
    input.destinationError ??
    (input.destination === null && input.targetSupport === "yes"
      ? `Checking ${input.targetLabel}…`
      : null) ??
    input.capReason ??
    (input.setupInvalid ? "Enter the setup command, or turn setup off." : null) ??
    input.followUpProblem
  );
}

/** What a started copy's progress list needs to word its steps, from the plan the form built. */
export function copyProgressContextOf(input: {
  readonly plan: ProjectCopyRunPlan;
  readonly options: ProjectCopyOptionsPlan;
  /** The source's inspection; null for a source that predates project copy. */
  readonly inspection: ProjectExportInspection | null;
  readonly targetLabel: string;
  readonly targetHome: string | null;
}): CopyProgressContext {
  const { plan, options, inspection } = input;
  const plainFolder = inspection !== null && !inspection.repository.isGitRepository;
  return {
    sourceLabel: plan.source.kind === "export" ? plan.source.label : null,
    targetLabel: input.targetLabel,
    mode: plan.choices.mode,
    remoteUrl: plan.choices.mode === "clone" ? options.modes.clone.remoteUrl : null,
    branch: inspection && !inspection.repository.isDetached ? inspection.repository.branch : null,
    destinationPath: plan.destinationPath,
    targetHome: input.targetHome,
    changeCount: inspection
      ? inspection.workingTree.trackedChangeCount + inspection.workingTree.untrackedCount
      : 0,
    setupCommand: plan.setup?.command ?? null,
    uploads: plan.source.kind === "export" && options.plannedBytes > 0,
    bringsCommits: plan.choices.mode === "clone" && plan.choices.bringCommits,
    bringsChanges: plan.choices.mode !== "link" && plan.choices.bringChanges,
    copiesSettings: plan.choices.copySettings,
    followUp: plan.followUpThread !== null,
    ...(plainFolder ? { plainFolder: true } : {}),
  };
}
