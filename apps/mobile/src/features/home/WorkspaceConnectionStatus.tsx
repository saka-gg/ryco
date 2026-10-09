import { ActivityIndicator, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useWorkspaceState } from "../../state/useWorkspaceState";
import {
  shouldShowWorkspaceConnectionStatus,
  workspaceConnectionStatusLabel,
} from "./workspace-connection-status";

// Recovery preserves the workspace. Show availability without recurring retry alerts.
export function WorkspaceConnectionStatus() {
  const workspace = useWorkspaceState();
  if (!shouldShowWorkspaceConnectionStatus(workspace)) return null;

  const label = workspaceConnectionStatusLabel(workspace);
  const isBusy =
    !workspace.hasLoadedShellSnapshot &&
    (workspace.hasConnectingEnvironment || workspace.hasPendingShellSnapshot);

  return (
    <View className="mx-4 my-2 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
      {isBusy ? <ActivityIndicator size="small" /> : null}
      <Text className="flex-1 font-sans text-sm text-foreground-muted">{label}</Text>
    </View>
  );
}
