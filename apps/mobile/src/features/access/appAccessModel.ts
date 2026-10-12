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
  readonly directHydrated: boolean;
  readonly directCredentialReadable: boolean;
}

/**
 * The one startup authority projection. Profiles, stored-token presence,
 * onboarding preferences, and partially completed ceremonies are deliberately
 * not inputs: none of them proves that this device can enter the workspace.
 *
 * Either plane unlocks on its own affirmative answer, without waiting for the
 * other to finish: a revalidated Hub session is published before the directory
 * read that follows it, and a readable direct credential needs no Hub at all.
 * Neither answer grants mutation authority by itself — that still requires a
 * ready directory or a live connection and a fresh shell snapshot. The other
 * plane joining later only upgrades `via`. `locked` is the one verdict that
 * needs both planes, because it is the absence of any grant.
 */
export function deriveAppAccess(facts: AppAccessFacts): AppAccess {
  const hosted = facts.hostedSessionRevalidated;
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
      path === "settings" ||
      path.startsWith("settings/")
    );
  } catch {
    return false;
  }
}
