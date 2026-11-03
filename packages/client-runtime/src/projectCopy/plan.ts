/**
 * Planning a cross-node copy, pure: where the copy goes on the target (A35), which options the
 * copy dialog and the Agent Control executor may offer (A7, A8, A12, A18, A19, A23, A27), the
 * run plan the coordinator executes, and the `projects.importStart` input it sends.
 *
 * Nothing here calls a node. Inputs that need a round trip (destination previews, the source's
 * export inspection, the target's remote check) arrive as data; `resolveCopyDestination` takes
 * its preview call as a parameter.
 *
 * @module projectCopy/plan
 */
import type {
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ModelSelection,
  ProjectId,
  ProjectScript,
  RepositoryIdentity,
  RuntimeMode,
  ServerConfig,
  ThreadEnvMode,
} from "@ryco/contracts";
import { DEFAULT_MODEL_BY_PROVIDER } from "@ryco/contracts/model";
import { DEFAULT_RUNTIME_MODE } from "@ryco/contracts/orchestration";
import {
  GitBranchName,
  GitObjectId,
  GitRemoteName,
  PROJECT_COPY_MAX_ARTIFACT_BYTES,
  PROJECT_COPY_MAX_IGNORED_PATHS,
  PROJECT_COPY_MAX_REMOTES,
  PROJECT_COPY_MAX_SCRIPTS,
  PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES,
  PROJECT_COPY_THREAD_TITLE_MAX_CHARS,
  PROJECT_COPY_TITLE_MAX_CHARS,
  PROJECT_IMPORT_UNINSPECTED_CLONE_STEPS,
  ProjectCopyRelativePath,
  ProjectCopyRelativeRoot,
  ProjectCopyRemoteUrl,
  ProjectImportStartInput,
  type NodePathHints,
  type ProjectCheckRemoteAccessResult,
  type ProjectCopyRemote,
  type ProjectDestinationPreview,
  type ProjectDestinationPreviewInput,
  type ProjectExportArtifactKind,
  type ProjectExportIgnoredCandidate,
  type ProjectExportInclude,
  type ProjectExportInspection,
  type ProjectExportResult,
  type ProjectImportFollowUpThread,
  type ProjectImportId,
  type ProjectImportOrigin,
  type ProjectImportSettings,
  type ProjectImportSetup,
  type ProjectImportSource,
  type ProjectTransferId,
} from "@ryco/contracts/project-copy";
import { normalizeGitRemoteUrl } from "@ryco/shared/git";
import {
  classifyRemoteUrl,
  isCloneableRemoteKind,
  isRecreatableRemoteKind,
  pickCloneRemoteName,
  sanitizeRemoteUrl,
} from "@ryco/shared/gitRemoteUrl";
import { createModelSelection } from "@ryco/shared/model";
import * as Schema from "effect/Schema";

import {
  deriveProviderInstanceEntries,
  isSetupProviderInstance,
  sortProviderInstanceEntries,
} from "../state/composer/providerInstances.ts";
import type { ProjectCopyTransport } from "./io.ts";

// ── Node paths ────────────────────────────────────────────────────────

export type NodePathSeparator = NodePathHints["pathSeparator"];

interface NodePathParts {
  /** `/`, `C:\`, `\\server\share\` or `\`; empty for a relative path. */
  readonly root: string;
  readonly segments: ReadonlyArray<string>;
}

/** Splits a path of a node with the given separator; Windows nodes accept `/` too. */
function splitNodePath(path: string, separator: NodePathSeparator): NodePathParts {
  const windows = separator === "\\";
  const value = windows ? path.trim().replaceAll("/", "\\") : path.trim();
  let root = "";
  let rest = value;
  if (windows) {
    const drive = /^[A-Za-z]:(?:\\|$)/.exec(value);
    if (drive) {
      root = `${value.slice(0, 2).toUpperCase()}\\`;
      rest = value.slice(drive[0].length);
    } else if (value.startsWith("\\\\")) {
      const [server = "", share = "", ...remaining] = value.slice(2).split("\\");
      root = `\\\\${server}\\${share}\\`;
      rest = remaining.join("\\");
    } else if (value.startsWith("\\")) {
      root = "\\";
      rest = value.slice(1);
    }
  } else if (value.startsWith("/")) {
    root = "/";
    rest = value.slice(1);
  }
  return {
    root,
    segments: rest.split(separator).filter((segment) => segment.length > 0 && segment !== "."),
  };
}

function formatNodePath(parts: NodePathParts, separator: NodePathSeparator): string {
  return `${parts.root}${parts.segments.join(separator)}` || ".";
}

/** `parent` joined with relative `segments`, in the node's own separator. */
export function joinNodePath(
  parent: string,
  segments: ReadonlyArray<string>,
  separator: NodePathSeparator,
): string {
  const base = splitNodePath(parent, separator);
  return formatNodePath({ root: base.root, segments: [...base.segments, ...segments] }, separator);
}

/** The last segment of a node path, or null for a root. */
export function nodePathBasename(path: string, separator: NodePathSeparator): string | null {
  return splitNodePath(path, separator).segments.at(-1) ?? null;
}

/**
 * The segments of `path` below `base`, or null when it is not inside it. Windows paths compare
 * case-insensitively.
 */
export function relativeNodePathSegments(
  path: string,
  base: string,
  separator: NodePathSeparator,
): ReadonlyArray<string> | null {
  const fold =
    separator === "\\" ? (value: string) => value.toLowerCase() : (value: string) => value;
  const target = splitNodePath(path, separator);
  const from = splitNodePath(base, separator);
  if (fold(target.root) !== fold(from.root) || target.segments.length < from.segments.length) {
    return null;
  }
  for (const [index, segment] of from.segments.entries()) {
    if (fold(segment) !== fold(target.segments[index] ?? "")) return null;
  }
  return target.segments.slice(from.segments.length);
}

// ── Destination (A35) ─────────────────────────────────────────────────

/**
 * `mirror` tries the source's place relative to its home first (A35); `default` goes straight
 * to the target's default project directory, as an agent's `{ kind: "default" }` and
 * `{ kind: "child-of-default" }` do.
 */
export type CopyDestinationPlacement = "mirror" | "default";

export interface CopyDestinationRequest {
  /** The source project's root on the source node; null for a repository source. */
  readonly sourceRoot: string | null;
  readonly sourceHints: Pick<NodePathHints, "homeDirectory" | "pathSeparator"> | null;
  readonly destHints: Pick<
    NodePathHints,
    "homeDirectory" | "pathSeparator" | "defaultProjectDirectory"
  >;
  /** The folder name when it is not the source root's own (a repository's or an agent's name). */
  readonly leafName?: string | null | undefined;
  readonly placement: CopyDestinationPlacement;
}

export interface CopyDestinationCandidate {
  /** The parent to preview first: the source's place under the target's home; null to skip. */
  readonly mirroredParent: string | null;
  readonly defaultParent: string;
  /** The destination folder's name; null when there is none (a source at a root). */
  readonly leaf: string | null;
}

/** Where a copy would go before any preview: the parents to try and the folder name. */
export function copyDestinationCandidate(
  request: CopyDestinationRequest,
): CopyDestinationCandidate {
  const { destHints, sourceHints, sourceRoot } = request;
  const leaf =
    request.leafName ??
    (sourceRoot !== null && sourceHints !== null
      ? nodePathBasename(sourceRoot, sourceHints.pathSeparator)
      : null);
  let mirroredParent: string | null = null;
  if (request.placement === "mirror" && sourceRoot !== null && sourceHints !== null) {
    const relative = relativeNodePathSegments(
      sourceRoot,
      sourceHints.homeDirectory,
      sourceHints.pathSeparator,
    );
    if (relative !== null && relative.length > 0) {
      mirroredParent = joinNodePath(
        destHints.homeDirectory,
        relative.slice(0, -1),
        destHints.pathSeparator,
      );
    }
  }
  return { mirroredParent, defaultParent: destHints.defaultProjectDirectory, leaf };
}

/**
 * The destination path to preview: the mirrored parent when the target has it (`exists-empty`
 * or `exists-not-empty`), otherwise the target's default project directory, plus the leaf.
 */
export function suggestCopyDestination(
  request: CopyDestinationRequest,
  mirroredParentPreview: ProjectDestinationPreview | null,
): {
  readonly path: string | null;
  readonly basis: "same-place" | "default-directory";
  /** The mirrored parent the target lacks ("<path> doesn't exist on D"). */
  readonly missingMirroredParent: string | null;
} {
  const candidate = copyDestinationCandidate(request);
  const separator = request.destHints.pathSeparator;
  const parentExists =
    mirroredParentPreview?.state === "exists-empty" ||
    mirroredParentPreview?.state === "exists-not-empty";
  // Only a missing parent is reported as missing; a refused one (`access-denied`, such as a
  // folder macOS guards, A34) is there, just not used.
  const parentMissing =
    mirroredParentPreview?.state === "available" || mirroredParentPreview?.state === "invalid";
  const useMirror = candidate.mirroredParent !== null && parentExists;
  const parent = useMirror
    ? (mirroredParentPreview?.resolvedPath ?? candidate.mirroredParent)
    : candidate.defaultParent;
  return {
    path:
      candidate.leaf === null || parent === null
        ? null
        : joinNodePath(parent, [candidate.leaf], separator),
    basis: useMirror ? "same-place" : "default-directory",
    missingMirroredParent:
      candidate.mirroredParent !== null && !useMirror && parentMissing
        ? candidate.mirroredParent
        : null,
  };
}

/**
 * - `available`: missing or an empty folder.
 * - `renamed`: taken; `path` is the target's first free sibling ("renamed, folder exists").
 * - `link`: a checkout of the same repository that is not a project yet (A27).
 * - `existing-project`: already a project of the same repository there.
 * - `blocked`: access denied, a retired checkout, or not a usable path.
 */
export type CopyDestinationStatus =
  | "available"
  | "renamed"
  | "link"
  | "existing-project"
  | "blocked";

export interface CopyDestinationSuggestion {
  /** Absolute on the target: the preview's resolved path, or the free sibling when renamed. */
  readonly path: string;
  readonly status: CopyDestinationStatus;
  readonly basis: "same-place" | "default-directory" | "explicit";
  readonly missingMirroredParent: string | null;
  /** When renamed, the path that was taken. */
  readonly takenPath: string | null;
  readonly existingProjectId: ProjectId | null;
  readonly detail: string | null;
  readonly preview: ProjectDestinationPreview;
}

/** Judges a previewed destination for a copy of the repository with `sourceCanonicalKey`. */
export function judgeCopyDestination(input: {
  readonly preview: ProjectDestinationPreview;
  readonly sourceCanonicalKey: string | null;
  readonly basis?: CopyDestinationSuggestion["basis"];
  readonly missingMirroredParent?: string | null;
}): CopyDestinationSuggestion {
  const { preview } = input;
  const base = {
    path: preview.resolvedPath,
    basis: input.basis ?? "explicit",
    missingMirroredParent: input.missingMirroredParent ?? null,
    takenPath: null,
    existingProjectId: preview.existingProjectId,
    detail: preview.detail,
    preview,
  } as const;
  switch (preview.state) {
    case "available":
    case "exists-empty":
      return { ...base, status: "available" };
    case "is-git-repository":
    case "exists-not-empty": {
      const sameRepository =
        preview.state === "is-git-repository" &&
        input.sourceCanonicalKey !== null &&
        preview.existingRepositoryCanonicalKey === input.sourceCanonicalKey;
      if (sameRepository) {
        return { ...base, status: preview.existingProjectId ? "existing-project" : "link" };
      }
      return preview.suggestedPath
        ? {
            ...base,
            status: "renamed",
            path: preview.suggestedPath,
            takenPath: preview.resolvedPath,
          }
        : { ...base, status: "blocked", detail: preview.detail ?? "The folder is not empty." };
    }
    case "retired-checkout":
    case "access-denied":
    case "invalid":
      return {
        ...base,
        status: "blocked",
        detail: preview.detail ?? "Ryco can't use this folder.",
      };
  }
}

/**
 * Previews the candidate parents and the destination through `preview`
 * (`projects.previewDestination` on the target) and judges the result. Null when there is no
 * folder name to use. Every preview is marked `suggested`: nobody chose these places, so the
 * target never opens a folder macOS guards for them (A34) and the mirror falls back to the
 * default directory instead.
 */
export async function resolveCopyDestination(
  request: CopyDestinationRequest,
  options: {
    readonly preview: (input: ProjectDestinationPreviewInput) => Promise<ProjectDestinationPreview>;
    readonly sourceCanonicalKey: string | null;
  },
): Promise<CopyDestinationSuggestion | null> {
  const candidate = copyDestinationCandidate(request);
  const preview = (path: string) => options.preview({ path, suggested: true });
  const parentPreview =
    candidate.mirroredParent === null ? null : await preview(candidate.mirroredParent);
  const suggestion = suggestCopyDestination(request, parentPreview);
  if (suggestion.path === null) return null;
  return judgeCopyDestination({
    preview: await preview(suggestion.path),
    sourceCanonicalKey: options.sourceCanonicalKey,
    basis: suggestion.basis,
    missingMirroredParent: suggestion.missingMirroredParent,
  });
}

// ── Sources and targets ───────────────────────────────────────────────

/** Whether a node implements project copy; `unknown` until a client connected to it (A23). */
export type ProjectCopySupport = "yes" | "no" | "unknown";

/** How the destination gets the repository. */
export type ProjectCopyMode = "clone" | "send-files" | "link";

/** A source project as the client already knows it, for a source without project copy (A23). */
export interface ProjectCopyLegacyProject {
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly customSystemPrompt: string | null;
  readonly preferredRemoteName: string | null;
  readonly projectMetadataDir: string;
  readonly hasCustomAvatar: boolean;
}

export type ProjectCopySourceFacts =
  /** A source that implements project copy, with its `projects.exportInspect` result. */
  | {
      readonly kind: "inspected";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly platformOs: ExecutionEnvironmentPlatformOs | null;
      readonly transport: ProjectCopyTransport | null;
      readonly checkoutPath: string | null;
      readonly inspection: ProjectExportInspection;
    }
  /** A source without project copy: a clone from origin is all it allows. */
  | {
      readonly kind: "legacy";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly platformOs: ExecutionEnvironmentPlatformOs | null;
      readonly projectId: ProjectId;
      readonly project: ProjectCopyLegacyProject;
    }
  /** A repository URL with no source node (an agent's repository source). */
  | { readonly kind: "repository"; readonly remoteUrl: string; readonly title: string };

export interface ProjectCopyTargetFacts {
  readonly label: string;
  readonly platformOs: ExecutionEnvironmentPlatformOs | null;
  readonly projectCopySupport: ProjectCopySupport;
  /** Null until the target was acquired. */
  readonly transport: ProjectCopyTransport | null;
  /** `projects.checkRemoteAccess` for the clone remote; null until checked. */
  readonly remoteAccess: ProjectCheckRemoteAccessResult | null;
  /** Null until a destination was chosen and previewed. */
  readonly destination: CopyDestinationSuggestion | null;
}

export interface ProjectCopyPlanningInput {
  readonly source: ProjectCopySourceFacts;
  readonly target: ProjectCopyTargetFacts;
}

/** The user's (or the agent's) choices; absent fields take the defaults. */
export interface ProjectCopyChoices {
  readonly mode: ProjectCopyMode;
  readonly bringCommits: boolean;
  readonly bringChanges: boolean;
  /** Opted-in ignored files (e.g. `.env`); they travel in the changes patch. */
  readonly ignoredPaths: ReadonlyArray<string>;
  readonly copySettings: boolean;
  readonly copyAvatar: boolean;
}

export interface ProjectCopyOptionState {
  readonly available: boolean;
  /** Why it is unavailable; null when it is available or simply does not apply. */
  readonly reason: string | null;
}

export interface ProjectCopyOptionsPlan {
  /** Set when Copy must stay disabled; every other field still describes the options. */
  readonly blockedReason: string | null;
  readonly modes: {
    readonly clone: ProjectCopyOptionState & {
      readonly remoteUrl: string | null;
      /** From `projects.checkRemoteAccess`; null until checked. */
      readonly reachable: boolean | null;
      readonly reachabilityDetail: string | null;
    };
    readonly sendFiles: ProjectCopyOptionState & { readonly estimatedBytes: number };
    readonly link: ProjectCopyOptionState;
  };
  /** What the dialog preselects; null when no mode is possible. */
  readonly defaultMode: ProjectCopyMode | null;
  /** In the effective mode. */
  readonly bringCommits: ProjectCopyOptionState & {
    readonly estimatedBytes: number;
    readonly unpushedCommitCount: number;
    /** Changes are included and HEAD is not on the remote, so commits must come too (A8). */
    readonly forced: boolean;
  };
  readonly bringChanges: ProjectCopyOptionState & { readonly estimatedBytes: number };
  readonly ignoredCandidates: ReadonlyArray<ProjectExportIgnoredCandidate>;
  readonly copySettings: ProjectCopyOptionState;
  readonly copyAvatar: ProjectCopyOptionState & { readonly estimatedBytes: number };
  /** The setup command to prefill (A18), and a note when the two nodes' OS differ. */
  readonly setup: { readonly command: string | null; readonly osNote: string | null };
  /** Either node is reached through the Hub, so the artifacts of one copy are capped (A7). */
  readonly relayed: boolean;
  /** The normalized choices: unavailable options off, forced ones on. */
  readonly choices: ProjectCopyChoices;
  /** Raw artifact bytes the choices would send (estimates). */
  readonly plannedBytes: number;
  readonly notes: ReadonlyArray<string>;
}

const MIB = 1024 * 1024;

export function formatCopyMegabytes(bytes: number): string {
  return `${Math.max(1, Math.ceil(bytes / MIB))} MB`;
}

export const relayTooLargeMessage = (bytes: number): string =>
  `Too large to send through the Hub (${formatCopyMegabytes(bytes)}). Push the branch, or connect both devices directly.`;

const directTooLargeMessage = (bytes: number): string =>
  `Too large to copy (${formatCopyMegabytes(bytes)}).`;

const updateRycoOn = (label: string, what: string): string => `Update Ryco on ${label} to ${what}.`;

const PLATFORM_LABELS: Record<ExecutionEnvironmentPlatformOs, string | null> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  unknown: null,
};

/** The setup to prefill: the source's worktree setup script (A18). */
export function projectCopySetupPrefill(input: {
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly sourceOs: ExecutionEnvironmentPlatformOs | null;
  readonly targetOs: ExecutionEnvironmentPlatformOs | null;
}): { readonly command: string | null; readonly osNote: string | null } {
  const command = input.scripts.find((script) => script.runOnWorktreeCreate)?.command ?? null;
  const source = input.sourceOs ? PLATFORM_LABELS[input.sourceOs] : null;
  const target = input.targetOs ? PLATFORM_LABELS[input.targetOs] : null;
  return {
    command,
    osNote:
      command !== null && source !== null && target !== null && source !== target
        ? `This setup was written on ${source}; it may need changes on ${target}.`
        : null,
  };
}

interface SourceRemote {
  readonly name: string;
  readonly url: string;
}

/** A legacy source's remotes as its identity lists them; older identities name only the locator. */
function legacyRemotesOf(project: ProjectCopyLegacyProject): ReadonlyArray<SourceRemote> {
  const identity = project.repositoryIdentity;
  if (identity === null) return [];
  const { locator } = identity;
  const remotes: ReadonlyArray<SourceRemote> = identity.remotes ?? [];
  return remotes.some((remote) => remote.name === locator.remoteName)
    ? remotes
    : [...remotes, { name: locator.remoteName, url: locator.remoteUrl }];
}

/**
 * The remote the copy clones from. An inspected source names it (its pushed state is measured
 * against it); for a legacy source the client applies the same rule, `pickCloneRemoteName`, to
 * the identity's remotes and the project's preferred remote.
 */
function cloneRemoteOf(source: ProjectCopySourceFacts): SourceRemote | null {
  switch (source.kind) {
    case "inspected": {
      const repository = source.inspection.repository;
      const remote = repository.remotes.find((entry) => entry.name === repository.cloneRemoteName);
      return remote ? { name: remote.name, url: remote.url } : null;
    }
    case "legacy": {
      const remotes = legacyRemotesOf(source.project);
      const name = pickCloneRemoteName({
        remoteNames: remotes.map((remote) => remote.name),
        preferredRemoteName: source.project.preferredRemoteName,
      });
      return remotes.find((remote) => remote.name === name) ?? null;
    }
    case "repository":
      return { name: "origin", url: source.remoteUrl };
  }
}

/** The canonical repository key a destination checkout must match to be linked (A27). */
export function projectCopySourceCanonicalKey(source: ProjectCopySourceFacts): string | null {
  switch (source.kind) {
    case "inspected":
      return source.inspection.repository.canonicalKey;
    case "legacy":
      return source.project.repositoryIdentity?.canonicalKey ?? null;
    case "repository":
      return normalizeGitRemoteUrl(source.remoteUrl);
  }
}

export function projectCopySourceTitle(source: ProjectCopySourceFacts): string {
  switch (source.kind) {
    case "inspected":
      return source.inspection.settings.title;
    case "legacy":
      return source.project.title;
    case "repository":
      return source.title;
  }
}

const sentenceCase = (reason: string): string =>
  reason.length === 0 ? reason : `${reason[0]?.toUpperCase() ?? ""}${reason.slice(1)}`;

/**
 * Which options a copy can offer, given the source, the target and what the user picked (A7,
 * A8, A12, A23, A27), and the normalized choices. Pure: call it again on every change.
 */
export function planProjectCopyOptions(
  input: ProjectCopyPlanningInput,
  requested: Partial<ProjectCopyChoices> = {},
): ProjectCopyOptionsPlan {
  const { source, target } = input;
  const title = projectCopySourceTitle(source);
  const inspected = source.kind === "inspected" ? source : null;
  const sourceLabel = source.kind === "repository" ? null : source.label;
  const relayed =
    target.transport === "relay" || (inspected !== null && inspected.transport === "relay");
  const sizeLimit = (bytes: number): string | null =>
    relayed && bytes > PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES
      ? relayTooLargeMessage(bytes)
      : bytes > PROJECT_COPY_MAX_ARTIFACT_BYTES
        ? directTooLargeMessage(bytes)
        : null;
  const estimate = (kind: ProjectExportArtifactKind) =>
    inspected?.inspection.estimates.find((entry) => entry.kind === kind) ?? null;
  const estimatedBytes = (kind: ProjectExportArtifactKind) => estimate(kind)?.estimatedBytes ?? 0;
  const notes: string[] = [];

  // ── Whole-copy blockers ──
  let blockedReason: string | null = null;
  if (target.projectCopySupport === "no") {
    blockedReason = updateRycoOn(target.label, "copy projects here");
  } else if (target.projectCopySupport === "unknown") {
    blockedReason = `Checking ${target.label}…`;
  } else if (inspected !== null && !inspected.inspection.repository.isGitRepository) {
    blockedReason = `${title} is not a git repository. Copying plain folders is not supported yet.`;
  }

  // ── Clone from origin ──
  const cloneRemote = cloneRemoteOf(source);
  const cloneKind = cloneRemote ? classifyRemoteUrl(cloneRemote.url) : null;
  const cloneUnavailableReason =
    cloneRemote === null || cloneKind === null
      ? `${title} has no remote.`
      : cloneKind === "http"
        ? "Plain http remotes are not cloned; send the files instead."
        : !isCloneableRemoteKind(cloneKind)
          ? "Its remote can only be reached from the source; send the files instead."
          : null;
  if (cloneRemote === null && source.kind !== "repository") {
    notes.push(`${title} has no remote, so the copy shows as a separate project.`);
  }
  const clone = {
    available: cloneUnavailableReason === null,
    reason: cloneUnavailableReason,
    remoteUrl: cloneRemote ? sanitizeRemoteUrl(cloneRemote.url) : null,
    reachable: target.remoteAccess?.reachable ?? null,
    reachabilityDetail:
      target.remoteAccess && !target.remoteAccess.reachable
        ? (target.remoteAccess.detail ?? `${target.label} can't reach the remote.`)
        : null,
  };

  // ── Send files (repository bundle) ──
  const bundleEstimate = estimate("repository-bundle");
  const sendFilesReason =
    inspected === null
      ? source.kind === "legacy"
        ? updateRycoOn(source.label, "send files")
        : "There are no files to send."
      : bundleEstimate === null
        ? "Sending files is not possible for this project."
        : bundleEstimate.skippedReason !== null
          ? sentenceCase(bundleEstimate.skippedReason)
          : sizeLimit(bundleEstimate.estimatedBytes);
  const sendFiles = {
    available: sendFilesReason === null,
    reason: sendFilesReason,
    estimatedBytes: bundleEstimate?.estimatedBytes ?? 0,
  };

  // ── Link an existing checkout (A27) ──
  const destination = target.destination;
  const link = {
    available: destination?.status === "link",
    reason: null,
  };
  if (destination?.status === "blocked") {
    blockedReason ??= destination.detail ?? "Ryco can't use this folder.";
  } else if (destination?.status === "existing-project") {
    blockedReason ??= `${title} is already on ${target.label} at ${destination.path}.`;
  }

  // ── Mode ──
  // A12: an unreachable remote (or one only the source can reach) preselects Send files.
  const defaultMode: ProjectCopyMode | null = link.available
    ? "link"
    : clone.available && (clone.reachable !== false || !sendFiles.available)
      ? "clone"
      : sendFiles.available
        ? "send-files"
        : null;
  const modeAvailable = (mode: ProjectCopyMode | undefined): mode is ProjectCopyMode =>
    mode === "clone"
      ? clone.available
      : mode === "send-files"
        ? sendFiles.available
        : mode === "link"
          ? link.available
          : false;
  const mode: ProjectCopyMode | null = modeAvailable(requested.mode) ? requested.mode : defaultMode;
  if (mode === null) {
    blockedReason ??= clone.reason ?? sendFiles.reason ?? `${title} can't be copied.`;
  }

  // ── Bring unpushed commits ──
  const repository = inspected?.inspection.repository ?? null;
  const pushedState = inspected?.inspection.pushedState ?? null;
  const commitsEstimate = estimate("commits-bundle");
  const unpushedCommitCount = pushedState?.unpushedCommitCount ?? 0;
  // Whether a commits bundle exists at all, whatever the mode.
  const commitsBaseReason =
    source.kind === "legacy"
      ? updateRycoOn(source.label, "bring unpushed commits")
      : inspected === null
        ? null
        : commitsEstimate?.skippedReason
          ? sentenceCase(commitsEstimate.skippedReason)
          : unpushedCommitCount === 0 || commitsEstimate === null
            ? "Nothing unpushed."
            : sizeLimit(commitsEstimate.estimatedBytes);
  const commitsModeReason =
    mode === "link"
      ? "Linking keeps the existing checkout as it is."
      : mode === "send-files"
        ? "Included in the files sent."
        : null;
  const commitsAvailable =
    inspected !== null && commitsBaseReason === null && commitsModeReason === null;

  // ── Bring uncommitted changes ──
  const changesEstimate = estimate("changes-patch");
  const workingTree = inspected?.inspection.workingTree ?? null;
  // A8: a clone lacks HEAD when it is not on the remote, so the changes need the commits too.
  const changesNeedCommits = mode === "clone" && pushedState !== null && !pushedState.headOnRemote;
  const changesBytes =
    estimatedBytes("changes-patch") + (changesNeedCommits ? estimatedBytes("commits-bundle") : 0);
  const changesReason =
    source.kind === "legacy"
      ? updateRycoOn(source.label, "bring uncommitted changes")
      : inspected === null
        ? null
        : mode === "link"
          ? "Linking keeps the existing checkout as it is."
          : repository?.headOid === null
            ? "The repository has no commits yet."
            : changesEstimate?.skippedReason
              ? sentenceCase(changesEstimate.skippedReason)
              : workingTree === null ||
                  workingTree.trackedChangeCount + workingTree.untrackedCount === 0 ||
                  changesEstimate === null
                ? "No uncommitted changes."
                : changesNeedCommits && !commitsAvailable
                  ? "Needs unpushed commits."
                  : sizeLimit(changesBytes);
  const changesAvailable = inspected !== null && changesReason === null;

  // ── Settings and avatar ──
  const copySettings =
    source.kind === "repository"
      ? { available: false, reason: null }
      : { available: true, reason: null };
  const hasAvatar =
    source.kind === "inspected"
      ? source.inspection.settings.hasCustomAvatar
      : source.kind === "legacy" && source.project.hasCustomAvatar;
  const avatarEstimate = estimate("avatar");
  const avatarReason = !hasAvatar
    ? null
    : source.kind === "legacy"
      ? updateRycoOn(source.label, "copy the avatar")
      : avatarEstimate === null
        ? null
        : avatarEstimate.skippedReason
          ? sentenceCase(avatarEstimate.skippedReason)
          : null;
  const avatarAvailable = hasAvatar && source.kind === "inspected" && avatarReason === null;

  // ── Choices ──
  const bringChanges = changesAvailable && (requested.bringChanges ?? false);
  const commitsForced = bringChanges && changesNeedCommits;
  const bringCommits = commitsAvailable && (commitsForced || (requested.bringCommits ?? true));
  const candidates = workingTree?.ignoredCandidates ?? [];
  const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
  const ignoredPaths = bringChanges
    ? (requested.ignoredPaths ?? [])
        .filter((path) => candidatePaths.has(path))
        .slice(0, PROJECT_COPY_MAX_IGNORED_PATHS)
    : [];
  const copyAvatar = avatarAvailable && (requested.copyAvatar ?? true);
  const choices: ProjectCopyChoices = {
    mode: mode ?? "clone",
    bringCommits,
    bringChanges,
    ignoredPaths,
    copySettings: copySettings.available && (requested.copySettings ?? true),
    copyAvatar,
  };
  const plannedBytes =
    (mode === "send-files" ? sendFiles.estimatedBytes : 0) +
    (bringCommits ? estimatedBytes("commits-bundle") : 0) +
    (bringChanges ? estimatedBytes("changes-patch") : 0) +
    (copyAvatar ? estimatedBytes("avatar") : 0);
  if (relayed && plannedBytes > PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES) {
    blockedReason ??= relayTooLargeMessage(plannedBytes);
  }
  if (
    mode === "clone" &&
    pushedState !== null &&
    !pushedState.headOnRemote &&
    !bringCommits &&
    sourceLabel !== null
  ) {
    notes.push(
      `Unpushed commits stay on ${sourceLabel}; the copy starts from what the remote has.`,
    );
  }

  const scripts =
    source.kind === "inspected"
      ? source.inspection.settings.scripts
      : source.kind === "legacy"
        ? source.project.scripts
        : [];
  return {
    blockedReason,
    modes: { clone, sendFiles, link },
    defaultMode,
    bringCommits: {
      available: commitsAvailable,
      reason: commitsModeReason ?? commitsBaseReason,
      estimatedBytes: estimatedBytes("commits-bundle"),
      unpushedCommitCount,
      forced: commitsForced,
    },
    bringChanges: {
      available: changesAvailable,
      reason: changesReason,
      estimatedBytes: estimatedBytes("changes-patch"),
    },
    ignoredCandidates: changesAvailable ? candidates : [],
    copySettings,
    copyAvatar: {
      available: avatarAvailable,
      reason: avatarReason,
      estimatedBytes: estimatedBytes("avatar"),
    },
    setup: projectCopySetupPrefill({
      scripts,
      sourceOs: source.kind === "repository" ? null : source.platformOs,
      targetOs: target.platformOs,
    }),
    relayed,
    choices,
    plannedBytes,
    notes,
  };
}

// ── Follow-up thread (A19) ────────────────────────────────────────────

export const PROJECT_COPY_FOLLOW_UP_PROMPT =
  "Finish setting up this project on this machine: install the tools and dependencies it " +
  "needs, run the setup steps the repository documents, and check that it builds and its " +
  "tests run. Do not change tracked files unless setup requires it. Report what you did and " +
  "anything that still needs attention.";

export interface ProjectCopyFollowUpDefaults {
  readonly title: string;
  readonly prompt: string;
  readonly runtimeMode: RuntimeMode;
  readonly envMode: ThreadEnvMode;
  /** The target's default model; null when no provider is ready there. */
  readonly modelSelection: ModelSelection | null;
  readonly unavailableReason: string | null;
}

/**
 * The target's default model for a new thread: its `initialModelSelection` when that provider
 * is set up, otherwise the first ready provider's default model. Null when none is ready.
 */
export function resolveFollowUpModelSelection(
  config: Pick<ServerConfig, "providers" | "settings"> | null,
): ModelSelection | null {
  if (config === null) return null;
  const ready = sortProviderInstanceEntries(deriveProviderInstanceEntries(config.providers)).filter(
    isSetupProviderInstance,
  );
  const preferred = config.settings.initialModelSelection;
  if (preferred && ready.some((entry) => entry.instanceId === preferred.instanceId)) {
    return createModelSelection(preferred.instanceId, preferred.model, preferred.options);
  }
  for (const entry of ready) {
    const fallback = DEFAULT_MODEL_BY_PROVIDER[entry.driverKind];
    const model =
      entry.models.find((candidate) => candidate.slug === fallback)?.slug ?? entry.models[0]?.slug;
    if (model) return createModelSelection(entry.instanceId, model);
  }
  return null;
}

/** What "Ask an agent to finish setup" prefills; the dialog lets the user edit all of it. */
export function projectCopyFollowUpDefaults(input: {
  readonly title: string;
  readonly targetLabel: string;
  readonly targetConfig: Pick<ServerConfig, "providers" | "settings"> | null;
}): ProjectCopyFollowUpDefaults {
  const modelSelection = resolveFollowUpModelSelection(input.targetConfig);
  return {
    title: `Finish setting up ${input.title}`.slice(0, PROJECT_COPY_THREAD_TITLE_MAX_CHARS),
    prompt: PROJECT_COPY_FOLLOW_UP_PROMPT,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    envMode: "local",
    modelSelection,
    unavailableReason:
      modelSelection === null ? `No agent provider is ready on ${input.targetLabel}.` : null,
  };
}

// ── Run plan ──────────────────────────────────────────────────────────

/** Where the repository comes from at run time. */
export type ProjectCopyRunSource =
  /** Exported from a source node that implements project copy. */
  | {
      readonly kind: "export";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly projectId: ProjectId;
      readonly checkoutPath: string | null;
    }
  /** Cloned from a remote with no export: an old source (A23) or an agent's repository URL. */
  | {
      readonly kind: "clone-only";
      readonly label: string | null;
      readonly remoteUrl: string;
      readonly remoteName: string;
      readonly remotes: ReadonlyArray<ProjectCopyRemote>;
      readonly relativeRootInRepository: string;
      readonly settings: ProjectImportSettings | null;
    };

export interface ProjectCopyRunTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly pathSeparator: NodePathSeparator;
}

/** Everything the coordinator runs, without ids: those are minted when it starts. */
export interface ProjectCopyRunPlan {
  readonly title: string;
  readonly source: ProjectCopyRunSource;
  readonly target: ProjectCopyRunTarget;
  /** The repository directory on the target, absolute. */
  readonly destinationPath: string;
  readonly choices: ProjectCopyChoices;
  /** The key a linked checkout must have (A27). */
  readonly expectedCanonicalKey: string | null;
  readonly setup: ProjectImportSetup | null;
  readonly followUpThread: ProjectImportFollowUpThread | null;
  readonly origin: ProjectImportOrigin;
  /** A clone the target can't reach may be retried by sending the files (A12). */
  readonly sendFilesFallback: boolean;
}

export type ProjectCopyRunPlanResult =
  | { readonly ok: true; readonly plan: ProjectCopyRunPlan }
  | { readonly ok: false; readonly reason: string };

const isValidRemoteName = Schema.is(GitRemoteName);
const isValidRemoteUrl = Schema.is(ProjectCopyRemoteUrl);
const isValidBranch = Schema.is(GitBranchName);
const isValidObjectId = Schema.is(GitObjectId);
const isValidRelativeRoot = Schema.is(ProjectCopyRelativeRoot);
const isValidRelativePath = Schema.is(ProjectCopyRelativePath);
const isValidImportStartInput = Schema.is(ProjectImportStartInput);

/** Recreatable remotes, sanitized and valid, minus the one the clone itself creates (A13). */
function recreatedRemotes(
  remotes: ReadonlyArray<{ readonly name: string; readonly url: string }>,
  cloneRemoteName: string | null,
): ReadonlyArray<ProjectCopyRemote> {
  const result: ProjectCopyRemote[] = [];
  for (const remote of remotes) {
    if (remote.name === cloneRemoteName) continue;
    const url = sanitizeRemoteUrl(remote.url);
    if (
      !isRecreatableRemoteKind(classifyRemoteUrl(url)) ||
      !isValidRemoteName(remote.name) ||
      !isValidRemoteUrl(url) ||
      result.some((entry) => entry.name === remote.name)
    ) {
      continue;
    }
    result.push({ name: remote.name, url });
    if (result.length === PROJECT_COPY_MAX_REMOTES) break;
  }
  return result;
}

/** The repository-relative project root, slash-separated, from two paths of one node. */
function legacyRelativeRoot(project: ProjectCopyLegacyProject): string {
  const repositoryRoot = project.repositoryIdentity?.rootPath;
  if (!repositoryRoot) return "";
  // git reports `C:/…` on Windows; a backslash anywhere means the node is Windows.
  const separator: NodePathSeparator =
    project.workspaceRoot.includes("\\") || /^[A-Za-z]:/.test(project.workspaceRoot) ? "\\" : "/";
  const segments = relativeNodePathSegments(project.workspaceRoot, repositoryRoot, separator);
  const relative = segments?.join("/") ?? "";
  return isValidRelativeRoot(relative) ? relative : "";
}

function legacySettings(project: ProjectCopyLegacyProject): ProjectImportSettings {
  return {
    scripts: project.scripts.slice(0, PROJECT_COPY_MAX_SCRIPTS),
    customSystemPrompt: project.customSystemPrompt,
    preferredRemoteName:
      project.preferredRemoteName !== null && isValidRemoteName(project.preferredRemoteName)
        ? project.preferredRemoteName
        : null,
    projectMetadataDir: project.projectMetadataDir,
    // A source without project copy cannot export its overrides: the copy keeps node settings.
    overrides: {},
  };
}

/**
 * The plan the coordinator runs, from the planning facts and the options plan. Fails when the
 * options block the copy or the destination is not chosen yet.
 */
export function buildProjectCopyRunPlan(input: {
  readonly planning: ProjectCopyPlanningInput;
  readonly options: ProjectCopyOptionsPlan;
  readonly target: Omit<ProjectCopyRunTarget, "label">;
  readonly title?: string | undefined;
  readonly setup: ProjectImportSetup | null;
  readonly followUpThread: ProjectImportFollowUpThread | null;
  readonly origin: ProjectImportOrigin;
}): ProjectCopyRunPlanResult {
  const { planning, options } = input;
  if (options.blockedReason !== null) return { ok: false, reason: options.blockedReason };
  const destination = planning.target.destination;
  if (destination === null) return { ok: false, reason: "Choose where the copy goes." };
  const { source } = planning;
  const choices = options.choices;
  const title = (input.title?.trim() || projectCopySourceTitle(source)).slice(
    0,
    PROJECT_COPY_TITLE_MAX_CHARS,
  );
  let runSource: ProjectCopyRunSource;
  if (source.kind === "inspected") {
    runSource = {
      kind: "export",
      environmentId: source.environmentId,
      label: source.label,
      projectId: source.inspection.projectId,
      checkoutPath: source.checkoutPath,
    };
  } else {
    const remote = cloneRemoteOf(source);
    if (remote === null || options.modes.clone.remoteUrl === null) {
      return { ok: false, reason: options.modes.clone.reason ?? "There is no remote to clone." };
    }
    runSource =
      source.kind === "legacy"
        ? {
            kind: "clone-only",
            label: source.label,
            remoteUrl: options.modes.clone.remoteUrl,
            remoteName: isValidRemoteName(remote.name) ? remote.name : "origin",
            remotes: recreatedRemotes(legacyRemotesOf(source.project), remote.name),
            relativeRootInRepository: legacyRelativeRoot(source.project),
            settings: legacySettings(source.project),
          }
        : {
            kind: "clone-only",
            label: null,
            remoteUrl: options.modes.clone.remoteUrl,
            remoteName: "origin",
            remotes: [],
            relativeRootInRepository: "",
            settings: null,
          };
  }
  return {
    ok: true,
    plan: {
      title,
      source: runSource,
      target: { ...input.target, label: planning.target.label },
      destinationPath: destination.path,
      choices,
      expectedCanonicalKey: choices.mode === "link" ? projectCopySourceCanonicalKey(source) : null,
      setup: input.setup,
      followUpThread: input.followUpThread,
      origin: input.origin,
      sendFilesFallback:
        source.kind === "inspected" &&
        choices.mode === "clone" &&
        options.modes.sendFiles.available,
    },
  };
}

/**
 * The same copy sent as a repository bundle, for the retry after the target could not reach
 * the remote (A12). Null when the plan can't fall back.
 */
export function projectCopyPlanWithSendFiles(plan: ProjectCopyRunPlan): ProjectCopyRunPlan | null {
  if (!plan.sendFilesFallback || plan.source.kind !== "export") return null;
  return {
    ...plan,
    choices: { ...plan.choices, mode: "send-files", bringCommits: false },
    sendFilesFallback: false,
  };
}

/** What `projects.exportStart` should include for the plan; null when nothing is exported. */
export function projectCopyExportInclude(plan: ProjectCopyRunPlan): ProjectExportInclude | null {
  if (plan.source.kind !== "export") return null;
  const { choices } = plan;
  const changes = choices.mode !== "link" && choices.bringChanges;
  return {
    commits: choices.mode === "clone" && choices.bringCommits,
    workingTreeChanges: changes,
    ignoredPaths: changes ? choices.ignoredPaths : [],
    wholeRepository: choices.mode === "send-files",
    avatar: choices.copyAvatar,
  };
}

/** The artifacts of an export the plan transfers to the target. */
export function projectCopyTransferKinds(
  plan: ProjectCopyRunPlan,
): ReadonlySet<ProjectExportArtifactKind> {
  const include = projectCopyExportInclude(plan);
  const kinds = new Set<ProjectExportArtifactKind>();
  if (include === null) return kinds;
  if (include.commits) kinds.add("commits-bundle");
  if (include.wholeRepository) kinds.add("repository-bundle");
  if (include.workingTreeChanges) kinds.add("changes-patch");
  if (include.avatar) kinds.add("avatar");
  return kinds;
}

export class ProjectCopyPlanError extends Error {
  readonly _tag = "ProjectCopyPlanError";

  constructor(message: string) {
    super(message);
    this.name = "ProjectCopyPlanError";
  }
}

/**
 * The `projects.importStart` input of a run: the plan's choices applied to the export result
 * (authoritative for branch, HEAD, remotes and settings) and the committed transfers. Throws
 * {@link ProjectCopyPlanError} when the result can't make a valid import.
 */
export function buildProjectImportStartInput(input: {
  readonly plan: ProjectCopyRunPlan;
  readonly importId: ProjectImportId;
  readonly projectId: ProjectId;
  readonly exportResult: ProjectExportResult | null;
  readonly transfers: Partial<Record<ProjectExportArtifactKind, ProjectTransferId>>;
}): { readonly input: ProjectImportStartInput; readonly warnings: ReadonlyArray<string> } {
  const { plan, exportResult, transfers } = input;
  const warnings: string[] = [];
  const mode = plan.choices.mode;
  const common = {
    importId: input.importId,
    projectId: input.projectId,
    title: plan.title,
    destinationPath: plan.destinationPath,
    setup: plan.setup,
    followUpThread: plan.followUpThread,
    origin: plan.origin,
  };
  let candidate: ProjectImportStartInput;
  if (plan.source.kind === "clone-only") {
    const source: ProjectImportSource =
      mode === "link"
        ? { kind: "existing-checkout", expectedCanonicalKey: plan.expectedCanonicalKey }
        : { kind: "clone", remoteUrl: plan.source.remoteUrl, remoteName: plan.source.remoteName };
    candidate = {
      ...common,
      source,
      remotes: mode === "link" ? [] : plan.source.remotes,
      commits: null,
      checkout: null,
      changes: null,
      relativeRootInRepository: plan.source.relativeRootInRepository,
      // Nobody inspected the repository: a clone asks for both steps, a link touches nothing.
      ...(mode === "link"
        ? { recurseSubmodules: false, usesLfs: false }
        : PROJECT_IMPORT_UNINSPECTED_CLONE_STEPS),
      settings: plan.choices.copySettings ? plan.source.settings : null,
      avatarTransferId: null,
    };
  } else {
    if (exportResult === null) throw new ProjectCopyPlanError("The source export is missing.");
    const { repository, pushedState, settings } = exportResult;
    // The remote the source measured its pushed state against: the commits bundle builds on it.
    const cloneRemote =
      repository.remotes.find((remote) => remote.name === repository.cloneRemoteName) ?? null;
    let source: ProjectImportSource;
    let cloneRemoteName: string | null = null;
    if (mode === "link") {
      source = {
        kind: "existing-checkout",
        expectedCanonicalKey: plan.expectedCanonicalKey ?? repository.canonicalKey,
      };
    } else if (mode === "send-files") {
      const transferId = transfers["repository-bundle"];
      if (!transferId) throw new ProjectCopyPlanError("The repository files were not sent.");
      source = { kind: "repository-bundle", transferId };
    } else {
      const remoteUrl = cloneRemote ? sanitizeRemoteUrl(cloneRemote.url) : null;
      if (
        cloneRemote === null ||
        remoteUrl === null ||
        !isCloneableRemoteKind(classifyRemoteUrl(remoteUrl)) ||
        !isValidRemoteUrl(remoteUrl)
      ) {
        throw new ProjectCopyPlanError(`${plan.title} has no remote another node can clone.`);
      }
      cloneRemoteName = isValidRemoteName(cloneRemote.name) ? cloneRemote.name : "origin";
      source = { kind: "clone", remoteUrl, remoteName: cloneRemoteName };
    }
    const commitsTransferId = mode === "clone" ? transfers["commits-bundle"] : undefined;
    const headOid =
      repository.headOid !== null && isValidObjectId(repository.headOid)
        ? repository.headOid
        : null;
    // HEAD exists on the target after the clone when the remote has it or the commits came along.
    const headArrives =
      mode === "send-files" || commitsTransferId !== undefined || pushedState.headOnRemote;
    const branch =
      !repository.isDetached && repository.branch !== null && isValidBranch(repository.branch)
        ? repository.branch
        : null;
    if (!repository.isDetached && repository.branch !== null && branch === null) {
      warnings.push(`The branch ${repository.branch} can't be recreated; the copy is detached.`);
    }
    const checkout =
      mode === "link"
        ? null
        : headOid !== null && headArrives
          ? { branch, headOid }
          : branch !== null && pushedState.upstreamBranch !== null
            ? { branch, headOid: null }
            : null;
    const changesTransferId = mode === "link" ? undefined : transfers["changes-patch"];
    let changes: ProjectImportStartInput["changes"] = null;
    if (changesTransferId !== undefined) {
      if (headOid !== null && checkout?.headOid === headOid) {
        changes = {
          transferId: changesTransferId,
          baseOid: headOid,
          ignoredPaths: plan.choices.ignoredPaths.filter(isValidRelativePath),
        };
      } else {
        warnings.push(
          "Uncommitted changes were not copied: the commit they are based on did not come along.",
        );
      }
    }
    if (!isValidRelativeRoot(settings.relativeRootInRepository)) {
      throw new ProjectCopyPlanError("The project's folder inside the repository is not valid.");
    }
    candidate = {
      ...common,
      source,
      remotes: mode === "link" ? [] : recreatedRemotes(repository.remotes, cloneRemoteName),
      commits: commitsTransferId === undefined ? null : { transferId: commitsTransferId },
      checkout,
      changes,
      relativeRootInRepository: settings.relativeRootInRepository,
      recurseSubmodules: repository.hasSubmodules,
      usesLfs: repository.usesLfs,
      settings: plan.choices.copySettings
        ? {
            scripts: settings.scripts.slice(0, PROJECT_COPY_MAX_SCRIPTS),
            customSystemPrompt: settings.customSystemPrompt,
            preferredRemoteName:
              settings.preferredRemoteName !== null &&
              isValidRemoteName(settings.preferredRemoteName)
                ? settings.preferredRemoteName
                : null,
            projectMetadataDir: settings.projectMetadataDir,
            overrides: settings.overrides,
          }
        : null,
      avatarTransferId: transfers.avatar ?? null,
    };
  }
  if (!isValidImportStartInput(candidate)) {
    throw new ProjectCopyPlanError("The copy request is not valid for the destination.");
  }
  return { input: candidate, warnings };
}
