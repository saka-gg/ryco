import { MonitorSmartphoneIcon, PaletteIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import type { ComponentProps, ReactElement } from "react";

import { usePresentationTier } from "../../hooks/usePresentationTier";
import {
  HUB_ACCOUNT_SECTION_TITLES,
  navigateHub,
  type HubAccountSection,
} from "../../hostedHub/hubRoutes";
import {
  preloadableLazy,
  useLazyComponentReady,
  usePreloadWhenIdle,
  type PreloadableModule,
} from "../../lib/preloadableLazy";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { HubPage, HubPanel } from "./shell/HubPage";
import { HubNavLinks, HubUserMenu } from "./shell/HubNav";
import { HubShell } from "./shell/HubShell";
import { setHostedReadCacheEnabled, useHostedReadCache } from "../../hostedHub/readCache";
import { Checkbox } from "../ui/checkbox";
import { HostedPwaControls } from "./HostedPwaControls";
import type * as AppearanceSettingsModule from "../settings/AppearanceSettings";

// Both panels are large and neither is on the Hub's first paint. They render
// synchronously once loaded (a `React.lazy` boundary held the skeleton for
// React's 300 ms Suspense reveal throttle), and load on the rail's intent or
// once the account page is idle (where speculative downloads are allowed).
const AccountSettingsPanel = preloadableLazy(() =>
  import("../settings/AccountSettings").then((module) => module.AccountSettingsPanel),
);
const AppearanceSettingsPanel = preloadableLazy<
  NonNullable<ComponentProps<typeof AppearanceSettingsModule.AppearanceSettingsPanel>>
>(() => import("../settings/AppearanceSettings").then((module) => module.AppearanceSettingsPanel));

const SECTION_PANELS: Record<HubAccountSection, PreloadableModule> = {
  overview: AccountSettingsPanel,
  security: AccountSettingsPanel,
  devices: AccountSettingsPanel,
  appearance: AppearanceSettingsPanel,
};

const ACCOUNT_GROUPS = {
  overview: "profile",
  security: "security",
  devices: "devices",
} as const;

const SECTION_DESCRIPTIONS: Record<HubAccountSection, string> = {
  overview: "Your username and email on this Hub.",
  security: "Passkeys, password, two-factor authentication and recovery.",
  devices: "Browsers and apps signed in to your account.",
  appearance: "Saved in this browser. Your other apps and devices keep their own appearance.",
};

function preloadSectionPanel(section: HubAccountSection): void {
  void SECTION_PANELS[section].preload();
}

const SECTIONS: readonly {
  readonly id: HubAccountSection;
  readonly icon: typeof UserRoundIcon;
}[] = [
  { id: "overview", icon: UserRoundIcon },
  { id: "security", icon: ShieldCheckIcon },
  { id: "devices", icon: MonitorSmartphoneIcon },
  { id: "appearance", icon: PaletteIcon },
];

/**
 * The Hub's account pages.
 *
 * These used to be one tab of the node app's settings dialog — the same modal
 * the desktop client opens for provider configuration, MCP servers and
 * keybindings — reached through a global `openSettings("account")` singleton. A
 * hosted user with no node saw exactly two tabs of a thirteen-tab IDE
 * preferences surface, in a dialog with no URL, no page title and no back
 * button.
 *
 * They are pages now, with an in-page rail rather than a modal rail. That is
 * the single change that most makes account management read as part of a site
 * instead of as a preferences dialog borrowed from another product.
 */
export function HubAccountPage({ section }: { readonly section: HubAccountSection }) {
  // The desktop workspace has no connection menu, so installing or updating the
  // app lives here. The phone tier keeps it in its connection sheet.
  const isPhoneTier = usePresentationTier() === "phone";
  usePreloadWhenIdle(AccountSettingsPanel, true);
  usePreloadWhenIdle(AppearanceSettingsPanel, true);

  return (
    <HubShell measure="page" nav={<HubNavLinks current="account" />} trailing={<HubUserMenu />}>
      <HubPage
        title={HUB_ACCOUNT_SECTION_TITLES[section]}
        description={SECTION_DESCRIPTIONS[section]}
      >
        <div className="flex flex-col gap-6 sm:flex-row sm:gap-10">
          {/* An in-page rail of links, not a dialog's icon rail. */}
          <nav aria-label="Account" className="shrink-0 sm:w-52">
            <ul className="flex gap-1 overflow-x-auto sm:sticky sm:top-0 sm:flex-col sm:overflow-visible">
              {SECTIONS.map((entry) => {
                const current = entry.id === section;
                return (
                  <li key={entry.id}>
                    <Button
                      variant={current ? "secondary" : "ghost"}
                      aria-current={current ? "page" : undefined}
                      className="w-full justify-start whitespace-nowrap"
                      onClick={() => navigateHub({ kind: "account", section: entry.id })}
                      onPointerEnter={() => preloadSectionPanel(entry.id)}
                      onFocus={() => preloadSectionPanel(entry.id)}
                    >
                      <entry.icon aria-hidden />
                      {HUB_ACCOUNT_SECTION_TITLES[entry.id]}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="min-w-0 flex-1">
            {section === "appearance" ? (
              <LoadedSectionPanel panel={AppearanceSettingsPanel}>
                {/* The Hub-relevant subset. Composer controls and panel layout
                    are node-workspace concepts with no meaning on a site that
                    may not have a node at all, and stay in the node app's own
                    settings, reachable from inside a node session. */}
                {() => <AppearanceSettingsPanel surface="hub" />}
              </LoadedSectionPanel>
            ) : (
              <div className="space-y-6">
                <LoadedSectionPanel panel={AccountSettingsPanel}>
                  {() => <AccountSettingsPanel group={ACCOUNT_GROUPS[section]} />}
                </LoadedSectionPanel>
                {section === "devices" ? (
                  <>
                    <RememberBrowserPanel />
                    {isPhoneTier ? null : <HostedPwaControls />}
                  </>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </HubPage>
    </HubShell>
  );
}

/**
 * A section panel once its chunk has loaded; the skeleton until then, as an
 * ordinary commit. A failed load mounts the panel, which reports the error.
 */
function LoadedSectionPanel(props: {
  readonly panel: PreloadableModule;
  readonly children: () => ReactElement;
}) {
  const ready = useLazyComponentReady(props.panel, true);
  return ready ? props.children() : <Skeleton className="h-64 w-full rounded-2xl" />;
}

function RememberBrowserPanel() {
  const cache = useHostedReadCache();
  return (
    <HubPanel
      title="Instant reopening"
      description="Keep recent conversations and text drafts in this browser so you can read and type while your devices reconnect."
    >
      <label className="flex items-center gap-3 text-sm">
        <Checkbox
          checked={cache.enabled}
          onCheckedChange={(checked) => {
            void setHostedReadCacheEnabled(checked === true);
          }}
        />
        Remember this browser
      </label>
      <p className="mt-3 text-xs text-muted-foreground">
        Cloud history stores recent conversation text on the Hub for quick access across devices.
        This setting adds a separate offline copy in this browser.
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        Only text is saved; draft attachments need to be added again. Anyone with access to this
        browser profile can read the saved copy, including offline. Sending work still requires a
        fresh connection. Turning this off or signing out removes the browser copy.
      </p>
    </HubPanel>
  );
}
