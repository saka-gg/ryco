import type { SettingsSharingNamespace } from "@ryco/client-runtime/state/settings/settingsSharingClock";

/**
 * Whose devices the phone's sharing state serves: the signed-in Hub account at its Hub, else the
 * phone's own (direct) connections. Another account gets its own client id, clock and cache, so
 * a cache never crosses accounts.
 */
export function mobileSettingsSharingNamespace(
  state: {
    readonly accountStatus: string;
    readonly account?: { readonly id: string } | null | undefined;
  },
  hubOrigin: string | undefined,
): SettingsSharingNamespace {
  const accountId = state.accountStatus === "authenticated" ? state.account?.id : undefined;
  return accountId !== undefined && accountId.length > 0 && hubOrigin !== undefined
    ? { kind: "hosted", hubOrigin, accountId }
    : { kind: "local" };
}
