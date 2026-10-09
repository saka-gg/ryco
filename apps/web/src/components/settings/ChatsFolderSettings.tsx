import { resolveChatsAvailability } from "@ryco/client-runtime/state/composer";
import type { ServerSettingsPatch } from "@ryco/contracts";
import { useState } from "react";

import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { ensureLocalApi } from "../../localApi";
import { applySettingsUpdated, useServerConfig } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { DraftInput } from "../ui/draft-input";
import { SETTINGS_CONTROL_WIDTH, SettingResetButton, SettingsRow } from "./settingsLayout";

const CHATS_FOLDER_DESCRIPTION =
  "Where chats without a project keep their files, one folder per chat. Use an absolute path or ~/ outside any Git repository; leave empty to use the default. Changing it only affects new chats: existing chats stay where they are.";

/** A node-scoped preference next to "Worktree root". The selected server validates the path. */
export function ChatsFolderSettings() {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const environmentId = target?.environmentId ?? config?.environment.environmentId;
  // Remount the editor on node changes so in-flight errors and drafts never cross environments.
  return (
    <ChatsFolderEditor
      key={environmentId ?? "disconnected"}
      disabled={
        scope === "client" ||
        !config ||
        (scope === "node" && !target) ||
        Boolean(
          target && (!target.connected || target.canManage === false || target.canMutate === false),
        )
      }
    />
  );
}

export function ChatsFolderEditor({ disabled }: { readonly disabled: boolean }) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availability = resolveChatsAvailability(config);
  // A node without chat support would ignore the setting entirely.
  const unsupported = !availability.available && availability.reason === "unsupported";
  const blocked = disabled || saving || unsupported;
  const value = config?.settings.chatsRoot ?? "";

  async function save(root: string) {
    if (blocked) return;
    setSaving(true);
    setError(null);
    const patch: ServerSettingsPatch = { chatsRoot: root.trim() };
    try {
      if (target) await updateEnvironmentServerSettings(target.environmentId, patch);
      else applySettingsUpdated(await ensureLocalApi().server.updateSettings(patch));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save the chats folder. Try again.",
      );
    } finally {
      setSaving(false);
    }
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
          {error ? (
            <span role="alert" className="mt-1 block text-destructive-foreground">
              {error}
            </span>
          ) : saving ? (
            <span role="status" className="mt-1 block">
              Saving…
            </span>
          ) : null}
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
