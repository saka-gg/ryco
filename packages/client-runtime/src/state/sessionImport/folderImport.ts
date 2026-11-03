// Project-level import of Codex and Claude Code history: groups discovered
// conversations by the folder they ran in, proposes where each group goes (an
// existing project that holds the folder, or a new project in it), plans the
// run and drives it one conversation at a time. Pure and platform-free, so the
// web dialog and a future native screen share one behaviour; the caller
// supplies discovery results, the node's projects and the two node calls.

import type {
  ProjectId,
  SessionImportCandidate,
  SessionImportDiscoverInput,
  SessionImportPage,
  SessionImportResult,
  SessionImportSource,
  ThreadId,
} from "@ryco/contracts";

import { absolutePathKey, workspacePathWithinRepository } from "../files/paths.ts";

/** A discovered conversation and the source row (a source's store) it was read from. */
export interface SessionImportOriginCandidate extends SessionImportCandidate {
  /** The caller's id for the store the conversation was read from and who continues it. */
  readonly origin: string;
}

/** A project on the node that can receive imported conversations. */
export interface SessionImportProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly workspaceRoot: string;
}

/**
 * `found`: the folder exists on the node (its real path, or the recorded one
 * from a node too old to resolve it). `missing`: the recorded folder is gone.
 * `unknown`: the conversation recorded no folder.
 */
export type SessionImportFolderState = "found" | "missing" | "unknown";

/** Where a group's conversations are imported to. */
export type SessionImportTarget =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  /** A new project in the group's own folder, created just before its first conversation. */
  | { readonly kind: "new"; readonly workspaceRoot: string };

export type SessionImportDestination = SessionImportTarget | { readonly kind: "none" };

export interface SessionImportGroup {
  readonly key: string;
  /** The real path for `found`, the recorded path for `missing`, null for `unknown`. */
  readonly folder: string | null;
  readonly folderState: SessionImportFolderState;
  readonly sources: readonly SessionImportSource[];
  readonly candidates: readonly SessionImportOriginCandidate[];
  /** The destination proposed until the user picks another. */
  readonly suggested: SessionImportDestination;
}

/** One store of one source to read, and the label its notices carry. */
export interface SessionImportSourceRow {
  /** Becomes each candidate's `origin`. */
  readonly id: string;
  readonly source: SessionImportSource;
  readonly storeKey: string;
  readonly label: string;
}

export interface SessionImportDiscovery {
  readonly candidates: readonly SessionImportOriginCandidate[];
  /** The node's notices (skipped files, safety limits) and per-store failures, once each. */
  readonly notices: readonly string[];
  /** False when `shouldContinue` ended the reading early. */
  readonly complete: boolean;
}

/**
 * Reads every page of every row with the node's bounded discovery, one page
 * at a time. A store that fails adds a notice and the others still load; a
 * page that does not move forward ends that store, so a misbehaving node
 * cannot loop it.
 */
export async function discoverSessionImportCandidates(input: {
  readonly rows: readonly SessionImportSourceRow[];
  readonly includeArchived: boolean;
  readonly discover: (request: SessionImportDiscoverInput) => Promise<SessionImportPage>;
  /** Read before each page; false ends the reading. */
  readonly shouldContinue: () => boolean;
  /** How many conversations were found so far. */
  readonly onProgress?: (found: number) => void;
}): Promise<SessionImportDiscovery> {
  const candidates: SessionImportOriginCandidate[] = [];
  const notices = new Set<string>();
  for (const row of input.rows) {
    let offset: number | null = 0;
    while (offset !== null) {
      if (!input.shouldContinue()) return { candidates, notices: [...notices], complete: false };
      let page: SessionImportPage;
      try {
        page = await input.discover({
          source: row.source,
          storeKey: row.storeKey,
          search: "",
          offset,
          includeArchived: input.includeArchived,
        });
      } catch (error) {
        notices.add(`${row.label}: ${failureMessage(error, "Discovery failed.")}`);
        break;
      }
      for (const item of page.items) candidates.push({ ...item, origin: row.id });
      for (const notice of page.notices) notices.add(notice);
      input.onProgress?.(candidates.length);
      offset = page.nextOffset !== null && page.nextOffset > offset ? page.nextOffset : null;
    }
  }
  return { candidates, notices: [...notices], complete: true };
}

const FOLDER_STATE_ORDER: Record<SessionImportFolderState, number> = {
  found: 0,
  missing: 1,
  unknown: 2,
};

function candidateFolder(candidate: SessionImportCandidate): {
  readonly folder: string | null;
  readonly state: SessionImportFolderState;
} {
  if (candidate.canonicalCwd) return { folder: candidate.canonicalCwd, state: "found" };
  if (!candidate.cwd) return { folder: null, state: "unknown" };
  // `undefined` is a node that predates folder resolution: its recorded folder stands in.
  return { folder: candidate.cwd, state: candidate.canonicalCwd === null ? "missing" : "found" };
}

function sameFolder(left: string, right: string): boolean {
  return workspacePathWithinRepository(left, right) === "";
}

/**
 * The project whose folder holds `folder`, the closest one when projects
 * nest; null when none does.
 */
export function findContainingImportProject<P extends SessionImportProject>(
  folder: string,
  projects: readonly P[],
): P | null {
  let best: { readonly project: P; readonly depth: number } | null = null;
  for (const project of projects) {
    const relative = workspacePathWithinRepository(folder, project.workspaceRoot);
    if (relative === null) continue;
    const depth = relative === "" ? 0 : relative.split("/").length;
    if (!best || depth < best.depth) best = { project, depth };
  }
  return best?.project ?? null;
}

function suggestDestination(
  folder: string | null,
  state: SessionImportFolderState,
  projects: readonly SessionImportProject[],
): SessionImportDestination {
  if (folder === null) return { kind: "none" };
  const existing = findContainingImportProject(folder, projects);
  if (existing) return { kind: "project", projectId: existing.id };
  // A gone folder cannot hold a new project; the user picks one by hand.
  return state === "found" ? { kind: "new", workspaceRoot: folder } : { kind: "none" };
}

/**
 * Groups conversations by the folder they ran in, never by name or remote.
 * Conversations from Codex and Claude Code in the same folder share a group.
 * Existing folders come first, then gone ones, then conversations without a
 * folder; each part is ordered by path, and conversations keep their order.
 */
export function groupSessionImportCandidates(
  candidates: readonly SessionImportOriginCandidate[],
  projects: readonly SessionImportProject[],
): SessionImportGroup[] {
  const groups = new Map<
    string,
    {
      folder: string | null;
      state: SessionImportFolderState;
      candidates: SessionImportOriginCandidate[];
    }
  >();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    const { folder, state } = candidateFolder(candidate);
    const key = folder === null ? state : `${state}:${absolutePathKey(folder) ?? folder}`;
    const group = groups.get(key);
    if (group) group.candidates.push(candidate);
    else groups.set(key, { folder, state, candidates: [candidate] });
  }
  return [...groups.entries()]
    .map(([key, group]): SessionImportGroup => ({
      key,
      folder: group.folder,
      folderState: group.state,
      sources: [...new Set(group.candidates.map((candidate) => candidate.source))].toSorted(),
      candidates: group.candidates,
      suggested: suggestDestination(group.folder, group.state, projects),
    }))
    .toSorted(
      (left, right) =>
        FOLDER_STATE_ORDER[left.folderState] - FOLDER_STATE_ORDER[right.folderState] ||
        (left.folder ?? "").localeCompare(right.folder ?? "", undefined, {
          sensitivity: "base",
        }) ||
        left.key.localeCompare(right.key),
    );
}

/**
 * The destinations a group can be sent to: a new project in its own folder
 * (only when the folder exists and no project already uses it), then every
 * project.
 */
export function sessionImportDestinationOptions(
  group: SessionImportGroup,
  projects: readonly SessionImportProject[],
): SessionImportTarget[] {
  const folder = group.folder;
  const offersNew =
    group.folderState === "found" &&
    folder !== null &&
    !projects.some((project) => sameFolder(project.workspaceRoot, folder));
  return [
    ...(offersNew ? [{ kind: "new", workspaceRoot: folder } as const] : []),
    ...projects.map((project) => ({ kind: "project", projectId: project.id }) as const),
  ];
}

/** Not imported before, not paused by an uncertain earlier import, and not done in this session. */
export function isSessionImportCandidatePending(
  candidate: SessionImportOriginCandidate,
  done: ReadonlySet<string>,
): boolean {
  return candidate.importedThreadId === null && !candidate.quarantined && !done.has(candidate.key);
}

/** Every conversation that can still be imported, across groups. */
export function pendingSessionImportKeys(
  groups: readonly SessionImportGroup[],
  done: ReadonlySet<string>,
): string[] {
  return groups.flatMap((group) =>
    group.candidates
      .filter((candidate) => isSessionImportCandidatePending(candidate, done))
      .map((candidate) => candidate.key),
  );
}

/** How much of a group's pending conversations is selected. */
export function sessionImportGroupSelection(
  group: SessionImportGroup,
  selected: ReadonlySet<string>,
  done: ReadonlySet<string>,
): "all" | "some" | "none" {
  const pending = pendingSessionImportKeys([group], done);
  const count = pending.filter((key) => selected.has(key)).length;
  if (count === 0) return "none";
  return count === pending.length ? "all" : "some";
}

/** `selected` with every pending conversation of `group` added or removed. */
export function setSessionImportGroupSelected(
  group: SessionImportGroup,
  selected: ReadonlySet<string>,
  done: ReadonlySet<string>,
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const key of pendingSessionImportKeys([group], done)) {
    if (checked) next.add(key);
    else next.delete(key);
  }
  return next;
}

export interface SessionImportPlanItem {
  readonly candidate: SessionImportOriginCandidate;
  readonly target: SessionImportTarget;
}

export interface SessionImportPlan {
  /** Selected pending conversations with a destination, group by group. */
  readonly items: readonly SessionImportPlanItem[];
  /** Selected pending conversations whose group has no destination yet. */
  readonly unassigned: number;
  /** Folders a project is created in. */
  readonly newProjects: readonly string[];
}

/**
 * What an import of the selection does. A group's destination is the user's
 * choice or else the suggestion; a chosen project that no longer exists
 * leaves the group unassigned, and a new project in a folder a project now
 * uses imports into that project instead of adding another.
 */
export function planSessionImport(input: {
  readonly groups: readonly SessionImportGroup[];
  readonly selected: ReadonlySet<string>;
  readonly done: ReadonlySet<string>;
  readonly destinations: Readonly<Record<string, SessionImportDestination>>;
  readonly projects: readonly SessionImportProject[];
}): SessionImportPlan {
  const items: SessionImportPlanItem[] = [];
  const newProjects = new Set<string>();
  let unassigned = 0;
  for (const group of input.groups) {
    const chosen = group.candidates.filter(
      (candidate) =>
        input.selected.has(candidate.key) && isSessionImportCandidatePending(candidate, input.done),
    );
    if (chosen.length === 0) continue;
    const target = resolveSessionImportDestination(
      input.destinations[group.key] ?? group.suggested,
      input.projects,
    );
    if (target.kind === "none") {
      unassigned += chosen.length;
      continue;
    }
    if (target.kind === "new") newProjects.add(target.workspaceRoot);
    for (const candidate of chosen) items.push({ candidate, target });
  }
  return { items, unassigned, newProjects: [...newProjects] };
}

/**
 * Where a destination leads with the node's current projects: a chosen
 * project that is gone leads nowhere, and a new project in a folder that a
 * project now uses is that project.
 */
export function resolveSessionImportDestination(
  destination: SessionImportDestination,
  projects: readonly SessionImportProject[],
): SessionImportDestination {
  if (destination.kind === "none") return destination;
  if (destination.kind === "project")
    return projects.some((project) => project.id === destination.projectId)
      ? destination
      : { kind: "none" };
  const existing = projects.find((project) =>
    sameFolder(project.workspaceRoot, destination.workspaceRoot),
  );
  return existing ? { kind: "project", projectId: existing.id } : destination;
}

export type SessionImportItemStatus =
  | { readonly state: "importing" }
  | { readonly state: "imported"; readonly threadId: ThreadId }
  | { readonly state: "failed"; readonly message: string };

export interface SessionImportRunHandlers {
  /** Creates a project in `workspaceRoot` through the normal project creation path. */
  readonly createProject: (workspaceRoot: string) => Promise<ProjectId>;
  /** The existing single-conversation import into `projectId`. */
  readonly importCandidate: (
    candidate: SessionImportOriginCandidate,
    projectId: ProjectId,
  ) => Promise<SessionImportResult>;
  /** Read before each conversation; false ends the run after the one in progress. */
  readonly shouldContinue: () => boolean;
  readonly onProjectCreated: (workspaceRoot: string, projectId: ProjectId) => void;
  readonly onItem: (key: string, status: SessionImportItemStatus) => void;
}

export interface SessionImportRunSummary {
  readonly imported: number;
  readonly failed: number;
  /** The run ended before its last conversation. */
  readonly stopped: boolean;
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/**
 * Imports the plan one conversation at a time. A new project is created right
 * before its first conversation, so stopping early leaves no empty project
 * behind; when its creation fails, the group's conversations fail with that
 * reason and creation is not tried again in this run. One failure never stops
 * the others.
 */
export async function runSessionImport(
  plan: SessionImportPlan,
  handlers: SessionImportRunHandlers,
): Promise<SessionImportRunSummary> {
  const created = new Map<string, ProjectId>();
  const creationFailures = new Map<string, string>();
  const projectFor = async (target: SessionImportTarget): Promise<ProjectId> => {
    if (target.kind === "project") return target.projectId;
    const root = target.workspaceRoot;
    const existing = created.get(root);
    if (existing) return existing;
    const failure = creationFailures.get(root);
    if (failure !== undefined) throw new Error(failure);
    try {
      const projectId = await handlers.createProject(root);
      created.set(root, projectId);
      handlers.onProjectCreated(root, projectId);
      return projectId;
    } catch (error) {
      const message = `Could not create the project: ${failureMessage(error, "the node refused it.")}`;
      creationFailures.set(root, message);
      throw new Error(message, { cause: error });
    }
  };
  let imported = 0;
  let failed = 0;
  for (const item of plan.items) {
    if (!handlers.shouldContinue()) return { imported, failed, stopped: true };
    const key = item.candidate.key;
    handlers.onItem(key, { state: "importing" });
    try {
      const projectId = await projectFor(item.target);
      const result = await handlers.importCandidate(item.candidate, projectId);
      imported++;
      handlers.onItem(key, { state: "imported", threadId: result.threadId });
    } catch (error) {
      failed++;
      handlers.onItem(key, {
        state: "failed",
        message: failureMessage(error, "Import failed. Retry this conversation."),
      });
    }
  }
  return { imported, failed, stopped: false };
}
