import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { ErrorBanner } from "../../components/ErrorBanner";
import {
  buildHubDomainResetPlan,
  clearMobileHubProfile,
  createHubProfile,
  executeHubDomainResetPlan,
  hydrateMobileHubProfile,
  readCachedMobileHubProfile,
  saveMobileHubProfile,
  type HubProfile,
} from "../../hostedHub/hubProfile";
import {
  ensureMobileHostedSession,
  hostedHubController,
  hostedHubStore,
  isMobileHostedModeAvailable,
} from "../../hostedHub/state";
import { invalidateMobileHostedRuntime } from "../../hostedHub/runtime";
import { isMobileDevelopmentBuild, readMobileHostedConfig } from "../../platform/config";
import { mobileE2eeTrustStore } from "../../platform/e2eeTrustStore";
import {
  openHostedSignInPreview,
  resolveHostedSignInPreviewUrl,
} from "../../platform/hostedSignInPreview";
import { mobileKV } from "../../platform/kv";
import { clearMobileHostedSessionToken } from "../../platform/sessionCredentials";
import { useHostedModeAvailable } from "../hostedHub/useHostedMode";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { HubDomainEditor } from "./HubDomainEditor";

function compatibilityLabel(profile: HubProfile | null, usesBuildDefault: boolean): string {
  if (profile?.compatibility.status === "compatible") return "Compatible";
  if (profile?.compatibility.status === "incompatible") return "Needs attention";
  return usesBuildDefault ? "Build configured" : "Not checked";
}

function accountLabel(profile: HubProfile | null, hostedAvailable: boolean): string | undefined {
  if (profile === null) return "Not configured";
  return hostedAvailable ? undefined : "Unavailable";
}

export function SettingsHubRouteScreen() {
  const navigation = useNavigation();
  const hostedAvailable = useHostedModeAvailable();
  const buildConfig = useMemo(readMobileHostedConfig, []);
  const development = isMobileDevelopmentBuild();
  const [storedProfile, setStoredProfile] = useState<HubProfile | null>(
    () => readCachedMobileHubProfile() ?? null,
  );
  const [editorVisible, setEditorVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildProfile = useMemo(
    () =>
      buildConfig
        ? createHubProfile({
            origin: buildConfig.hubOrigin,
            label: "Ryco Hub",
            allowInsecure: development,
          })
        : null,
    [buildConfig, development],
  );
  const profile = storedProfile ?? buildProfile;
  const previewUrl = resolveHostedSignInPreviewUrl({
    developmentBuild: development,
    hostedModeAvailable: hostedAvailable,
    profile,
  });
  useEffect(() => {
    let active = true;
    void hydrateMobileHubProfile(mobileKV).then((next) => {
      if (active) setStoredProfile(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const persistReplacement = async (nextProfile: HubProfile | null) => {
    if (nextProfile) await saveMobileHubProfile(mobileKV, nextProfile);
    else await clearMobileHubProfile(mobileKV);
    setStoredProfile(nextProfile);
    invalidateMobileHostedRuntime();
    void ensureMobileHostedSession();
  };

  const openSignInPreview = async () => {
    if (previewUrl === null || previewBusy) return;
    setPreviewBusy(true);
    setError(null);
    try {
      await openHostedSignInPreview(previewUrl);
    } catch {
      setError("Ryco could not open the Hub sign-in preview.");
    } finally {
      setPreviewBusy(false);
    }
  };

  const replaceProfile = (nextProfile: HubProfile | null) => {
    const plan = buildHubDomainResetPlan(profile?.origin ?? null, nextProfile?.origin ?? null);
    const run = async () => {
      setBusy(true);
      setError(null);
      try {
        if (!plan) {
          await persistReplacement(nextProfile);
        } else {
          await executeHubDomainResetPlan(plan, {
            attemptRemoteSignOut: async () => {
              if (
                !isMobileHostedModeAvailable() ||
                hostedHubStore.getState().accountStatus !== "authenticated"
              ) {
                return;
              }
              await hostedHubController.signOut();
              if (hostedHubStore.getState().accountStatus === "authenticated") {
                throw new Error("remote sign-out unavailable");
              }
            },
            clearLocalHubState: async () => {
              if (
                isMobileHostedModeAvailable() &&
                hostedHubStore.getState().accountStatus !== "signed-out"
              ) {
                await hostedHubController.expireSession();
              }
              // The origin is about to change. Clear the native token even when
              // the old Hub was unreachable and its controller could not run.
              await clearMobileHostedSessionToken();
              // And the §13 trust state recorded under the origin being left:
              // pins, latches, owner legacy consents, the strict-legacy policy,
              // and the `anyNodeVerified` marker. There is no generic secret-wipe
              // path this could ride on, so the registration is by hand, and
              // `plan.fromOrigin` is the origin the records were taken under —
              // `profile` has not been replaced yet at this point.
              if (plan.fromOrigin !== null) {
                await mobileE2eeTrustStore.forgetHubOrigin(plan.fromOrigin);
              }
            },
            replaceProfile: () => persistReplacement(nextProfile),
          });
        }
        setEditorVisible(false);
      } catch {
        setError("Ryco could not change the Hub safely. The current profile remains active.");
      } finally {
        setBusy(false);
      }
    };

    if (!plan) {
      void run();
      return;
    }
    showConfirmDialog({
      title: plan.confirmation.title,
      message: plan.confirmation.message,
      confirmText: plan.confirmation.confirmText,
      destructive: true,
      onConfirm: () => void run(),
    });
  };

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
      >
        {error ? (
          <View className="mx-5 mt-4">
            <ErrorBanner message={error} />
          </View>
        ) : null}

        <SettingsSection title="Hub">
          <SettingsRow
            first
            label="Domain"
            value={profile?.origin ?? "Not configured"}
            disabled={busy}
            onPress={() => setEditorVisible(true)}
          />
          <SettingsRow
            label="Compatibility"
            value={compatibilityLabel(profile, storedProfile === null && buildConfig !== null)}
          />
        </SettingsSection>

        <SettingsSection title="Account and security">
          <SettingsRow
            first
            label="Account"
            value={accountLabel(profile, hostedAvailable)}
            disabled={!hostedAvailable || busy || previewBusy}
            onPress={() => navigation.navigate("SettingsAccount" as never)}
          />
          {previewUrl ? (
            <SettingsRow
              label="Preview Hub sign-in"
              value={previewBusy ? "Opening…" : "Simulator"}
              disabled={busy || previewBusy}
              onPress={() => void openSignInPreview()}
            />
          ) : null}
        </SettingsSection>

        {profile?.compatibility.status === "compatible" && !hostedAvailable ? (
          <Text className="mt-2 px-5 font-sans text-xs leading-relaxed text-foreground-muted">
            This Hub is compatible, but this device could not create the hardware-backed key its
            session requires. Direct nodes keep working.
            {previewUrl
              ? " The preview opens an isolated browser so you can test the passkey QR code; it cannot connect Hub nodes in the Simulator."
              : ""}
          </Text>
        ) : null}
      </ScrollView>

      <HubDomainEditor
        visible={editorVisible}
        currentProfile={profile}
        buildOrigin={buildConfig?.hubOrigin ?? null}
        allowInsecure={development}
        onDismiss={() => setEditorVisible(false)}
        onSave={replaceProfile}
        onUseBuildDefault={storedProfile && buildConfig ? () => replaceProfile(null) : null}
      />
    </>
  );
}
