import type {
  Project,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";

import {
  deriveLogicalProjectKey,
  derivePhysicalProjectKey,
  deriveProjectGroupLabel,
  type ProjectGroupingMode,
} from "../../lib/logicalProject";
import type { NodeTrust } from "../home/nodeTrustModel";

export interface ProjectEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: "connected" | "reconnecting" | "offline" | "read-only";
  /** Wave 2 cache provenance — see InboxEnvironment (structurally identical). */
  readonly stale?: boolean;
  readonly staleDetail?: string;
  /** Wave 4 role and display-only E2EE trust — see InboxEnvironment
   * (structurally identical; HomeScreen feeds one roster to both models).
   * Both stay absent rather than defaulted: "no role known" is not "viewer",
   * and "no trust evidence" is not "unverified". */
  readonly role?: "viewer" | "operator" | "owner" | "client";
  readonly trust?: NodeTrust;
}

/**
 * One machine a project row lives on. A row carries one entry per contributing
 * machine — the machine is an attribute of the row now, never a mode the list is
 * in — so the provenance (which machine, how reachable, at what authority, with
 * what role) travels with the project instead of with a section header.
 */
export interface ProjectRowMachine {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
  readonly connectionState: ProjectEnvironment["connectionState"];
  readonly stale?: boolean;
  readonly staleDetail?: string;
  readonly role?: "viewer" | "operator" | "owner" | "client";
}

export interface ProjectListRow {
  readonly key: string;
  readonly title: string;
  readonly customAvatarContentHash: string | null;
  readonly path: string;
  readonly machines: ReadonlyArray<ProjectRowMachine>;
  readonly worktreeCount: number;
  readonly threadCount: number;
  readonly updatedAt: string | null;
  /** Navigation target: the representative member, the one row taps open. */
  readonly open: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
}

export interface ProjectWorktreeGroup {
  readonly worktree: SidebarWorktreeSummary;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
}

export interface ProjectDetailModel {
  readonly project: Project;
  readonly environment: ProjectEnvironment | null;
  readonly activeWorktrees: ReadonlyArray<ProjectWorktreeGroup>;
  readonly archivedWorktrees: ReadonlyArray<ProjectWorktreeGroup>;
  readonly projectThreads: ReadonlyArray<SidebarThreadSummary>;
}

function scopedKey(environmentId: EnvironmentId, id: string): string {
  return `${environmentId}:${id}`;
}

function newestFirst(
  left: { readonly updatedAt?: string | undefined; readonly createdAt?: string | undefined },
  right: { readonly updatedAt?: string | undefined; readonly createdAt?: string | undefined },
): number {
  const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? "");
  const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? "");
  const delta = rightTime - leftTime;
  return Number.isFinite(delta) ? delta : 0;
}

export function buildProjectDetail(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly environments: ReadonlyArray<ProjectEnvironment>;
}): ProjectDetailModel | null {
  const project = input.projects.find(
    (candidate) =>
      candidate.environmentId === input.environmentId && candidate.id === input.projectId,
  );
  if (!project) return null;

  const worktrees = input.worktrees
    .filter(
      (worktree) =>
        worktree.environmentId === input.environmentId && worktree.projectId === input.projectId,
    )
    .toSorted(newestFirst);
  const threads = input.threads
    .filter(
      (thread) =>
        thread.environmentId === input.environmentId &&
        thread.projectId === input.projectId &&
        thread.archivedAt === null,
    )
    .toSorted(newestFirst);
  const threadsByWorktree = new Map<string, SidebarThreadSummary[]>();
  for (const thread of threads) {
    if (!thread.worktreeId) continue;
    const current = threadsByWorktree.get(thread.worktreeId) ?? [];
    current.push(thread);
    threadsByWorktree.set(thread.worktreeId, current);
  }
  const groups = worktrees.map((worktree) => ({
    worktree,
    threads: threadsByWorktree.get(worktree.id) ?? [],
  }));

  return {
    project,
    environment:
      input.environments.find((environment) => environment.environmentId === input.environmentId) ??
      null,
    activeWorktrees: groups.filter((group) => group.worktree.archivedAt === null),
    archivedWorktrees: groups.filter((group) => group.worktree.archivedAt !== null),
    projectThreads: threads.filter((thread) => !thread.worktreeId),
  };
}

interface ProjectMember {
  readonly project: Project;
  readonly physicalKey: string;
  readonly machine: ProjectRowMachine;
  readonly worktreeCount: number;
  readonly threadCount: number;
  readonly updatedAt: string | null;
}

function parseTime(value: string | null): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * The machine entry for a project, from the environment roster when it has one.
 *
 * A project whose environment is absent from the roster still renders, under
 * "Unknown machine" / offline. The node-grouped list used to drop such projects
 * silently (it iterated environments, not projects); a project that disappears
 * because its machine is momentarily unknown contradicts the row being the unit
 * of the list, and a labelled-unplaceable row is the honest degradation.
 */
function buildMachine(
  project: Project,
  environmentsById: ReadonlyMap<EnvironmentId, ProjectEnvironment>,
): ProjectRowMachine {
  const environment = environmentsById.get(project.environmentId);
  if (!environment) {
    return {
      environmentId: project.environmentId,
      projectId: project.id,
      label: "Unknown machine",
      connectionState: "offline",
    };
  }
  return {
    environmentId: project.environmentId,
    projectId: project.id,
    label: environment.label,
    connectionState: environment.connectionState,
    ...(environment.stale ? { stale: true } : {}),
    // Wave 2: the detail is only meaningful while the rows are cache provenance.
    ...(environment.stale && environment.staleDetail
      ? { staleDetail: environment.staleDetail }
      : {}),
    ...(environment.role ? { role: environment.role } : {}),
  };
}

/**
 * Physical keys are environment + normalized path, so two projects registered at
 * one path on one machine would collide. Fall back to the scoped project id so
 * the rendered list never carries a duplicate key.
 */
function claimKey(used: Set<string>, preferred: string, fallback: string): string {
  const key = used.has(preferred) ? fallback : preferred;
  used.add(key);
  return key;
}

/**
 * Project rows with machine provenance, merged across machines by the logical
 * project key (`deriveLogicalProjectKey`, algorithm-identical to server/web).
 *
 * THE MERGE RULE (load-bearing — a wrong merge is worse than two rows): a
 * logical-key group collapses into one row ONLY when it spans >= 2 environments
 * AND every contributing environment contributes exactly one project. If any one
 * environment contributes two or more projects to the key, the key is AMBIGUOUS:
 * a same-repo double checkout on one machine leaves no basis for deciding which
 * local checkout the other machine's checkout pairs with, and a merged row would
 * assert a pairing the data does not support. An ambiguous key emits every member
 * as its own unmerged physical row — no partial merging, no within-machine
 * collapsing. In "separate" mode the logical key IS the physical key, so nothing
 * ever merges; a project with no `repositoryIdentity.canonicalKey` likewise falls
 * back to its environment-scoped physical key and never merges.
 *
 * `nodeScope` and `query` filter MEMBERS, not rows: a scoped or filtered view
 * shows only the machines that survive the filter, so a merged row degrades to a
 * plain single-machine row rather than claiming machines the filter excluded.
 * Ambiguity is judged on the UNFILTERED catalog: a query that happens to hide
 * one of two same-machine checkouts must not manufacture a merge the full view
 * refuses — the pairing is no less ambiguous for being filtered out of sight.
 */
export function buildProjectRows(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly environments: ReadonlyArray<ProjectEnvironment>;
  readonly nodeScope?: EnvironmentId | null;
  readonly query?: string;
  readonly groupingMode: ProjectGroupingMode;
}): ReadonlyArray<ProjectListRow> {
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const environmentsById = new Map<EnvironmentId, ProjectEnvironment>();
  for (const environment of input.environments) {
    environmentsById.set(environment.environmentId, environment);
  }

  const worktreeCountByProject = new Map<string, number>();
  for (const worktree of input.worktrees) {
    if (worktree.archivedAt !== null) continue;
    const key = scopedKey(worktree.environmentId, worktree.projectId);
    worktreeCountByProject.set(key, (worktreeCountByProject.get(key) ?? 0) + 1);
  }
  const threadsByProject = new Map<string, SidebarThreadSummary[]>();
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const key = scopedKey(thread.environmentId, thread.projectId);
    const threads = threadsByProject.get(key) ?? [];
    threads.push(thread);
    threadsByProject.set(key, threads);
  }

  const unfilteredCountByKeyAndEnvironment = new Map<string, Map<EnvironmentId, number>>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKey(project, { groupingMode: input.groupingMode });
    const byEnvironment =
      unfilteredCountByKeyAndEnvironment.get(logicalKey) ?? new Map<EnvironmentId, number>();
    byEnvironment.set(project.environmentId, (byEnvironment.get(project.environmentId) ?? 0) + 1);
    unfilteredCountByKeyAndEnvironment.set(logicalKey, byEnvironment);
  }
  const ambiguousKeys = new Set<string>();
  for (const [logicalKey, byEnvironment] of unfilteredCountByKeyAndEnvironment) {
    if ([...byEnvironment.values()].some((count) => count >= 2)) ambiguousKeys.add(logicalKey);
  }

  const membersByLogicalKey = new Map<string, ProjectMember[]>();
  for (const project of input.projects) {
    if (input.nodeScope && project.environmentId !== input.nodeScope) continue;
    // A merged row renders the repository identity as its title, so the title
    // must be searchable — not only the members' own names and paths.
    const haystack = `${project.name} ${project.cwd} ${
      project.repositoryIdentity?.displayName ?? ""
    } ${project.repositoryIdentity?.name ?? ""}`;
    if (query && !haystack.toLocaleLowerCase().includes(query)) continue;

    const key = scopedKey(project.environmentId, project.id);
    const threads = threadsByProject.get(key) ?? [];
    const member: ProjectMember = {
      project,
      physicalKey: derivePhysicalProjectKey(project),
      machine: buildMachine(project, environmentsById),
      worktreeCount: worktreeCountByProject.get(key) ?? 0,
      threadCount: threads.length,
      updatedAt:
        threads
          .map((thread) => thread.updatedAt ?? thread.createdAt)
          .toSorted((left, right) => Date.parse(right) - Date.parse(left))[0] ??
        project.updatedAt ??
        project.createdAt ??
        null,
    };
    const logicalKey = deriveLogicalProjectKey(project, { groupingMode: input.groupingMode });
    const members = membersByLogicalKey.get(logicalKey) ?? [];
    members.push(member);
    membersByLogicalKey.set(logicalKey, members);
  }

  const usedKeys = new Set<string>();
  const rows: ProjectListRow[] = [];
  for (const [logicalKey, members] of membersByLogicalKey) {
    const environmentIds = new Set(members.map((member) => member.project.environmentId));
    const merges =
      !ambiguousKeys.has(logicalKey) &&
      environmentIds.size >= 2 &&
      environmentIds.size === members.length;
    if (!merges) {
      for (const member of members) {
        rows.push({
          key: claimKey(
            usedKeys,
            member.physicalKey,
            scopedKey(member.project.environmentId, member.project.id),
          ),
          title: member.project.name || "Untitled project",
          customAvatarContentHash: member.project.customAvatarContentHash ?? null,
          path: member.project.cwd,
          machines: [member.machine],
          worktreeCount: member.worktreeCount,
          threadCount: member.threadCount,
          updatedAt: member.updatedAt,
          open: { environmentId: member.project.environmentId, projectId: member.project.id },
        });
      }
      continue;
    }

    const representative = members.reduce((best, candidate) =>
      parseTime(candidate.updatedAt) > parseTime(best.updatedAt) ? candidate : best,
    );
    const label = deriveProjectGroupLabel({
      representative: representative.project,
      members: members.map((member) => member.project),
    });
    rows.push({
      key: claimKey(
        usedKeys,
        logicalKey,
        scopedKey(representative.project.environmentId, representative.project.id),
      ),
      title: label || "Untitled project",
      customAvatarContentHash: representative.project.customAvatarContentHash ?? null,
      path: representative.project.cwd,
      machines: [
        representative.machine,
        ...members
          .filter((member) => member !== representative)
          .map((member) => member.machine)
          .toSorted((left, right) => left.label.localeCompare(right.label)),
      ],
      worktreeCount: members.reduce((total, member) => total + member.worktreeCount, 0),
      threadCount: members.reduce((total, member) => total + member.threadCount, 0),
      updatedAt:
        members
          .map((member) => member.updatedAt)
          .filter((value): value is string => value !== null)
          .toSorted((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null,
      open: {
        environmentId: representative.project.environmentId,
        projectId: representative.project.id,
      },
    });
  }

  // parseTime keeps the comparator total when a row has no timestamp at all —
  // NaN deltas would make it intransitive and the order permutation-dependent.
  return rows.toSorted((left, right) => {
    const leftTime = parseTime(left.updatedAt);
    const rightTime = parseTime(right.updatedAt);
    if (leftTime !== rightTime) return rightTime > leftTime ? 1 : -1;
    return left.title.localeCompare(right.title);
  });
}

/**
 * The one-line status a machine entry renders: the wave 2 cache-provenance
 * detail when the rows are last-known, otherwise the live connection state in
 * the vocabulary the node headers used before rows carried their own machines.
 */
export function projectMachineStatusLabel(machine: ProjectRowMachine): string {
  return (
    machine.staleDetail ??
    (machine.connectionState === "connected"
      ? "Connected"
      : machine.connectionState === "read-only"
        ? "Read-only"
        : machine.connectionState === "reconnecting"
          ? "Reconnecting"
          : "Offline")
  );
}

/** Machines and access restrictions remain part of the spoken row summary. */
export function projectRowAccessibilityLabel(row: ProjectListRow): string {
  const parts = [
    `${row.title}, ${row.worktreeCount} worktree${row.worktreeCount === 1 ? "" : "s"}, ${row.threadCount} task${row.threadCount === 1 ? "" : "s"}`,
  ];
  if (row.machines.length > 0) {
    parts.push(
      `on ${row.machines
        .map((machine) => {
          const status =
            machine.connectionState !== "connected" || machine.stale
              ? `, ${projectMachineStatusLabel(machine)}`
              : "";
          return `${machine.label}${status}`;
        })
        .join(", ")}`,
    );
  }
  if (row.machines.some((machine) => machine.role === "viewer")) parts.push("Viewer");
  return parts.join(", ");
}
