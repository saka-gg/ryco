import type { EnvironmentId, ThreadGoal } from "@ryco/contracts";
import type { AppSymbolName } from "../../components/AppSymbol";
import type { AgentControlProposalView } from "@ryco/contracts/agent-control";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { BottomSheet } from "../../components/BottomSheet";
import { ChangeRequestBadge } from "../../components/ChangeRequestBadge";
import { CheckSummaryBadge } from "../../components/CheckSummaryBadge";
import { DeviceIcon } from "../../components/DeviceIcon";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { secondClock } from "../../lib/secondClock";
import { useThemeColor } from "../../lib/useThemeColor";
import { AgentControlProposalCard } from "./AgentControlProposalCard";
import { formatElapsed } from "./floatingThreadControlModel";
import type { CheckSummary } from "./prCheckSummary";
import { PullRequestWatchChip, PullRequestWatchSection } from "./PullRequestWatchViews";
import {
  threadStatusTone,
  type ThreadParentLink,
  type ThreadStatusTone,
} from "./threadContextSheetModel";
import type { ThreadAgentRow, ThreadAgentsEntry, ThreadAgentTone } from "./threadAgentsSheetModel";
import { ThreadGoalSection, type ThreadGoalActions } from "./ThreadGoalSection";
import type { ThreadHeaderModel } from "./threadHeaderModel";
import type { PullRequestWatchControl } from "./usePullRequestWatchControl";

const STATUS_TEXT: Readonly<Record<ThreadStatusTone, string>> = {
  working: "text-accent-strong",
  attention: "text-warning",
  ready: "text-foreground",
  muted: "text-foreground-muted",
};

const AGENT_DOT: Readonly<Record<ThreadAgentTone, string>> = {
  working: "bg-accent",
  attention: "bg-warning",
  done: "bg-success",
  failed: "bg-danger-foreground",
  muted: "bg-foreground-tertiary",
};

const RESULT_TEXT: Readonly<Record<NonNullable<ThreadParentLink["resultTone"]>, string>> = {
  muted: "text-foreground-tertiary",
  pending: "text-foreground-tertiary",
  info: "text-accent-strong",
  success: "text-success",
  danger: "text-danger-foreground",
};

const subscribeToNothing = () => () => {};
const readNoClock = () => 0;

/** One label / value line of the sheet's card; a chevron when it leads somewhere. */
function InfoRow(props: {
  readonly label: string;
  readonly first?: boolean;
  readonly onPress?: (() => void) | undefined;
  readonly accessibilityLabel?: string;
  readonly children: ReactNode;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  return (
    <Pressable
      accessibilityRole={props.onPress ? "button" : "text"}
      accessibilityLabel={props.accessibilityLabel}
      disabled={!props.onPress}
      onPress={props.onPress}
      className={cn(
        "min-h-12 flex-row items-center gap-3 px-4 py-2.5 active:bg-subtle",
        props.first ? "" : "border-t border-border",
      )}
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <View className="min-w-0 flex-1 flex-row items-center justify-end gap-1.5">
        {props.children}
      </View>
      {props.onPress ? (
        <SymbolView name="chevron.right" size={11} tintColor={iconColor} type="monochrome" />
      ) : null}
    </Pressable>
  );
}

function ValueText(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <Text
      className={cn("shrink text-right text-sm font-ryco-medium text-foreground", props.className)}
      numberOfLines={1}
    >
      {props.children}
    </Text>
  );
}

function QuickButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly onPress: (() => void) | undefined;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={!props.onPress}
      onPress={props.onPress}
      className="h-16 flex-1 items-center justify-center gap-1 rounded-2xl bg-card active:bg-card-alt disabled:opacity-35"
    >
      <SymbolView name={props.icon} size={18} tintColor={iconColor} type="monochrome" />
      <Text className="text-xs font-ryco-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function StatusValue(props: {
  readonly model: ThreadHeaderModel;
  readonly runningSince: string | null;
}) {
  const live = props.runningSince !== null;
  const nowMs = useSyncExternalStore(
    live ? secondClock.subscribe : subscribeToNothing,
    live ? secondClock.read : readNoClock,
  );
  const tone = threadStatusTone(props.model.statusLabel);
  const startedMs = props.runningSince === null ? Number.NaN : Date.parse(props.runningSince);
  const label =
    tone === "working" && Number.isFinite(startedMs)
      ? `Working ${formatElapsed(nowMs - startedMs)}`
      : tone === "working"
        ? "Working"
        : props.model.statusLabel;
  return (
    <ValueText className={STATUS_TEXT[tone]}>
      <Text style={{ fontVariant: ["tabular-nums"] }}>{label}</Text>
    </ValueText>
  );
}

export interface ThreadContextSheetActions {
  readonly openMachines: () => void;
  readonly openProject: (() => void) | undefined;
  /** The repository's issues, Actions runs and Jira items. */
  readonly openExplorer?: (() => void) | undefined;
  readonly openSourceControl: (() => void) | undefined;
  readonly openFiles: (() => void) | undefined;
  readonly openTerminal: (() => void) | undefined;
  readonly openReview: (() => void) | undefined;
  readonly openPullRequest: (() => void) | undefined;
  readonly openCacheInfo: (() => void) | undefined;
  readonly openAgents: () => void;
  readonly openThread: (threadId: string) => void;
}

/**
 * One sheet for the chat's context, behind the title pill: the machine, project and worktree
 * (each opens its screen), the status, the pull request and its watch, Claude's cache, the
 * chat that delegated this one (with whether its result returned) and the chats this one
 * delegated, with quick ways into files, terminal, git and the pull request.
 */
export function ThreadContextSheet(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly model: ThreadHeaderModel;
  readonly runningSince: string | null;
  readonly checks: CheckSummary | null;
  /** "128k read · 4.1k written"; null when the thread is not Claude's. */
  readonly cacheSummary: string | null;
  readonly parent: ThreadParentLink | null;
  readonly delegated: ReadonlyArray<ThreadAgentRow>;
  /** The chat's agents and delegated tasks; null when it set none working. */
  readonly agents: ThreadAgentsEntry | null;
  readonly pullRequestWatch: PullRequestWatchControl | null;
  /** Settled Agent Control receipts of this chat (pending ones sit over the composer). */
  readonly agentControlReceipts: ReadonlyArray<AgentControlProposalView>;
  /** The goal the agent pursues (`/goal`), with its controls; null when it has none. */
  readonly goal: {
    readonly goal: ThreadGoal;
    readonly busy: boolean;
    readonly actions: ThreadGoalActions;
  } | null;
  readonly actions: ThreadContextSheetActions;
}) {
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  // A row that leads to another screen closes the sheet first and goes once it is gone.
  const pending = useRef<(() => void) | null>(null);
  const go = (action: (() => void) | undefined) =>
    action
      ? () => {
          pending.current = action;
          props.onClose();
        }
      : undefined;
  const onDismissed = () => {
    const action = pending.current;
    pending.current = null;
    action?.();
  };
  const { model, actions } = props;
  const iconColor = useThemeColor("--color-icon-subtle");
  const subagentsOnly = props.agents !== null && props.delegated.length === 0 ? props.agents : null;

  return (
    <BottomSheet
      visible={props.visible}
      onClose={props.onClose}
      onDismissed={onDismissed}
      accessibilityLabel="Chat details"
    >
      <Text className="text-lg font-ryco-bold text-foreground" numberOfLines={2}>
        {model.title}
      </Text>

      <View className="overflow-hidden rounded-2xl bg-card">
        <InfoRow first label="Machine" onPress={go(actions.openMachines)}>
          <DeviceIcon environmentId={props.environmentId} label={model.nodeLabel} size={15} />
          <ValueText>{model.nodeLabel}</ValueText>
        </InfoRow>
        <InfoRow label="Project" onPress={go(actions.openProject)}>
          <ValueText>{model.projectLabel}</ValueText>
        </InfoRow>
        {actions.openExplorer ? (
          <InfoRow label="Repository" onPress={go(actions.openExplorer)}>
            <ValueText>Issues · Actions</ValueText>
          </InfoRow>
        ) : null}
        <InfoRow
          label={model.contextHeading === "Project · Folder" ? "Folder" : "Worktree · branch"}
          onPress={go(actions.openSourceControl)}
        >
          <ValueText>{model.worktreeLabel}</ValueText>
        </InfoRow>
        <InfoRow label="Status">
          <StatusValue model={model} runningSince={props.runningSince} />
        </InfoRow>
        {model.changeRequest ? (
          <InfoRow label="Pull request" onPress={go(actions.openPullRequest)}>
            <ChangeRequestBadge badge={model.changeRequest} />
            {props.checks ? <CheckSummaryBadge summary={props.checks} /> : null}
            {model.pullRequestWatch?.chip ? (
              <PullRequestWatchChip chip={model.pullRequestWatch.chip} />
            ) : null}
          </InfoRow>
        ) : null}
        {props.cacheSummary !== null ? (
          <InfoRow
            label="Claude cache"
            accessibilityLabel={`Claude cache, ${props.cacheSummary}. Show details.`}
            onPress={go(actions.openCacheInfo)}
          >
            <ValueText className="font-sans">{props.cacheSummary}</ValueText>
            <SymbolView name="info.circle" size={13} tintColor={iconColor} type="monochrome" />
          </InfoRow>
        ) : null}
        {props.parent ? (
          <InfoRow
            label="Delegated by"
            accessibilityLabel={`Delegated by ${props.parent.title}${
              props.parent.resultLabel ? `, result ${props.parent.resultLabel}` : ""
            }. Open it.`}
            onPress={go(() => actions.openThread(props.parent!.threadId))}
          >
            <View className="min-w-0 shrink items-end">
              <ValueText>{props.parent.title}</ValueText>
              {props.parent.resultLabel && props.parent.resultTone ? (
                <Text className={cn("text-2xs", RESULT_TEXT[props.parent.resultTone])}>
                  {props.parent.resultLabel}
                </Text>
              ) : null}
            </View>
          </InfoRow>
        ) : null}
        {subagentsOnly ? (
          <InfoRow label="Agents" onPress={go(actions.openAgents)}>
            <ValueText className={subagentsOnly.live ? "text-accent-strong" : undefined}>
              {subagentsOnly.label}
            </ValueText>
          </InfoRow>
        ) : null}
      </View>

      {props.goal ? (
        <ThreadGoalSection
          goal={props.goal.goal}
          runningSince={props.runningSince}
          busy={props.goal.busy}
          actions={props.goal.actions}
        />
      ) : null}

      {props.delegated.length > 0 ? (
        <View className="gap-2">
          <View className="flex-row items-center justify-between px-1">
            <Text className="text-sm font-ryco-medium text-foreground-muted">
              Delegated · {props.delegated.length}
            </Text>
            {props.agents ? (
              <Pressable
                accessibilityRole="button"
                onPress={go(actions.openAgents)}
                hitSlop={8}
                className="active:opacity-60"
              >
                <Text className="text-xs font-ryco-medium text-accent-strong">All agents</Text>
              </Pressable>
            ) : null}
          </View>
          <View className="overflow-hidden rounded-2xl bg-card">
            {props.delegated.map((row, index) => (
              <Pressable
                key={row.key}
                accessibilityRole="button"
                accessibilityLabel={`${row.label}, ${row.statusLabel}${
                  row.activity ? `, ${row.activity}` : ""
                }. Open it.`}
                onPress={
                  row.childThreadId === null
                    ? undefined
                    : go(() => actions.openThread(row.childThreadId!))
                }
                className={cn(
                  "min-h-12 flex-row items-center gap-3 px-4 py-2.5 active:bg-subtle",
                  index === 0 ? "" : "border-t border-border",
                )}
              >
                <View className={cn("h-2 w-2 rounded-full", AGENT_DOT[row.tone])} />
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-ryco-medium text-foreground" numberOfLines={1}>
                    {row.label}
                  </Text>
                  <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
                    {row.activity ? `${row.statusLabel} · ${row.activity}` : row.statusLabel}
                  </Text>
                </View>
                <SymbolView
                  name="chevron.right"
                  size={11}
                  tintColor={iconColor}
                  type="monochrome"
                />
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <View className="flex-row gap-2">
        <QuickButton icon="folder" label="Files" onPress={go(actions.openFiles)} />
        <QuickButton icon="apple.terminal" label="Terminal" onPress={go(actions.openTerminal)} />
        <QuickButton
          icon="arrow.triangle.branch"
          label="Git"
          onPress={go(actions.openReview ?? actions.openSourceControl)}
        />
        <QuickButton icon="arrow.triangle.pull" label="PR" onPress={go(actions.openPullRequest)} />
      </View>

      {props.pullRequestWatch ? <PullRequestWatchSection control={props.pullRequestWatch} /> : null}

      {props.agentControlReceipts.length > 0 ? (
        <View className="-mx-4">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: receiptsOpen }}
            onPress={() => setReceiptsOpen((open) => !open)}
            className="min-h-11 flex-row items-center gap-1.5 px-5 active:opacity-60"
          >
            <SymbolView
              name={receiptsOpen ? "chevron.down" : "chevron.right"}
              size={10}
              tintColor={iconColor}
              type="monochrome"
            />
            <Text className="text-sm font-ryco-medium text-foreground-muted">
              Agent Control · {props.agentControlReceipts.length}
            </Text>
          </Pressable>
          {receiptsOpen
            ? props.agentControlReceipts.map((proposal) => (
                <AgentControlProposalCard
                  key={proposal.proposalId}
                  environmentId={props.environmentId}
                  proposal={proposal}
                  onOpenThread={(threadId) => go(() => actions.openThread(threadId))?.()}
                />
              ))
            : null}
        </View>
      ) : null}
      <View className="h-2" />
    </BottomSheet>
  );
}
