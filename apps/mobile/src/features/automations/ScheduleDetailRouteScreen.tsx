import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AUTOMATION_RUN_STATUS,
  definitionWithEnabled,
  diffScheduleDefinitions,
  failedScheduleProposals,
  runsInWords,
  scheduleModelLabel,
  scheduleRetryState,
  type ScheduleProposal,
} from "@ryco/client-runtime/state/agentControl";
import type { DialogRow } from "@ryco/client-runtime/state/automations/dialogModel";
import type { AutomationCommandDraft } from "@ryco/client-runtime/state/automations/commands";
import {
  approveProposalLabel,
  detailVerb,
  lapsedWords,
  PROPOSAL_HEAD,
  proposalNote,
  rejectProposalLabel,
  runHistoryText,
  scheduleWhenLine,
} from "@ryco/client-runtime/state/automations/words";
import type {
  AgentControlAutomationId,
  AutomationCentreRun,
  ProjectId,
  ThreadId,
} from "@ryco/contracts";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import { countdown, phrase, when } from "@ryco/shared/automationSchedule";
import * as Haptics from "expo-haptics";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { runtimeModeConfig } from "../threads/sessionPolicyPresentation";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { openScheduleEditor } from "./scheduledNavigation";
import { DecisionButton, useDecision } from "./ScheduledRows";
import { dismissScheduleProposals, sendScheduleCommand } from "./scheduledRuntime";
import { useScheduleCheckout, type ScheduleCheckout } from "./useScheduleCheckout";

type ScheduleDetailRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly automationId: string;
}>;

const runtimeModeLabel = (mode: keyof typeof runtimeModeConfig) => runtimeModeConfig[mode].label;

/** A card above the schedule's facts: what waits for the user, or what went wrong. */
function Block(props: {
  readonly icon: string;
  readonly title: string;
  readonly body?: string | null;
  readonly tone?: "default" | "danger";
  readonly children?: ReactNode;
}) {
  const icon = useThemeColor(
    props.tone === "danger" ? "--color-danger-foreground" : "--color-icon-muted",
  ) as string;
  return (
    <View className="mx-4 mt-3 gap-2.5 rounded-[22px] bg-card px-4 py-3.5">
      <View className="flex-row items-start gap-3">
        <View className="pt-0.5">
          <SymbolView name={props.icon as never} size={17} tintColor={icon} type="monochrome" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text
            className={cn(
              "text-[15px] font-ryco-medium",
              props.tone === "danger" ? "text-danger-foreground" : "text-foreground",
            )}
          >
            {props.title}
          </Text>
          {props.body ? (
            <Text className="text-[13px] leading-[18px] text-foreground-muted">{props.body}</Text>
          ) : null}
        </View>
      </View>
      {props.children}
    </View>
  );
}

function ProposalBlock(props: {
  readonly checkout: ScheduleCheckout;
  readonly item: DialogRow;
  readonly proposal: ScheduleProposal;
}) {
  const { checkout, item, proposal } = props;
  const { pending, error, decide } = useDecision();
  const diff =
    proposal.kind === "edit" && proposal.before && proposal.after
      ? diffScheduleDefinitions(proposal.before, proposal.after, {
          nowMs: checkout.nowMs,
          runtimeModeLabel,
          providers: checkout.providers,
        })
      : [];
  const target = {
    environmentId: checkout.environmentId,
    projectId: checkout.projectId,
    proposalId: proposal.id,
  };
  const left = proposal.expiresAtMs - checkout.nowMs;
  return (
    <Block
      icon="questionmark.circle"
      title={PROPOSAL_HEAD[proposal.kind]}
      body={[
        proposalNote(proposal, item.row.automation, checkout.nowMs),
        left > 0 ? `Expires in ${countdown(left)}.` : null,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {diff.length > 0 ? (
        <View className="gap-1 rounded-xl bg-subtle px-3 py-2.5">
          {diff.map((row) => (
            <Text key={row.key} className="text-[13px] text-foreground">
              <Text className="text-foreground-muted">{row.label}: </Text>
              {row.before !== null ? (
                <Text className="text-foreground-muted line-through">{row.before} </Text>
              ) : null}
              {row.after}
            </Text>
          ))}
        </View>
      ) : null}
      <View className="flex-row justify-end gap-2">
        <DecisionButton
          label={rejectProposalLabel(proposal.kind)}
          busy={pending === "reject"}
          disabled={pending !== null || !checkout.connected}
          onPress={() => void decide(target, "reject")}
        />
        <DecisionButton
          label={approveProposalLabel(proposal.kind)}
          primary
          busy={pending === "accept"}
          disabled={pending !== null || !checkout.connected}
          onPress={() => void decide(target, "accept")}
        />
      </View>
      {error ? <Text className="text-xs text-danger-foreground">{error}</Text> : null}
    </Block>
  );
}

function DueRunBlock(props: { readonly checkout: ScheduleCheckout; readonly item: DialogRow }) {
  const { checkout, item } = props;
  const due = item.row.dueRun;
  const { pending, error, decide } = useDecision();
  if (!due) return null;
  const left = due.expiresAtMs - checkout.nowMs;
  const missed = due.coalescedOccurrences;
  const proposalId = due.proposalId;
  return (
    <Block
      icon="hourglass"
      title="Run waiting for your approval"
      body={[
        `Due ${when(due.scheduledForMs, checkout.nowMs)}.`,
        missed > 0
          ? `${missed} missed ${missed === 1 ? "time is" : "times are"} folded into it.`
          : null,
        left > 0 ? `Expires in ${countdown(left)}.` : "Expiring.",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {proposalId ? (
        <View className="flex-row justify-end gap-2">
          <DecisionButton
            label="Reject"
            busy={pending === "reject"}
            disabled={pending !== null || !checkout.connected}
            onPress={() =>
              void decide(
                {
                  environmentId: checkout.environmentId,
                  projectId: checkout.projectId,
                  proposalId,
                },
                "reject",
              )
            }
          />
          <DecisionButton
            label="Run now"
            primary
            busy={pending === "accept"}
            disabled={pending !== null || !checkout.connected}
            onPress={() =>
              void decide(
                {
                  environmentId: checkout.environmentId,
                  projectId: checkout.projectId,
                  proposalId,
                },
                "accept",
              )
            }
          />
        </View>
      ) : null}
      {error ? <Text className="text-xs text-danger-foreground">{error}</Text> : null}
    </Block>
  );
}

function HistoryRow(props: {
  readonly entry: AutomationCentreRun;
  readonly checkout: ScheduleCheckout;
  readonly first: boolean;
  readonly retry: ReturnType<typeof scheduleRetryState>;
  readonly busy: boolean;
  readonly onOpen: (threadId: ThreadId) => void;
  readonly onRetry: () => void;
}) {
  const { entry, checkout } = props;
  const status = AUTOMATION_RUN_STATUS[entry.run.status];
  const words = runHistoryText(entry, null);
  const threadId = entry.threadIds[0] ?? null;
  const chevron = useThemeColor("--color-icon-subtle") as string;
  const dot =
    status.tone === "err"
      ? "bg-danger"
      : status.tone === "faint" || status.tone === "wait"
        ? "border border-foreground-tertiary"
        : "bg-foreground-muted";
  const body = (
    <View
      className={cn(
        "min-h-[56px] flex-1 flex-row items-center gap-3 py-2.5 pr-4",
        !props.first && "border-t border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="text-[15px] font-ryco-medium text-foreground">{status.label}</Text>
          {entry.unread ? <View className="h-2 w-2 rounded-full bg-primary" /> : null}
          <Text className="text-[13px] text-foreground-tertiary">
            {when(entry.run.scheduledFor, checkout.nowMs)}
          </Text>
        </View>
        <Text
          className={cn(
            "text-[13px]",
            words.tone === "err" ? "text-danger-foreground" : "text-foreground-muted",
          )}
          numberOfLines={2}
        >
          {[words.missed, words.retry ? "Retry · " : null, words.text].filter(Boolean).join("")}
        </Text>
        {props.retry.block ? (
          <Text className="text-[12px] text-foreground-tertiary">{props.retry.block.short}</Text>
        ) : null}
      </View>
      {props.retry.ok ? (
        <DecisionButton
          label="Retry"
          busy={props.busy}
          disabled={props.busy}
          onPress={props.onRetry}
        />
      ) : threadId ? (
        <SymbolView name="chevron.right" size={13} weight="semibold" tintColor={chevron} />
      ) : null}
    </View>
  );
  return (
    <Pressable
      accessibilityRole={threadId ? "button" : undefined}
      disabled={!threadId}
      onPress={threadId ? () => props.onOpen(threadId) : undefined}
      className="flex-row items-center gap-3 pl-4 active:bg-subtle"
    >
      <View className={cn("h-2.5 w-2.5 rounded-full", dot)} />
      {body}
    </Pressable>
  );
}

/**
 * One schedule: what waits for a decision (a run, a proposed change, an expired or failed
 * one), when it runs, what each run does, the actions (edit, pause or resume, cancel) and
 * its run history. Every change is proposed and waits for approval, like on the desktop.
 */
export function ScheduleDetailRouteScreen(props: ScheduleDetailRouteScreenProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = props.route.params.projectId as ProjectId;
  const automationId = props.route.params.automationId as AgentControlAutomationId;
  const checkout = useScheduleCheckout(environmentId, projectId);
  const item = checkout.rows.find((row) => row.row.id === automationId) ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({ title: item?.row.title || "Schedule" });
  }, [item?.row.title, navigation]);

  if (!item) {
    return (
      <View className="flex-1 bg-screen px-6 pt-16">
        <EmptyState
          variant="plain"
          title={checkout.status === "loading" ? "Loading…" : "Schedule not found"}
          detail={
            checkout.status === "loading"
              ? ""
              : checkout.status === "unavailable"
                ? "This machine's schedules could not be read. Reconnect and try again."
                : "It may have been cancelled on another device."
          }
        />
      </View>
    );
  }

  const { row } = item;
  const automation = row.automation;
  const def = row.def;
  const execution = def.execution;
  const nowMs = checkout.nowMs;
  const whenLine = scheduleWhenLine(row, nowMs);
  const failed = checkout.snapshot
    ? failedScheduleProposals({
        projectId,
        snapshot: checkout.snapshot,
        queueProposals: checkout.queueProposals,
        dismissedLapsed: checkout.dismissed,
        nowMs,
      }).filter((proposal) => proposal.automationId === row.id)
    : [];
  const scheduleRows = checkout.group?.scheduleRows ?? [];
  const changesOpen = automation !== null && row.proposal === null && checkout.connected;

  // A proposed change shows as the schedule's tag and its approval card once it lands.
  const run = async (key: string, draft: AutomationCommandDraft) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    const result = await sendScheduleCommand(environmentId, draft);
    setBusy(null);
    if (!result.ok) setError(result.error);
    else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };
  const setEnabled = (enabled: boolean) => {
    if (!automation) return;
    void run(enabled ? "resume" : "pause", {
      kind: "save",
      projectId,
      automationId: automation.automationId,
      expectedRevision: automation.revision,
      definition: definitionWithEnabled(automation, enabled, Date.now()),
    });
  };
  const cancel = () => {
    if (!automation) return;
    Alert.alert(
      "Cancel this schedule?",
      "Cancelling is final once approved. The run history stays.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Propose cancel",
          style: "destructive",
          onPress: () =>
            void run("cancel", {
              kind: "cancel",
              projectId,
              automationId: automation.automationId,
              expectedRevision: automation.revision,
            }),
        },
      ],
    );
  };
  const openThread = (entry: AutomationCentreRun, threadId: ThreadId) => {
    if (entry.unread)
      void sendScheduleCommand(environmentId, {
        kind: "read",
        projectId,
        runId: entry.run.runId,
        expectedUpdatedAt: entry.run.updatedAt,
        unread: false,
      });
    navigation.navigate("Thread", { environmentId, threadId });
  };
  const paused = row.state === "paused";

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingBottom: 48 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            checkout.refresh();
            setTimeout(() => setRefreshing(false), 600);
          }}
        />
      }
    >
      <View className="gap-1 px-5 pt-3">
        <Text className="text-[13px] text-foreground-muted">
          {[checkout.projectName, checkout.machineLabel].join(" · ")}
        </Text>
        <Text className="text-[15px] text-foreground">
          {`${detailVerb(row.state)} ${phrase(def.schedule, nowMs)}.`}
        </Text>
      </View>

      <DueRunBlock checkout={checkout} item={item} />
      {row.activeRun ? (
        <Block
          icon="play.circle"
          title={AUTOMATION_RUN_STATUS[row.activeRun.run.status].label}
          body="Its chat is being started."
        />
      ) : null}
      {row.proposal ? (
        <ProposalBlock checkout={checkout} item={item} proposal={row.proposal} />
      ) : null}
      {row.lapsed ? (
        <Block
          icon="clock.badge.xmark"
          title={lapsedWords(row.lapsed.kind).title}
          body={lapsedWords(row.lapsed.kind).body}
        >
          <View className="flex-row justify-end gap-2">
            <DecisionButton
              label={lapsedWords(row.lapsed.kind).dismiss}
              busy={false}
              disabled={false}
              onPress={() => {
                const lapsed = row.lapsed;
                if (lapsed) dismissScheduleProposals([lapsed.id]);
                if (lapsed?.kind === "create") navigation.goBack();
              }}
            />
            <DecisionButton
              label="Propose again"
              primary
              busy={false}
              disabled={!checkout.connected}
              onPress={() =>
                openScheduleEditor(navigation, {
                  mode: "repropose",
                  environmentId,
                  projectId,
                  automationId: row.id,
                })
              }
            />
          </View>
        </Block>
      ) : null}
      {failed.map((proposal) => (
        <Block
          key={proposal.id}
          icon="exclamationmark.triangle"
          tone="danger"
          title="The change couldn't be applied"
          body={proposal.failure}
        >
          <View className="flex-row justify-end">
            <DecisionButton
              label="Dismiss"
              busy={false}
              disabled={false}
              onPress={() => dismissScheduleProposals([proposal.id])}
            />
          </View>
        </Block>
      ))}

      <SettingsSection title="When">
        {whenLine.kind === "quiet" ? (
          <SettingsRow first label={whenLine.text} />
        ) : (
          <SettingsRow
            first
            label={whenLine.kind === "first" ? "First run" : "Next run"}
            value={whenLine.at}
            {...(whenLine.tail ? { detail: whenLine.tail } : {})}
          />
        )}
        {row.lastRun ? (
          <SettingsRow
            label="Last run"
            value={`${AUTOMATION_RUN_STATUS[row.lastRun.run.status].label} · ${when(row.lastRun.run.scheduledFor, nowMs)}`}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Each run">
        <View className="px-4 py-3">
          <Text className="text-[15px] leading-[21px] text-foreground" selectable>
            {execution.prompt}
          </Text>
        </View>
        <SettingsRow
          label="Model"
          value={scheduleModelLabel(execution.modelSelection, checkout.providers, { effort: true })}
        />
        <SettingsRow label="Permissions" value={runtimeModeLabel(execution.runtimeMode)} />
        <SettingsRow
          label="Runs in"
          value={runsInWords(execution)}
          {...(execution.target === undefined && execution.envMode === "worktree"
            ? { detail: `Off ${execution.baseRef ?? "the default branch"}` }
            : {})}
        />
        {def.runPolicy === "run-without-asking" ? (
          <SettingsRow label="Approval" value="Runs without asking" />
        ) : null}
      </SettingsSection>

      {automation ? (
        <SettingsSection
          {...(row.proposal
            ? { footer: "Decide the change waiting above before proposing another." }
            : !checkout.connected
              ? { footer: "Reconnect to this machine to change the schedule." }
              : { footer: "Every change waits for your approval before it applies." })}
        >
          <SettingsRow
            first
            icon="pencil"
            label="Edit"
            disabled={!changesOpen}
            onPress={() =>
              openScheduleEditor(navigation, {
                mode: "edit",
                environmentId,
                projectId,
                automationId: row.id,
              })
            }
          />
          {row.state !== "finished" ? (
            <SettingsRow
              icon={paused ? "play" : "pause"}
              label={
                busy === "pause" || busy === "resume" ? "Proposing…" : paused ? "Resume" : "Pause"
              }
              disabled={!changesOpen || busy !== null}
              onPress={() => setEnabled(paused)}
            />
          ) : null}
          <SettingsRow
            icon="xmark.circle"
            label={busy === "cancel" ? "Proposing…" : "Cancel schedule"}
            destructive
            disabled={!changesOpen || busy !== null}
            onPress={cancel}
          />
        </SettingsSection>
      ) : null}
      {error ? <Text className="px-6 pt-2 text-xs text-danger-foreground">{error}</Text> : null}

      {row.history.length > 0 ? (
        <SettingsSection title="Runs">
          {row.history.map((entry, index) => (
            <HistoryRow
              key={entry.run.runId}
              entry={entry}
              checkout={checkout}
              first={index === 0}
              retry={scheduleRetryState(entry, scheduleRows)}
              busy={busy === `retry:${entry.run.runId}`}
              onOpen={(threadId) => openThread(entry, threadId)}
              onRetry={() =>
                void run(`retry:${entry.run.runId}`, {
                  kind: "retry",
                  projectId,
                  runId: entry.run.runId,
                })
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </ScrollView>
  );
}
