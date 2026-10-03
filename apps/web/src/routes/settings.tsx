import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { usePresentationTier } from "../hooks/usePresentationTier";
import { getPresentationTier } from "../lib/presentationTier";
import { useSettingsDialogStore } from "../settingsDialogStore";

const LazySettingsPage = lazy(() =>
  import("../components/settings/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);

function SettingsRouteView() {
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
  return (
    <Suspense
      fallback={
        <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground" />
      }
    >
      <LazySettingsPage />
    </Suspense>
  );
}

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static" &&
      context.authGateState.status !== "hosted-hub"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    // The frozen phone tier presents settings as its own full-screen sheet over
    // the home stack, so the page itself never renders there.
    if (getPresentationTier() === "phone") {
      useSettingsDialogStore.getState().markOpen();
      throw redirect({ to: "/", replace: true });
    }
  },
  component: SettingsRouteView,
});
