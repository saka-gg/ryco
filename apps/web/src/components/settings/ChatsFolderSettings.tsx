import { resolveChatsAvailability } from "@ryco/client-runtime/state/composer";
import type { NodeSettingsConfig } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import type { ServerConfig } from "@ryco/contracts";
import {
  CHAT_FOLDER_CLEANUP_DAY_OPTIONS,
  type ChatFolderCleanupAfterDays,
  DEFAULT_CHAT_FOLDER_CLEANUP_AFTER_DAYS,
} from "@ryco/contracts/settings";

import { useServerConfig } from "../../rpc/serverState";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SETTINGS_CONTROL_WIDTH } from "./settingsLayout";
import { SharedSettingRow, sharedControlLabel } from "./sharedSettings/SharedSettingRow";

const CHATS_FOLDER_DESCRIPTION =
  "Where chats without a project keep their files, one folder per chat. Use an absolute path or ~/ outside any Git repository; leave empty to use the default. Changing it only affects new chats: existing chats stay where they are.";

const CHAT_FOLDER_CLEANUP_DESCRIPTION =
  "Remove a chat's folder when the chat has been idle this long and the folder is still empty. The chat stays, and its folder comes back as soon as it is needed again. Artifacts are kept elsewhere and never removed.";

/** A node without chat support ignores both settings. */
function nodeKeepsChats(config: NodeSettingsConfig): boolean {
  const availability = resolveChatsAvailability(config as Pick<ServerConfig, "chats">);
  return availability.available || availability.reason !== "unsupported";
}

/** An older node omits the cleanup setting; it never removes chat folders. */
function nodeCleansChatFolders(config: NodeSettingsConfig): boolean {
  return nodeKeepsChats(config) && config.settings.chatFolderCleanupAfterDays !== undefined;
}

/** Where the shown device keeps chats now. */
function ChatsFolderAvailability() {
  const config = useServerConfig();
  if (config === null) return null;
  const availability = resolveChatsAvailability(config);
  return availability.available ? (
    <span className="block break-all">
      Effective: {availability.root ?? (config.settings.chatsRoot || "Ryco-managed directory")}
    </span>
  ) : (
    <span data-testid="chats-folder-unavailable" className="block">
      Chats unavailable: {availability.message}
    </span>
  );
}

const cleanupLabel = (days: ChatFolderCleanupAfterDays) =>
  days === null ? "Never" : `After ${days} idle ${days === 1 ? "day" : "days"}`;

/**
 * The chats folder and empty chat folder cleanup, next to "Worktree root": shared across
 * devices, each path validated by the device that keeps it.
 */
export function ChatsFolderSettings() {
  return (
    <>
      <SharedSettingRow
        settingKey="chatsRoot"
        description={CHATS_FOLDER_DESCRIPTION}
        status={<ChatsFolderAvailability />}
        knowsSetting={nodeKeepsChats}
        unknownSettingStatus="This device does not support chats."
        defaultValue=""
        resetLabel="chats folder"
        render={(control) => (
          <DraftInput
            className={SETTINGS_CONTROL_WIDTH.lg}
            value={control.value}
            disabled={control.disabled}
            onCommit={(root) => control.onChange(root.trim())}
            placeholder="Ryco-managed directory"
            aria-label={sharedControlLabel("Chats folder directory", control)}
            spellCheck={false}
            autoCapitalize="none"
          />
        )}
      />
      <SharedSettingRow
        settingKey="chatFolderCleanupAfterDays"
        description={CHAT_FOLDER_CLEANUP_DESCRIPTION}
        knowsSetting={nodeCleansChatFolders}
        unknownSettingStatus="Update this device to remove empty chat folders."
        defaultValue={DEFAULT_CHAT_FOLDER_CLEANUP_AFTER_DAYS}
        resetLabel="empty chat folder cleanup"
        render={(control) => (
          <Select
            value={control.value?.toString() ?? "never"}
            disabled={control.disabled}
            onValueChange={(next) => {
              if (control.disabled) return;
              const days = next === "never" ? null : Number(next);
              if (
                days === null ||
                CHAT_FOLDER_CLEANUP_DAY_OPTIONS.includes(
                  days as Exclude<ChatFolderCleanupAfterDays, null>,
                )
              ) {
                control.onChange(days as ChatFolderCleanupAfterDays);
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className={SETTINGS_CONTROL_WIDTH.md}
              aria-label={sharedControlLabel("Remove empty chat folders", control)}
            >
              <SelectValue>{cleanupLabel(control.value)}</SelectValue>
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
        )}
      />
    </>
  );
}
