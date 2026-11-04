import {
  CopyIcon,
  Edit3Icon,
  FolderPlusIcon,
  FolderOpenIcon,
  LinkIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { DeviceIcon } from "../DeviceIcon";
import { AtlassianJiraIcon } from "../Icons";
import type { CrossNodeProjectActions } from "../projectNodes/projectNodesDialogStore";
import { displayProjectPath } from "../../lib/projectPaths";
import { scopedProjectKey, scopeProjectRef } from "@ryco/client-runtime/scoped";
import { MenuGroup, MenuItem, MenuSeparator } from "../ui/menu";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { formatProjectMemberActionLabel } from "./sidebarProjectGroupingLabels";
import {
  resolveProjectRemoteLink,
  resolveRepositoryProviderIcon,
} from "./sidebarProjectRemoteLink";

export function ProjectSettingsMenu(props: {
  jiraProjectOpenUrlByProjectKey: ReadonlyMap<string, string>;
  project: SidebarProjectSnapshot;
  onCopyPath: (member: SidebarProjectGroupMember) => void;
  onGrouping: (member: SidebarProjectGroupMember) => void;
  onNewFolderWithProject: (project: SidebarProjectSnapshot) => void;
  onOpenJiraProject: (member: SidebarProjectGroupMember) => void;
  onOpenOverview: () => void;
  onOpenRemote: (member: SidebarProjectGroupMember) => void;
  onRemove: (member: SidebarProjectGroupMember) => void;
  onRename: (member: SidebarProjectGroupMember) => void;
  onSettings: (member: SidebarProjectGroupMember) => void;
  /** Copy and link across nodes; left unset where the menu must not offer them (the phone tier). */
  crossNodeActions?: CrossNodeProjectActions | undefined;
}) {
  const crossNode = props.crossNodeActions ? (
    <CrossNodeMenuSection project={props.project} actions={props.crossNodeActions} />
  ) : null;
  const renderActions = (member: SidebarProjectGroupMember) => {
    const remoteLink = resolveProjectRemoteLink(
      member.repositoryIdentity,
      member.preferredRemoteName,
    );
    const jiraProjectUrl =
      props.jiraProjectOpenUrlByProjectKey.get(
        scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
      ) ?? null;
    const RemoteIcon = resolveRepositoryProviderIcon(remoteLink?.provider);
    return (
      <>
        <MenuItem onClick={() => props.onSettings(member)} className="min-h-7 py-1 sm:text-xs">
          <SettingsIcon className="size-3.5" />
          Project settings
        </MenuItem>
        {remoteLink ? (
          <MenuItem onClick={() => props.onOpenRemote(member)} className="min-h-7 py-1 sm:text-xs">
            <RemoteIcon className="size-3.5" />
            Open remote
          </MenuItem>
        ) : null}
        {jiraProjectUrl ? (
          <MenuItem
            onClick={() => props.onOpenJiraProject(member)}
            className="min-h-7 py-1 sm:text-xs"
          >
            <AtlassianJiraIcon className="size-3.5" />
            Open Jira project
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => props.onRename(member)} className="min-h-7 py-1 sm:text-xs">
          <Edit3Icon className="size-3.5" />
          Rename project
        </MenuItem>
        <MenuItem onClick={() => props.onGrouping(member)} className="min-h-7 py-1 sm:text-xs">
          <SettingsIcon className="size-3.5" />
          Project grouping...
        </MenuItem>
        <MenuItem onClick={() => props.onCopyPath(member)} className="min-h-7 py-1 sm:text-xs">
          <CopyIcon className="size-3.5" />
          Copy Project Path
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={() => props.onRemove(member)}
          variant="destructive"
          className="min-h-7 py-1 sm:text-xs"
        >
          <Trash2Icon className="size-3.5" />
          Remove project
        </MenuItem>
      </>
    );
  };

  if (props.project.memberProjects.length === 1) {
    return (
      <MenuGroup>
        <MenuItem onClick={props.onOpenOverview} className="min-h-7 py-1 sm:text-xs">
          <FolderOpenIcon className="size-3.5" />
          Project overview
        </MenuItem>
        <MenuItem
          onClick={() => props.onNewFolderWithProject(props.project)}
          className="min-h-7 py-1 sm:text-xs"
        >
          <FolderPlusIcon className="size-3.5" />
          New folder with project
        </MenuItem>
        {crossNode}
        <MenuSeparator />
        {renderActions(props.project.memberProjects[0]!)}
      </MenuGroup>
    );
  }

  return (
    <>
      <MenuGroup>
        <MenuItem onClick={props.onOpenOverview} className="min-h-7 py-1 sm:text-xs">
          <FolderOpenIcon className="size-3.5" />
          Project overview
        </MenuItem>
        <MenuItem
          onClick={() => props.onNewFolderWithProject(props.project)}
          className="min-h-7 py-1 sm:text-xs"
        >
          <FolderPlusIcon className="size-3.5" />
          New folder with grouped project
        </MenuItem>
        {crossNode}
      </MenuGroup>
      <MenuSeparator />
      {props.project.memberProjects.map((member, index) => (
        <MenuGroup key={member.physicalProjectKey}>
          <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
            {formatProjectMemberActionLabel(member, props.project.groupedProjectCount)}
          </div>
          {renderActions(member)}
          {index < props.project.memberProjects.length - 1 ? <MenuSeparator /> : null}
        </MenuGroup>
      ))}
    </>
  );
}

/**
 * "Copy to another node…" (new), "Link a copy that's already on a node…", and
 * where the project is now: one row per checkout with its node and path. Only
 * this DOM kebab lists the checkouts; native menus have just the two actions.
 */
function CrossNodeMenuSection(props: {
  readonly project: SidebarProjectSnapshot;
  readonly actions: CrossNodeProjectActions;
}) {
  const members = props.project.memberProjects;
  const nodeCount = new Set(members.map((member) => member.environmentId)).size;
  return (
    <>
      <MenuSeparator />
      <MenuItem
        onClick={props.actions.onCopy}
        onPointerEnter={props.actions.onCopyIntent}
        onFocus={props.actions.onCopyIntent}
        className="min-h-7 py-1 sm:text-xs"
      >
        <CopyIcon className="size-3.5" />
        Copy to another node…
        <span className="ms-auto rounded-full bg-primary px-1.5 py-px font-medium text-[10px] text-primary-foreground">
          New
        </span>
      </MenuItem>
      <MenuItem onClick={props.actions.onLink} className="min-h-7 py-1 sm:text-xs">
        <LinkIcon className="size-3.5" />
        Link a copy that’s already on a node…
      </MenuItem>
      <MenuSeparator />
      <div
        role="group"
        aria-label={`On ${nodeCount} node${nodeCount === 1 ? "" : "s"}`}
        data-testid="project-menu-nodes"
      >
        <div className="px-2 pt-1 pb-0.5 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
          On {nodeCount} node{nodeCount === 1 ? "" : "s"}
        </div>
        {members.map((member) => {
          const label = member.environmentLabel ?? "This device";
          return (
            <div
              key={member.physicalProjectKey}
              className="flex min-w-0 items-center gap-[7px] px-2 py-[3px] text-[11.5px] text-muted-foreground"
            >
              <DeviceIcon
                environmentId={member.environmentId}
                label={label}
                className="size-3 shrink-0"
              />
              <span className="truncate">{label}</span>
              <span
                className="ms-auto max-w-[120px] truncate font-mono text-[11px]"
                title={member.cwd}
              >
                {displayProjectPath(member.cwd)}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
