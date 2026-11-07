import * as Linking from "expo-linking";
import { Platform } from "react-native";

/**
 * The URL that launched the app, if any.
 *
 * On iOS the scene delegate starts React Native without launch options and
 * hands a launch URL (a deep link, or a quick action as one) to the app
 * delegate before JS listens (plugins/withIosSceneLifecycle.cjs). React
 * Native's own initial URL is then empty; expo-linking's registry holds it.
 * `consume` clears that registry entry, so a navigator that mounts again
 * later cannot replay a link it already opened.
 */
export async function readLaunchURL(options: {
  readonly consume: boolean;
}): Promise<string | null> {
  const initial = await Linking.getInitialURL();
  if (initial !== null) return initial;
  if (Platform.OS !== "ios") return null;
  const registered = Linking.getLinkingURL();
  if (registered !== null && options.consume) Linking.clearInitialURL();
  return registered;
}

/** A link that arrived while running has been handled: it must not count as a launch URL later. */
export function forgetReceivedURL(): void {
  if (Platform.OS === "ios") Linking.clearInitialURL();
}
