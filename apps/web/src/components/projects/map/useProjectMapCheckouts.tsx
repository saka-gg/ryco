import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import {
  deriveScheduleRows,
  pendingScheduleProposals,
  type ScheduleProposal,
} from "@ryco/client-runtime/state/agentControl";
import {
  ProjectId,
  WS_METHODS,
  type AgentControlAutomation,
  type AgentControlProposalId,
  type AutomationCentreSnapshot,
  type AutomationCentreRun,
  type WorkspaceLifecycleSummary,
} from "@ryco/contracts";
import { dayStart } from "@ryco/shared/automationSchedule";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "../../../env";
import { useEvent } from "../../../hooks/useEvent";
import { retainDesktopWorkspaceInteractiveScope } from "../../../platform/desktopWorkspace";
import { useHostedRpcCapability } from "../../../hostedHub/capabilities";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import {
  selectSidebarThreadsForProjectRef,
  selectSidebarWorktreesForProjectRef,
  useStore,
} from "../../../store";
import { useMinuteNow } from "../../automations/dialog/clock";
import {
  useAutomationCentre,
  type AutomationCommandDraft,
} from "../../automations/useAutomationCentre";
import {
  useSidebarTree,
  type SidebarTreeThread,
  type SidebarTreeWorktree,
} from "../../sidebar/hooks/useSidebarTree";
import { adaptProjectForSidebarTree } from "../../sidebar/sidebarTreeAdapters";
import { projectCheckoutKey } from "../../../projectCheckouts.logic";
import {
  unlistedWorkspaces,
  workspaceInspectionSignature,
} from "../sections/projectWorkspaces.logic";
import {
  useProjectWorkspaceInspection,
  type WorkspaceInspection,
} from "../sections/useProjectWorkspaceInspection";
import { useEnvironmentPresence } from "../useEnvironmentPresence";
import type { MapCheckout, MapPresenceStatus } from "./projectMap.logic";
import { summaryOnlyWorkspace, toMapAutomation, toMapWorkspace } from "./projectMapModel";

/** The logical project narrowed to one checkout, so the sidebar's tree builds just its worktrees. */
export function scopeSnapshotToMember(
  snapshot: SidebarProjectSnapshot,
  member: SidebarProjectGroupMember,
): SidebarProjectSnapshot {
  return {
    ...snapshot,
    ...member,
    projectKey: snapshot.projectKey,
    displayName: snapshot.displayName,
    groupedProjectCount: 1,
    memberProjects: [member],
    memberProjectRefs: [scopeProjectRef(member.environmentId, member.id)],
  };
}

/** Everything the map and its inspector know about one checkout. */
export interface MapCheckoutDetail {
  readonly member: SidebarProjectGroupMember;
  readonly scoped: SidebarProjectSnapshot;
  readonly checkout: MapCheckout;
  readonly nodes: ReadonlyMap<string, SidebarTreeWorktree>;
  readonly summaries: ReadonlyMap<string, WorkspaceLifecycleSummary>;
  readonly threads: ReadonlyMap<string, SidebarTreeThread>;
  readonly automations: ReadonlyMap<string, AgentControlAutomation>;
  readonly runs: readonly AutomationCentreRun[];
  /** The checkout's automation centre read (null until it lands): the dialog's counts. */
  readonly automationSnapshot: AutomationCentreSnapshot | null;
  readonly inspection: WorkspaceInspection;
  readonly automationError: string | null;
  readonly automationBusy: boolean;
  readonly automationDisabledReason: string | null;
  readonly decide: (
    proposalId: AgentControlProposalId,
    decision: "accept" | "reject",
  ) => Promise<void>;
  /** Save, cancel or retry a schedule; each becomes a change to approve. */
  readonly command: (input: AutomationCommandDraft) => Promise<boolean>;
  /** Schedule changes proposed and waiting for a decision (the shared model's reading). */
  readonly pendingChanges: readonly ScheduleProposal[];
  readonly reinspect: () => void;
}

const presenceStatus = (status: string): MapPresenceStatus =>
  status === "online" || status === "connecting" || status === "offline"
    ? status
    : status === "cached"
      ? "offline"
      : "unknown";

/** Reads one checkout and reports it up; renders nothing. */
function CheckoutSource(props: {
  readonly snapshot: SidebarProjectSnapshot;
  readonly member: SidebarProjectGroupMember;
  readonly onChange: (key: string, detail: MapCheckoutDetail | null) => void;
}) {
  const { snapshot, member, onChange } = props;
  const key = projectCheckoutKey(member.environmentId, member.id);
  const presence = useEnvironmentPresence(member.environmentId);
  // A checkout on another desktop Hub machine connects on demand: hold it
  // while the map shows it, as the settings view does for the scoped device.
  const isPrimary = presence.isPrimary;
  useEffect(() => {
    if (!isElectron || isPrimary) return;
    return retainDesktopWorkspaceInteractiveScope(member.environmentId);
  }, [isPrimary, member.environmentId]);
  const scoped = useMemo(() => scopeSnapshotToMember(snapshot, member), [member, snapshot]);
  const ref = scoped.memberProjectRefs[0]!;
  const threads = useStore(useShallow((state) => selectSidebarThreadsForProjectRef(state, ref)));
  const worktrees = useStore(
    useShallow((state) => selectSidebarWorktreesForProjectRef(state, ref)),
  );
  const adapted = useMemo(
    () => adaptProjectForSidebarTree({ project: scoped, threads, worktrees }),
    [scoped, threads, worktrees],
  );
  const tree = useSidebarTree({
    projects: [adapted.project],
    threads: adapted.threads,
    worktrees: adapted.worktrees,
  });
  const treeProject = tree.projects[0] ?? null;

  const listCapability = useHostedRpcCapability(WS_METHODS.lifecycleListWorkspaces);
  const signature = useMemo(() => workspaceInspectionSignature(worktrees), [worktrees]);
  const { inspection, reinspect } = useProjectWorkspaceInspection({
    environmentId: member.environmentId,
    projectId: member.id,
    signature,
    enabled: listCapability.allowed,
    suggestionsEnabled: false,
  });
  const centre = useAutomationCentre(member.environmentId, ProjectId.make(member.id));
  // Schedule words ("today 16:00") change with the day, not the minute.
  const dayMs = dayStart(useMinuteNow());
  const decide = useEvent(centre.decide);
  const command = useEvent(centre.command);

  const detail = useMemo<MapCheckoutDetail>(() => {
    const summaries = inspection.status === "ready" ? inspection.summaries : [];
    const nodes = new Map<string, SidebarTreeWorktree>();
    const summaryById = new Map<string, WorkspaceLifecycleSummary>();
    const threadById = new Map<string, SidebarTreeThread>();
    const workspaces = [
      ...(treeProject?.worktrees ?? []).map((node) => ({ node, archived: false })),
      ...(treeProject?.archivedWorktrees ?? []).map((node) => ({ node, archived: true })),
    ].map(({ node, archived }) => {
      const { workspace, summary } = toMapWorkspace(node, summaries, archived);
      nodes.set(workspace.id, node);
      if (summary) summaryById.set(workspace.id, summary);
      for (const thread of [...node.sessions, ...node.archivedSessions])
        threadById.set(thread.id, thread);
      return workspace;
    });
    /* Registered workspaces the sidebar's tree does not show are still the
       project's: list them so they can be inspected and managed. */
    const listed = new Set<string>();
    for (const workspace of workspaces) {
      listed.add(workspace.id);
      if (workspace.registeredId) listed.add(workspace.registeredId);
    }
    for (const summary of unlistedWorkspaces(summaries, listed)) {
      const workspace = summaryOnlyWorkspace(summary);
      summaryById.set(workspace.id, summary);
      workspaces.push(workspace);
    }
    const snapshotAutomations = centre.snapshot?.automations ?? [];
    const runs = centre.snapshot?.runs ?? [];
    // The dialog's rows, so a schedule's state reads the same on both surfaces.
    const scheduleRows = new Map(
      (centre.snapshot
        ? deriveScheduleRows({
            projectId: ProjectId.make(member.id),
            snapshot: centre.snapshot,
            nowMs: dayMs,
          })
        : []
      ).map((row) => [row.id, row]),
    );
    return {
      member,
      scoped,
      checkout: {
        key,
        environmentId: member.environmentId,
        projectId: member.id,
        cwd: member.cwd,
        deviceLabel: presence.label,
        isPrimary: presence.isPrimary,
        status: presenceStatus(presence.status),
        workspaces,
        automations: snapshotAutomations.flatMap((automation) => {
          const row = scheduleRows.get(automation.automationId);
          const mapped = row ? toMapAutomation(row, dayMs) : null;
          return mapped ? [mapped] : [];
        }),
      },
      nodes,
      summaries: summaryById,
      threads: threadById,
      automations: new Map(
        snapshotAutomations.map((automation) => [automation.automationId, automation]),
      ),
      runs,
      automationSnapshot: centre.snapshot,
      inspection,
      automationError: centre.error,
      automationBusy: centre.busy,
      automationDisabledReason: centre.disabledReason,
      decide,
      command,
      pendingChanges: pendingScheduleProposals(centre.snapshot?.proposals ?? [], {
        projectId: ProjectId.make(member.id),
      }),
      reinspect,
    };
  }, [
    centre.busy,
    centre.disabledReason,
    centre.error,
    centre.snapshot,
    command,
    dayMs,
    decide,
    inspection,
    key,
    member,
    presence.isPrimary,
    presence.label,
    presence.status,
    reinspect,
    scoped,
    treeProject,
  ]);

  useEffect(() => onChange(key, detail), [detail, key, onChange]);
  useEffect(() => () => onChange(key, null), [key, onChange]);
  return null;
}

/**
 * Every checkout of a logical project, read side by side: the device this
 * app runs on first, then the others in the project's own order. Render
 * `sources` somewhere in the tree; `details` follows them.
 */
export function useProjectMapCheckouts(snapshot: SidebarProjectSnapshot): {
  readonly details: readonly MapCheckoutDetail[];
  readonly sources: ReactNode;
} {
  const [byKey, setByKey] = useState<ReadonlyMap<string, MapCheckoutDetail>>(new Map());
  const onChange = useCallback((key: string, detail: MapCheckoutDetail | null) => {
    setByKey((current) => {
      if (current.get(key) === detail || (!detail && !current.has(key))) return current;
      const next = new Map(current);
      if (detail) next.set(key, detail);
      else next.delete(key);
      return next;
    });
  }, []);
  const details = useMemo(() => {
    const ordered = snapshot.memberProjects
      .map((member) => byKey.get(projectCheckoutKey(member.environmentId, member.id)))
      .filter((detail): detail is MapCheckoutDetail => detail !== undefined);
    return ordered.toSorted(
      (left, right) => Number(right.checkout.isPrimary) - Number(left.checkout.isPrimary),
    );
  }, [byKey, snapshot.memberProjects]);
  const sources = snapshot.memberProjects.map((member) => (
    <CheckoutSource
      key={projectCheckoutKey(member.environmentId, member.id)}
      snapshot={snapshot}
      member={member}
      onChange={onChange}
    />
  ));
  return { details, sources };
}
