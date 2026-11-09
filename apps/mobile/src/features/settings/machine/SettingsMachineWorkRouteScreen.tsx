import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import {
  CHAT_FOLDER_CLEANUP_DAY_OPTIONS,
  DEFAULT_RESPONSE_STREAMING_MODE,
  GIT_REF_NAME_PATTERN,
  type ChatFolderCleanupAfterDays,
  type GitWritingStyle,
  type ResponseStreamingMode,
} from "@ryco/contracts/settings";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SettingsRow } from "../components/SettingsRow";
import { SettingsSection } from "../components/SettingsSection";
import { SettingsSwitchRow } from "../components/SettingsSwitchRow";
import { ChoiceSettingRow, TextSettingRow } from "./MachineSettingRows";
import { useMachineSettings } from "./useMachineSettings";

type SettingsMachineWorkRouteScreenProps = StaticScreenProps<{ readonly environmentId: string }>;

const GIT_WRITING_INSTRUCTIONS_MAX_LENGTH = 4_000;

const STREAMING_OPTIONS: ReadonlyArray<{
  readonly value: ResponseStreamingMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "paragraph",
    label: "Paragraphs",
    description: "Each paragraph or code block appears once it is finished.",
  },
  {
    value: "turn",
    label: "Whole messages",
    description: "Each message appears once the agent has finished writing it.",
  },
  {
    value: "token",
    label: "Token by token",
    description: "Text appears token by token. Slower, and long replies are harder to follow.",
  },
];

const WRITING_STYLE_OPTIONS: ReadonlyArray<{
  readonly value: GitWritingStyle;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "default", label: "Standard", description: "Ryco's own concise style." },
  {
    value: "repository",
    label: "Like the repository",
    description: "Follows the repository's recent commits.",
  },
  {
    value: "conventional",
    label: "Conventional Commits",
    description: "type(scope): summary.",
  },
];

type CleanupChoice = "never" | `${(typeof CHAT_FOLDER_CLEANUP_DAY_OPTIONS)[number]}`;

const CLEANUP_OPTIONS: ReadonlyArray<{ readonly value: CleanupChoice; readonly label: string }> = [
  ...CHAT_FOLDER_CLEANUP_DAY_OPTIONS.map((days) => ({
    value: `${days}` as CleanupChoice,
    label: days === 1 ? "After 1 day" : `After ${days} days`,
  })),
  { value: "never", label: "Never" },
];

function cleanupChoice(days: ChatFolderCleanupAfterDays): CleanupChoice {
  return days === null ? "never" : (`${days}` as CleanupChoice);
}

function cleanupDays(choice: CleanupChoice): ChatFolderCleanupAfterDays {
  return choice === "never" ? null : (Number(choice) as ChatFolderCleanupAfterDays);
}

function usagePriceCount(count: number): string {
  return count === 0 ? "Provider prices" : count === 1 ? "1 custom" : `${count} custom`;
}

function branchPrefixProblem(value: string): string | null {
  if (value.length > 128) return "At most 128 characters.";
  return GIT_REF_NAME_PATTERN.test(value) ? null : "Not a valid Git branch name.";
}

/**
 * One machine's work defaults: where chats and worktrees go, how commits and pull requests
 * are written, how replies stream to every client, and what happens at a usage limit. These
 * are shared settings: an edit here is this machine's value, like the desktop's row.
 */
export function SettingsMachineWorkRouteScreen(props: SettingsMachineWorkRouteScreenProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const machine = useMachineSettings(environmentId);
  const settings = machine.config?.settings ?? null;
  const capabilities = machine.config?.environment.capabilities ?? null;
  if (settings === null) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" className="flex-1 bg-screen">
        <SettingsSection>
          <SettingsRow
            first
            label={machine.connected ? "Loading settings…" : "Not connected"}
            detail={machine.connected ? undefined : "Connect this machine to see its settings."}
          />
        </SettingsSection>
      </ScrollView>
    );
  }
  const off = !machine.editable;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 48 }}
    >
      {machine.readOnlyReason ? (
        <Text className="px-6 pt-3 text-xs text-foreground-muted">{machine.readOnlyReason}</Text>
      ) : null}
      {machine.error ? (
        <Text className="px-6 pt-3 text-xs text-danger-foreground">{machine.error}</Text>
      ) : null}

      <SettingsSection
        title="Chats"
        footer="Chats without a project get a folder here. Empty folders are removed after the time you pick and come back when a chat needs one."
      >
        <TextSettingRow
          first
          label="Chats folder"
          value={settings.chatsRoot}
          emptyLabel="Default"
          placeholder="~/Ryco Chats"
          disabled={off}
          onSave={(value) => machine.writeShared("chatsRoot", value)}
        />
        <ChoiceSettingRow<CleanupChoice>
          label="Remove empty folders"
          value={cleanupChoice(settings.chatFolderCleanupAfterDays)}
          options={CLEANUP_OPTIONS}
          disabled={off}
          onPick={(choice) =>
            void machine.writeShared("chatFolderCleanupAfterDays", cleanupDays(choice))
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Worktrees"
        footer="Where new worktrees are created and how their branches are named. Existing checkouts keep their paths."
      >
        <TextSettingRow
          first
          label="Worktree root"
          value={settings.worktreeRoot}
          emptyLabel="Default"
          placeholder="~/ryco-worktrees"
          disabled={off}
          onSave={(value) => machine.writeShared("worktreeRoot", value)}
        />
        <TextSettingRow
          label="Branch prefix"
          value={settings.worktreeBranchPrefix}
          emptyLabel="None"
          placeholder="ryco"
          disabled={off}
          validate={branchPrefixProblem}
          onSave={(value) => machine.writeShared("worktreeBranchPrefix", value)}
        />
        <SettingsSwitchRow
          label="Change type in branch names"
          detail="Names branches like ryco/fix/… or ryco/feat/…."
          value={settings.worktreeBranchChangeTypes}
          disabled={off}
          onValueChange={(value) => void machine.writeShared("worktreeBranchChangeTypes", value)}
        />
      </SettingsSection>

      <SettingsSection
        title="Commits & pull requests"
        footer="Instructions are added to the prompt whenever a commit message or pull request text is generated, and take precedence over the style."
      >
        {capabilities?.gitWritingStyle === true ? (
          <ChoiceSettingRow<GitWritingStyle>
            first
            label="Writing style"
            value={settings.gitWritingStyle}
            options={WRITING_STYLE_OPTIONS}
            disabled={off}
            onPick={(style) => void machine.writeShared("gitWritingStyle", style)}
          />
        ) : null}
        <TextSettingRow
          first={capabilities?.gitWritingStyle !== true}
          label="Commit messages"
          value={settings.commitMessageInstructions}
          emptyLabel="No instructions"
          placeholder="e.g. Describe what changed, not file by file."
          multiline
          maxLength={GIT_WRITING_INSTRUCTIONS_MAX_LENGTH}
          disabled={off}
          onSave={(value) => machine.writeShared("commitMessageInstructions", value)}
        />
        <TextSettingRow
          label="Pull requests"
          value={settings.pullRequestInstructions}
          emptyLabel="No instructions"
          placeholder="e.g. Plain language; add Before / After for UI changes."
          multiline
          maxLength={GIT_WRITING_INSTRUCTIONS_MAX_LENGTH}
          disabled={off}
          onSave={(value) => machine.writeShared("pullRequestInstructions", value)}
        />
        {capabilities?.changeRequestTemplates === true ? (
          <SettingsSwitchRow
            label="Pull request templates"
            detail="Fill generated descriptions from the repository's template."
            value={settings.pullRequestTemplates}
            disabled={off}
            onValueChange={(value) => void machine.writeShared("pullRequestTemplates", value)}
          />
        ) : null}
      </SettingsSection>

      {capabilities?.responseStreamingModes === true ? (
        <SettingsSection
          title="Responses"
          footer="How assistant text reaches every app while a reply streams."
        >
          <ChoiceSettingRow<ResponseStreamingMode>
            first
            label="Show replies"
            value={settings.responseStreamingMode ?? DEFAULT_RESPONSE_STREAMING_MODE}
            options={STREAMING_OPTIONS}
            disabled={off}
            onPick={(mode) => void machine.writeShared("responseStreamingMode", mode)}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Usage limits"
        footer="Limits apply to the whole provider account. Every resumed thread re-reads its conversation, which on long Claude threads rebuilds the prompt cache at full input cost."
      >
        <SettingsSwitchRow
          first
          label="Resume after the limit resets"
          detail="Sends “Continue where you left off.” at the reported reset time."
          value={settings.autoResumeLimitedThreads}
          disabled={off}
          onValueChange={(value) => void machine.writeShared("autoResumeLimitedThreads", value)}
        />
        <SettingsSwitchRow
          label="Snooze limited threads"
          detail="Hides a stopped thread until the reset time."
          value={settings.snoozeLimitedThreads}
          disabled={off}
          onValueChange={(value) => void machine.writeShared("snoozeLimitedThreads", value)}
        />
        {capabilities?.usagePriceOverrides === true ? (
          <SettingsRow
            label="Usage prices"
            value={usagePriceCount(Object.keys(settings.usagePriceOverrides).length)}
            onPress={() => navigation.navigate("SettingsMachineUsagePrices", { environmentId })}
          />
        ) : null}
      </SettingsSection>
      <View className="h-2" />
    </ScrollView>
  );
}
