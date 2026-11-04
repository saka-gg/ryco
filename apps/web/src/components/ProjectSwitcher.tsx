import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { ChevronRightIcon, GitBranchIcon, MessageCircleDashedIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { isPendingChatDraft, useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { hostedDraftTargetController } from "../hooks/useHostedDraftExecutionTarget";
import { preloadableLazy, useLazyComponentReady, usePreloadWhenIdle } from "../lib/preloadableLazy";
import { useStore } from "../store";
import { createProjectSelectorByRef } from "../storeSelectors";
import { cn } from "~/lib/utils";
import type {
  ProjectSelectorIcons,
  ProjectSelectorKeyHandler,
  ProjectSelectorList,
} from "./ProjectSelectorBody";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  clearProjectSelectorOpenRequest,
  isProjectSelectorOpenRequested,
  useProjectNodesDialogStore,
} from "./projectNodes/projectNodesDialogStore";
import { Combobox, ComboboxInput, ComboboxPopup, ComboboxTrigger } from "./ui/combobox";

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
  /**
   * Opens when something asks to show this project in the selector
   * (`requestProjectSelectorOpen`, the add-project dialog's done step). Only
   * the new-thread hero's headline instance listens, so one selector opens.
   */
  readonly openOnRequest?: boolean;
}

// The list (logical projects across nodes, node catalog, chips, footer) loads
// with the first open, or in an idle slot once a switcher is on screen, so the
// chat route carries only the trigger and the search field.
const ProjectSelectorBody = preloadableLazy(() =>
  import("./ProjectSelectorBody").then((module) => module.ProjectSelectorBody),
);

const NO_LIST: ProjectSelectorList = { items: [], value: null };
// See `ProjectSelectorIcons`: the chat route already holds these icons.
const SELECTOR_ICONS: ProjectSelectorIcons = {
  expand: ChevronRightIcon,
  branch: GitBranchIcon,
  noProject: MessageCircleDashedIcon,
};

/**
 * Retargets the thread being composed at a different project, on any node.
 *
 * The project is a *field* of this draft, not a navigation target, so this
 * rewrites the current draft in place rather than hopping to the target
 * project's own draft. That keeps the prompt, attachments, model, provider and
 * effort exactly as the user left them — none of it has to be copied, because
 * the composer draft is keyed by draft id and never moves. Only the branch and
 * worktree path are dropped, since they belong to the old repository.
 *
 * One row per logical project (the same repository on several nodes is one
 * row) shows every node it is on; its chevron (or →) lists the checkout on
 * each node, and picking one moves the draft there. In hosted mode a checkout
 * on another node is reached through the hosted draft-target controller, which
 * switches the routed node and commits the move under that node's fresh lease.
 * Node chips and an `@node` word narrow the list to one node; the text matches
 * names and paths.
 *
 * Where the draft's node supports chats, "No project" leads the list: it turns
 * the draft into a chat that gets its own folder on first send (and picking a
 * project turns it back). The footer adds a project or copies this one to
 * another node (not on the frozen phone tier).
 */
export function ProjectSwitcher({
  activeProjectId,
  activeProjectEnvironmentId,
  appearance,
  draftId,
  label,
  className,
  openOnRequest = false,
}: ProjectSwitcherProps) {
  const isChatDraft = useComposerDraftStore((store) =>
    isPendingChatDraft(store.draftThreadsByThreadKey[draftId]),
  );
  const activeProjectRef = useMemo(
    () => scopeProjectRef(activeProjectEnvironmentId, activeProjectId),
    [activeProjectEnvironmentId, activeProjectId],
  );
  const activeProjectSelector = useMemo(
    () => createProjectSelectorByRef(activeProjectRef),
    [activeProjectRef],
  );
  const activeProject = useStore(activeProjectSelector);
  const [open, setOpen] = useState(false);
  // "Show in project selector" (the add-project dialog) opens it once, as a
  // click would; closing it clears the request.
  const openRequested = useProjectNodesDialogStore(
    (state) =>
      openOnRequest &&
      isProjectSelectorOpenRequested(state.projectSelectorOpenRequest, activeProjectRef),
  );
  if (openRequested && !open) setOpen(true);
  const [query, setQuery] = useState("");
  const [list, setList] = useState(NO_LIST);
  const [loadFailed, setLoadFailed] = useState<{ readonly retry: () => void } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const keyHandlerRef = useRef<ProjectSelectorKeyHandler | null>(null);
  usePreloadWhenIdle(ProjectSelectorBody, true);
  const bodyReady = useLazyComponentReady(ProjectSelectorBody, open, {
    onLoadError: (_error, retry) => setLoadFailed({ retry }),
  });

  const close = useCallback(() => {
    setOpen(false);
    clearProjectSelectorOpenRequest(activeProjectRef);
    setQuery("");
    // The next open loads again (see `useLazyComponentReady`).
    setLoadFailed(null);
  }, [activeProjectRef]);
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) setOpen(true);
      else close();
    },
    [close],
  );
  const updateQuery = useCallback((update: (previous: string) => string) => setQuery(update), []);
  const handleInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    keyHandlerRef.current?.(event);
  }, []);
  const preload = useCallback(() => {
    void ProjectSelectorBody.preload();
  }, []);
  // The headline's popup centers under the whole headline rather than under
  // the project name inside it (which sits right of center), at its own width
  // (`min-w-0` drops the popup's anchor-width minimum); the chip and the
  // sentence open from their own start.
  const headlineAnchor = useCallback(
    () => triggerRef.current?.closest("h1") ?? triggerRef.current,
    [],
  );
  const beginHostedProjectMove = useCallback<(typeof hostedDraftTargetController)["beginProject"]>(
    (input) => hostedDraftTargetController.beginProject(input),
    [],
  );

  return (
    <Combobox
      items={list.items}
      filteredItems={list.items}
      autoHighlight
      open={open}
      value={list.value}
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
        onPointerEnter={preload}
        onFocus={preload}
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
        anchor={appearance === "headline" ? headlineAnchor : triggerRef}
        align={appearance === "headline" ? "center" : "start"}
        side={appearance === "chip" ? "top" : "bottom"}
        className="w-[440px] min-w-0 overflow-hidden rounded-xl font-normal text-[13px] tracking-normal"
        popupClassName="max-h-[min(var(--available-height),30rem)]"
        data-testid="project-selector"
      >
        <label className="flex items-center gap-2 border-b px-3 py-[9px] text-muted-foreground">
          <SearchIcon aria-hidden className="size-3.5 shrink-0" />
          <ComboboxInput
            aria-label="Search projects"
            className="flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 before:hidden has-focus-visible:ring-0 dark:bg-transparent [&_input]:h-6 [&_input]:px-0 [&_input]:font-sans [&_input]:text-[13px] [&_input]:leading-6"
            placeholder="Search projects or paths · @ to pick a node"
            showTrigger={false}
            size="sm"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
        </label>
        {bodyReady ? (
          <ProjectSelectorBody
            activeProjectId={activeProjectId}
            activeProjectEnvironmentId={activeProjectEnvironmentId}
            draftId={draftId}
            isChatDraft={isChatDraft}
            copyName={activeProject?.name ?? null}
            query={query}
            onQueryChange={updateQuery}
            onListChange={setList}
            keyHandlerRef={keyHandlerRef}
            onClose={close}
            beginHostedProjectMove={beginHostedProjectMove}
            icons={SELECTOR_ICONS}
          />
        ) : (
          <div className="flex items-center gap-2 px-[18px] py-[18px] text-[12.5px] text-muted-foreground">
            {loadFailed ? (
              <>
                Couldn't load your projects.
                <button
                  type="button"
                  className="rounded-md px-1 font-medium text-foreground underline-offset-4 hover:underline"
                  onClick={() => {
                    const { retry } = loadFailed;
                    setLoadFailed(null);
                    retry();
                  }}
                >
                  Try again
                </button>
              </>
            ) : (
              "Loading projects…"
            )}
          </div>
        )}
      </ComboboxPopup>
    </Combobox>
  );
}
