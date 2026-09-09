import { ArrowLeftIcon, PaletteIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { navigateHub, type HubAccountSection } from "../../hostedHub/hubRoutes";
import { useHostedHubStore } from "../../hostedHub/state";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { HubPage, HubPanel } from "./shell/HubPage";
import { HubShell } from "./shell/HubShell";

// Both panels are large and neither is on the Hub's first paint.
const AccountSettingsPanel = lazy(() =>
  import("../settings/AccountSettings").then((module) => ({
    default: module.AccountSettingsPanel,
  })),
);
const AppearanceSettingsPanel = lazy(() =>
  import("../settings/AppearanceSettings").then((module) => ({
    default: module.AppearanceSettingsPanel,
  })),
);

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

  return (
    <HubShell
      measure="page"
      trailing={
        <Button variant="ghost" onClick={() => navigateHub({ kind: "nodes" })}>
          <ArrowLeftIcon aria-hidden /> Nodes
        </Button>
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
              <HubAccountOverview />
            ) : (
              <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
                {section === "security" ? (
                  <AccountSettingsPanel />
                ) : (
                  // The Hub-relevant subset. Composer controls and panel layout
                  // are node-workspace concepts with no meaning on a site that
                  // may not have a node at all, and stay in the node app's own
                  // settings, reachable from inside a node session.
                  <AppearanceSettingsPanel surface="hub" />
                )}
              </Suspense>
            )}
          </div>
        </div>
      </HubPage>
    </HubShell>
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
