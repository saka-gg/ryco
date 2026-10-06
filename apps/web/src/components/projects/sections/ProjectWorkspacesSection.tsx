import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { ThreadId, WS_METHODS } from "@ryco/contracts";
import { useRouter } from "@tanstack/react-router";
import { ChevronRightIcon, GitBranchIcon, MapIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { useThreadActions } from "../../../hooks/useThreadActions";
import { useHostedRpcCapability } from "../../../hostedHub/capabilities";
import {
  DISCLOSURE_INNER_CLASS,
  disclosureChevronClassName,
  disclosureShellClassName,
} from "../../../lib/disclosureMotion";
import { cn } from "../../../lib/utils";
import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";
import {
  selectSidebarThreadsForProjectRef,
  selectSidebarWorktreesForProjectRef,
  useStore,
} from "../../../store";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { useUiStateStore } from "../../../uiStateStore";
import {
  formatSuggestionDays,
  LIFECYCLE_SUGGESTION_COPY,
  parseSuggestionDays,
  suggestionDayOptions,
  suggestionDaysValue,
  useLifecycleSuggestionPolicyEditor,
} from "../../settings/lifecycleSuggestionPolicy";
import { SETTINGS_INSET_CLASS, SettingsBlock, SettingsRow } from "../../settings/settingsLayout";
import { SettingsSelect } from "../../settings/SettingsSelect";
import { Button } from "../../ui/button";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { NewWorktreeDialog } from "../../worktrees/NewWorktreeDialog";
import { useProjectsPage } from "../ProjectsPageContext";
import { ProjectNodeSettingsScope } from "./ProjectNodeSettingsScope";
import { ProjectSection } from "./ProjectSection";
import type { ProjectSectionProps } from "./projectSectionTypes";
import {
  excludePinnedSuggestions,
  projectSuggestions,
  workspaceFacts,
  workspaceInspectionSignature,
} from "./projectWorkspaces.logic";
import {
  useProjectWorkspaceInspection,
  type WorkspaceInspection,
} from "./useProjectWorkspaceInspection";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Approval-only suggestions for this project; nothing happens until one is chosen. */
function WorkspaceSuggestions(props: {
  readonly member: SidebarProjectGroupMember;
  readonly inspection: WorkspaceInspection;
  readonly threadIds: readonly string[];
  readonly threadWorktreeIds: ReadonlyMap<string, string>;
  readonly canMutate: boolean;
  readonly onReviewRemoval: (worktreeId: string) => void;
  readonly onArchived: () => void;
}) {
  const { member, inspection } = props;
  const { archiveThread } = useThreadActions();
  const pinnedThreadKeys = useUiStateStore((state) => state.pinnedThreadKeys);
  const suggestions = useMemo(() => {
    if (inspection.status !== "ready" || !inspection.suggestions) return null;
    const isPinned = (threadId: string) =>
      Boolean(
        pinnedThreadKeys[
          scopedThreadKey(scopeThreadRef(member.environmentId, ThreadId.make(threadId)))
        ],
      );
    const pinnedWorktreeIds = new Set(
      props.threadIds.flatMap((threadId) => {
        const worktreeId = props.threadWorktreeIds.get(threadId);
        return isPinned(threadId) && worktreeId ? [worktreeId] : [];
      }),
    );
    return excludePinnedSuggestions(
      projectSuggestions(inspection.suggestions, member.id),
      isPinned,
      pinnedWorktreeIds,
    );
  }, [
    inspection,
    member.environmentId,
    member.id,
    pinnedThreadKeys,
    props.threadIds,
    props.threadWorktreeIds,
  ]);
  if (!suggestions || (suggestions.checkouts.length === 0 && suggestions.threads.length === 0)) {
    return null;
  }

  const archive = async (threadId: string, title: string) => {
    try {
      await archiveThread(scopeThreadRef(member.environmentId, ThreadId.make(threadId)));
      props.onArchived();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to archive "${title}"`,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  return (
    <SettingsBlock flush className="border-t border-border/60">
      <div role="list" aria-label="Cleanup suggestions" className="flex flex-col">
        <p className={cn("pt-3 pb-1 text-xs text-muted-foreground", SETTINGS_INSET_CLASS)}>
          Suggested cleanup — nothing changes until you choose.
        </p>
        {suggestions.checkouts.map((checkout) => (
          <div
            key={checkout.worktreeId}
            role="listitem"
            className={cn("flex items-center gap-3 py-2", SETTINGS_INSET_CLASS)}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{checkout.title}</p>
              <p className="text-[11px] text-muted-foreground">
                All {checkout.conversations} conversation
                {checkout.conversations === 1 ? "" : "s"} archived{" "}
                {formatRelativeTimeLabel(checkout.archivedSince)}
              </p>
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={!props.canMutate}
              onClick={() => props.onReviewRemoval(checkout.worktreeId)}
            >
              Review removal
            </Button>
          </div>
        ))}
        {suggestions.threads.map((thread) => (
          <div
            key={thread.threadId}
            role="listitem"
            className={cn("flex items-center gap-3 py-2", SETTINGS_INSET_CLASS)}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{thread.title}</p>
              <p className="text-[11px] text-muted-foreground">
                Inactive since {formatRelativeTimeLabel(thread.lastActivityAt)}
              </p>
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={!props.canMutate}
              onClick={() => void archive(thread.threadId, thread.title)}
            >
              Archive
            </Button>
          </div>
        ))}
      </div>
    </SettingsBlock>
  );
}

/** One disclosure row, the same shape as the archived fold. */
function Disclosure(props: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SettingsBlock flush>
      <button
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className={cn(
          "flex w-full items-center gap-1.5 py-2.5 text-left text-xs text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:text-foreground focus-visible:bg-accent/55",
          SETTINGS_INSET_CLASS,
        )}
      >
        <ChevronRightIcon className={disclosureChevronClassName(props.open)} />
        {props.label}
        {props.hint && !props.open ? (
          <span className="ml-auto truncate pl-3">{props.hint}</span>
        ) : null}
      </button>
      <div className={disclosureShellClassName(props.open)}>
        <div className={DISCLOSURE_INNER_CLASS}>
          <div className="flex flex-col border-t border-border/60" inert={!props.open}>
            {props.children}
          </div>
        </div>
      </div>
    </SettingsBlock>
  );
}

/**
 * This project's override of the device's cleanup suggestions. The override
 * is the whole policy: until it is set the device setting applies, and it
 * can be reset back to it.
 */
function CleanupSuggestionSettings(props: { readonly member: SidebarProjectGroupMember }) {
  const { member } = props;
  const editor = useLifecycleSuggestionPolicyEditor({
    environmentId: member.environmentId,
    projectId: member.id,
  });
  const [open, setOpen] = useState(false);
  const { policy, devicePolicy, overridden } = editor;
  const busy = editor.saving || policy === null || devicePolicy === null;
  const fields = ["archiveInactiveThreadsDays", "removeArchivedCheckoutsDays"] as const;
  const hint = policy
    ? `${overridden ? "This project" : "Device setting"} · ${fields
        .map((field) => formatSuggestionDays(policy[field]))
        .join(" / ")}`
    : null;
  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((value) => !value)}
      label="Cleanup suggestions"
      hint={hint}
    >
      {fields.map((field) => {
        const copy = LIFECYCLE_SUGGESTION_COPY[field];
        const days = policy?.[field] ?? null;
        const deviceDays = devicePolicy?.[field] ?? null;
        return (
          <SettingsRow
            key={field}
            title={copy.title}
            description={copy.description}
            control={
              <SettingsSelect
                ariaLabel={copy.ariaLabel}
                width="sm"
                disabled={busy}
                value={overridden ? suggestionDaysValue(days) : "device"}
                onValueChange={(value) => {
                  if (value === "device") return;
                  void editor.setField(field, parseSuggestionDays(value));
                }}
                options={[
                  ...(overridden
                    ? []
                    : [
                        {
                          value: "device",
                          label: `Device setting (${formatSuggestionDays(deviceDays)})`,
                        },
                      ]),
                  ...suggestionDayOptions(days),
                ]}
              />
            }
          />
        );
      })}
      {overridden ? (
        <SettingsRow
          title="Follow the device setting"
          description="Drop this project's values and use the device's again."
          control={
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void editor.save(null)}
            >
              Use device setting
            </Button>
          }
        />
      ) : null}
    </Disclosure>
  );
}

/**
 * The checkout's workspaces, in brief: how many there are and how many need
 * care, with the map one click away (it shows them across every device, with
 * their threads and automations, and reviews checkout changes in place).
 * Cleanup suggestions and their timing stay here, with the other settings.
 */
export function ProjectWorkspacesSection({ member, canEdit, canManageNode }: ProjectSectionProps) {
  const router = useRouter();
  const { nav } = useProjectsPage();
  const ref = useMemo(() => scopeProjectRef(member.environmentId, member.id), [member]);
  const threads = useStore(useShallow((state) => selectSidebarThreadsForProjectRef(state, ref)));
  const worktrees = useStore(
    useShallow((state) => selectSidebarWorktreesForProjectRef(state, ref)),
  );
  const listCapability = useHostedRpcCapability(WS_METHODS.lifecycleListWorkspaces);
  const suggestionsCapability = useHostedRpcCapability(WS_METHODS.lifecycleSuggestions);
  const applyCapability = useHostedRpcCapability(WS_METHODS.lifecycleApplyWorkspace);
  const createCapability = useHostedRpcCapability(WS_METHODS.gitCreateWorktreeForProject);
  const signature = useMemo(() => workspaceInspectionSignature(worktrees), [worktrees]);
  const { inspection, reinspect } = useProjectWorkspaceInspection({
    environmentId: member.environmentId,
    projectId: member.id,
    signature,
    enabled: listCapability.allowed,
    suggestionsEnabled: suggestionsCapability.allowed,
  });
  const canMutate = canEdit && applyCapability.allowed;
  const [dialogOpen, setDialogOpen] = useState(false);

  const live = worktrees.filter((worktree) => worktree.archivedAt == null).length;
  const archived = worktrees.length - live;
  const needsCare =
    inspection.status === "ready"
      ? inspection.summaries.filter(
          (summary) =>
            !summary.archivedAt && workspaceFacts(summary).some((fact) => fact.tone === "warning"),
        ).length
      : null;
  const threadIds = useMemo(() => threads.map((thread) => thread.id), [threads]);
  const threadWorktreeIds = useMemo(
    () =>
      new Map(
        threads.flatMap((thread) => (thread.worktreeId ? [[thread.id, thread.worktreeId]] : [])),
      ),
    [threads],
  );

  return (
    <ProjectSection
      section="workspaces"
      description="The main checkout and its worktrees. The map shows them across every device, with their threads and the automations that run there."
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={!canEdit || !createCapability.allowed}
          onClick={() => setDialogOpen(true)}
        >
          <GitBranchIcon className="size-3.5" />
          New worktree
        </Button>
      }
    >
      <SettingsRow
        title={live === 0 ? "No worktrees yet" : plural(live, "worktree")}
        description={
          [
            archived ? `${archived} archived` : null,
            needsCare ? `${needsCare} need${needsCare === 1 ? "s" : ""} care` : null,
            inspection.status === "error" ? inspection.message : null,
          ]
            .filter(Boolean)
            .join(" · ") ||
          "Worktrees let threads work on several branches at once without touching the main checkout."
        }
        control={
          <Button size="sm" variant="ghost" onClick={() => nav.setView("map")}>
            <MapIcon className="size-3.5" />
            Open map
          </Button>
        }
      />
      <WorkspaceSuggestions
        member={member}
        inspection={inspection}
        threadIds={threadIds}
        threadWorktreeIds={threadWorktreeIds}
        canMutate={canMutate}
        onReviewRemoval={(worktreeId) => nav.openWorkspaceReview(worktreeId, "remove-checkout")}
        onArchived={reinspect}
      />
      {canManageNode ? (
        <ProjectNodeSettingsScope environmentId={member.environmentId}>
          <CleanupSuggestionSettings member={member} />
        </ProjectNodeSettingsScope>
      ) : null}
      <NewWorktreeDialog
        open={dialogOpen}
        environmentId={member.environmentId}
        projectId={member.id}
        cwd={member.cwd}
        initialTab="branches"
        onCreated={(result) =>
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(member.environmentId, result.sessionId)),
          })
        }
        onOpenChange={setDialogOpen}
      />
    </ProjectSection>
  );
}
