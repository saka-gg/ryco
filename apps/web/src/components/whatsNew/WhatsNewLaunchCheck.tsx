import { resolveWhatsNewLaunch, selectReleasesBetween } from "@ryco/shared/releaseVersion";
import { useEffect, useRef } from "react";

import { APP_VERSION } from "../../branding";
import {
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import { scheduleIdleTask } from "../../lib/idleTask";
import { getPresentationTier } from "../../lib/presentationTier";
import { openWhatsNewDialog } from "./whatsNewDialogStore";

/** How long after boot the check may wait for an idle moment. */
const WHATS_NEW_IDLE_TIMEOUT_MS = 3_000;

/**
 * The first time the app starts after an update, opens What's new with the
 * releases since the version this device last saw. A fresh install only
 * records its version. Runs once per launch, after client settings load, at
 * an idle moment; the release notes load only when there is something to show.
 */
export function WhatsNewLaunchCheck() {
  const hydrated = useClientSettingsHydrated();
  const checked = useRef(false);
  useEffect(() => {
    if (!hydrated || checked.current) return;
    return scheduleIdleTask(() => {
      checked.current = true;
      runWhatsNewLaunchCheck();
    }, WHATS_NEW_IDLE_TIMEOUT_MS);
  }, [hydrated]);
  return null;
}

/** Outside the component: React Compiler does not lower `import()` expressions. */
function runWhatsNewLaunchCheck(): void {
  const settings = getClientSettings();
  const decision = resolveWhatsNewLaunch({
    currentVersion: APP_VERSION,
    lastSeenVersion: settings.lastSeenReleaseNotesVersion,
    showAfterUpdate: settings.whatsNewAfterUpdate,
  });
  if (decision.kind === "none") return;
  if (decision.kind === "show") {
    void import("@ryco/shared/releaseNotes")
      .then(({ CHANGELOG_RELEASES }) => {
        const releases = selectReleasesBetween(CHANGELOG_RELEASES, {
          sinceVersion: decision.sinceVersion,
          currentVersion: APP_VERSION,
        });
        // A release without notes (a quick fix) moves the marker on quietly. The
        // frozen web phone tier only records: the native app is the phone surface.
        if (releases.length > 0 && getPresentationTier() !== "phone") {
          openWhatsNewDialog({ sinceVersion: decision.sinceVersion });
        }
        recordSeenVersion();
      })
      // Not recorded: the next launch tries again.
      .catch((error: unknown) => console.warn("Loading the release notes failed.", error));
    return;
  }
  recordSeenVersion();
}

/** Remembered as soon as the dialog opens, so a launch never shows the same notes twice. */
function recordSeenVersion(): void {
  void persistClientSettingsUpdate({ lastSeenReleaseNotesVersion: APP_VERSION }).catch(
    (error: unknown) => console.warn("Saving the seen release notes version failed.", error),
  );
}
