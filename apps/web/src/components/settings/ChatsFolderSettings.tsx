import { resolveChatsAvailability } from "@ryco/client-runtime/state/composer";
import type { ServerSettingsPatch } from "@ryco/contracts";
import {
  CHAT_FOLDER_CLEANUP_DAY_OPTIONS,
  type ChatFolderCleanupAfterDays,
  DEFAULT_CHAT_FOLDER_CLEANUP_AFTER_DAYS,
} from "@ryco/contracts/settings";
import { useState } from "react";

import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { ensureLocalApi } from "../../localApi";
import { applySettingsUpdated, useServerConfig } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { isNodeSettingsTargetReadOnly } from "./settingsSections.logic";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SETTINGS_CONTROL_WIDTH, SettingResetButton, SettingsRow } from "./settingsLayout";

const CHATS_FOLDER_DESCRIPTION =
  "Where chats without a project keep their files, one folder per chat. Use an absolute path or ~/ outside any Git repository; leave empty to use the default. Changing it only affects new chats: existing chats stay where they are.";

const CHAT_FOLDER_CLEANUP_DESCRIPTION =
  "Remove a chat's folder when the chat has been idle this long and the folder is still empty. The chat stays, and its folder comes back as soon as it is needed again. Artifacts are kept elsewhere and never removed.";

/** A node-scoped preference next to "Worktree root". The selected server validates the path. */
export function ChatsFolderSettings() {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const environmentId = target?.environmentId ?? config?.environment.environmentId;
  const disabled = !config || isNodeSettingsTargetReadOnly(scope, target);
  // Remount the editors on node changes so in-flight errors and drafts never cross environments.
  return (
    <>
      <ChatsFolderEditor key={environmentId ?? "disconnected"} disabled={disabled} />
      <ChatFolderCleanupEditor
        key={`cleanup:${environmentId ?? "disconnected"}`}
        disabled={disabled}
      />
    </>
  );
}

/** Saves a node settings patch on the settings target (or the local server). */
function useChatsSettingsSave(errorFallback: string) {
  const target = useSettingsTarget();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(patch: ServerSettingsPatch) {
    setSaving(true);
    setError(null);
    try {
      if (target) await updateEnvironmentServerSettings(target.environmentId, patch);
      else applySettingsUpdated(await ensureLocalApi().server.updateSettings(patch));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : errorFallback);
    } finally {
      setSaving(false);
    }
  }
  return { saving, error, save };
}

/** The status line both chat settings rows share: an error, or "Saving…" while a save runs. */
function SaveStatus({
  saving,
  error,
}: {
  readonly saving: boolean;
  readonly error: string | null;
}) {
  return error ? (
    <span role="alert" className="mt-1 block text-destructive-foreground">
      {error}
    </span>
  ) : saving ? (
    <span role="status" className="mt-1 block">
      Saving…
    </span>
  ) : null;
}

export function ChatsFolderEditor({ disabled }: { readonly disabled: boolean }) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const {
    saving,
    error,
    save: saveSettings,
  } = useChatsSettingsSave("Could not save the chats folder. Try again.");
  const availability = resolveChatsAvailability(config);
  // A node without chat support would ignore the setting entirely.
  const unsupported = !availability.available && availability.reason === "unsupported";
  const blocked = disabled || saving || unsupported;
  const value = config?.settings.chatsRoot ?? "";

  async function save(root: string) {
    if (blocked) return;
    await saveSettings({ chatsRoot: root.trim() });
  }

  return (
    <SettingsRow
      title="Chats folder"
      owner="node"
      scope={target?.nodeLabel ?? "This node"}
      description={CHATS_FOLDER_DESCRIPTION}
      resetAction={
        value ? (
          <SettingResetButton
            label="chats folder"
            tooltip="Reset to default"
            disabled={blocked}
            onClick={() => void save("")}
          />
        ) : null
      }
      status={
        <>
          {availability.available ? (
            <span className="block break-all">
              Effective: {availability.root ?? (value || "Ryco-managed directory")}
            </span>
          ) : (
            <span data-testid="chats-folder-unavailable" className="block">
              Chats unavailable: {availability.message}
            </span>
          )}
          <SaveStatus saving={saving} error={error} />
        </>
      }
      control={
        <DraftInput
          className={SETTINGS_CONTROL_WIDTH.lg}
          value={value}
          disabled={blocked}
          onCommit={(root) => {
            void save(root);
          }}
          placeholder="Ryco-managed directory"
          aria-label="Chats folder directory"
          spellCheck={false}
          autoCapitalize="none"
        />
      }
    />
  );
}

const cleanupLabel = (days: ChatFolderCleanupAfterDays) =>
  days === null ? "Never" : `After ${days} idle ${days === 1 ? "day" : "days"}`;

export function ChatFolderCleanupEditor({ disabled }: { readonly disabled: boolean }) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const { saving, error, save } = useChatsSettingsSave(
    "Could not save empty chat folder cleanup. Try again.",
  );
  const availability = resolveChatsAvailability(config);
  const unsupported = !availability.available && availability.reason === "unsupported";
  // An older node omits the setting; it never removes chat folders.
  const known = config?.settings.chatFolderCleanupAfterDays !== undefined;
  const blocked = disabled || saving || unsupported || !known;
  const value = config?.settings.chatFolderCleanupAfterDays ?? null;

  return (
    <SettingsRow
      title="Remove empty chat folders"
      owner="node"
      scope={target?.nodeLabel ?? "This node"}
      description={CHAT_FOLDER_CLEANUP_DESCRIPTION}
      resetAction={
        known && value !== DEFAULT_CHAT_FOLDER_CLEANUP_AFTER_DAYS ? (
          <SettingResetButton
            label="empty chat folder cleanup"
            tooltip="Reset to default"
            disabled={blocked}
            onClick={() =>
              void save({ chatFolderCleanupAfterDays: DEFAULT_CHAT_FOLDER_CLEANUP_AFTER_DAYS })
            }
          />
        ) : null
      }
      status={<SaveStatus saving={saving} error={error} />}
      control={
        <Select
          value={value?.toString() ?? "never"}
          disabled={blocked}
          onValueChange={(next) => {
            if (blocked) return;
            const days = next === "never" ? null : Number(next);
            if (
              days === null ||
              CHAT_FOLDER_CLEANUP_DAY_OPTIONS.includes(
                days as Exclude<ChatFolderCleanupAfterDays, null>,
              )
            ) {
              void save({ chatFolderCleanupAfterDays: days as ChatFolderCleanupAfterDays });
            }
          }}
        >
          <SelectTrigger
            className={SETTINGS_CONTROL_WIDTH.md}
            aria-label="Remove empty chat folders"
          >
            <SelectValue>{cleanupLabel(value)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {CHAT_FOLDER_CLEANUP_DAY_OPTIONS.map((days) => (
              <SelectItem key={days} hideIndicator value={String(days)}>
                {cleanupLabel(days)}
              </SelectItem>
            ))}
            <SelectItem hideIndicator value="never">
              {cleanupLabel(null)}
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
