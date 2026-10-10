import type { AgentControlAutomationId, EnvironmentId, ProjectId } from "@ryco/contracts";

import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";

/** Which project the Automations dialog opens on. */
export type AutomationsDialogProjectTarget =
  /** A logical project (the sidebar's `projectKey`). */
  | { readonly kind: "key"; readonly projectKey: string }
  /** The logical project holding this checkout. */
  | {
      readonly kind: "checkout";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    }
  /** The project the dialog showed last. */
  | { readonly kind: "last" };

/**
 * `view` selects the schedule (or the first waiting one), `edit` opens the
 * editor on `automationId`, `new` opens a blank editor.
 */
export type AutomationsDialogMode = "view" | "edit" | "new";

/** One open request, normalized. */
export interface AutomationsDialogRequest {
  readonly project: AutomationsDialogProjectTarget;
  readonly automationId: AgentControlAutomationId | null;
  readonly mode: AutomationsDialogMode;
  /** The device a new schedule is for; null leaves the choice to the dialog. */
  readonly environmentId: EnvironmentId | null;
}

/**
 * The project the dialog showed last. The logical key can change with the
 * grouping settings, so a checkout of it is kept too.
 */
export interface AutomationsDialogProjectMemory {
  readonly projectKey: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function rememberedAutomationsProject(
  snapshot: SidebarProjectSnapshot,
): AutomationsDialogProjectMemory {
  return {
    projectKey: snapshot.projectKey,
    environmentId: snapshot.environmentId,
    projectId: snapshot.id,
  };
}

function snapshotWithCheckout(
  snapshots: readonly SidebarProjectSnapshot[],
  environmentId: EnvironmentId,
  projectId: ProjectId,
): SidebarProjectSnapshot | null {
  return (
    snapshots.find((snapshot) =>
      snapshot.memberProjects.some(
        (member) => member.environmentId === environmentId && member.id === projectId,
      ),
    ) ?? null
  );
}

function rememberedSnapshot(
  snapshots: readonly SidebarProjectSnapshot[],
  last: AutomationsDialogProjectMemory | null,
): SidebarProjectSnapshot | null {
  if (!last) return null;
  return (
    snapshots.find((snapshot) => snapshot.projectKey === last.projectKey) ??
    snapshotWithCheckout(snapshots, last.environmentId, last.projectId)
  );
}

/**
 * The project a request lands on: the named one when it still exists, else
 * the last one shown, else the first project. Null only with no projects.
 */
export function resolveAutomationsDialogProject(input: {
  readonly snapshots: readonly SidebarProjectSnapshot[];
  readonly target: AutomationsDialogProjectTarget;
  readonly last: AutomationsDialogProjectMemory | null;
}): SidebarProjectSnapshot | null {
  const { snapshots, target, last } = input;
  const named =
    target.kind === "key"
      ? (snapshots.find((snapshot) => snapshot.projectKey === target.projectKey) ?? null)
      : target.kind === "checkout"
        ? snapshotWithCheckout(snapshots, target.environmentId, target.projectId)
        : null;
  return named ?? rememberedSnapshot(snapshots, last) ?? snapshots[0] ?? null;
}

/**
 * The device a new schedule starts on: the one asked for, else the checkout
 * the request named, as long as the project has a checkout there.
 */
export function automationsDialogDevice(
  snapshot: SidebarProjectSnapshot,
  request: Pick<AutomationsDialogRequest, "project" | "environmentId">,
): EnvironmentId | null {
  const asked =
    request.environmentId ??
    (request.project.kind === "checkout" ? request.project.environmentId : null);
  if (!asked) return null;
  return snapshot.memberProjects.some((member) => member.environmentId === asked) ? asked : null;
}
