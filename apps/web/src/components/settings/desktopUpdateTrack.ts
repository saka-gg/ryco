import type { DesktopUpdateState } from "@ryco/contracts";
import { isNightlyVersion } from "@ryco/shared/desktopFlavor";

/**
 * What the About section says about the update track. Ryco follows stable releases and Ryco
 * Nightly follows nightlies; they are separate apps with separate data, so there is no switch.
 * A stable app still running a nightly version is the in-place nightly Ryco Nightly replaces:
 * it now waits for the next stable release, which installs over it as an ordinary update.
 */
export function describeDesktopUpdateTrack(
  state: Pick<DesktopUpdateState, "channel" | "currentVersion">,
): { readonly label: string; readonly description: string } {
  if (state.channel === "nightly") {
    return {
      label: "Nightly",
      description:
        "Ryco Nightly follows nightly builds. It is its own app with its own data, so Ryco keeps your stable workspace untouched.",
    };
  }
  if (isNightlyVersion(state.currentVersion)) {
    return {
      label: "Stable",
      description:
        "Nightly builds now come as a separate app, Ryco Nightly. This copy moves to the next stable release when it is out.",
    };
  }
  return {
    label: "Stable",
    description:
      "Ryco follows stable releases. Nightly builds come as a separate app, Ryco Nightly, with its own data.",
  };
}
