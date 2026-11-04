import React, { useCallback } from "react";
import { scopedProjectKey, scopeProjectRef } from "@ryco/client-runtime/scoped";
import { type ContextMenuItem } from "@ryco/contracts";
import { readLocalApi } from "../../../localApi";
import type { CrossNodeProjectActions } from "../../projectNodes/projectNodesDialogStore";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import { formatProjectMemberActionLabel } from "../sidebarProjectGroupingLabels";
import { resolveProjectRemoteLink } from "../sidebarProjectRemoteLink";

export function useSidebarProjectContextMenu(params: {
  project: SidebarProjectSnapshot;
  jiraProjectOpenUrlByProjectKey: ReadonlyMap<string, string>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  onOpenOverview: () => void;
  openProjectSettingsDialog: (member: SidebarProjectGroupMember) => void;
  openProjectRemoteLink: (member: SidebarProjectGroupMember) => void;
  openProjectJiraLink: (member: SidebarProjectGroupMember) => void;
  openProjectRenameDialog: (member: SidebarProjectGroupMember) => void;
  openProjectGroupingDialog: (member: SidebarProjectGroupMember) => void;
  copyPathToClipboard: (value: string, ctx: { path: string }) => void;
  handleRemoveProject: (member: SidebarProjectGroupMember) => Promise<void>;
  /** Copy and link across nodes; left unset where the menu must not offer them (the phone tier). */
  crossNodeActions?: CrossNodeProjectActions | undefined;
}) {
  const {
    project,
    jiraProjectOpenUrlByProjectKey,
    suppressProjectClickForContextMenuRef,
    onOpenOverview,
    openProjectSettingsDialog,
    openProjectRemoteLink,
    openProjectJiraLink,
    openProjectRenameDialog,
    openProjectGroupingDialog,
    copyPathToClipboard,
    handleRemoveProject,
    crossNodeActions,
  } = params;

  // The shared opener: builds the single project action inventory and
  // dispatches the clicked handler. The desktop right-click handler and the
  // phone header kebab/long-press both present this inventory (through the
  // native menu, the DOM fallback, or the phone action sheet respectively).
  const openProjectMenu = useCallback(
    (position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;

        const actionHandlers = new Map<string, () => Promise<void> | void>();
        actionHandlers.set("project-overview", () => {
          onOpenOverview();
        });
        crossNodeActions?.onIntent?.();
        // A native menu has no hover to listen to: its opening is the copy's intent too.
        crossNodeActions?.onCopyIntent?.();
        if (crossNodeActions) {
          actionHandlers.set("copy-to-node", crossNodeActions.onCopy);
          actionHandlers.set("link-node-copy", crossNodeActions.onLink);
        }
        const makeLeaf = (
          action:
            | "settings"
            | "open-remote"
            | "open-jira"
            | "rename"
            | "grouping"
            | "copy-path"
            | "delete",
          member: SidebarProjectGroupMember,
          options?: {
            destructive?: boolean;
            disabled?: boolean;
          },
        ): ContextMenuItem<string> => {
          const id = `${action}:${member.physicalProjectKey}`;
          actionHandlers.set(id, () => {
            switch (action) {
              case "settings":
                openProjectSettingsDialog(member);
                return;
              case "open-remote":
                openProjectRemoteLink(member);
                return;
              case "open-jira":
                openProjectJiraLink(member);
                return;
              case "rename":
                openProjectRenameDialog(member);
                return;
              case "grouping":
                openProjectGroupingDialog(member);
                return;
              case "copy-path":
                copyPathToClipboard(member.cwd, { path: member.cwd });
                return;
              case "delete":
                return handleRemoveProject(member);
            }
          });

          return {
            id,
            label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
            ...(options?.destructive ? { destructive: true } : {}),
            ...(options?.disabled ? { disabled: true } : {}),
          };
        };

        const buildTargetedItem = (
          action:
            | "settings"
            | "open-remote"
            | "open-jira"
            | "rename"
            | "grouping"
            | "copy-path"
            | "delete",
          label: string,
          options?: {
            destructive?: boolean;
            isDisabled?: (member: SidebarProjectGroupMember) => boolean;
          },
        ): ContextMenuItem<string> => {
          if (project.memberProjects.length === 1) {
            const singleMember = project.memberProjects[0]!;
            return {
              ...makeLeaf(action, singleMember, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(singleMember) ? { disabled: true } : {}),
              }),
              label,
            };
          }

          return {
            id: `${action}:submenu`,
            label,
            children: project.memberProjects.map((member) =>
              makeLeaf(action, member, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(member) ? { disabled: true } : {}),
              }),
            ),
          };
        };

        const hasAnyRemoteLink = project.memberProjects.some(
          (member) =>
            resolveProjectRemoteLink(member.repositoryIdentity, member.preferredRemoteName) !==
            null,
        );
        const hasAnyJiraProjectLink = project.memberProjects.some((member) =>
          jiraProjectOpenUrlByProjectKey.has(
            scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
          ),
        );
        const menuItems: ContextMenuItem<string>[] = [
          { id: "project-overview", label: "Project overview" },
          buildTargetedItem("settings", "Project settings"),
          ...(hasAnyRemoteLink
            ? [
                buildTargetedItem("open-remote", "Open remote", {
                  isDisabled: (member) =>
                    resolveProjectRemoteLink(
                      member.repositoryIdentity,
                      member.preferredRemoteName,
                    ) === null,
                }),
              ]
            : []),
          ...(hasAnyJiraProjectLink
            ? [
                buildTargetedItem("open-jira", "Open Jira project", {
                  isDisabled: (member) =>
                    !jiraProjectOpenUrlByProjectKey.has(
                      scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
                    ),
                }),
              ]
            : []),
          buildTargetedItem("rename", "Rename project"),
          ...(crossNodeActions
            ? [
                { id: "copy-to-node", label: "Copy to another node…" },
                { id: "link-node-copy", label: "Link a copy that’s already on a node…" },
              ]
            : []),
          buildTargetedItem("grouping", "Project grouping…"),
          buildTargetedItem("copy-path", "Copy Project Path"),
          buildTargetedItem("delete", "Remove project", {
            destructive: true,
          }),
        ];

        const clicked = await api.contextMenu.show(menuItems, position);

        if (!clicked) {
          return;
        }

        await actionHandlers.get(clicked)?.();
      })();
    },
    [
      copyPathToClipboard,
      crossNodeActions,
      handleRemoveProject,
      jiraProjectOpenUrlByProjectKey,
      onOpenOverview,
      openProjectGroupingDialog,
      openProjectJiraLink,
      openProjectRemoteLink,
      openProjectRenameDialog,
      openProjectSettingsDialog,
      project.groupedProjectCount,
      project.memberProjects,
    ],
  );

  const handleProjectButtonContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      suppressProjectClickForContextMenuRef.current = true;
      openProjectMenu({ x: event.clientX, y: event.clientY });
    },
    [openProjectMenu, suppressProjectClickForContextMenuRef],
  );

  return { handleProjectButtonContextMenu, openProjectMenu };
}
