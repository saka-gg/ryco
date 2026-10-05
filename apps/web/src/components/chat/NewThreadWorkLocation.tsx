import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { FolderGit2Icon, FolderIcon, GitBranchPlusIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { selectSidebarWorktreesForProjectRef, useStore } from "../../store";
import { cn } from "~/lib/utils";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "../BranchToolbarEnvironmentSelector";
import { ProjectSwitcher } from "../ProjectSwitcher";
import { NewThreadSourcePicker, type NewThreadSource } from "./NewThreadSourcePicker";
import type { DraftWorktreeSource } from "@ryco/client-runtime/state/composer";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  branchSlotPreposition,
  newWorktreeBaseBranch,
  resolveWorkLocation,
  showsBranchSlot,
  workLocationDraftPatch,
  workLocationLabel,
  worktreeChoiceLabel,
  type WorkLocation,
  type WorktreeChoice,
} from "./NewThreadWorkLocation.logic";

const PROJECT_ROOT_ITEM = "__project_root__";
const NEW_WORKTREE_ITEM = "__new_worktree__";

export interface NewThreadWorkLocationProps {
  readonly draftId: DraftId | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly projectEnvironmentId: EnvironmentId | null;
  readonly projectName: string | null;
  readonly envLocked: boolean;
  readonly availableEnvironments: readonly EnvironmentOption[];
  readonly onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  readonly onComposerFocusRequest: (() => void) | undefined;
  readonly onCheckoutPullRequestRequest: ((reference: string) => void) | undefined;
  readonly cwd: string | null;
}

/**
 * States the plan for the thread about to be started, in one line:
 *
 *   Work in **ryco** › **a new worktree** from **main**
 *
 * Every bold token is a control. Slots that don't apply are dropped rather
 * than disabled — an existing worktree already has its branch, so it shows no
 * source; the environment appears only when there is more than one.
 *
 * This replaces the chip row for empty threads so the same three settings
 * aren't offered twice on one screen.
 */
export function NewThreadWorkLocation({
  draftId,
  environmentId,
  threadId,
  projectId,
  projectEnvironmentId,
  projectName,
  envLocked,
  availableEnvironments,
  onEnvironmentChange,
  onComposerFocusRequest,
  onCheckoutPullRequestRequest,
  cwd,
}: NewThreadWorkLocationProps) {
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : null,
  );
  const projectRef = useMemo(
    () =>
      projectEnvironmentId && projectId ? scopeProjectRef(projectEnvironmentId, projectId) : null,
    [projectEnvironmentId, projectId],
  );
  const worktreeSummaries = useStore(
    useShallow((state) => selectSidebarWorktreesForProjectRef(state, projectRef)),
  );
  const worktrees = useMemo<ReadonlyArray<WorktreeChoice>>(
    () =>
      worktreeSummaries.flatMap((worktree) =>
        worktree.worktreePath && worktree.archivedAt === null && worktree.checkoutRemovedAt == null
          ? [
              {
                worktreeId: worktree.id,
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                title: worktree.title ?? null,
              },
            ]
          : [],
      ),
    [worktreeSummaries],
  );

  const location = resolveWorkLocation({
    draft: {
      envMode: draftThread?.envMode ?? "local",
      worktreePath: draftThread?.worktreePath ?? null,
    },
    worktrees,
  });

  const applyLocation = useCallback(
    (next: WorkLocation) => {
      if (!draftId) return;
      setDraftThreadContext(draftId, workLocationDraftPatch(next));
      onComposerFocusRequest?.();
    },
    [draftId, onComposerFocusRequest, setDraftThreadContext],
  );

  const showEnvironment = availableEnvironments.length > 1 && onEnvironmentChange !== undefined;
  const canEdit = draftId !== undefined && !envLocked;
  const worktreeSource = draftThread?.worktreeSource ?? null;
  const fetchOrigin = draftThread?.fetchOrigin ?? true;
  const selectedBranch = draftThread?.branch?.trim();
  const sourceLabel =
    worktreeSource?.label ??
    (selectedBranch
      ? newWorktreeBaseBranch(selectedBranch, fetchOrigin)
      : fetchOrigin
        ? "origin’s default branch"
        : "the current branch");
  const sourceKind = worktreeSource
    ? worktreeSource.kind
    : draftThread?.branch?.trim()
      ? ("branch" as const)
      : null;

  // Every source is recorded, never materialized: picking one is a statement
  // of intent, and the worktree is created from it on first send. Branch and
  // non-branch sources are mutually exclusive, so each selection clears the
  // other.
  const handleSelectSource = useCallback(
    (source: NewThreadSource) => {
      if (!draftId) return;
      setDraftThreadContext(
        draftId,
        source.kind === "branch"
          ? { branch: source.branchName, worktreeSource: null, worktreePath: null }
          : {
              branch: null,
              worktreePath: null,
              worktreeSource: toDraftWorktreeSource(source),
            },
      );
      onComposerFocusRequest?.();
    },
    [draftId, onComposerFocusRequest, setDraftThreadContext],
  );

  if (!projectId || !projectEnvironmentId || !projectName) {
    return null;
  }

  return (
    <p
      className="flex max-w-208 flex-wrap items-center justify-center gap-x-0.5 gap-y-1 text-[13px] text-muted-foreground/70"
      data-testid="new-thread-work-location"
    >
      <span className="px-1">Work in</span>

      {canEdit && draftId ? (
        <ProjectSwitcher
          activeProjectId={projectId}
          activeProjectEnvironmentId={projectEnvironmentId}
          appearance="sentence"
          draftId={draftId}
          label={projectName}
        />
      ) : (
        <SentenceValue>{projectName}</SentenceValue>
      )}

      <span aria-hidden className="px-1 text-muted-foreground/35">
        ›
      </span>

      {canEdit ? (
        <WorkLocationPicker location={location} worktrees={worktrees} onSelect={applyLocation} />
      ) : (
        <SentenceValue>{workLocationLabel(location)}</SentenceValue>
      )}

      {showsBranchSlot(location) ? (
        <>
          <span className="px-1">{branchSlotPreposition(location)}</span>
          {/* A new worktree can branch off far more than a local ref, and none
              of those are things you can `git switch` to — so the richer source
              picker is offered only in that mode, and the project root keeps
              the plain ref selector that performs a real checkout. */}
          {location.kind === "newWorktree" && canEdit && projectId ? (
            <NewThreadSourcePicker
              label={sourceLabel}
              sourceKind={sourceKind}
              environmentId={environmentId}
              projectId={projectId}
              cwd={cwd}
              fetchOrigin={fetchOrigin}
              onFetchOriginChange={(enabled) => {
                if (draftId) setDraftThreadContext(draftId, { fetchOrigin: enabled, branch: null });
              }}
              branchName={draftThread?.worktreeBranchName ?? null}
              onBranchNameChange={(name) => {
                if (draftId)
                  setDraftThreadContext(draftId, {
                    worktreeBranchName: name,
                    worktreeSource: null,
                  });
              }}
              onSelect={handleSelectSource}
            />
          ) : (
            <BranchToolbarBranchSelector
              className="text-[13px] text-foreground/85 hover:text-foreground"
              environmentId={environmentId}
              threadId={threadId}
              {...(draftId ? { draftId } : {})}
              envLocked={envLocked}
              omitBasePrefix
              {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
              {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
            />
          )}
        </>
      ) : null}

      {location.kind === "newWorktree" && draftThread?.worktreeBranchName && !worktreeSource ? (
        <span className="px-1 text-muted-foreground">
          as <span className="font-mono text-foreground/85">{draftThread.worktreeBranchName}</span>
        </span>
      ) : null}

      {showEnvironment && onEnvironmentChange ? (
        <>
          <span className="px-1">on</span>
          <BranchToolbarEnvironmentSelector
            envLocked={envLocked}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            onEnvironmentChange={onEnvironmentChange}
          />
        </>
      ) : null}
    </p>
  );
}

/** Narrows a picked source to the plain data the draft persists. */
function toDraftWorktreeSource(
  source: Exclude<NewThreadSource, { kind: "branch" }>,
): DraftWorktreeSource {
  if (source.kind === "pr") {
    return {
      kind: "pr",
      number: source.changeRequest.number,
      label: `#${source.changeRequest.number} ${source.changeRequest.title}`,
    };
  }
  if (source.kind === "issue") {
    return {
      kind: "issue",
      number: source.issue.number,
      title: source.issue.title,
      label: `#${source.issue.number} ${source.issue.title}`,
    };
  }
  return {
    kind: "workItem",
    provider: source.workItem.provider,
    key: source.workItem.key,
    title: source.workItem.title,
    ...(source.workItem.state ? { state: source.workItem.state } : {}),
    ...(source.workItem.stateName ? { stateName: source.workItem.stateName } : {}),
    ...(source.workItem.url ? { url: source.workItem.url } : {}),
    label: `${source.workItem.key} ${source.workItem.title}`,
  };
}

function SentenceValue({ children }: { readonly children: React.ReactNode }) {
  return <span className="px-1 font-medium text-foreground/85">{children}</span>;
}

function WorkLocationPicker({
  location,
  worktrees,
  onSelect,
}: {
  readonly location: WorkLocation;
  readonly worktrees: ReadonlyArray<WorktreeChoice>;
  readonly onSelect: (location: WorkLocation) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const items = useMemo(
    () => [
      PROJECT_ROOT_ITEM,
      ...worktrees.map((worktree) => worktree.worktreeId),
      NEW_WORKTREE_ITEM,
    ],
    [worktrees],
  );
  const worktreeById = useMemo(
    () => new Map(worktrees.map((worktree) => [worktree.worktreeId, worktree] as const)),
    [worktrees],
  );
  const activeItem =
    location.kind === "projectRoot"
      ? PROJECT_ROOT_ITEM
      : location.kind === "newWorktree"
        ? NEW_WORKTREE_ITEM
        : (location.worktree?.worktreeId ?? PROJECT_ROOT_ITEM);

  const selectItem = useCallback(
    (item: string) => {
      setOpen(false);
      if (item === PROJECT_ROOT_ITEM) {
        onSelect({ kind: "projectRoot", worktree: null });
        return;
      }
      if (item === NEW_WORKTREE_ITEM) {
        onSelect({ kind: "newWorktree", worktree: null });
        return;
      }
      const worktree = worktreeById.get(item);
      if (worktree) {
        onSelect({ kind: "existingWorktree", worktree });
      }
    },
    [onSelect, worktreeById],
  );

  return (
    <Combobox
      items={items}
      filteredItems={items}
      autoHighlight
      open={open}
      value={activeItem}
      onOpenChange={setOpen}
    >
      <ComboboxTrigger
        ref={triggerRef}
        aria-label={`Change where this thread runs (currently ${workLocationLabel(location)})`}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 font-medium text-foreground/85 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        render={<button type="button" />}
      >
        <WorkLocationIcon kind={location.kind} />
        <span className="min-w-0 max-w-[16rem] truncate">{workLocationLabel(location)}</span>
      </ComboboxTrigger>
      <ComboboxPopup anchor={triggerRef} align="start" side="bottom" className="w-80">
        <ComboboxEmpty>Nowhere to run this thread.</ComboboxEmpty>
        <ComboboxList className="max-h-72">
          {items.map((item, index) => {
            const worktree = worktreeById.get(item);
            const label =
              item === PROJECT_ROOT_ITEM
                ? "The project root"
                : item === NEW_WORKTREE_ITEM
                  ? "A new worktree"
                  : worktree
                    ? worktreeChoiceLabel(worktree)
                    : item;
            const description =
              item === PROJECT_ROOT_ITEM
                ? "Work directly in the checked-out project directory"
                : item === NEW_WORKTREE_ITEM
                  ? "Branch off and create the worktree when you send"
                  : (worktree?.worktreePath ?? "");
            return (
              <ComboboxItem
                hideIndicator
                key={item}
                index={index}
                value={item}
                onClick={() => selectItem(item)}
              >
                <div className="flex w-full min-w-0 items-center gap-2 py-0.5 text-left">
                  <WorkLocationIcon
                    kind={
                      item === PROJECT_ROOT_ITEM
                        ? "projectRoot"
                        : item === NEW_WORKTREE_ITEM
                          ? "newWorktree"
                          : "existingWorktree"
                    }
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cn(
                        "truncate text-sm",
                        item === activeItem && "font-medium text-foreground",
                      )}
                    >
                      {label}
                    </span>
                    {description ? (
                      <span className="truncate text-muted-foreground text-xs">{description}</span>
                    ) : null}
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

function WorkLocationIcon({ kind }: { readonly kind: WorkLocation["kind"] }) {
  const className = "size-3.5 shrink-0 text-muted-foreground";
  if (kind === "newWorktree") return <GitBranchPlusIcon className={className} />;
  if (kind === "existingWorktree") return <FolderGit2Icon className={className} />;
  return <FolderIcon className={className} />;
}
