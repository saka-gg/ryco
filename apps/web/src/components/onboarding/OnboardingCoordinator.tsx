import { useCallback, useEffect, useState } from "react";
import type { EnvironmentId } from "@ryco/contracts";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import {
  getClientSettings,
  useClientSettingsHydrated,
  useSettings,
  useUpdateSettings,
} from "../../hooks/useSettings";
import { notifySurfaceLoadFailure } from "../ui/surfaceLoadFailure";
import { preloadableLazy, useLazyComponentReady } from "../../lib/preloadableLazy";
import { useServerConfig } from "../../rpc/serverState";
import { useWsConnectionStatusForEnvironment } from "../../rpc/wsConnectionState";
import { selectEnvironmentState, useStore } from "../../store";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { isLocalOnboardingClient } from "./localOnboarding";
import {
  addCompletedEnvironment,
  resolveOnboardingGate,
  useOnboardingReplayStore,
} from "./onboardingState";

// Loads when the gate first shows it and mounts once loaded, so it never
// commits a Suspense fallback or waits on React's 300 ms reveal throttle.
const OnboardingDialog = preloadableLazy(() =>
  import("./OnboardingDialog").then((module) => module.OnboardingDialog),
);

export function OnboardingCoordinator() {
  const environmentId = usePrimaryEnvironmentId();
  const tier = usePresentationTier();
  if (!environmentId || tier === "phone" || !isLocalOnboardingClient()) return null;
  return <LocalOnboardingSession key={environmentId} environmentId={environmentId} />;
}

function LocalOnboardingSession({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useServerConfig();
  const connection = useWsConnectionStatusForEnvironment(environmentId);
  const shellReady = useStore((state) => {
    const environment = selectEnvironmentState(state, environmentId);
    return environment.bootstrapComplete && environment.hydratedFromCacheAt === undefined;
  });
  const projectCount = useStore(
    (state) => selectEnvironmentState(state, environmentId).projectIds.length,
  );
  const settingsOpen = useSettingsDialogStore((state) => state.open);
  const paletteOpen = useCommandPaletteStore((state) => state.open);
  const replayRequest = useOnboardingReplayStore((state) => state.requestedFor);
  const [active, setActive] = useState(false);
  const settingsHydrated = useClientSettingsHydrated();
  const completedEnvironments = useSettings(
    (settings) => settings.localOnboardingCompletedEnvironmentIds,
  );
  const { updateSettings } = useUpdateSettings();
  const complete = useCallback(() => {
    updateSettings({
      localOnboardingCompletedEnvironmentIds: addCompletedEnvironment(
        getClientSettings().localOnboardingCompletedEnvironmentIds,
        environmentId,
      ),
    });
  }, [environmentId, updateSettings]);
  const ready =
    settingsHydrated && config !== null && shellReady && connection.phase === "connected";
  const dialogReady = useLazyComponentReady(OnboardingDialog, active, {
    onLoadError: (error, retry) => notifySurfaceLoadFailure("setup guide", error, retry),
  });

  useEffect(() => {
    if (active) {
      if (replayRequest) useOnboardingReplayStore.getState().consume();
      return;
    }
    if (!ready) return;
    if (replayRequest) {
      useOnboardingReplayStore.getState().consume();
      if (replayRequest === environmentId) {
        setActive(true);
        return;
      }
    }
    const gate = resolveOnboardingGate({
      eligible: true,
      ready,
      projectCount,
      completed: completedEnvironments?.includes(environmentId) ?? false,
    });
    if (gate === "existing") complete();
    if (gate === "show") setActive(true);
  }, [active, complete, completedEnvironments, environmentId, projectCount, ready, replayRequest]);

  if (!active || !config || !dialogReady) return null;
  return (
    <OnboardingDialog
      environmentId={environmentId}
      providers={config.providers}
      projectCount={projectCount}
      ready={ready}
      connectionGeneration={connection.connectedAt}
      open={!settingsOpen && !paletteOpen}
      onComplete={() => {
        complete();
        setActive(false);
      }}
    />
  );
}
