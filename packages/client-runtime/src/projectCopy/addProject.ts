// FILE: addProject.ts
// Purpose: What adding a project from a clone or an existing checkout sends to
//          a node (`projects.importStart`), and how such an import's progress
//          reads. The web's add-project dialog and the phone's Add Project
//          sheet share these.
// Layer: Client runtime, pure.

import type { ProjectId } from "@ryco/contracts";
import {
  PROJECT_COPY_MAX_SCRIPTS,
  PROJECT_COPY_TITLE_MAX_CHARS,
  PROJECT_IMPORT_UNINSPECTED_CLONE_STEPS,
  ProjectImportStartInput,
  type ProjectImportId,
  type ProjectImportSnapshot,
} from "@ryco/contracts/project-copy";
import { classifyRemoteUrl, repositoryFolderName } from "@ryco/shared/gitRemoteUrl";
import { inferProjectTitleFromPath } from "@ryco/shared/projectPaths";
import * as Schema from "effect/Schema";

import { deriveRepositoryRelativeProjectPath } from "../state/workspace/index.ts";
import type { Project } from "../state/threads/types.ts";
import type { CopyProgressStep } from "./dialog.ts";
import { lastOutputLine, projectImportStepLabel } from "./progressView.ts";

/** Typed clone input that is a URL (https, ssh, scp-style, file) rather than "owner/repo". */
export function isGitRemoteUrlInput(input: string): boolean {
  const kind = classifyRemoteUrl(input.trim());
  return kind !== "local" && kind !== "other";
}

/** The folder a clone gets: the repository's name, else the slug of what was typed. */
export function cloneFolderName(remoteUrl: string, repositoryInput: string): string | null {
  return repositoryFolderName(remoteUrl) ?? repositoryFolderName(repositoryInput);
}

/* ───────── Imports ───────── */

/**
 * An import's steps as the progress list shows them (the copy dialog's list): skipped steps
 * left out, the running one with its own percent and last output line.
 */
export function importProgressSteps(snapshot: ProjectImportSnapshot): CopyProgressStep[] {
  const tail = lastOutputLine(snapshot.outputTail);
  const steps: CopyProgressStep[] = [];
  for (const step of snapshot.steps) {
    if (step.status === "skipped") continue;
    const running = step.status === "running";
    steps.push({
      id: step.id,
      label: [{ text: projectImportStepLabel(step.id) }],
      status: step.status,
      percent: running ? step.progressPercent : null,
      log: running ? (step.detail ?? tail) : null,
      weight: 1,
    });
  }
  return steps;
}

/** How much of the import ran: finished steps plus the running step's share. */
export function importOverallPercent(snapshot: ProjectImportSnapshot): number {
  if (snapshot.status === "completed") return 100;
  const counted = snapshot.steps.filter((step) => step.status !== "skipped");
  if (counted.length === 0) return 0;
  let finished = 0;
  for (const step of counted) {
    if (step.status === "done" || step.status === "failed") finished += 1;
    else if (step.status === "running") finished += (step.progressPercent ?? 0) / 100;
  }
  return Math.max(0, Math.min(100, Math.round((finished / counted.length) * 100)));
}

const isValidImportStartInput = Schema.is(ProjectImportStartInput);

function importTitle(title: string): string {
  return title.trim().slice(0, PROJECT_COPY_TITLE_MAX_CHARS);
}

const USER_ORIGIN = { kind: "user", sourceLabel: null, proposalId: null } as const;

/**
 * The import that clones `remoteUrl` into `destinationPath` and adds it as a
 * project, without settings, setup or a follow-up thread (what adding a cloned
 * repository did before). Null when the node would refuse it (a relative path, a
 * URL with a password).
 */
export function buildCloneImportInput(input: {
  readonly importId: ProjectImportId;
  readonly projectId: ProjectId;
  readonly destinationPath: string;
  readonly remoteUrl: string;
}): ProjectImportStartInput | null {
  const candidate = {
    importId: input.importId,
    projectId: input.projectId,
    title: importTitle(inferProjectTitleFromPath(input.destinationPath)),
    destinationPath: input.destinationPath,
    source: { kind: "clone", remoteUrl: input.remoteUrl.trim(), remoteName: "origin" },
    remotes: [],
    commits: null,
    checkout: null,
    changes: null,
    relativeRootInRepository: "",
    ...PROJECT_IMPORT_UNINSPECTED_CLONE_STEPS,
    settings: null,
    avatarTransferId: null,
    setup: null,
    followUpThread: null,
    origin: USER_ORIGIN,
  };
  return isValidImportStartInput(candidate) ? candidate : null;
}

/**
 * The import that registers the checkout at `destinationPath` as `source`'s
 * project there (A27): its repository key must match, the folder is never
 * touched, and the project keeps the source's title, folder inside the
 * repository and, when they pass the node's rules, its settings.
 */
export function buildLinkImportInput(input: {
  readonly importId: ProjectImportId;
  readonly projectId: ProjectId;
  readonly destinationPath: string;
  readonly source: Pick<
    Project,
    | "name"
    | "cwd"
    | "repositoryIdentity"
    | "scripts"
    | "customSystemPrompt"
    | "preferredRemoteName"
    | "projectMetadataDir"
  >;
}): ProjectImportStartInput | null {
  const { source } = input;
  const base = {
    importId: input.importId,
    projectId: input.projectId,
    title:
      importTitle(source.name) || importTitle(inferProjectTitleFromPath(input.destinationPath)),
    destinationPath: input.destinationPath,
    source: {
      kind: "existing-checkout",
      expectedCanonicalKey: source.repositoryIdentity?.canonicalKey ?? null,
    },
    remotes: [],
    commits: null,
    checkout: null,
    changes: null,
    relativeRootInRepository: deriveRepositoryRelativeProjectPath(source) ?? "",
    recurseSubmodules: false,
    usesLfs: false,
    avatarTransferId: null,
    setup: null,
    followUpThread: null,
    origin: USER_ORIGIN,
  };
  const withSettings = {
    ...base,
    settings: {
      scripts: source.scripts.slice(0, PROJECT_COPY_MAX_SCRIPTS),
      customSystemPrompt: source.customSystemPrompt ?? null,
      preferredRemoteName: source.preferredRemoteName ?? null,
      projectMetadataDir: source.projectMetadataDir ?? ".ryco",
      // The project record carries no overrides: the linked project keeps this node's settings.
      overrides: {},
    },
  };
  if (isValidImportStartInput(withSettings)) return withSettings;
  const withoutSettings = { ...base, settings: null };
  return isValidImportStartInput(withoutSettings) ? withoutSettings : null;
}
