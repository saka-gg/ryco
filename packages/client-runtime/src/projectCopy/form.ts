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

import type { NodeProjectCopySupport } from "../state/nodes/types.ts";
import type { Project } from "../state/threads/types.ts";
import type { CopyProgressContext } from "./dialog.ts";
import {
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
