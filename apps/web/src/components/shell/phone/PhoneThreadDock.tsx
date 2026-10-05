import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  CheckIcon,
  EllipsisIcon,
  GitBranchIcon,
  LayersIcon,
  PanelRightIcon,
  SearchIcon,
} from "lucide-react";

import type { DraftId } from "../../../composerDraftStore";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../../store";
import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../../../types";
import type { SessionTabItem } from "../../../sessionTabs.selectors";
import { MobileContextStrip, type MobileContextStripItem } from "../../mobile/MobileContextStrip";
import { MobileListRow } from "../../mobile/MobileListRow";
import {
  MobileSheet,
  MobileSheetHeader,
  MobileSheetPanel,
  MobileSheetTitle,
} from "../../mobile/MobileSheet";
import { ThreadStatusDetailLine } from "../../ThreadStatusIndicators";
import { PhoneThreadActionsSheet, PhoneThreadRenameDialog } from "./PhoneThreadActionsSheet";
import { usePhoneThreadActions } from "./usePhoneThreadActions";

const EMPTY_MEMBER_PROJECTS = new Map<string, never>();

export interface PhoneThreadDockProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly projectCwd: string | null;
  /** The worktree branch this thread runs on, when it is known. */
  readonly branch: string | null;
  /**
   * Present on the draft route: the overflow sheet then offers the draft
   * inventory ("Discard draft") through the same shared dispatcher instead of
   * an empty menu, since drafts have no server-side sidebar summary.
   */
  readonly draft?: {
    readonly draftId: DraftId;
    readonly projectId: ProjectId;
    readonly createdAt: string;
  } | null;
  readonly workspacePanelOpen: boolean;
  readonly onToggleWorkspacePanel: () => void;
  readonly onOpenFindInThread: () => void;
  /**
   * Opens the overview (source-control) surface full-screen. Null on draft
   * threads: a draft has no turns, checkpoints, or worktree yet, so the
   * surface would only render empty states.
   */
  readonly onOpenSourceControl: (() => void) | null;
  readonly sessionTabs: ReadonlyArray<SessionTabItem>;
  readonly activeSessionTabKey: string | null;
  readonly onSelectSessionTab: ((key: string) => void) | null;
}

/**
 * The thread surface's dock row: the controls that used to sit in the app
 * bar's top-right corner, relocated to the bottom of the screen directly above
 * the composer capsule.
 *
 * It is deliberately **not** the floating `MobileDock` overlay. On this surface
 * the composer capsule is already the bottom-anchored, keyboard-inset-riding
 * dock, so a second floating capsule would sit on top of it. This row is laid
 * out with the composer instead, and the composer's own bottom padding carries
 * the safe area and the keyboard inset for both.
 *
 * The workspace toggle and the thread-actions overflow are the two controls the
 * audit found in the top-right corner specifically. The strip between them
 * carries the thread's contextual entry points — branch, find, sessions — each
 * a ≥44 px target reusing the behaviour it already had.
 */
export function PhoneThreadDock(props: PhoneThreadDockProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const threadKey = scopedThreadKey(scopeThreadRef(props.environmentId, props.threadId));
  const summaries = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const summary = useMemo(
    () =>
      summaries.find(
        (thread) => thread.id === props.threadId && thread.environmentId === props.environmentId,
      ) ?? null,
    [props.environmentId, props.threadId, summaries],
  );
  // Drafts have no server summary; a minimal synthetic summary carries the
  // draftId so the shared inventory resolves to "Discard draft" and the
  // shared dispatcher clears the draft.
  const draftSummary = useMemo<(SidebarThreadSummary & { draftId: DraftId }) | null>(() => {
    if (!props.draft) return null;
    return {
      id: props.threadId,
      environmentId: props.environmentId,
      projectId: props.draft.projectId,
      title: props.title,
      interactionMode: DEFAULT_INTERACTION_MODE,
      session: null,
      createdAt: props.draft.createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      branch: null,
      worktreePath: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      draftId: props.draft.draftId,
    };
  }, [props.draft, props.environmentId, props.threadId, props.title]);
  const resolvedSummary = summary ?? draftSummary;
  const summaryByKeyRef = useRef<ReadonlyMap<string, SidebarThreadSummary>>(new Map());
  summaryByKeyRef.current = useMemo(
    () => new Map(resolvedSummary ? [[threadKey, resolvedSummary] as const] : []),
    [resolvedSummary, threadKey],
  );
  const threadActions = usePhoneThreadActions({
    sidebarThreadByKeyRef: summaryByKeyRef,
    memberProjectByScopedKey: EMPTY_MEMBER_PROJECTS,
    projectCwd: props.projectCwd,
  });
  const menuItems = resolvedSummary ? threadActions.listThreadMenuActions(threadKey) : [];
  // `> 0`, matching the app-bar sheet this replaces. A one-session worktree
  // still gets the affordance: hiding it below two sessions would drop a
  // control on the phone tier only.
  const canSelectSessionTab = props.sessionTabs.length > 0 && props.onSelectSessionTab !== null;

  const stripItems: MobileContextStripItem[] = [
    {
      id: "find",
      label: "Find in thread",
      icon: <SearchIcon aria-hidden className="size-3.5 shrink-0" />,
      onSelect: props.onOpenFindInThread,
    },
    ...(props.onOpenSourceControl
      ? [
          {
            id: "source-control",
            label: "Source control",
            ...(props.branch === null ? {} : { value: props.branch }),
            icon: <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />,
            onSelect: props.onOpenSourceControl,
          } satisfies MobileContextStripItem,
        ]
      : []),
    ...(canSelectSessionTab
      ? [
          {
            id: "sessions",
            label: "Sessions",
            value: String(props.sessionTabs.length),
            icon: <LayersIcon aria-hidden className="size-3.5 shrink-0" />,
            onSelect: () => setSessionsOpen(true),
          } satisfies MobileContextStripItem,
        ]
      : []),
  ];

  return (
    <>
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5" data-slot="phone-thread-dock">
        <button
          type="button"
          aria-label="Toggle workspace panel"
          aria-pressed={props.workspacePanelOpen}
          // The same fixed 44px floor the dock capsule pins its controls to,
          // in px so no type scale can shrink it. This control measured 32×32
          // in the app bar.
          className="flex min-h-[var(--app-dock-control-size)] min-w-[var(--app-dock-control-size)] shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:text-foreground"
          onClick={props.onToggleWorkspacePanel}
        >
          <PanelRightIcon aria-hidden className="size-4" />
        </button>
        {/* `w-0 grow`, not `flex-1`. Both grow from a zero base, so inside a
            viewport-sized column they are identical. They differ in what the
            rail contributes to an ancestor sized by *min-content*: the rail is
            a block-level scroll container whose pills do not shrink, so its
            min-content width is the sum of the pills — and `min-width: 0` on
            the flex item clamps the used width, not that contribution. `w-0`
            zeroes it. Verified needed: with `flex-1` the rail widens the
            thread column to 367px inside a 320px viewport in the real-path
            `ChatView` browser harness, whose host box is a `display: grid`
            container (grid items take `min-width: auto`). Production's `#root`
            is `max-width: 100%; overflow-x: clip` and has no such ancestor, so
            this is robustness rather than a fix for a live defect — the
            property is pinned in `MobileContextStrip.browser.tsx`. */}
        <MobileContextStrip label="Thread context" items={stripItems} className="w-0 grow" />
        <button
          type="button"
          aria-label="Thread actions"
          className="flex min-h-[var(--app-dock-control-size)] min-w-[var(--app-dock-control-size)] shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setMenuOpen(true)}
        >
          <EllipsisIcon aria-hidden className="size-4" />
        </button>
      </div>
      <PhoneThreadActionsSheet
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={props.title}
        items={menuItems}
        onAction={(actionId) => {
          void threadActions.performThreadMenuAction(
            scopeThreadRef(props.environmentId, props.threadId),
            actionId,
          );
        }}
        leadingSections={summary ? <ThreadStatusDetailLine thread={summary} /> : undefined}
      />
      <MobileSheet
        open={sessionsOpen}
        onOpenChange={setSessionsOpen}
        label="Sessions in this worktree"
        detent="medium"
      >
        <MobileSheetHeader>
          <MobileSheetTitle>Sessions</MobileSheetTitle>
        </MobileSheetHeader>
        <MobileSheetPanel>
          <div role="group" aria-label="Sessions in this worktree" className="space-y-0.5">
            {props.sessionTabs.map((tab) => (
              <MobileListRow
                key={tab.key}
                label={tab.title}
                selected={tab.key === props.activeSessionTabKey}
                trailing={
                  tab.key === props.activeSessionTabKey ? (
                    <CheckIcon aria-hidden className="size-4 shrink-0" />
                  ) : undefined
                }
                onClick={() => {
                  setSessionsOpen(false);
                  props.onSelectSessionTab?.(tab.key);
                }}
              />
            ))}
          </div>
        </MobileSheetPanel>
      </MobileSheet>
      <PhoneThreadRenameDialog
        renamingThreadKey={threadActions.renamingThreadKey}
        originalTitle={summary?.title ?? props.title}
        renamingTitle={threadActions.renamingTitle}
        setRenamingTitle={threadActions.setRenamingTitle}
        commitRename={threadActions.commitRename}
        cancelRename={threadActions.cancelRename}
      />
    </>
  );
}
