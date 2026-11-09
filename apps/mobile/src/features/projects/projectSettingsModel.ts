import { ATLASSIAN_NONE_VALUE } from "@ryco/client-runtime/projectSettings/atlassianLink";
import {
  diskSizeOf,
  diskText,
  formatDiskSize,
  sumDiskSizes,
  type DiskSize,
  type DiskUsageReading,
} from "@ryco/client-runtime/projectSettings/diskUsage";
import {
  PROJECT_SECTION_GROUPS,
  PROJECT_SECTION_LABELS,
  visibleProjectSections,
  type ProjectSection,
} from "@ryco/client-runtime/projectSettings/sections";
import {
  availableWorkspaceActions,
  workspaceFacts,
  type WorkspaceFact,
} from "@ryco/client-runtime/projectSettings/workspaces";
import type { WorkspaceActionId } from "@ryco/client-runtime/state/lifecycle";
import type { Project } from "@ryco/client-runtime/state/threads";
import type {
  EnvironmentId,
  ProjectId,
  ProjectScriptIcon,
  WorkspaceLifecycleSummary,
  WorktreeId,
} from "@ryco/contracts";
import {
  ORCHESTRATION_WS_METHODS,
  PROJECT_CUSTOM_SYSTEM_PROMPT_MAX_CHARS,
} from "@ryco/contracts/orchestration";
import { WS_METHODS } from "@ryco/contracts/rpc";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import type { SFSymbol } from "expo-symbols";

import { nodeRoleAllows } from "../../connection/nodeRoleAccess";
import { validateNodeWorkspacePath, workspaceActionErrorMessage } from "./projectActions";
import { deriveLogicalProjectKey } from "../../lib/logicalProject";
import type { InboxEnvironment } from "../inbox/inboxModel";
import { canChangeNodeSettings } from "../settings/nodeSettingsTargets";

// ---------------------------------------------------------------------------
// Access

type AccessEnvironment = Pick<
  InboxEnvironment,
  "label" | "connectionState" | "role" | "mutationReady" | "stale"
>;

export interface ProjectSettingsAccess {
  /** Project writes (`project.*` commands, scripts, workspaces) can run now. */
  readonly canEdit: boolean;
  /** Why not, stated once under the header. */
  readonly reason: string | null;
  /** The machine's own settings for this project (new-task defaults, Atlassian link). */
  readonly canManageNode: boolean;
  /** Why only the machine's own settings are out of reach, when project writes are fine. */
  readonly nodeReason: string | null;
  /** The reader may inspect workspaces (Git state, disk usage) on the machine. */
  readonly canInspectWorkspaces: boolean;
  /** The reader may change workspaces (archive, restore, delete) right now. */
  readonly canChangeWorkspaces: boolean;
}

/** An unknown role is not refused here: the node enforces it, as for every other write. */
const roleAllows = (role: AccessEnvironment["role"], method: string) =>
  role === undefined || nodeRoleAllows(role, method);

/**
 * Whether this phone can change a project on its machine right now, and why not. One answer per
 * checkout, so the screen says the reason once instead of on every dimmed control: the role on
 * the machine (a viewer can look, not change), then whether the machine is live and synced.
 */
export function projectSettingsAccess(
  environment: AccessEnvironment | null | undefined,
): ProjectSettingsAccess {
  const readOnly = (reason: string, canInspectWorkspaces = false): ProjectSettingsAccess => ({
    canEdit: false,
    reason,
    canManageNode: false,
    nodeReason: null,
    canInspectWorkspaces,
    canChangeWorkspaces: false,
  });
  if (!environment) return readOnly("This machine is not connected to this phone.");
  const { label } = environment;
  const canInspect =
    (environment.connectionState === "connected" || environment.connectionState === "read-only") &&
    roleAllows(environment.role, WS_METHODS.lifecyclePreviewWorkspace);
  if (
    environment.connectionState === "read-only" ||
    !roleAllows(environment.role, ORCHESTRATION_WS_METHODS.dispatchCommand)
  ) {
    return readOnly(`Your access to ${label} is view-only.`, canInspect);
  }
  switch (environment.connectionState) {
    case "reconnecting":
      return readOnly(`Connecting to ${label}…`);
    case "offline":
      return readOnly(
        environment.stale
          ? `${label} is offline. This is a cached copy; changes need a live connection.`
          : `${label} is offline. Reconnect it to make changes.`,
      );
    case "connected":
      break;
  }
  if (environment.mutationReady === false) return readOnly(`Connecting to ${label}…`, canInspect);
  const canManageNode = canChangeNodeSettings(environment);
  return {
    canEdit: true,
    reason: null,
    canManageNode,
    nodeReason: canManageNode
      ? null
      : `Only the owner of ${label} can change new-task defaults and the Jira & Bitbucket link.`,
    canInspectWorkspaces: canInspect,
    canChangeWorkspaces:
      canInspect && roleAllows(environment.role, WS_METHODS.lifecycleApplyWorkspace),
  };
}

// ---------------------------------------------------------------------------
// Sections

/**
 * The phone's names where its own words differ: it calls devices machines and threads tasks
 * everywhere else, so the settings say so too.
 */
const PHONE_SECTION_LABELS: Partial<Record<ProjectSection, string>> = {
  devices: "Machines",
  defaults: "New tasks",
};

/** Sections that need the desktop: automations are edited in the Automations dialog there. */
const PHONE_UNSUPPORTED_SECTIONS: ReadonlySet<ProjectSection> = new Set(["automations"]);

export function projectSectionLabel(section: ProjectSection): string {
  return PHONE_SECTION_LABELS[section] ?? PROJECT_SECTION_LABELS[section];
}

export interface ProjectSettingsGroup {
  readonly label: string | null;
  readonly sections: readonly ProjectSection[];
}

/**
 * The sections the phone shows, grouped and ordered as on the web. Owner-only sections leave
 * when the reader cannot manage the machine; a group left empty goes too.
 */
export function projectSettingsGroups(input: {
  readonly canManageNode: boolean;
}): readonly ProjectSettingsGroup[] {
  const visible = new Set(visibleProjectSections(input));
  return PROJECT_SECTION_GROUPS.map((group) => ({
    label: group.label,
    sections: group.sections.filter(
      (section) => visible.has(section) && !PHONE_UNSUPPORTED_SECTIONS.has(section),
    ),
  })).filter((group) => group.sections.length > 0);
}

// ---------------------------------------------------------------------------
// Machines (checkouts)

type MachineEnvironment = Pick<
  InboxEnvironment,
  "environmentId" | "label" | "connectionState" | "stale"
>;

export interface ProjectCheckoutRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
  readonly path: string;
  readonly status: string;
  readonly current: boolean;
}

export interface ProjectMissingMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

function machineStatus(environment: MachineEnvironment | undefined): string {
  if (!environment) return "Unknown machine";
  switch (environment.connectionState) {
    case "connected":
      return "Online";
    case "read-only":
      return "Online · view-only";
    case "reconnecting":
      return "Connecting";
    case "offline":
      return environment.stale ? "Offline · cached" : "Offline";
  }
}

/**
 * Where this project is checked out, and which known machines lack it. Checkouts are the
 * projects that share its repository (the logical key the project list merges by); a project
 * without a repository identity is only on its own machine. A machine is said to lack the
 * project only once its project list has arrived (it is online), never while it is offline or
 * still syncing.
 */
export function projectCheckouts(input: {
  readonly project: Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">;
  readonly projects: ReadonlyArray<Project>;
  readonly environments: ReadonlyArray<MachineEnvironment>;
}): {
  readonly checkouts: readonly ProjectCheckoutRow[];
  readonly missing: readonly ProjectMissingMachine[];
} {
  const key = deriveLogicalProjectKey(input.project, { groupingMode: "repository" });
  const members = excludeChatProjects(input.projects).filter(
    (candidate) =>
      (candidate.environmentId === input.project.environmentId &&
        candidate.id === input.project.id) ||
      deriveLogicalProjectKey(candidate, { groupingMode: "repository" }) === key,
  );
  const environmentsById = new Map(
    input.environments.map((environment) => [environment.environmentId, environment]),
  );
  const checkouts = members
    .map((member) => {
      const environment = environmentsById.get(member.environmentId);
      const current =
        member.environmentId === input.project.environmentId && member.id === input.project.id;
      return {
        key: `${member.environmentId}:${member.id}`,
        environmentId: member.environmentId,
        projectId: member.id,
        label: environment?.label ?? "Unknown machine",
        path: member.cwd,
        status: machineStatus(environment),
        current,
      };
    })
    // The checkout being edited first, then by machine name.
    .toSorted(
      (left, right) =>
        Number(right.current) - Number(left.current) || left.label.localeCompare(right.label),
    );
  const projectEnvironmentIds = new Set<string>(members.map((member) => member.environmentId));
  const seen = new Set<string>();
  const missing: ProjectMissingMachine[] = [];
  for (const environment of input.environments) {
    if (
      environment.connectionState !== "connected" ||
      environment.stale === true ||
      projectEnvironmentIds.has(environment.environmentId) ||
      seen.has(environment.environmentId)
    ) {
      continue;
    }
    seen.add(environment.environmentId);
    missing.push({ environmentId: environment.environmentId, label: environment.label });
  }
  return { checkouts, missing };
}

/** The route the project copy flow opens with: from this checkout, to the machine picked. */
export interface CopyProjectRouteParams {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly targetEnvironmentId: EnvironmentId;
}

export function copyProjectRouteParams(
  source: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
  target: { readonly environmentId: EnvironmentId },
): CopyProjectRouteParams {
  return {
    environmentId: source.environmentId,
    projectId: source.projectId,
    targetEnvironmentId: target.environmentId,
  };
}

// ---------------------------------------------------------------------------
// Location

export type ProjectRootChange =
  | { readonly kind: "unchanged" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "move"; readonly next: string };

/**
 * What a typed project root would do: nothing (empty or the same folder), a refusal (not a path
 * the machine can take), or a move. The machine owns the filesystem; the phone only checks the
 * path is absolute.
 */
export function checkProjectRoot(current: string, draft: string): ProjectRootChange {
  const trimmed = draft.trim();
  if (trimmed.length === 0 || trimmed === current) return { kind: "unchanged" };
  try {
    return { kind: "move", next: validateNodeWorkspacePath(trimmed) };
  } catch (error) {
    return { kind: "invalid", message: workspaceActionErrorMessage("add-project", error) };
  }
}

// ---------------------------------------------------------------------------
// Agent instructions

export const INSTRUCTIONS_MAX_CHARS = PROJECT_CUSTOM_SYSTEM_PROMPT_MAX_CHARS;

export interface InstructionsDraftView {
  readonly value: string;
  /** Save and Revert show only while the draft differs from the saved text. */
  readonly dirty: boolean;
  readonly counter: string;
  readonly counterTone: "muted" | "warning" | "danger";
  /** The longest instructions the machine accepts. */
  readonly max: number;
  /** What Save writes: the trimmed text, or null to clear the instructions. */
  readonly next: string | null;
}

export function instructionsDraftView(
  saved: string | null | undefined,
  draft: string | null,
): InstructionsDraftView {
  const savedText = saved ?? "";
  const value = draft ?? savedText;
  const trimmed = value.trim();
  const length = value.length;
  return {
    value,
    dirty: draft !== null && trimmed !== savedText.trim(),
    counter: `${length.toLocaleString("en-US")} / ${INSTRUCTIONS_MAX_CHARS.toLocaleString("en-US")}`,
    counterTone:
      length >= INSTRUCTIONS_MAX_CHARS
        ? "danger"
        : length >= Math.floor(INSTRUCTIONS_MAX_CHARS * 0.9)
          ? "warning"
          : "muted",
    max: INSTRUCTIONS_MAX_CHARS,
    next: trimmed.length > 0 ? trimmed : null,
  } satisfies InstructionsDraftView;
}

// ---------------------------------------------------------------------------
// Actions (scripts)

/** The SF Symbol each action icon shows as. */
export const PROJECT_SCRIPT_SYMBOLS: Readonly<Record<ProjectScriptIcon, SFSymbol>> = {
  play: "play",
  test: "checkmark.circle",
  lint: "list.clipboard",
  configure: "gearshape",
  build: "hammer",
  debug: "ladybug",
};

// ---------------------------------------------------------------------------
// Workspaces

export interface ProjectWorkspaceRow {
  readonly worktreeId: WorktreeId;
  readonly title: string;
  readonly branch: string;
  readonly archived: boolean;
  readonly facts: readonly WorkspaceFact[];
  /** Its space on disk ("1.4 GB"), or null when unmeasured or removed. */
  readonly disk: string | null;
  readonly actions: readonly WorkspaceActionId[];
}

export interface ProjectWorkspacesView {
  readonly rows: readonly ProjectWorkspaceRow[];
  /** Every checkout on disk together, main included ("1.4 GB", "Measuring…"). */
  readonly diskTotal: string;
  readonly diskPartial: boolean;
}

/**
 * The project's workspaces as the machine inspected them, with what each takes on disk. The
 * main checkout is never a workspace row; it counts toward the total.
 */
export function projectWorkspacesView(input: {
  readonly summaries: ReadonlyArray<WorkspaceLifecycleSummary>;
  readonly disk: DiskUsageReading;
}): ProjectWorkspacesView {
  const usageById = new Map(
    input.disk.status === "ready"
      ? input.disk.workspaces.map((usage) => [usage.worktreeId as string, usage])
      : [],
  );
  const sizeOf = (worktreeId: string): DiskSize | null => {
    const usage = usageById.get(worktreeId);
    return usage ? diskSizeOf(usage) : null;
  };
  const rows = input.summaries
    .filter((summary) => !summary.main)
    .map((summary) => {
      const size = summary.checkout === "removed" ? null : sizeOf(summary.worktreeId);
      return {
        worktreeId: summary.worktreeId,
        title: summary.title.trim() || summary.branch,
        branch: summary.branch,
        archived: summary.archivedAt !== null,
        facts: workspaceFacts(summary),
        disk: size ? formatDiskSize(size) : null,
        actions: availableWorkspaceActions(summary),
      };
    });
  const total =
    input.disk.status === "ready"
      ? sumDiskSizes(input.disk.workspaces.map((usage) => ({ disk: diskSizeOf(usage) })))
      : null;
  return {
    rows,
    diskTotal: diskText(total, input.disk),
    diskPartial: total?.partial === true,
  };
}

/** A workspace row's second line: its branch when the title differs, then what needs care. */
export function workspaceRowDetail(row: ProjectWorkspaceRow): string | undefined {
  const parts = [
    row.branch !== row.title ? row.branch : null,
    row.archived ? "Archived" : null,
    ...row.facts.map((fact) => fact.label),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The "also delete conversations" switch. The phone has no undo for deleted conversations, so it
 * says they go with the workspace rather than promising one.
 */
export function workspaceReviewConversationCopy(
  count: number,
  deleting: boolean,
): { readonly label: string; readonly detail: string } {
  return {
    label: `Also delete ${count} conversation${count === 1 ? "" : "s"}`,
    detail: deleting ? "They are deleted with the workspace." : "They stay in the archive.",
  };
}

/** The menu a workspace row opens: Archive or Restore, then Delete workspace… */
export function workspaceActionLabel(action: WorkspaceActionId): string {
  switch (action) {
    case "archive":
      return "Archive";
    case "restore":
      return "Restore";
    case "delete-workspace":
      return "Delete workspace…";
  }
}

// ---------------------------------------------------------------------------
// Jira & Bitbucket

/** A connection picker's value as its row says it. */
export function atlassianConnectionLabel(
  value: string,
  connections: ReadonlyArray<{ readonly connectionId: string; readonly label: string }>,
): string {
  if (value === ATLASSIAN_NONE_VALUE) return "Not linked";
  return connections.find((connection) => connection.connectionId === value)?.label ?? "Unknown";
}

// ---------------------------------------------------------------------------
// Mutation results

export type SettingsWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Runs one write when the machine takes changes, as a result instead of a throw, so screens
 * branch on it without try/catch (which the React Compiler cannot compile).
 */
export async function runSettingsWrite(input: {
  readonly canEdit: boolean;
  readonly write: () => Promise<unknown>;
  /** Said when the write fails without a message of its own. */
  readonly fallback: string;
}): Promise<SettingsWriteResult> {
  if (!input.canEdit) {
    return {
      ok: false,
      message: "This machine is not ready for changes. Reconnect it, then try again.",
    };
  }
  try {
    await input.write();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error && error.message ? error.message : input.fallback,
    };
  }
}
