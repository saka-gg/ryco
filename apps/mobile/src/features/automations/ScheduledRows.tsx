import type { DueDialogRow } from "@ryco/client-runtime/state/automations/dialogModel";
import { missedRunsNoticeView } from "@ryco/client-runtime/state/automations/missedRunsNotice";
import { countdown, rel } from "@ryco/shared/automationSchedule";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ScheduledMissedRuns, ScheduledRowModel } from "./scheduledModel";
import { decideScheduleProposal, dismissScheduleProposals } from "./scheduledRuntime";

function stateSymbol(row: ScheduledRowModel): AppSymbolName {
  switch (row.item.row.state) {
    case "awaiting-approval":
      return "hourglass";
    case "running":
      return "play.circle";
    case "paused":
      return "pause.circle";
    case "finished":
      return "checkmark.circle";
    case "pending-create":
    case "lapsed":
      return "clock.badge.questionmark";
    default:
      return "clock";
  }
}

/** One schedule: title (with a tag for a proposed or failed change), cadence and the next run. */
export function ScheduleListRow(props: {
  readonly row: ScheduledRowModel;
  readonly nowMs: number;
  readonly first: boolean;
  /** Says the project (and machine) under the cadence. */
  readonly showPlace?: boolean;
  readonly onPress: () => void;
}) {
  const { row } = props;
  const p = row.presentation;
  const quiet = row.item.row.state === "paused" || row.item.row.state === "finished";
  const icon = useThemeColor(quiet ? "--color-icon-subtle" : "--color-icon-muted") as string;
  const meta = p.soonAt !== null ? rel(p.soonAt, props.nowMs) : p.meta;
  const detail = [p.summary, props.showPlace ? row.place : null].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[p.title, p.tag, detail, meta].filter(Boolean).join(", ")}
      onPress={props.onPress}
      className="flex-row items-center gap-3 bg-card pl-4 active:bg-subtle"
    >
      <View className="h-6 w-6 items-center justify-center">
        <SymbolView name={stateSymbol(row)} size={18} tintColor={icon} type="monochrome" />
      </View>
      <View
        className={cn(
          "min-h-[58px] min-w-0 flex-1 flex-row items-center gap-3 py-2.5 pr-4",
          !props.first && "border-t border-border-subtle",
        )}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text
              className={cn(
                "shrink text-[16px] font-ryco-medium",
                quiet ? "text-foreground-muted" : "text-foreground",
              )}
              numberOfLines={1}
            >
              {p.title}
            </Text>
            {p.tag ? (
              <View className="rounded-full bg-subtle px-2 py-0.5">
                <Text
                  className={cn(
                    "text-[11px] font-ryco-medium",
                    p.tagTone === "err" ? "text-danger-foreground" : "text-foreground-muted",
                  )}
                  numberOfLines={1}
                >
                  {p.tag}
                </Text>
              </View>
            ) : null}
          </View>
          <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
            {detail}
          </Text>
        </View>
        <Text
          className={cn(
            "max-w-[38%] text-[13px]",
            p.metaTone === "fg" ? "font-ryco-medium text-foreground" : "text-foreground-tertiary",
          )}
          numberOfLines={1}
        >
          {meta}
        </Text>
      </View>
    </Pressable>
  );
}

export function DecisionButton(props: {
  readonly label: string;
  readonly primary?: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const spinner = useThemeColor(
    props.primary ? "--color-primary-foreground" : "--color-foreground",
  ) as string;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, busy: props.busy }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "h-9 min-w-[84px] items-center justify-center rounded-full px-4 active:opacity-70",
        props.primary ? "bg-primary" : "bg-subtle",
        props.disabled && !props.busy && "opacity-50",
      )}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color={spinner} />
      ) : (
        <Text
          className={cn(
            "text-[14px] font-ryco-bold",
            props.primary ? "text-primary-foreground" : "text-foreground",
          )}
        >
          {props.label}
        </Text>
      )}
    </Pressable>
  );
}

/** Approve / Reject for a proposal, with the busy state and the error said under them. */
export function useDecision() {
  const [pending, setPending] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (
    input: Omit<Parameters<typeof decideScheduleProposal>[0], "decision">,
    decision: "accept" | "reject",
  ) => {
    if (pending) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPending(decision);
    setError(null);
    const result = await decideScheduleProposal({ ...input, decision });
    setPending(null);
    if (!result.ok) setError(result.error);
    else if (decision === "accept")
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };
  return { pending, error, decide };
}

/** A run waiting for approval: it starts a chat once approved, and expires in 15 minutes. */
export function WaitingRunRow(props: {
  readonly waiting: DueDialogRow & { readonly place: string | null };
  readonly nowMs: number;
  readonly first: boolean;
  readonly onOpen: () => void;
}) {
  const { waiting } = props;
  const { pending, error, decide } = useDecision();
  const icon = useThemeColor("--color-icon-muted") as string;
  const proposalId = waiting.due.proposalId;
  const left = waiting.due.expiresAtMs - props.nowMs;
  const missed = waiting.due.coalescedOccurrences;
  const target = { environmentId: waiting.environmentId, projectId: waiting.projectId };
  return (
    <View
      className={cn("gap-2.5 bg-card px-4 py-3", !props.first && "border-t border-border-subtle")}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Opens the schedule"
        onPress={props.onOpen}
        className="flex-row items-center gap-3 active:opacity-70"
      >
        <SymbolView name="hourglass" size={18} tintColor={icon} type="monochrome" />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[16px] font-ryco-medium text-foreground" numberOfLines={1}>
            {waiting.row.title || "Untitled schedule"}
          </Text>
          <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
            {[
              left > 0 ? `Expires in ${countdown(left)}` : "Expiring",
              missed > 0 ? `${missed} missed, folded into one run` : null,
              waiting.place,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
      </Pressable>
      {proposalId ? (
        <View className="flex-row justify-end gap-2">
          <DecisionButton
            label="Reject"
            busy={pending === "reject"}
            disabled={pending !== null}
            onPress={() => void decide({ ...target, proposalId }, "reject")}
          />
          <DecisionButton
            label="Run now"
            primary
            busy={pending === "accept"}
            disabled={pending !== null}
            onPress={() => void decide({ ...target, proposalId }, "accept")}
          />
        </View>
      ) : null}
      {error ? <Text className="text-xs text-danger-foreground">{error}</Text> : null}
    </View>
  );
}

/**
 * What a machine's scheduler caught up on after it was offline (the web's missed-runs
 * notice): one waiting catch-up run can be run from here; dismissing hides the notice.
 */
export function MissedRunsNotice(props: {
  readonly missed: ScheduledMissedRuns;
  readonly nowMs: number;
  readonly showMachine: boolean;
}) {
  const { missed } = props;
  const view = missedRunsNoticeView(missed.runs, {
    deviceLabel: props.showMachine ? missed.machineLabel : null,
    nowMs: props.nowMs,
  });
  const { pending, error, decide } = useDecision();
  const only = missed.runs.length === 1 ? missed.runs[0] : undefined;
  const icon = useThemeColor("--color-warning") as string;
  const dismiss = () => dismissScheduleProposals(missed.runs.map((run) => run.proposalId));
  return (
    <View className="gap-2 rounded-2xl bg-card px-4 py-3">
      <View className="flex-row items-start gap-3">
        <View className="pt-0.5">
          <SymbolView name="moon.zzz" size={17} tintColor={icon} type="monochrome" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[15px] font-ryco-medium text-foreground">{view.title}</Text>
          <Text className="text-[13px] leading-[18px] text-foreground-muted">
            {view.description}
          </Text>
        </View>
      </View>
      <View className="flex-row justify-end gap-2">
        <DecisionButton
          label="Dismiss"
          busy={false}
          disabled={pending !== null}
          onPress={dismiss}
        />
        {view.canRunNow && only ? (
          <DecisionButton
            label="Run now"
            primary
            busy={pending === "accept"}
            disabled={pending !== null}
            onPress={() =>
              void decide(
                {
                  environmentId: missed.environmentId,
                  projectId: only.projectId,
                  proposalId: only.proposalId,
                },
                "accept",
              )
            }
          />
        ) : null}
      </View>
      {error ? <Text className="text-xs text-danger-foreground">{error}</Text> : null}
    </View>
  );
}
