import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, View } from "react-native";

import { buildUpdateEverythingPlan } from "@ryco/client-runtime/updates";
import {
  describeDeviceCard,
  describeRunResult,
  isRunActive,
  nextRunParticipants,
  runProgress,
  updateEverythingDeviceEntries,
  updateEverythingPlanSummary,
  type UpdateDeviceCardView,
  type UpdateEverythingRunParticipants,
} from "@ryco/client-runtime/updates/view";
import { useShallow } from "zustand/react/shallow";

import { AppText as Text } from "../../../components/AppText";
import { useEnvironmentServerConfigs } from "../../../state/environmentServerConfigs";
import {
  collectInterruptibleTurnsByEnvironment,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../../state/threadsRuntime";
import { selectShellCurrentByEnvironmentId } from "../../home/homeEnvironmentModel";
import { useHomeEnvironments } from "../../home/useHomeEnvironments";
import { SettingsRow } from "../components/SettingsRow";
import { SettingsSection } from "../components/SettingsSection";
import {
  mobileNodeUpdateStore,
  mobileUpdateRunner,
  assembleMobileUpdateInputs,
  setMobileUpdateResultPresenter,
  setMobileUpdateSources,
  startMobileNodeUpdateWiring,
} from "./mobileUpdateEverything";
import { mobileUpdateSource } from "./mobileUpdateSources";

function deviceLines(card: UpdateDeviceCardView): ReadonlyArray<string> {
  const lines: string[] = [];
  if (card.version?.kind === "change") {
    lines.push(`Ryco ${card.version.from ?? "?"} → ${card.version.to}`);
  } else if (card.version?.kind === "current") {
    lines.push(`Ryco ${card.version.version} · up to date`);
  }
  for (const provider of card.providers) {
    lines.push(`${provider.name} ${provider.from ?? "?"} → ${provider.to ?? "latest"}`);
  }
  if (card.chatWarning) lines.push(card.chatWarning);
  lines.push(...card.notes);
  for (const item of card.manual) {
    lines.push(item.command ? `${item.text} Run: ${item.command}` : item.text);
  }
  if (card.status) {
    lines.push(
      card.status.message ? `${card.status.label} · ${card.status.message}` : card.status.label,
    );
    lines.push(...card.status.failures);
  }
  return lines;
}

/**
 * Settings → Workspace → Updates: every connected machine's Ryco and provider
 * updates, the same plan and wording as on desktop. Only a machine's owner on
 * a ready connection can update it; the node checks every call again.
 */
export function NodeUpdatesSettings() {
  const nodes = useHomeEnvironments();
  const configs = useEnvironmentServerConfigs();
  const threads = useStore(selectSidebarThreadsAcrossEnvironments);
  const shellCurrent = useStore(useShallow(selectShellCurrentByEnvironmentId));
  const nodeUpdates = useSyncExternalStore(
    mobileNodeUpdateStore.subscribe,
    mobileNodeUpdateStore.snapshot,
    mobileNodeUpdateStore.snapshot,
  );
  const runState = useSyncExternalStore(
    mobileUpdateRunner.subscribe,
    mobileUpdateRunner.getSnapshot,
    mobileUpdateRunner.getSnapshot,
  );

  useEffect(() => startMobileNodeUpdateWiring(), []);
  useEffect(
    () =>
      setMobileUpdateResultPresenter((description) => {
        Alert.alert(description.title, description.description);
      }),
    [],
  );

  const sources = useMemo(
    () => ({
      environments: nodes.map((node) =>
        mobileUpdateSource(node, {
          config: configs.get(node.environmentId) ?? null,
          shellCurrent: shellCurrent[node.environmentId] === true,
          nodeUpdate: nodeUpdates.get(node.environmentId) ?? null,
        }),
      ),
      activity: collectInterruptibleTurnsByEnvironment(threads),
    }),
    [configs, nodeUpdates, nodes, shellCurrent, threads],
  );

  useEffect(() => {
    setMobileUpdateSources(sources);
  }, [sources]);

  const plan = useMemo(
    () =>
      buildUpdateEverythingPlan({
        environments: assembleMobileUpdateInputs(sources),
        localApp: null,
      }),
    [sources],
  );
  const run = runState.run;
  const entries = updateEverythingDeviceEntries(plan, run);
  const busy = runState.running || isRunActive(run);
  // A device that loses its connection mid-run turns skipped later; it still counts.
  const [participants, setParticipants] = useState<UpdateEverythingRunParticipants | null>(null);
  const nextParticipants = nextRunParticipants(participants, run);
  if (nextParticipants !== participants) setParticipants(nextParticipants);
  const progress = run !== null && busy ? runProgress(run, nextParticipants) : null;
  const outcome = runState.running ? null : describeRunResult(runState.result);

  return (
    <SettingsSection title="Updates">
      <SettingsRow
        first
        label={runState.checking ? "Checking…" : "Check for updates"}
        disabled={runState.checking}
        detail={
          progress
            ? `Updating · ${progress.done} of ${progress.total} done`
            : updateEverythingPlanSummary(plan)
        }
        onPress={() => {
          void mobileUpdateRunner.checkAll();
        }}
      />
      <SettingsRow
        label={busy ? "Updating…" : "Update everything"}
        disabled={!plan.hasWork || busy}
        onPress={() => {
          const restarting = plan.devices.filter(
            (device) => device.runningChatCount > 0 && !device.continuesChatsAfterRestart,
          );
          if (restarting.length === 0) {
            mobileUpdateRunner.start();
            return;
          }
          Alert.alert(
            "Stop running chats?",
            `Updating restarts ${restarting.map((device) => device.label).join(", ")}, which stops the chats running there.`,
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Update",
                style: "destructive",
                onPress: () => mobileUpdateRunner.start(),
              },
            ],
          );
        }}
      />
      {outcome ? (
        <SettingsRow
          label={outcome.title}
          {...(outcome.description ? { detail: outcome.description } : {})}
          value="Dismiss"
          onPress={() => mobileUpdateRunner.dismissRun()}
        />
      ) : null}
      {entries.map((entry) => {
        const card = describeDeviceCard(entry);
        return (
          <View key={entry.environmentId} className="gap-1 border-t border-border px-5 py-3">
            <Text className="text-[15px] font-ryco-medium text-foreground">
              {card.label}
              {card.installationLabel ? ` · ${card.installationLabel}` : ""}
            </Text>
            {deviceLines(card).map((line, index) => (
              <Text key={index} className="text-xs text-foreground-muted">
                {line}
              </Text>
            ))}
            {card.canUpdate && !busy ? (
              <Text
                accessibilityRole="button"
                className="pt-1 text-sm font-ryco-medium text-primary"
                onPress={() => mobileUpdateRunner.start({ environmentIds: [entry.environmentId] })}
              >
                Update this machine
              </Text>
            ) : null}
          </View>
        );
      })}
    </SettingsSection>
  );
}
