export type AppAccess =
  | { readonly status: "hydrating" }
  | { readonly status: "locked" }
  | {
      readonly status: "unlocked";
      readonly via: "hosted-session" | "direct-node" | "both";
    };

export interface AppAccessFacts {
  /**
   * The hosted plane has decided: its launch session check settled, or the
   * launch decision deadline passed while it was still waiting on the network.
   */
  readonly hostedHydrated: boolean;
  readonly hostedSessionRevalidated: boolean;
  /**
   * This device holds a Hub sign-in the Hub confirmed recently and has not
   * ended since, and the saved workspace has been read from storage
   * (`hostedHub/retainedSessionAccess.ts`). Optional: absent means no.
   */
  readonly hostedSessionRetained?: boolean;
  readonly directHydrated: boolean;
  readonly directCredentialReadable: boolean;
}

/**
 * The one startup authority projection. Profiles, onboarding preferences, and
 * partially completed ceremonies are deliberately not inputs: none of them
 * proves that this device can enter the workspace. A stored Hub credential by
 * itself is not one either; only a retained sign-in is, which also needs the
 * Hub's recent confirmation of that session.
 *
 * Either plane unlocks on its own affirmative answer, without waiting for the
 * other to finish: a revalidated Hub session is published before the directory
 * read that follows it, a retained Hub sign-in opens the saved workspace
 * before the Hub has answered at all (and while it cannot be reached), and a
 * readable direct credential needs no Hub at all. None of these answers grants
 * mutation authority by itself: that still requires a revalidated session, a
 * ready directory or a live connection, and a fresh shell snapshot. The other
 * plane joining later only upgrades `via`. `locked` is the one verdict that
 * needs both planes, because it is the absence of any grant.
 */
export function deriveAppAccess(facts: AppAccessFacts): AppAccess {
  const hosted = facts.hostedSessionRevalidated || facts.hostedSessionRetained === true;
  const direct = facts.directHydrated && facts.directCredentialReadable;
  if (hosted && direct) return { status: "unlocked", via: "both" };
  if (hosted) return { status: "unlocked", via: "hosted-session" };
  if (direct) return { status: "unlocked", via: "direct-node" };
  if (!facts.hostedHydrated || !facts.directHydrated) return { status: "hydrating" };
  return { status: "locked" };
}

/** Only workspace destinations are deferred; auth/reset/direct links stay in the blocker. */
export function isWorkspaceDeepLink(value: string): boolean {
  try {
    const url = new URL(value);
    const path =
      `${url.protocol === "http:" || url.protocol === "https:" ? "" : url.hostname}${url.pathname}`
        .replace(/^\/+/, "")
        .toLocaleLowerCase();
    return (
      path.startsWith("threads/") ||
      path.startsWith("projects/") ||
      path === "tasks/new" ||
      // The main tabs (`mainTabsModel.ts`) and Search.
      path === "tasks" ||
      path === "pull-requests" ||
      path === "usage" ||
      path === "search" ||
      path === "settings" ||
      path.startsWith("settings/")
    );
  } catch {
    return false;
  }
}
