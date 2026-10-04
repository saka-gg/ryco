import { ORCHESTRATION_WS_METHODS } from "@ryco/contracts";
import type { ExternalIdentityConfigResponse } from "@ryco/contracts/hosted-identity";
import {
  deriveHostedConnectionStatusIndicator,
  deriveHostedConnectionStatusText,
  hostedHubFailureExplanation,
  resolveHostedRpcCapability,
  type HostedAccountActionStatus,
  type HostedConnectionGuarantee,
  type HostedConnectionStatusIndicator,
  type HostedConnectionStatusText,
  type HostedE2eeChannelStatus,
  type HostedHubState,
  type HostedNativeDeviceSecurityStatus,
  type HostedRpcCapability,
} from "@ryco/client-runtime/authorization";

import type { StatusTone } from "../../components/StatusPill";
import { hostedHubController } from "../../hostedHub/state";

/**
 * View models for every hosted-plane surface the native app renders.
 *
 * This module is deliberately free of `react-native` (and of React): the
 * navigation tree's route config is kept import-clean for the same reason, and
 * react-native ships untranspiled Flow that cannot load in the vp/node test
 * env. Keeping the derivation here means each surface's state machine, its
 * bounded copy, and the controller call behind every affordance are asserted by
 * a real test rather than by inspection of a `.tsx` file.
 *
 * Two rules the derivations never break:
 *
 * 1. **Nothing is re-derived that the runtime already computes.** Connection
 *    status comes from `deriveHostedConnectionStatusText` /
 *    `…Indicator`, and action availability from `resolveHostedRpcCapability`.
 *    A hand-written status string here would be a second, drifting source of
 *    truth for the state the relay engine owns.
 * 2. **A view model carries status, never secret material.** The hosted store
 *    holds no token, proof, or ticket — those live behind the session
 *    credentials seam and the enclave — and nothing here reintroduces one, nor
 *    surfaces an account id, session id, or any other identifier. The bounded
 *    status vocabulary and the account's own display name are the whole
 *    vocabulary. `hostedAuthModel.test.ts` asserts this over every surface.
 */

/** The one node RPC the hosted account surface reports capability for. */
const HOSTED_CAPABILITY_METHOD: string = ORCHESTRATION_WS_METHODS.dispatchCommand;

export type HostedSignInSurface =
  /** No hosted plane in this build, or no hardware-backed key on this device. */
  | "unavailable"
  /** Hosted mode is configured but the Hub could not be reached. */
  | "hub-unreachable"
  /** Signed out with an account already enrolled on the Hub. */
  | "signed-out"
  /** The Hub has no owner yet: registration is browser-transport-only. */
  | "first-run"
  /** A system-browser authorization handoff is in flight. */
  | "authenticating"
  | "session-expired"
  | "signing-out"
  /** Codes shown once, after a registration; must be acknowledged. */
  | "recovery-codes"
  | "authenticated";

export type HostedAuthActionId =
  | "sign-in"
  | "sign-in-github"
  | "cancel-authentication"
  | "retry-hub"
  | "pair-device"
  | "dismiss-recovery-codes"
  | "acknowledge-delivery-unknown"
  | "sign-out"
  | "done";

/** A confirmation the surface must present before running an action. */
export interface HostedAuthConfirmation {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly destructive: boolean;
}

export interface HostedAuthAction {
  readonly id: HostedAuthActionId;
  readonly label: string;
  readonly disabled: boolean;
  readonly confirm?: HostedAuthConfirmation;
  readonly run: () => void | Promise<void>;
}

/**
 * The mandatory delivery-unknown acknowledgement.
 *
 * A request may or may not have reached the node, and the runtime deliberately
 * does not resend it. The acknowledgement is the user's, so no surface may
 * auto-dismiss it: it stays in the view model for as long as the session status
 * says so, and only `acknowledgeDeliveryUnknown()` clears it. The action is
 * disabled — never hidden — until replay has settled, so the state is always
 * visible even while it cannot yet be dismissed.
 */
export interface HostedDeliveryUnknownView {
  readonly message: string;
  readonly action: HostedAuthAction;
}

export interface HostedSignInView {
  readonly surface: HostedSignInSurface;
  readonly title: string;
  readonly detail: string;
  /** True while a ceremony or sign-out is in flight; surfaces show a spinner. */
  readonly busy: boolean;
  readonly errorMessage: string | null;
  readonly statusText: HostedConnectionStatusText | null;
  readonly statusIndicator: HostedConnectionStatusIndicator | null;
  readonly recoveryCodes: ReadonlyArray<string>;
  readonly primaryAction: HostedAuthAction | null;
  readonly secondaryAction: HostedAuthAction | null;
  /** Provider-specific entry points advertised by the Hub, in policy order. */
  readonly providerActions: ReadonlyArray<HostedAuthAction>;
  readonly deliveryUnknown: HostedDeliveryUnknownView | null;
}

export interface HostedAccountRow {
  readonly id: HostedAuthActionId;
  readonly label: string;
  readonly value: string | null;
  readonly destructive: boolean;
  readonly confirm?: HostedAuthConfirmation;
  readonly run: () => void;
}

export interface HostedAccountView {
  /** False for a direct-only build: the Settings row must not render at all. */
  readonly available: boolean;
  readonly signedIn: boolean;
  readonly title: string;
  readonly detail: string;
  readonly displayName: string | null;
  readonly roleLabel: string | null;
  readonly statusText: HostedConnectionStatusText | null;
  readonly statusIndicator: HostedConnectionStatusIndicator | null;
  readonly capability: HostedRpcCapability;
  /** The runtime's own explanation of why node actions are unavailable. */
  readonly capabilityNotice: string | null;
  readonly errorMessage: string | null;
  readonly rows: ReadonlyArray<HostedAccountRow>;
  readonly recoveryCodes: ReadonlyArray<string>;
  /**
   * Present exactly while codes are on screen. Rotating them is now an action
   * this surface offers, so the acknowledgement has to live here too: codes
   * displayed with no way to dismiss them would either persist across
   * navigation or be cleared by something other than the user, and the display
   * contract is that the user says when they are done reading.
   *
   * **Disabled — never hidden — while a rotation is in flight.** The codes on
   * screen are the ones that rotation is about to invalidate, so an
   * acknowledgement tapped now says "I saved these" about a set that is
   * seconds from being dead, and clears the display the replacement is due to
   * arrive in. It stays visible so the state is never a mystery, and comes back
   * the moment the new set lands.
   */
  readonly dismissRecoveryCodes: HostedAuthAction | null;
  readonly deliveryUnknown: HostedDeliveryUnknownView | null;
  /** Present only while signed out, so Settings can route to the sheet. */
  readonly signInAction: HostedAuthAction | null;
}

export interface HostedSignInViewInput {
  readonly state: HostedHubState;
  readonly externalIdentityConfiguration: ExternalIdentityConfigResponse | null;
  /** `isMobileHostedModeAvailable()` — hosted config plus a usable hardware key. */
  readonly hostedModeAvailable: boolean;
  /**
   * `useMobileE2eeChannelStatus()` — what `docs/relay-e2ee-protocol.md` §4.4
   * locked on the channel behind this session.
   *
   * REQUIRED, not optional with a benign default. §12.2 makes the legacy label
   * mandatory "in every user-facing surface", and a surface that omitted this
   * would render a fallen-back channel with the same word and the same success
   * colour as a verified one — which is the §2.2 overclaim, arrived at by
   * forgetting rather than by deciding. A required field makes forgetting a type
   * error.
   */
  readonly e2eeStatus: HostedE2eeChannelStatus;
  readonly nativeDeviceSecurityStatus?: HostedNativeDeviceSecurityStatus;
  /** The direct-plane escape hatch offered whenever hosted mode cannot run. */
  readonly onPairDevice: () => void;
  /** Dismiss the sheet once the hosted session is established. */
  readonly onDone: () => void;
}

export interface HostedAccountViewInput {
  readonly state: HostedHubState;
  readonly hostedModeAvailable: boolean;
  /** §4.4's locked mode, for the same reason {@link HostedSignInViewInput} takes it. */
  readonly e2eeStatus: HostedE2eeChannelStatus;
  readonly nativeDeviceSecurityStatus?: HostedNativeDeviceSecurityStatus;
  /** Open the sign-in sheet (the `Onboarding` route). */
  readonly onSignIn: () => void;
  /**
   * What the account surface is currently doing, from `hostedAccountStore`.
   *
   * Read for one reason: while a recovery-code rotation is in flight, the
   * acknowledgement on screen belongs to the set that rotation is about to
   * invalidate. See {@link HostedAccountView.dismissRecoveryCodes}.
   */
  readonly actionStatus: HostedAccountActionStatus;
}

/**
 * The Hub revoked this device's encrypted enrollment (`Device removed`). The
 * revoked enrollment cannot be restored from this session; a new sign-in is
 * what enrolls fresh keys, so that is the one step the copy names.
 */
export const HOSTED_DEVICE_REMOVED_MESSAGE =
  "This device was removed from your Hub's encrypted devices, so it cannot reach your nodes. Sign out, then sign in again to set it up again.";

const DELIVERY_UNKNOWN_MESSAGE =
  "A request may or may not have reached the node. Ryco did not resend it automatically.";

function action(
  id: HostedAuthActionId,
  label: string,
  run: () => void | Promise<void>,
  options?: { readonly disabled?: boolean; readonly confirm?: HostedAuthConfirmation },
): HostedAuthAction {
  const disabled = options?.disabled ?? false;
  return {
    id,
    label,
    disabled,
    ...(options?.confirm ? { confirm: options.confirm } : {}),
    // The guard lives here rather than only in the surface's `disabled` prop: a
    // hardware keyboard, an accessibility action, or a future surface that
    // forgets to pass the flag must not be able to fire a call the state
    // machine is not ready for.
    run: disabled ? () => undefined : run,
  };
}

const signInAction = (label: string): HostedAuthAction =>
  action("sign-in", label, () => hostedHubController.signIn());

/** Generic system-browser handoff for native surfaces that also offer direct credentials. */
export const deriveHostedBrowserSignInAction = (): HostedAuthAction =>
  signInAction("Continue in browser");

/** Provider-specific native handoffs. Policy absence means no affordance. */
export function deriveHostedProviderSignInActions(
  configuration: ExternalIdentityConfigResponse | null,
): ReadonlyArray<HostedAuthAction> {
  const github =
    configuration?.providers.find((provider) => provider.provider === "github") ?? null;
  return github?.login === true
    ? [
        action("sign-in-github", "Continue with GitHub", () =>
          hostedHubController.signInWithExternalProvider("github"),
        ),
      ]
    : [];
}

function statusOf(
  state: HostedHubState,
  e2eeStatus: HostedE2eeChannelStatus,
  nativeDeviceSecurityStatus?: HostedNativeDeviceSecurityStatus,
): {
  readonly text: HostedConnectionStatusText;
  readonly indicator: HostedConnectionStatusIndicator;
} {
  const input = {
    browserStatus: state.browserStatus,
    sessionStatus: state.sessionStatus,
    selectionStatus: state.selectionStatus,
    transportStatus: state.transportStatus,
    e2eeStatus,
    nativeDeviceSecurityStatus,
  };
  return {
    text: deriveHostedConnectionStatusText(input),
    indicator: deriveHostedConnectionStatusIndicator(input),
  };
}

/**
 * The short labels that mean "something is wrong", as opposed to "not there
 * yet". Everything else — Connecting, Preparing, Syncing, Opening — is a
 * transient step and gets the neutral tone rather than an alarming one.
 */
const HOSTED_ATTENTION_LABELS: ReadonlySet<string> = new Set([
  "Unconfirmed",
  "No access",
  "Revoked",
  "Removed",
  "Incompatible",
  "Failed",
  // docs/relay-e2ee-protocol.md §13.1's release gate: an E2EE channel with no
  // verified pin carries the §13.2 ceremony and no application payload. That is
  // a state the owner has to act on, not a step on the way to one.
  "Not verified",
]);

/**
 * The tone a §2.2 claim carries on its own, before connectedness is consulted.
 *
 * EXHAUSTIVE OVER THE GUARANTEE, NOT A CHAIN OF COMPARISONS, and that is the
 * whole point: `guarantee` is the one property §2.2 forbids overstating, so
 * adding a member to it has to force a colour decision rather than fall through
 * to whatever the previous `if` did not claim. An `if (guarantee === "legacy")`
 * chain absorbed `web` silently into the connected branch and handed §2.2's web
 * NX row the verified session's token; the `satisfies never` below is what makes
 * the next member a compile error instead.
 *
 * `undefined` means "this claim does not decide the tone" — `none` is the
 * absence of a claim and `e2ee` is the one claim the success token is for, so
 * both are left to connectedness.
 */
function hostedClaimTone(
  guarantee: HostedConnectionGuarantee,
): Omit<StatusTone, "label"> | undefined {
  switch (guarantee) {
    case "legacy":
      // §12.2 requires a fallen-back channel to be labeled legacy "in every
      // user-facing surface", and a green pill reading `Legacy` is that label
      // wearing the verified session's colour.
      return {
        pillClassName: "bg-warning-bg border border-warning-border",
        textClassName: "text-warning",
      };
    case "web":
    case "account":
      // §2.2's *Web, unsigned ephemeral* row and §2.4's web ceiling: a usable,
      // encrypted channel whose code the Hub serves, so it is neither the
      // fallback amber marks nor the row the success token means. It gets the
      // one remaining connected tone — informational — so the scale reads
      // legacy, then web, then verified, rather than grouping web with the row
      // §2.2 forbids it from claiming.
      return {
        pillClassName: "bg-accent-bg border border-accent-border",
        textClassName: "text-accent-strong",
      };
    case "none":
    case "e2ee":
      return undefined;
    default:
      guarantee satisfies never;
      return undefined;
  }
}

/**
 * Token-class tone for one bounded status, mirroring `connectionTone.ts` for
 * the direct plane. The label is the runtime's own short label — the tone
 * chooses colour only, so a pill can never contradict the word inside it.
 *
 * THERE IS EXACTLY ONE OF THESE, AND IT READS `guarantee`. A second mapper
 * beside it — "the E2EE one" — would be a second opinion about the property
 * `docs/relay-e2ee-protocol.md` §2.2 forbids overstating, and the two would
 * disagree the first time one of them was extended. The rule is stated
 * positively: the success token is reachable only from a CONNECTED session
 * whose guarantee is `none` or `e2ee`. Every other claim is answered above.
 */
export function hostedStatusTone(indicator: HostedConnectionStatusIndicator): StatusTone {
  const claimed = hostedClaimTone(indicator.guarantee);
  if (claimed !== undefined) return { label: indicator.shortLabel, ...claimed };
  if (indicator.connected) {
    return {
      label: indicator.shortLabel,
      pillClassName: "bg-success-bg border border-success-border",
      textClassName: "text-success",
    };
  }
  if (HOSTED_ATTENTION_LABELS.has(indicator.shortLabel)) {
    return {
      label: indicator.shortLabel,
      pillClassName: "bg-danger border border-danger-border",
      textClassName: "text-danger-foreground",
    };
  }
  return {
    label: indicator.shortLabel,
    pillClassName: "bg-subtle",
    textClassName: "text-foreground-muted",
  };
}

function deliveryUnknownView(state: HostedHubState): HostedDeliveryUnknownView | null {
  if (state.sessionStatus !== "delivery-unknown") return null;
  const recovered = state.sessionRecoveredAfterUnknown;
  return {
    message: DELIVERY_UNKNOWN_MESSAGE,
    action: action(
      "acknowledge-delivery-unknown",
      recovered ? "Acknowledge" : "Synchronizing…",
      () => hostedHubController.acknowledgeDeliveryUnknown(),
      { disabled: !recovered },
    ),
  };
}

function roleLabel(state: HostedHubState): string | null {
  const role = state.account?.role ?? null;
  if (role === null) return null;
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

function hostedStateErrorMessage(state: HostedHubState): string | null {
  if (state.errorMessage !== null) return state.errorMessage;
  return state.errorReason ? hostedHubFailureExplanation(state.errorReason).message : null;
}

/** The surface the sign-in sheet shows, in strict precedence order. */
function resolveSignInSurface(input: HostedSignInViewInput): HostedSignInSurface {
  const { state } = input;
  if (!input.hostedModeAvailable) return "unavailable";
  if (state.accountStatus === "unavailable") return "hub-unreachable";
  if (state.accountStatus === "authenticating") return "authenticating";
  if (state.accountStatus === "signing-out") return "signing-out";
  if (state.accountStatus === "session-expired") return "session-expired";
  if (state.accountStatus === "authenticated") {
    // Codes are shown exactly once and are not recoverable afterwards, so they
    // outrank the connected summary until they are acknowledged.
    return state.recoveryCodes.length > 0 ? "recovery-codes" : "authenticated";
  }
  return state.bootstrapAvailable ? "first-run" : "signed-out";
}

/** The hosted sign-in sheet (`Onboarding`), as a bounded view model. */
export function deriveHostedSignInView(input: HostedSignInViewInput): HostedSignInView {
  const { state } = input;
  const surface = resolveSignInSurface(input);
  const pairDevice = action("pair-device", "Add a machine directly", input.onPairDevice);
  const base = {
    surface,
    busy: false,
    errorMessage: hostedStateErrorMessage(state),
    statusText: null,
    statusIndicator: null,
    recoveryCodes: [] as ReadonlyArray<string>,
    primaryAction: null,
    secondaryAction: null,
    providerActions: [] as ReadonlyArray<HostedAuthAction>,
    deliveryUnknown: null,
  } satisfies Omit<HostedSignInView, "title" | "detail">;

  switch (surface) {
    case "unavailable":
      return {
        ...base,
        title: "Hub sign-in unavailable",
        detail:
          "This build has no Ryco Hub, or this device cannot create the hardware-backed key a Hub session requires. Pair a Ryco node directly instead.",
        // Deliberately no error text: `errorMessage` describes the hosted
        // session, and there is no hosted session to describe.
        errorMessage: null,
        primaryAction: pairDevice,
      };
    case "hub-unreachable":
      return {
        ...base,
        title: "Hub unavailable",
        detail: "Ryco could not reach your Hub. Check your connection and try again.",
        primaryAction: action("retry-hub", "Try again", () => void hostedHubController.bootstrap()),
        secondaryAction: pairDevice,
      };
    case "authenticating":
      return {
        ...base,
        title: "Finish in your browser",
        detail: "Sign in to your Hub and approve this device. Ryco will return here automatically.",
        busy: true,
        primaryAction: action("cancel-authentication", "Cancel", () =>
          hostedHubController.cancelAuthentication(),
        ),
      };
    case "signing-out":
      return {
        ...base,
        title: "Signing out",
        detail: "Ending this device's Hub session.",
        busy: true,
      };
    case "session-expired":
      return {
        ...base,
        title: "Your session expired",
        detail: "Continue in your browser to reconnect this device to your Hub.",
        primaryAction: signInAction("Continue in browser"),
        providerActions: deriveHostedProviderSignInActions(input.externalIdentityConfiguration),
      };
    case "first-run":
      return {
        ...base,
        title: "Set up your Hub",
        detail:
          "This Hub has no account yet. Continue in your browser to create the first owner, then approve this device.",
        primaryAction: signInAction("Continue in browser"),
        providerActions: deriveHostedProviderSignInActions(input.externalIdentityConfiguration),
      };
    case "recovery-codes":
      return {
        ...base,
        title: "Save your recovery codes",
        detail: "These codes are shown once. Ryco does not store them on this device.",
        recoveryCodes: state.recoveryCodes,
        primaryAction: action("dismiss-recovery-codes", "I saved the codes", () =>
          hostedHubController.dismissRecoveryCodes(),
        ),
      };
    case "authenticated": {
      const status = statusOf(state, input.e2eeStatus, input.nativeDeviceSecurityStatus);
      return {
        ...base,
        title: "Connected to your Hub",
        detail:
          state.account === null
            ? "This device has a Hub session."
            : `Signed in as ${state.account.displayName}.`,
        statusText: status.text,
        statusIndicator: status.indicator,
        deliveryUnknown: deliveryUnknownView(state),
        primaryAction: action("done", "Done", input.onDone),
      };
    }
    case "signed-out":
      return {
        ...base,
        title: "Connect to your Hub",
        detail:
          "Continue in your browser, choose any sign-in method your Hub supports, then approve this device.",
        primaryAction: signInAction("Continue in browser"),
        providerActions: deriveHostedProviderSignInActions(input.externalIdentityConfiguration),
      };
  }
}

/**
 * The session rows.
 *
 * Sign-out only. "Add this device" and "Recovery codes" used to hand off to the
 * Hub's web app from here, because the shared runtime exposed no client method
 * for either ceremony. It does now, and both are DPoP-native — so they live in
 * `hostedAccountModel.ts` alongside password, two-factor, and email, and this
 * model no longer reaches the browser at all from an authenticated session.
 */
function accountRows(state: HostedHubState): ReadonlyArray<HostedAccountRow> {
  const row = (
    id: HostedAuthActionId,
    label: string,
    run: () => void,
    extras?: {
      readonly value?: string;
      readonly destructive?: boolean;
      readonly confirm?: HostedAuthConfirmation;
    },
  ): HostedAccountRow => ({
    id,
    label,
    value: extras?.value ?? null,
    destructive: extras?.destructive ?? false,
    ...(extras?.confirm ? { confirm: extras.confirm } : {}),
    run,
  });

  return [
    row("sign-out", "Sign out", () => void hostedHubController.signOut(), {
      destructive: true,
      confirm: {
        title: "Sign out of your Hub?",
        message:
          state.selectedNode === null
            ? "This device's Hub session ends. Directly paired devices are unaffected."
            : `This device's Hub session ends and ${state.selectedNode.label} disconnects. Directly paired devices are unaffected.`,
        confirmText: "Sign out",
        destructive: true,
      },
    }),
  ];
}

/** The hosted account surface in Settings, as a bounded view model. */
export function deriveHostedAccountView(input: HostedAccountViewInput): HostedAccountView {
  const { state } = input;
  const capability = resolveHostedRpcCapability({
    hosted: input.hostedModeAvailable,
    role: state.effectiveRole,
    fresh: state.directoryStatus === "ready" && state.transportStatus === "online",
    browserCurrent: state.browserStatus === "current",
    sessionReady: state.sessionStatus === "ready",
    method: HOSTED_CAPABILITY_METHOD,
  });
  const base = {
    available: input.hostedModeAvailable,
    capability,
    capabilityNotice: capability.allowed ? null : capability.reason,
    errorMessage: hostedStateErrorMessage(state),
    displayName: null,
    roleLabel: null,
    statusText: null,
    statusIndicator: null,
    rows: [] as ReadonlyArray<HostedAccountRow>,
    recoveryCodes: [] as ReadonlyArray<string>,
    dismissRecoveryCodes: null,
    deliveryUnknown: null,
    signInAction: null,
  } satisfies Omit<HostedAccountView, "signedIn" | "title" | "detail">;

  if (!input.hostedModeAvailable) {
    // Nothing about the hosted plane is reachable, so nothing about it renders
    // — not even a disabled row that would imply a broken feature.
    return {
      ...base,
      capabilityNotice: null,
      errorMessage: null,
      signedIn: false,
      title: "Hub unavailable",
      detail: "This build has no Ryco Hub.",
    };
  }

  if (state.accountStatus !== "authenticated" || state.account === null) {
    return {
      ...base,
      signedIn: false,
      title: "Not signed in",
      detail:
        state.accountStatus === "session-expired"
          ? "Your Hub session expired. Continue in your browser to reconnect this device."
          : "Continue in your browser to sign in and reach the nodes on your Hub.",
      signInAction: action("sign-in", "Continue in browser", input.onSignIn),
    };
  }

  const status = statusOf(state, input.e2eeStatus, input.nativeDeviceSecurityStatus);
  return {
    ...base,
    signedIn: true,
    title: state.account.displayName,
    // What this device can actually attest to. Nothing the client or the Hub
    // exposes says which credential minted the session, so claiming "signed in
    // with a passkey" would state as fact something that could as easily be a
    // password or a recovery code — the one thing the account copy must never
    // do. The DPoP binding, by contrast, is true of every session this app
    // holds.
    detail:
      input.nativeDeviceSecurityStatus === "revoked"
        ? HOSTED_DEVICE_REMOVED_MESSAGE
        : "Every request from this device is signed with a key held in its secure hardware.",
    displayName: state.account.displayName,
    roleLabel: roleLabel(state),
    statusText: status.text,
    statusIndicator: status.indicator,
    rows: accountRows(state),
    recoveryCodes: state.recoveryCodes,
    dismissRecoveryCodes:
      state.recoveryCodes.length > 0
        ? action(
            "dismiss-recovery-codes",
            "I saved the codes",
            () => hostedHubController.dismissRecoveryCodes(),
            { disabled: input.actionStatus === "regenerating-recovery-codes" },
          )
        : null,
    deliveryUnknown: deliveryUnknownView(state),
  };
}
