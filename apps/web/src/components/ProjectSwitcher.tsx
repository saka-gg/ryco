import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { MessageCircleDashedIcon } from "lucide-react";
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  buildChatDraftTarget,
  CHAT_PROJECT_LABEL,
  isPendingChatDraft,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import { useChatsAvailability } from "../hooks/useChatsAvailability";
import { useSettings } from "../hooks/useSettings";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { newProjectId } from "../lib/utils";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { useHostedWorkspaceState } from "../hostedHub/hostedConnectionCoordinator";
import { cn } from "~/lib/utils";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSeparator,
  ComboboxTrigger,
} from "./ui/combobox";

/**
 * `headline` renders the dotted-underline project name inside the new-thread
 * hero title; `sentence` renders the inline token used by the "Work in …" row;
 * `chip` renders the compact favicon + name control in the branch toolbar.
 */
export type ProjectSwitcherAppearance = "headline" | "sentence" | "chip";

export interface ProjectSwitcherProps {
  readonly activeProjectId: ProjectId;
  readonly activeProjectEnvironmentId: EnvironmentId;
  readonly appearance: ProjectSwitcherAppearance;
  /** The draft being retargeted. Switching is disabled without one. */
  readonly draftId: DraftId;
  readonly label: string;
  readonly className?: string;
}

function projectItemKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}\u0000${projectId}`;
}

/** Combobox value of the "No project" entry; never collides with a project key. */
const NO_PROJECT_ITEM = "\u0000no-project";
const NO_PROJECT_SEARCH_TERMS = `${CHAT_PROJECT_LABEL} chat without folder`.toLowerCase();

/**
 * Retargets the thread being composed at a different project.
 *
 * The project is a *field* of this draft, not a navigation target, so this
 * rewrites the current draft in place rather than hopping to the target
 * project's own draft. That keeps the prompt, attachments, model, provider and
 * effort exactly as the user left them — none of it has to be copied, because
 * the composer draft is keyed by draft id and never moves. Only the branch and
 * worktree path are dropped, since they belong to the old repository.
 *
 * Where the draft's node supports chats, "No project" leads the list: it turns
 * the draft into a chat that gets its own folder on first send (and picking a
 * project turns it back).
 */
export function ProjectSwitcher({
  activeProjectId,
  activeProjectEnvironmentId,
  appearance,
  draftId,
  label,
  className,
}: ProjectSwitcherProps) {
  const moveDraftThreadToProject = useComposerDraftStore((store) => store.moveDraftThreadToProject);
  const isChatDraft = useComposerDraftStore((store) =>
    isPendingChatDraft(store.draftThreadsByThreadKey[draftId]),
  );
  const chatsAvailability = useChatsAvailability(activeProjectEnvironmentId);
  // A chat draft keeps its own entry even if the node stopped offering chats.
  const showNoProject = chatsAvailability.available || isChatDraft;
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const hosted = useHostedWorkspaceState();
  const allProjects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const projects = useMemo(
    () =>
      excludeChatProjects(
        hosted.status === "signed-out"
          ? allProjects
          : allProjects.filter((project) => project.environmentId === activeProjectEnvironmentId),
      ),
    [activeProjectEnvironmentId, allProjects, hosted.status],
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const items = useMemo(
    () => [
      ...(showNoProject ? [NO_PROJECT_ITEM] : []),
      ...projects.map((project) => projectItemKey(project.environmentId, project.id)),
    ],
    [projects, showNoProject],
  );
  const projectByItem = useMemo(
    () =>
      new Map(
        projects.map(
          (project) => [projectItemKey(project.environmentId, project.id), project] as const,
        ),
      ),
    [projects],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = useMemo(() => {
    if (normalizedQuery.length === 0) {
      return items;
    }
    return items.filter((item) => {
      if (item === NO_PROJECT_ITEM) return NO_PROJECT_SEARCH_TERMS.includes(normalizedQuery);
      const project = projectByItem.get(item);
      if (!project) return false;
      return (
        project.name.toLowerCase().includes(normalizedQuery) ||
        project.cwd.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [items, normalizedQuery, projectByItem]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
    }
  }, []);

  const selectProject = useCallback(
    (item: string) => {
      setOpen(false);
      setQuery("");
      if (item === NO_PROJECT_ITEM) {
        if (!isChatDraft) {
          moveDraftThreadToProject(
            draftId,
            buildChatDraftTarget(activeProjectEnvironmentId, newProjectId()),
          );
        }
        return;
      }
      const project = projectByItem.get(item);
      if (
        !project ||
        (!isChatDraft &&
          project.id === activeProjectId &&
          project.environmentId === activeProjectEnvironmentId)
      ) {
        return;
      }
      moveDraftThreadToProject(draftId, {
        projectRef: scopeProjectRef(project.environmentId, project.id),
        logicalProjectKey: deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
      });
    },
    [
      activeProjectEnvironmentId,
      activeProjectId,
      draftId,
      isChatDraft,
      moveDraftThreadToProject,
      projectByItem,
      projectGroupingSettings,
    ],
  );

  const activeItem = isChatDraft
    ? NO_PROJECT_ITEM
    : projectItemKey(activeProjectEnvironmentId, activeProjectId);
  const activeProject = projectByItem.get(activeItem) ?? null;

  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      open={open}
      value={activeItem}
      onOpenChange={handleOpenChange}
    >
      <ComboboxTrigger
        ref={triggerRef}
        aria-label={`Switch project (currently ${label})`}
        className={cn(
          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          appearance === "headline" &&
            // Dots at full strength so they read as part of the headline, and
            // hover dims name *and* dots together rather than brightening the
            // underline — the affordance is "this is editable", not "look here".
            "rounded-sm text-foreground underline decoration-foreground decoration-dotted decoration-2 underline-offset-[7px] transition-colors hover:text-foreground/55 hover:decoration-foreground/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          appearance === "sentence" &&
            "inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 font-medium text-foreground/85 transition-colors hover:bg-accent hover:text-foreground",
          appearance === "chip" &&
            "inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium text-muted-foreground/70 text-xs transition-colors hover:bg-accent hover:text-foreground/80",
          className,
        )}
        render={<button type="button" />}
      >
        {appearance !== "headline" && isChatDraft ? (
          <MessageCircleDashedIcon aria-hidden className="size-3.5 shrink-0 opacity-80" />
        ) : appearance === "chip" && activeProject ? (
          // The sentence omits the favicon: the new-thread hero already shows
          // the project's artwork right above it.
          <ProjectFavicon
            environmentId={activeProject.environmentId}
            cwd={activeProject.cwd}
            projectId={activeProject.id}
            customAvatarContentHash={activeProject.customAvatarContentHash ?? null}
            className="size-3.5 shrink-0"
          />
        ) : null}
        <span className={appearance === "headline" ? undefined : "min-w-0 truncate"}>{label}</span>
      </ComboboxTrigger>
      <ComboboxPopup
        anchor={triggerRef}
        align="start"
        side={appearance === "chip" ? "top" : "bottom"}
        className="w-80 overflow-hidden"
      >
        <div className="border-b p-1">
          <ComboboxInput
            className="[&_input]:font-sans rounded-md"
            inputClassName="ring-0"
            placeholder="Search projects..."
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No projects found.</ComboboxEmpty>
        <ComboboxList className="max-h-64">
          {filteredItems.map((item, index) => {
            if (item === NO_PROJECT_ITEM) {
              return (
                <Fragment key={item}>
                  <ComboboxItem
                    hideIndicator
                    index={index}
                    value={item}
                    data-testid="project-switcher-no-project"
                    onClick={() => selectProject(item)}
                  >
                    <div className="flex w-full min-w-0 items-center gap-2 py-0.5 text-left">
                      <MessageCircleDashedIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span
                          className={cn(
                            "truncate text-sm",
                            item === activeItem && "font-medium text-foreground",
                          )}
                        >
                          {CHAT_PROJECT_LABEL}
                        </span>
                        <span className="truncate text-muted-foreground text-xs">
                          A chat in its own folder · turn it into a project later
                        </span>
                      </span>
                    </div>
                  </ComboboxItem>
                  {index < filteredItems.length - 1 ? <ComboboxSeparator /> : null}
                </Fragment>
              );
            }
            const project = projectByItem.get(item);
            if (!project) return null;
            return (
              <ComboboxItem
                hideIndicator
                key={item}
                index={index}
                value={item}
                onClick={() => selectProject(item)}
              >
                <div className="flex w-full min-w-0 items-center gap-2 py-0.5 text-left">
                  <ProjectFavicon
                    environmentId={project.environmentId}
                    cwd={project.cwd}
                    projectId={project.id}
                    customAvatarContentHash={project.customAvatarContentHash ?? null}
                    className="size-4 shrink-0"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cn(
                        "truncate text-sm",
                        item === activeItem && "font-medium text-foreground",
                      )}
                    >
                      {project.name}
                    </span>
                    <span className="truncate text-muted-foreground text-xs">{project.cwd}</span>
                  </span>
                </div>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
