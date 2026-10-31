import { subscribeEnvironmentServerConfigs } from "@ryco/client-runtime/rpc";
import type { UpdateEverythingDeviceEntry } from "@ryco/client-runtime/updates/view";
import { WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import { useCallback, useState, useSyncExternalStore } from "react";

import { readNodeServerConfig } from "../../environments/nodeServerConfig";
import { updateEnvironmentServerSettings } from "../../environments/runtime";
import {
  mayCallNodeOwnerMethod,
  subscribeNodeMethodPermissions,
} from "../../updates/nodeUpdatePermissions";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  automaticUpdatesDesktopNote,
  automaticUpdatesSwitch,
  automaticUpdatesView,
  type AutomaticUpdatesView,
} from "./AutomaticUpdatesSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

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

function AutomaticUpdatesRow({
  environmentId,
  label,
  view,
}: {
  environmentId: EnvironmentId;
  label: string;
  view: Exclude<AutomaticUpdatesView, "hidden">;
}) {
  const [saving, setSaving] = useState(false);
  const readDesktopNote = useCallback(
    () => automaticUpdatesDesktopNote(readNodeServerConfig(environmentId)),
    [environmentId],
  );
  const desktopNote = useSyncExternalStore(
    subscribeEnvironmentServerConfigs,
    readDesktopNote,
    readDesktopNote,
  );
  const save = (automaticUpdates: boolean) => {
    setSaving(true);
    void updateEnvironmentServerSettings(environmentId, { automaticUpdates })
      .catch((error: unknown) => {
        console.error(`[SETTINGS] update failed for ${environmentId}`, error);
        toastManager.add({
          type: "error",
          title: "Could not save node settings",
          description: `Reconnect to ${label} and try again.`,
        });
      })
      .finally(() => setSaving(false));
  };
  const { checked, checksOff, canChange } = automaticUpdatesSwitch(view);
  return (
    <SettingsRow
      title={label}
      description={desktopNote ?? undefined}
      status={
        checksOff
          ? checked
            ? "Does nothing while provider update checks are off for this node (General settings)."
            : "Acts only while provider update checks are on. Turn them on for this node first (General settings)."
          : undefined
      }
      control={
        <Switch
          checked={checked}
          disabled={saving || !canChange}
          onCheckedChange={(next) => save(Boolean(next))}
          aria-label={`Update ${label} automatically`}
        />
      }
    />
  );
}

/**
 * Settings → Updates: per node its owner may turn on unattended updates of its provider CLIs (and,
 * on a CLI service node, of Ryco itself). Rows show only on nodes that support them and that this
 * session owns.
 */
export function AutomaticUpdatesSettings({
  entries,
}: {
  entries: ReadonlyArray<UpdateEverythingDeviceEntry>;
}) {
  const views = useAutomaticUpdatesViews(entries.map((entry) => entry.environmentId));
  const rows = entries.flatMap((entry, index) => {
    const view = views[index];
    return view === undefined || view === "hidden"
      ? []
      : [{ environmentId: entry.environmentId, label: entry.device?.label ?? "This node", view }];
  });
  if (rows.length === 0) return null;
  return (
    <SettingsSection
      title="Update automatically"
      description="Install provider CLI updates on their own once nobody has used Ryco for 2 minutes and no agent on this computer is working. Only versions this Ryco release has checked and rates supported, at least 2 days after their release, one at a time. A CLI service node installed with npm or pnpm also updates Ryco itself, 2 days after a release, and restarts only once nobody has used it for 5 minutes and no agent, terminal command, clone or cleanup is running. Other updates still wait for you."
    >
      {rows.map((row) => (
        <AutomaticUpdatesRow
          key={row.environmentId}
          environmentId={row.environmentId}
          label={row.label}
          view={row.view}
        />
      ))}
    </SettingsSection>
  );
}
