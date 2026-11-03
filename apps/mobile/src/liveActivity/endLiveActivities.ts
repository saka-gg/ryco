import { rycoWidgetsNative, type RycoWidgetsNativeModule } from "../widgets/rycoWidgetsNative";

/**
 * Ends every Ryco card at once, also one still showing its results. The sign-in screen calls it
 * once the switch was ever on (`LockedLiveActivityBridge`): a sign-out while Ryco was closed would
 * otherwise leave task titles on the Lock Screen until iOS removes the card.
 */
export async function endLiveActivities(
  native: Pick<RycoWidgetsNativeModule, "dismissAgentActivities"> | null = rycoWidgetsNative(),
): Promise<void> {
  if (native === null) return;
  await native.dismissAgentActivities(false);
}
