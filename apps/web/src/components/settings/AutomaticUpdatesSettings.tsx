import { subscribeEnvironmentServerConfigs } from "@ryco/client-runtime/rpc";
import type { UpdateEverythingDeviceEntry } from "@ryco/client-runtime/updates/view";
import { WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import type { NodeSettingsConfig } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import { useCallback, useSyncExternalStore } from "react";

import { readNodeServerConfig } from "../../environments/nodeServerConfig";
import { SettingsEditingScopeProvider } from "../../settingsTarget";
import {
  mayCallNodeOwnerMethod,
  subscribeNodeMethodPermissions,
} from "../../updates/nodeUpdatePermissions";
import { Switch } from "../ui/switch";
import {
  automaticUpdatesDesktopNote,
  automaticUpdatesView,
  type AutomaticUpdatesView,
} from "./AutomaticUpdatesSettings.logic";
import { SettingsSection } from "./settingsLayout";
import { SharedSettingRow, sharedControlLabel } from "./sharedSettings/SharedSettingRow";

function subscribeAutomaticUpdatesView(listener: () => void): () => void {
  const unsubscribeConfigs = subscribeEnvironmentServerConfigs(listener);
  const unsubscribePermissions = subscribeNodeMethodPermissions(listener);
  return () => {
    unsubscribeConfigs();
    unsubscribePermissions();
  };
}

function readAutomaticUpdatesView(environmentId: EnvironmentId): AutomaticUpdatesView {
  return automaticUpdatesView({
    config: readNodeServerConfig(environmentId),
    owner: mayCallNodeOwnerMethod(WS_METHODS.serverUpdateSettings, environmentId),
  });
}

function useAutomaticUpdatesViews(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<AutomaticUpdatesView> {
  // Keyed by the ids, not the array, whose identity changes with every plan.
  const key = environmentIds.join("\n");
  const readKey = useCallback(
    () =>
      key === ""
        ? ""
        : key
            .split("\n")
            .map((environmentId) => readAutomaticUpdatesView(environmentId as EnvironmentId))
            .join("\n"),
    [key],
  );
  const views = useSyncExternalStore(subscribeAutomaticUpdatesView, readKey, readKey);
  return views === "" ? [] : (views.split("\n") as AutomaticUpdatesView[]);
}

const nodeUpdatesAutomatically = (config: NodeSettingsConfig): boolean =>
  config.environment.capabilities.automaticUpdates === true;

/** What a desktop app device also does while the setting is on, per device that says. */
function useDesktopNotes(entries: ReadonlyArray<UpdateEverythingDeviceEntry>): string | null {
  // Keyed by the ids and labels, not the array, whose identity changes with every plan.
  const key = entries
    .map((entry) => `${entry.environmentId}\t${entry.device?.label ?? "This node"}`)
    .join("\n");
  const read = useCallback(
    () =>
      key
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          const [environmentId, label] = line.split("\t") as [EnvironmentId, string];
          const note = automaticUpdatesDesktopNote(readNodeServerConfig(environmentId));
          return note === null ? [] : [`${label}: ${note}`];
        })
        .join("\n"),
    [key],
  );
  const notes = useSyncExternalStore(subscribeEnvironmentServerConfigs, read, read);
  return notes === "" ? null : notes;
}

/**
 * Settings → Updates: unattended updates of provider CLIs (and, on a CLI service node, of Ryco
 * itself), shared across devices. Shown once a device this session owns supports them.
 */
export function AutomaticUpdatesSettings({
  entries,
}: {
  entries: ReadonlyArray<UpdateEverythingDeviceEntry>;
}) {
  const views = useAutomaticUpdatesViews(entries.map((entry) => entry.environmentId));
  const desktopNotes = useDesktopNotes(entries);
  const checksOff = views.some((view) => view.endsWith("-checks-off"));
  if (!views.some((view) => view !== "hidden")) return null;
  // A setting of every device, inside the Updates page's app part: shown whatever that part's
  // editing scope (an app-only scope hides rows stored on devices).
  return (
    <SettingsEditingScopeProvider value="all">
      <AutomaticUpdatesSection desktopNotes={desktopNotes} checksOff={checksOff} />
    </SettingsEditingScopeProvider>
  );
}

function AutomaticUpdatesSection({
  desktopNotes,
  checksOff,
}: {
  readonly desktopNotes: string | null;
  readonly checksOff: boolean;
}) {
  return (
    <SettingsSection title="Update automatically">
      <SharedSettingRow
        settingKey="automaticUpdates"
        description="Install provider CLI updates on their own once nobody has used Ryco for 2 minutes and no agent on this computer is working. Only versions this Ryco release has checked and rates supported, at least 2 days after their release, one at a time. A CLI service node installed with npm or pnpm also updates Ryco itself, 2 days after a release, and restarts only once nobody has used it for 5 minutes and no agent, terminal command, clone or cleanup is running. Other updates still wait for you."
        status={
          desktopNotes || checksOff ? (
            <>
              {desktopNotes ? (
                <span className="block whitespace-pre-line">{desktopNotes}</span>
              ) : null}
              {checksOff ? (
                <span className="block">
                  Acts only on devices whose provider update checks are on.
                </span>
              ) : null}
            </>
          ) : undefined
        }
        knowsSetting={nodeUpdatesAutomatically}
        unknownSettingStatus="Update this device to install updates automatically."
        render={(control) => (
          <Switch
            checked={control.value}
            disabled={control.disabled}
            onCheckedChange={(next) => control.onChange(Boolean(next))}
            aria-label={sharedControlLabel("Update automatically", control)}
          />
        )}
      />
    </SettingsSection>
  );
}
