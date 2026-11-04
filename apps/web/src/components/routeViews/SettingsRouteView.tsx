import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, type ReactElement } from "react";

import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { SettingsPage } from "../settings/SettingsPage";
import {
  parseSettingsLocationSearch,
  type SettingsLocationSearch,
} from "../settings/settingsRegistry";
import { SETTINGS_ROUTE_PATH } from "../../settingsRoute";

/** The `/settings` route body, loaded by the route file through `lazyRouteComponent`. */
export function SettingsRoute(): ReactElement | null {
  const navigate = useNavigate();
  const phoneTier = usePresentationTier() === "phone";
  const search = parseSettingsLocationSearch(useSearch({ strict: false }));
  // Moves within settings replace the entry, so Back still leaves settings.
  const replace = useCallback(
    (next: SettingsLocationSearch) =>
      void navigate({ to: SETTINGS_ROUTE_PATH, search: next, replace: true }),
    [navigate],
  );
  // Reached by URL, Back, or Forward rather than through `openSettings`.
  useEffect(() => {
    const state = useSettingsDialogStore.getState();
    if (!state.open) state.markOpen();
  }, []);
  // A rotation into the phone tier hands the open section to the phone sheet,
  // which presents over the home stack rather than over this page.
  useEffect(() => {
    if (phoneTier) void navigate({ to: "/", replace: true });
  }, [navigate, phoneTier]);
  if (phoneTier) return null;
  return <SettingsPage location={{ search, replace }} />;
}
