import type {
  HostedAccountProfile,
  HostedAccountSession,
} from "@ryco/client-runtime/authorization";
import { create } from "zustand";

import { isHostedHubMode } from "../env";
import { useHostedHubStore } from "./state";

/**
 * The signed-in account's profile and its live sign-ins.
 *
 * Kept beside, not inside, the runtime's account store: both reads are plain
 * re-fetchable projections with no secret material and no step-up, so they do
 * not need the single-flight action fence the credential mutations run behind.
 *
 * `"unsupported"` is a Hub that does not serve the route. The surfaces treat it
 * as "this Hub has no such page", never as a failure.
 */
export type AccountReadStatus = "idle" | "loading" | "ready" | "unsupported" | "error";

export interface AccountProfileState {
  /** The account the cached reads belong to; a different account discards them. */
  readonly accountId: string | null;
  readonly profile: HostedAccountProfile | null;
  readonly profileStatus: AccountReadStatus;
  readonly sessions: ReadonlyArray<HostedAccountSession>;
  readonly sessionsStatus: AccountReadStatus;
}

export const EMPTY_ACCOUNT_PROFILE_STATE: AccountProfileState = {
  accountId: null,
  profile: null,
  profileStatus: "idle",
  sessions: [],
  sessionsStatus: "idle",
};

export const useAccountProfileStore = create<AccountProfileState>(
  () => EMPTY_ACCOUNT_PROFILE_STATE,
);

/**
 * Read the profile from shared chrome.
 *
 * The read itself lives in `./accountProfile` beside the Hub API client, which
 * a standard build must not bundle. Hosted builds already hold that module, so
 * the import resolves from memory; a standard build never reaches it.
 */
export function loadAccountProfile(): void {
  if (!isHostedHubMode()) return;
  void import("./accountProfile").then((module) => module.refreshAccountProfile());
}

/** Machine-assigned names from before usernames existed. */
const LEGACY_USERNAME_PATTERN = /^legacy_[a-z2-7]+$/;

export interface AccountIdentity {
  /** What to call the account in chrome: `@name`, or the old display name. */
  readonly handle: string;
  /** The letter an avatar shows. */
  readonly initial: string;
  /** `true` while the account still needs to pick a username. */
  readonly needsUsername: boolean;
}

export function accountIdentity(
  profile: HostedAccountProfile | null,
  fallbackDisplayName: string | null,
): AccountIdentity {
  const named =
    profile !== null &&
    !profile.usernameNeedsChange &&
    !LEGACY_USERNAME_PATTERN.test(profile.username);
  const handle = named ? `@${profile.username}` : (fallbackDisplayName ?? "Account");
  const letter = (named ? profile.username : (fallbackDisplayName ?? "")).trim().charAt(0);
  return {
    handle,
    initial: letter === "" ? "?" : letter.toUpperCase(),
    needsUsername: profile !== null && !named,
  };
}

export function useAccountIdentity(): AccountIdentity {
  const profile = useAccountProfileStore((state) => state.profile);
  const displayName = useHostedHubStore((state) => state.account?.displayName ?? null);
  return accountIdentity(profile, displayName);
}

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/** Lowercase and drop what a username can never contain, as the user types. */
export function normalizeUsernameInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, USERNAME_MAX_LENGTH);
}

/** Why a username cannot be submitted, or `null` when it can. */
export function usernameIssue(value: string): string | null {
  if (value.length < USERNAME_MIN_LENGTH) {
    return `Use at least ${USERNAME_MIN_LENGTH} characters.`;
  }
  if (value.length > USERNAME_MAX_LENGTH) {
    return `Use at most ${USERNAME_MAX_LENGTH} characters.`;
  }
  if (!/^[a-z0-9_]+$/.test(value)) return "Use lowercase letters, numbers and underscores.";
  if (value.startsWith("legacy_")) return "Pick a name that does not start with legacy_.";
  return null;
}
