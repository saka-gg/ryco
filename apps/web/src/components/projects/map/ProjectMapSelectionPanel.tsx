import { definitionWithEnabled } from "@ryco/client-runtime/state/agentControl";
import {
  isWorkspaceReviewAction,
  listThreadLifecycleActions,
  type ThreadLifecycleActionId,
} from "@ryco/client-runtime/state/lifecycle";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  ProjectId,
  ThreadId,
  WorktreeId,
  type AgentControlAutomation,
  type AgentControlProposalId,
  type ScopedThreadRef,
  type WorkspaceLifecycleSummary,
} from "@ryco/contracts";
import type { ScheduleProposal } from "@ryco/client-runtime/state/agentControl";
import {
  ClockIcon,
  FolderIcon,
  GitBranchIcon,
  ListChecksIcon,
  PauseIcon,
  PlayIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useThreadActions } from "../../../hooks/useThreadActions";
import { hostedCapabilityCopy } from "../../../hostedHub/switchTarget";
import { formatCount } from "../../../lib/formatCount";
import { cn, isMacPlatform } from "../../../lib/utils";
import {
  runWorkspaceLifecycleBatch,
  type WorkspaceDirectAction,
  type WorkspaceLifecycleTarget,
} from "../../../workspaceLifecycle";
import type { AutomationCommandDraft } from "../../automations/useAutomationCentre";
import { InboxStatusGlyph } from "../../inboxSidebar/InboxStatusGlyph";
import type { SidebarTreeThread } from "../../sidebar/hooks/useSidebarTree";
import { Button } from "../../ui/button";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { availableWorkspaceActions } from "../sections/projectWorkspaces.logic";
import type { MapAutomation, MapThread, MapWorkspace } from "./projectMap.logic";
import {
  itemKey,
  selectionFromItems,
  type MapItemRef,
  type MapSelection,
} from "./projectMapSelection.logic";
import {
  ACTION_ICONS,
  Actions,
  findDetail,
  Kind,
  LINK_ROW_CLASS,
  Section,
  THREAD_ACTION_ICONS,
  Title,
} from "./ProjectMapInspectorParts";
import type { MapCheckoutDetail } from "./useProjectMapCheckouts";

type WorkspaceBatchTarget = WorkspaceLifecycleTarget & { readonly action: WorkspaceDirectAction };

interface WorkspaceEntry {
  readonly ref: MapItemRef;
  readonly detail: MapCheckoutDetail;
  readonly workspace: MapWorkspace;
  readonly summary: WorkspaceLifecycleSummary | null;
  readonly title: string;
}

interface AutomationEntry {
  readonly ref: MapItemRef;
  readonly detail: MapCheckoutDetail;
  readonly automation: MapAutomation;
  readonly record: AgentControlAutomation;
  readonly changes: readonly ScheduleProposal[];
}

interface ThreadEntry {
  readonly ref: MapItemRef;
  readonly detail: MapCheckoutDetail;
  readonly thread: MapThread;
  readonly record: SidebarTreeThread | null;
  readonly target: ScopedThreadRef;
}

/** The selected cards that are still on the map, with what each needs to act. */
function resolveItems(items: readonly MapItemRef[], details: readonly MapCheckoutDetail[]) {
  const workspaces: WorkspaceEntry[] = [];
  const automations: AutomationEntry[] = [];
  const threads: ThreadEntry[] = [];
  for (const ref of items) {
    const detail = findDetail(details, ref.checkoutKey);
    if (!detail) continue;
    if (ref.kind === "workspace") {
      const workspace = detail.checkout.workspaces.find((candidate) => candidate.id === ref.id);
      if (!workspace) continue;
      workspaces.push({
        ref,
        detail,
        workspace,
        summary: detail.summaries.get(ref.id) ?? null,
        title: workspace.main ? "Main checkout" : (workspace.title ?? workspace.branch),
      });
    } else if (ref.kind === "automation") {
      const automation = detail.checkout.automations.find((candidate) => candidate.id === ref.id);
      const record = detail.automations.get(ref.id);
      if (!automation || !record) continue;
      automations.push({
        ref,
        detail,
        automation,
        record,
        changes: detail.pendingChanges.filter((change) => change.automationId === ref.id),
      });
    } else {
      const thread = detail.checkout.workspaces
        .flatMap((workspace) => workspace.threads)
        .find((candidate) => candidate.id === ref.id);
      if (!thread) continue;
      threads.push({
        ref,
        detail,
        thread,
        record: detail.threads.get(ref.id) ?? null,
        target: scopeThreadRef(detail.member.environmentId, ThreadId.make(ref.id)),
      });
    }
  }
  return { workspaces, automations, threads };
}

/** Why some of the selection is out of reach, said once per section. */
const firstReason = (reasons: ReadonlyArray<string | null | undefined>) =>
  reasons.find((reason): reason is string => Boolean(reason)) ?? null;

/** Why the checkout's device refuses workspace changes, when it does. */
const applyRefusal = (detail: MapCheckoutDetail) =>
  detail.capabilities.applyWorkspace.allowed
    ? null
    : hostedCapabilityCopy(detail.capabilities.applyWorkspace, detail.checkout.deviceLabel);

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "An error occurred.";

function reportFailures(title: string, failures: readonly string[]) {
  if (failures.length === 0) return;
  toastManager.add(stackedThreadToast({ type: "error", title, description: failures.join("\n") }));
}

const WORKSPACE_BULK: ReadonlyArray<{
  readonly action: WorkspaceDirectAction;
  readonly label: (count: number) => string;
}> = [
  { action: "archive", label: (count) => `Archive ${formatCount(count, "workspace")}` },
  { action: "restore", label: (count) => `Restore ${formatCount(count, "workspace")}` },
];

const THREAD_BULK: ReadonlyArray<{
  readonly id: ThreadLifecycleActionId;
  readonly label: (count: number) => string;
  readonly destructive?: boolean;
}> = [
  { id: "interrupt-turn", label: (count) => `Interrupt ${formatCount(count, "turn")}` },
  { id: "stop-session", label: (count) => `Stop ${formatCount(count, "session")}` },
  { id: "archive", label: (count) => `Archive ${formatCount(count, "thread")}` },
  { id: "unarchive", label: (count) => `Unarchive ${formatCount(count, "thread")}` },
  {
    id: "delete",
    label: (count) => `Delete ${formatCount(count, "thread")}…`,
    destructive: true,
  },
];

/** A selected card: opens it on its own, or leaves the selection. */
function SelectedRow(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
  readonly onOpen: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center">
      <button type="button" onClick={props.onOpen} className={cn(LINK_ROW_CLASS, "flex-1")}>
        {props.icon}
        <span className="min-w-0 flex-1 truncate">{props.children}</span>
        {props.trailing}
      </button>
      <button
        type="button"
        aria-label={`Deselect ${props.label}`}
        onClick={props.onRemove}
        className="ml-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

/**
 * Several cards at once, as a file browser selection: what is selected,
 * grouped by kind, and each action for the cards it applies to ("Archive 3
 * threads" when 3 of 5 selected threads can be archived). Checkout changes
 * that need a review stay one workspace at a time.
 */
export function ProjectMapSelectionPanel(props: {
  readonly items: readonly MapItemRef[];
  readonly details: readonly MapCheckoutDetail[];
  readonly onSelect: (selection: MapSelection | null) => void;
}) {
  const threadActions = useThreadActions();
  const [running, setRunning] = useState(false);
  const { workspaces, automations, threads } = resolveItems(props.items, props.details);
  const total = workspaces.length + automations.length + threads.length;

  const run = (work: () => Promise<void>) => {
    setRunning(true);
    void work().finally(() => setRunning(false));
  };
  const open = (ref: MapItemRef) => props.onSelect(selectionFromItems([ref]));
  const remove = (ref: MapItemRef) =>
    props.onSelect(
      selectionFromItems(props.items.filter((item) => itemKey(item) !== itemKey(ref))),
    );

  /* Workspaces: hiding and restoring run directly; checkout changes are reviewed singly. */
  const workspaceGroups = WORKSPACE_BULK.flatMap((spec) => {
    const offered = workspaces.filter((entry) =>
      availableWorkspaceActions(entry.summary).includes(spec.action),
    );
    if (offered.length === 0) return [];
    const targets = offered.flatMap((entry): WorkspaceBatchTarget[] => {
      const registeredId =
        entry.workspace.registeredId ?? (entry.workspace.main ? null : entry.workspace.id);
      if (
        !registeredId ||
        !entry.detail.access.canEdit ||
        !entry.detail.capabilities.applyWorkspace.allowed
      )
        return [];
      return [
        {
          environmentId: entry.detail.member.environmentId,
          projectId: ProjectId.make(entry.detail.member.id),
          worktreeId: WorktreeId.make(registeredId),
          action: spec.action,
          title: entry.title,
        },
      ];
    });
    return [{ spec, offered, targets }];
  });
  const reviewedSingly = workspaces.some((entry) =>
    availableWorkspaceActions(entry.summary).some(isWorkspaceReviewAction),
  );

  /* Threads: each action for the threads that offer it. */
  const threadGroups = THREAD_BULK.flatMap((spec) => {
    const offered = threads.filter(
      (entry) =>
        entry.record !== null &&
        listThreadLifecycleActions(entry.record).some((item) => item.id === spec.id),
    );
    if (offered.length === 0) return [];
    return [{ spec, offered, runnable: offered.filter((entry) => entry.detail.access.canEdit) }];
  });
  const performThreads = (id: ThreadLifecycleActionId, entries: readonly ThreadEntry[]) =>
    run(async () => {
      const targets = entries.map((entry) => entry.target);
      if (id === "delete") {
        await threadActions.confirmAndDeleteThreads(targets);
        return;
      }
      const failures: string[] = [];
      for (const entry of entries) {
        try {
          if (id === "interrupt-turn") await threadActions.interruptThreadTurn(entry.target);
          else if (id === "stop-session") await threadActions.stopThreadSession(entry.target);
          else if (id === "archive") await threadActions.archiveThread(entry.target);
          else await threadActions.unarchiveThread(entry.target);
        } catch (error) {
          failures.push(`${entry.thread.title}: ${errorMessage(error)}`);
        }
      }
      reportFailures(
        `${id === "archive" ? "Archiving" : "Unarchiving"} ${formatCount(failures.length, "thread")} failed`,
        failures,
      );
    });

  /* Automations: every change is a proposal, one at a time per schedule. */
  const canDecide = (entry: AutomationEntry) =>
    entry.detail.capabilities.decideAutomation.allowed &&
    entry.detail.automationDisabledReason === null;
  const canChange = (entry: AutomationEntry) =>
    canDecide(entry) && entry.changes.length === 0 && !entry.record.cancelled;
  const due = automations.filter((entry) => entry.automation.pendingProposalId && canDecide(entry));
  const proposed = automations.filter((entry) => entry.changes.length > 0 && canDecide(entry));
  const pausable = automations.filter(
    (entry) => entry.record.definition.enabled && canChange(entry),
  );
  const resumable = automations.filter(
    (entry) => !entry.record.definition.enabled && canChange(entry),
  );
  const cancellable = automations.filter(canChange);
  const decideAll = (decisions: ReadonlyArray<readonly [MapCheckoutDetail, string]>) =>
    run(async () => {
      for (const [detail, proposalId] of decisions)
        await detail.decide(proposalId as AgentControlProposalId, "accept");
    });
  const commandAll = (
    entries: readonly AutomationEntry[],
    draft: (entry: AutomationEntry) => AutomationCommandDraft,
    what: string,
  ) =>
    run(async () => {
      const failures: string[] = [];
      for (const entry of entries)
        if (!(await entry.detail.command(draft(entry)))) failures.push(entry.automation.title);
      reportFailures(`Could not ${what} ${formatCount(failures.length, "schedule")}`, failures);
    });

  const counts = [
    workspaces.length ? formatCount(workspaces.length, "workspace") : null,
    threads.length ? formatCount(threads.length, "thread") : null,
    automations.length ? formatCount(automations.length, "automation") : null,
  ].filter(Boolean);
  const mod = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";

  return (
    <>
      <Kind icon={<ListChecksIcon className="size-3.5" />}>Selection</Kind>
      <Title>{formatCount(total, "item")} selected</Title>
      <p className="text-[12px] text-muted-foreground">{counts.join(" · ")}</p>

      {workspaces.length > 0 ? (
        <>
          <Section title="Workspaces">
            {workspaces.map((entry) => (
              <SelectedRow
                key={itemKey(entry.ref)}
                label={entry.title}
                onOpen={() => open(entry.ref)}
                onRemove={() => remove(entry.ref)}
                icon={
                  entry.workspace.main ? (
                    <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )
                }
                trailing={
                  entry.workspace.archived ? (
                    <span className="text-[11px] text-muted-foreground">Archived</span>
                  ) : null
                }
              >
                <span className={entry.workspace.main || entry.workspace.title ? "" : "font-mono"}>
                  {entry.title}
                </span>
              </SelectedRow>
            ))}
          </Section>
          {workspaceGroups.length > 0 ? (
            <Actions
              disabledReason={firstReason([
                ...workspaces.map((entry) => entry.detail.access.reason),
                ...workspaces.map((entry) => applyRefusal(entry.detail)),
              ])}
            >
              {workspaceGroups.map(({ spec, offered, targets }) => {
                const Icon = ACTION_ICONS[spec.action];
                return (
                  <Button
                    key={spec.action}
                    size="sm"
                    variant="outline"
                    disabled={running || targets.length === 0}
                    onClick={() => run(() => runWorkspaceLifecycleBatch(targets))}
                  >
                    <Icon className="size-3.5" />
                    {spec.label(targets.length || offered.length)}
                  </Button>
                );
              })}
            </Actions>
          ) : null}
          {reviewedSingly ? (
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              Deleting a workspace is reviewed one workspace at a time.
            </p>
          ) : null}
        </>
      ) : null}

      {threads.length > 0 ? (
        <>
          <Section title="Threads">
            {threads.map((entry) => (
              <SelectedRow
                key={itemKey(entry.ref)}
                label={entry.thread.title}
                onOpen={() => open(entry.ref)}
                onRemove={() => remove(entry.ref)}
                icon={
                  entry.thread.archived ? (
                    <span aria-hidden className="map-dot ml-0.5 shrink-0" data-glyph="archived" />
                  ) : (
                    <InboxStatusGlyph kind={entry.thread.glyph} label={entry.thread.glyphLabel} />
                  )
                }
              >
                {entry.thread.title}
              </SelectedRow>
            ))}
          </Section>
          {threadGroups.length > 0 ? (
            <Actions
              disabledReason={firstReason(threads.map((entry) => entry.detail.access.reason))}
            >
              {threadGroups.map(({ spec, offered, runnable }) => {
                const Icon = THREAD_ACTION_ICONS[spec.id];
                return (
                  <Button
                    key={spec.id}
                    size="sm"
                    variant={spec.destructive ? "destructive-outline" : "outline"}
                    disabled={running || runnable.length === 0}
                    onClick={() => performThreads(spec.id, runnable)}
                  >
                    <Icon className="size-3.5" />
                    {spec.label(runnable.length || offered.length)}
                  </Button>
                );
              })}
            </Actions>
          ) : null}
        </>
      ) : null}

      {automations.length > 0 ? (
        <>
          <Section title="Automations">
            {automations.map((entry) => (
              <SelectedRow
                key={itemKey(entry.ref)}
                label={entry.automation.title}
                onOpen={() => open(entry.ref)}
                onRemove={() => remove(entry.ref)}
                icon={<ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />}
                trailing={
                  entry.automation.pendingProposalId || entry.changes.length ? (
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span aria-hidden className="size-1.5 rounded-full bg-warning" />
                      Waiting
                    </span>
                  ) : entry.automation.enabled ? null : (
                    <span className="text-[11px] text-muted-foreground">Paused</span>
                  )
                }
              >
                {entry.automation.title}
              </SelectedRow>
            ))}
          </Section>
          <Actions
            disabledReason={firstReason(
              automations.map((entry) => entry.detail.automationDisabledReason),
            )}
          >
            {due.length > 0 ? (
              <Button
                size="sm"
                disabled={running}
                onClick={() =>
                  decideAll(
                    due.map(
                      (entry) => [entry.detail, entry.automation.pendingProposalId!] as const,
                    ),
                  )
                }
              >
                <ShieldCheckIcon className="size-3.5" />
                Approve {formatCount(due.length, "due run")}
              </Button>
            ) : null}
            {proposed.length > 0 ? (
              <Button
                size="sm"
                disabled={running}
                onClick={() =>
                  decideAll(
                    proposed.flatMap((entry) =>
                      entry.changes.map((change) => [entry.detail, change.id] as const),
                    ),
                  )
                }
              >
                <ShieldCheckIcon className="size-3.5" />
                Approve{" "}
                {formatCount(
                  proposed.reduce((sum, entry) => sum + entry.changes.length, 0),
                  "change",
                )}
              </Button>
            ) : null}
            {pausable.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={running}
                onClick={() =>
                  commandAll(
                    pausable,
                    (entry) => ({
                      kind: "save",
                      projectId: ProjectId.make(entry.detail.member.id),
                      automationId: entry.record.automationId,
                      expectedRevision: entry.record.revision,
                      definition: definitionWithEnabled(entry.record, false, Date.now()),
                    }),
                    "pause",
                  )
                }
              >
                <PauseIcon className="size-3.5" />
                Pause {formatCount(pausable.length, "schedule")}
              </Button>
            ) : null}
            {resumable.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={running}
                onClick={() =>
                  commandAll(
                    resumable,
                    (entry) => ({
                      kind: "save",
                      projectId: ProjectId.make(entry.detail.member.id),
                      automationId: entry.record.automationId,
                      expectedRevision: entry.record.revision,
                      definition: definitionWithEnabled(entry.record, true, Date.now()),
                    }),
                    "resume",
                  )
                }
              >
                <PlayIcon className="size-3.5" />
                Resume {formatCount(resumable.length, "schedule")}
              </Button>
            ) : null}
            {cancellable.length > 0 ? (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={running}
                onClick={() =>
                  commandAll(
                    cancellable,
                    (entry) => ({
                      kind: "cancel",
                      projectId: ProjectId.make(entry.detail.member.id),
                      automationId: entry.record.automationId,
                      expectedRevision: entry.record.revision,
                    }),
                    "cancel",
                  )
                }
              >
                <XIcon className="size-3.5" />
                Cancel {formatCount(cancellable.length, "schedule")}
              </Button>
            ) : null}
          </Actions>
        </>
      ) : null}

      <Button size="sm" variant="ghost" className="mt-5 -ml-2" onClick={() => props.onSelect(null)}>
        <XIcon className="size-3.5" />
        Clear selection
      </Button>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {mod}-click adds or removes a card, shift-click selects a run, and shift-drag on the canvas
        selects what the box touches. {mod}-A selects every card.
      </p>
    </>
  );
}
