// Pure logic for the hosted account settings surface.
//
// Everything here is deliberately free of React and of the runtime stores so it
// can be exercised directly: the step-up classification, the passkey
// presentation rules, and the input normalisation are the parts whose failure
// modes are security-relevant rather than cosmetic.

import {
  PASSKEY_SESSION_REQUIRED_CODE,
  STEP_UP_REQUIRED_CODE,
  type HostedAccountOutcome,
  type HostedAccountRefused,
  type HostedHubPasskey,
} from "@ryco/client-runtime/authorization";

/**
 * Whether an account action was refused on the fallback-session step-up gate.
 *
 * Read off `errorCode`, which is the Hub-or-runtime *reason*, never the message:
 * the message is display copy produced by the runtime's own error constructor
 * and may be reworded at any time, so string-comparing it would couple a
 * security branch to a UI string.
 *
 * This is still the only signal a client has about *when* to ask. Neither the
 * client session nor the Hub exposes which credential minted the session, so a
 * surface cannot know in advance whether an action needs a TOTP code — it
 * attempts the action and asks only once the refusal says it must.
 */
export function isStepUpRefusal(outcome: HostedAccountOutcome): outcome is HostedAccountRefused {
  return outcome.status === "refused" && outcome.errorCode === STEP_UP_REQUIRED_CODE;
}

/**
 * Whether the last account action was refused because it requires a
 * passkey-authenticated session. There is no step-up out of this one: a
 * fallback session cannot enrol TOTP at all, and offering a code field here
 * would imply otherwise.
 */
export function isPasskeySessionRequired(errorCode: string | null | undefined): boolean {
  return errorCode === PASSKEY_SESSION_REQUIRED_CODE;
}

/**
 * How many refused code submissions a step-up prompt built on an *inferred*
 * code may absorb before it stops asking.
 *
 * Three, not one: authenticator codes rotate every 30 seconds and a mistyped or
 * just-expired code is the ordinary case, so a prompt that gives up on the first
 * refusal would fail the users it exists for.
 */
export const STEP_UP_INFERRED_ATTEMPT_LIMIT = 3;

/**
 * Whether a refused code submission should re-open the prompt.
 *
 * `step_up_required` is a code the runtime *synthesises* from a bare `forbidden`
 * — the Hub never sends it (see `narrowCode` in the runtime's `api.ts`). The
 * narrowing is right whenever the step-up gate is the only `forbidden` producer
 * on that route, and wrong the moment anything else answers 403: a role check
 * added later, an operator disabling the account mid-session, a WAF or gateway
 * in front of the Hub. In every one of those cases the TOTP prompt can never
 * succeed, and a surface that re-prompts on each refusal asks forever for a code
 * that was never the problem.
 *
 * So an inferred refusal buys a bounded number of attempts and no more. A code
 * the Hub actually sent is authoritative and carries no such bound — it means
 * what it says, and only the user's code is in question.
 */
export function shouldRetryStepUp(refusal: HostedAccountRefused, refusals: number): boolean {
  if (!refusal.inferredErrorCode) return true;
  return refusals < STEP_UP_INFERRED_ATTEMPT_LIMIT;
}

/**
 * What to say once an inferred step-up prompt has been refused to its limit.
 *
 * It must not repeat "enter a current code": the whole reason the prompt is
 * being abandoned is that the code may never have been the obstacle, and the
 * Hub does not say. Claiming otherwise sends the user back to an authenticator
 * app that cannot help them.
 */
export const STEP_UP_UNRESOLVED_MESSAGE =
  "The Hub refused this change every time. It answers a missing authenticator code and other refusals identically, so if the codes you entered were current then something else is blocking this — sign in again with a passkey, or try again later.";

/**
 * The error worth rendering in the section body.
 *
 * A step-up refusal is not a failure the user needs to read as one — it is the
 * prompt the surface is already showing — so it is withheld while the step-up
 * dialog carries the same information in an actionable form.
 */
export function inlineErrorMessage(
  errorMessage: string | null,
  errorCode: string | null | undefined,
  stepUpPending: boolean,
): string | null {
  if (!errorMessage) return null;
  if (stepUpPending && errorCode === STEP_UP_REQUIRED_CODE) return null;
  return errorMessage;
}

/** A passkey is revoked once the Hub reports a revocation timestamp for it. */
export function isPasskeyRevoked(passkey: HostedHubPasskey): boolean {
  return passkey.revokedAt !== null;
}

/** The credentials that can still authenticate. */
export function activePasskeys(
  passkeys: ReadonlyArray<HostedHubPasskey>,
): ReadonlyArray<HostedHubPasskey> {
  return passkeys.filter((passkey) => !isPasskeyRevoked(passkey));
}

/**
 * Active credentials first, revoked ones after.
 *
 * Revoked keys are still **listed, never filtered** — the list is the only
 * place a user learns why a device stopped working — but a dead credential
 * sitting between two live ones makes the live set impossible to count at a
 * glance. `toSorted` rather than `sort`: the array is the runtime store's own,
 * and sorting it in place would reorder state a render is reading.
 */
export function orderPasskeys(
  passkeys: ReadonlyArray<HostedHubPasskey>,
): ReadonlyArray<HostedHubPasskey> {
  return passkeys.toSorted((left, right) => {
    const leftRevoked = isPasskeyRevoked(left) ? 1 : 0;
    const rightRevoked = isPasskeyRevoked(right) ? 1 : 0;
    return leftRevoked - rightRevoked;
  });
}

/**
 * How many usable credentials the Hub has positively reported as synced.
 *
 * Only `backupState === true` counts. `backupEligible` and `backupState` are
 * independently nullable and `null` means the Hub did not say, so a zero here
 * is indistinguishable from "unknown" — which is exactly why the caller must
 * never render this count when it is zero.
 */
export function syncedPasskeyCount(passkeys: ReadonlyArray<HostedHubPasskey>): number {
  return activePasskeys(passkeys).filter((passkey) => passkey.backupState === true).length;
}

/**
 * The one honest security-posture signal this surface has.
 *
 * The Hub exposes no read for "is TOTP enrolled", "is a password set", or "is
 * an email on file". `activePasskeys().length` is the *only* readable posture
 * input on the page, so posture is one conditional alert about passkey count
 * and nothing else. No score, no meter, no checklist: a checklist would render
 * an unknown state for two-factor and password, and every user reads unknown as
 * "off".
 *
 * A list that is loading or stale is never scored — scoring a list that could
 * not be refreshed would warn about a credential set the surface cannot see.
 * And there is no positive "you are secure" branch: silence is the only honest
 * rendering of "nothing is wrong that I can detect".
 */
export interface AccountPosture {
  readonly variant: "error" | "warning";
  readonly title: string;
  readonly description: string;
  /**
   * The action's label, which says what to do next rather than repeating the
   * Passkeys header's own "Add passkey". Two controls on one page sharing an
   * accessible name and a destination is an ambiguity for voice control and
   * for anyone listing the buttons, and "Add another passkey" is better copy
   * in the case that produces it.
   */
  readonly actionLabel: string;
}

export function accountPosture(
  passkeys: ReadonlyArray<HostedHubPasskey>,
  passkeysStatus: string,
): AccountPosture | null {
  if (passkeysStatus !== "ready") return null;
  const usable = activePasskeys(passkeys).length;
  if (usable === 0) {
    return {
      variant: "error",
      title: "No usable passkey on this account",
      description:
        "Without one you can only get back in through a fallback credential. Adding a passkey is the only action on this page that makes the account stronger.",
      actionLabel: "Add your first passkey",
    };
  }
  if (usable === 1) {
    return {
      variant: "warning",
      title: "One passkey on this account",
      // No emailed link. Fourteen rows below, this same panel says this Hub has
      // no mail transport configured, that verification messages are generated
      // and discarded, and not to rely on email as the way back into the
      // account. Naming it here — in the alert a user reads first, at the exact
      // moment they are deciding whether they have a way back in — offers a
      // recovery path that provably does not work.
      description:
        "If you lose this device you fall back to a password or a recovery code. Add a second passkey on another device.",
      actionLabel: "Add another passkey",
    };
  }
  return null;
}

/**
 * A display name for a credential the Hub did not label. The credential id is a
 * public handle, so showing a truncated form of it is safe and is the only
 * thing that distinguishes two unlabelled keys.
 */
export function passkeyDisplayLabel(passkey: HostedHubPasskey): string {
  const label = passkey.label?.trim();
  if (label) return label;
  return `Unnamed passkey (${passkey.id.slice(0, 12)}…)`;
}

/**
 * How a credential answers "will this survive losing the device?".
 *
 * `backupEligible` / `backupState` are independently nullable, and `null` means
 * the Hub did not say — which must not be rendered as "not backed up".
 */
export function passkeyBackupSummary(passkey: HostedHubPasskey): string | null {
  if (passkey.backupState === true) return "Synced to your password manager";
  if (passkey.backupEligible === true) return "Can be synced, not yet backed up";
  if (passkey.backupEligible === false) return "Tied to this device only";
  return null;
}

/**
 * Trim a label to what the Hub will accept, or `null` when the user left it
 * blank. The runtime omits a blank label rather than sending `""`, which the
 * Hub rejects; normalising here keeps the surface's own validation aligned.
 */
export function normalizePasskeyLabel(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** The Hub bounds a TOTP code at 16 characters; digits are the only content. */
export const TOTP_CODE_MAX_LENGTH = 16;

/**
 * Keep only digits, bounded. Authenticator apps render codes with a space in
 * the middle and users paste them that way, so stripping is a correctness fix
 * rather than a nicety.
 */
export function normalizeTotpCode(value: string): string {
  return value.replace(/\D/gu, "").slice(0, TOTP_CODE_MAX_LENGTH);
}

/** A TOTP code is submittable once it is a plausible length. */
export function isSubmittableTotpCode(value: string): boolean {
  return normalizeTotpCode(value).length >= 6;
}

/** The Hub bounds a password at 256 characters. */
export const PASSWORD_MAX_LENGTH = 256;

/** The Hub bounds an email address at 254 characters. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Why a password pair cannot be submitted, or `null` when it can.
 *
 * Deliberately minimal: the Hub owns strength and breach policy (a breached
 * password comes back as a `conflict` with its own message), so restating a
 * strength rule here would be a second, weaker source of truth. What this does
 * own is the confirmation match, which never reaches the Hub at all.
 */
export function passwordIssue(password: string, confirmation: string): string | null {
  if (password.length === 0) return "Enter a password.";
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use ${String(PASSWORD_MAX_LENGTH)} characters or fewer.`;
  }
  if (confirmation.length === 0) return "Re-enter the password to confirm it.";
  if (password !== confirmation) return "The two passwords do not match.";
  return null;
}

/** Why an email address cannot be submitted, or `null` when it can. */
export function emailIssue(email: string): string | null {
  const trimmed = email.trim();
  if (trimmed.length === 0) return "Enter an email address.";
  if (trimmed.length > EMAIL_MAX_LENGTH) {
    return `Use ${String(EMAIL_MAX_LENGTH)} characters or fewer.`;
  }
  // Structural only. The Hub is the authority on deliverability, and a stricter
  // client pattern rejects addresses that are in fact valid.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmed)) return "Enter a valid email address.";
  return null;
}

/** The clipboard form of a one-time recovery-code set: one code per line. */
export function formatRecoveryCodesForClipboard(codes: ReadonlyArray<string>): string {
  return codes.join("\n");
}

/**
 * Which account action a step-up prompt belongs to. Used only to word the
 * prompt; the retry itself re-runs the caller's own thunk.
 */
export type AccountStepUpAction =
  | "set-password"
  | "remove-password"
  | "revoke-totp"
  | "request-email-verification"
  | "add-passkey"
  | "regenerate-recovery-codes"
  | "connect-github"
  | "disconnect-github"
  | "delete-account";

const STEP_UP_ACTION_TITLES: Record<AccountStepUpAction, string> = {
  "set-password": "Confirm the password change",
  "remove-password": "Confirm removing the password",
  "revoke-totp": "Confirm removing two-factor authentication",
  "request-email-verification": "Confirm the email change",
  "add-passkey": "Confirm adding a passkey",
  "regenerate-recovery-codes": "Confirm new recovery codes",
  "connect-github": "Confirm connecting GitHub",
  "disconnect-github": "Confirm disconnecting GitHub",
  "delete-account": "Confirm deleting the account",
};

export function stepUpTitle(action: AccountStepUpAction): string {
  return STEP_UP_ACTION_TITLES[action];
}

/**
 * The prompt body, as a four-cell matrix over (first attempt | retry) ×
 * (the Hub said so | this client inferred it).
 *
 * The `inferred` axis is the one that matters. `step_up_required` is
 * *synthesised* client-side by `narrowCode` from a bare `403 {"error":
 * "forbidden"}` — the Hub never sends it. The previous copy read "This session
 * was not started with a passkey", which asserts the session's provenance: the
 * one thing neither the client nor the Hub exposes, and a claim that is simply
 * false whenever the 403 came from a role check, a disabled account, or a
 * gateway in front of the Hub. It was a guess rendered as a finding, and it
 * sent people to an authenticator app that could not help them.
 *
 * No cell claims how the session was created, and no cell implies the session
 * is weaker or stronger than it is. The inferred column names the inference as
 * an inference and still says what to try.
 *
 * The second attempt cannot distinguish "no code" from "wrong code" — the Hub
 * answers both identically on purpose — so the retry copy says only what is
 * actually known.
 */
export function stepUpDescription(attempts: number, inferred: boolean): string {
  if (attempts === 0) {
    return inferred
      ? "The Hub refused this change without saying why. The usual reason is that it wants a code from your authenticator app."
      : "The Hub asked for a code from your authenticator app before making this change.";
  }
  return inferred
    ? "That did not work. The Hub answers a wrong code and other refusals identically, so this may not be about the code at all. You can try the code showing now."
    : "That code was not accepted. Codes change every 30 seconds — enter the one showing now.";
}
