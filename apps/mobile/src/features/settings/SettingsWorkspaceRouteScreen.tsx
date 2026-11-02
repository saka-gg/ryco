import {
  isClaudeResumeReviewEnabled,
  updatePreferences,
  useIsPreferencesHydrated,
  usePreferences,
} from "../../state/preferencesStore";
import { NodeNewTaskDefaults } from "./NodeNewTaskDefaults";
import { NodeStorageSettings } from "./NodeStorageSettings";
import { NodeUpdatesSettings } from "./updates/NodeUpdatesSettings";
import { useNavigation } from "@react-navigation/native";
import { ScrollView } from "react-native";

import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { openMachinesFromSettings } from "./openMachinesFromSettings";

export function SettingsWorkspaceRouteScreen() {
  const navigation = useNavigation();
  const preferences = usePreferences();
  const preferencesHydrated = useIsPreferencesHydrated();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
    >
      <SettingsSection title="Context">
        <SettingsRow
          first
          label="Preferred machine"
          value="Last ready"
          onPress={() => openMachinesFromSettings(navigation)}
        />
        <SettingsRow label="Project and worktree" value="Current context" />
      </SettingsSection>

      <NodeStorageSettings />
      <NodeUpdatesSettings />
      {/* Runtime mode is execution authority: chosen per task, never a default edited here. */}
      <NodeNewTaskDefaults />

      {/* Device-local. Shown once preferences load: a switch flipped before then would
          save over the preferences this device already keeps. */}
      {preferencesHydrated ? (
        <SettingsSection title="Sending">
          <SettingsSwitchRow
            first
            label="Review large Claude resumes"
            detail="Before a send resumes a large Claude conversation that sat idle, ask whether to continue with full context or compact it first. Applies to this device."
            value={isClaudeResumeReviewEnabled(preferences)}
            onValueChange={(claudeResumeReview) => updatePreferences({ claudeResumeReview })}
          />
        </SettingsSection>
      ) : null}
    </ScrollView>
  );
}
