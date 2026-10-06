import {
  automationRunStatusLabel,
  definitionWithEnabled,
  type ScheduleProposal,
} from "@ryco/client-runtime/state/agentControl";
import {
  listThreadLifecycleActions,
  WORKSPACE_LIFECYCLE_ACTION_LABELS,
  type ThreadLifecycleActionId,
  type WorkspaceActionId,
} from "@ryco/client-runtime/state/lifecycle";
import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  AGENT_CONTROL_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
  WorktreeId,
  type AgentControlProposalId,
  type EnvironmentId,
} from "@ryco/contracts";
import { useRouter } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  ClockIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  OctagonPauseIcon,
  PauseIcon,
  PlayIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SquareIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { openInPreferredEditor } from "../../../editorPreferences";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { useThreadActions } from "../../../hooks/useThreadActions";
import { useHostedRpcCapability } from "../../../hostedHub/capabilities";
import { cn } from "../../../lib/utils";
import { buildPullRequestsPageLocation } from "../../../pullRequestsRoute";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { readLocalApi } from "../../../localApi";
import { renameThread } from "../../../threadMutations";
import { buildThreadRouteParams } from "../../../threadRoutes";
import {
  openWorkspaceReviewDialog,
  runWorkspaceLifecycleAction,
} from "../../../workspaceLifecycle";
import { DeviceIcon } from "../../DeviceIcon";
import { openAutomationsDialog } from "../../automations/automationsDialogStore";
import { checkoutAutomationCounts } from "../../automations/data/automationProjectCounts.logic";
import { useMinuteNow } from "../../automations/dialog/clock";
import { PROPOSAL_HEAD, plural } from "../../automations/dialog/dialogWords";
import { InboxStatusGlyph } from "../../inboxSidebar/InboxStatusGlyph";
import { RelativeTime } from "../../pullRequests/primitives";
import {
  resolveWorktreeOpenTarget,
  useSidebarWorktreeActions,
} from "../../sidebar/hooks/useSidebarWorktreeActions";
import { useThreadClipboardActions } from "../../sidebar/hooks/useThreadClipboardActions";
import { Button } from "../../ui/button";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { NewWorktreeDialog } from "../../worktrees/NewWorktreeDialog";
import { InlineNameField, ProjectImage, ProjectNameField } from "../detail/ProjectHero";
import { useProjectsPage, useProjectsSelection } from "../ProjectsPageContext";
import { projectRepositoryLabel } from "../projectsModel.logic";
import {
  isWorkspaceReviewAction,
  type ProjectSection,
  type WorkspaceReviewAction,
} from "../projectsSearch";
import { PROJECT_SECTION_COMPONENTS } from "../sections/projectSectionComponents";
import { visibleProjectSections, type ProjectSectionProps } from "../sections/projectSectionTypes";
import { availableWorkspaceActions } from "../sections/projectWorkspaces.logic";
import { useProjectEditAccess } from "../sections/useProjectEditAccess";
import { WorkspaceReview } from "../sections/WorkspaceReview";
import { nextRunLabel } from "./projectMapModel";
import { useNowMs } from "./ProjectMapNodes";
import type { MapCheckoutDetail } from "./useProjectMapCheckouts";

export type MapSelection =
  | { readonly kind: "project" }
  | { readonly kind: "device"; readonly checkoutKey: string }
  | {
      readonly kind: "workspace";
      readonly checkoutKey: string;
      readonly id: string;
      /** A checkout change under review, shown in place of the details. */
      readonly review?: WorkspaceReviewAction | undefined;
    }
  | { readonly kind: "automation"; readonly checkoutKey: string; readonly id: string }
  | { readonly kind: "thread"; readonly checkoutKey: string; readonly id: string };

const ACTION_ICONS: Record<WorkspaceActionId, typeof ArchiveIcon> = {
  archive: ArchiveIcon,
  restore: ArchiveRestoreIcon,
  "recreate-checkout": FolderPlusIcon,
  "remove-stale-record": FolderMinusIcon,
  "remove-checkout": FolderMinusIcon,
  "delete-workspace": Trash2Icon,
};

/* ---------------------------------------------------------------- pieces */

function Kind(props: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      {props.icon}
      {props.children}
    </div>
  );
}

function Title(props: { readonly mono?: boolean; readonly children: ReactNode }) {
  return (
    <h3
      className={cn(
        "mt-1.5 mr-7 break-words text-[15px] font-semibold tracking-tight",
        props.mono && "font-mono text-[14px] font-medium",
      )}
    >
      {props.children}
    </h3>
  );
}

function Facts(props: { readonly rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="mt-3.5 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
      {props.rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="mt-4 border-t border-border/60 pt-3">
      <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">{props.title}</h4>
      <div className="-mx-2 flex flex-col">{props.children}</div>
    </section>
  );
}

function LinkRow(props: {
  readonly onClick: () => void;
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-left text-[12.5px] outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.children}</span>
      {props.trailing}
    </button>
  );
}

function Actions(props: { readonly children: ReactNode; readonly disabledReason?: string | null }) {
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-1.5">{props.children}</div>
      {props.disabledReason ? (
        <p className="mt-2 text-[11.5px] text-muted-foreground">{props.disabledReason}</p>
      ) : null}
    </>
  );
}

const findDetail = (details: readonly MapCheckoutDetail[], key: string) =>
  details.find((detail) => detail.checkout.key === key) ?? null;

/* ---------------------------------------------------------------- kinds */

/** Sections the map's project card edits; devices, workspaces and automations are the map itself. */
const CARD_SECTIONS = new Set<ProjectSection>([
  "location",
  "repository",
  "defaults",
  "actions",
  "instructions",
  "integrations",
  "danger",
]);

/**
 * The project, edited in place: its image and name, then the same settings
 * sections as the settings view, for one of its checkouts at a time.
 */
function ProjectPanel(props: {
  readonly snapshot: SidebarProjectSnapshot;
  readonly details: readonly MapCheckoutDetail[];
  readonly onSelect: (selection: MapSelection) => void;
  readonly onOpenSettings: () => void;
}) {
  const router = useRouter();
  const { nav } = useProjectsPage();
  const { member, checkoutKey } = useProjectsSelection();
  const access = useProjectEditAccess(member.environmentId);
  const { handleNewThread } = useNewThreadHandler();
  const repository = projectRepositoryLabel(props.snapshot.repositoryIdentity);
  const sections = visibleProjectSections({ canManageNode: access.canManageNode }).filter(
    (section) => CARD_SECTIONS.has(section),
  );
  const sectionProps: ProjectSectionProps = {
    member,
    canEdit: access.canEdit,
    canManageNode: access.canManageNode,
  };
  return (
    <>
      <Kind icon={<FolderIcon className="size-3.5" />}>Project</Kind>
      <div className="mt-2 mr-7 flex min-w-0 items-center gap-3">
        <ProjectImage member={member} canEdit={access.canEdit} compact />
        <div className="min-w-0 flex-1">
          <ProjectNameField member={member} canEdit={access.canEdit} compact />
          <p className="truncate font-mono text-[11px] text-muted-foreground" title={member.cwd}>
            {repository ?? member.cwd}
          </p>
        </div>
      </div>
      <Actions>
        <Button
          size="sm"
          disabled={!access.canEdit}
          onClick={() => void handleNewThread(scopeProjectRef(member.environmentId, member.id))}
        >
          <SquarePenIcon className="size-3.5" />
          New thread
        </Button>
        {repository ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void router.navigate(
                buildPullRequestsPageLocation({
                  environmentId: member.environmentId,
                  projectId: member.id,
                }),
              )
            }
          >
            <GitPullRequestIcon className="size-3.5" />
            Pull requests
          </Button>
        ) : null}
      </Actions>
      <AutomationsEntry snapshot={props.snapshot} details={props.details} />
      <Section title={`On ${props.details.length} device${props.details.length === 1 ? "" : "s"}`}>
        {props.details.map((detail) => (
          <LinkRow
            key={detail.checkout.key}
            onClick={() => props.onSelect({ kind: "device", checkoutKey: detail.checkout.key })}
            icon={
              <DeviceIcon
                environmentId={detail.member.environmentId}
                label={detail.checkout.deviceLabel}
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            }
            trailing={
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {detail.checkout.cwd}
              </span>
            }
          >
            {detail.checkout.deviceLabel}
          </LinkRow>
        ))}
      </Section>
      <section aria-label="Settings" className="mt-4 border-t border-border/60 pt-3">
        <div className="mb-3 flex min-w-0 items-center gap-2">
          <h4 className="text-[11px] font-medium text-muted-foreground">Settings</h4>
          {props.details.length > 1 ? (
            <div
              role="radiogroup"
              aria-label="Checkout to edit"
              className="ml-auto flex min-w-0 gap-0.5 rounded-md bg-muted/60 p-0.5"
            >
              {props.details.map((detail) => {
                const active = detail.checkout.key === checkoutKey;
                return (
                  <button
                    key={detail.checkout.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() =>
                      nav.selectCheckout({
                        environmentId: detail.member.environmentId,
                        projectId: detail.member.id,
                      })
                    }
                    className={cn(
                      "min-w-0 truncate rounded-[5px] px-2 py-0.5 text-[11.5px] outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {detail.checkout.deviceLabel}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        {access.reason || access.nodeReason ? (
          <p className="mb-3 text-[11.5px] text-muted-foreground">
            {access.reason ?? access.nodeReason}
          </p>
        ) : null}
        <div key={checkoutKey} className="flex flex-col gap-7">
          {sections.map((section) => {
            const SectionComponent = PROJECT_SECTION_COMPONENTS[section];
            return <SectionComponent key={section} {...sectionProps} />;
          })}
        </div>
        <Button size="sm" variant="ghost" className="mt-5 -ml-2" onClick={props.onOpenSettings}>
          <Settings2Icon className="size-3.5" />
          Open all settings
        </Button>
      </section>
    </>
  );
}

/**
 * The project's schedules in one line — "3 schedules · 1 waiting ›" — that
 * opens the Automations dialog on this project (it grows out of the line).
 */
function AutomationsEntry(props: {
  readonly snapshot: SidebarProjectSnapshot;
  readonly details: readonly MapCheckoutDetail[];
}) {
  const nowMs = useMinuteNow();
  let schedules = 0;
  let waiting = 0;
  for (const detail of props.details) {
    if (!detail.automationSnapshot) continue;
    const counts = checkoutAutomationCounts({
      projectId: ProjectId.make(detail.member.id),
      snapshot: detail.automationSnapshot,
      nowMs,
    });
    schedules += counts.schedules;
    waiting += counts.waiting;
  }
  const name = props.snapshot.displayName;
  return (
    <button
      type="button"
      data-testid="map-automations-entry"
      aria-label={`Automations for ${name}: ${schedules ? plural(schedules, "schedule") : "none yet"}${waiting ? `, ${waiting} waiting for approval` : ""}`}
      onClick={(event) =>
        openAutomationsDialog({
          projectKey: props.snapshot.projectKey,
          origin: event.currentTarget,
        })
      }
      className="mt-3 flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-border/70 px-2.5 text-left text-[12.5px] outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CalendarClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">
        {schedules ? plural(schedules, "schedule") : "No schedules"}
      </span>
      {waiting ? (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-warning" />
          {waiting} waiting
        </span>
      ) : null}
      <ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** Schedule changes proposed and waiting for approval, approved or rejected right here. */
function PendingChanges(props: {
  readonly detail: MapCheckoutDetail;
  readonly changes: readonly ScheduleProposal[];
}) {
  const { detail } = props;
  const decideCapability = useHostedRpcCapability(AGENT_CONTROL_WS_METHODS.automationCommand);
  const canDecide = decideCapability.allowed && detail.automationDisabledReason === null;
  if (props.changes.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {props.changes.map((change) => (
        <div
          key={change.id}
          data-testid="map-pending-change"
          className="map-due flex flex-wrap items-center gap-2 rounded-[min(var(--radius-lg),0.625rem)] px-3 py-2 text-[12.5px]"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0 text-warning-foreground" />
          <span className="min-w-0 flex-[1_1_9rem]">
            <span className="font-medium">{PROPOSAL_HEAD[change.kind]}</span>
            {change.kind === "create" ? <> · {change.title}</> : null}
          </span>
          <span className="flex gap-1.5">
            <Button
              size="xs"
              disabled={!canDecide || detail.automationBusy}
              onClick={() => void detail.decide(change.id, "accept")}
            >
              Approve
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canDecide || detail.automationBusy}
              onClick={() => void detail.decide(change.id, "reject")}
            >
              Reject
            </Button>
          </span>
        </div>
      ))}
    </div>
  );
}

function DevicePanel(props: {
  readonly detail: MapCheckoutDetail;
  readonly onSelect: (selection: MapSelection) => void;
}) {
  const { detail } = props;
  const { nav } = useProjectsPage();
  const access = useProjectEditAccess(detail.member.environmentId);
  const createCapability = useHostedRpcCapability(WS_METHODS.gitCreateWorktreeForProject);
  const { copyPathToClipboard } = useThreadClipboardActions();
  const router = useRouter();
  const nowMs = useNowMs();
  const [newWorktree, setNewWorktree] = useState(false);
  // The editor bridge opens folders on this machine only.
  const canOpenInEditor = detail.checkout.isPrimary && readLocalApi() !== undefined;
  const status = detail.checkout.isPrimary
    ? "This device"
    : { online: "Online", connecting: "Connecting", offline: "Offline", unknown: "Unknown" }[
        detail.checkout.status
      ];
  const projectId = ProjectId.make(detail.member.id);
  return (
    <>
      <Kind
        icon={
          <DeviceIcon
            environmentId={detail.member.environmentId}
            label={detail.checkout.deviceLabel}
            className="size-3.5"
          />
        }
      >
        Device · checkout
      </Kind>
      <Title>{detail.checkout.deviceLabel}</Title>
      <Facts
        rows={[
          [
            "Folder",
            <button
              key="v1"
              type="button"
              title="Copy path"
              onClick={() =>
                copyPathToClipboard(detail.checkout.cwd, { path: detail.checkout.cwd })
              }
              className="text-left font-mono text-[11.5px] underline decoration-transparent underline-offset-2 hover:decoration-border"
            >
              {detail.checkout.cwd}
            </button>,
          ],
          ["Connection", status],
        ]}
      />
      <Actions disabledReason={access.reason}>
        <Button
          size="sm"
          variant="outline"
          disabled={!access.canEdit || !createCapability.allowed}
          onClick={() => setNewWorktree(true)}
        >
          <GitBranchIcon className="size-3.5" />
          New worktree
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={detail.automationDisabledReason !== null}
          onClick={(event) =>
            openAutomationsDialog({
              environmentId: detail.member.environmentId,
              projectId,
              mode: "new",
              origin: event.currentTarget,
            })
          }
        >
          <ClockIcon className="size-3.5" />
          New schedule
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            nav.selectCheckout({ environmentId: detail.member.environmentId, projectId });
            props.onSelect({ kind: "project" });
          }}
        >
          <Settings2Icon className="size-3.5" />
          Settings
        </Button>
        {canOpenInEditor ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const api = readLocalApi();
              if (!api) return;
              void openInPreferredEditor(api, detail.checkout.cwd).catch((error: unknown) =>
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Unable to open the project",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                ),
              );
            }}
          >
            <SquareTerminalIcon className="size-3.5" />
            Open in editor
          </Button>
        ) : null}
      </Actions>
      <PendingChanges
        detail={detail}
        changes={detail.pendingChanges.filter((change) => change.kind === "create")}
      />
      <Section title="Workspaces">
        {detail.checkout.workspaces.map((workspace) => (
          <LinkRow
            key={workspace.id}
            onClick={() =>
              props.onSelect({
                kind: "workspace",
                checkoutKey: detail.checkout.key,
                id: workspace.id,
              })
            }
            icon={
              workspace.main ? (
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )
            }
            trailing={
              workspace.archived ? (
                <span className="text-[11px] text-muted-foreground">Archived</span>
              ) : null
            }
          >
            <span className={workspace.main ? "" : "font-mono"}>
              {workspace.main ? "Main checkout" : (workspace.title ?? workspace.branch)}
            </span>
          </LinkRow>
        ))}
      </Section>
      {detail.checkout.automations.length > 0 ? (
        <Section title="Automations">
          {detail.checkout.automations.map((automation) => (
            <LinkRow
              key={automation.id}
              onClick={() =>
                props.onSelect({
                  kind: "automation",
                  checkoutKey: detail.checkout.key,
                  id: automation.id,
                })
              }
              icon={<ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />}
              trailing={
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {nextRunLabel(automation, nowMs)}
                </span>
              }
            >
              {automation.title}
            </LinkRow>
          ))}
        </Section>
      ) : null}
      <NewWorktreeDialog
        open={newWorktree}
        environmentId={detail.member.environmentId}
        projectId={detail.member.id}
        cwd={detail.member.cwd}
        initialTab="branches"
        onCreated={(result) =>
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(detail.member.environmentId, result.sessionId),
            ),
          })
        }
        onOpenChange={setNewWorktree}
      />
    </>
  );
}

function WorkspacePanel(props: {
  readonly detail: MapCheckoutDetail;
  readonly details: readonly MapCheckoutDetail[];
  readonly id: string;
  readonly review: WorkspaceReviewAction | undefined;
  readonly onSelect: (selection: MapSelection) => void;
  readonly onReview: (action: WorkspaceReviewAction | undefined) => void;
}) {
  const { detail } = props;
  const router = useRouter();
  const access = useProjectEditAccess(detail.member.environmentId);
  const applyCapability = useHostedRpcCapability(WS_METHODS.lifecycleApplyWorkspace);
  const previewCapability = useHostedRpcCapability(WS_METHODS.lifecyclePreviewWorkspace);
  const createCapability = useHostedRpcCapability(WS_METHODS.gitCreateWorktreeForProject);
  const { copyPathToClipboard } = useThreadClipboardActions();
  const { handleNewThread } = useNewThreadHandler();
  const navigateToThread = (environmentId: EnvironmentId, threadId: string) =>
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, ThreadId.make(threadId))),
    });
  const actions = useSidebarWorktreeActions({
    project: detail.scoped,
    navigateToThread: (ref) => navigateToThread(ref.environmentId, ref.threadId),
    createThreadForProjectMember: (target, seed) =>
      void handleNewThread(scopeProjectRef(target.environmentId, target.id), {
        ...(seed?.branch !== undefined ? { branch: seed.branch } : {}),
        ...(seed?.worktreePath !== undefined ? { worktreePath: seed.worktreePath } : {}),
        ...(seed ? { envMode: seed.envMode } : {}),
      }),
    copyPathToClipboard,
    openWorkspaceReview: (target) => {
      if (isWorkspaceReviewAction(target.action)) props.onReview(target.action);
    },
  });
  const workspace = detail.checkout.workspaces.find((candidate) => candidate.id === props.id);
  const node = detail.nodes.get(props.id) ?? null;
  if (!workspace)
    return <p className="text-[13px] text-muted-foreground">This workspace is gone.</p>;
  const summary = detail.summaries.get(props.id) ?? null;
  const registeredId = workspace.registeredId ?? (workspace.main ? null : workspace.id);
  const canMutate = access.canEdit && applyCapability.allowed;
  const title = workspace.main ? "Main checkout" : (workspace.title ?? workspace.branch);

  if (props.review && registeredId) {
    return (
      <>
        <Kind icon={<GitBranchIcon className="size-3.5" />}>
          {WORKSPACE_LIFECYCLE_ACTION_LABELS[props.review]}
        </Kind>
        <Title mono={!workspace.main && !workspace.title}>{title}</Title>
        <div className="mt-3 -ml-[1.625rem]">
          <WorkspaceReview
            key={`${registeredId}:${props.review}`}
            environmentId={detail.member.environmentId}
            projectId={ProjectId.make(detail.member.id)}
            worktreeId={WorktreeId.make(registeredId)}
            action={props.review}
            title={title}
            previewDenied={
              previewCapability.allowed
                ? null
                : (previewCapability.reason ?? "Your role on this device can't change workspaces.")
            }
            canApply={canMutate}
            onClose={() => props.onReview(undefined)}
            onReopen={() =>
              props.review &&
              openWorkspaceReviewDialog({
                environmentId: detail.member.environmentId,
                projectId: ProjectId.make(detail.member.id),
                worktreeId: WorktreeId.make(registeredId),
                action: props.review,
                title,
              })
            }
            onChangeAction={props.onReview}
          />
        </div>
      </>
    );
  }

  const openTarget = node ? resolveWorktreeOpenTarget(node) : null;
  const live = !workspace.archived && !workspace.checkoutRemoved;
  const twins = props.details.flatMap((other) =>
    other.checkout.key === detail.checkout.key || workspace.main
      ? []
      : other.checkout.workspaces
          .filter((candidate) => !candidate.main && candidate.branch === workspace.branch)
          .map((candidate) => ({ other, candidate })),
  );
  const lifecycle = summary ? availableWorkspaceActions(summary) : [];
  const path = node ? actions.resolveWorktreeFilesystemPath(node) : (summary?.path ?? null);
  return (
    <>
      <Kind
        icon={
          workspace.main ? (
            <FolderIcon className="size-3.5" />
          ) : (
            <GitBranchIcon className="size-3.5" />
          )
        }
      >
        {workspace.main ? "Main checkout" : workspace.archived ? "Archived worktree" : "Worktree"}
      </Kind>
      <Title mono={!workspace.main && !workspace.title}>{title}</Title>
      <p className="text-[12px] text-muted-foreground">
        {workspace.facts.length
          ? workspace.facts.map((fact) => (
              <span key={fact.label} data-tone={fact.tone} className="map-fact">
                {fact.label}
              </span>
            ))
          : detail.inspection.status === "ready"
            ? "Clean and up to date"
            : null}
      </p>
      <Facts
        rows={[
          ["Device", detail.checkout.deviceLabel],
          ...(workspace.main || workspace.title
            ? ([
                [
                  "Branch",
                  <span key="v2" className="font-mono text-[11.5px]">
                    {workspace.branch}
                  </span>,
                ],
              ] as const)
            : []),
          [
            "Path",
            <span key="v3" className="font-mono text-[11.5px]">
              {path ?? "—"}
            </span>,
          ],
          ...(twins.length
            ? ([
                [
                  "Also on",
                  <span key="v4" className="flex flex-wrap gap-x-2">
                    {twins.map(({ other, candidate }) => (
                      <button
                        key={other.checkout.key}
                        type="button"
                        className="underline decoration-border underline-offset-2 hover:decoration-foreground"
                        onClick={() =>
                          props.onSelect({
                            kind: "workspace",
                            checkoutKey: other.checkout.key,
                            id: candidate.id,
                          })
                        }
                      >
                        {other.checkout.deviceLabel}
                      </button>
                    ))}
                  </span>,
                ],
              ] as const)
            : []),
        ]}
      />
      <Section title="Threads">
        {workspace.threads.length ? (
          workspace.threads.map((thread) => (
            <LinkRow
              key={thread.id}
              onClick={() => navigateToThread(detail.member.environmentId, thread.id)}
              icon={
                thread.archived ? (
                  <span aria-hidden className="map-dot ml-0.5 shrink-0" data-glyph="archived" />
                ) : (
                  <InboxStatusGlyph kind={thread.glyph} label={thread.glyphLabel} />
                )
              }
              trailing={
                thread.activityAt ? (
                  <RelativeTime
                    value={thread.activityAt}
                    className="text-[11px] text-muted-foreground"
                  />
                ) : null
              }
            >
              {thread.title}
            </LinkRow>
          ))
        ) : (
          <p className="px-2 text-[12.5px] text-muted-foreground">No threads yet.</p>
        )}
      </Section>
      <Actions
        disabledReason={access.reason ?? (applyCapability.allowed ? null : applyCapability.reason)}
      >
        {live && node ? (
          <Button
            size="sm"
            variant="default"
            disabled={!access.canEdit || !createCapability.allowed}
            onClick={() => node && actions.createThreadInWorktree(node)}
          >
            <SquarePenIcon className="size-3.5" />
            New thread
          </Button>
        ) : null}
        {node && openTarget?.kind === "thread" ? (
          <Button size="sm" variant="outline" onClick={() => actions.openWorktree(node)}>
            <ExternalLinkIcon className="size-3.5" />
            Open latest thread
          </Button>
        ) : null}
        {lifecycle.map((action) => {
          const Icon = ACTION_ICONS[action];
          const removal =
            action === "remove-checkout" ||
            action === "remove-stale-record" ||
            action === "delete-workspace";
          return (
            <Button
              key={action}
              size="sm"
              variant={removal ? "destructive-outline" : "outline"}
              disabled={!canMutate || !registeredId}
              onClick={() =>
                registeredId &&
                void runWorkspaceLifecycleAction(
                  {
                    environmentId: detail.member.environmentId,
                    projectId: ProjectId.make(detail.member.id),
                    worktreeId: WorktreeId.make(registeredId),
                    action,
                    title,
                  },
                  (target) => {
                    if (isWorkspaceReviewAction(target.action)) props.onReview(target.action);
                  },
                )
              }
            >
              <Icon className="size-3.5" />
              {WORKSPACE_LIFECYCLE_ACTION_LABELS[action]}
              {isWorkspaceReviewAction(action) ? "…" : ""}
            </Button>
          );
        })}
      </Actions>
      {!summary && detail.inspection.status === "loading" ? (
        <p className="mt-2 text-[11.5px] text-muted-foreground">Checking the workspace…</p>
      ) : null}
    </>
  );
}

function AutomationPanel(props: {
  readonly detail: MapCheckoutDetail;
  readonly id: string;
  readonly onSelect: (selection: MapSelection) => void;
}) {
  const { detail } = props;
  const router = useRouter();
  const decideCapability = useHostedRpcCapability(AGENT_CONTROL_WS_METHODS.automationCommand);
  const nowMs = useNowMs();
  const automation = detail.checkout.automations.find((candidate) => candidate.id === props.id);
  const record = detail.automations.get(props.id);
  if (!automation || !record)
    return <p className="text-[13px] text-muted-foreground">This automation is gone.</p>;
  const runs = detail.runs
    .filter((entry) => entry.run.automationId === props.id)
    .toSorted(
      (left, right) => Date.parse(right.run.scheduledFor) - Date.parse(left.run.scheduledFor),
    )
    .slice(0, 6);
  const execution = record.definition.execution;
  const decide = (decision: "accept" | "reject") =>
    automation.pendingProposalId &&
    void detail.decide(automation.pendingProposalId as AgentControlProposalId, decision);
  const canDecide = decideCapability.allowed && detail.automationDisabledReason === null;
  const projectId = ProjectId.make(detail.member.id);
  const automationId = record.automationId;
  const changes = detail.pendingChanges.filter((change) => change.automationId === props.id);
  // Every change becomes a proposal to approve; one at a time per schedule.
  const canChange = canDecide && !detail.automationBusy && changes.length === 0;
  /** Pause or resume: the same schedule, its start rolled forward (the server refuses a past one). */
  const setEnabled = (enabled: boolean) =>
    detail.command({
      kind: "save",
      projectId,
      automationId,
      expectedRevision: record.revision,
      definition: definitionWithEnabled(record, enabled, Date.now()),
    });
  return (
    <>
      <Kind icon={<ClockIcon className="size-3.5" />}>
        Automation{automation.enabled ? "" : " · paused"}
      </Kind>
      <Title>{automation.title}</Title>
      <p className="text-[12px] text-muted-foreground">{automation.scheduleLabel}</p>
      <PendingChanges detail={detail} changes={changes} />
      {automation.pendingProposalId ? (
        <div className="map-due mt-3 flex flex-wrap items-center gap-2 rounded-[min(var(--radius-lg),0.625rem)] px-3 py-2.5 text-[12.5px]">
          <ShieldCheckIcon className="size-3.5 shrink-0 text-warning-foreground" />
          <span className="min-w-0 flex-[1_1_9rem]">
            A run is due on {detail.checkout.deviceLabel} and waits for your approval.
          </span>
          <span className="flex gap-1.5">
            <Button
              size="xs"
              disabled={!canDecide || detail.automationBusy}
              onClick={() => decide("accept")}
            >
              Approve
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canDecide || detail.automationBusy}
              onClick={() => decide("reject")}
            >
              Reject
            </Button>
          </span>
        </div>
      ) : null}
      <Facts
        rows={[
          ["Runs on", detail.checkout.deviceLabel],
          ["Next run", nextRunLabel(automation, nowMs)],
          [
            "Where",
            execution.envMode === "worktree" ? (
              <span key="where">
                A new worktree off{" "}
                <span className="font-mono text-[11.5px]">
                  {execution.baseRef ?? "the default branch"}
                </span>{" "}
                each run
              </span>
            ) : (
              "The main checkout"
            ),
          ],
          [
            "Model",
            <span key="v5" className="font-mono text-[11.5px]">
              {execution.modelSelection.model}
            </span>,
          ],
        ]}
      />
      {detail.automationError ? (
        <p className="mt-2 text-[12px] text-warning-foreground">{detail.automationError}</p>
      ) : null}
      <Section title="Recent runs">
        {runs.length ? (
          runs.map(({ run, threadIds }) => (
            <LinkRow
              key={run.runId}
              onClick={() =>
                threadIds[0]
                  ? props.onSelect({
                      kind: "thread",
                      checkoutKey: detail.checkout.key,
                      id: threadIds[0],
                    })
                  : undefined
              }
              icon={<span aria-hidden className="map-run shrink-0" data-status={run.status} />}
              trailing={
                <RelativeTime
                  value={run.scheduledFor}
                  className="text-[11px] text-muted-foreground"
                />
              }
            >
              {automationRunStatusLabel[run.status]}
              {run.safeFailureDetail ? (
                <span className="text-muted-foreground"> · {run.safeFailureDetail}</span>
              ) : null}
            </LinkRow>
          ))
        ) : (
          <p className="px-2 text-[12.5px] text-muted-foreground">No runs yet.</p>
        )}
      </Section>
      <Actions disabledReason={detail.automationDisabledReason}>
        <Button
          size="sm"
          variant="outline"
          disabled={!canChange}
          onClick={() => void setEnabled(!record.definition.enabled)}
        >
          {record.definition.enabled ? (
            <PauseIcon className="size-3.5" />
          ) : (
            <PlayIcon className="size-3.5" />
          )}
          {record.definition.enabled ? "Pause" : "Resume"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canChange}
          onClick={(event) =>
            openAutomationsDialog({
              environmentId: detail.member.environmentId,
              projectId,
              automationId,
              mode: "edit",
              origin: event.currentTarget,
            })
          }
        >
          <SquarePenIcon className="size-3.5" />
          Edit
        </Button>
        <Button
          size="sm"
          variant="destructive-outline"
          disabled={!canChange}
          onClick={() =>
            void detail.command({
              kind: "cancel",
              projectId,
              automationId,
              expectedRevision: record.revision,
            })
          }
        >
          <XIcon className="size-3.5" />
          Cancel schedule
        </Button>
        {runs[0]?.threadIds[0] ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(
                    detail.member.environmentId,
                    ThreadId.make(runs[0]!.threadIds[0]!),
                  ),
                ),
              })
            }
          >
            <ExternalLinkIcon className="size-3.5" />
            Open last run
          </Button>
        ) : null}
      </Actions>
    </>
  );
}

const THREAD_ACTION_ICONS: Record<ThreadLifecycleActionId, typeof ArchiveIcon> = {
  "interrupt-turn": OctagonPauseIcon,
  "stop-session": SquareIcon,
  archive: ArchiveIcon,
  unarchive: ArchiveRestoreIcon,
  trash: Trash2Icon,
};

function ThreadPanel(props: {
  readonly detail: MapCheckoutDetail;
  readonly id: string;
  readonly onSelect: (selection: MapSelection | null) => void;
}) {
  const { detail } = props;
  const router = useRouter();
  const access = useProjectEditAccess(detail.member.environmentId);
  const threadActions = useThreadActions();
  const workspace = detail.checkout.workspaces.find((candidate) =>
    candidate.threads.some((thread) => thread.id === props.id),
  );
  const thread = workspace?.threads.find((candidate) => candidate.id === props.id);
  if (!workspace || !thread)
    return <p className="text-[13px] text-muted-foreground">This thread is gone.</p>;
  const startedBy = detail.checkout.automations.find((automation) =>
    automation.threadIds.includes(props.id),
  );
  const record = detail.threads.get(props.id) ?? null;
  const ref = scopeThreadRef(detail.member.environmentId, ThreadId.make(thread.id));
  const lifecycle = record ? listThreadLifecycleActions(record) : [];
  const run = (label: string, action: () => Promise<void>, after?: () => void) =>
    void action().then(after, (error: unknown) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `${label} failed`,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
    );
  const perform = (id: ThreadLifecycleActionId, label: string) => {
    switch (id) {
      case "interrupt-turn":
        return run(label, () => threadActions.interruptThreadTurn(ref));
      case "stop-session":
        return run(label, () => threadActions.stopThreadSession(ref));
      case "archive":
        return run(label, () => threadActions.archiveThread(ref));
      case "unarchive":
        return run(label, () => threadActions.unarchiveThread(ref));
      case "trash":
        // A thread in Trash leaves the map; so does its card.
        return run(
          label,
          () => threadActions.confirmAndTrashThread(ref),
          () => {
            if (!detail.threads.has(props.id)) props.onSelect(null);
          },
        );
    }
  };
  return (
    <>
      <Kind
        icon={
          thread.archived ? (
            <span aria-hidden className="map-dot" data-glyph="archived" />
          ) : (
            <InboxStatusGlyph kind={thread.glyph} />
          )
        }
      >
        Thread · {thread.glyphLabel}
      </Kind>
      <div className="mt-1.5 mr-7">
        <InlineNameField
          key={thread.id}
          value={thread.title}
          label="Thread title"
          canEdit={access.canEdit && record !== null}
          compact
          emptyMessage="Thread title cannot be empty"
          failureTitle="Failed to rename thread"
          onSave={(title) => renameThread(ref, title)}
        />
      </div>
      <Facts
        rows={[
          [
            "Workspace",
            <button
              key="v6"
              type="button"
              className={cn(
                "underline decoration-border underline-offset-2 hover:decoration-foreground",
                !workspace.main && !workspace.title && "font-mono text-[11.5px]",
              )}
              onClick={() =>
                props.onSelect({
                  kind: "workspace",
                  checkoutKey: detail.checkout.key,
                  id: workspace.id,
                })
              }
            >
              {workspace.main ? "Main checkout" : (workspace.title ?? workspace.branch)}
            </button>,
          ],
          ["Device", detail.checkout.deviceLabel],
          ...(thread.activityAt
            ? ([
                ["Activity", <RelativeTime key="activity" value={thread.activityAt} withSuffix />],
              ] as const)
            : []),
          ...(startedBy
            ? ([
                [
                  "Started by",
                  <button
                    key="v7"
                    type="button"
                    className="underline decoration-border underline-offset-2 hover:decoration-foreground"
                    onClick={() =>
                      props.onSelect({
                        kind: "automation",
                        checkoutKey: detail.checkout.key,
                        id: startedBy.id,
                      })
                    }
                  >
                    {startedBy.title}
                  </button>,
                ],
              ] as const)
            : []),
        ]}
      />
      <Actions disabledReason={access.reason}>
        <Button
          size="sm"
          onClick={() =>
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(ref),
            })
          }
        >
          <ExternalLinkIcon className="size-3.5" />
          Open thread
        </Button>
        {lifecycle.map((item) => {
          const Icon = THREAD_ACTION_ICONS[item.id];
          return (
            <Button
              key={item.id}
              size="sm"
              variant={item.destructive ? "destructive-outline" : "outline"}
              disabled={!access.canEdit}
              onClick={() => perform(item.id, item.label)}
            >
              <Icon className="size-3.5" />
              {item.label}
            </Button>
          );
        })}
      </Actions>
    </>
  );
}

/* ---------------------------------------------------------------- panel */

export const MAP_INSPECTOR_WIDTH = 336;
/** The project's card holds its settings, so it opens wider. */
export const MAP_PROJECT_INSPECTOR_WIDTH = 408;

export const mapInspectorWidth = (selection: MapSelection | null): number =>
  selection?.kind === "project" ? MAP_PROJECT_INSPECTOR_WIDTH : MAP_INSPECTOR_WIDTH;

/**
 * The map's inspector: slides in from the right edge for the selected node.
 * Content re-keys per selection so a new subject settles in.
 */
export function ProjectMapInspector(props: {
  readonly selection: MapSelection | null;
  readonly snapshot: SidebarProjectSnapshot;
  readonly details: readonly MapCheckoutDetail[];
  readonly onSelect: (selection: MapSelection | null) => void;
  readonly onReview: (action: WorkspaceReviewAction | undefined) => void;
  readonly onOpenSettings: (input?: {
    readonly checkoutKey?: string;
    readonly section?: "automations";
  }) => void;
}) {
  const { details } = props;
  /* Closing keeps the last subject on screen while the panel slides away. */
  const [shown, setShown] = useState(props.selection);
  if (props.selection && props.selection !== shown) setShown(props.selection);
  const selection = props.selection ?? shown;
  const open = props.selection !== null;
  const detail =
    selection && "checkoutKey" in selection ? findDetail(details, selection.checkoutKey) : null;
  let content: ReactNode = null;
  let contentKey = "none";
  if (selection?.kind === "project") {
    contentKey = "project";
    content = (
      <ProjectPanel
        snapshot={props.snapshot}
        details={details}
        onSelect={props.onSelect}
        onOpenSettings={() => props.onOpenSettings()}
      />
    );
  } else if (selection && detail) {
    contentKey = `${selection.kind}|${selection.checkoutKey}|${"id" in selection ? selection.id : ""}`;
    if (selection.kind === "device")
      content = <DevicePanel detail={detail} onSelect={props.onSelect} />;
    else if (selection.kind === "workspace")
      content = (
        <WorkspacePanel
          detail={detail}
          details={details}
          id={selection.id}
          review={selection.review}
          onSelect={props.onSelect}
          onReview={props.onReview}
        />
      );
    else if (selection.kind === "automation")
      content = <AutomationPanel detail={detail} id={selection.id} onSelect={props.onSelect} />;
    else content = <ThreadPanel detail={detail} id={selection.id} onSelect={props.onSelect} />;
  }
  return (
    <aside
      data-map-ui
      data-open={open && content ? "" : undefined}
      aria-label="Details"
      aria-hidden={open && content ? undefined : true}
      inert={!open || !content}
      className="map-inspector absolute top-[3.25rem] right-3 bottom-3 z-20 flex max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-[min(var(--radius-xl),0.875rem)] border border-border bg-popover text-popover-foreground shadow-lg"
      style={{ width: mapInspectorWidth(selection) }}
    >
      <button
        type="button"
        aria-label="Close details"
        onClick={() => props.onSelect(null)}
        className="absolute top-2.5 right-2.5 z-10 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-3.5" />
      </button>
      <div
        key={contentKey}
        className="map-inspector-body @container/detail min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-5"
      >
        {content}
      </div>
    </aside>
  );
}
