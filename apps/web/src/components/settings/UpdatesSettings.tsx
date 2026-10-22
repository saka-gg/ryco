import { ArrowUpCircleIcon, LoaderIcon, MonitorSmartphoneIcon, RefreshCwIcon } from "lucide-react";

import { useNodeUpdateState, useUpdateEverything } from "../../updates/useUpdateEverything";
import { Button } from "../ui/button";
import { UpdateDeviceCard } from "../updates/UpdateDeviceCard";
import { useRunParticipants } from "../updates/useRunParticipants";
import {
  describeDeviceCard,
  describeRunResult,
  isRunActive,
  nodeUpdateMetaLabel,
  runProgress,
  updateEverythingDeviceEntries,
  updateEverythingPlanSummary,
  updateEverythingSubtitle,
  type UpdateEverythingDeviceEntry,
  type UpdateResultTone,
} from "../updates/updateEverything.logic";
import {
  SETTINGS_CARD_RADIUS_CLASS,
  SettingsCard,
  SettingsEmpty,
  SettingsNotice,
  SettingsPageContainer,
  SettingsSection,
  SettingsToolbar,
  useRelativeLabelTick,
} from "./settingsLayout";

const NOTICE_TONE: Readonly<Record<UpdateResultTone, "info" | "warning" | "error">> = {
  success: "info",
  warning: "warning",
  error: "error",
};

function UpdatesSettingsDevice({
  entry,
  busy,
  onUpdate,
}: {
  entry: UpdateEverythingDeviceEntry;
  busy: boolean;
  onUpdate: () => void;
}) {
  const nodeUpdate = useNodeUpdateState(entry.environmentId);
  const checkedAtMs = nodeUpdate?.checkedAt ? Date.parse(nodeUpdate.checkedAt) : undefined;
  const nowMs = useRelativeLabelTick([checkedAtMs]);
  const view = describeDeviceCard(entry);
  return (
    <UpdateDeviceCard
      view={view}
      meta={nodeUpdateMetaLabel(nodeUpdate, nowMs)}
      className={`${SETTINGS_CARD_RADIUS_CLASS} bg-card px-4 py-3 text-card-foreground shadow-xs/5 dark:border-border/60`}
      action={
        view.canUpdate && !busy ? (
          <Button
            size="xs"
            variant="outline"
            aria-label={`Update ${view.label}`}
            className="ml-1"
            onClick={onUpdate}
          >
            Update
          </Button>
        ) : null
      }
    />
  );
}

/**
 * Settings → Updates: every device this app reaches with what one click would
 * update there, a run for one device or all of them, and a fresh check.
 */
export function UpdatesSettings() {
  const controller = useUpdateEverything();
  const { plan, run } = controller;
  const entries = updateEverythingDeviceEntries(plan, run);
  const active = isRunActive(run);
  const busy = controller.running || active;
  const participants = useRunParticipants(run);
  const progress = run !== null && active ? runProgress(run, participants) : null;
  const outcome = run !== null && !active ? describeRunResult(controller.result) : null;

  return (
    <SettingsPageContainer>
      <SettingsToolbar
        actions={
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={controller.checking}
              onClick={() => void controller.checkAll()}
            >
              {controller.checking ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
              {controller.checking ? "Checking…" : "Check for updates"}
            </Button>
            <Button size="xs" disabled={!plan.hasWork || busy} onClick={() => controller.start()}>
              {busy ? <LoaderIcon className="animate-spin" /> : <ArrowUpCircleIcon />}
              {busy ? "Updating…" : "Update all"}
            </Button>
          </>
        }
      >
        <span aria-live="polite">
          {progress
            ? `Updating · ${progress.done} of ${progress.total} done`
            : updateEverythingPlanSummary(plan)}
        </span>
      </SettingsToolbar>
      {outcome ? (
        <SettingsNotice
          tone={NOTICE_TONE[outcome.tone]}
          title={outcome.title}
          role="status"
          action={
            <Button size="xs" variant="ghost" onClick={() => controller.dismissRun()}>
              Dismiss
            </Button>
          }
        >
          {outcome.description}
        </SettingsNotice>
      ) : null}
      <SettingsSection title="Devices" description={updateEverythingSubtitle(plan)} bare>
        {entries.length === 0 ? (
          <SettingsCard>
            <SettingsEmpty
              icon={<MonitorSmartphoneIcon />}
              title="No devices connected"
              description="Devices this app connects to show up here with their updates."
            />
          </SettingsCard>
        ) : (
          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <UpdatesSettingsDevice
                key={entry.environmentId}
                entry={entry}
                busy={busy}
                onUpdate={() => controller.start({ environmentIds: [entry.environmentId] })}
              />
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
