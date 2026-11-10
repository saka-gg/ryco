// The reads and mutations behind the account's profile and session list. This
// module holds the Hub API client, so only hosted surfaces import it; shared
// chrome (the sidebar) reads `./accountIdentity`, which loads this on demand.

import {
  EMPTY_ACCOUNT_PROFILE_STATE,
  useAccountProfileStore,
  type AccountProfileState,
} from "./accountIdentity";
import { hostedHubApi, HostedHubApiError } from "./api";
import { hostedHubController, hostedHubStore } from "./state";

export * from "./accountIdentity";

function currentAccountId(): string | null {
  const state = hostedHubStore.getState();
  return state.accountStatus === "authenticated" ? (state.account?.id ?? null) : null;
}

/** Start from nothing whenever the signed-in account is not the cached one. */
function alignToAccount(): string | null {
  const accountId = currentAccountId();
  if (useAccountProfileStore.getState().accountId !== accountId) {
    useAccountProfileStore.setState({ ...EMPTY_ACCOUNT_PROFILE_STATE, accountId });
  }
  return accountId;
}

hostedHubStore.subscribe(() => {
  alignToAccount();
});

/** A result may only publish for the account that asked for it. */
function publish(accountId: string, patch: Partial<AccountProfileState>): void {
  if (useAccountProfileStore.getState().accountId !== accountId) return;
  if (currentAccountId() !== accountId) return;
  useAccountProfileStore.setState(patch);
}

async function expireIfUnauthorized(error: unknown): Promise<boolean> {
  if (error instanceof HostedHubApiError && error.status === 401) {
    await hostedHubController.expireSession();
    return true;
  }
  return false;
}

let profileRead: Promise<void> | null = null;

export function refreshAccountProfile(): Promise<void> {
  const accountId = alignToAccount();
  if (accountId === null) return Promise.resolve();
  if (profileRead) return profileRead;
  if (useAccountProfileStore.getState().profile === null) {
    useAccountProfileStore.setState({ profileStatus: "loading" });
  }
  const read = (async () => {
    try {
      const profile = await hostedHubApi.getAccountProfile();
      publish(
        accountId,
        profile === null
          ? { profile: null, profileStatus: "unsupported" }
          : { profile, profileStatus: "ready" },
      );
    } catch (error) {
      if (await expireIfUnauthorized(error)) return;
      publish(accountId, { profileStatus: "error" });
    }
  })().finally(() => {
    if (profileRead === read) profileRead = null;
  });
  profileRead = read;
  return read;
}

let sessionsRead: Promise<void> | null = null;

export function refreshAccountSessions(): Promise<void> {
  const accountId = alignToAccount();
  if (accountId === null) return Promise.resolve();
  if (sessionsRead) return sessionsRead;
  if (useAccountProfileStore.getState().sessionsStatus !== "ready") {
    useAccountProfileStore.setState({ sessionsStatus: "loading" });
  }
  const read = (async () => {
    try {
      const sessions = await hostedHubApi.listAccountSessions();
      publish(
        accountId,
        sessions === null
          ? { sessions: [], sessionsStatus: "unsupported" }
          : { sessions, sessionsStatus: "ready" },
      );
    } catch (error) {
      if (await expireIfUnauthorized(error)) return;
      publish(accountId, { sessionsStatus: "error" });
    }
  })().finally(() => {
    if (sessionsRead === read) sessionsRead = null;
  });
  sessionsRead = read;
  return read;
}

export type AccountMutationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

async function refused(error: unknown, messages: Readonly<Record<string, string>>) {
  if (await expireIfUnauthorized(error)) {
    return { ok: false, code: "session_invalid", message: "Your session ended. Sign in again." };
  }
  const code = error instanceof HostedHubApiError ? error.code : "unavailable";
  return {
    ok: false,
    code,
    message: messages[code] ?? "The Hub could not complete that. Try again in a moment.",
  } as const;
}

export async function changeAccountUsername(username: string): Promise<AccountMutationResult> {
  const accountId = alignToAccount();
  if (accountId === null) return { ok: false, code: "signed_out", message: "Sign in first." };
  try {
    const profile = await hostedHubApi.changeUsername(username);
    publish(accountId, { profile, profileStatus: "ready" });
    return { ok: true };
  } catch (error) {
    return refused(error, {
      conflict: "That username is taken.",
      rate_limited: "You changed your username recently. Try again later.",
      invalid_request: "That username is not available. Pick a different one.",
    });
  }
}

export async function revokeAccountSession(sessionId: string): Promise<AccountMutationResult> {
  try {
    await hostedHubApi.revokeAccountSession(sessionId);
  } catch (error) {
    // Already gone is the outcome that was asked for.
    if (!(error instanceof HostedHubApiError && error.status === 404)) {
      return refused(error, {});
    }
  }
  await refreshAccountSessions();
  return { ok: true };
}

export async function revokeOtherAccountSessions(): Promise<AccountMutationResult> {
  try {
    await hostedHubApi.revokeOtherAccountSessions();
  } catch (error) {
    return refused(error, {});
  }
  await refreshAccountSessions();
  return { ok: true };
}

export async function confirmAccountEmailCode(code: string): Promise<AccountMutationResult> {
  try {
    await hostedHubApi.confirmEmailVerificationCode(code);
  } catch (error) {
    return refused(error, {
      invalid_request: "That code is not right. Check the newest email and try again.",
      not_found: "That code expired. Send a new one.",
      rate_limited: "Too many attempts. Send a new code.",
    });
  }
  await hostedHubController.refreshAccountSecurity({ force: true });
  return { ok: true };
}
