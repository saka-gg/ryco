import {
  ArrowLeftIcon,
  LogOutIcon,
  PaletteIcon,
  ShieldCheckIcon,
  UserRoundIcon,
} from "lucide-react";
import type { ComponentProps, ReactElement } from "react";

import { usePresentationTier } from "../../hooks/usePresentationTier";
import { navigateHub, type HubAccountSection } from "../../hostedHub/hubRoutes";
import { hostedHubController, useHostedHubStore } from "../../hostedHub/state";
import {
  preloadableLazy,
  useLazyComponentReady,
  usePreloadWhenIdle,
  type PreloadableModule,
} from "../../lib/preloadableLazy";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { HubPage, HubPanel } from "./shell/HubPage";
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

const SECTION_PANELS: Partial<Record<HubAccountSection, PreloadableModule>> = {
  security: AccountSettingsPanel,
  appearance: AppearanceSettingsPanel,
};

function preloadSectionPanel(section: HubAccountSection): void {
  void SECTION_PANELS[section]?.preload();
}

const SECTIONS: readonly {
  readonly id: HubAccountSection;
  readonly label: string;
  readonly icon: typeof UserRoundIcon;
}[] = [
  { id: "overview", label: "Overview", icon: UserRoundIcon },
  { id: "security", label: "Security", icon: ShieldCheckIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
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
  const account = useHostedHubStore((state) => state.account);
  // The desktop workspace has no connection menu, so the account's own
  // actions — signing out, installing or updating the app — live here, behind
  // the sidebar's Account entry. The phone tier keeps them in its connection
  // sheet and this page as it was.
  const accountActions = usePresentationTier() !== "phone";
  usePreloadWhenIdle(AccountSettingsPanel, true);
  usePreloadWhenIdle(AppearanceSettingsPanel, true);

  return (
    <HubShell
      measure="page"
      trailing={
        <>
          <Button variant="ghost" onClick={() => navigateHub({ kind: "nodes" })}>
            <ArrowLeftIcon aria-hidden /> Nodes
          </Button>
          {accountActions ? (
            <Button variant="ghost" onClick={() => void hostedHubController.signOut()}>
              <LogOutIcon aria-hidden /> Sign out
            </Button>
          ) : null}
        </>
      }
    >
      <HubPage
        title={section === "appearance" ? "Browser appearance" : "Account"}
        description={
          section === "appearance"
            ? "Saved in this browser. Your other apps and devices keep their own appearance."
            : account === null
              ? undefined
              : `${account.displayName} · ${account.role.charAt(0).toUpperCase()}${account.role.slice(1)}`
        }
      >
        <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
          {/* An in-page rail of links, not a dialog's icon rail. */}
          <nav aria-label="Account" className="shrink-0 sm:w-48">
            <ul className="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
              {SECTIONS.map((entry) => {
                const current = entry.id === section;
                return (
                  <li key={entry.id}>
                    <Button
                      variant={current ? "secondary" : "ghost"}
                      aria-current={current ? "page" : undefined}
                      className="w-full justify-start"
                      onClick={() => navigateHub({ kind: "account", section: entry.id })}
                      onPointerEnter={() => preloadSectionPanel(entry.id)}
                      onFocus={() => preloadSectionPanel(entry.id)}
                    >
                      <entry.icon aria-hidden />
                      {entry.label}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="min-w-0 flex-1">
            {section === "overview" ? (
              <div className="space-y-6">
                <HubAccountOverview />
                <RememberBrowserPanel />
                {accountActions ? <HostedPwaControls /> : null}
              </div>
            ) : section === "security" ? (
              <LoadedSectionPanel panel={AccountSettingsPanel}>
                {() => <AccountSettingsPanel />}
              </LoadedSectionPanel>
            ) : (
              <LoadedSectionPanel panel={AppearanceSettingsPanel}>
                {/* The Hub-relevant subset. Composer controls and panel layout
                    are node-workspace concepts with no meaning on a site that
                    may not have a node at all, and stay in the node app's own
                    settings, reachable from inside a node session. */}
                {() => <AppearanceSettingsPanel surface="hub" />}
              </LoadedSectionPanel>
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

function HubAccountOverview() {
  const account = useHostedHubStore((state) => state.account);

  return (
    <HubPanel title="Your account" description="Identity this Hub knows you by.">
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground text-xs">Display name</dt>
          <dd className="mt-0.5 text-sm">{account?.displayName ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Role</dt>
          <dd className="mt-0.5 text-sm">
            {account === null
              ? "—"
              : `${account.role.charAt(0).toUpperCase()}${account.role.slice(1)}`}
          </dd>
        </div>
      </dl>
      {/*
       * Deliberately not shown: username, active space, and the list of spaces
       * this account belongs to. `GET /api/auth/session` projects only
       * `{ id, displayName, role, createdAt, disabledAt }`, so the client cannot
       * render them after a reload without the Hub extending that projection.
       * Inventing placeholders here would be worse than the gap.
       */}
    </HubPanel>
  );
}
