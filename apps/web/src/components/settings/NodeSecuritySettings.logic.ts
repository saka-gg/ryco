// Every decision, every owner-facing sentence, and every gate the node security
// panel makes — docs/relay-e2ee-protocol.md §6.4, §7.5, §12.3–§12.6, §13.4–§13.6.
//
// A `.logic.ts` sibling for the reason `HostedRelayTrustNotice.logic.ts` and
// `HostedConnectionControls.logic.ts` are: a decision whose failure mode is
// security-relevant rather than cosmetic belongs somewhere a node test can reach
// it without a DOM, and copy that could mislead an owner about what is protected
// belongs under a prohibited-phrase scan.
//
// WHAT THE SCAN OVER THIS MODULE DOES AND DOES NOT COVER. `everyNodeSecurityString`
// flattens the sentences this module PRODUCES, and the node suite walks it. It
// does not reach a literal written inside the `.tsx`, and claiming otherwise is
// how a contradiction ships: the panel's own live-session row once told an owner
// to compare a code against the machine they were sitting at, in a sentence no
// unit scan could see. Claim-bearing `.tsx` copy is therefore exported from here
// as a constant, and the browser suite runs the same prohibited list over the
// RENDERED DOM so a literal added to the `.tsx` is covered without waiting for
// someone to move it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PANEL DESCRIBES THE NODE. IT PROVES NOTHING ABOUT THE READER'S SESSION.
// ─────────────────────────────────────────────────────────────────────────────
// Reading a node's operator state says what that node will admit. It says
// nothing about the confidentiality of the channel the reader is using to read
// it — and in hosted mode §2.4 is explicit that it cannot: the Hub serves this
// very JavaScript, so a malicious one "may serve code that completes the genuine
// node handshake, displays the genuine session `WebSAS`, and separately
// exfiltrates plaintext or traffic keys". No sentence below may let a reader
// conclude otherwise, and where the panel shows a session's own code the shipped
// advisory travels with it — from `hostedE2eeVerificationView`, whose whole
// design is that the characters and the denial are one value.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO MODES ARE NOT TWO SKINS
// ─────────────────────────────────────────────────────────────────────────────
// `apps/desktop` has no `.tsx` of its own: it loads the local node's HTTP URL and
// the node serves `apps/web/dist`, so one implementation is both the desktop UI
// and the Hub-hosted PWA. What differs is the CONNECTION MODE, and it differs in
// a way that decides this panel's whole shape — see {@link NodeSecurityMode}.

import { E2EE_SAFETY_NUMBER_DIGITS } from "@ryco/shared/relayE2eeConstants";

import type { RelayCapability } from "@ryco/contracts/relay";
import type {
  NodeE2eeClientListing,
  NodeE2eeClientRecord,
  NodeE2eeContinuity,
  NodeE2eeFallback,
  NodeE2eePolicy,
  NodeE2eePolicyChange,
  NodeE2eePolicyProposal,
  NodeE2eePrekey,
  NodeE2eeSession,
} from "@ryco/client-runtime/connection";
import type { HostedConnectionStatusIndicator } from "../../hostedHub/connectionStatus";
import { hostedE2eeVerificationView } from "../hostedHub/HostedE2eeVerification.logic";

/**
 * Which of the two connection modes this build is running in.
 *
 * `local` — the browser (or the Electron window, which is the same bundle)
 * reaches a node on this machine directly. There is no relay in the path, so
 * there is no §4 channel and nothing for §4 to encrypt.
 *
 * `hosted` — the Hub serves this bundle and the relay carries `ryco.rpc`. The §4
 * NX channel exists and is already shipped; the node's OPERATOR routes are not
 * on the relay at all.
 *
 * IT IS DERIVED FROM THE BUILD MODE AND NOT FROM A LIVE SESSION, and that choice
 * is load-bearing rather than incidental — see
 * {@link nodeE2eeStrictPolicyDisposition}.
 */
export type NodeSecurityMode = "local" | "hosted";

export function nodeSecurityMode(hostedHubMode: boolean): NodeSecurityMode {
  return hostedHubMode ? "hosted" : "local";
}

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS CONNECTION IS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The panel's statement about the connection the reader is holding.
 *
 * `warn` is deliberately absent from the local shape. In local mode there is no
 * relay, so there is nothing to encrypt and no downgrade to report; a red badge
 * there would be a warning about a risk that does not exist, and an owner taught
 * to dismiss one indicator learns to dismiss the one that matters. The local
 * copy therefore states what the connection IS and says nothing at all about
 * relay encryption in either direction.
 */
export interface NodeConnectionStatement {
  readonly headline: string;
  readonly body: string;
}

/**
 * §2.2's claim vocabulary is NOT re-derived here.
 *
 * `packages/client-runtime/src/authorization/connectionStatus.ts` exists because
 * deriving indicators independently once shipped a contradictory pill, so the
 * hosted statement takes the already-derived indicator and quotes its own words.
 * This module adds no status noun of its own.
 *
 * THE HOSTED BODY DOES NOT NAME THE PEER AS THE OWNER'S NODE.
 * `HostedRelayTrustNotice.logic.ts` calls it "the node this tab was routed to"
 * and never "your node", because §2.3's web bullet is that this client "retains
 * no durable latch, no pin of any kind" — the identity of the far end is exactly
 * what this tier cannot establish. This sentence is drawn in the larger, earlier
 * position, directly above the disclosure that denies the claim, so asserting it
 * here would put the stronger sentence where readers look and the denial where
 * they do not.
 */
export function nodeConnectionStatement(
  mode: NodeSecurityMode,
  indicator: HostedConnectionStatusIndicator | null,
): NodeConnectionStatement {
  if (mode === "local") {
    return {
      headline: "Direct to a node on this machine",
      body: "This window talks to a Ryco node running here, on this machine. No Ryco Hub sits between them and nothing you send leaves this machine on its way to the node.",
    };
  }
  return {
    headline: indicator === null ? "Through the Ryco Hub" : indicator.shortLabel,
    body: "This browser reaches a node through the Ryco Hub relay. What that channel is worth is stated with the channel itself, below.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE OPERATOR DATA COMES FROM, AND WHERE IT DOES NOT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the node's operator routes can be reached from this build at all.
 *
 * NOT A PREFERENCE — A BOUNDARY THAT ALREADY EXISTS.
 * `apps/web/src/environments/primary/target.ts` throws
 * "Node HTTP routes are unavailable in hosted Hub mode." from
 * `resolvePrimaryEnvironmentHttpUrl`, and `hostedHttpBoundary.test.ts` pins it.
 * The relay carries `ryco.rpc` channels and there is no HTTP tunnel, so the
 * sixteen `/api/hub/e2ee/…` routes are unreachable from a hosted browser however
 * a surface asks for them.
 *
 * The panel therefore does not render an empty client table with a spinner in
 * hosted mode. It says where the data lives and how to reach it.
 */
export interface NodeOperatorDataAvailability {
  readonly available: boolean;
  readonly unavailableBody: string;
}

export type NodeLocalOperatorAccess = "checking" | "owner" | "client" | "unavailable";

export function nodeOperatorDataAvailability(
  mode: NodeSecurityMode,
  localAccess: NodeLocalOperatorAccess = "owner",
): NodeOperatorDataAvailability {
  if (mode === "local") {
    if (localAccess === "owner") return { available: true, unavailableBody: "" };
    if (localAccess === "checking") {
      return {
        available: false,
        unavailableBody: "Checking whether this session can administer the node's security state.",
      };
    }
    if (localAccess === "client") {
      return {
        available: false,
        unavailableBody:
          "This browser is paired as a client. Node security administration is owner-only; open Ryco Desktop on this machine or run `ryco e2ee` on the node. This direct client connection remains available.",
      };
    }
    return {
      available: false,
      unavailableBody:
        "Ryco could not verify that this session may administer the node's security state. Reconnect from Ryco Desktop on this machine or run `ryco e2ee` on the node.",
    };
  }
  return {
    available: false,
    unavailableBody:
      "Your node's client list, live sessions, admission policy, prekey and fallback counters are held on the node and read over its own local interface, which the relay does not carry. Open Ryco on that machine to see them, or run `ryco e2ee` there.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HARD BLOCK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What this build may do with `requireApprovedClientE2EE` (§12.4).
 *
 * §12.4's policy admits only approved native client keys, which closes web and
 * legacy access by design. Applying it FROM a browser therefore ends the session
 * doing the applying, and the operator is locked out of the surface they were
 * holding — with no way back in through it, because §12.4 is exactly the policy
 * that refuses the web tier.
 *
 * A typed confirmation is not sufficient and is not offered. A confirmation
 * changes how deliberate the action is; it does not change the end state, and
 * the end state is the lockout. In hosted mode the control is inert and says
 * why; in local mode it is available, because a local operator who narrows their
 * node too far still has the machine in front of them.
 */
export type NodeE2eeStrictPolicyDisposition =
  | { readonly kind: "available" }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * KEYED ON THE BUILD MODE, NEVER ON A LIVE RELAY SESSION.
 *
 * "Is a hosted channel up right now?" is the wrong question and answering it
 * would invert the guard exactly when it matters: a hosted tab whose transport
 * has dropped holds no session, so a session-keyed gate would UNBLOCK the
 * lockout control precisely while the operator's connection was already broken.
 * The build mode cannot flicker — `VITE_RYCO_CLIENT_MODE` is fixed when the
 * bundle is built, and it is the same fact that decides whether the Hub served
 * this page — so it is what the block reads.
 */
export function nodeE2eeStrictPolicyDisposition(
  mode: NodeSecurityMode,
): NodeE2eeStrictPolicyDisposition {
  if (mode === "local") return { kind: "available" };
  return {
    kind: "blocked",
    reason:
      "This one can only be changed from the node itself. It admits approved native client keys and closes browser and legacy access — including this browser, which is how you are reading this — so turning it on from here would end this session and leave no way back in through it. Run `ryco e2ee policy set --require-approved-client-e2ee` on the machine running the node, where you can still reach it if the result is not what you wanted.",
  };
}

/**
 * The gate every policy proposal passes before it is allowed near the network.
 *
 * THE FIELD IS REFUSED IN HOSTED MODE WHETHER IT IS BEING SET OR CLEARED.
 * Distinguishing the two would make the guard depend on reading a boolean
 * correctly, and the clearing direction is not a case that has to work here: a
 * hosted browser can only be talking to a node that does NOT have the policy on,
 * because a node that did would not admit it. Refusing the field outright costs
 * nothing real and cannot be got wrong.
 *
 * This is the INNER half of the block. The outer half is the hosted HTTP
 * boundary, which throws before a request is built — so reaching the network
 * with this proposal takes defeating both, in two packages, in one change.
 */
export type NodeE2eePolicyGate =
  | { readonly allowed: true; readonly proposal: NodeE2eePolicyProposal }
  | { readonly allowed: false; readonly refusal: string };

/**
 * The gate's own refusal, for the case where the disposition does not supply one.
 *
 * The guard and the sentence are separate concerns and the sentence is NOT
 * allowed to fall back to `""`. The panel renders its error banner from this
 * string; an empty one renders as no banner at all, so a control that snapped
 * back with nothing said would be the only signal — and a guard that fails
 * silently is one an operator routes around. The branch is unreachable today
 * (hosted always blocks), which is exactly why it has to be written correctly
 * rather than left to a future tier to notice.
 */
export const NODE_E2EE_POLICY_GATE_REFUSAL =
  "This build cannot change whether the node admits only approved native client keys. Run " +
  "`ryco e2ee policy set --require-approved-client-e2ee` on the machine running the node.";

export function nodeE2eePolicyGate(
  mode: NodeSecurityMode,
  proposal: NodeE2eePolicyProposal,
): NodeE2eePolicyGate {
  if (mode === "hosted" && proposal.requireApprovedClientE2EE !== undefined) {
    const disposition = nodeE2eeStrictPolicyDisposition(mode);
    return {
      allowed: false,
      refusal: disposition.kind === "blocked" ? disposition.reason : NODE_E2EE_POLICY_GATE_REFUSAL,
    };
  }
  return { allowed: true, proposal };
}

// ─────────────────────────────────────────────────────────────────────────────
// §13.4 — THE SAFETY NUMBER AND ITS CEILING ARE ONE VALUE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §13.4's rendered value, its format caption, and what a comparison is worth —
 * as ONE object with three required fields.
 *
 * THE MECHANISM IS `hostedE2eeVerificationView`'S, AND IT IS COPIED ON PURPOSE
 * RATHER THAN CALLED. That function validates §13.5's `WebSAS` — eight Crockford
 * characters in two groups — and returns `null` for anything else, so a §13.4
 * safety number (sixty decimal digits in twelve groups) does not survive it.
 * Every §13.5 value this panel draws goes through the shipped function untouched
 * (the live-sessions panel and the connection panel both import it); this exists
 * only for the value that function cannot represent, and it is built the same
 * way for the same reason: there is no exported accessor that hands back the
 * digits alone, so drawing the number without its advisory takes deleting a
 * field from a returned object rather than forgetting a second call.
 *
 * Every number in the caption is read from `E2EE_SAFETY_NUMBER_DIGITS`, so a
 * §13.4 format change rewrites the sentence and breaks the split in one edit.
 */
export interface NodeSafetyNumberView {
  readonly groups: ReadonlyArray<string>;
  /** The groups re-joined with the format's own separator. */
  readonly display: string;
  readonly caption: string;
  readonly advisory: string;
}

/**
 * §13.4's format, restated as a validator: `groups` runs of `digitsPerGroup`
 * decimal digits joined by a single `separator`.
 *
 * A surface that silently re-grouped, truncated, or padded would show the owner
 * a different string from the one their device shows, in the one ceremony that
 * consists of comparing the two — and §13.4 is explicit that "the fixed length
 * and grouping are the checksum — there is no separate check digit".
 */
export function nodeSafetyNumberGroups(display: string): ReadonlyArray<string> {
  const groups = display.split(E2EE_SAFETY_NUMBER_DIGITS.separator);
  if (groups.length !== E2EE_SAFETY_NUMBER_DIGITS.groups) return [];
  for (const group of groups) {
    if (group.length !== E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup) return [];
    for (const character of group) {
      if (character < "0" || character > "9") return [];
    }
  }
  return groups;
}

export const NODE_SAFETY_NUMBER_CAPTION =
  `${E2EE_SAFETY_NUMBER_DIGITS.digits} digits, in ${E2EE_SAFETY_NUMBER_DIGITS.groups} groups of ` +
  `${E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup}. The length and the grouping are the only check ` +
  `there is, so read all ${E2EE_SAFETY_NUMBER_DIGITS.digits} in order.`;

/**
 * What a §13.4 comparison catches, and what it is for.
 *
 * §13.4's own duties: the value is long-term, it covers both identity keys and
 * the Hub/account namespace, and the same key pair paired under a different
 * account yields a different number. §13.2 step 5 is where an owner uses it —
 * they compare it against the device before approving the key.
 *
 * It carries none of the tokens the prohibited-claims scan forbids, including in
 * the negative: the scan is a bare substring match and cannot tell a claim from
 * its denial, so the words simply do not appear.
 */
export const NODE_SAFETY_NUMBER_ADVISORY =
  "Compare this with the number the device itself shows, on the device, before approving it. " +
  "They match only for this key pair under this Hub account — the same device under a different " +
  "account reads differently. Approve nothing whose number you have not read off the other " +
  "screen yourself.";

/**
 * The owner's statement, per row, that gates every approval from this panel.
 *
 * §13.2 step 5 has the owner compare the number on both screens before
 * approving, and strict mode's whole guarantee rests on that one human check: a
 * Hub mints the tickets, so it can introduce a key of its own under the owner's
 * account, and that pending row differs from the phone's only in its
 * fingerprint and this number. An advisory sentence beside an Approve button
 * leaves the comparison optional, so the button does not exist until the owner
 * says the numbers match. It is a statement about the whole value — never about
 * a tail of it, which a Hub that knows the phone's enrolled key can grind a key
 * to match ahead of time.
 */
export const NODE_SAFETY_NUMBER_MATCH_LABEL = "This number matches the phone";

export const NODE_SAFETY_NUMBER_MATCH_HINT =
  `Read all ${E2EE_SAFETY_NUMBER_DIGITS.digits} digits off the phone's own screen and tick this ` +
  "only if every group is the same; the approve action appears once you have. The characters " +
  "in this row's title only tell rows apart and are no comparison.";

export function nodeSafetyNumberView(value: string): NodeSafetyNumberView | null {
  const groups = nodeSafetyNumberGroups(value);
  if (groups.length === 0) return null;
  return {
    groups,
    display: groups.join(E2EE_SAFETY_NUMBER_DIGITS.separator),
    caption: NODE_SAFETY_NUMBER_CAPTION,
    advisory: NODE_SAFETY_NUMBER_ADVISORY,
  };
}

/**
 * What the surface says when a record carries no readable §13.4 value.
 *
 * The absence gets a sentence for the reason §13.5's does: rendering nothing
 * would leave an owner unable to tell "this build shows none" from "this record
 * has none", while the row still invited them to approve the key.
 */
export const NODE_SAFETY_NUMBER_UNAVAILABLE =
  "No comparison number is readable for this record, so there is nothing here to check against " +
  "the device.";

// ─────────────────────────────────────────────────────────────────────────────
// THIS NODE'S IDENTITY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the node's own enrollment fingerprint can be shown right now.
 *
 * IT USUALLY CANNOT, AND THAT IS A GAP IN THE NODE'S ROUTES RATHER THAN A CHOICE
 * MADE HERE. §13.2 step 5 has the owner compare "the safety number and node
 * fingerprint against the local node CLI/enrollment surface", and §13.2's final
 * paragraph allows a product to require entry of the node enrollment fingerprint
 * before any pairing exchange — so the value is one an owner needs before pairing
 * a phone. The node serves it from `GET /api/hub/enrollment`, which answers 404
 * once the ceremony is over, and `GET /api/hub/identity` carries "no origin, no
 * node/key/environment identifier, and no fingerprint" by design. No route on
 * this node exposes its long-term identity fingerprint after enrollment
 * completes.
 *
 * So the panel shows it while a ceremony is pending and states its absence
 * otherwise, rather than showing the §6.4 AGREEMENT prekey fingerprint under the
 * identity heading. Those are different keys, and labelling one as the other
 * would send an owner into a pairing comparison with the wrong value.
 */
export interface NodeEnrollmentFingerprintView {
  readonly available: boolean;
  readonly fingerprint: string | null;
  readonly caption: string;
}

export function nodeEnrollmentFingerprintView(
  pendingCeremonyFingerprint: string | null,
): NodeEnrollmentFingerprintView {
  if (pendingCeremonyFingerprint !== null) {
    return {
      available: true,
      fingerprint: pendingCeremonyFingerprint,
      caption:
        "This node's identity fingerprint, from the enrollment now waiting for approval. Compare it character for character wherever you are asked to confirm this machine.",
    };
  }
  return {
    available: false,
    fingerprint: null,
    caption:
      "This node's identity fingerprint is shown here only while an enrollment is waiting for approval. At other times, read it from the node with `ryco hub status` on the machine running it.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §6.4 PREKEY, §7.5 CONTINUITY
// ─────────────────────────────────────────────────────────────────────────────

export interface NodeFactRow {
  readonly label: string;
  readonly value: string;
  /** Rendered in a face that makes character-by-character reading possible. */
  readonly mono?: boolean;
}

const UNKNOWN = "unknown";

/** Epoch millis as a readable local time, or a stated absence. */
export function formatNodeEpoch(value: number | undefined): string {
  if (value === undefined) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? UNKNOWN : date.toLocaleString();
}

/**
 * §6.4's prekey, with its remedy carried rather than restated.
 *
 * `present: false` is a node holding no prekey for this origin at all, which
 * §6.4 distinguishes from an expired one — a surface that drew them the same way
 * would send an operator to rotate a key that was never there.
 */
export function nodePrekeyRows(prekey: NodeE2eePrekey | null): ReadonlyArray<NodeFactRow> {
  if (prekey === null) return [{ label: "Agreement prekey", value: UNKNOWN }];
  if (!prekey.present) return [{ label: "Agreement prekey", value: "none held" }];
  return [
    { label: "Prekey", value: prekey.prekeyId ?? UNKNOWN, mono: true },
    { label: "Fingerprint", value: prekey.fingerprint ?? UNKNOWN, mono: true },
    { label: "Validity", value: prekey.validity ?? UNKNOWN },
    { label: "Created", value: formatNodeEpoch(prekey.createdAt) },
    { label: "Expires", value: formatNodeEpoch(prekey.expiresAt) },
  ];
}

/** §6.4's own repair sentence, from the module that defines the diagnostic. */
export function nodePrekeyRemedy(prekey: NodeE2eePrekey | null): string | null {
  if (prekey === null) return null;
  if (!prekey.present) {
    return "This node holds no agreement prekey for its Hub origin. It re-signs one at startup; rotate to issue one now.";
  }
  return prekey.remedy ?? null;
}

/**
 * §7.5's lineage. An unresolvable one carries §7.5's own remedy, so this surface
 * cannot drift from the condition that raised it.
 */
export function nodeContinuityRows(
  continuity: NodeE2eeContinuity | null,
): ReadonlyArray<NodeFactRow> {
  if (continuity === null) return [{ label: "Continuity", value: UNKNOWN }];
  if (continuity.status === "unavailable") {
    return [
      { label: "Continuity", value: "unresolvable" },
      { label: "Reason", value: continuity.reason ?? UNKNOWN },
    ];
  }
  return [
    { label: "Continuity", value: "advertisable" },
    { label: "Lineage", value: continuity.continuityId ?? UNKNOWN, mono: true },
    { label: "Rotation generation", value: String(continuity.generation ?? 0) },
    { label: "Retained chain length", value: String(continuity.chainLength ?? 0) },
    ...(continuity.repair === undefined
      ? []
      : [{ label: "Startup repair", value: continuity.repair }]),
    ...(continuity.lastBreakReason === undefined
      ? []
      : [
          {
            label: "Last break",
            value: `${continuity.lastBreakReason} at ${formatNodeEpoch(continuity.lastBreakAt)}`,
          },
        ]),
  ];
}

export function nodeContinuityRemedy(continuity: NodeE2eeContinuity | null): string | null {
  return continuity?.remedy ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §13.6 CLIENT RECORDS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The §13.6 record status, reused verbatim.
 *
 * The node's three words are the vocabulary; this module invents none. In
 * particular there is no "trusted", no "secure", and no word borrowed from
 * §2.2's connection ladder — a record's status is a statement about what the
 * node will admit, not about what any channel is worth.
 */
export function nodeClientStatusTone(
  status: NodeE2eeClientRecord["status"],
): "warning" | "success" | "error" {
  switch (status) {
    case "pending":
      return "warning";
    case "approved":
      return "success";
    case "revoked":
      return "error";
  }
}

/**
 * How many trailing fingerprint characters a row title and a confirmation carry.
 *
 * Enough to tell two devices apart at a glance, and never offered as a substitute
 * for the full value: the row's own `FactRows` and every per-record confirmation
 * carry all of it, because §13.2 step 5's comparison is character for character.
 * It is not a comparison either — a Hub that knows the phone's enrolled key can
 * grind one whose tail matches — so the statement that gates an approval says
 * so next to the number (`NODE_SAFETY_NUMBER_MATCH_HINT`).
 */
const CLIENT_TITLE_FINGERPRINT_TAIL = 8;

/**
 * The name a row gives one record.
 *
 * IT NEVER DEGRADES TO A CONSTANT. Two devices paired under one Hub account
 * carry the same account, the same origin, and — because nothing in this panel
 * sets `displayLabel` — the same stored label, which left every row reading
 * "Client key" over the identical description. The only value that told them
 * apart was the fingerprint inside the expanded facts, so a mis-targeted click on
 * a withdrawal was indistinguishable from the intended one. The fallback is the
 * fingerprint's tail for that reason.
 */
export function nodeClientRowTitle(record: NodeE2eeClientRecord): string {
  const label = record.displayLabel?.trim() ?? "";
  if (label !== "") return label;
  return `Client key …${record.fingerprint.slice(-CLIENT_TITLE_FINGERPRINT_TAIL)}`;
}

export function nodeClientRows(record: NodeE2eeClientRecord): ReadonlyArray<NodeFactRow> {
  return [
    { label: "Fingerprint", value: record.fingerprint, mono: true },
    { label: "Hub origin", value: record.hubOrigin },
    { label: "Account", value: record.accountId },
    { label: "Maximum role", value: record.maxRole === "" ? "none granted" : record.maxRole },
    // The role the device introduced itself under — what an approval has to
    // name for it to connect at all (see `nodeApprovalRole`). The node follows
    // it only while the record is pending; once it is approved or revoked, a
    // peer's hello never rewrites it, so the label says when it was read.
    {
      label: record.status === "pending" ? "Connects as" : "Connected as (when introduced)",
      value: record.observedRole ?? "not recorded",
    },
    {
      label: "Capabilities",
      value: record.capabilitySet.length === 0 ? "none" : record.capabilitySet.join(", "),
    },
    { label: "Created", value: formatNodeEpoch(record.createdAt) },
    ...(record.approvedAt === undefined
      ? []
      : [{ label: "Approved", value: formatNodeEpoch(record.approvedAt) }]),
    ...(record.revokedAt === undefined
      ? []
      : [{ label: "Revoked", value: formatNodeEpoch(record.revokedAt) }]),
    { label: "Last seen", value: formatNodeEpoch(record.lastSeenAt) },
    ...(record.pairingReserved ? [{ label: "Pairing reservation", value: "held" }] : []),
  ];
}

/**
 * §13.6's three instrumentation duties, as sentences rather than as counts the
 * owner has to infer a meaning for.
 *
 * The refusal count names the action that clears it, because §13.6 makes it
 * "bounded, owner-clearable" and a counter an owner can read but not reset stops
 * being instrumentation after the first flood.
 */
export function nodeClientListingNotices(
  listing: NodeE2eeClientListing | null,
): ReadonlyArray<string> {
  if (listing === null) return [];
  const notices: string[] = [];
  if (listing.pendingGlobalSaturated || listing.saturatedAccounts.length > 0) {
    notices.push(
      "Pending pairing is saturated, so a new device may not be able to introduce itself. Purge a pending record, or read the fingerprint off the device and open a pairing window naming it.",
    );
  }
  if (listing.refusedPairingAttempts > 0) {
    notices.push(
      `${listing.refusedPairingAttempts} pairing attempt(s) were refused because the pending list was full. Clear the count once you have dealt with them, or later readings will be dominated by history.`,
    );
  }
  return notices;
}

/**
 * §13.6: while a window is open, all three of these facts, or it is closed —
 * and `unknown` when no listing was ever read.
 *
 * THE UNREAD CASE IS TAKEN FIRST, BEFORE THE OPTIONAL CHAIN. `listing` is `null`
 * on every mount until the first read resolves, and stays `null` for the whole
 * session whenever a read keeps failing — a non-owner local session, a node
 * predating these routes, a network fault. Optional-chaining straight to
 * `pairingWindow === undefined` collapsed both into "closed", which is an
 * affirmative statement that no device can introduce itself right now about a
 * node whose pairing state this panel does not have. `nodeE2eeOperator.ts`'s own
 * rule is that a field the node stops sending "degrades to a stated absence
 * instead of to a confident wrong value", and `nodePolicyRows(null)` and
 * `nodePrekeyRows(null)` both already say `unknown`.
 */
export function nodePairingWindowRows(
  listing: NodeE2eeClientListing | null,
): ReadonlyArray<NodeFactRow> {
  if (listing === null) return [{ label: "Pairing window", value: UNKNOWN }];
  const window = listing.pairingWindow;
  if (window === undefined) return [{ label: "Pairing window", value: "closed" }];
  return [
    { label: "Pairing window", value: "open" },
    { label: "Only this fingerprint", value: window.fingerprint, mono: true },
    { label: "Expires", value: formatNodeEpoch(window.expiresAt) },
    { label: "Reservation", value: window.spent ? "spent" : "unspent" },
  ];
}

/**
 * §13.6's refused-attempt counter, or the same stated absence.
 *
 * `?? 0` on an unread listing renders "0 attempt(s) refused" — a count the panel
 * does not have, drawn as the reassuring value.
 */
export function nodeRefusedAttemptsDescription(listing: NodeE2eeClientListing | null): string {
  if (listing === null) {
    return "How many pairing attempts this node refused because the pending list was full has not been read here.";
  }
  return `${listing.refusedPairingAttempts} attempt(s) refused because the pending list was full.`;
}

/** The row copy for a pairing window, which is a §13.6 admission-widening tool. */
export const NODE_PAIRING_WINDOW_DESCRIPTION =
  "A window lets exactly one device introduce itself, and only the one whose fingerprint you name.";

// ─────────────────────────────────────────────────────────────────────────────
// §13.5 LIVE SESSIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How one live session is labelled.
 *
 * The tier word is the node's own (`native` / `web`) and the suite is the §3.4
 * registry number. No confidentiality claim is attached to either: a session
 * being open says a handshake completed, and this panel does not restate what
 * §2.2 says that is worth.
 */
export function nodeSessionRows(session: NodeE2eeSession): ReadonlyArray<NodeFactRow> {
  return [
    {
      label: "Tier",
      value: session.tier === "native" ? "native (IK)" : "browser (NX)",
    },
    { label: "Suite", value: String(session.suite) },
    { label: "Established", value: formatNodeEpoch(session.establishedAt) },
  ];
}

/**
 * What a native session offers instead of a §13.5 code.
 *
 * §13.5 has no native meaning — the long-term §13.4 value on the record is the
 * one to compare for a signed client — so the row points at it rather than
 * rendering a blank that reads as a missing value.
 */
export const NODE_SESSION_NATIVE_CODE_ABSENT =
  "Native sessions have no per-session code. Compare this device's long-term number on its record above instead.";

// ─────────────────────────────────────────────────────────────────────────────
// §13.5 FROM THE NODE'S END OF THE COMPARISON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §13.5's advisory WRITTEN FROM THE NODE END, because a comparison has two ends
 * and the shipped one names only the other.
 *
 * `E2EE_WEB_SAS_ADVISORY` says "Compare this code with the one your node's CLI
 * shows", and it is correct where it ships: a browser holding its own channel's
 * code is told to check it against the node. Rendered on the NODE's live-session
 * list it inverts — the reader is already at the node, so the instruction sends
 * them to compare the node against itself, which always matches and establishes
 * nothing. Its ceiling clause inverts with it: "the Hub operator, who serves this
 * page" is the party serving the BROWSER its page, and in local mode the node is
 * serving this one.
 *
 * So the node end gets its own sentence, with §13.5's denial restated in node-end
 * terms and no weaker: the match is against the remote browser's screen, and it
 * still cannot rule out whoever served that browser its JavaScript.
 */
export const NODE_SESSION_WEB_SAS_ADVISORY =
  "Compare this code with the one that browser is showing for this session, on that screen. A " +
  "match catches accidental wrong-node routing and some network interposition — anyone standing " +
  "in for this node who is not also serving that browser its page — while the code that browser " +
  "loaded is honest; it cannot protect against whoever served that page, and a match does not " +
  "rule out someone sitting in the middle.";

/** The node end's absence sentence, for the same reason §13.5's own has one. */
export const NODE_SESSION_WEB_SAS_UNAVAILABLE =
  "No session code reached this listing for that channel, so there is nothing here to compare " +
  "against the browser holding it.";

/**
 * §13.5's value for a session on the node's own list, as one inseparable object.
 *
 * The format validation, the groups, and the display value are the shipped
 * function's — this is not a second parser, and a value that function refuses is
 * refused here. Only the advisory is replaced, and only because its referent is
 * the other end of the comparison. It is still a required field on the returned
 * object, so drawing these characters without a sentence takes deleting a field.
 *
 * IT IS NO LONGER AN ALIAS OF THE BROWSER-END VIEW, and the difference is the
 * `more` field rather than a style choice. The browser end ships a short line
 * plus a pointer at the long account in Settings → Security; the node end has
 * one form and, in local mode, the reader is already inside Settings → Security,
 * so a pointer there would send them to the page they are standing on. The
 * placement argument below is only what satisfies the shipped validator — every
 * string it chose is discarded.
 *
 * THE ABSENCE IS STATED, NOT OMITTED. `more` is `null` here rather than missing,
 * because `VerificationCode` renders both ends: an optional field made "this end
 * has none" and "this caller forgot one" the same shape at the boundary, and the
 * field the browser end would then silently lose is the one naming
 * `ryco e2ee sessions`.
 */
export interface NodeSessionVerificationView {
  readonly groups: ReadonlyArray<string>;
  /** The groups re-joined with the format's own separator. */
  readonly display: string;
  readonly advisory: string;
  /** Always `null`: the reader is already on the page a pointer would name. */
  readonly more: null;
}

export function nodeSessionVerificationView(
  code: string | null,
): NodeSessionVerificationView | null {
  const view = hostedE2eeVerificationView(code, "inline");
  if (view === null) return null;
  return {
    groups: view.groups,
    display: view.display,
    advisory: NODE_SESSION_WEB_SAS_ADVISORY,
    more: null,
  };
}

/**
 * The live-session row's description.
 *
 * It does NOT repeat the comparison instruction. Two comparison sentences one
 * line apart is how the panel came to tell an owner to check the browser's screen
 * and the node's own CLI about the same characters; the instruction lives in the
 * advisory that travels with the value, and nowhere else.
 */
export const NODE_SESSION_WEB_ROW_DESCRIPTION =
  "A browser channel this node has open. Its per-session code is below.";

// ─────────────────────────────────────────────────────────────────────────────
// §12.3–§12.6 ADMISSION POLICY
// ─────────────────────────────────────────────────────────────────────────────

export function nodePolicyRows(policy: NodeE2eePolicy | null): ReadonlyArray<NodeFactRow> {
  if (policy === null) return [{ label: "Admission policy", value: UNKNOWN }];
  return [
    // §12.4's implication makes the raw and the effective value differ, and a
    // display showing only one would either understate the guarantee or
    // misreport the configuration. Both, always.
    { label: "requireE2EE", value: String(policy.requireE2EE), mono: true },
    {
      label: "requireApprovedClientE2EE",
      value: String(policy.requireApprovedClientE2EE),
      mono: true,
    },
    { label: "Effective requireE2EE", value: String(policy.effectiveRequireE2EE), mono: true },
    { label: "Admitted patterns", value: policy.admittedPatterns.join(", ") || "none" },
    { label: "Suite registry", value: policy.suiteRegistry.join(", ") || "none" },
    { label: "Policy generation", value: String(policy.generation) },
  ];
}

/**
 * §12.6's pre-change warnings, computed from a preview and never from a guess.
 *
 * THE PREVIEW IS NOT OPTIONAL AND IS NOT A FLAG ON THE CHANGE. §12.6 puts the
 * display duty BEFORE the change runs and the node keeps `policy/preview` a
 * separate route that mutates nothing, so the panel asks it first, shows what
 * comes back, and only then offers to apply. One request that could warn or
 * sweep depending on a boolean is the shape most likely to sweep when an
 * operator meant to look.
 *
 * The counts are approximate by nature — channels open and close while the
 * operator reads them — and §12.6 says so in as many words, so the sentence does
 * too.
 */
export function nodePolicyPreviewWarnings(
  preview: NodeE2eePolicyChange,
  proposal: NodeE2eePolicyProposal,
  current: NodeE2eePolicy | null,
): ReadonlyArray<string> {
  const warnings: string[] = [];
  if (proposal.requireApprovedClientE2EE === true) {
    // §12.4 requires the warning at enable time and requires it to say three
    // things: that the policy closes web and legacy access entirely, that it can
    // strand remote access if every approved native client key is lost, and that
    // enabling it closes the live channels it no longer admits.
    warnings.push(
      "requireApprovedClientE2EE closes browser and legacy access entirely. Only approved native client keys reach application payload after this, and losing every approved key strands remote access to this node until someone recovers it at the machine — which never relaxes admission policy.",
    );
  }
  for (const widening of nodePolicyWidenings(proposal, current)) warnings.push(widening);
  if (preview.withdrawal) {
    warnings.push(
      `This narrows what the node admits, so it closes live channels. Roughly matching now: ${preview.counts.legacy} legacy, ${preview.counts.nxE2ee} browser, ${preview.counts.suiteWithdrawn} on a withdrawn suite, and ${preview.counts.abortedHandshakes} handshake(s) in flight. These move while you read them.`,
    );
  }
  if (!preview.changed) {
    warnings.push("This changes nothing: the node already admits exactly this.");
  }
  // NO BRANCH OF THIS DIALOG IS PURELY REASSURING. The panel used to render an
  // empty list as "The node reports that this closes no live channels." — the
  // one sentence an owner saw while turning `requireE2EE` off, which is the
  // change that re-admits plaintext. A widening closes nothing by definition, so
  // the count sentence is true and useless there, and the fallback below says
  // what it is a statement about.
  if (warnings.length === 0) warnings.push(NODE_POLICY_NO_WITHDRAWAL_NOTICE);
  return warnings;
}

/**
 * What the node will admit AFTER a proposal that relaxes admission, in the
 * consequence's own terms.
 *
 * Read against the policy the node currently reports rather than against the
 * preview, because §12.6's preview answers with the RESULTING policy: a proposal
 * turning `requireE2EE` off comes back with `requireE2EE: false` either way, so
 * the preview alone cannot tell a change from a restatement. An unread current
 * policy (`null`) warns rather than stays quiet — not knowing what the node
 * enforces now is not a reason to tell an owner nothing is being given up.
 */
function nodePolicyWidenings(
  proposal: NodeE2eePolicyProposal,
  current: NodeE2eePolicy | null,
): ReadonlyArray<string> {
  const widenings: string[] = [];
  if (proposal.requireE2EE === false && current?.requireE2EE !== false) {
    widenings.push(
      "Turning this off re-admits plaintext. The node goes back to accepting relay payload it has not encrypted, for browsers and for legacy clients, and the Hub carries that in a form it can read. It closes nothing now — what changes is what the node accepts next.",
    );
  }
  if (
    proposal.requireApprovedClientE2EE === false &&
    current?.requireApprovedClientE2EE !== false
  ) {
    widenings.push(
      "Clearing this re-admits the browser and legacy tiers. Client keys this node has not approved reach it again on their next connection, under whatever the remaining policy allows.",
    );
  }
  return widenings;
}

/**
 * §12.6's count sentence when there is nothing else to say, written so it is not
 * a reassurance.
 */
export const NODE_POLICY_NO_WITHDRAWAL_NOTICE =
  "The node reports that this closes no channel it has open now. That is a statement about the " +
  "live channels and not about what the node will admit afterwards.";

/**
 * Whether the confirmation for a policy change should read as destructive.
 *
 * IT DISCRIMINATES, WHICH IS THE ONLY THING A RED BUTTON IS FOR. Every policy
 * change used to draw the same red Apply, including the ones whose own body said
 * they closed nothing — and an owner taught to click through one red affordance
 * clicks through the one that strands their access. Red means the node will shut
 * live channels, or the change reduces what it enforces.
 */
export function nodePolicyChangeDestructive(
  preview: NodeE2eePolicyChange,
  proposal: NodeE2eePolicyProposal,
  current: NodeE2eePolicy | null,
): boolean {
  return preview.withdrawal || nodePolicyWidenings(proposal, current).length > 0;
}

/** What the node reported after a change actually ran (§12.6(c)). */
export function nodePolicyChangeSummary(change: NodeE2eePolicyChange): string {
  return [
    change.changed ? "Policy committed." : "Policy unchanged.",
    `Closed ${change.counts.legacy} legacy channel(s), ${change.counts.nxE2ee} browser channel(s), ${change.counts.suiteWithdrawn} suite-withdrawn channel(s); aborted ${change.counts.abortedHandshakes} handshake(s) in flight.`,
  ].join(" ");
}

/**
 * §5.7's recovery warning, which the node's CLI prints before the jump and this
 * panel shows before the confirmation for the same reason: §5.7 requires the
 * jump to be deliberate, and requires the operator to be told that clients
 * accept only a strictly higher generation than the one they remember.
 */
export const NODE_POLICY_RECOVER_WARNING =
  "This advances the policy generation past every value this node may already have advertised, " +
  "and the jump is deliberate. Clients accept only a higher generation than the one they " +
  "remember, so nothing below the new value can be advertised again. " +
  // §12.4's consequence, spelled out rather than named. The node decides which
  // of the two outcomes this command has — it commits the fail-closed policy
  // when the record sits below the anchor's high-water mark, and nothing this
  // panel can read tells an operator which they are about to get. "Commits the
  // fail-closed policy" is not a sentence an owner can price; what it does is.
  "If a restore rolled the record back, recovery does not restore the old values: it commits the " +
  "fail-closed policy, which admits only approved native client keys and so closes browser and " +
  "legacy access entirely, including every remote browser session open now. There is no way to " +
  "tell from here which of the two this will be. Widening it back is a separate, explicit policy " +
  "change, and if this node's only remaining access was a browser it has to be made at the " +
  "machine.";

// ─────────────────────────────────────────────────────────────────────────────
// §12.5 FALLBACK DIAGNOSTICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §12.5's counters, as the thing an owner actually watches during a rollout
 * observation window rather than as a dump of the record.
 *
 * The two classes stay SEPARATE and are never summed: §12.5 requires it, and
 * they mean different things — a peer that spoke legacy is not the same event as
 * this node failing to emit an advertisement, and one total would hide which was
 * happening.
 */
export interface NodeFallbackReport {
  readonly windowStarted: string;
  readonly classes: ReadonlyArray<{
    readonly label: string;
    readonly meaning: string;
    readonly occurrences: number;
    readonly lastOccurrence: string;
    readonly ringOverflows: number;
  }>;
  /**
   * The retained occurrences in time order with their reason labels — §12.5
   * requires the SHAPE to be legible, and a bare count is not a shape.
   *
   * `ordinal` is the position after sorting, and it exists because two entries
   * can share a millisecond and a reason: without it the only key a list could
   * form from this data is a duplicate.
   */
  readonly entries: ReadonlyArray<{
    readonly ordinal: number;
    readonly at: string;
    readonly reason: string;
  }>;
  /** Present only when a ring overflowed, and adjacent to the ring by §12.5. */
  readonly overflowNotice: string | null;
  /** Present only while the condition is live (§12.5 scopes it to the connection). */
  readonly undersizedNotice: string | null;
  readonly quiet: boolean;
}

export function nodeFallbackReport(fallback: NodeE2eeFallback | null): NodeFallbackReport | null {
  if (fallback === null) return null;
  const overflowed =
    fallback.peerLegacy.ringOverflows > 0 || fallback.advertisementUnavailable.ringOverflows > 0;
  return {
    windowStarted: formatNodeEpoch(fallback.windowStartedAt),
    classes: [
      {
        label: "Peer spoke legacy",
        meaning:
          "The other end did not take the encrypted channel, so this one carried readable payload.",
        occurrences: fallback.peerLegacy.occurrences,
        lastOccurrence: formatNodeEpoch(fallback.peerLegacy.lastOccurrenceAt),
        ringOverflows: fallback.peerLegacy.ringOverflows,
      },
      {
        label: "No advertisement",
        meaning:
          "This node could not offer an encrypted channel, or the offer did not survive the path. It cannot tell which.",
        occurrences: fallback.advertisementUnavailable.occurrences,
        lastOccurrence: formatNodeEpoch(fallback.advertisementUnavailable.lastOccurrenceAt),
        ringOverflows: fallback.advertisementUnavailable.ringOverflows,
      },
    ],
    entries: [...fallback.ring]
      .toSorted((left, right) => left.occurredAt - right.occurredAt)
      .map((entry, ordinal) => ({
        ordinal,
        at: formatNodeEpoch(entry.occurredAt),
        reason: entry.reason,
      })),
    overflowNotice: overflowed
      ? "The retained list overflowed, so it is an incomplete account of this window. The shape of what is left is not evidence in either direction."
      : null,
    undersizedNotice:
      fallback.undersizedConnection === undefined
        ? null
        : `This connection asserts a maximum chunk of ${fallback.undersizedConnection.assertedMaxDataChunkBytes} bytes, below the ${fallback.undersizedConnection.advertisementMinChunkBytes} bytes an offer needs. Nothing that fits can carry one, so this node offers nothing on this connection.`,
    quiet:
      fallback.peerLegacy.occurrences === 0 &&
      fallback.advertisementUnavailable.occurrences === 0 &&
      fallback.ring.length === 0,
  };
}

export const NODE_FALLBACK_QUIET =
  "Nothing has fallen back in this window. This counts what happened, not what could — a quiet window is not a statement about the next one.";

// ─────────────────────────────────────────────────────────────────────────────
// OWNER ACTIONS AND THEIR CONFIRMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every mutation the panel offers, with a confirmation proportionate to its
 * consequence.
 *
 * `destructive` is not a colour decision. It marks the actions whose effect
 * reaches beyond this panel and cannot be taken back by pressing the same button
 * again: §13.6's withdrawals close the target's live channels before the node
 * acknowledges them, and §7.5's re-mint sends every paired client back through a
 * fresh pairing ceremony.
 *
 * The body of each is what the owner is agreeing to, in the consequence's own
 * terms. `confirmLabel` never repeats the neutral verb — an owner scanning two
 * buttons reads the labels, not the paragraph.
 */
export type NodeE2eeActionId =
  | "approve"
  | "narrow"
  | "revoke"
  | "purge"
  | "open-window"
  | "close-window"
  | "clear-refusals"
  | "rotate-prekey"
  | "recover-policy"
  | "reset-fallback"
  | "remint-continuity"
  | "break-continuity";

export interface NodeE2eeActionConfirmation {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
  /**
   * The exact record or value this confirmation is about, drawn in the same
   * mono face the record's own facts use.
   *
   * §13.6's per-record withdrawals need it. A confirmation that names no record
   * catches an accidental click and nothing else — and two devices paired under
   * one Hub account render with the same account, the same origin, and, since
   * nothing here sets `displayLabel`, the same stored label. The dialog paints an
   * opaque scrim over the list, so the row behind it cannot be re-read either:
   * whatever tells the two apart has to be inside the dialog.
   */
  readonly facts?: ReadonlyArray<NodeFactRow>;
}

const ACTION_CONFIRMATIONS = {
  approve: {
    title: "Approve this client key?",
    // §13.6: a first approval is authority-widening, so it takes effect only on
    // a fresh ticket, channel, and handshake — never on one already open.
    body: "The device holding this key may then reach this node, at most with the role and capability this approval names. Compare its number against the device first. It takes effect on its next connection, not on anything open now.",
    confirmLabel: "Approve key",
    destructive: false,
  },
  narrow: {
    title: "Reduce what this client may do?",
    // The capability clause is not a hedge. The panel sends `narrow` with no
    // capability set and the node reads that as "leave capabilities alone"
    // (`capabilitySet ?? found.entry.capabilitySet`), so the role ceiling is the
    // only dimension that moves — while §13.6 treats the capability grant as a
    // separate authority the owner names, and this panel's own approve flow makes
    // them name it.
    //
    // The reconnect clause is CONDITIONAL because the outcome is. §8.3 makes the
    // device's intended role equal its `channel.open` role, so a ceiling below
    // that refuses it rather than limiting it. The old sentence — "The device
    // reconnects with the smaller role ceiling" — promised a reconnect the node
    // then refused on every handshake. The panel offers this action only when
    // the role the device connects with already fits (`nodeNarrowOffered`) —
    // as the node recorded it when the device introduced itself, which nothing
    // refreshes once the record is approved, so the sentence says that too.
    body: "Anything this device has open under the wider authority closes immediately — the node will not confirm the change until those channels are shut. It can reconnect only while the role it connects with fits under the new ceiling. The role it introduced itself with does; if the Hub has raised its account's role since, it is refused, not limited. Its capability grant is left exactly as it is; only the ceiling drops, and changing the capabilities is a separate command on the node.",
    confirmLabel: "Reduce authority",
    destructive: true,
  },
  revoke: {
    title: "Revoke this client key?",
    body: "The device loses access now: every channel it has open closes before this is confirmed, and it cannot reconnect until you approve it again. The record stays, so you can see it was revoked.",
    confirmLabel: "Revoke key",
    destructive: true,
  },
  purge: {
    title: "Delete this client record?",
    body: "The same immediate disconnection as revoking, and the record goes with it — there will be nothing left showing this device was ever here. If it connects again it arrives as a stranger and pairs from scratch.",
    confirmLabel: "Delete record",
    destructive: true,
  },
  "open-window": {
    title: "Open a pairing window for this fingerprint?",
    body: "For a short time this node will accept one introduction, and only from the key whose fingerprint you name. Read that fingerprint off the device itself — a window naming the wrong one lets the wrong device in.",
    confirmLabel: "Open window",
    destructive: false,
  },
  "close-window": {
    title: "Close the pairing window?",
    body: "No new device can introduce itself until you open another. Anything already introduced keeps its record.",
    confirmLabel: "Close window",
    destructive: false,
  },
  "clear-refusals": {
    title: "Clear the refused-attempt count?",
    body: "The count goes back to zero. Do this once you have dealt with what caused it, so the next reading is about the next thing rather than about history.",
    confirmLabel: "Clear count",
    destructive: false,
  },
  "rotate-prekey": {
    title: "Issue a new agreement prekey?",
    body: "The node makes a fresh key pair and certificate immediately. Clients pick the new one up on their next connection; nothing already open is disturbed.",
    confirmLabel: "Rotate prekey",
    destructive: false,
  },
  "recover-policy": {
    title: "Advance the policy generation?",
    body: NODE_POLICY_RECOVER_WARNING,
    confirmLabel: "Advance generation",
    destructive: true,
  },
  "reset-fallback": {
    title: "Reset the fallback counters?",
    body: "Both counts and the retained list go back to empty and a new observation window starts. What was recorded is gone; nothing else changes.",
    confirmLabel: "Reset counters",
    destructive: false,
  },
  "remint-continuity": {
    title: "Break continuity and mint a fresh lineage?",
    body: "Every device that has paired with this node has to go through the whole pairing ceremony again, in person, before it can reconnect. Do this when you believe the lineage is wrong, not to tidy it up.",
    confirmLabel: "Mint fresh lineage",
    destructive: true,
  },
  "break-continuity": {
    title: "Break the continuity chain?",
    body: "The lineage keeps its name, but every device that pinned this node has to go through the pairing ceremony again before it can reconnect.",
    confirmLabel: "Break chain",
    destructive: true,
  },
} as const satisfies Record<NodeE2eeActionId, NodeE2eeActionConfirmation>;

export function nodeE2eeActionConfirmation(action: NodeE2eeActionId): NodeE2eeActionConfirmation {
  return ACTION_CONFIRMATIONS[action];
}

/** The three §13.6 commands that name one record and act on it alone. */
export const NODE_E2EE_RECORD_ACTION_IDS = ["narrow", "revoke", "purge"] as const;
export type NodeE2eeRecordActionId = (typeof NODE_E2EE_RECORD_ACTION_IDS)[number];

/** The record key a per-record confirmation echoes back. */
export interface NodeE2eeRecordSubject {
  readonly fingerprint: string;
  readonly accountId: string;
  readonly hubOrigin: string;
}

/**
 * Why a per-record confirmation carries the record and not only the verb.
 *
 * `purge` is the sharpest case: the node removes the record and echoes nothing
 * back, deliberately — "echoing a stale copy of a record the owner just deleted
 * would be the one answer an operator could misread as 'it is still there'". So
 * the last chance to see which record is going is this dialog.
 */
export const NODE_E2EE_RECORD_SUBJECT_PROMPT =
  "It applies to the key below and to no other. Check the fingerprint against the device you " +
  "meant: two devices paired under one account are told apart by nothing else here.";

export function nodeE2eeRecordSubjectFacts(
  subject: NodeE2eeRecordSubject,
): ReadonlyArray<NodeFactRow> {
  return [
    { label: "Fingerprint", value: subject.fingerprint, mono: true },
    { label: "Account", value: subject.accountId },
    { label: "Hub origin", value: subject.hubOrigin },
  ];
}

export function nodeE2eeRecordConfirmation(
  action: NodeE2eeRecordActionId,
  subject: NodeE2eeRecordSubject,
): NodeE2eeActionConfirmation {
  const base = ACTION_CONFIRMATIONS[action];
  return {
    ...base,
    body: `${base.body} ${NODE_E2EE_RECORD_SUBJECT_PROMPT}`,
    facts: nodeE2eeRecordSubjectFacts(subject),
  };
}

/**
 * The pairing-window confirmation, with the fingerprint it is about to admit.
 *
 * The body already names a wrong fingerprint as the exact risk — "a window naming
 * the wrong one lets the wrong device in" — while withholding the value that was
 * named, behind a scrim that makes the input unreadable. The node parses the
 * value and refuses only an unparseable one, never a wrong one, so this dialog is
 * the last place a transposed character or a stale paste can be caught.
 */
export function nodeE2eePairingWindowConfirmation(fingerprint: string): NodeE2eeActionConfirmation {
  const base = ACTION_CONFIRMATIONS["open-window"];
  return {
    ...base,
    body: `${base.body} Read the value below off the device now, before confirming.`,
    facts: [{ label: "Only this fingerprint", value: fingerprint, mono: true }],
  };
}

/**
 * §8.3's role vocabulary, in its ordering, least authority first.
 *
 * It is the set an approval may name and the ranking a narrowing is judged by.
 * It is NOT a menu: see `nodeApprovalRole` for why the panel offers one role.
 */
export const NODE_E2EE_APPROVABLE_ROLES = ["viewer", "operator", "owner"] as const;
export type NodeE2eeApprovableRole = (typeof NODE_E2EE_APPROVABLE_ROLES)[number];

/** §8.3's rank, or -1 for anything outside the vocabulary. */
function nodeRoleRank(role: string | undefined): number {
  return (NODE_E2EE_APPROVABLE_ROLES as ReadonlyArray<string | undefined>).indexOf(role);
}

/**
 * The one role an approval from this panel names: the role the node saw this
 * device connect with.
 *
 * NOT A MENU, AND NOT A DEFAULT THE PANEL PICKED. §8.3 makes a native client's
 * intended role equal the `channel.open` role the Hub assigns, and §8.6 step 6
 * admits it only under a `maxRole` at least that high — the node's account-grant
 * verifier applies the same ceiling, so this holds on both suites. A ceiling
 * BELOW the observed role does not limit the device: the record commits as
 * `approved`, the row goes green, and every handshake it attempts is refused.
 * The three buttons this replaced listed `viewer` first, which put exactly that
 * lockout under the cursor first, for every owner approving their own phone. A
 * ceiling ABOVE it grants headroom the Hub never assigned, which is what the
 * node-local ceiling exists to withhold. The observed role is the only value
 * that is neither — and it is never inferred from whose account this is.
 *
 * The owner still names it (§13.6): the confirmation states the role, what it
 * can do, and the account it is for, and approving is their action. `null` when
 * the record carries no role it can rank — it predates the field, or came from a
 * Local Trusted Introduction — because offering one then is a guess, and a wrong
 * guess is the lockout. `nodeApprovalWithheldNotice` says what to do instead.
 *
 * PENDING RECORDS ONLY. The node follows the observed role while a record is
 * pending and freezes it once the owner acts, because a peer's hello never
 * rewrites an `approved` or `revoked` record. On a revoked record it is the role
 * the device had when it introduced itself, and the Hub may assign another now:
 * re-approving at it could lock the device out, or grant headroom the Hub no
 * longer assigns. So a revoked key comes back the way it first arrived — a fresh
 * introduction this panel can compare and approve — or at a role the owner
 * names on the node.
 */
export function nodeApprovalRole(record: NodeE2eeClientRecord): NodeE2eeApprovableRole | null {
  if (record.status !== "pending") return null;
  const rank = nodeRoleRank(record.observedRole);
  return rank < 0 ? null : NODE_E2EE_APPROVABLE_ROLES[rank]!;
}

export const NODE_APPROVAL_ROLE_UNKNOWN_PENDING =
  "This request does not say which role the device connects with, so no approval here could " +
  "let it in. Have the device try again: its next attempt records the role, and the approve " +
  "action appears on this row.";

export const NODE_APPROVAL_REVOKED_NOTICE =
  "A revoked key is not re-approved from here. The role on this record is the one the device " +
  "introduced itself with, and the Hub may open its channels under another now — a smaller " +
  "ceiling would refuse the device, a larger one would grant what the Hub no longer assigns. " +
  "Delete the record and let the device introduce itself again, then approve the new request " +
  "here, or name the role on the node with `ryco e2ee client approve --max-role`.";

/**
 * Why a record that is not approved offers no approval, or `null` when it does.
 *
 * A pending record recovers on its own — the node refreshes its observed role on
 * the device's next attempt. A revoked one does not, because a peer's hello never
 * rewrites a record the owner revoked, so the way back is a fresh introduction
 * (see `nodeApprovalRole`).
 */
export function nodeApprovalWithheldNotice(record: NodeE2eeClientRecord): string | null {
  switch (record.status) {
    case "approved":
      return null;
    case "revoked":
      return NODE_APPROVAL_REVOKED_NOTICE;
    case "pending":
      return nodeApprovalRole(record) === null ? NODE_APPROVAL_ROLE_UNKNOWN_PENDING : null;
  }
}

/**
 * How many pending records share this record's §13.6 partition — the same
 * `(hubOrigin, accountId)` — this one included, or 0 for a record that is not
 * pending.
 *
 * Counted from the listing the panel actually holds, so the warning below and
 * the rows it sits on describe the same read.
 */
export function nodePendingInPartition(
  listing: NodeE2eeClientListing | null,
  record: NodeE2eeClientRecord,
): number {
  if (listing === null || record.status !== "pending") return 0;
  return listing.records.filter(
    (entry) =>
      entry.status === "pending" &&
      entry.hubOrigin === record.hubOrigin &&
      entry.accountId === record.accountId,
  ).length;
}

/**
 * The warning for a partition holding more than one pending request.
 *
 * One request under an account is the ordinary case: the phone being held. A
 * second is either another device on that account or a key the Hub introduced
 * under it — the account need not be the owner's own, hence "this account" —
 * and the two read identically here except for the fingerprint and the number.
 * That is the moment an owner most needs to compare rather than pick, so it is
 * said on the row and again in the dialog.
 */
export function nodePendingPartitionWarning(pendingInPartition: number): string | null {
  if (pendingInPartition <= 1) return null;
  return (
    `${pendingInPartition} requests are waiting under this account at this Hub. A Hub can open ` +
    "one under this account from a key of its own, and it reads exactly like the phone's except " +
    "for the fingerprint and the number. Approve only the row whose number matches the phone in " +
    "your hand, and delete any you cannot account for."
  );
}

/**
 * Whether lowering an approved record's ceiling to `ceiling` still lets the
 * device in.
 *
 * Only when the role it connects with already fits under the new ceiling, and
 * the ceiling actually drops. Anything else is a lockout presented as a limit —
 * the device is refused on its next handshake, not narrowed — and Revoke already
 * says that honestly. A record that does not carry the role offers nothing,
 * for the same reason `nodeApprovalRole` does not guess one.
 *
 * The role is the one the device introduced itself with, frozen when the owner
 * approved it, so the Hub may have raised it since. That is still offered: a
 * narrowing only ever withdraws authority, so the worst a stale role costs is a
 * refusal the owner asked for, and the confirmation says it can happen. A
 * re-approval widens, which is why `nodeApprovalRole` does not offer one on a
 * record whose role it can no longer vouch for.
 */
export function nodeNarrowOffered(
  record: NodeE2eeClientRecord,
  ceiling: NodeE2eeApprovableRole,
): boolean {
  if (record.status !== "approved") return false;
  const target = nodeRoleRank(ceiling);
  const observed = nodeRoleRank(record.observedRole);
  return nodeRoleRank(record.maxRole) > target && observed >= 0 && observed <= target;
}

const APPROVAL_ROLE_MEANINGS: Record<NodeE2eeApprovableRole, string> = {
  viewer: "read what is there",
  operator: "edit files and run terminals",
  owner: "also change credentials and server policy",
};

/**
 * The capability set an approval from this panel grants.
 *
 * IT IS NOT EMPTY, AND AN EMPTY ONE IS NOT "THE LEAST IT CAN BE" — IT IS BELOW
 * THE LEAST USABLE VALUE. §8.6 step 6 admits a native handshake only when
 * `record.capabilitySet.includes(intendedCapability)`, unconditionally on that
 * tier and not gated on `requireApprovedClientE2EE`. `RelayCapability` is a
 * closed vocabulary with one member, so an empty set matches nothing a relay
 * channel can ever intend: the record commits as `approved`, the row goes green,
 * and every handshake the device attempts dies with fatal P12 `authorization`.
 * The node's own CLI makes that state unreachable — `--capability` is
 * `Flag.atLeast(1)` — and this panel was the only way to reach it.
 *
 * The element is typed as `RelayCapability`, so widening or renaming the relay
 * capability vocabulary in `@ryco/contracts` stops this file compiling rather
 * than silently leaving an approval that admits nothing.
 */
export const NODE_E2EE_APPROVAL_CAPABILITY_SET: ReadonlyArray<RelayCapability> = ["ryco.rpc"];

/**
 * The approval confirmation, with the role it grants written into it and the
 * record it names.
 *
 * §13.6 has the owner name the maximum role AND the capability set. The role is
 * the one the device connects with (`nodeApprovalRole`), and the sentence says
 * so — and says that a smaller one would refuse the device, so an owner who
 * does not want this account holding that much here revokes instead of
 * approving lower. The capability set is not a choice this surface can offer,
 * because there is exactly one capability a relay channel carries and any other
 * value approves a key that cannot connect; so the sentence states what is
 * granted rather than implying an empty grant is a smaller one.
 *
 * THE DIALOG CARRIES THE WHOLE NUMBER. Its scrim hides the row the owner just
 * compared, so the last look before the key is approved has to be inside the
 * dialog — all of it, never a tail — and, when the account has more than one
 * request waiting, so does the reason to look twice.
 */
export interface NodeE2eeApprovalSubject extends NodeE2eeRecordSubject {
  /** §13.4's display string, as the record stores it. */
  readonly safetyNumber: string;
  /** `nodePendingInPartition` for the record being approved. */
  readonly pendingInPartition: number;
}

export const NODE_APPROVE_NUMBER_PROMPT =
  "The number below is the one you matched against the phone; read it once more before " +
  "confirming.";

export function nodeApproveConfirmation(
  role: NodeE2eeApprovableRole,
  subject?: NodeE2eeApprovalSubject,
): NodeE2eeActionConfirmation {
  const base = ACTION_CONFIRMATIONS.approve;
  const capabilities = NODE_E2EE_APPROVAL_CAPABILITY_SET.join(", ");
  const number = subject === undefined ? null : nodeSafetyNumberView(subject.safetyNumber);
  const partition =
    subject === undefined ? null : nodePendingPartitionWarning(subject.pendingInPartition);
  const subjectSentences =
    subject === undefined
      ? []
      : [
          ...(number === null ? [] : [NODE_APPROVE_NUMBER_PROMPT]),
          ...(partition === null ? [] : [partition]),
          NODE_E2EE_RECORD_SUBJECT_PROMPT,
        ];
  return {
    title: `Approve this client key as ${role}?`,
    body: [
      `${base.body} This device connects as ${role}, so that is the ceiling it is approved at: ` +
        `at most it will be able to ${APPROVAL_ROLE_MEANINGS[role]}. A smaller ceiling would ` +
        `refuse the device rather than limit it — if this account should not hold that much on ` +
        `this node, revoke the key instead.`,
      `It is granted the one capability a relay channel carries, ${capabilities} — a key ` +
        `approved with none is admitted by nothing and could not connect at all.`,
      ...subjectSentences,
    ].join(" "),
    confirmLabel: `Approve as ${role}`,
    destructive: false,
    ...(subject === undefined
      ? {}
      : {
          facts: [
            ...nodeE2eeRecordSubjectFacts(subject),
            ...(number === null
              ? []
              : [{ label: "Comparison number", value: number.display, mono: true }]),
          ],
        }),
  };
}

/** Every action, for the scan that reads them all. */
export const NODE_E2EE_ACTION_IDS = Object.keys(
  ACTION_CONFIRMATIONS,
) as ReadonlyArray<NodeE2eeActionId>;

// ─────────────────────────────────────────────────────────────────────────────
// THE PANEL'S CLAIM-BEARING ROW COPY
// ─────────────────────────────────────────────────────────────────────────────
// Every sentence below is rendered by the `.tsx` and says something about what
// the node admits, encrypts, or refuses. They live here so the node suite's
// prohibited-claims scan reaches them; the browser suite runs the same list over
// the rendered DOM, which is what covers the layout copy that stays in the
// component.

export const NODE_PANEL_SUBTITLE =
  "What this node will admit, and which client keys it has on file.";

export const NODE_POLICY_REQUIRE_E2EE_TITLE = "Require an encrypted channel";
export const NODE_POLICY_REQUIRE_E2EE_DESCRIPTION = "Refuse plaintext, including for browsers.";

export const NODE_POLICY_STRICT_TITLE = "Only approved native client keys";
export const NODE_POLICY_STRICT_DESCRIPTION =
  "Closes browser and legacy access entirely. Only approved native client keys reach application payload.";

export const NODE_POLICY_GENERATION_DESCRIPTION =
  "Recover a generation that a restore rolled back.";

/**
 * What a policy switch says when the node's value for it has not been read.
 *
 * A disabled switch still draws in a position, and a position is a claim. In
 * hosted mode the policy is structurally unreadable — the operator routes are not
 * on the relay — so an off switch there asserted `requireApprovedClientE2EE:
 * false` about a node whose policy the same section had just said it cannot see.
 * The panel's convention everywhere else is a stated absence:
 * `nodePolicyRows(null)` says `Admission policy: unknown`,
 * `formatNodeEpoch(undefined)` says `never`.
 */
export const NODE_POLICY_VALUE_UNREADABLE =
  "Its current value on the node has not been read here, so nothing on this row states what it is.";

export const NODE_PREKEY_DESCRIPTION = "The key this node offers for new channels.";
export const NODE_CONTINUITY_DESCRIPTION = "The lineage paired clients remember this node by.";
export const NODE_NO_CLIENTS_DESCRIPTION = "No device has introduced itself to this node yet.";
export const NODE_NO_SESSIONS_DESCRIPTION = "Nothing is connected right now.";

/**
 * Every owner-facing sentence this module produces, flattened.
 *
 * IT WALKS THE PRODUCERS, NOT A LIST OF CONSTANTS. The earlier version enumerated
 * call sites by hand and missed most of what the panel renders — the fallback
 * report's class meanings, the listing notices, the preview warnings, the change
 * summary — so a banned phrase written into any of them passed the scan while
 * being drawn to owners. Every function that returns owner-facing prose is called
 * here with a representative input, and the DOM scan in the browser suite covers
 * what the `.tsx` still writes for itself.
 */
export function everyNodeSecurityString(): ReadonlyArray<{
  readonly where: string;
  readonly text: string;
}> {
  const strings: { where: string; text: string }[] = [];
  const push = (where: string, text: string) => {
    strings.push({ where, text });
  };
  const pushAll = (where: string, texts: ReadonlyArray<string>) => {
    texts.forEach((text, index) => push(`${where}[${index}]`, text));
  };
  const pushConfirmation = (where: string, confirmation: NodeE2eeActionConfirmation) => {
    push(`${where}.title`, confirmation.title);
    push(`${where}.body`, confirmation.body);
    push(`${where}.confirmLabel`, confirmation.confirmLabel);
    for (const fact of confirmation.facts ?? []) push(`${where}.fact(${fact.label})`, fact.label);
  };
  const pushRows = (where: string, rows: ReadonlyArray<NodeFactRow>) => {
    for (const row of rows) {
      push(`${where}.${row.label}.label`, row.label);
      push(`${where}.${row.label}.value`, row.value);
    }
  };

  for (const mode of ["local", "hosted"] as const) {
    const statement = nodeConnectionStatement(mode, null);
    push(`connection(${mode}).headline`, statement.headline);
    push(`connection(${mode}).body`, statement.body);
    const availability = nodeOperatorDataAvailability(mode);
    if (availability.unavailableBody !== "")
      push(`availability(${mode})`, availability.unavailableBody);
    const disposition = nodeE2eeStrictPolicyDisposition(mode);
    if (disposition.kind === "blocked") push(`strictPolicy(${mode})`, disposition.reason);
  }
  push("policyGateRefusal", NODE_E2EE_POLICY_GATE_REFUSAL);

  for (const action of NODE_E2EE_ACTION_IDS) {
    pushConfirmation(`action(${action})`, nodeE2eeActionConfirmation(action));
  }
  const subject: NodeE2eeRecordSubject = {
    fingerprint: "SHA256:example",
    accountId: "acct_example",
    hubOrigin: "https://hub.example",
  };
  for (const action of NODE_E2EE_RECORD_ACTION_IDS) {
    pushConfirmation(`record(${action})`, nodeE2eeRecordConfirmation(action, subject));
  }
  pushConfirmation("pairingWindow", nodeE2eePairingWindowConfirmation("SHA256:example"));
  const exampleSafetyNumber = Array.from({ length: E2EE_SAFETY_NUMBER_DIGITS.groups }, () =>
    "1".repeat(E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup),
  ).join(E2EE_SAFETY_NUMBER_DIGITS.separator);
  for (const role of NODE_E2EE_APPROVABLE_ROLES) {
    pushConfirmation(`approve(${role})`, nodeApproveConfirmation(role));
    pushConfirmation(
      `approve(${role}, record)`,
      nodeApproveConfirmation(role, {
        ...subject,
        safetyNumber: exampleSafetyNumber,
        pendingInPartition: 2,
      }),
    );
  }
  push("approveNumberPrompt", NODE_APPROVE_NUMBER_PROMPT);
  push("pendingPartitionWarning", nodePendingPartitionWarning(2) ?? "");
  push("safetyNumberMatchLabel", NODE_SAFETY_NUMBER_MATCH_LABEL);
  push("safetyNumberMatchHint", NODE_SAFETY_NUMBER_MATCH_HINT);
  push("recordSubjectPrompt", NODE_E2EE_RECORD_SUBJECT_PROMPT);
  for (const status of ["pending", "revoked"] as const) {
    push(
      `approvalWithheld(${status})`,
      nodeApprovalWithheldNotice({
        status,
        hubOrigin: "https://hub.example",
        accountId: "acct_example",
        fingerprint: "SHA256:example",
        maxRole: "viewer",
        capabilitySet: [],
        createdAt: 0,
        safetyNumber: "",
        pairingReserved: false,
      }) ?? "",
    );
  }

  for (const fingerprint of [null, "SHA256:example"]) {
    push(
      `enrollmentFingerprint(${fingerprint === null ? "absent" : "pending"})`,
      nodeEnrollmentFingerprintView(fingerprint).caption,
    );
  }

  // §6.4 / §7.5 remedies and rows, in every state that produces prose.
  push("prekeyRemedy(none)", nodePrekeyRemedy({ present: false }) ?? "");
  pushRows("prekeyRows(null)", nodePrekeyRows(null));
  pushRows("prekeyRows(none)", nodePrekeyRows({ present: false }));
  pushRows("continuityRows(null)", nodeContinuityRows(null));
  pushRows(
    "continuityRows(unavailable)",
    nodeContinuityRows({ status: "unavailable", reason: "anchor_disagrees" }),
  );
  pushRows("policyRows(null)", nodePolicyRows(null));
  pushRows("pairingWindowRows(null)", nodePairingWindowRows(null));
  push("refusedAttempts(null)", nodeRefusedAttemptsDescription(null));
  push(
    "refusedAttempts(read)",
    nodeRefusedAttemptsDescription({
      records: [],
      pendingGlobalSaturated: false,
      saturatedAccounts: [],
      refusedPairingAttempts: 3,
    }),
  );
  push("pairingWindowDescription", NODE_PAIRING_WINDOW_DESCRIPTION);

  // §13.6's listing instrumentation, in the state that produces both sentences.
  pushAll(
    "listingNotices",
    nodeClientListingNotices({
      records: [],
      pendingGlobalSaturated: true,
      saturatedAccounts: [],
      refusedPairingAttempts: 4,
    }),
  );

  // §12.6's warnings, in every branch, and §12.6(c)'s report.
  const previewPolicy: NodeE2eePolicy = {
    requireE2EE: true,
    requireApprovedClientE2EE: false,
    effectiveRequireE2EE: true,
    admittedPatterns: ["IK", "NX"],
    suiteRegistry: [1],
    generation: 4,
  };
  const change: NodeE2eePolicyChange = {
    policy: previewPolicy,
    withdrawal: true,
    changed: true,
    counts: { legacy: 1, nxE2ee: 2, suiteWithdrawn: 3, abortedHandshakes: 4 },
  };
  pushAll(
    "previewWarnings(strict)",
    nodePolicyPreviewWarnings(change, { requireApprovedClientE2EE: true }, previewPolicy),
  );
  pushAll(
    "previewWarnings(widenE2ee)",
    nodePolicyPreviewWarnings(
      { ...change, withdrawal: false },
      { requireE2EE: false },
      previewPolicy,
    ),
  );
  pushAll(
    "previewWarnings(widenStrict)",
    nodePolicyPreviewWarnings(
      { ...change, withdrawal: false },
      { requireApprovedClientE2EE: false },
      {
        ...previewPolicy,
        requireApprovedClientE2EE: true,
      },
    ),
  );
  pushAll(
    "previewWarnings(noop)",
    nodePolicyPreviewWarnings(
      { ...change, withdrawal: false, changed: false },
      { requireE2EE: true },
      previewPolicy,
    ),
  );
  pushAll(
    "previewWarnings(quiet)",
    nodePolicyPreviewWarnings(
      { ...change, withdrawal: false },
      { suiteRegistry: [1, 2] },
      previewPolicy,
    ),
  );
  push("policyChangeSummary", nodePolicyChangeSummary(change));
  push("policyChangeSummary(unchanged)", nodePolicyChangeSummary({ ...change, changed: false }));

  // §12.5's report, in the states that produce prose.
  const report = nodeFallbackReport({
    windowStartedAt: 1_000,
    peerLegacy: { occurrences: 1, ringOverflows: 1, lastOccurrenceAt: 2_000 },
    advertisementUnavailable: { occurrences: 2, ringOverflows: 0 },
    ring: [{ occurredAt: 2_000, reason: "peer-legacy" }],
    undersizedConnection: { assertedMaxDataChunkBytes: 100, advertisementMinChunkBytes: 512 },
  })!;
  for (const entry of report.classes) {
    push(`fallbackClass(${entry.label}).label`, entry.label);
    push(`fallbackClass(${entry.label}).meaning`, entry.meaning);
  }
  push("fallbackOverflow", report.overflowNotice!);
  push("fallbackUndersized", report.undersizedNotice!);

  push("safetyNumberCaption", NODE_SAFETY_NUMBER_CAPTION);
  push("safetyNumberAdvisory", NODE_SAFETY_NUMBER_ADVISORY);
  push("safetyNumberUnavailable", NODE_SAFETY_NUMBER_UNAVAILABLE);
  push("nativeSessionCode", NODE_SESSION_NATIVE_CODE_ABSENT);
  push("nodeSessionSasAdvisory", NODE_SESSION_WEB_SAS_ADVISORY);
  push("nodeSessionSasUnavailable", NODE_SESSION_WEB_SAS_UNAVAILABLE);
  push("nodeSessionRowDescription", NODE_SESSION_WEB_ROW_DESCRIPTION);
  push("policyRecoverWarning", NODE_POLICY_RECOVER_WARNING);
  push("policyNoWithdrawal", NODE_POLICY_NO_WITHDRAWAL_NOTICE);
  push("policyValueUnreadable", NODE_POLICY_VALUE_UNREADABLE);
  push("fallbackQuiet", NODE_FALLBACK_QUIET);

  push("panelSubtitle", NODE_PANEL_SUBTITLE);
  push("requireE2eeTitle", NODE_POLICY_REQUIRE_E2EE_TITLE);
  push("requireE2eeDescription", NODE_POLICY_REQUIRE_E2EE_DESCRIPTION);
  push("strictTitle", NODE_POLICY_STRICT_TITLE);
  push("strictDescription", NODE_POLICY_STRICT_DESCRIPTION);
  push("policyGenerationDescription", NODE_POLICY_GENERATION_DESCRIPTION);
  push("prekeyDescription", NODE_PREKEY_DESCRIPTION);
  push("continuityDescription", NODE_CONTINUITY_DESCRIPTION);
  push("noClients", NODE_NO_CLIENTS_DESCRIPTION);
  push("noSessions", NODE_NO_SESSIONS_DESCRIPTION);
  return strings;
}
