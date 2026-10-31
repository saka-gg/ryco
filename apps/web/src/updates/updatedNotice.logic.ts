import type { DesktopUpdateState } from "@ryco/contracts";

/** localStorage key: the version whose "Updated to" notice was shown. */
export const UPDATED_NOTICE_SHOWN_KEY = "ryco:desktop-updated-notice";

export interface UpdatedNoticeView {
  readonly version: string;
  readonly title: string;
  readonly description: string;
}

/**
 * The "Updated to X" notice on the first launch after an update this app installed, or `null`:
 * when nothing was installed, or the notice for this version was shown already (`shownVersion`).
 */
export function selectUpdatedNotice(
  state: Pick<DesktopUpdateState, "currentVersion" | "updatedFromVersion"> | null,
  shownVersion: string | null,
): UpdatedNoticeView | null {
  const fromVersion = state?.updatedFromVersion ?? null;
  if (state === null || fromVersion === null || fromVersion === state.currentVersion) return null;
  if (shownVersion === state.currentVersion) return null;
  return {
    version: state.currentVersion,
    title: `Updated to ${state.currentVersion}`,
    description: `Ryco was on ${fromVersion} before.`,
  };
}
