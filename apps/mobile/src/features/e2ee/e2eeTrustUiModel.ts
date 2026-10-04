import {
  E2EE_SAFETY_NUMBER_DIGITS,
  E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS,
} from "@ryco/shared/relayE2eeConstants";
import { verifyNativeTrustApprovalQr } from "@ryco/client-runtime/authorization";

import {
  attachMobileE2eeLocalNodeHandle,
  clearMobileE2eeTrustEvent,
  type MobileE2eeIdentityDisplay,
  type MobileE2eeLocalDiagnostic,
  type MobileE2eeSelection,
  type MobileE2eeSessionState,
} from "../../hostedHub/e2eeSession";
import {
  e2eeUnexpectedNodeResolutions,
  type E2eeTrustRecordIndex,
} from "../../platform/e2eeTrustModel";
import {
  mintE2eeOwnerLegacyConsentDecision,
  mintE2eeOwnerUnresolvedLegacyConsentDecision,
  mintE2eeOwnerVerificationDecision,
  mobileE2eeTrustStore,
} from "../../platform/e2eeTrustStore";

/**
 * Every owner-facing decision and string of the §13 trust surfaces —
 * docs/relay-e2ee-protocol.md §13.1.1 (the persistent indication), §13.2 (the
 * pairing ceremony), §13.2.1 (the three unexpected situations), §13.3 (rotation
 * and the owner-initiated re-pair), §13.4 (the safety number), §11.4 (the local
 * diagnostics), and §2.2 / §2.3 / §12.2 (honest labeling).
 *
 * Free of `react-native` and of React, the convention `hostedAuthModel.ts`
 * documents and every hosted surface follows: the RN packages ship untranspiled
 * Flow the vp/node runner cannot parse, so a decision, a string, or a choice of
 * which action fires written inside a `.tsx` is untestable. The `.tsx` files are
 * layout.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS MODULE IS THE ONLY PLACE A §13.2 STEP 5 DECISION IS MINTED
 * ─────────────────────────────────────────────────────────────────────────────
 * `mintE2eeOwnerVerificationDecision` is the sole constructor of the token
 * `mobileE2eeTrustStore.promote` requires, and {@link confirmE2eeVerification} is
 * the sole caller of it in this application. §13.2 closes with "In no flow may a
 * product silently promote a self-signed first-contact key to a verified pin",
 * and that is held structurally rather than by convention: the token is branded
 * so it cannot be written as a literal, its minting re-derives the §13.4 value
 * from BOTH identity keys, and `e2eeTrustUiSurface.test.ts` fails the build if the
 * identifier appears at any other call site under `apps/mobile/src`. The action
 * that reaches it is ABSENT — not disabled — until the owner has said, on this
 * screen, that they compared the number against the node's own surface.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE COPY MAY NOT SAY
 * ─────────────────────────────────────────────────────────────────────────────
 * Three limits, each of them a specification rule rather than a style choice:
 *
 * 1. **No stronger claim for a weaker configuration** (§2.2, §12.2). A legacy
 *    channel is called legacy in every string here and carries no E2EE or
 *    active-Hub wording; an `unverified` pin claims nothing at all.
 * 2. **No claim of survival** (§2.3): "Disclosure text MUST NOT describe native
 *    downgrade resistance as surviving reinstall, restore, or device transfer."
 *    The copy says the opposite, because §13.1.1 makes it true.
 * 3. **No explanation this client does not have.** Every §11.2 pre-key failure is
 *    byte-identical on the wire — one fixed-length reject and a
 *    `channel.close(channel_rejected)`, with no cause and no code — so "not
 *    approved", "revoked", "rate limited", "tier forbidden", "clock wrong" and
 *    "prekey expired" are indistinguishable to this app. Nothing below claims to
 *    know which happened; the only causes named are ones this device concluded
 *    about itself (§11.4).
 */

/* -------------------------------------------------------------------------- */
/* §13.4 rendering                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Split the §13.4 display value into its groups, in derivation order.
 *
 * The rendering is the shared derivation's (`renderE2eeSafetyNumber`); this only
 * re-splits it for a grid, and refuses anything that is not the exact format —
 * `E2EE_SAFETY_NUMBER_DIGITS.groups` runs of `digitsPerGroup` decimal digits. A
 * surface that silently re-grouped, truncated, or reordered would be showing the
 * owner a different value from the node CLI in the one ceremony that consists of
 * comparing the two, and §13.4 is explicit that "the fixed length and grouping
 * are the checksum — there is no separate check digit".
 */
export function e2eeSafetyNumberGroups(display: string): readonly string[] {
  const groups = display.split(E2EE_SAFETY_NUMBER_DIGITS.separator);
  if (groups.length !== E2EE_SAFETY_NUMBER_DIGITS.groups) return [];
  for (const group of groups) {
    if (group.length !== E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup) return [];
    if (!/^\d+$/.test(group)) return [];
  }
  return groups;
}

/** True only for a value in the exact §13.4 display format. */
export function isE2eeSafetyNumberDisplay(display: string): boolean {
  return e2eeSafetyNumberGroups(display).length === E2EE_SAFETY_NUMBER_DIGITS.groups;
}

/**
 * What the screen says about the number itself.
 *
 * The entropy floor is quoted from the constant rather than written into the
 * sentence, so a change to §13.4's length cannot leave a stale claim behind.
 */
export const E2EE_SAFETY_NUMBER_CAPTION =
  `Compare all ${E2EE_SAFETY_NUMBER_DIGITS.groups} groups with the number your node shows. ` +
  `They are ${E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS} bits of check value in a fixed order — ` +
  "there is no shortcut, and no check digit to read instead.";

/* -------------------------------------------------------------------------- */
/* The four messages §13.2.1 and §13.3 require to differ                       */
/* -------------------------------------------------------------------------- */

/**
 * §13.2.1's three situations and §13.3's identity change, as four strings that
 * are never the same string.
 *
 * §13.2.1: "The presentation MUST distinguish the three underlying situations in
 * its copy, because they carry different meanings for the owner … Conflating them
 * re-creates exactly the click-through training §13.3 opens by forbidding."
 * Situation 3 in particular "MUST NOT be worded as an identity change": no
 * previously verified fingerprint is being contradicted there, so saying one was
 * would be false.
 */
export const E2EE_UNEXPECTED_NODE_MESSAGES = {
  /** Situation 1: a new node on an account that already has verified ones. */
  1: "You have other verified nodes on this account, but this one is new. Pair it before this device will send anything to it.",
  /** Situation 2: a first-contact identity under an account holding a pin. */
  2: "This account already has a verified node, and this connection is presenting a different identity. Compare both sets below before you continue — if the fingerprint and number on the right are not the ones your node shows, do not pair it.",
  /** Situation 3: the account-scope change. Deliberately NOT an identity change. */
  3: "This device has verified nodes on this Hub, but not for this account. Nothing you verified before is being contradicted — this account simply has no verified node yet.",
} as const satisfies Record<1 | 2 | 3, string>;

/** §13.3's message, and the only one of the four that reports a contradiction. */
export const E2EE_IDENTITY_CHANGE_MESSAGE =
  "The node you previously verified is presenting a different identity, and it did not prove that the change was a legitimate rotation. This device is sending nothing to it. Verify the new fingerprint and number against your node before pairing again.";

/**
 * The heading each of those four carries, one per situation.
 *
 * §13.2.1 requires the surface to "distinguish the three underlying situations
 * in its copy", and a shared heading over three different bodies is the
 * conflation it forbids. Situation 3 in particular is NOT worded as an identity
 * change, in the heading as well as in the body.
 */
export const E2EE_UNEXPECTED_NODE_TITLES = {
  1: "A node this device has not paired",
  2: "This connection is presenting a different identity",
  3: "No verified node for this account",
} as const satisfies Record<1 | 2 | 3, string>;

/** §13.3's heading, and the only one of the four that reports a contradiction. */
export const E2EE_IDENTITY_CHANGE_TITLE = "The node you verified changed identity";

/** All four, for the surface and for the test that asserts they differ. */
export const E2EE_TRUST_SITUATION_MESSAGES: readonly string[] = [
  E2EE_UNEXPECTED_NODE_MESSAGES[1],
  E2EE_UNEXPECTED_NODE_MESSAGES[2],
  E2EE_UNEXPECTED_NODE_MESSAGES[3],
  E2EE_IDENTITY_CHANGE_MESSAGE,
];

/* -------------------------------------------------------------------------- */
/* Bounded copy                                                                */
/* -------------------------------------------------------------------------- */

/**
 * §13.1.1's persistent indication. It is never a transient banner, it never
 * dismisses into a verified-looking state, and it states the §2.3 limit plainly
 * in the same breath — a device that has verified nothing has verified nothing,
 * and reinstalling is one of the ordinary ways to get here.
 */
export const E2EE_NO_VERIFIED_NODE_TITLE = "No verified node on this Hub";
export const E2EE_NO_VERIFIED_NODE_MESSAGE =
  "This device has not verified any node on this Hub, so it claims no protection against the Hub itself for anything it sends. Verification lives only on this device: reinstalling Ryco, restoring a backup, or moving to a new phone clears it, and this is what that looks like afterwards.";

/** §12.2's honest label for a channel that fell back, in the words a screen uses. */
export const E2EE_LEGACY_CHANNEL_LABEL = "legacy";
export const E2EE_LEGACY_CHANNEL_MESSAGE =
  "This connection is legacy: Ryco is not encrypting it end to end, and your Hub can read what crosses it. Pair the node to change that.";

/**
 * §6.3's other legacy channel, which is NOT the one pairing fixes.
 *
 * "A device that cannot hold the key simply has no E2EE" — there is no software
 * fallback and no degraded mode — so on such a device no ceremony can produce an
 * encrypted channel. Offering the §12.2 sentence here would point the owner at an
 * action that cannot deliver what it implies, which is the same overclaim §2.2
 * forbids wearing different clothes.
 */
export const E2EE_NO_KEY_CUSTODY_MESSAGE =
  "This connection is legacy: Ryco is not encrypting it end to end, and your Hub can read what crosses it. This device cannot hold the key end-to-end encryption needs, so pairing a node will not change that here.";

/** §13.1's release gate, stated as the reason nothing is flowing. */
export const E2EE_PAIRING_ONLY_MESSAGE =
  "This connection is carrying the pairing ceremony and nothing else. No project, conversation, or terminal data is sent to a node this device has not verified.";

/** §2.2's bottom row, and no word of it beyond what that row grants. */
export const E2EE_VERIFIED_CHANNEL_MESSAGE =
  "This connection is encrypted end to end to a node you verified on this device. Your Hub relays it and cannot read it.";

/**
 * The pre-key limit, said out loud.
 *
 * §11.2's uniform observable and §11.5's acceptance observable mean this app
 * genuinely cannot tell the owner why a pairing attempt ended. Saying so is the
 * only truthful copy; inventing a likely cause would be the app guessing.
 */
export const E2EE_PAIRING_OUTCOME_MESSAGE =
  "A pairing attempt always ends without the node accepting this device — that is what the ceremony is. Ryco is not told why any attempt ended, so it cannot tell you whether the node has your key on file yet. Approve this device on the node, then reconnect.";

/**
 * The §13.2 first-contact ceremony, enrollment-fingerprint-first.
 *
 * §13.2's final paragraph permits it — "A product MAY instead require entry of
 * the node enrollment fingerprint before any pairing exchange; in that flow the
 * client verifies the advertised identity fingerprint against the entered value
 * before sending the pairing hello" — and it is preferred here because it is a
 * trust anchor the owner carries from the node itself, rather than one that
 * depends on a round trip the Hub sits in the middle of.
 */
export const E2EE_ENROLLMENT_FINGERPRINT_TITLE = "Enter the node's fingerprint";
export const E2EE_ENROLLMENT_FINGERPRINT_MESSAGE =
  "Run the enrollment command on the node itself and type the fingerprint it prints. Ryco compares it against the identity this connection advertised — on this device, without asking the node or the Hub. Pairing does not start until they match.";
export const E2EE_ENROLLMENT_FINGERPRINT_MISMATCH =
  "That is not the fingerprint this connection advertised. Nothing was sent. Check that you read it from the node you meant to reach.";
export const E2EE_ENROLLMENT_FINGERPRINT_PLACEHOLDER = "SHA256:…";

/**
 * §13.2 step 4's affirmation, and the two column titles it is read against.
 *
 * The affirmation is the sentence whose acknowledgement is the ONLY precondition
 * for the action that mints a §13.2 step 5 decision, so it is the one string in
 * the ceremony that carries the security meaning of the whole flow. It lives here
 * with the rest of the copy — a `.tsx` cannot be loaded by the node runner, so a
 * future edit weakening it there would be invisible to every test.
 */
export const E2EE_COMPARISON_AFFIRMATION =
  "I compared every group with the number my node shows, and they are the same.";
export const E2EE_PREVIOUSLY_VERIFIED_COLUMN_TITLE = "Verified before";
export const E2EE_PRESENTED_COLUMN_TITLE = "Presented now";

/** What a build with no hosted plane says instead of a security surface. */
export const E2EE_NO_HOSTED_PLANE_MESSAGE =
  "This build has no Ryco Hub, so there is no relay connection to secure.";

/** The approve-on-node alternative, offered second rather than instead. */
export const E2EE_NODE_APPROVAL_MESSAGE =
  "If you would rather start from the node: pair from here, then run the pending-client command on the node, compare the number it lists for this device, and approve it there.";

/**
 * §13.3's owner-initiated re-pair. "It is owner-initiated by requirement:
 * nothing the Hub sends may trigger, suggest, or pre-select it."
 */
export const E2EE_REPAIR_TITLE = "Forget this node's identity?";
export const E2EE_REPAIR_MESSAGE =
  "Ryco clears what it verified about this node — the pinned identity, the recorded chain, and any legacy exception you recorded for it — and asks you to pair it again from scratch. Other nodes are unaffected.";

/** §13.2.1's second resolution, when local policy still permits legacy. */
export const E2EE_LEGACY_CONSENT_TITLE = "Connect without encryption?";
export const E2EE_LEGACY_CONSENT_MESSAGE =
  "Ryco will send this node's traffic unencrypted from now on, and your Hub can read it. This applies to this node only, it is remembered until you clear it, and it is never assumed from a dismissed screen.";

/** §11.4, stated as the limit it is. */
export const E2EE_DIAGNOSTICS_CAPTION =
  "What this device concluded on its own. None of it is sent anywhere, and none of it came from the node — the relay reports the same thing for every failure.";

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

export type E2eeTrustActionId =
  | "start-pairing"
  | "confirm-verification"
  | "record-legacy-consent"
  | "re-pair"
  | "destroy-unreadable-trust-state"
  | "open-verification"
  | "dismiss";

export interface E2eeTrustConfirmation {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly destructive: boolean;
}

export interface E2eeTrustAction {
  readonly id: E2eeTrustActionId;
  readonly label: string;
  readonly destructive: boolean;
  readonly confirm?: E2eeTrustConfirmation;
  readonly run: () => void;
}

function action(
  id: E2eeTrustActionId,
  label: string,
  run: () => void,
  options?: { readonly destructive?: boolean; readonly confirm?: E2eeTrustConfirmation },
): E2eeTrustAction {
  return {
    id,
    label,
    destructive: options?.destructive ?? false,
    ...(options?.confirm ? { confirm: options.confirm } : {}),
    run,
  };
}

/* -------------------------------------------------------------------------- */
/* The verification ceremony                                                   */
/* -------------------------------------------------------------------------- */

export type E2eeVerificationStage =
  /** §13.2's preferred first contact: the owner enters the node's fingerprint. */
  | "enrollment-fingerprint"
  /** §13.2 step 4/5: both sides display the number and the owner compares. */
  | "compare"
  /** Nothing to verify: no statement validated on this channel (rows K23/K24). */
  | "no-evidence";

/**
 * The cross-device QR path is an alternative to entering the enrollment
 * fingerprint. Once that anchor matches, leaving the alternative visible both
 * misstates the current step and can push the comparison action out of the
 * native sheet's usable viewport.
 */
export function shouldShowE2eeApprovalScanner(stage: E2eeVerificationStage): boolean {
  return stage === "enrollment-fingerprint";
}

/**
 * The screen's own editing state. Flat and owned by the surface, so the model
 * stays a function of state — and so the comparison acknowledgement is a value
 * the test can assert about rather than a checkbox nobody can reach.
 */
export interface E2eeVerificationDraft {
  readonly enteredFingerprint: string;
  /** The owner saying, on this screen, that they compared §13.4's value. */
  readonly comparisonAcknowledged: boolean;
  readonly busy: boolean;
  readonly errorMessage: string | null;
}

export function createE2eeVerificationDraft(): E2eeVerificationDraft {
  return {
    enteredFingerprint: "",
    comparisonAcknowledged: false,
    busy: false,
    errorMessage: null,
  };
}

export interface E2eeVerificationView {
  readonly stage: E2eeVerificationStage;
  readonly title: string;
  readonly message: string;
  /** The node's Hub-supplied label, for naming the selection. Display only. */
  readonly nodeLabel: string | null;
  /** The identity this channel advertised, once a statement validated. */
  readonly presented: MobileE2eeIdentityDisplay | null;
  /**
   * §13.2.1 situation 2's other half. Present ONLY in situation 2, because
   * §13.2.1 forbids showing a previously verified fingerprint in situation 3:
   * "no previously verified fingerprint is being contradicted, so displaying one
   * would be misleading."
   */
  readonly previouslyVerified: MobileE2eeIdentityDisplay | null;
  readonly safetyNumberGroups: readonly string[];
  readonly safetyNumberCaption: string;
  readonly fingerprintPlaceholder: string;
  readonly fingerprintValue: string;
  /**
   * §13.2's mismatch warning, or `null`.
   *
   * WHEN it appears is a decision, not a layout detail, which is why it is a
   * value here rather than a `length > 0` test in the screen. The sentence means
   * "you may be looking at a node you did not mean to reach"; rendering it from
   * the first keystroke of a CORRECT fingerprint shows it on every successful
   * entry too, and training the owner to read past it is precisely what §13.2
   * and §13.3 spend their warnings trying to avoid. It appears only once the
   * entry is long enough to be a complete fingerprint and still does not match.
   */
  readonly fingerprintError: string | null;
  readonly onChangeFingerprint: (value: string) => void;
  readonly comparisonAcknowledged: boolean;
  readonly onAcknowledgeComparison: (value: boolean) => void;
  readonly errorMessage: string | null;
  readonly busy: boolean;
  /**
   * The §13.2 step 5 promotion. ABSENT — not disabled — until the owner has both
   * matched the enrollment fingerprint and said they compared the number.
   */
  readonly confirm: E2eeTrustAction | null;
  /** The approve-on-node alternative's explanation. Never a default. */
  readonly nodeApprovalMessage: string;
  readonly outcomeMessage: string;
  readonly dismiss: E2eeTrustAction;
}

export interface E2eeVerificationInput {
  readonly session: MobileE2eeSessionState;
  readonly draft: E2eeVerificationDraft;
  readonly onDraftChange: (draft: E2eeVerificationDraft) => void;
  readonly onCompleted: () => void;
  readonly now: () => number;
}

/** Whitespace-insensitive, case-sensitive: a §7.1 fingerprint is base64 material. */
function normalizeFingerprint(value: string): string {
  return value.replaceAll(/\s+/gu, "");
}

function fingerprintMatches(entered: string, advertised: string): boolean {
  const left = normalizeFingerprint(entered);
  return left.length > 0 && left === normalizeFingerprint(advertised);
}

/**
 * Whether a non-matching entry is long enough to be an ANSWER rather than a
 * prefix. §7.1 fixes the display form's length, so an entry that has reached it
 * and still disagrees is a mismatch; anything shorter is still being typed.
 */
function fingerprintEntryComplete(entered: string, advertised: string): boolean {
  return normalizeFingerprint(entered).length >= normalizeFingerprint(advertised).length;
}

/**
 * The §13.2 ceremony as a view model.
 *
 * The gate order is the specification's: the enrollment fingerprint is checked
 * BEFORE anything else is offered ("the client verifies the advertised identity
 * fingerprint against the entered value before sending the pairing hello"), and
 * the promotion is offered only after the owner has also compared the §13.4
 * value, which is §13.2 step 5's own wording.
 */
export function deriveE2eeVerificationView(input: E2eeVerificationInput): E2eeVerificationView {
  const { session, draft } = input;
  const selection = session.selection;
  const presented = session.presented;
  const situation = session.event?.kind === "unexpected-node" ? session.event.situation : null;
  const identityChanged = session.event?.kind === "identity-change";

  const set = (patch: Partial<E2eeVerificationDraft>) =>
    input.onDraftChange({ ...draft, ...patch });

  const dismiss = action("dismiss", "Close", () => {
    clearMobileE2eeTrustEvent(selection?.environmentId);
    input.onCompleted();
  });

  const base = {
    nodeLabel: selection?.nodeLabel ?? null,
    // §13.2.1 situation 3 is the one case that must NOT display a previously
    // verified fingerprint, and situation 2 is the one that must.
    previouslyVerified: situation === 2 ? session.previouslyVerified : null,
    safetyNumberCaption: E2EE_SAFETY_NUMBER_CAPTION,
    fingerprintPlaceholder: E2EE_ENROLLMENT_FINGERPRINT_PLACEHOLDER,
    fingerprintValue: draft.enteredFingerprint,
    fingerprintError: null,
    onChangeFingerprint: (value: string) => set({ enteredFingerprint: value, errorMessage: null }),
    comparisonAcknowledged: draft.comparisonAcknowledged,
    onAcknowledgeComparison: (value: boolean) => set({ comparisonAcknowledged: value }),
    errorMessage: draft.errorMessage,
    busy: draft.busy,
    nodeApprovalMessage: E2EE_NODE_APPROVAL_MESSAGE,
    outcomeMessage: E2EE_PAIRING_OUTCOME_MESSAGE,
    dismiss,
  };

  const headline = identityChanged
    ? E2EE_IDENTITY_CHANGE_MESSAGE
    : situation !== null
      ? E2EE_UNEXPECTED_NODE_MESSAGES[situation]
      : E2EE_ENROLLMENT_FINGERPRINT_MESSAGE;

  if (selection === null || presented === null) {
    // Rows K23/K24: the carrier never arrived, or `T_ADV` expired. There is no
    // advertised identity to compare, so no ceremony can run on this channel and
    // the surface says exactly that rather than offering an empty comparison.
    return {
      ...base,
      stage: "no-evidence",
      title: E2EE_NO_VERIFIED_NODE_TITLE,
      message: headline,
      presented: null,
      safetyNumberGroups: [],
      confirm: null,
    };
  }

  const matched = fingerprintMatches(draft.enteredFingerprint, presented.display.fingerprint);
  if (!matched) {
    return {
      ...base,
      stage: "enrollment-fingerprint",
      title: E2EE_ENROLLMENT_FINGERPRINT_TITLE,
      message: headline,
      fingerprintError: fingerprintEntryComplete(
        draft.enteredFingerprint,
        presented.display.fingerprint,
      )
        ? E2EE_ENROLLMENT_FINGERPRINT_MISMATCH
        : null,
      presented: presented.display,
      // Nothing of §13.4 is shown before the anchor matches: the number is only
      // meaningful once the owner has established which node they are looking at.
      safetyNumberGroups: [],
      confirm: null,
    };
  }

  return {
    ...base,
    stage: "compare",
    title: "Compare the safety number",
    message: headline,
    presented: presented.display,
    safetyNumberGroups: e2eeSafetyNumberGroups(presented.display.safetyNumber),
    // The explicit user act, as a surface property: there is no disabled button
    // to re-enable, no default to fall through, and no other construction site.
    confirm: draft.comparisonAcknowledged
      ? action("confirm-verification", "The numbers match — verify this node", () => {
          if (draft.busy) return;
          set({ busy: true, errorMessage: null });
          void (async () => {
            const failed = await confirmE2eeVerification({
              session,
              decidedAt: input.now(),
            });
            if (failed !== null) {
              input.onDraftChange({ ...draft, busy: false, errorMessage: failed });
              return;
            }
            input.onDraftChange({ ...createE2eeVerificationDraft() });
            clearMobileE2eeTrustEvent(selection?.environmentId);
            input.onCompleted();
          })();
        })
      : null,
  };
}

/**
 * §13.2 step 2's handle: the selection's own record, or one minted now — the
 * ordinary shape, because a channel that reached first contact resolved to no
 * record at all — and attached to the session so a retry reuses it.
 */
async function ceremonyIndex(selection: MobileE2eeSelection): Promise<E2eeTrustRecordIndex> {
  if (selection.localNodeHandle !== null) {
    return {
      hubOrigin: selection.hubOrigin,
      accountId: selection.accountId,
      localNodeHandle: selection.localNodeHandle,
    };
  }
  const index = await mobileE2eeTrustStore.beginPairing({
    hubOrigin: selection.hubOrigin,
    accountId: selection.accountId,
    nodeId: selection.nodeId,
    ...(selection.environmentId === null ? {} : { environmentId: selection.environmentId }),
  });
  attachMobileE2eeLocalNodeHandle(index.localNodeHandle, "unverified", selection.environmentId);
  return index;
}

/**
 * §13.2 step 5, and the only call to the decision minter in this application.
 *
 * Returns `null` on success, or one bounded message. NOTHING about the failure —
 * not the fingerprint, not the origin, not the account scope, not the handle —
 * travels out of the trust store, and nothing is added to it here.
 */
async function confirmE2eeVerification(input: {
  readonly session: MobileE2eeSessionState;
  readonly decidedAt: number;
}): Promise<string | null> {
  const { session } = input;
  const selection = session.selection;
  const presented = session.presented;
  if (selection === null || selection.clientIdentityPublicKey === null || presented === null) {
    return E2EE_VERIFICATION_UNAVAILABLE;
  }
  try {
    const index = await ceremonyIndex(selection);
    const decision = mintE2eeOwnerVerificationDecision({
      index,
      nodeIdentityPublicKey: presented.nodeIdentityPublicKey,
      clientIdentityPublicKey: selection.clientIdentityPublicKey,
      // The value this screen DISPLAYED. The minter re-derives it from both keys
      // and refuses a mismatch, so a screen that rendered anything else cannot
      // produce a decision — which is the property, not the round trip.
      comparedSafetyNumber: presented.display.safetyNumber,
      continuityId: presented.continuityId,
      acceptedPolicyGeneration: presented.policyGeneration,
      decidedAt: input.decidedAt,
    });
    await mobileE2eeTrustStore.promote(decision);
    return null;
  } catch {
    return E2EE_VERIFICATION_UNAVAILABLE;
  }
}

/**
 * The one-scan cross-device path. The shared verifier checks the node signature,
 * current statement/selection, continuity, policy generation, and this device's
 * hardware-backed client key before the same branded promotion path is used.
 */
export async function confirmE2eeApprovalQr(input: {
  readonly session: MobileE2eeSessionState;
  readonly payload: string;
  readonly decidedAt: number;
}): Promise<string | null> {
  const { session } = input;
  const selection = session.selection;
  const presented = session.presented;
  if (
    selection === null ||
    selection.nodeId === null ||
    selection.clientIdentityPublicKey === null ||
    presented === null
  ) {
    return E2EE_VERIFICATION_UNAVAILABLE;
  }
  const verification = verifyNativeTrustApprovalQr({
    payload: input.payload,
    hubOrigin: selection.hubOrigin,
    accountId: selection.accountId,
    nodeId: selection.nodeId,
    nodeIdentityPublicKey: presented.nodeIdentityPublicKey,
    clientIdentityPublicKey: selection.clientIdentityPublicKey,
    nodeContinuityId: presented.continuityId,
    nodePolicyGeneration: presented.policyGeneration,
    now: input.decidedAt,
    requiredRole: "owner",
    requiredCapability: "ryco.rpc",
  });
  if (!verification.ok) return E2EE_APPROVAL_QR_INVALID;
  const { approval } = verification;

  try {
    const index = await ceremonyIndex(selection);
    const decision = mintE2eeOwnerVerificationDecision({
      index,
      nodeIdentityPublicKey: presented.nodeIdentityPublicKey,
      clientIdentityPublicKey: selection.clientIdentityPublicKey,
      comparedSafetyNumber: presented.display.safetyNumber,
      continuityId: presented.continuityId,
      acceptedPolicyGeneration: presented.policyGeneration,
      approvedAt: approval.approvedAt,
      decidedAt: input.decidedAt,
    });
    await mobileE2eeTrustStore.promote(decision);
    clearMobileE2eeTrustEvent(selection.environmentId);
    return null;
  } catch {
    return E2EE_VERIFICATION_UNAVAILABLE;
  }
}

/**
 * Put this selection's record into §13.2 pairing, which makes the next
 * connection pairing-only. No node key is trusted here and the pairing channel
 * cannot carry application data; its sole purpose is to let the node
 * authenticate this phone's client key and create the pending record the owner
 * will approve.
 */
export async function requestE2eeApproval(session: MobileE2eeSessionState): Promise<string | null> {
  const selection = session.selection;
  if (
    selection === null ||
    selection.clientIdentityPublicKey === null ||
    session.presented === null ||
    session.pinVerified ||
    selection.localRecordState === "verified"
  ) {
    return E2EE_VERIFICATION_UNAVAILABLE;
  }
  // Already requested: the caller's reconnect is the whole retry.
  if (selection.localRecordState === "unverified") return null;
  try {
    if (selection.localNodeHandle === null) {
      await ceremonyIndex(selection);
      return null;
    }
    // A legacy consent's no-pin record: a handle that never sent a pairing hello.
    await mobileE2eeTrustStore.beginPairingForRecord({
      hubOrigin: selection.hubOrigin,
      accountId: selection.accountId,
      localNodeHandle: selection.localNodeHandle,
    });
    attachMobileE2eeLocalNodeHandle(
      selection.localNodeHandle,
      "unverified",
      selection.environmentId,
    );
    return null;
  } catch {
    return E2EE_VERIFICATION_UNAVAILABLE;
  }
}

/**
 * Whether this phone has asked the node for approval: its record is in §13.2
 * pairing. A handle alone is not that, because a legacy consent's no-pin record
 * and a verified pin carry one too, and neither sent a pairing hello.
 */
export function isE2eeApprovalRequested(session: MobileE2eeSessionState): boolean {
  return session.selection?.localRecordState === "unverified" && !session.pinVerified;
}

/**
 * The §13.4 number this phone shows once it has asked for approval.
 *
 * Desktop lists every pending row with its full number and tells the owner to
 * compare it with the device. Without this the phone showed nothing to compare,
 * so a row the Hub minted from a key of its own — it issues the tickets — looked
 * the same as this phone's, and approving it would hand the Hub an approved
 * record (§2.3). The WHOLE number or nothing: the Hub holds this phone's enrolled
 * identity key and can grind a key whose fingerprint shares any short tail, so a
 * partial value is no check at all.
 */
export interface E2eeApprovalComparison {
  readonly groups: readonly string[];
  readonly value: string;
  readonly caption: string;
}

export const E2EE_APPROVAL_REQUESTED_MESSAGE =
  "Approval requested. In Ryco Desktop, approve only the row for this phone whose safety number matches the one below.";

/** Approval was requested, but no channel has presented the node's identity yet. */
export const E2EE_APPROVAL_AWAITING_NUMBER_MESSAGE =
  "Approval requested. This phone's safety number appears here once the node answers; do not approve a Desktop row before you can compare it.";

export const E2EE_APPROVAL_SAFETY_NUMBER_CAPTION =
  `This phone's safety number. The row you approve on Desktop must show all ${E2EE_SAFETY_NUMBER_DIGITS.groups} groups, in this order. ` +
  "If any group differs, do not approve it.";

export function deriveE2eeApprovalComparison(
  session: MobileE2eeSessionState,
): E2eeApprovalComparison | null {
  const selection = session.selection;
  const presented = session.presented;
  if (
    selection === null ||
    // Before "Request approval" there is no pending row to compare against.
    !isE2eeApprovalRequested(session) ||
    selection.clientIdentityPublicKey === null ||
    presented === null
  ) {
    return null;
  }
  const groups = e2eeSafetyNumberGroups(presented.display.safetyNumber);
  if (groups.length === 0) return null;
  return {
    groups,
    value: presented.display.safetyNumber,
    caption: E2EE_APPROVAL_SAFETY_NUMBER_CAPTION,
  };
}

/** The fast path's lead line before this phone has asked for approval. */
export const E2EE_APPROVAL_INTRO_MESSAGE =
  "Ask an already trusted owner to approve this phone, then scan the one-time code it shows.";

/**
 * Before any request, with no node identity presented yet. "Request approval"
 * needs that identity, so this line must not invite an approval either.
 */
export const E2EE_APPROVAL_AWAITING_NODE_MESSAGE =
  "Waiting for the node to present its identity. This phone can ask for approval once it does; do not approve a Desktop row for it before then.";

export type E2eeApprovalRequestTone = "neutral" | "success" | "warning";

/** The fast path's lead line and the number it is read against. */
export interface E2eeApprovalRequestStatus {
  readonly message: string;
  readonly tone: E2eeApprovalRequestTone;
  /** The full §13.4 number to match on Desktop, or `null` while there is none. */
  readonly comparison: E2eeApprovalComparison | null;
}

/**
 * What the fast path tells the owner, decided apart from the ceremony stage.
 *
 * A request outlives the identity it was made against. It bumps the trust
 * revision, the re-prepared channel starts with nothing presented, and until the
 * node's statement validates again the stage is `no-evidence` — indefinitely, if
 * the node is offline or the Hub withholds the statement (rows K23/K24). The
 * phone then has no number to compare, while the Hub, which issues the tickets,
 * can still put a row of its own on Desktop. So a pending request without a
 * number says "do not approve yet", whatever the stage, and never falls back to
 * the generic invitation.
 */
export function deriveE2eeApprovalRequestStatus(input: {
  readonly session: MobileE2eeSessionState;
  readonly stage: E2eeVerificationStage;
  readonly approvalRequested: boolean;
}): E2eeApprovalRequestStatus {
  if (!input.approvalRequested) {
    return {
      message:
        input.stage === "no-evidence"
          ? E2EE_APPROVAL_AWAITING_NODE_MESSAGE
          : E2EE_APPROVAL_INTRO_MESSAGE,
      tone: "neutral",
      comparison: null,
    };
  }
  const comparison = deriveE2eeApprovalComparison(input.session);
  return comparison === null
    ? { message: E2EE_APPROVAL_AWAITING_NUMBER_MESSAGE, tone: "warning", comparison: null }
    : { message: E2EE_APPROVAL_REQUESTED_MESSAGE, tone: "success", comparison };
}

export const E2EE_APPROVAL_QR_INVALID =
  "That approval code does not match this phone, node, account, or current node security state. Ask the node to show a new code and scan it again.";

/**
 * One fixed message, for the reason the trust store has one: an origin, an
 * account scope, a handle, or a fingerprint must not reach a view through an
 * error. It is also honest about the next step, which is always the same.
 */
export const E2EE_VERIFICATION_UNAVAILABLE =
  "Ryco could not record this verification on this device. Nothing was sent and nothing was changed. Try again.";

/* -------------------------------------------------------------------------- */
/* The security surface                                                        */
/* -------------------------------------------------------------------------- */

export type E2eeChannelClaim =
  /** §2.2's bottom row. The only value that may carry an E2EE claim. */
  | "verified"
  /** §18 account-grant IK: encrypted, but not independently verified. */
  | "account-trusted"
  /** §13.1's release gate: the ceremony, and nothing else. */
  | "pairing-only"
  /** §12.2's honest label for a channel that FELL BACK and could pair out of it. */
  | "legacy"
  /** §6.3: this device holds no key, so no ceremony can produce E2EE here. */
  | "legacy-no-custody"
  /** No channel to describe. */
  | "none";

export interface E2eeDiagnosticRow {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

export interface E2eeSecurityView {
  /** False for a build with no hosted plane: the surface must not render at all. */
  readonly available: boolean;
  /** What a build with no hosted plane renders instead of everything below. */
  readonly unavailableMessage: string;
  readonly claim: E2eeChannelClaim;
  readonly channelLabel: string;
  readonly channelMessage: string;
  /**
   * §13.2.1's "explicit surface naming the selection", as the two strings that
   * have to be on screen before either resolution can be taken.
   *
   * They are `null` only when no §13.2.1 or §13.3 surface was raised. With one
   * raised they are never null and never shared between situations: the copy is
   * what tells the owner which of the three happened, and taking the consent
   * resolution without it is exactly the click-through §13.2.1 exists to
   * prevent. {@link E2eeSecurityView.nodeLabel} names the selection beside them.
   */
  readonly situationTitle: string | null;
  readonly situationMessage: string | null;
  /** The node's Hub-supplied display label. Bounded, and display-only. */
  readonly nodeLabel: string | null;
  /**
   * §13.1.1's persistent indication. It is `true` whenever this device holds no
   * verified pin on the connected Hub origin — including when the marker is
   * unobtainable, because the owner-visible fact is the same and §4.4 forbids
   * reading unobtainable as unset.
   */
  readonly unverifiedHub: boolean;
  readonly unverifiedHubTitle: string;
  readonly unverifiedHubMessage: string;
  /** §13.2's entry point, which §13.1.1 requires beside the indication. */
  readonly pair: E2eeTrustAction | null;
  /**
   * §13.2.1's two resolutions, in the order the specification lists them.
   * Neither is the default, neither is reachable by dismissal, and the consent
   * resolution is ABSENT where local policy forbids legacy or a pin is latched.
   */
  readonly resolutions: readonly E2eeTrustAction[];
  /** §13.3's owner-initiated re-pair, offered only for a selection that has a pin. */
  readonly rePair: E2eeTrustAction | null;
  /** §13.1.1's last resort for a durable document this device cannot read. */
  readonly destroyUnreadable: E2eeTrustAction | null;
  readonly diagnostics: readonly E2eeDiagnosticRow[];
  readonly diagnosticsCaption: string;
}

export interface E2eeSecurityInput {
  readonly session: MobileE2eeSessionState;
  readonly hostedModeAvailable: boolean;
  /** True only when the durable document was read and would not parse. */
  readonly trustStateUnreadable: boolean;
  readonly onOpenVerification: () => void;
  readonly now: () => number;
}

export const CHANNEL_LABELS: Record<E2eeChannelClaim, string> = {
  verified: "Encrypted · Verified locally",
  "account-trusted": "Encrypted · Account trusted",
  "pairing-only": "Not verified",
  // §12.2: "MUST label the channel legacy in every user-facing surface and
  // diagnostic". One word, and both legacy claims carry it.
  legacy: "Legacy connection",
  "legacy-no-custody": "Legacy connection",
  none: "No connection",
};

export const CHANNEL_MESSAGES: Record<E2eeChannelClaim, string> = {
  verified: E2EE_VERIFIED_CHANNEL_MESSAGE,
  "account-trusted":
    "This channel is end-to-end encrypted and authorized by your signed-in Ryco account. Verify independently for protection from an active Hub.",
  "pairing-only": E2EE_PAIRING_ONLY_MESSAGE,
  legacy: E2EE_LEGACY_CHANNEL_MESSAGE,
  "legacy-no-custody": E2EE_NO_KEY_CUSTODY_MESSAGE,
  none: "There is no node connection to describe yet.",
};

const DIAGNOSTIC_LABELS: Record<string, string> = {
  e2ee_message_too_large: "A message was larger than this channel's ceiling. Nothing was sent.",
  e2ee_send_unavailable: "This device could not queue a message. The connection is unaffected.",
  e2ee_prekey_expired: "This device's own key certificate was outside its validity window.",
  e2ee_policy_generation_regressed:
    "The node presented an older policy generation than this device already accepted.",
  pre_key_local: "This device ended a connection attempt before any key was agreed.",
};

function claimFor(session: MobileE2eeSessionState): E2eeChannelClaim {
  switch (session.channel) {
    case "verified":
      // §13.3: an unresolved identity-change or §13.2.1 surface means the pin
      // this claim rests on is exactly what is in question, and the channel that
      // earned the claim is closed. The claim is withheld rather than repainted:
      // a green "Encrypted" over an open substitution warning is the strongest
      // form of §2.2's forbidden overclaim.
      return session.event === null ? "verified" : "none";
    case "account-trusted":
      return session.event === null ? "account-trusted" : "none";
    case "unverified":
      return "pairing-only";
    case "legacy":
      return session.keyCustodyUnavailable ? "legacy-no-custody" : "legacy";
    case "web-unsigned":
      // §2.2's web NX row, which THIS app cannot occupy: §8.1's role/tier matrix
      // gives the native client a static agreement key and the IK pattern, and
      // `lockMobileE2eeChannelMode` emits only `legacy`, `verified`, and
      // `unverified` — asserted across every publisher in `e2eeSession.test.ts`.
      // The arm exists because the shared union is exhaustive: the point of
      // adding the member there was to make "what does this tier call the web
      // row?" a compile error rather than a silent fall-through.
      //
      // `none` IS NOT A NEUTRAL VALUE AND IS NOT PICKED AS ONE. It renders
      // `CHANNEL_LABELS.none` — "No connection" — with
      // `CHANNEL_MESSAGES.none`'s "There is no node connection to describe yet."
      // and `CLAIM_SYMBOLS.none`'s closed padlock, so it asserts DISCONNECTION,
      // which a live web NX channel is not. That is exactly why the shared
      // vocabulary refused to fold the web row into `unverified`
      // (`connectionStatus.ts`: it "reports the session unusable, which would be
      // a lie about connectedness"), and the two modules would answer the same
      // row inconsistently if this app could ever reach it.
      //
      // It is correct here for one reason and one only: an unreachable row has
      // no owner-visible rendering, so the choice is about what a FUTURE caller
      // inherits. Given that, "no connection" is the safe direction — it claims
      // nothing about confidentiality and understates connectedness — while
      // `verified` or a new claim of its own would be a native-strength word
      // sitting in the native app for §2.2's weakest row. A tier that ever gains
      // a real web channel here gets its own `E2eeChannelClaim` member, the way
      // `legacy-no-custody` did, and does not silently adopt this one.
      //
      // ITS OWN RETURN, NOT A FALL-THROUGH INTO THE ONE BELOW. Sharing a body
      // left the answer to this row unstated: a case inserted between the two
      // would have silently changed what the web row claims, and the value was
      // pinned by nothing. `e2eeTrustUiModel.test.ts` now asserts the claim AND
      // the three strings it renders.
      return "none";
    case "negotiating":
    case "unavailable":
      return "none";
  }
}

/**
 * The §13.1.1 security surface.
 *
 * The indication is derived from the marker and the pins, never from the
 * channel: a device with no verified pin has to see it whether or not a channel
 * is currently up, and it must not be possible for a connection to make it go
 * away. Dismissal is not modelled at all — there is no dismiss action here,
 * which is the strongest reading of "MUST NOT be presented as a transient banner
 * that dismisses into a verified-looking state".
 */
export function deriveE2eeSecurityView(input: E2eeSecurityInput): E2eeSecurityView {
  const { session } = input;
  const claim = claimFor(session);
  const selection = session.selection;
  const classification = session.classification;
  const latched = classification?.class === "latched";

  const event = session.event;
  const base = {
    available: input.hostedModeAvailable,
    unavailableMessage: E2EE_NO_HOSTED_PLANE_MESSAGE,
    claim,
    channelLabel: CHANNEL_LABELS[claim],
    channelMessage: CHANNEL_MESSAGES[claim],
    // §13.2.1 / §13.3: the surface names the selection and says which situation
    // it is, on the same screen as the resolutions and never only on the other
    // one. The situation is chosen in `e2eeSession`, from client-anchored state.
    situationTitle:
      event === null
        ? null
        : event.kind === "identity-change"
          ? E2EE_IDENTITY_CHANGE_TITLE
          : E2EE_UNEXPECTED_NODE_TITLES[event.situation],
    situationMessage:
      event === null
        ? null
        : event.kind === "identity-change"
          ? E2EE_IDENTITY_CHANGE_MESSAGE
          : E2EE_UNEXPECTED_NODE_MESSAGES[event.situation],
    nodeLabel: selection?.nodeLabel ?? null,
    unverifiedHubTitle: E2EE_NO_VERIFIED_NODE_TITLE,
    unverifiedHubMessage: E2EE_NO_VERIFIED_NODE_MESSAGE,
    diagnostics: diagnosticRows(session.diagnostics),
    diagnosticsCaption: E2EE_DIAGNOSTICS_CAPTION,
  };

  if (!input.hostedModeAvailable) {
    return {
      ...base,
      claim: "none",
      channelLabel: CHANNEL_LABELS.none,
      channelMessage: CHANNEL_MESSAGES.none,
      situationTitle: null,
      situationMessage: null,
      nodeLabel: null,
      unverifiedHub: false,
      pair: null,
      resolutions: [],
      rePair: null,
      destroyUnreadable: null,
    };
  }

  const pair =
    selection === null
      ? null
      : action("open-verification", "Verify this node", input.onOpenVerification);

  // §13.2.1: exactly two resolutions, and the consent one is unavailable — not
  // defaulted — where local policy forbids legacy. A latched pin is not offered
  // it at all, which `e2eeUnexpectedNodeResolutions` cannot express because the
  // latch is not policy, so the latch is applied here on top of it.
  const offered = e2eeUnexpectedNodeResolutions(
    session.legacyPermitted ? { kind: "permitted" } : { kind: "unobtainable" },
  );
  const resolutions: E2eeTrustAction[] = [];
  if (event !== null && selection !== null) {
    for (const resolution of offered) {
      if (resolution === "pair") {
        resolutions.push(action("start-pairing", "Pair this node", input.onOpenVerification));
        continue;
      }
      if (latched) continue;
      resolutions.push(
        action(
          "record-legacy-consent",
          "Connect without encryption",
          () => {
            void recordE2eeLegacyConsent(session, input.now());
          },
          {
            destructive: true,
            confirm: {
              title: E2EE_LEGACY_CONSENT_TITLE,
              message: E2EE_LEGACY_CONSENT_MESSAGE,
              confirmText: "Connect unencrypted",
              destructive: true,
            },
          },
        ),
      );
    }
  }

  // §13.3's owner-initiated re-pair needs the client-anchored index, which only
  // exists once this selection has a record. Resolved once, so the action's
  // closure carries a value rather than a nullable field it has to re-narrow.
  const rePairIndex =
    selection === null || selection.localNodeHandle === null
      ? null
      : {
          hubOrigin: selection.hubOrigin,
          accountId: selection.accountId,
          localNodeHandle: selection.localNodeHandle,
        };

  return {
    ...base,
    // §13.1.1: unset AFTER reconciliation, and `unobtainable` counts — this
    // device can point at no verified node either way.
    unverifiedHub: session.markerSet !== true,
    pair,
    resolutions,
    rePair:
      rePairIndex === null
        ? null
        : action(
            "re-pair",
            "Forget this node's identity",
            () => {
              void mobileE2eeTrustStore.clearSelection(rePairIndex).catch(() => undefined);
            },
            {
              destructive: true,
              confirm: {
                title: E2EE_REPAIR_TITLE,
                message: E2EE_REPAIR_MESSAGE,
                confirmText: "Forget",
                destructive: true,
              },
            },
          ),
    destroyUnreadable: input.trustStateUnreadable
      ? action(
          "destroy-unreadable-trust-state",
          "Clear this device's verification state",
          () => {
            void mobileE2eeTrustStore.destroyUnreadableTrustState().catch(() => undefined);
          },
          {
            destructive: true,
            confirm: {
              title: "Clear verification state?",
              message:
                "Ryco cannot read what this device recorded about any node on any Hub. Clearing it starts this device over: every node has to be verified again, and until then Ryco claims no protection against a Hub anywhere.",
              confirmText: "Clear",
              destructive: true,
            },
          },
        )
      : null,
  };
}

function diagnosticRows(
  diagnostics: readonly MobileE2eeLocalDiagnostic[],
): readonly E2eeDiagnosticRow[] {
  const grouped = new Map<string, E2eeDiagnosticRow>();
  for (const [index, diagnostic] of diagnostics.entries()) {
    // Bounded by construction: the label comes from a fixed table keyed on the
    // closed diagnostic set, and an unrecognised id renders the neutral line
    // rather than the id itself.
    const label =
      DIAGNOSTIC_LABELS[diagnostic.id] ??
      "This device ended a connection attempt before any key was agreed.";
    const current = grouped.get(label);
    if (current) {
      grouped.set(label, { ...current, count: current.count + 1 });
      continue;
    }
    grouped.set(label, {
      id: `${index}:${diagnostic.id}:${diagnostic.row}`,
      label,
      count: 1,
    });
  }
  return Array.from(grouped.values());
}

/** §12.1.1's per-selection legacy consent, taken as an explicit owner act. */
async function recordE2eeLegacyConsent(
  session: MobileE2eeSessionState,
  decidedAt: number,
): Promise<void> {
  const selection = session.selection;
  if (selection === null) return;
  try {
    if (selection.localNodeHandle === null) {
      const index = await mobileE2eeTrustStore.recordUnresolvedLegacyConsent(
        mintE2eeOwnerUnresolvedLegacyConsentDecision({
          hubOrigin: selection.hubOrigin,
          accountId: selection.accountId,
          nodeId: selection.nodeId,
          ...(selection.environmentId === null ? {} : { environmentId: selection.environmentId }),
          decidedAt,
        }),
      );
      attachMobileE2eeLocalNodeHandle(index.localNodeHandle, "unpinned", selection.environmentId);
    } else {
      await mobileE2eeTrustStore.recordLegacyConsent(
        mintE2eeOwnerLegacyConsentDecision({
          index: {
            hubOrigin: selection.hubOrigin,
            accountId: selection.accountId,
            localNodeHandle: selection.localNodeHandle,
          },
          decidedAt,
        }),
      );
    }
  } catch {
    // The store refuses a latched selection outright (§12.1.1), and refuses a
    // document it cannot read. Neither is worth an error carrying a selection.
    return;
  }
  clearMobileE2eeTrustEvent(selection.environmentId);
}
