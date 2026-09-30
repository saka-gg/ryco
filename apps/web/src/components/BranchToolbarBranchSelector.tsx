import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  WorktreeId,
  type ChangeRequest,
  type EnvironmentId,
  type VcsRef,
  type ThreadId,
} from "@ryco/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, GitBranchIcon } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { gitScopeKey, invalidateScopes, prefetchBranches, useGitBranches } from "../rpc/useGit";
import { useSourceControlChangeRequestList } from "../rpc/useSourceControl";
import { useGitStatus } from "../lib/gitStatusState";
import { newCommandId } from "../lib/utils";
import { cn } from "../lib/utils";
import { parsePullRequestReference } from "../pullRequestReference";
import { getSourceControlPresentation } from "../sourceControlPresentation";
import { useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import {
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";
import { OverviewRailButton } from "./overview/OverviewRail";
import { useRepositoryRemote } from "./sourceControl/useRepositoryRemote";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "./ui/combobox";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface BranchToolbarBranchSelectorProps {
  className?: string;
  /**
   * "default" renders the compact ghost trigger used in the top toolbar.
   * "pill" renders the legacy inset branch pill.
   * "panelRow" renders the full-width overview-panel row (branch icon + mono
   * name + ahead/behind + chevron) — see {@link OverviewLayoutProps}.
   * "rail" renders a desktop overview rail item whose picker opens beside the
   * rail; the repository remote is a separate rail item there.
   */
  appearance?: "default" | "pill" | "panelRow" | "rail";
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  envLocked: boolean;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (refName: string | null) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  /** Drop the "From " prefix when surrounding copy already supplies it. */
  omitBasePrefix?: boolean;
}

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function getBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: "local" | "worktree";
  resolvedActiveBranch: string | null;
  /**
   * Set where the surrounding copy already says "from" — the work-location
   * sentence renders its own preposition, so the built-in prefix would read
   * "from From main".
   */
  omitBasePrefix?: boolean;
}): string {
  const { activeWorktreePath, effectiveEnvMode, resolvedActiveBranch } = input;
  if (!resolvedActiveBranch) {
    return "Select ref";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath && !input.omitBasePrefix) {
    return `From ${resolvedActiveBranch}`;
  }
  return resolvedActiveBranch;
}

export function BranchToolbarBranchSelector({
  className,
  appearance = "default",
  environmentId,
  threadId,
  draftId,
  envLocked,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  omitBasePrefix = false,
}: BranchToolbarBranchSelectorProps) {
  // ---------------------------------------------------------------------------
  // Thread / project state (pushed down from parent to colocate with mutation)
  // ---------------------------------------------------------------------------
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThreadSelector = useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]);
  const serverThread = useStore(serverThreadSelector);
  const serverSession = serverThread?.session ?? null;
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProjectSelector = useMemo(
    () => createProjectSelectorByRef(activeProjectRef),
    [activeProjectRef],
  );
  const activeProject = useStore(activeProjectSelector);

  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch =
    activeThreadBranchOverride !== undefined
      ? activeThreadBranchOverride
      : (serverThread?.branch ?? draftThread?.branch ?? null);
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeProjectCwd = activeProject?.cwd ?? null;
  const branchCwd = activeWorktreePath ?? activeProjectCwd;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
  });

  // ---------------------------------------------------------------------------
  // Thread branch mutation (colocated — only this component calls it)
  // ---------------------------------------------------------------------------
  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId || !activeProject) return;
      const api = readEnvironmentApi(environmentId);
      if (serverSession && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (api && hasServerThread) {
        const changedAt = new Date().toISOString();
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
        if (branch && serverThread.worktreeId) {
          void api.orchestration.dispatchCommand({
            type: "worktree.meta.update",
            commandId: newCommandId(),
            worktreeId: WorktreeId.make(serverThread.worktreeId),
            branch,
            changedAt,
          });
        }
      }
      if (hasServerThread) {
        onActiveThreadBranchOverrideChange?.(branch);
        setThreadBranchAction(threadRef, branch, worktreePath);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(draftId ?? threadRef, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
        projectRef: scopeProjectRef(environmentId, activeProject.id),
      });
    },
    [
      activeThreadId,
      activeProject,
      serverSession,
      serverThread,
      activeWorktreePath,
      hasServerThread,
      onActiveThreadBranchOverrideChange,
      setThreadBranchAction,
      setDraftThreadContext,
      draftId,
      threadRef,
      environmentId,
      effectiveEnvMode,
    ],
  );

  // ---------------------------------------------------------------------------
  // Git ref queries
  // ---------------------------------------------------------------------------
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const deferredBranchQuery = useDeferredValue(branchQuery);

  const branchStatusQuery = useGitStatus({ environmentId, cwd: branchCwd });
  const trimmedBranchQuery = branchQuery.trim();
  const deferredTrimmedBranchQuery = deferredBranchQuery.trim();

  useEffect(() => {
    if (!branchCwd) return;
    prefetchBranches({ environmentId, cwd: branchCwd, query: "" });
  }, [branchCwd, environmentId]);

  const {
    refs,
    totalCount: totalBranchCount,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending: isBranchesSearchPending,
  } = useGitBranches({
    environmentId,
    cwd: branchCwd,
    query: deferredTrimmedBranchQuery,
  });
  const currentGitBranch =
    branchStatusQuery.data?.refName ?? refs.find((refName) => refName.current)?.name ?? null;
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(branchStatusQuery.data?.sourceControlProvider),
    [branchStatusQuery.data?.sourceControlProvider],
  );
  const SourceControlIcon = sourceControlPresentation.Icon;
  const repositoryRemote = useRepositoryRemote({
    identity: activeProject?.repositoryIdentity,
    provider: branchStatusQuery.data?.sourceControlProvider,
  });
  const PillIcon = repositoryRemote.Icon;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const branchNames = useMemo(() => refs.map((refName) => refName.name), [refs]);
  const branchByName = useMemo(
    () => new Map(refs.map((refName) => [refName.name, refName] as const)),
    [refs],
  );
  const normalizedDeferredBranchQuery = deferredTrimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  const checkoutPullRequestItemValue =
    prReference && onCheckoutPullRequestRequest ? `__checkout_pull_request__:${prReference}` : null;
  const canCreateBranch = !isSelectingWorktreeBase && trimmedBranchQuery.length > 0;
  const hasExactBranchMatch = branchByName.has(trimmedBranchQuery);
  const createBranchItemValue = canCreateBranch
    ? `__create_new_branch__:${trimmedBranchQuery}`
    : null;

  // Open pull requests are offered as base refs, so "start work on this PR"
  // doesn't require knowing the head branch name or reaching for the full
  // worktree dialog. Only in worktree-base mode: there the picked ref is just
  // recorded and the server resolves it when it forks the worktree, whereas a
  // project-root pick performs a real checkout that would fail for a head that
  // was never fetched.
  const pullRequestsQuery = useSourceControlChangeRequestList({
    environmentId: isSelectingWorktreeBase ? environmentId : null,
    cwd: isSelectingWorktreeBase ? branchCwd : null,
    state: "open",
    limit: 50,
  });
  const pullRequestByItemValue = useMemo(() => {
    const entries = new Map<string, ChangeRequest>();
    if (!isSelectingWorktreeBase) return entries;
    for (const changeRequest of pullRequestsQuery.data ?? []) {
      // A PR whose head already exists as a local ref would duplicate a row in
      // the list above; the plain ref is the better affordance there.
      if (branchByName.has(changeRequest.headRefName)) continue;
      entries.set(`__pull_request_base__:${changeRequest.number}`, changeRequest);
    }
    return entries;
  }, [branchByName, isSelectingWorktreeBase, pullRequestsQuery.data]);

  const branchPickerItems = useMemo(() => {
    const items = [...branchNames];
    if (createBranchItemValue && !hasExactBranchMatch) {
      items.push(createBranchItemValue);
    }
    items.push(...pullRequestByItemValue.keys());
    if (checkoutPullRequestItemValue) {
      items.unshift(checkoutPullRequestItemValue);
    }
    return items;
  }, [
    branchNames,
    checkoutPullRequestItemValue,
    createBranchItemValue,
    hasExactBranchMatch,
    pullRequestByItemValue,
  ]);
  const pullRequestSearchText = useMemo(
    () =>
      new Map(
        Array.from(pullRequestByItemValue, ([itemValue, changeRequest]) => [
          itemValue,
          `#${changeRequest.number} ${changeRequest.title} ${changeRequest.headRefName}`,
        ]),
      ),
    [pullRequestByItemValue],
  );
  const filteredBranchPickerItems = useMemo(
    () =>
      normalizedDeferredBranchQuery.length === 0
        ? branchPickerItems
        : branchPickerItems.filter((itemValue) =>
            shouldIncludeBranchPickerItem({
              itemValue,
              normalizedQuery: normalizedDeferredBranchQuery,
              createBranchItemValue,
              checkoutPullRequestItemValue,
              searchTextByItemValue: pullRequestSearchText,
            }),
          ),
    [
      branchPickerItems,
      checkoutPullRequestItemValue,
      createBranchItemValue,
      normalizedDeferredBranchQuery,
      pullRequestSearchText,
    ],
  );
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const shouldVirtualizeBranchList = filteredBranchPickerItems.length > 40;
  const branchStatusText = isBranchesSearchPending
    ? "Loading refs..."
    : isFetchingNextPage
      ? "Loading more refs..."
      : hasNextPage
        ? `Showing ${refs.length} of ${totalBranchCount} refs`
        : null;

  // ---------------------------------------------------------------------------
  // Branch actions
  // ---------------------------------------------------------------------------
  const runBranchAction = (action: () => Promise<void>) => {
    startBranchActionTransition(async () => {
      await action().catch(() => undefined);
      invalidateScopes([gitScopeKey(branchCwd)]);
    });
  };

  const selectBranch = (refName: VcsRef) => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !branchCwd || !activeProjectCwd || isBranchActionPending) return;

    if (isSelectingWorktreeBase) {
      setThreadBranch(refName.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd,
      activeWorktreePath,
      refName,
    });

    if (selectionTarget.reuseExistingWorktree) {
      setThreadBranch(refName.name, selectionTarget.nextWorktreePath);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = refName.isRemote
      ? deriveLocalBranchNameFromRemoteRef(refName.name)
      : refName.name;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(selectedBranchName);
      try {
        const checkoutResult = await api.vcs.switchRef({
          cwd: selectionTarget.checkoutCwd,
          refName: refName.name,
        });
        const nextBranchName = refName.isRemote
          ? (checkoutResult.refName ?? selectedBranchName)
          : selectedBranchName;
        setOptimisticBranch(nextBranchName);
        setThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
      } catch (error) {
        setOptimisticBranch(previousBranch);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch ref.",
            description: toBranchActionErrorMessage(error),
          }),
        );
      }
    });
  };

  const createRef = (rawName: string) => {
    const name = rawName.trim();
    const api = readEnvironmentApi(environmentId);
    if (!api || !branchCwd || !name || isBranchActionPending) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(name);
      try {
        const createBranchResult = await api.vcs.createRef({
          cwd: branchCwd,
          refName: name,
          switchRef: true,
        });
        setOptimisticBranch(createBranchResult.refName);
        setThreadBranch(createBranchResult.refName, activeWorktreePath);
      } catch (error) {
        setOptimisticBranch(previousBranch);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to create and switch ref.",
            description: toBranchActionErrorMessage(error),
          }),
        );
      }
    });
  };

  useEffect(() => {
    if (
      effectiveEnvMode !== "worktree" ||
      activeWorktreePath ||
      activeThreadBranch ||
      !currentGitBranch
    ) {
      return;
    }
    setThreadBranch(currentGitBranch, null);
  }, [activeThreadBranch, activeWorktreePath, currentGitBranch, effectiveEnvMode, setThreadBranch]);

  // ---------------------------------------------------------------------------
  // Combobox / list plumbing
  // ---------------------------------------------------------------------------
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsBranchMenuOpen(open);
      if (!open) {
        setBranchQuery("");
        return;
      }
      invalidateScopes([gitScopeKey(branchCwd)]);
    },
    [branchCwd],
  );

  const branchListScrollElementRef = useRef<HTMLDivElement | null>(null);
  const maybeFetchNextBranchPage = useCallback(() => {
    if (!isBranchMenuOpen || !hasNextPage || isFetchingNextPage) {
      return;
    }

    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement) {
      return;
    }

    const distanceFromBottom =
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
    if (distanceFromBottom > 96) {
      return;
    }

    fetchNextPage();
  }, [fetchNextPage, hasNextPage, isBranchMenuOpen, isFetchingNextPage]);
  const branchListRef = useRef<LegendListRef | null>(null);
  const setBranchListRef = useCallback((element: HTMLDivElement | null) => {
    branchListScrollElementRef.current = (element?.parentElement as HTMLDivElement | null) ?? null;
  }, []);

  useEffect(() => {
    if (!isBranchMenuOpen) {
      return;
    }

    if (shouldVirtualizeBranchList) {
      branchListRef.current?.scrollToOffset?.({ offset: 0, animated: false });
    } else {
      branchListScrollElementRef.current?.scrollTo({ top: 0 });
    }
  }, [deferredTrimmedBranchQuery, isBranchMenuOpen, shouldVirtualizeBranchList]);

  useEffect(() => {
    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement || !isBranchMenuOpen) {
      return;
    }

    const handleScroll = () => {
      maybeFetchNextBranchPage();
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [isBranchMenuOpen, maybeFetchNextBranchPage]);

  useEffect(() => {
    if (shouldVirtualizeBranchList) return;
    maybeFetchNextBranchPage();
  }, [refs.length, maybeFetchNextBranchPage, shouldVirtualizeBranchList]);

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    omitBasePrefix,
  });

  function renderPickerItem(itemValue: string, index: number) {
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          onClick={() => {
            if (!prReference || !onCheckoutPullRequestRequest) {
              return;
            }
            setIsBranchMenuOpen(false);
            setBranchQuery("");
            onComposerFocusRequest?.();
            onCheckoutPullRequestRequest(prReference);
          }}
        >
          <div className="flex min-w-0 items-center gap-2 py-1">
            <SourceControlIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col items-start">
              <span className="truncate font-medium">
                Checkout {sourceControlPresentation.terminology.singular}
              </span>
              <span className="truncate text-muted-foreground text-xs">{prReference}</span>
            </span>
          </div>
        </ComboboxItem>
      );
    }
    if (createBranchItemValue && itemValue === createBranchItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          onClick={() => createRef(trimmedBranchQuery)}
        >
          <span className="truncate">Create new ref &quot;{trimmedBranchQuery}&quot;</span>
        </ComboboxItem>
      );
    }

    const pullRequest = pullRequestByItemValue.get(itemValue);
    if (pullRequest) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          onClick={() => {
            // Worktree-base mode only, so this records the head ref as the base
            // to fork from — no checkout is attempted here.
            setThreadBranch(pullRequest.headRefName, null);
            setIsBranchMenuOpen(false);
            setBranchQuery("");
            onComposerFocusRequest?.();
          }}
        >
          <div className="flex min-w-0 items-center gap-2 py-1">
            <SourceControlIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col items-start">
              <span className="truncate">
                #{pullRequest.number} {pullRequest.title}
              </span>
              <span className="truncate font-mono text-muted-foreground text-[10px]">
                {pullRequest.headRefName}
              </span>
            </span>
          </div>
        </ComboboxItem>
      );
    }

    const refName = branchByName.get(itemValue);
    if (!refName) return null;

    const hasSecondaryWorktree =
      refName.worktreePath && activeProjectCwd && refName.worktreePath !== activeProjectCwd;
    const badge = refName.current
      ? "current"
      : hasSecondaryWorktree
        ? "worktree"
        : refName.isRemote
          ? "remote"
          : refName.isDefault
            ? "default"
            : null;
    return (
      <ComboboxItem
        hideIndicator
        key={itemValue}
        index={index}
        value={itemValue}
        onClick={() => selectBranch(refName)}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="truncate">{itemValue}</span>
          {badge && <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>}
        </div>
      </ComboboxItem>
    );
  }

  const aheadCount = branchStatusQuery.data?.aheadCount ?? 0;
  const behindCount = branchStatusQuery.data?.behindCount ?? 0;
  // Ahead/behind come from the current checkout, so only show them when the
  // displayed label matches that checkout (not an override/optimistic ref).
  const showAheadBehind =
    resolvedActiveBranch === currentGitBranch && (aheadCount > 0 || behindCount > 0);

  return (
    <Combobox
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      autoHighlight
      virtualized={shouldVirtualizeBranchList}
      onItemHighlighted={(_value, eventDetails) => {
        if (!isBranchMenuOpen || eventDetails.index < 0 || eventDetails.reason !== "keyboard") {
          return;
        }
        branchListRef.current?.scrollIndexIntoView?.({
          index: eventDetails.index,
          animated: false,
        });
      }}
      onOpenChange={handleOpenChange}
      open={isBranchMenuOpen}
      value={resolvedActiveBranch}
    >
      {appearance === "rail" ? (
        <ComboboxTrigger
          render={
            <OverviewRailButton
              icon={<GitBranchIcon />}
              label={<span className="font-mono text-[12px]">{triggerLabel}</span>}
              value={
                showAheadBehind ? (
                  <AheadBehindCounts ahead={aheadCount} behind={behindCount} />
                ) : undefined
              }
              // Behind upstream is the one branch state that wants action.
              tone={showAheadBehind && behindCount > 0 ? "warning" : null}
              aria-label={[
                `Branch ${triggerLabel}`,
                showAheadBehind && aheadCount > 0 ? `${aheadCount} ahead` : null,
                showAheadBehind && behindCount > 0 ? `${behindCount} behind` : null,
              ]
                .filter(Boolean)
                .join(", ")}
            />
          }
          disabled={(isBranchesSearchPending && refs.length === 0) || isBranchActionPending}
        />
      ) : appearance === "pill" || appearance === "panelRow" ? (
        <div
          data-appearance={appearance}
          className={cn(
            "min-w-0 items-center overflow-hidden",
            appearance === "pill"
              ? "inline-flex h-[30px] rounded-[9px] border border-input bg-popover shadow-xs"
              : "flex h-9 w-full bg-transparent",
            className,
          )}
        >
          {repositoryRemote.webUrl ? (
            <button
              type="button"
              onClick={repositoryRemote.open}
              title={repositoryRemote.openLabel}
              aria-label="Open repository remote"
              className={cn(
                "grid h-full shrink-0 place-items-center text-foreground/80 transition-colors hover:bg-accent",
                appearance === "pill" ? "pr-1 pl-2.5" : "w-[37px]",
              )}
            >
              {appearance === "pill" ? (
                <PillIcon className="size-3.5" />
              ) : (
                <span className="grid size-5 place-items-center rounded-md bg-secondary text-muted-foreground [&_svg]:size-3">
                  <PillIcon />
                </span>
              )}
            </button>
          ) : (
            <span
              className={cn(
                "grid h-full shrink-0 place-items-center text-foreground/80",
                appearance === "pill" ? "pr-1 pl-2.5" : "w-[37px]",
              )}
            >
              {appearance === "pill" ? (
                <PillIcon className="size-3.5" />
              ) : (
                <span className="grid size-5 place-items-center rounded-md bg-secondary text-muted-foreground [&_svg]:size-3">
                  <PillIcon />
                </span>
              )}
            </span>
          )}
          <ComboboxTrigger
            render={<Button variant="ghost" size="sm" />}
            className={cn(
              "h-full min-w-0 gap-1.5 rounded-none border-0 bg-transparent text-foreground shadow-none before:shadow-none",
              appearance === "pill"
                ? "pr-2.5 pl-1 text-[13px] font-medium"
                : "flex-1 justify-start pr-2.5 pl-0 text-[11.5px] font-semibold hover:bg-accent",
            )}
            disabled={(isBranchesSearchPending && refs.length === 0) || isBranchActionPending}
          >
            <span
              className={cn(
                "min-w-0 truncate font-mono",
                appearance === "pill" ? "max-w-[170px]" : "flex-1 text-left",
              )}
            >
              {triggerLabel}
            </span>
            {showAheadBehind ? (
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1 font-mono font-semibold text-muted-foreground tabular-nums",
                  appearance === "pill" ? "text-[11px]" : "text-[10px]",
                )}
              >
                <AheadBehindCounts ahead={aheadCount} behind={behindCount} />
              </span>
            ) : null}
            <ChevronDownIcon
              className={cn(
                "shrink-0 text-muted-foreground",
                appearance === "pill" ? "size-3.5" : "size-3",
              )}
            />
          </ComboboxTrigger>
        </div>
      ) : (
        <ComboboxTrigger
          render={<Button variant="ghost" size="xs" />}
          className={cn("min-w-0 text-muted-foreground/70 hover:text-foreground/80", className)}
          disabled={(isBranchesSearchPending && refs.length === 0) || isBranchActionPending}
        >
          <span className="min-w-0 max-w-[240px] truncate">{triggerLabel}</span>
          <ChevronDownIcon className="shrink-0" />
        </ComboboxTrigger>
      )}
      <ComboboxPopup
        align={appearance === "rail" ? "start" : "end"}
        side={appearance === "rail" ? "left" : "top"}
        sideOffset={appearance === "rail" ? 10 : undefined}
        className={cn(
          "w-80",
          appearance === "rail"
            ? "data-ending-style:translate-x-1 data-starting-style:translate-x-1"
            : "data-ending-style:translate-y-1 data-starting-style:translate-y-1",
        )}
      >
        <div className="border-b p-1">
          <ComboboxInput
            className="[&_input]:font-sans rounded-md"
            inputClassName="ring-0"
            placeholder="Search refs..."
            showTrigger={false}
            size="sm"
            value={branchQuery}
            onChange={(event) => setBranchQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No refs found.</ComboboxEmpty>

        {shouldVirtualizeBranchList ? (
          <ComboboxListVirtualized>
            <LegendList<string>
              ref={branchListRef}
              data={filteredBranchPickerItems}
              keyExtractor={(item) => item}
              renderItem={({ item, index }) => renderPickerItem(item, index)}
              estimatedItemSize={28}
              drawDistance={336}
              onEndReached={() => {
                if (hasNextPage && !isFetchingNextPage) {
                  fetchNextPage();
                }
              }}
              style={{ maxHeight: "14rem" }}
            />
          </ComboboxListVirtualized>
        ) : (
          <ComboboxList ref={setBranchListRef} className="max-h-56">
            {filteredBranchPickerItems.map((itemValue, index) =>
              renderPickerItem(itemValue, index),
            )}
          </ComboboxList>
        )}
        {branchStatusText ? <ComboboxStatus>{branchStatusText}</ComboboxStatus> : null}
      </ComboboxPopup>
    </Combobox>
  );
}

function AheadBehindCounts({ ahead, behind }: { ahead: number; behind: number }) {
  return (
    <>
      {ahead > 0 ? (
        <span className="flex items-center gap-0.5">
          <ArrowUpIcon className="size-[11px]" />
          {ahead}
        </span>
      ) : null}
      {behind > 0 ? (
        <span className="flex items-center gap-0.5">
          <ArrowDownIcon className="size-[11px]" />
          {behind}
        </span>
      ) : null}
    </>
  );
}
