import {
  WORKTREE_SUBMODULE_OPTIONS,
  selectWorktreeSubmodules,
} from "@ryco/shared/worktreeSubmodules";
import { useStore } from "../../state/threadsRuntime";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { NodeStorageSettings } from "./NodeStorageSettings";
import { useNavigation } from "@react-navigation/native";
import { ScrollView } from "react-native";

import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { openMachinesFromSettings } from "./openMachinesFromSettings";

export function SettingsWorkspaceRouteScreen() {
  const navigation = useNavigation();
  const environmentId = useStore((state) => state.activeEnvironmentId);
  const configs = useEnvironmentServerConfigs();
  const config = environmentId ? configs.get(environmentId) : undefined;
  const supported = config?.environment.capabilities.worktreeSubmoduleSettings === true;
  const settings = supported ? config?.settings : undefined;
  const submoduleMode = settings ? selectWorktreeSubmodules({ settings }).mode : undefined;

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

      <SettingsSection title="New tasks">
        <SettingsRow first label="Provider and model" value="Project default" />
        <SettingsRow label="Runtime mode" value="Thread default" />
        <SettingsRow
          label="Worktree submodules"
          value={
            WORKTREE_SUBMODULE_OPTIONS.find((option) => option.value === submoduleMode)?.label ??
            (config ? "Update this machine" : "Connect a machine")
          }
          detail={
            config && !supported
              ? "This node does not support configurable submodules."
              : "Node default. New worktrees also honor project overrides and repository configuration."
          }
        />
      </SettingsSection>
    </ScrollView>
  );
}
