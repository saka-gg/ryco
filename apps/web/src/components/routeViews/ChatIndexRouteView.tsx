import { getRouteApi } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";
import { Suspense } from "react";

import { NoActiveThreadState } from "../NoActiveThreadState";
import { Button } from "../ui/button";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { useSavedEnvironmentRegistryStore } from "../../environments/runtime";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { preloadableLazy } from "../../lib/preloadableLazy";
import { APP_DISPLAY_NAME } from "~/branding";

// The frozen phone tier's Home. The route loader preloads it on that tier so
// it renders on the first pass; the Suspense boundary below only covers a
// rotation into the phone tier after the route already loaded.
const PhoneHome = preloadableLazy(() =>
  import("../shell/phone/PhoneHome").then((module) => module.PhoneHome),
);

export function preloadPhoneHome(): Promise<void> {
  return PhoneHome.preload();
}

const chatIndexRouteApi = getRouteApi("/_chat/");

export function ChatIndexRoute() {
  const { authGateState } = chatIndexRouteApi.useRouteContext();
  const presentationTier = usePresentationTier();
  const savedEnvironmentCount = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length,
  );

  if (authGateState.status === "hosted-static" && savedEnvironmentCount === 0) {
    return <HostedStaticOnboardingState />;
  }

  // The phone tier lands on Home (the project-grouped thread list); desktop
  // keeps the empty no-active-thread surface and its last-thread redirect.
  if (presentationTier === "phone") {
    return (
      <Suspense fallback={null}>
        <PhoneHome />
      </Suspense>
    );
  }

  return <NoActiveThreadState />;
}

function HostedStaticOnboardingState() {
  const openSettings = useSettingsDialogStore((s) => s.openSettings);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect an environment to get started
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                Open a pairing link from your Ryco desktop app or add a reachable backend manually.
                Your saved environments stay in this browser.
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button size="sm" onClick={() => openSettings("connections")}>
                  <PlusIcon className="size-4" />
                  Add environment
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
