import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import type { ServerSettingsPatch } from "@ryco/contracts/settings";
import type {
  ShareableServerSettingKey,
  ShareableSettingValue,
} from "@ryco/shared/settingsSharing";
import { useMemo, useState } from "react";

import { updateEnvironmentServerSettings } from "../../../connection/environmentApi";
import { useEnvironmentServerConfigs } from "../../../state/environmentServerConfigs";
import { useHomeEnvironments } from "../../home/useHomeEnvironments";
import type { InboxEnvironment } from "../../inbox/inboxModel";
import {
  canChangeNodeSettings,
  homeNodeSettingsTargets,
  nodeConnected,
  nodeSettingsReadOnlyReason,
} from "../nodeSettingsTargets";
import { mobileSettingsSharing } from "../sharing/mobileSettingsSharing";
import { applySharedSettingToAllNodes, saveNodeSharedSetting } from "../sharing/sharedSettingEdits";

export interface MachineSettings {
  readonly environmentId: EnvironmentId;
  /** The machine as Machines lists it, or null when it is no longer known. */
  readonly node: InboxEnvironment | null;
  readonly label: string;
  /** Its last known config (settings, providers, capabilities), or null before one arrived. */
  readonly config: ServerConfig | null;
  /** Answers this device now (as its owner or a viewer). */
  readonly connected: boolean;
  /** This device may change it now: its owner, connected and synchronized. */
  readonly editable: boolean;
  /** Why the controls take no change from this device, or null when they do. */
  readonly readOnlyReason: string | null;
  /** A write in flight. */
  readonly saving: boolean;
  /** The last write's failure, until the next write. */
  readonly error: string | null;
  /**
   * Writes a patch of the machine's own settings (`server.updateSettings`, owner only). The
   * node answers with its settings, redacted, which replace the cached config.
   */
  readonly write: (patch: ServerSettingsPatch) => Promise<boolean>;
  /**
   * Saves this machine's value of a shared device setting (docs/shared-device-settings.md):
   * stamped like the web's rows, so the edit never turns into another machine's value.
   * Use it, not `write`, for every key `@ryco/shared/settingsSharing` marks shareable.
   */
  readonly writeShared: <K extends ShareableServerSettingKey>(
    key: K,
    value: ShareableSettingValue<K>,
  ) => Promise<boolean>;
  /** Gives every machine this value; resolves the one line saying what it did. */
  readonly applyEverywhere: <K extends ShareableServerSettingKey>(
    key: K,
    value: ShareableSettingValue<K>,
  ) => Promise<string>;
}

/**
 * One machine's settings for the per-machine Settings screens: its config, whether this
 * device may change it (the node's own owner rule), and a write through its connection.
 */
export function useMachineSettings(environmentId: EnvironmentId): MachineSettings {
  const nodes = useHomeEnvironments();
  const configs = useEnvironmentServerConfigs();
  const node = nodes.find((candidate) => candidate.environmentId === environmentId) ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = node !== null && canChangeNodeSettings(node);
  // Every known node: a shared edit is stamped against all of them.
  const targets = useMemo(
    () => homeNodeSettingsTargets({ nodes, configs, write: updateEnvironmentServerSettings }),
    [configs, nodes],
  );
  const run = async (save: () => Promise<void>) => {
    if (!editable) return false;
    setSaving(true);
    setError(null);
    const failure = await settle(save);
    setSaving(false);
    setError(failure);
    return failure === null;
  };
  const write = (patch: ServerSettingsPatch) =>
    run(() => updateEnvironmentServerSettings(environmentId, patch));
  const writeShared = <K extends ShareableServerSettingKey>(
    key: K,
    value: ShareableSettingValue<K>,
  ) =>
    run(() =>
      saveNodeSharedSetting({ runtime: mobileSettingsSharing, targets, environmentId, key, value }),
    );
  const applyEverywhere = <K extends ShareableServerSettingKey>(
    key: K,
    value: ShareableSettingValue<K>,
  ) => applySharedSettingToAllNodes({ runtime: mobileSettingsSharing, targets, key, value });
  return {
    environmentId,
    node,
    label: node?.label ?? "Machine",
    config: configs.get(environmentId) ?? null,
    connected: node !== null && nodeConnected(node),
    editable,
    readOnlyReason:
      node === null ? "This machine is no longer paired." : nodeSettingsReadOnlyReason(node),
    saving,
    error,
    write,
    writeShared,
    applyEverywhere,
  };
}

/** Runs a save; resolves its failure message, or null when it saved. */
async function settle(save: () => Promise<void>): Promise<string | null> {
  try {
    await save();
    return null;
  } catch (cause) {
    return writeErrorMessage(cause);
  }
}

function writeErrorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "The change could not be saved.";
}
