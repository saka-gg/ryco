import type { EnvironmentId } from "@ryco/contracts";

import type { InboxProjectFilter } from "./inboxFilterStore";
import type { InboxSidebarRow } from "./inboxSidebarModel";

/** A row menu item that narrows the Inbox to the row's project or machine. */
export type InboxRowFilterAction = {
  readonly label: string;
  /** The Inbox is already narrowed to it: choosing the item shows everything again. */
  readonly active: boolean;
} & (
  | { readonly kind: "project"; readonly project: InboxProjectFilter }
  | { readonly kind: "machine"; readonly environmentId: EnvironmentId }
);

/**
 * Offered only while the Inbox spans more than one project or machine. A chat
 * has no project to narrow to. `projectKey` is the row's logical project key.
 */
export function inboxRowFilterActions(
  row: Pick<
    InboxSidebarRow,
    "environmentId" | "machineLabel" | "projectLabel" | "isChat" | "showProject" | "spansMachines"
  >,
  projectKey: string | null,
  filters: { readonly projectKey: string | null; readonly environmentId: EnvironmentId | null },
): ReadonlyArray<InboxRowFilterAction> {
  const actions: InboxRowFilterAction[] = [];
  if (projectKey !== null && !row.isChat && row.showProject) {
    const active = filters.projectKey === projectKey;
    actions.push({
      kind: "project",
      label: active ? "Show all projects" : `Filter by ${row.projectLabel}`,
      active,
      project: { logicalKey: projectKey, label: row.projectLabel },
    });
  }
  if (row.spansMachines) {
    const active = filters.environmentId === row.environmentId;
    actions.push({
      kind: "machine",
      label: active ? "Show all machines" : `Filter by ${row.machineLabel}`,
      active,
      environmentId: row.environmentId,
    });
  }
  return actions;
}
