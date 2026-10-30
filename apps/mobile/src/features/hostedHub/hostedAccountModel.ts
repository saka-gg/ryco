import {
  HostedHubApiError,
  PASSKEY_SESSION_REQUIRED_CODE,
  STEP_UP_REQUIRED_CODE,
  type HostedAccountIntent,
  type HostedAccountState,
  type HostedHubPasskey,
  type HostedHubState,
} from "@ryco/client-runtime/authorization";

import type { StatusTone } from "../../components/StatusPill";

/**
 * Native account management for the hosted plane.
 *
 * Every credential operation on this surface is a **direct, DPoP-bound call**
 * through `hostedHubController`. Nothing here opens a browser. The sign-in
 * sheet uses the reviewed system-browser handoff, while `/api/account/*` is
 * served to the native transport, so credential *management* has no reason to
 * leave the app.
 *
 * Like `hostedAuthModel.ts` this module is free of `react-native` and of React:
 * the RN packages ship untranspiled Flow that the vp/node runner cannot parse,
 * so every decision — which rows exist, when an action is refused, what each
 * confirmation destroys, and which controller call sits behind every button —
 * lives here and is asserted by a real test. The `.tsx` files are layout.
 *
 * Five rules this module exists to hold:
 *
 * 1. **Step-up is discovered, never assumed.** Neither the client type nor the
 *    Hub says whether the current session came from a passkey or from a
 *    password / recovery code / email link. So an action is attempted, and only
 *    the runtime's distinguishable refusal turns on a TOTP field — see
 *    {@link isHostedStepUpMessage}.
 * 2. **Recovery-code regeneration rotates.** It invalidates codes the user has
 *    already saved, so it runs from one explicit, confirmed submit and from
 *    nothing else — never a mount, focus, retry, or reconnect. No derivation in
 *    this file calls an action; every call is inside a button's `run`.
 * 3. **The one-shot secrets are transient, but it is the user who ends them.**
 *    The TOTP enrolment secret and the recovery codes live in one in-memory
 *    runtime slot each; the secret is projected into exactly one view (the
 *    enrolment prompt) and is dropped through `dismissTotpEnrollment()` when
 *    the user closes it. Neither is dropped by a *teardown* — see
 *    {@link leaseHostedRecoveryCodeDisplay} for why an unmount is not an
 *    acknowledgement.
 * 4. **A fallback credential is never presented as equivalent to a passkey.**
 *    The password and two-factor copy says so in as many words.
 * 5. **A result may only land on the state it was started from.** The account
 *    store cannot distinguish "committed" from "abandoned" or "the session
 *    rotated" — all three leave it idle with no error — so every submit is
 *    fenced on the prompt it belongs to, the attempt that is still live, and
 *    the session that issued it. The runtime's `createFence` is the same
 *    discipline; this is its surface-side half.
 */

/* -------------------------------------------------------------------------- */
/* The runtime's refusals                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every account operation the runtime can attribute an error to.
 *
 * The runtime exports the union as a *type* only, so the values are listed
 * here — and the `satisfies` is the coupling, not a formality: an intent added
 * over there stops this file compiling until it is added here too, which is the
 * whole point of listing them rather than sampling the ones that matter today.
 */
const ACCOUNT_INTENTS = {
  "set-password": true,
  "remove-password": true,
  "begin-totp-enrollment": true,
  "confirm-totp-enrollment": true,
  "revoke-totp": true,
  "request-email-verification": true,
  "revoke-passkey": true,
  "add-passkey": true,
  "regenerate-recovery-codes": true,
  "connect-external-identity": true,
  "disconnect-external-identity": true,
  "delete-account": true,
} satisfies Record<HostedAccountIntent, true>;

export const HOSTED_ACCOUNT_INTENTS = Object.keys(
  ACCOUNT_INTENTS,
) as ReadonlyArray<HostedAccountIntent>;

/**
 * Recognise one of the runtime's refusals from the text the controller
 * published.
 *
 * A refusal reaches this surface as a **message**, never a code: the controller
 * catches `HostedHubApiError` and publishes `error.message`, and the code never
 * reaches a consumer. So the text is rebuilt from the runtime's own error type
 * rather than copied as a string literal — a reword over there moves this with
 * it instead of leaving a comparison against text that no longer exists.
 *
 * One message is not enough, though. `messageForCode(code, intent)` consults a
 * **route-scoped** table before the generic one, and every account error the
 * controller publishes carries an intent — the runtime already scopes
 * `conflict`, `authentication_failed`, and `not_found` this way. Matching only
 * the intent-less text would hold exactly until someone scopes this code too,
 * and then fail silently and badly: on that one route the authenticator field
 * would never appear and the action would be permanently uncompletable for a
 * fallback session. So the matcher accepts every message the runtime can
 * produce for the code, across every intent it knows about.
 *
 * `build` exists so a test can stand in a runtime that *does* scope one; the
 * default is the real thing.
 */
export function createHostedRefusalMatcher(
  code: string,
  build: (intent: HostedAccountIntent | undefined) => string = (intent) =>
    new HostedHubApiError(code, 403, undefined, intent).message,
): (message: string | null) => boolean {
  const messages = new Set<string>([build(undefined)]);
  for (const intent of HOSTED_ACCOUNT_INTENTS) messages.add(build(intent));
  return (message) => message !== null && messages.has(message);
}

/**
 * Whether a published error is the fallback-session step-up gate: a session
 * minted from a password, a recovery code, or an email link, acting on an
 * account that has TOTP enrolled. The answer is "ask the user for a current
 * authenticator code and let them submit again" — never "retry silently".
 */
export const isHostedStepUpMessage = createHostedRefusalMatcher(STEP_UP_REQUIRED_CODE);

/**
 * Whether a published error is "this needs a passkey session". It is *not* a
 * step-up: no code upgrades a fallback session for TOTP enrolment, and offering
 * a code field here would imply the two session kinds are interchangeable. The
 * runtime's own message already says what to do instead.
 */
export const isHostedPasskeySessionMessage = createHostedRefusalMatcher(
  PASSKEY_SESSION_REQUIRED_CODE,
);

/* -------------------------------------------------------------------------- */
/* Seams                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The controller calls this surface drives. Structural rather than an import so
 * a test can pass a fake without loading the runtime's configurator, and so no
 * module in this file's graph reaches SecureStore, the enclave, or
 * `expo-constants`. `hostedHubController` satisfies it as written.
 */
export interface HostedAccountActions {
  readonly refreshPasskeys: (options?: { readonly force?: boolean }) => unknown;
  readonly refreshAccountSecurity: (options?: { readonly force?: boolean }) => unknown;
  readonly refreshExternalIdentityConfiguration: (options?: {
    readonly force?: boolean;
  }) => unknown;
  readonly addPasskey: (input: {
    readonly passkeyLabel: string | null;
    readonly totpCode?: string;
  }) => unknown;
  readonly revokePasskey: (credentialId: string) => unknown;
  readonly regenerateRecoveryCodes: (input?: { readonly totpCode?: string }) => unknown;
  readonly setPassword: (input: {
    readonly password: string;
    readonly totpCode?: string;
  }) => unknown;
  readonly removePassword: (input?: { readonly totpCode?: string }) => unknown;
  readonly beginTotpEnrollment: () => unknown;
  readonly confirmTotpEnrollment: (input: { readonly code: string }) => unknown;
  readonly revokeTotp: (input?: { readonly totpCode?: string }) => unknown;
  readonly requestEmailVerification: (input: {
    readonly email: string;
    readonly totpCode?: string;
  }) => unknown;
  readonly connectExternalIdentity: (
    provider: "github",
    input?: { readonly totpCode?: string },
  ) => unknown;
  readonly disconnectExternalIdentity: (
    provider: "github",
    input?: { readonly totpCode?: string },
  ) => unknown;
  readonly cancelExternalIdentityConnection: (provider: "github") => void;
  readonly dismissTotpEnrollment: () => void;
  readonly cancelAccountAction: () => void;
}

/* -------------------------------------------------------------------------- */
/* The one-shot secrets' lifetime                                              */
/* -------------------------------------------------------------------------- */

/**
 * The one runtime call this surface makes about the *lifetime* of the secrets
 * it renders. Structural for the same reason as {@link HostedAccountActions},
 * and `hostedHubController` satisfies it as written — which is what lets a test
 * drive the real controller through it rather than a fake that cannot fail the
 * way the runtime can.
 */
export interface HostedRecoveryCodeDisplayActions {
  readonly leaseRecoveryCodeDisplay: () => () => void;
}

/**
 * Declare that the account surface is displaying the account's one-time
 * recovery codes, for as long as it is mounted, and hand back the release. The
 * screen's whole mount effect:
 * `useEffect(() => leaseHostedRecoveryCodeDisplay(hostedHubController), [])`.
 *
 * **The lease is load-bearing, not defensive.** The runtime publishes rotated
 * codes only if a lease was live when the rotation was asked for; without this
 * the "Generate new codes" button rotates the user's codes server-side — every
 * code they had saved stops working the instant the Hub answers — and then
 * comes back `displayed: false` with nothing to show. That is the shape this
 * screen shipped: it never took the claim this replaces, so the destructive
 * half of the operation succeeded and the display half could not.
 *
 * **The release destroys nothing, and neither does anything else on the way
 * out.** This cleanup used to call `dismissRecoveryCodes()` — with a subscribed
 * watch that hunted down a rotation still in flight and dismissed its result as
 * it landed — and `dismissTotpEnrollment()` besides. Both are teardown paths,
 * and a teardown is not the user: this screen is unmounted by a back-swipe, by
 * the settings sheet closing, by a sign-out underneath it, and by a re-render
 * at a new position. None of those is anybody deciding they have written the
 * codes down, and by the time codes are in the slot the rotation has already
 * invalidated the set they had — so destroying them there left the account with
 * recovery codes nobody has ever seen, which with a lost passkey is a lockout.
 * The same goes for the enrolment secret, which this Hub issues once.
 *
 * The two secrets are dropped by the acknowledgements the surface already
 * offers — "I saved the codes", and the enrolment prompt's own close — or with
 * the account, and by nothing else. A set that lands after this screen is gone
 * stays in the runtime's slot, and the next visit to this screen renders it
 * with its acknowledgement rather than silently discarding it.
 */
export function leaseHostedRecoveryCodeDisplay(
  actions: HostedRecoveryCodeDisplayActions,
): () => void {
  return actions.leaseRecoveryCodeDisplay();
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                     */
/* -------------------------------------------------------------------------- */

export interface HostedAccountButton {
  readonly label: string;
  readonly disabled: boolean;
  readonly destructive: boolean;
  readonly run: () => void;
}

/**
 * The same discipline `hostedAuthModel`'s `action` uses: a disabled button is
 * inert *at the model layer*, not merely greyed out by whichever surface
 * remembered to forward the flag. A hardware keyboard, an accessibility action,
 * or a future layout that forgets `disabled` must not be able to fire a
 * mutation the state machine is not ready for.
 */
function button(
  label: string,
  run: () => void,
  options?: { readonly disabled?: boolean; readonly destructive?: boolean },
): HostedAccountButton {
  const disabled = options?.disabled ?? false;
  return {
    label,
    disabled,
    destructive: options?.destructive ?? false,
    run: disabled ? () => undefined : run,
  };
}

/* -------------------------------------------------------------------------- */
/* Passkey rows                                                                */
/* -------------------------------------------------------------------------- */

const SYNCED_TONE: StatusTone = {
  label: "Synced",
  pillClassName: "bg-subtle",
  textClassName: "text-foreground-muted",
};
const DEVICE_ONLY_TONE: StatusTone = {
  label: "This device only",
  pillClassName: "bg-subtle",
  textClassName: "text-foreground-muted",
};
const REVOKED_TONE: StatusTone = {
  label: "Revoked",
  pillClassName: "bg-danger border border-danger-border",
  textClassName: "text-danger-foreground",
};

export interface HostedPasskeyRow {
  /**
   * The Hub's public credential handle. Carried so the row can name its own
   * revoke target and key a list — never rendered. `label` and `detail` are the
   * whole visible vocabulary, and a test asserts the id appears in neither.
   */
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly tone: StatusTone | null;
  readonly revoked: boolean;
  /** `undefined` whenever the row must not offer a revoke — never a dead handler. */
  readonly revoke: (() => void) | undefined;
}

/** A coarse, locale-free age. Full-ICU `Intl` is not guaranteed on Hermes. */
function ageLabel(timestamp: number | null, now: number): string | null {
  if (timestamp === null || !Number.isFinite(timestamp)) return null;
  const delta = now - timestamp;
  // Clock skew between device and Hub is ordinary; a negative age is not an
  // error worth surfacing, it is simply "now".
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function passkeyLabel(passkey: HostedHubPasskey): string {
  const label = passkey.label === null ? "" : passkey.label.trim();
  return label.length > 0 ? label : "Unnamed passkey";
}

function passkeyDetail(passkey: HostedHubPasskey, now: number): string {
  if (passkey.revokedAt !== null) {
    const age = ageLabel(passkey.revokedAt, now);
    return age === null ? "Revoked" : `Revoked ${age}`;
  }
  const parts: string[] = [];
  const added = ageLabel(passkey.createdAt, now);
  if (added !== null) parts.push(`Added ${added}`);
  const used = ageLabel(passkey.lastUsedAt, now);
  parts.push(used === null ? "Never used" : `Last used ${used}`);
  return parts.join(" · ");
}

function passkeyTone(passkey: HostedHubPasskey): StatusTone | null {
  if (passkey.revokedAt !== null) return REVOKED_TONE;
  if (passkey.backupState === true) return SYNCED_TONE;
  if (passkey.backupState === false) return DEVICE_ONLY_TONE;
  return null;
}

/* -------------------------------------------------------------------------- */
/* The prompt                                                                  */
/* -------------------------------------------------------------------------- */

export type HostedAccountPromptId =
  | "add-passkey"
  | "revoke-passkey"
  | "regenerate-recovery-codes"
  | "set-password"
  | "remove-password"
  | "enroll-totp"
  | "revoke-totp"
  | "verify-email"
  | "connect-github"
  | "disconnect-github";

/**
 * Everything the surface holds for an open prompt. Deliberately flat so a test
 * can build one by hand — and deliberately **not** where the TOTP secret lives:
 * that stays in the runtime's transient slot and is read from the store on every
 * derivation, so dismissing the prompt is all it takes to be rid of it.
 */
export interface HostedAccountPromptDraft {
  readonly id: HostedAccountPromptId;
  /**
   * Identity of this prompt *instance*, minted once per opened prompt and
   * carried through every edit. Two prompts with the same `id` are still two
   * different prompts, so a result may only touch the one it was started from.
   * See {@link derivePrompt}.
   */
  readonly generation: number;
  /**
   * Which submit is live. Bumped by every submit and by "Stop waiting", so a
   * result that lands after the attempt it belongs to was abandoned is
   * recognisable as stale — the store cannot say so, because a cancellation
   * resets it to exactly the idle/no-error state a success leaves behind.
   */
  readonly attempt: number;
  /** `revoke-passkey` only: which credential, and what to call it in the copy. */
  readonly credentialId: string | null;
  readonly passkeyLabel: string | null;
  /** The prompt's primary text field (device name, password, email, or code). */
  readonly text: string;
  /** The confirmation field, used by `set-password` only. */
  readonly secondary: string;
  /** The fallback-session step-up code. Distinct from an enrolment code. */
  readonly stepUpCode: string;
  /** True once the runtime has refused this action for want of a step-up. */
  readonly stepUpRequired: boolean;
  /** True once a submit has settled: the gate on showing a store error here. */
  readonly attempted: boolean;
  /** True once the action committed and the prompt is showing its outcome. */
  readonly completed: boolean;
}

/**
 * The generation counter behind {@link HostedAccountPromptDraft.generation}.
 *
 * Module-scoped and monotonic, the same shape as the runtime's `createFence`:
 * the value only ever has to be *comparable*, never meaningful, and a counter
 * that is never reset cannot hand the same identity to two prompts.
 */
let promptGeneration = 0;

export function createHostedAccountPromptDraft(
  id: HostedAccountPromptId,
  extras?: { readonly credentialId?: string; readonly passkeyLabel?: string | null },
): HostedAccountPromptDraft {
  promptGeneration += 1;
  return {
    id,
    generation: promptGeneration,
    attempt: 0,
    credentialId: extras?.credentialId ?? null,
    passkeyLabel: extras?.passkeyLabel ?? null,
    text: "",
    secondary: "",
    stepUpCode: "",
    stepUpRequired: false,
    attempted: false,
    completed: false,
  };
}

export type HostedPromptFieldKey = "text" | "secondary" | "stepUpCode";

export interface HostedAccountPromptField {
  readonly key: HostedPromptFieldKey;
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly secureTextEntry: boolean;
  readonly keyboardType: "default" | "email-address" | "number-pad";
  readonly autoCapitalize: "none" | "words";
  readonly maxLength: number;
  readonly onChangeText: (value: string) => void;
}

/**
 * The started TOTP enrolment, projected for the one screen allowed to show it.
 *
 * Both members are secret key material: `secretBase32` *is* the shared key and
 * `provisioningUri` embeds it. They appear here and in no other view model —
 * the account view, the sign-in view, and every row model are asserted free of
 * them — they are read straight from the runtime's transient slot rather than
 * copied into the draft, and every close path calls `dismissTotpEnrollment()`.
 */
export interface HostedTotpEnrollmentView {
  readonly provisioningUri: string;
  readonly secretBase32: string;
}

export interface HostedAccountPromptView {
  readonly id: HostedAccountPromptId;
  readonly title: string;
  readonly message: string;
  /** A standing caveat about the action itself — not an error. */
  readonly notice: string | null;
  readonly destructive: boolean;
  readonly fields: ReadonlyArray<HostedAccountPromptField>;
  readonly enrollment: HostedTotpEnrollmentView | null;
  readonly errorMessage: string | null;
  readonly busy: boolean;
  /** Null once the prompt is showing its outcome; `dismiss` is then the way out. */
  readonly submit: HostedAccountButton | null;
  readonly dismiss: HostedAccountButton;
  /** Offered only while an action is in flight — a platform sheet can hang. */
  readonly cancel: HostedAccountButton | null;
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

export type HostedAccountSectionId =
  | "passkeys"
  | "recovery-codes"
  | "password"
  | "two-factor"
  | "email"
  | "external-identities";

export interface HostedAccountActionRow {
  readonly id: HostedAccountPromptId;
  readonly label: string;
  readonly destructive: boolean;
  readonly disabled: boolean;
  readonly run: () => void;
}

export interface HostedAccountSection {
  readonly id: HostedAccountSectionId;
  readonly title: string;
  readonly status: string | null;
  readonly footnote: string;
  readonly rows: ReadonlyArray<HostedAccountActionRow>;
}

export interface HostedAccountManagementView {
  /** False whenever there is no authenticated session to manage. */
  readonly available: boolean;
  readonly passkeyRows: ReadonlyArray<HostedPasskeyRow>;
  readonly passkeysEmptyDetail: string | null;
  readonly sections: ReadonlyArray<HostedAccountSection>;
  readonly securityMessage: string | null;
  readonly securityRetry: HostedAccountButton | null;
  readonly externalIdentityMessage: string | null;
  readonly externalIdentityRetry: HostedAccountButton | null;
  /** The account store's own message — never re-worded, and never duplicated
   *  onto the screen while the prompt that produced it is still open. */
  readonly errorMessage: string | null;
  readonly busy: boolean;
  readonly prompt: HostedAccountPromptView | null;
}

export interface HostedAccountManagementInput {
  readonly state: HostedHubState;
  readonly accountState: HostedAccountState;
  readonly draft: HostedAccountPromptDraft | null;
  readonly actions: HostedAccountActions;
  /**
   * Re-reads the account store *after* an action settles. The controller
   * resolves `void` for both outcomes and records the result in the store, so
   * this is the only way a submit can tell success from a refusal — and the only
   * way it can spot the step-up gate.
   */
  readonly readAccountState: () => HostedAccountState;
  /**
   * Re-reads the hosted lifecycle store, for the same reason: a session that
   * rotated while an action was in flight makes that action's result somebody
   * else's, and the render-time snapshot cannot say so.
   */
  readonly readHubState: () => HostedHubState;
  /**
   * The prompt as it is *now* — not the copy this derivation was handed. A
   * submit settles into whatever the surface has become, so both halves of the
   * fence (is this still the same prompt, is this still the live attempt) read
   * through this. It must reflect an `onDraftChange` immediately, before any
   * re-render.
   */
  readonly readDraft: () => HostedAccountPromptDraft | null;
  /** `null` closes the prompt. */
  readonly onDraftChange: (draft: HostedAccountPromptDraft | null) => void;
  /** Injected so age labels are deterministic under test. */
  readonly now?: number;
}

/**
 * Where a passkey lives is the platform's decision, not Ryco's: a platform
 * passkey syncs through iCloud Keychain or Google Password Manager by default,
 * and this same model renders a "Synced" pill saying so. So the copy says what
 * the list can show and claims no hardware binding for the credential itself —
 * the only key this app can attest never leaves the device is its own DPoP key.
 */
const PASSKEY_FOOTNOTE =
  "A passkey is the strongest way to sign in. Whether one stays on this device or syncs through your password manager is the platform's decision — each entry below says which. Add one here so this device stops depending on the browser.";
const RECOVERY_FOOTNOTE =
  "Recovery codes are a last resort for getting back in. Generating a new set replaces the old one.";
const PASSWORD_FOOTNOTE =
  "A password is a fallback credential. It is weaker than a passkey and never replaces one.";
const TOTP_FOOTNOTE =
  "An authenticator app protects the fallback ways of signing in. Setting one up needs a passkey session on this device.";
const EMAIL_DISABLED_FOOTNOTE =
  "This Hub has no mail transport configured, so no message will arrive. The request is accepted and recorded either way.";
const EMAIL_CONFIGURED_FOOTNOTE =
  "Used for account recovery after verification. The Hub accepts the request without confirming whether an address is already known.";

const MAX_LABEL_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 256;
const MAX_EMAIL_LENGTH = 254;
const MAX_CODE_LENGTH = 16;
const MIN_CODE_LENGTH = 6;
/** The app's own floor. The Hub owns the real policy and may demand more. */
const MIN_PASSWORD_LENGTH = 8;

function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return false;
  if (/\s/.test(trimmed)) return false;
  const at = trimmed.indexOf("@");
  return at > 0 && at === trimmed.lastIndexOf("@") && trimmed.indexOf(".", at) > at + 1;
}

/**
 * Await whatever a controller call returns. The controller resolves rather than
 * rejects, but a fake, a future signature, or a synchronous throw must not turn
 * a button press into an unhandled rejection that leaves the prompt stuck busy.
 */
async function settle(value: unknown): Promise<void> {
  try {
    await value;
  } catch {
    // The store carries the outcome; a thrown value would only duplicate it.
  }
}

export function deriveHostedAccountManagementView(
  input: HostedAccountManagementInput,
): HostedAccountManagementView {
  const { state, accountState, draft } = input;
  const now = input.now ?? Date.now();
  const busy = accountState.actionStatus !== "idle";
  const signedIn = state.accountStatus === "authenticated" && state.account !== null;

  if (!signedIn) {
    return {
      available: false,
      passkeyRows: [],
      passkeysEmptyDetail: null,
      sections: [],
      securityMessage: null,
      securityRetry: null,
      externalIdentityMessage: null,
      externalIdentityRetry: null,
      errorMessage: null,
      busy: false,
      prompt: null,
    };
  }

  const open = (
    id: HostedAccountPromptId,
    extras?: { readonly credentialId?: string; readonly passkeyLabel?: string | null },
  ) => input.onDraftChange(createHostedAccountPromptDraft(id, extras));

  const activePasskeys = accountState.passkeys.filter((passkey) => passkey.revokedAt === null);
  // The Hub refuses to revoke the last credential (`conflict`), so the row is
  // withheld rather than offered and then rejected. This mirrors the Hub's rule;
  // it does not replace it.
  const canRevoke = activePasskeys.length > 1;

  const passkeyRows = accountState.passkeys.map((passkey): HostedPasskeyRow => {
    const revocable = passkey.revokedAt === null && canRevoke && !busy;
    return {
      id: passkey.id,
      label: passkeyLabel(passkey),
      detail: passkeyDetail(passkey, now),
      tone: passkeyTone(passkey),
      revoked: passkey.revokedAt !== null,
      revoke: revocable
        ? () =>
            open("revoke-passkey", {
              credentialId: passkey.id,
              passkeyLabel: passkeyLabel(passkey),
            })
        : undefined,
    };
  });

  const row = (
    id: HostedAccountPromptId,
    label: string,
    options?: { readonly destructive?: boolean },
  ): HostedAccountActionRow => ({
    id,
    label,
    destructive: options?.destructive ?? false,
    disabled: busy,
    run: busy ? () => undefined : () => open(id),
  });

  const security = accountState.security;
  const securityKnown = security !== null;
  const securityStale = accountState.securityStatus === "stale";
  const securityMessage =
    accountState.securityStatus === "loading" || accountState.securityStatus === "idle"
      ? "Checking which sign-in methods are configured."
      : securityStale
        ? securityKnown
          ? "This account-security state may be out of date."
          : "Account security could not be loaded."
        : null;
  const securityRetry = securityStale
    ? button("Retry account security", () => {
        void input.actions.refreshAccountSecurity({ force: true });
      })
    : null;
  const emailFootnote =
    security === null
      ? EMAIL_DISABLED_FOOTNOTE
      : `${security.email === null ? "" : `${security.email.verified ? "Verified" : "Verification pending"} for ${security.email.address}. `}${security.emailDeliveryConfigured ? EMAIL_CONFIGURED_FOOTNOTE : EMAIL_DISABLED_FOOTNOTE}`;
  const githubPolicy =
    accountState.externalIdentityConfiguration?.providers.find(
      (provider) => provider.provider === "github",
    ) ?? null;
  const githubIdentity =
    security?.externalIdentities.find((identity) => identity.provider === "github") ?? null;
  const externalIdentityStale = accountState.externalIdentityConfigurationStatus === "stale";
  const externalIdentityMessage =
    accountState.externalIdentityConfigurationStatus === "loading" ||
    accountState.externalIdentityConfigurationStatus === "idle"
      ? "Checking which connected accounts this Hub supports."
      : externalIdentityStale
        ? githubIdentity === null
          ? "Connected-account support could not be loaded."
          : "This connected-account status may be out of date."
        : null;
  const externalIdentityRetry = externalIdentityStale
    ? button("Retry connected accounts", () => {
        void input.actions.refreshExternalIdentityConfiguration({ force: true });
        void input.actions.refreshAccountSecurity({ force: true });
      })
    : null;

  const externalIdentitySections: ReadonlyArray<HostedAccountSection> =
    githubIdentity !== null || githubPolicy?.link === true
      ? [
          {
            id: "external-identities",
            title: "GitHub",
            status: githubIdentity === null ? "Not connected" : `@${githubIdentity.login}`,
            footnote:
              githubIdentity === null
                ? "Connect GitHub as another way to sign in. Repository access remains separate."
                : `${githubIdentity.displayName ? `${githubIdentity.displayName}. ` : ""}Connected ${ageLabel(githubIdentity.connectedAt, now) ?? "previously"}${githubIdentity.lastUsedAt === null ? "" : ` · last used ${ageLabel(githubIdentity.lastUsedAt, now) ?? "previously"}`}. Repository access remains separate.`,
            rows:
              githubPolicy?.link !== true
                ? []
                : githubIdentity === null
                  ? [row("connect-github", "Connect GitHub")]
                  : [row("disconnect-github", "Disconnect GitHub", { destructive: true })],
          },
        ]
      : [];

  const sections: ReadonlyArray<HostedAccountSection> = [
    ...externalIdentitySections,
    {
      id: "passkeys",
      title: "Passkeys",
      status: null,
      footnote:
        activePasskeys.length === 1
          ? `${PASSKEY_FOOTNOTE} This is the only one left, so it cannot be removed yet.`
          : PASSKEY_FOOTNOTE,
      rows: [row("add-passkey", "Add a passkey for this device")],
    },
    {
      id: "recovery-codes",
      title: "Recovery codes",
      status: null,
      footnote: RECOVERY_FOOTNOTE,
      rows: [
        row("regenerate-recovery-codes", "Generate new recovery codes", { destructive: true }),
      ],
    },
    {
      id: "password",
      title: "Password",
      status: securityKnown ? (security.passwordConfigured ? "Set" : "Not set") : "Checking…",
      footnote: PASSWORD_FOOTNOTE,
      rows: !securityKnown
        ? []
        : security.passwordConfigured
          ? [
              row("set-password", "Change password"),
              row("remove-password", "Remove password", { destructive: true }),
            ]
          : [row("set-password", "Set password")],
    },
    {
      id: "two-factor",
      title: "Two-factor authentication",
      status: securityKnown ? (security.totpEnrolled ? "On" : "Off") : "Checking…",
      footnote: TOTP_FOOTNOTE,
      rows: !securityKnown
        ? []
        : security.totpEnrolled
          ? [row("revoke-totp", "Turn off two-factor authentication", { destructive: true })]
          : [row("enroll-totp", "Set up an authenticator app")],
    },
    {
      id: "email",
      title: "Email",
      status:
        security === null
          ? "Checking…"
          : security.email === null
            ? "Not set"
            : security.email.verified
              ? "Verified"
              : "Pending",
      footnote: emailFootnote,
      rows:
        security === null
          ? []
          : [
              row(
                "verify-email",
                security.email === null
                  ? "Send a verification email"
                  : security.email.verified
                    ? "Change email address"
                    : "Resend or change verification email",
              ),
            ],
    },
  ];

  return {
    available: true,
    passkeyRows,
    passkeysEmptyDetail:
      passkeyRows.length > 0
        ? null
        : accountState.passkeysStatus === "ready"
          ? "No passkeys are registered on this account yet."
          : accountState.passkeysStatus === "stale"
            ? "The passkey list could not be loaded."
            : "Loading your passkeys.",
    sections,
    securityMessage,
    securityRetry,
    externalIdentityMessage,
    externalIdentityRetry,
    // An open prompt owns its own error. Publishing it twice makes a single
    // refusal read as two separate failures.
    errorMessage: draft === null ? accountState.errorMessage : null,
    busy,
    prompt: draft === null ? null : derivePrompt(input, draft, busy),
  };
}

/* -------------------------------------------------------------------------- */
/* Prompt derivation                                                           */
/* -------------------------------------------------------------------------- */

interface PromptSpec {
  readonly title: string;
  readonly message: string;
  readonly notice: string | null;
  readonly destructive: boolean;
  readonly submitLabel: string;
  /** Null when the committed action speaks for itself and the prompt may close. */
  readonly completionMessage: string | null;
  readonly fields: ReadonlyArray<HostedAccountPromptField>;
  /** True while the draft is not yet submittable. */
  readonly incomplete: boolean;
  readonly perform: () => Promise<void>;
  /** Overrides the default "close or report" behaviour of a committed action. */
  readonly onCommitted?: () => void;
  readonly enrollment: HostedTotpEnrollmentView | null;
}

interface PromptHelpers {
  readonly field: (
    key: HostedPromptFieldKey,
    label: string,
    placeholder: string,
    value: string,
    options: {
      readonly secureTextEntry?: boolean;
      readonly keyboardType?: HostedAccountPromptField["keyboardType"];
      readonly autoCapitalize?: HostedAccountPromptField["autoCapitalize"];
      readonly maxLength: number;
    },
  ) => HostedAccountPromptField;
  readonly withStepUp: (
    fields: ReadonlyArray<HostedAccountPromptField>,
  ) => ReadonlyArray<HostedAccountPromptField>;
  readonly stepUp: { readonly totpCode?: string };
  readonly set: (patch: Partial<HostedAccountPromptDraft>) => void;
}

function derivePrompt(
  input: HostedAccountManagementInput,
  draft: HostedAccountPromptDraft,
  busy: boolean,
): HostedAccountPromptView {
  const { actions, accountState } = input;

  /**
   * This prompt as it is *now*, or `null` once it has been closed or replaced.
   *
   * Everything that writes goes through it, so a closure held by an in-flight
   * submit can neither resurrect a prompt the user dismissed nor overwrite a
   * different one that has since been opened — and a write always merges into
   * the live draft rather than into the copy this derivation captured.
   */
  const live = (): HostedAccountPromptDraft | null => {
    const current = input.readDraft();
    return current !== null && current.generation === draft.generation ? current : null;
  };

  const set = (patch: Partial<HostedAccountPromptDraft>) => {
    const current = live();
    if (current === null) return;
    input.onDraftChange({ ...current, ...patch });
  };

  const close = () => {
    if (live() === null) return;
    // Every close path drops the enrolment secret, including the ones the
    // runtime would not clear on its own: backing out of the enrolment screen
    // must not leave the account's shared key sitting in a store.
    if (draft.id === "enroll-totp") actions.dismissTotpEnrollment();
    if (draft.id === "connect-github") actions.cancelExternalIdentityConnection("github");
    input.onDraftChange(null);
  };

  /**
   * Abandon whatever submit is in flight. `cancelAccountAction` resets the
   * account store to idle with no error — byte for byte what a success leaves
   * behind — so the abandonment has to be recorded here or the result that
   * eventually lands reads as that success.
   */
  const abandonAttempt = () => {
    const current = live();
    if (current === null) return;
    if (draft.id === "connect-github") actions.cancelExternalIdentityConnection("github");
    input.onDraftChange({ ...current, attempt: current.attempt + 1 });
  };

  const field: PromptHelpers["field"] = (key, label, placeholder, value, options) => ({
    key,
    label,
    placeholder,
    value,
    secureTextEntry: options.secureTextEntry ?? false,
    keyboardType: options.keyboardType ?? "default",
    autoCapitalize: options.autoCapitalize ?? "none",
    maxLength: options.maxLength,
    onChangeText: (next: string) => {
      if (key === "text") set({ text: next });
      else if (key === "secondary") set({ secondary: next });
      else set({ stepUpCode: next });
    },
  });

  const stepUpField = field("stepUpCode", "Authenticator code", "123456", draft.stepUpCode, {
    keyboardType: "number-pad",
    maxLength: MAX_CODE_LENGTH,
  });
  const stepUp = draft.stepUpRequired ? { totpCode: draft.stepUpCode.trim() } : {};
  const stepUpIncomplete = draft.stepUpRequired && draft.stepUpCode.trim().length < MIN_CODE_LENGTH;
  const withStepUp: PromptHelpers["withStepUp"] = (fields) =>
    draft.stepUpRequired ? [...fields, stepUpField] : fields;

  const spec = promptSpec(input, draft, { field, withStepUp, stepUp, set });
  const submitDisabled = busy || spec.incomplete || stepUpIncomplete;

  const submit = draft.completed
    ? null
    : button(
        spec.submitLabel,
        () => {
          // Claim this submit before it starts. Both halves of the fence are
          // taken *now*, from the live state, so what the result is compared
          // against is what was true when the request went out.
          const attempt = (live() ?? draft).attempt + 1;
          const session = sessionIdentity(input.readHubState());
          set({ attempt });
          void (async () => {
            await settle(spec.perform());
            // The runtime resolves the same way for a commit, a refusal, an
            // abandoned operation, and a session that rotated underneath, so
            // "it returned" says nothing about whose result this is. Only a
            // result that is still the live attempt on the same prompt and the
            // same session may be read as this action's outcome — the
            // alternative is a stale closure closing (or falsely completing) a
            // prompt the user has since opened for something else.
            const current = live();
            if (current === null || current.attempt !== attempt || current.completed) return;
            if (sessionIdentity(input.readHubState()) !== session) return;

            const after = input.readAccountState();
            if (after.errorMessage === null) {
              if (spec.onCommitted) spec.onCommitted();
              else if (spec.completionMessage === null) close();
              else set({ attempted: true, completed: true });
              return;
            }
            // The one refusal a surface can act on. A wrong code lands here too,
            // so the field is cleared and the runtime's message stays visible;
            // the retry is the user pressing submit again — never an automatic
            // one, because regenerating recovery codes must never re-run itself.
            set({
              attempted: true,
              ...(isHostedStepUpMessage(after.errorMessage)
                ? { stepUpRequired: true, stepUpCode: "" }
                : {}),
            });
          })();
        },
        { disabled: submitDisabled, destructive: spec.destructive },
      );

  return {
    id: draft.id,
    title: spec.title,
    message:
      draft.completed && spec.completionMessage !== null ? spec.completionMessage : spec.message,
    notice: draft.completed ? null : spec.notice,
    destructive: spec.destructive,
    fields: draft.completed ? [] : spec.fields,
    enrollment: draft.completed ? null : spec.enrollment,
    // Only ever this prompt's own outcome: a message left over from an earlier
    // action must not appear as though this one had already failed.
    errorMessage: draft.attempted && !draft.completed ? accountState.errorMessage : null,
    busy,
    submit,
    dismiss: button(draft.completed ? "Done" : "Cancel", close, { disabled: busy }),
    cancel: busy
      ? button("Stop waiting", () => {
          actions.cancelAccountAction();
          abandonAttempt();
        })
      : null,
  };
}

/**
 * Which session a result belongs to.
 *
 * A session rotation drops the operation that was in flight and leaves the
 * account store idle with no error — the same state a success leaves — so the
 * session is compared rather than the outcome. `accountStatus` rides along
 * because a sign-out is a change of session too, and it can happen without the
 * session id changing.
 */
function sessionIdentity(state: HostedHubState): string {
  return `${state.accountStatus}:${state.session?.id ?? ""}`;
}

function promptSpec(
  input: HostedAccountManagementInput,
  draft: HostedAccountPromptDraft,
  helpers: PromptHelpers,
): PromptSpec {
  const { actions, state } = input;
  const { field, withStepUp, stepUp, set } = helpers;
  const enrollment = state.totpEnrollment ?? null;

  switch (draft.id) {
    case "add-passkey": {
      const label = draft.text.trim();
      return {
        title: "Add a passkey for this device",
        message:
          "Ryco asks this device for a new passkey and registers it with your Hub. Whether that passkey stays here or syncs through your password manager is the platform's decision — the list says which. Ryco's own request is signed with a separate key that never leaves this device's secure hardware.",
        notice: null,
        destructive: false,
        submitLabel: "Add passkey",
        completionMessage: null,
        fields: withStepUp([
          field("text", "Name (optional)", "iPhone", draft.text, { maxLength: MAX_LABEL_LENGTH }),
        ]),
        incomplete: false,
        enrollment: null,
        perform: async () => {
          await actions.addPasskey({
            passkeyLabel: label.length > 0 ? label : null,
            ...stepUp,
          });
        },
      };
    }

    case "revoke-passkey": {
      const name = draft.passkeyLabel ?? "This passkey";
      return {
        title: "Remove this passkey?",
        message: `${name} stops working for signing in to your Hub. If it is the passkey this device signed in with, this device has to sign in again.`,
        notice: null,
        destructive: true,
        submitLabel: "Remove passkey",
        completionMessage: null,
        fields: [],
        incomplete: draft.credentialId === null,
        enrollment: null,
        perform: async () => {
          if (draft.credentialId === null) return;
          await actions.revokePasskey(draft.credentialId);
        },
      };
    }

    case "regenerate-recovery-codes":
      return {
        title: "Generate new recovery codes?",
        message:
          "This replaces your recovery codes. Every code you saved before stops working immediately, and the new set is shown once.",
        notice: "There is no way to undo this, and no way to see the old codes again.",
        destructive: true,
        submitLabel: "Generate new codes",
        completionMessage: null,
        fields: withStepUp([]),
        incomplete: false,
        enrollment: null,
        perform: async () => {
          await actions.regenerateRecoveryCodes(stepUp);
        },
      };

    case "set-password": {
      const password = draft.text;
      const mismatch = draft.secondary.length > 0 && draft.secondary !== password;
      return {
        title: "Set or replace your password",
        message:
          "A password lets you sign in on a device that has no passkey. It is a fallback, not a replacement: a passkey stays the strongest way in.",
        notice: mismatch ? "The two entries do not match." : null,
        destructive: false,
        submitLabel: "Save password",
        completionMessage: "Your password was saved.",
        fields: withStepUp([
          field("text", "New password", "At least 8 characters", draft.text, {
            secureTextEntry: true,
            maxLength: MAX_PASSWORD_LENGTH,
          }),
          field("secondary", "Repeat password", "Repeat it", draft.secondary, {
            secureTextEntry: true,
            maxLength: MAX_PASSWORD_LENGTH,
          }),
        ]),
        incomplete: password.length < MIN_PASSWORD_LENGTH || draft.secondary !== password,
        enrollment: null,
        perform: async () => {
          await actions.setPassword({ password, ...stepUp });
        },
      };
    }

    case "remove-password":
      return {
        title: "Remove your password?",
        message:
          "Password sign-in stops working for this account. Your passkeys, recovery codes, and any authenticator app are unaffected.",
        notice: null,
        destructive: true,
        submitLabel: "Remove password",
        completionMessage: "Password sign-in is off.",
        fields: withStepUp([]),
        incomplete: false,
        enrollment: null,
        perform: async () => {
          await actions.removePassword(stepUp);
        },
      };

    case "enroll-totp":
      // `completed` pins the confirming stage: a successful confirm clears the
      // runtime's enrolment slot, and without this the prompt would fall back
      // to the "get a setup key" copy while it is meant to be reporting success.
      if (enrollment === null && !draft.completed) {
        return {
          title: "Set up an authenticator app",
          message:
            "Ryco asks your Hub for a new setup key and shows it once, as a code you can scan. Setting this up needs a passkey session on this device.",
          notice: null,
          destructive: false,
          submitLabel: "Get a setup key",
          completionMessage: null,
          fields: [],
          incomplete: false,
          enrollment: null,
          perform: async () => {
            await actions.beginTotpEnrollment();
          },
          // The started enrolment is the point of this step, so the prompt stays
          // open and re-derives into the confirming stage below.
          onCommitted: () => set({ attempted: true, text: "" }),
        };
      }
      return {
        title: "Scan this in your authenticator app",
        message:
          "Scan the code, or type the setup key in by hand, then enter the six digits your app shows. The key is displayed once and is not stored on this device.",
        notice: null,
        destructive: false,
        submitLabel: "Turn on two-factor",
        completionMessage:
          "Two-factor authentication is on. Keep your recovery codes somewhere safe.",
        fields: [
          field("text", "Code from the app", "123456", draft.text, {
            keyboardType: "number-pad",
            maxLength: MAX_CODE_LENGTH,
          }),
        ],
        incomplete: draft.text.trim().length < MIN_CODE_LENGTH,
        enrollment:
          enrollment === null
            ? null
            : {
                provisioningUri: enrollment.provisioningUri,
                secretBase32: enrollment.secretBase32,
              },
        perform: async () => {
          await actions.confirmTotpEnrollment({ code: draft.text.trim() });
        },
      };

    case "revoke-totp":
      return {
        title: "Turn off two-factor authentication?",
        message:
          "Signing in with a password or a recovery code stops asking for a code from your authenticator app.",
        notice: null,
        destructive: true,
        submitLabel: "Turn off",
        completionMessage: "Two-factor authentication is off.",
        fields: withStepUp([]),
        incomplete: false,
        enrollment: null,
        perform: async () => {
          await actions.revokeTotp(stepUp);
        },
      };

    case "verify-email": {
      const email = draft.text.trim();
      const deliveryConfigured = input.accountState.security?.emailDeliveryConfigured === true;
      return {
        title: "Send a verification email",
        message: "Your Hub records the address and generates a verification link for it.",
        notice: deliveryConfigured
          ? null
          : "This Hub has no mail transport configured, so the message is discarded rather than delivered. Nothing will arrive in your inbox until an operator wires one up.",
        destructive: false,
        submitLabel: "Send",
        completionMessage: deliveryConfigured
          ? "Your Hub accepted the request. Check your inbox and spam folder; delivery may take a moment."
          : "Your Hub accepted the request. It cannot deliver mail yet, so no message will arrive.",
        fields: withStepUp([
          field("text", "Email address", "you@example.com", draft.text, {
            keyboardType: "email-address",
            maxLength: MAX_EMAIL_LENGTH,
          }),
        ]),
        incomplete: !isPlausibleEmail(draft.text),
        enrollment: null,
        perform: async () => {
          await actions.requestEmailVerification({ email, ...stepUp });
        },
      };
    }

    case "connect-github":
      return {
        title: "Connect GitHub?",
        message:
          "Ryco opens your system browser for GitHub authorization, then returns here. This adds a sign-in method and requests no repository access.",
        notice: null,
        destructive: false,
        submitLabel: "Continue with GitHub",
        completionMessage: null,
        fields: withStepUp([]),
        incomplete: false,
        enrollment: null,
        perform: async () => {
          await actions.connectExternalIdentity("github", stepUp);
        },
      };

    case "disconnect-github":
      return {
        title: "Disconnect GitHub?",
        message:
          "GitHub stops working as a Ryco sign-in method. Your Hub refuses this change when GitHub is the only primary sign-in method left.",
        notice: "Repository access is separate and is not changed here.",
        destructive: true,
        submitLabel: "Disconnect GitHub",
        completionMessage: null,
        fields: withStepUp([]),
        incomplete: false,
        enrollment: null,
        perform: async () => {
          await actions.disconnectExternalIdentity("github", stepUp);
        },
      };
  }
}
