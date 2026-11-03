// FILE: addProjectDialog.logic.ts
// Purpose: What the add-project dialog decides without React: where it starts (the node step
//          is skipped when the node is given or only one can take projects), its step labels
//          and primary button, the status line of a clone and of a folder that joins a project
//          on other nodes, the repositories it offers to clone, the projects it can copy from
//          another node, the done step's node list, an import's progress rows, and the
//          `projects.importStart` inputs of a clone and a link.
// Layer: Web UI logic, pure. Rendering lives in `AddProjectDialog.tsx`.

import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { deriveRepositoryRelativeProjectPath } from "@ryco/client-runtime/state/workspace";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@ryco/contracts";
import {
  PROJECT_COPY_MAX_SCRIPTS,
  PROJECT_COPY_TITLE_MAX_CHARS,
  PROJECT_IMPORT_UNINSPECTED_CLONE_STEPS,
  ProjectImportStartInput,
  type ProjectImportId,
  type ProjectImportSnapshot,
} from "@ryco/contracts/project-copy";
import {
  classifyRemoteUrl,
  displayRemoteUrl,
  isCloneableRemoteKind,
  repositoryFolderName,
  sanitizeRemoteUrl,
} from "@ryco/shared/gitRemoteUrl";
import { isChatProject } from "@ryco/shared/projectKind";
import * as Schema from "effect/Schema";

import { inferProjectTitleFromPath, isSameFilesystemPath } from "../../lib/projectPaths";
import type { Project } from "../../types";
import type { AddProjectDialogMode, AddProjectDialogRequest } from "./projectNodesDialogStore";
import type { CopyProgressStep } from "./copyProjectDialog.logic";
import { lastOutputLine, projectImportStepLabel } from "./copyRuntime/projectCopyProgress.logic";
import { formatNodePath, type FolderSelectionStatus } from "./folderPicker.logic";
import { resolveNodePickerAvailability } from "./nodePicker.logic";

/** What the project is added from: a folder on the node, a clone, a copy, or a checkout to link. */
export type AddProjectSourceKind = AddProjectDialogMode;

/** Node → Source → Folder. */
export type AddProjectStep = 0 | 1 | 2;

/* ───────── Where the dialog starts ───────── */

/** The nodes a project can be added to now: online (or connecting) and open to changes. */
export function addProjectSelectableNodes(
  nodes: ReadonlyArray<NodeCatalogEntry>,
): ReadonlyArray<NodeCatalogEntry> {
  return nodes.filter((node) => resolveNodePickerAvailability(node, {}, undefined).selectable);
}

export interface AddProjectStart {
  readonly nodeId: EnvironmentId | null;
  readonly step: AddProjectStep;
  /** The source the dialog opens on (expanded on the source step). */
  readonly kind: AddProjectSourceKind | null;
}

/** The step a source opens on once the node is known: a folder and a link go straight to the folder. */
export function addProjectStepForKind(kind: AddProjectSourceKind | null): AddProjectStep {
  return kind === "folder" || kind === "link" ? 2 : 1;
}

/**
 * Where an open starts. The node step is skipped when the request names a node
 * that can take projects, or when only one node can; a `link` needs the project
 * it links (`linkAvailable`) and otherwise opens on the sources.
 */
export function resolveAddProjectStart(input: {
  readonly request: AddProjectDialogRequest | null;
  readonly nodes: ReadonlyArray<NodeCatalogEntry>;
  readonly linkAvailable: boolean;
}): AddProjectStart {
  const mode = input.request?.mode ?? null;
  const kind = mode === "link" && !input.linkAvailable ? null : mode;
  const selectable = addProjectSelectableNodes(input.nodes);
  const requested = input.request?.environmentId ?? null;
  const nodeId =
    requested !== null && selectable.some((node) => node.environmentId === requested)
      ? requested
      : selectable.length === 1
        ? selectable[0]!.environmentId
        : null;
  if (nodeId === null) return { nodeId: null, step: 0, kind };
  return { nodeId, step: addProjectStepForKind(kind), kind };
}

/* ───────── Labels ───────── */

const SOURCE_STEP_LABELS: Readonly<Record<AddProjectSourceKind, string>> = {
  folder: "Open folder",
  clone: "Clone",
  copy: "Copy",
  link: "Link",
};

/** The stepper's three labels: the node's name once picked, the source once chosen. */
export function addProjectStepLabels(input: {
  readonly nodeLabel: string | null;
  readonly kind: AddProjectSourceKind | null;
  readonly step: AddProjectStep;
}): readonly [string, string, string] {
  return [
    input.nodeLabel ?? "Node",
    input.kind !== null && input.step >= 1 ? SOURCE_STEP_LABELS[input.kind] : "Source",
    input.kind === "clone" ? "Where to clone" : "Folder",
  ];
}

/** The folder step's primary button: "Add project", "Already a project", "Clone to <node>". */
export function addProjectPrimaryLabel(input: {
  readonly kind: AddProjectSourceKind;
  readonly nodeLabel: string;
  readonly status: FolderSelectionStatus | null;
}): string {
  const selected = input.status?.selectedPath != null;
  switch (input.kind) {
    case "clone":
      return selected ? `Clone to ${input.nodeLabel}` : "Clone";
    case "link":
      return "Link checkout";
    default:
      return input.status?.kind === "existing-project" ? "Already a project" : "Add project";
  }
}

/* ───────── Status line ───────── */

/**
 * The clone's status line: "Clones <remote> into <path>", flagged when that
 * folder already exists. The folder picker's other states (checking, refused, an
 * existing project) stay as they are.
 */
export function describeCloneDestination(
  status: FolderSelectionStatus,
  input: { readonly remoteUrl: string; readonly homeDirectory: string | null },
): FolderSelectionStatus {
  const destination = status.destinationPath;
  if (destination === null) return status;
  const line = [
    { text: "Clones " },
    { text: displayRemoteUrl(input.remoteUrl), path: true },
    { text: " into " },
    { text: formatNodePath(destination, input.homeDirectory), path: true },
  ];
  switch (status.kind) {
    case "new-folder":
    case "empty-folder":
    case "unchecked":
      return withSegments(status, line, { kind: "clone-destination", tone: "neutral" });
    case "occupied":
    case "same-repository":
    case "existing-project":
      return withSegments(status, [...line, { text: ": that folder already exists" }], {
        kind: "clone-destination",
        tone: "caution",
        usable: false,
      });
    default:
      return status;
  }
}

/** A project of the same repository on other nodes, which a new checkout joins. */
export interface AddProjectRepositoryJoin {
  readonly name: string;
  readonly nodeLabels: ReadonlyArray<string>;
}

/** Appends " · joins <project> from <nodes>" to a usable folder's status line. */
export function describeFolderJoin(
  status: FolderSelectionStatus,
  join: AddProjectRepositoryJoin | null,
): FolderSelectionStatus {
  if (join === null || !status.usable || join.nodeLabels.length === 0) return status;
  return withSegments(status, [
    ...status.segments,
    { text: " · joins " },
    { text: join.name },
    { text: ` from ${join.nodeLabels.join(", ")}` },
  ]);
}

function withSegments(
  status: FolderSelectionStatus,
  segments: FolderSelectionStatus["segments"],
  patch: Partial<Pick<FolderSelectionStatus, "kind" | "tone" | "usable">> = {},
): FolderSelectionStatus {
  return {
    ...status,
    ...patch,
    segments,
    text: segments.map((segment) => segment.text).join(""),
  };
}

/* ───────── Projects across nodes ───────── */

/** Projects as the dialog reads them: every node's, chats left out by the helpers below. */
type ProjectLike = Pick<
  Project,
  "id" | "environmentId" | "kind" | "name" | "cwd" | "repositoryIdentity"
>;

/** Node labels of `environmentIds` in catalog order, each once, unknown ids left out. */
function nodeLabelsInOrder(
  environmentIds: ReadonlySet<EnvironmentId>,
  nodes: ReadonlyArray<Pick<NodeCatalogEntry, "environmentId" | "label">>,
): string[] {
  return nodes.filter((node) => environmentIds.has(node.environmentId)).map((node) => node.label);
}

/**
 * The project a checkout of `canonicalKey` on `nodeId` joins: the first project of
 * that repository, and the other nodes it is on. Null when no other node has it.
 */
export function findRepositoryJoin(input: {
  readonly canonicalKey: string | null;
  readonly nodeId: EnvironmentId;
  readonly projects: ReadonlyArray<ProjectLike>;
  readonly nodes: ReadonlyArray<Pick<NodeCatalogEntry, "environmentId" | "label">>;
}): AddProjectRepositoryJoin | null {
  if (!input.canonicalKey) return null;
  const members = input.projects.filter(
    (project) =>
      !isChatProject(project) && project.repositoryIdentity?.canonicalKey === input.canonicalKey,
  );
  const otherNodes = new Set(
    members
      .map((project) => project.environmentId)
      .filter((environmentId) => environmentId !== input.nodeId),
  );
  if (otherNodes.size === 0) return null;
  const nodeLabels = nodeLabelsInOrder(otherNodes, input.nodes);
  return nodeLabels.length > 0 ? { name: members[0]!.name, nodeLabels } : null;
}

/** A repository the clone source offers: one of the user's projects, by its remote. */
export interface AddProjectRepositorySuggestion {
  readonly canonicalKey: string;
  /** "owner/repo" when the remote names one. */
  readonly label: string;
  /** The URL the node clones, credentials stripped. */
  readonly remoteUrl: string;
  /** A project of this repository is already on the dialog's node. */
  readonly onThisNode: boolean;
  /** The other nodes it is on, in catalog order. */
  readonly otherNodeIds: ReadonlyArray<EnvironmentId>;
}

function repositoryLabel(project: ProjectLike, canonicalKey: string): string {
  const identity = project.repositoryIdentity;
  if (identity?.owner && identity.name) return `${identity.owner}/${identity.name}`;
  const path = canonicalKey.split("/").slice(1).join("/");
  return identity?.displayName ?? (path || canonicalKey);
}

/**
 * The repositories of the user's projects that can be cloned (a network remote),
 * one entry per repository in project order, matching `query` on "owner/repo",
 * or on the repository key or URL when the query names a host.
 */
export function buildRepositorySuggestions(input: {
  readonly projects: ReadonlyArray<ProjectLike>;
  readonly nodeId: EnvironmentId;
  readonly nodes: ReadonlyArray<Pick<NodeCatalogEntry, "environmentId">>;
  readonly query: string;
}): AddProjectRepositorySuggestion[] {
  const needle = input.query.trim().toLowerCase();
  const order = new Map(input.nodes.map((node, index) => [node.environmentId, index] as const));
  const byKey = new Map<
    string,
    { label: string; remoteUrl: string; environmentIds: Set<EnvironmentId> }
  >();
  for (const project of input.projects) {
    if (isChatProject(project)) continue;
    const identity = project.repositoryIdentity;
    const canonicalKey = identity?.canonicalKey;
    if (!identity || !canonicalKey) continue;
    const existing = byKey.get(canonicalKey);
    if (existing) {
      existing.environmentIds.add(project.environmentId);
      continue;
    }
    const remoteUrl = sanitizeRemoteUrl(identity.locator.remoteUrl);
    if (!isCloneableRemoteKind(classifyRemoteUrl(remoteUrl))) continue;
    byKey.set(canonicalKey, {
      label: repositoryLabel(project, canonicalKey),
      remoteUrl,
      environmentIds: new Set([project.environmentId]),
    });
  }
  const suggestions: AddProjectRepositorySuggestion[] = [];
  for (const [canonicalKey, entry] of byKey) {
    // The host part matches only a query that names one ("github.com/…", a URL), so
    // "hub" finds ryco-hub rather than everything on GitHub.
    const matchesAddress =
      /[.:]/u.test(needle) &&
      (canonicalKey.includes(needle) || entry.remoteUrl.toLowerCase().includes(needle));
    if (needle.length > 0 && !entry.label.toLowerCase().includes(needle) && !matchesAddress) {
      continue;
    }
    suggestions.push({
      canonicalKey,
      label: entry.label,
      remoteUrl: entry.remoteUrl,
      onThisNode: entry.environmentIds.has(input.nodeId),
      otherNodeIds: Array.from(entry.environmentIds)
        .filter((environmentId) => environmentId !== input.nodeId)
        .toSorted(
          (left, right) =>
            (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right) ?? Number.MAX_SAFE_INTEGER),
        ),
    });
  }
  return suggestions;
}

/** Typed clone input that is a URL (https, ssh, scp-style, file) rather than "owner/repo". */
export function isGitRemoteUrlInput(input: string): boolean {
  const kind = classifyRemoteUrl(input.trim());
  return kind !== "local" && kind !== "other";
}

/** The folder a clone gets: the repository's name, else the slug of what was typed. */
export function cloneFolderName(remoteUrl: string, repositoryInput: string): string | null {
  return repositoryFolderName(remoteUrl) ?? repositoryFolderName(repositoryInput);
}

/** A logical project as the copy source lists it. */
export interface AddProjectCopyGroup {
  readonly key: string;
  readonly name: string;
  readonly members: ReadonlyArray<
    ProjectLike & { readonly customAvatarContentHash?: string | null }
  >;
}

/** A project the dialog can bring over from another node, and the checkout it copies. */
export interface AddProjectCopySource {
  readonly key: string;
  readonly name: string;
  readonly source: ProjectLike & { readonly customAvatarContentHash?: string | null };
}

/**
 * The projects not on `nodeId` that another online node has; each copies from its
 * first checkout on an online node.
 */
export function buildCopySources(input: {
  readonly groups: ReadonlyArray<AddProjectCopyGroup>;
  readonly nodeId: EnvironmentId;
  readonly isOnline: (environmentId: EnvironmentId) => boolean;
}): AddProjectCopySource[] {
  const sources: AddProjectCopySource[] = [];
  for (const group of input.groups) {
    if (group.members.some((member) => member.environmentId === input.nodeId)) continue;
    const source = group.members.find((member) => input.isOnline(member.environmentId));
    if (source) sources.push({ key: group.key, name: group.name, source });
  }
  return sources;
}

/* ───────── Done ───────── */

/** The project the dialog added, as it knows it before the node's shell reports it. */
export interface AddedProject {
  readonly ref: ScopedProjectRef;
  readonly name: string;
  readonly cwd: string;
  /** Its repository's key when known, which groups it with checkouts on other nodes. */
  readonly canonicalKey: string | null;
}

export interface AddedProjectNodeRow {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly isNew: boolean;
}

/**
 * Every node the added project is on, in the catalog's node order: the new
 * checkout (marked) and the other checkouts of its repository.
 */
export function buildAddedProjectNodeRows(input: {
  readonly added: AddedProject;
  readonly projects: ReadonlyArray<ProjectLike>;
  readonly nodes: ReadonlyArray<Pick<NodeCatalogEntry, "environmentId">>;
}): AddedProjectNodeRow[] {
  const { added } = input;
  const rows: AddedProjectNodeRow[] = [
    { environmentId: added.ref.environmentId, cwd: added.cwd, isNew: true },
  ];
  if (added.canonicalKey) {
    for (const project of input.projects) {
      if (isChatProject(project)) continue;
      if (project.repositoryIdentity?.canonicalKey !== added.canonicalKey) continue;
      const isAdded =
        project.environmentId === added.ref.environmentId &&
        (project.id === added.ref.projectId || isSameFilesystemPath(project.cwd, added.cwd));
      if (isAdded) continue;
      rows.push({ environmentId: project.environmentId, cwd: project.cwd, isNew: false });
    }
  }
  const order = new Map(input.nodes.map((node, index) => [node.environmentId, index] as const));
  return rows.toSorted(
    (left, right) =>
      (order.get(left.environmentId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.environmentId) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** The done step's explanation under "<name> is on <node>". */
export function addedProjectLead(otherNodeLabels: ReadonlyArray<string>): string {
  if (otherNodeLabels.length === 0) return "Ready for threads.";
  return `Same repository as on ${otherNodeLabels.join(" and ")}, so it shows up as one project on ${
    otherNodeLabels.length + 1
  } nodes.`;
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
