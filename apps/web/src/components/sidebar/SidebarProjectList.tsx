import {
  ArrowUpDownIcon,
  Edit3Icon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import React, { memo, useCallback, useState } from "react";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  type DragStartEvent,
  type DragEndEvent,
  useDroppable,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  type SortableContextProps,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  WS_METHODS,
  type SidebarProjectGroupingMode,
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
} from "@ryco/contracts";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { hasNoShortcutModifiers } from "../../keybindings";
import { projectTreeItemId, useUiStateStore } from "../../uiStateStore";
import type { useUpdateSettings } from "~/hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarProjectTreeRow } from "../../sidebarProjectFolders";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { handleSidebarListScroll } from "./sidebarFold";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuSub,
} from "../ui/sidebar";
import {
  SIDEBAR_ROW_ACTION_COARSE_ANCHORED_CLASS_NAME,
  SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME,
} from "../Sidebar.logic";

const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};
const SortableContextComponent = SortableContext as React.ComponentType<SortableContextProps>;
const PROJECT_ROOT_DROP_ID = "project-folder-root-drop";

export type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectRootDropZone(props: { hasFolders: boolean }) {
  const { isOver, setNodeRef } = useDroppable({ id: PROJECT_ROOT_DROP_ID });
  if (!props.hasFolders) {
    return <li ref={setNodeRef} className="h-0" aria-hidden="true" />;
  }
  return (
    <li
      ref={setNodeRef}
      aria-label="Move projects to root"
      className={`mx-1 my-1 h-6 rounded-md border border-dashed text-center text-[10px] leading-6 transition-colors ${
        isOver
          ? "border-primary/50 bg-primary/10 text-primary"
          : "border-transparent text-muted-foreground/50"
      }`}
    >
      Root
    </li>
  );
}

export { PROJECT_ROOT_DROP_ID };

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  projectGroupingMode,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
  onProjectGroupingModeChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  projectGroupingMode: SidebarProjectGroupingMode;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onProjectGroupingModeChange: (mode: SidebarProjectGroupingMode) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              className={`inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
            />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort projects</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
            Sort threads
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 font-medium text-muted-foreground sm:text-xs">
            Group projects
          </div>
          <MenuRadioGroup
            value={projectGroupingMode}
            onValueChange={(value) => {
              if (value === "repository" || value === "repository_path" || value === "separate") {
                onProjectGroupingModeChange(value);
              }
            }}
          >
            {(
              Object.entries(PROJECT_GROUPING_MODE_LABELS) as Array<
                [SidebarProjectGroupingMode, string]
              >
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: string;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md [content-visibility:auto] [contain-intrinsic-block-size:2rem] ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

interface SidebarProjectFolderRowProps {
  folderName: string;
  projectCount: number;
  expanded: boolean;
  isManualProjectSorting: boolean;
  dragHandleProps: SortableProjectHandleProps | null;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}

const SidebarProjectFolderRow = memo(function SidebarProjectFolderRow(
  props: SidebarProjectFolderRowProps,
) {
  return (
    <div className="group/folder-row relative">
      <SidebarMenuButton
        ref={props.isManualProjectSorting ? props.dragHandleProps?.setActivatorNodeRef : undefined}
        size="sm"
        className={`gap-2 px-2 py-1.5 pr-9 phone:pointer-coarse:pr-12 text-left hover:bg-accent group-hover/folder-row:bg-accent group-hover/folder-row:text-sidebar-accent-foreground ${
          props.isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
        }`}
        {...(props.isManualProjectSorting && props.dragHandleProps
          ? props.dragHandleProps.attributes
          : {})}
        {...(props.isManualProjectSorting && props.dragHandleProps
          ? props.dragHandleProps.listeners
          : {})}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        {props.expanded ? (
          <FolderOpenIcon className="size-[18px] shrink-0 text-muted-foreground/80" />
        ) : (
          <FolderIcon className="size-[18px] shrink-0 text-muted-foreground/80" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
          {props.folderName}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground/60">{props.projectCount}</span>
      </SidebarMenuButton>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                aria-label={`Open folder settings for ${props.folderName}`}
                className={`pointer-events-none absolute top-1 right-1.5 phone:pointer-coarse:top-1/2 phone:pointer-coarse:-translate-y-1/2 phone:pointer-coarse:right-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity duration-150 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring phone:pointer-events-auto phone:opacity-100 group-hover/folder-row:pointer-events-auto group-hover/folder-row:opacity-100 group-focus-within/folder-row:pointer-events-auto group-focus-within/folder-row:opacity-100 ${SIDEBAR_ROW_ACTION_COARSE_ANCHORED_CLASS_NAME}`}
              />
            }
          >
            <MoreHorizontalIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Folder settings</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side="bottom" className="min-w-44">
          <MenuItem onClick={props.onRename} className="min-h-7 py-1 sm:text-xs">
            <Edit3Icon className="size-3.5" />
            Rename folder
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onClick={props.onDelete}
            variant="destructive"
            className="min-h-7 py-1 sm:text-xs"
          >
            <Trash2Icon className="size-3.5" />
            Delete folder
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
});

export interface SidebarProjectsContentProps {
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  desktopUpdateButtonAction: "download" | "install" | "none";
  desktopUpdateButtonDisabled: boolean;
  handleDesktopUpdateButtonClick: () => void;
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  projectGroupingMode: SidebarProjectGroupingMode;
  updateSettings: ReturnType<typeof useUpdateSettings>["updateSettings"];
  openAddProject: () => void;
  isManualProjectSorting: boolean;
  projectDnDSensors: ReturnType<typeof useSensors>;
  projectCollisionDetection: CollisionDetection;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  projectTreeRows: readonly SidebarProjectTreeRow[];
  attachProjectListAutoAnimateRef: (node: HTMLElement | null) => void;
  projectsLength: number;
  renderProjectRow: (
    project: SidebarProjectSnapshot,
    dragHandleProps: SortableProjectHandleProps | null,
    onNewFolderWithProject: (project: SidebarProjectSnapshot) => void,
  ) => React.ReactNode;
  /** The "Chats" section ("No project" chats), rendered after the project tree. */
  chatsSection?: React.ReactNode;
}

export const SidebarProjectsContent = memo(function SidebarProjectsContent(
  props: SidebarProjectsContentProps,
) {
  const {
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    handleDesktopUpdateButtonClick,
    projectSortOrder,
    threadSortOrder,
    projectGroupingMode,
    updateSettings,
    openAddProject,
    isManualProjectSorting,
    projectDnDSensors,
    projectCollisionDetection,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    projectTreeRows,
    attachProjectListAutoAnimateRef,
    projectsLength,
    renderProjectRow,
    chatsSection,
  } = props;
  const createProjectFolder = useUiStateStore((state) => state.createProjectFolder);
  const renameProjectFolder = useUiStateStore((state) => state.renameProjectFolder);
  const deleteProjectFolder = useUiStateStore((state) => state.deleteProjectFolder);
  const setProjectFolderExpanded = useUiStateStore((state) => state.setProjectFolderExpanded);
  const [folderDialog, setFolderDialog] = useState<
    | { mode: "create"; initialProjectKeys: readonly string[]; initialName: string }
    | { mode: "rename"; folderId: string; initialName: string }
    | null
  >(null);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const addProjectCapability = useHostedRpcCapability(WS_METHODS.projectsAdd);
  const openCreateFolderDialog = useCallback(
    (input: { initialProjectKeys?: readonly string[]; initialName?: string } = {}) => {
      const initialName = input.initialName ?? "";
      setFolderDialog({
        mode: "create",
        initialProjectKeys: input.initialProjectKeys ?? [],
        initialName,
      });
      setFolderNameDraft(initialName);
    },
    [],
  );
  const openRenameFolderDialog = useCallback((folderId: string, initialName: string) => {
    setFolderDialog({ mode: "rename", folderId, initialName });
    setFolderNameDraft(initialName);
  }, []);
  const closeFolderDialog = useCallback(() => {
    setFolderDialog(null);
    setFolderNameDraft("");
  }, []);
  const submitFolderDialog = useCallback(() => {
    if (!folderDialog) {
      return;
    }
    const name = folderNameDraft.trim();
    if (!name) {
      return;
    }
    if (folderDialog.mode === "create") {
      createProjectFolder(name, folderDialog.initialProjectKeys);
    } else {
      renameProjectFolder(folderDialog.folderId, name);
    }
    closeFolderDialog();
  }, [closeFolderDialog, createProjectFolder, folderDialog, folderNameDraft, renameProjectFolder]);
  const handleDeleteFolder = useCallback(
    (folderId: string, folderName: string) => {
      const confirmed = window.confirm(
        `Delete folder "${folderName}"?\n\nProjects inside it will stay in the sidebar.`,
      );
      if (!confirmed) {
        return;
      }
      deleteProjectFolder(folderId);
    },
    [deleteProjectFolder],
  );
  const handleNewFolderWithProject = useCallback(
    (project: SidebarProjectSnapshot) => {
      openCreateFolderDialog({
        initialName: project.displayName,
        initialProjectKeys: project.memberProjects.map((member) => member.physicalProjectKey),
      });
    },
    [openCreateFolderDialog],
  );

  const handleProjectSortOrderChange = useCallback(
    (sortOrder: SidebarProjectSortOrder) => {
      updateSettings({ sidebarProjectSortOrder: sortOrder });
    },
    [updateSettings],
  );
  const handleThreadSortOrderChange = useCallback(
    (sortOrder: SidebarThreadSortOrder) => {
      updateSettings({ sidebarThreadSortOrder: sortOrder });
    },
    [updateSettings],
  );
  const handleProjectGroupingModeChange = useCallback(
    (groupingMode: SidebarProjectGroupingMode) => {
      updateSettings({ sidebarProjectGroupingMode: groupingMode });
    },
    [updateSettings],
  );

  return (
    <>
      <SidebarContent className="gap-0" onViewportScroll={handleSidebarListScroll}>
        {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
          <SidebarGroup className="px-2 pt-2 pb-0">
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
              <TriangleAlertIcon />
              <AlertTitle>Intel build on Apple Silicon</AlertTitle>
              <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              {desktopUpdateButtonAction !== "none" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={desktopUpdateButtonDisabled}
                    onClick={handleDesktopUpdateButtonClick}
                  >
                    {desktopUpdateButtonAction === "download"
                      ? "Download ARM build"
                      : "Install ARM build"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="px-2 py-2">
          <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Projects
            </span>
            <div className="flex items-center gap-1 phone:pointer-coarse:gap-3">
              <ProjectSortMenu
                projectSortOrder={projectSortOrder}
                threadSortOrder={threadSortOrder}
                projectGroupingMode={projectGroupingMode}
                onProjectSortOrderChange={handleProjectSortOrderChange}
                onThreadSortOrderChange={handleThreadSortOrderChange}
                onProjectGroupingModeChange={handleProjectGroupingModeChange}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Create project folder"
                      className={`inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
                      onClick={() => openCreateFolderDialog()}
                    />
                  }
                >
                  <FolderPlusIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="right">New folder</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className="inline-flex"
                      tabIndex={addProjectCapability.allowed ? undefined : 0}
                      aria-label={
                        addProjectCapability.allowed
                          ? undefined
                          : (addProjectCapability.reason ?? "Add project is unavailable")
                      }
                    >
                      <button
                        type="button"
                        aria-label="Add project"
                        data-testid="sidebar-add-project-trigger"
                        className={`inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
                        disabled={!addProjectCapability.allowed}
                        onClick={openAddProject}
                      >
                        <PlusIcon className="size-3.5" />
                      </button>
                    </span>
                  }
                />
                <TooltipPopup side="right">
                  {addProjectCapability.allowed
                    ? "Add project"
                    : (addProjectCapability.reason ?? "Add project is unavailable")}
                </TooltipPopup>
              </Tooltip>
            </div>
          </div>

          <DndContext
            sensors={projectDnDSensors}
            collisionDetection={projectCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleProjectDragStart}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={handleProjectDragCancel}
          >
            <SidebarMenu ref={attachProjectListAutoAnimateRef}>
              <SortableContextComponent
                items={projectTreeRows.map((row) => row.itemId)}
                strategy={verticalListSortingStrategy}
              >
                {projectTreeRows.map((row) => {
                  if (row.kind === "project") {
                    return (
                      <SortableProjectItem key={row.itemId} projectId={row.itemId}>
                        {(dragHandleProps) =>
                          renderProjectRow(row.project, dragHandleProps, handleNewFolderWithProject)
                        }
                      </SortableProjectItem>
                    );
                  }
                  return (
                    <SortableProjectItem key={row.itemId} projectId={row.itemId}>
                      {(dragHandleProps) => (
                        <>
                          <SidebarProjectFolderRow
                            folderName={row.folder.name}
                            projectCount={row.projects.length}
                            expanded={row.folder.expanded}
                            isManualProjectSorting={isManualProjectSorting}
                            dragHandleProps={dragHandleProps}
                            onToggle={() =>
                              setProjectFolderExpanded(row.folder.id, !row.folder.expanded)
                            }
                            onRename={() => openRenameFolderDialog(row.folder.id, row.folder.name)}
                            onDelete={() => handleDeleteFolder(row.folder.id, row.folder.name)}
                          />
                          {row.folder.expanded ? (
                            <SidebarMenuSub>
                              <SortableContextComponent
                                items={row.projects.map((project) =>
                                  projectTreeItemId(project.projectKey),
                                )}
                                strategy={verticalListSortingStrategy}
                              >
                                {row.projects.map((project) => (
                                  <SortableProjectItem
                                    key={project.projectKey}
                                    projectId={projectTreeItemId(project.projectKey)}
                                  >
                                    {(childDragHandleProps) =>
                                      renderProjectRow(
                                        project,
                                        childDragHandleProps,
                                        handleNewFolderWithProject,
                                      )
                                    }
                                  </SortableProjectItem>
                                ))}
                              </SortableContextComponent>
                            </SidebarMenuSub>
                          ) : null}
                        </>
                      )}
                    </SortableProjectItem>
                  );
                })}
              </SortableContextComponent>
              <ProjectRootDropZone
                hasFolders={projectTreeRows.some((row) => row.kind === "folder")}
              />
            </SidebarMenu>
          </DndContext>

          {projectsLength === 0 && projectTreeRows.length === 0 && (
            <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
              No projects yet
            </div>
          )}
        </SidebarGroup>
        {chatsSection}
      </SidebarContent>
      <Dialog
        open={folderDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeFolderDialog();
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {folderDialog?.mode === "rename" ? "Rename folder" : "New project folder"}
            </DialogTitle>
            <DialogDescription>
              Project folders organize this sidebar only. Projects and sessions are not changed.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Folder name</span>
              <Input
                aria-label="Folder name"
                value={folderNameDraft}
                autoFocus
                onChange={(event) => setFolderNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && hasNoShortcutModifiers(event)) {
                    event.preventDefault();
                    submitFolderDialog();
                  }
                }}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeFolderDialog}>
              Cancel
            </Button>
            <Button disabled={folderNameDraft.trim().length === 0} onClick={submitFolderDialog}>
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
