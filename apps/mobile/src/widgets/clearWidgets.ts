import { rycoWidgetsNative, type RycoWidgetsNativeModule } from "./rycoWidgetsNative";
import { WIDGET_KINDS } from "./widgetKinds";

/**
 * Empties every widget the app writes. The sign-in screen calls it (`LockedWidgetsBridge`): an
 * account that signed out, or lost its last machine, while Ryco was closed left its last timeline
 * in the App Group, and the workspace's own bridge never mounts on a locked launch.
 */
export async function clearWidgets(
  native: Pick<RycoWidgetsNativeModule, "clear"> | null = rycoWidgetsNative(),
): Promise<void> {
  if (native === null) return;
  await Promise.all(WIDGET_KINDS.map((kind) => native.clear(kind)));
}
