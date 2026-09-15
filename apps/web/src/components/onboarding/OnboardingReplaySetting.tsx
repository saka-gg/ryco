import { usePrimaryEnvironmentId } from "../../environments/primary";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { useSettingsEditingScope } from "../../settingsTarget";
import { Button } from "../ui/button";
import { SettingsRow } from "../settings/settingsLayout";
import { isLocalOnboardingClient } from "./localOnboarding";
import { useOnboardingReplayStore } from "./onboardingState";

export function OnboardingReplaySetting() {
  const environmentId = usePrimaryEnvironmentId();
  const tier = usePresentationTier();
  const scope = useSettingsEditingScope();
  if (tier === "phone" || scope === "node" || !isLocalOnboardingClient()) return null;
  return (
    <SettingsRow
      title="Welcome tour"
      description="Replay provider setup, add a project, and learn the essentials."
      owner="client"
      control={
        <Button
          variant="outline"
          disabled={!environmentId}
          onClick={() => {
            if (!environmentId) return;
            useOnboardingReplayStore.getState().replay(environmentId);
            useSettingsDialogStore.getState().closeSettings();
          }}
        >
          Open welcome tour
        </Button>
      }
    />
  );
}
