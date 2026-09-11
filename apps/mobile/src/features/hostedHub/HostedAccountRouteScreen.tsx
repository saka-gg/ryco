import { readMobileDeviceLabel } from "../../platform/config";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import {
  hostedAccountStore,
  hostedHubController,
  hostedHubStore,
  useHostedAccountStore,
  useHostedHubStore,
} from "../../hostedHub/state";
import { useMobileE2eeChannelStatus } from "../e2ee/useMobileE2eeSession";
import { useMobileNativeE2eeEnrollmentStatus } from "../e2ee/useMobileNativeE2eeEnrollment";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  deriveHostedAccountManagementView,
  leaseHostedRecoveryCodeDisplay,
  type HostedAccountPromptDraft,
} from "./hostedAccountModel";
import { HostedAccountPrompt } from "./HostedAccountPrompt";
import { deriveHostedAccountView, type HostedAccountRow } from "./hostedAuthModel";
import { HostedPasskeyList } from "./HostedPasskeyList";
import { HostedRecoveryCodes } from "./HostedRecoveryCodes";
import {
  HostedCapabilityNotice,
  HostedDeliveryUnknownNotice,
  HostedPrimaryButton,
  HostedStatusRow,
} from "./HostedSurfaceParts";
import { useHostedModeAvailable } from "./useHostedMode";

/**
 * The hosted account surface, nested inside the Settings sheet.
 *
 * Reachable only when hosted mode is available — `SettingsRouteScreen` does not
 * render its row otherwise, and this screen still fails closed on its own so a
 * deep link cannot land on a hosted surface a direct-only build cannot serve.
 *
 * Every credential action below is a native, DPoP-bound controller call.
 * Nothing on this screen opens a browser: `/api/account/*` authorizes an
 * `Authorization: DPoP` request without a same-origin check. Signed-out users
 * enter the same full-screen native identity blocker used at startup.
 */
export function HostedAccountRouteScreen() {
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const hostedModeAvailable = useHostedModeAvailable();
  const state = useHostedHubStore((value) => value);
  // §12.2 / §2.2: the connection pill names §4.4's locked mode.
  const e2eeStatus = useMobileE2eeChannelStatus(state.selectedNode?.environmentId ?? null);
  const nativeDeviceSecurityStatus = useMobileNativeE2eeEnrollmentStatus();
  const accountState = useHostedAccountStore((value) => value);
  const [draft, setDraftState] = useState<HostedAccountPromptDraft | null>(null);
  // The ref is the *live* draft and the state is the rendered one. A submit
  // settles long after the render that started it, and the fence it checks
  // itself against — is this still the same prompt, is this still the live
  // attempt — has to see a close or a newly opened prompt the instant it
  // happens, not one commit later.
  const draftRef = useRef<HostedAccountPromptDraft | null>(null);
  const setDraft = useCallback((next: HostedAccountPromptDraft | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const signedIn = state.accountStatus === "authenticated";

  // Reads, not mutations: both calls deduplicate, no-op while signed out, and
  // touch no credentials. Regenerating recovery codes deliberately has no
  // equivalent here — that rotates, so it only ever runs from an explicit,
  // confirmed submit.
  useEffect(() => {
    if (!hostedModeAvailable || !signedIn) return;
    void hostedHubController.refreshPasskeys();
    void hostedHubController.refreshAccountSecurity();
    void hostedHubController.refreshExternalIdentityConfiguration();
  }, [hostedModeAvailable, signedIn]);

  // This screen displays the account's one-time recovery codes, and saying so
  // is the whole of its involvement in their lifetime. The runtime publishes a
  // rotation's result only if a lease was live when the user asked for it, so
  // without this the "Generate new codes" row would rotate the codes and then
  // be unable to show them. Releasing the lease destroys nothing — leaving the
  // screen is not the user saying they have written the codes down, and the
  // rotation has by then already killed the set they had. Both secrets go away
  // on their own acknowledgements, or with the account.
  useEffect(() => leaseHostedRecoveryCodeDisplay(hostedHubController), []);

  const view = deriveHostedAccountView({
    state,
    hostedModeAvailable,
    e2eeStatus,
    nativeDeviceSecurityStatus,
    onSignIn: () => navigation.navigate("Access"),
    actionStatus: accountState.actionStatus,
  });

  const management = deriveHostedAccountManagementView({
    state,
    accountState,
    draft,
    actions: hostedHubController,
    // Read through the store rather than the subscribed snapshot: a submit
    // needs the state as it is *after* its own action settled, and the value
    // captured at render time is by definition the one from before. The same
    // goes for the session it was issued on and for the prompt it belongs to.
    readAccountState: () => hostedAccountStore.getState(),
    readHubState: () => hostedHubStore.getState(),
    readDraft: () => draftRef.current,
    onDraftChange: setDraft,
  });

  const runRow = (row: HostedAccountRow) => {
    if (!row.confirm) {
      row.run();
      return;
    }
    showConfirmDialog({
      title: row.confirm.title,
      message: row.confirm.message,
      confirmText: row.confirm.confirmText,
      destructive: row.confirm.destructive,
      onConfirm: row.run,
    });
  };

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingVertical: 12, paddingBottom: 40 }}
      >
        {!view.available ? (
          <View className="px-5 py-16">
            <EmptyState variant="plain" title={view.title} detail={view.detail} />
          </View>
        ) : (
          <>
            <View className="px-5 pb-1 pt-2">
              <Text className="text-2xl font-ryco-bold text-foreground">{view.title}</Text>
              <Text className="mt-2 font-sans text-sm leading-relaxed text-foreground-muted">
                {view.detail}
              </Text>
              {view.statusIndicator ? (
                <View className="mt-3.5">
                  <HostedStatusRow indicator={view.statusIndicator} roleLabel={view.roleLabel} />
                </View>
              ) : null}
            </View>

            {view.errorMessage && isFocused ? (
              <View className="mx-5 mt-4">
                <ErrorBanner message={view.errorMessage} />
              </View>
            ) : null}

            {management.errorMessage ? (
              <View className="mx-5 mt-4">
                <ErrorBanner message={management.errorMessage} />
              </View>
            ) : null}

            {management.securityMessage ? (
              <View className="mx-5 mt-4 rounded-2xl border border-border bg-card px-4 py-3">
                <Text className="font-sans text-xs leading-relaxed text-foreground-muted">
                  {management.securityMessage}
                </Text>
              </View>
            ) : null}

            {management.securityRetry ? (
              <SettingsSection title="Account security">
                <SettingsRow
                  first
                  label={management.securityRetry.label}
                  disabled={management.securityRetry.disabled}
                  onPress={management.securityRetry.run}
                />
              </SettingsSection>
            ) : null}

            {management.externalIdentityMessage ? (
              <View className="mx-5 mt-4 rounded-2xl border border-border bg-card px-4 py-3">
                <Text className="font-sans text-xs leading-relaxed text-foreground-muted">
                  {management.externalIdentityMessage}
                </Text>
              </View>
            ) : null}

            {management.externalIdentityRetry ? (
              <SettingsSection title="Connected accounts">
                <SettingsRow
                  first
                  label={management.externalIdentityRetry.label}
                  disabled={management.externalIdentityRetry.disabled}
                  onPress={management.externalIdentityRetry.run}
                />
              </SettingsSection>
            ) : null}

            {view.deliveryUnknown ? (
              <HostedDeliveryUnknownNotice view={view.deliveryUnknown} />
            ) : null}

            {view.capabilityNotice ? (
              <HostedCapabilityNotice reason={view.capabilityNotice} />
            ) : null}

            <HostedRecoveryCodes codes={view.recoveryCodes} />
            {view.dismissRecoveryCodes ? (
              <HostedPrimaryButton action={view.dismissRecoveryCodes} />
            ) : null}

            {view.signInAction ? <HostedPrimaryButton action={view.signInAction} /> : null}

            {management.available
              ? management.sections.map((section) => (
                  <View key={section.id}>
                    <SettingsSection title={section.title}>
                      {section.status !== null ? (
                        <SettingsRow first label="Status" value={section.status} />
                      ) : null}
                      {section.id === "passkeys" ? (
                        <HostedPasskeyList
                          rows={management.passkeyRows}
                          emptyDetail={management.passkeysEmptyDetail}
                        />
                      ) : null}
                      {section.rows.map((row, index) => (
                        <SettingsRow
                          key={row.id}
                          // The passkey list occupies the top of its own card,
                          // so the action beneath it always keeps a separator.
                          first={
                            section.status === null && section.id !== "passkeys" && index === 0
                          }
                          label={row.label}
                          destructive={row.destructive}
                          disabled={row.disabled}
                          onPress={row.run}
                        />
                      ))}
                    </SettingsSection>
                    <Text className="mt-2 px-5 font-sans text-xs leading-relaxed text-foreground-muted">
                      {section.footnote}
                    </Text>
                  </View>
                ))
              : null}

            {view.rows.length > 0 ? (
              <SettingsSection title={readMobileDeviceLabel()}>
                {view.rows.map((row, index) => (
                  <SettingsRow
                    key={row.id}
                    first={index === 0}
                    label={row.label}
                    {...(row.value === null ? {} : { value: row.value })}
                    destructive={row.destructive}
                    onPress={() => runRow(row)}
                  />
                ))}
              </SettingsSection>
            ) : null}
          </>
        )}
      </ScrollView>

      <HostedAccountPrompt view={management.prompt} />
    </>
  );
}
