import { useNavigate } from "@tanstack/react-router";
import { useEffect, type ReactElement } from "react";

import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { SettingsPage } from "../settings/SettingsPage";

/** The `/settings` route body, loaded by the route file through `lazyRouteComponent`. */
export function SettingsRoute(): ReactElement | null {
  const navigate = useNavigate();
  const phoneTier = usePresentationTier() === "phone";
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
  return <SettingsPage />;
}
