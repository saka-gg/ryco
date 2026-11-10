import {
  ChevronDownIcon,
  LogOutIcon,
  MonitorSmartphoneIcon,
  PaletteIcon,
  ShieldCheckIcon,
  UserRoundIcon,
} from "lucide-react";
import { useEffect } from "react";

import { cn } from "~/lib/utils";
import { refreshAccountProfile, useAccountIdentity } from "../../../hostedHub/accountProfile";
import {
  HUB_ACCOUNT_SECTION_TITLES,
  navigateHub,
  type HubAccountSection,
} from "../../../hostedHub/hubRoutes";
import { hostedHubController } from "../../../hostedHub/state";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";

export type HubDestination = "nodes" | "account";

const DESTINATIONS: readonly { readonly id: HubDestination; readonly label: string }[] = [
  { id: "nodes", label: "Nodes" },
  { id: "account", label: "Account" },
];

const ACCOUNT_MENU: readonly {
  readonly section: HubAccountSection;
  readonly icon: typeof UserRoundIcon;
}[] = [
  { section: "overview", icon: UserRoundIcon },
  { section: "security", icon: ShieldCheckIcon },
  { section: "devices", icon: MonitorSmartphoneIcon },
  { section: "appearance", icon: PaletteIcon },
];

/**
 * The Hub's two destinations, as links in the top bar.
 *
 * Every signed-in Hub page shows the same pair in the same place, so moving
 * between the machines and the account never depends on which page happens to
 * carry a back button.
 */
export function HubNavLinks({ current }: { readonly current: HubDestination }) {
  return (
    <ul className="ml-3 flex items-center gap-1">
      {DESTINATIONS.map((destination) => {
        const active = destination.id === current;
        return (
          <li key={destination.id}>
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() =>
                navigateHub(
                  destination.id === "nodes"
                    ? { kind: "nodes" }
                    : { kind: "account", section: "overview" },
                )
              }
              className={cn(
                "rounded-lg px-3 py-1.5 font-medium text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {destination.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The round letter that stands for the account wherever it is named. */
export function HubAvatar({
  initial,
  className,
}: {
  readonly initial: string;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/12 font-semibold text-primary text-xs",
        className,
      )}
    >
      {initial}
    </span>
  );
}

/**
 * Who is signed in, and everything that belongs to them: the account pages and
 * signing out.
 */
export function HubUserMenu() {
  const identity = useAccountIdentity();
  useEffect(() => {
    void refreshAccountProfile();
  }, []);

  return (
    <Menu>
      <MenuTrigger
        aria-label={`Account menu for ${identity.handle}`}
        className="flex max-w-56 items-center gap-2 rounded-full py-1 pr-2 pl-1 text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent/60"
      >
        <HubAvatar initial={identity.initial} />
        <span className="min-w-0 truncate font-medium">{identity.handle}</span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        <MenuGroup>
          {ACCOUNT_MENU.map((entry) => (
            <MenuItem
              key={entry.section}
              onClick={() => navigateHub({ kind: "account", section: entry.section })}
            >
              <entry.icon aria-hidden />
              {HUB_ACCOUNT_SECTION_TITLES[entry.section]}
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => void hostedHubController.signOut()}>
          <LogOutIcon aria-hidden />
          Sign out
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
