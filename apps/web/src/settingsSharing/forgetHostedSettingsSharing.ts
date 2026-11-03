import { clearSettingsSharingNamespace } from "@ryco/client-runtime/state/settings/settingsSharingClock";

/**
 * Forgets a Hub account's shared-settings cache and clock in this browser (its sign-out, or
 * another account taking over): the cache holds values of that account's nodes in plain
 * `localStorage`. Part of the hosted account-scoped reset, with the hosted read cache; the
 * namespace matches `readSettingsSharingNamespace`. Small and static: the hosted coordinator
 * calls it.
 */
export function forgetHostedSettingsSharing(input: {
  readonly hubOrigin: string;
  readonly accountId: string;
}): void {
  try {
    clearSettingsSharingNamespace(window.localStorage, {
      kind: "hosted",
      hubOrigin: input.hubOrigin,
      accountId: input.accountId,
    });
  } catch {
    // Storage disabled: nothing was kept.
  }
}
