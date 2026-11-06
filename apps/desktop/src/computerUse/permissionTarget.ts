import { resolveMacAppBundle } from "../macAppBundle.ts";

/** The app bundle macOS gives Computer Use's privacy grants to, as System Settings lists it. */
export interface ComputerUsePermissionTarget {
  /** The exact bundle setup registers and guides; absent outside an app bundle (dev launchers). */
  readonly bundlePath: string | undefined;
  readonly bundleId: string;
  /** The name System Settings shows for it. */
  readonly displayName: string;
}

/**
 * The one place that decides which bundle receives Computer Use's macOS grants. Today that is
 * the running Ryco app. A separate signed helper app (planned) only changes this function.
 */
export function resolveComputerUsePermissionTarget(input: {
  readonly executablePath: string;
  readonly platform: NodeJS.Platform;
  readonly appName: string;
}): ComputerUsePermissionTarget {
  const { bundlePath, bundleId } = resolveMacAppBundle(input.executablePath, input.platform);
  return { bundlePath, bundleId, displayName: input.appName };
}
