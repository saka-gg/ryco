import {
  CloudIcon,
  FolderOpenIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SquarePenIcon,
} from "lucide-react";
import { scopedProjectKey } from "@ryco/client-runtime/scoped";
import React from "react";
import { ProjectFavicon } from "../ProjectFavicon";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarMenuButton } from "../ui/sidebar";
import {
  SIDEBAR_ROW_ACTION_COARSE_ANCHORED_CLASS_NAME,
  SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME,
  type ThreadStatusPill,
} from "../Sidebar.logic";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { type SortableProjectHandleProps } from "./SidebarProjectList";
import { ProjectSettingsMenu } from "./ProjectSettingsMenu";
import { SIDEBAR_PROJECT_MEMBERS_ATTRIBUTE } from "../chat/promoteChatDialogStore";

export function SidebarProjectHeader(props: {
  project: SidebarProjectSnapshot;
  isManualProjectSorting: boolean;
  dragHandleProps: SortableProjectHandleProps | null;
  projectExpanded: boolean;
  projectStatus: ThreadStatusPill | null;
  jiraProjectOpenUrlByProjectKey: ReadonlyMap<string, string>;
  setProjectHeaderVisibilityNode: (node: HTMLElement | null) => void;
  onPointerDownCapture: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenProjectOverviewClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenNewWorktreeClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenNewThreadClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onCopyPath: (member: SidebarProjectGroupMember) => void;
  onGrouping: (member: SidebarProjectGroupMember) => void;
  onNewFolderWithProject: (project: SidebarProjectSnapshot) => void;
  onOpenJiraProject: (member: SidebarProjectGroupMember) => void;
  onOpenOverview: () => void;
  onOpenRemote: (member: SidebarProjectGroupMember) => void;
  onRemove: (member: SidebarProjectGroupMember) => void;
  onRename: (member: SidebarProjectGroupMember) => void;
  onSettings: (member: SidebarProjectGroupMember) => void;
}) {
  const {
    project,
    isManualProjectSorting,
    dragHandleProps,
    projectExpanded,
    projectStatus,
    jiraProjectOpenUrlByProjectKey,
    setProjectHeaderVisibilityNode,
    onPointerDownCapture,
    onClick,
    onKeyDown,
    onContextMenu,
    onOpenProjectOverviewClick,
    onOpenNewWorktreeClick,
    onOpenNewThreadClick,
  } = props;

  const memberProjectKeys = React.useMemo(
    () => project.memberProjectRefs.map(scopedProjectKey).join(" "),
    [project.memberProjectRefs],
  );

  return (
    <div ref={setProjectHeaderVisibilityNode} className="group/project-header relative">
      <SidebarMenuButton
        ref={dragHandleProps?.setActivatorNodeRef}
        size="sm"
        className={`gap-2 px-2 py-1.5 pr-26 phone:pointer-coarse:pr-36 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground ${
          isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
        }`}
        {...(dragHandleProps ? dragHandleProps.attributes : {})}
        {...(dragHandleProps ? dragHandleProps.listeners : {})}
        onPointerDownCapture={onPointerDownCapture}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        {...{ [SIDEBAR_PROJECT_MEMBERS_ATTRIBUTE]: memberProjectKeys }}
      >
        {!projectExpanded && projectStatus ? (
          <span
            aria-hidden="true"
            title={projectStatus.label}
            className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
          >
            {projectStatus.pulse ? (
              <span className="status-activity-signal size-[9px]">
                <span className={`size-full rounded-full ${projectStatus.dotClass}`} />
              </span>
            ) : (
              <span className={`size-[9px] rounded-full ${projectStatus.dotClass}`} />
            )}
          </span>
        ) : null}
        <ProjectFavicon
          environmentId={project.environmentId}
          cwd={project.cwd}
          projectId={project.id}
          customAvatarContentHash={project.customAvatarContentHash ?? null}
          className="size-[18px]"
        />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
            {project.displayName}
          </span>
          {project.groupedProjectCount > 1 ? (
            <span className="shrink-0 text-[10px] text-muted-foreground/60">
              {project.groupedProjectCount} projects
            </span>
          ) : null}
        </span>
      </SidebarMenuButton>
      {/* Environment badge – visible by default, crossfades with the
          "new thread" button on hover using the same pointer-events +
          opacity pattern as the thread row archive/timestamp swap. */}
      {project.environmentPresence === "remote-only" && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={
                  project.environmentPresence === "remote-only"
                    ? "Remote project"
                    : "Available in multiple environments"
                }
                className="pointer-events-none absolute top-1 right-1.5 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/60 transition-opacity duration-150 phone:pointer-fine:right-7 phone:pointer-coarse:top-1/2 phone:pointer-coarse:-translate-y-1/2 phone:pointer-coarse:right-31 group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0 phone:group-hover/project-header:opacity-100 phone:group-focus-within/project-header:opacity-100"
              />
            }
          >
            <CloudIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            Remote environment: {project.remoteEnvironmentLabels.join(", ")}
          </TooltipPopup>
        </Tooltip>
      )}
      {/* Opens the composer-first new-thread surface. Hidden on coarse
          pointers: the phone shell has its own new-thread flow (`PhoneHome`)
          and the touch action row is already at capacity. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="pointer-events-none absolute top-1 right-[4.75rem] phone:pointer-coarse:hidden opacity-0 transition-opacity duration-150 phone:pointer-events-auto phone:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
              <button
                type="button"
                aria-label={`Start a new thread in ${project.displayName}`}
                data-testid="new-thread-composer-button"
                className={`inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
                onClick={onOpenNewThreadClick}
              >
                <SquarePenIcon className="size-3.5" />
              </button>
            </div>
          }
        />
        <TooltipPopup side="top">New thread</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="pointer-events-none absolute top-1 right-[3.25rem] phone:pointer-coarse:top-1/2 phone:pointer-coarse:-translate-y-1/2 phone:pointer-coarse:right-23 opacity-0 transition-opacity duration-150 phone:pointer-events-auto phone:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
              <button
                type="button"
                aria-label={`Open project overview for ${project.displayName}`}
                data-testid="project-overview-button"
                className={`inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
                onClick={onOpenProjectOverviewClick}
              >
                <FolderOpenIcon className="size-3.5" />
              </button>
            </div>
          }
        />
        <TooltipPopup side="top">Project overview</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="pointer-events-none absolute top-1 right-7 phone:pointer-coarse:top-1/2 phone:pointer-coarse:-translate-y-1/2 phone:pointer-coarse:right-12 opacity-0 transition-opacity duration-150 phone:pointer-events-auto phone:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
              <button
                type="button"
                aria-label={`Create new workspace in ${project.displayName}`}
                data-testid="new-thread-button"
                className={`inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
                onClick={onOpenNewWorktreeClick}
              >
                <PlusIcon className="size-3.5" />
              </button>
            </div>
          }
        />
        <TooltipPopup side="top">New workspace</TooltipPopup>
      </Tooltip>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                aria-label={`Open project settings for ${project.displayName}`}
                className={`pointer-events-none absolute top-1 right-1.5 phone:pointer-coarse:top-1/2 phone:pointer-coarse:-translate-y-1/2 phone:pointer-coarse:right-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity duration-150 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring phone:pointer-events-auto phone:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100 ${SIDEBAR_ROW_ACTION_COARSE_ANCHORED_CLASS_NAME}`}
              />
            }
          >
            <MoreHorizontalIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Project settings</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side="bottom" className="min-w-48">
          <ProjectSettingsMenu
            jiraProjectOpenUrlByProjectKey={jiraProjectOpenUrlByProjectKey}
            project={project}
            onCopyPath={props.onCopyPath}
            onGrouping={props.onGrouping}
            onNewFolderWithProject={props.onNewFolderWithProject}
            onOpenJiraProject={props.onOpenJiraProject}
            onOpenOverview={props.onOpenOverview}
            onOpenRemote={props.onOpenRemote}
            onRemove={props.onRemove}
            onRename={props.onRename}
            onSettings={props.onSettings}
          />
        </MenuPopup>
      </Menu>
    </div>
  );
}
