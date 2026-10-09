import type {
  HostedBrowserStatus,
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
  HostedSelectionStatus,
} from "./types.ts";

/**
 * The bounded inputs of the hosted connection status derivation. A subset of
 * the hosted hub store state so the selector stays pure and callable from the
 * phone pill, the connection sheet, and the desktop menu alike.
 */
export interface HostedConnectionStatusInput {
  readonly browserStatus: HostedBrowserStatus;
  readonly sessionStatus: HostedRycoSessionStatus;
  readonly selectionStatus: HostedSelectionStatus;
  readonly transportStatus: HostedRelayTransportStatus;
  /**
   * What `docs/relay-e2ee-protocol.md` §4.4 locked on the channel behind this
   * session, folded in here rather than derived beside it.
   *
   * OPTIONAL, AND `unavailable` IS THE HONEST DEFAULT. Both shipping tiers now
   * run a §4 channel and supply this field, so the default is no longer a
   * statement about either of them: it is what a caller with no channel to
   * describe — a build with no hosted plane, a surface rendered before any
   * socket exists — reports, and it gets byte-identical results to the
   * derivation before this input existed. It is deliberately not defaulted to
   * `legacy`: an absent channel is not "an E2EE client that fell back", and
   * §12.2's legacy label is a claim about a channel that could have been
   * encrypted.
   */
  readonly e2eeStatus?: HostedE2eeChannelStatus;
  /** Native account enrollment gate. Omitted by Web and direct clients. */
  readonly nativeDeviceSecurityStatus?: HostedNativeDeviceSecurityStatus;
}

export type HostedNativeDeviceSecurityStatus = "ready" | "securing" | "unavailable" | "revoked";

export const HOSTED_NATIVE_DEVICE_SECURITY_STATUSES = Object.keys({
  ready: true,
  securing: true,
  unavailable: true,
  revoked: true,
} satisfies Record<
  HostedNativeDeviceSecurityStatus,
  true
>) as ReadonlyArray<HostedNativeDeviceSecurityStatus>;

/**
 * §4.4's channel modes plus what §13.1's release gate makes of them, as the
 * bounded vocabulary this derivation consumes.
 *
 * `verified` is the ONLY member that may produce a status carrying an E2EE
 * guarantee, and it means both halves of §2.2's bottom row: the channel locked
 * `e2ee`, and the selection resolved to a pin the owner verified (§13.1). An
 * `e2ee` channel with no verified pin is `unverified` — §13.1 restricts it to the
 * pairing ceremony and §2.2 grants it no active-Hub protection — so it can never
 * be spelled the same way as the row that has one.
 */
export type HostedE2eeChannelStatus =
  /** No §4 channel in this tier, or none open yet. Makes no claim either way. */
  | "unavailable"
  /** §4.4 `negotiating`: nothing is released and no mode is locked yet. */
  | "negotiating"
  /** §4.4 `e2ee` on a selection that resolved to a verified pin (§13.1, §2.2). */
  | "verified"
  /** §18 account-grant IK: encrypted and authorized by the signed-in Hub account. */
  | "account-trusted"
  /** §4.4 `e2ee` with no verified pin: the §13.2 ceremony, and nothing more. */
  | "unverified"
  /**
   * §4.4 `e2ee` locked on the WEB tier — §2.2's *Web, unsigned ephemeral* row,
   * the NX pattern, and a USABLE session: web releases application payload
   * normally, because §13.1's release gate is native-only by construction (web
   * holds no durable pin of any kind, §6.3, §13.1).
   *
   * IT IS A SEPARATE MEMBER BECAUSE NEITHER EXISTING ONE IS HONEST FOR IT.
   * `verified` means both halves of §2.2's bottom row and carries the E2EE
   * guarantee, which §2.2 and §2.3 forbid the web tier from claiming: the Hub
   * serves the JavaScript, so it can exfiltrate plaintext while completing a
   * genuine handshake and drawing a genuine §13.5 `WebSAS`. `unverified` means
   * §13.1's release-gated pairing channel and reports the session unusable,
   * which would be a lie about connectedness. The name is §2.2's own row name,
   * so nothing about it reads as the signed native tier.
   */
  | "web-unsigned"
  /** §4.4 `legacy` (§12.2 honest labeling): plaintext, and labeled as such. */
  | "legacy";

export const HOSTED_E2EE_CHANNEL_STATUSES = Object.keys({
  unavailable: true,
  negotiating: true,
  verified: true,
  "account-trusted": true,
  unverified: true,
  "web-unsigned": true,
  legacy: true,
} satisfies Record<HostedE2eeChannelStatus, true>) as ReadonlyArray<HostedE2eeChannelStatus>;

/**
 * Runtime enumerations of the derivation's four inputs.
 *
 * The unions are types, so without these a caller — a test in particular —
 * could only ever cover a hand-picked subset, and a state added to a union
 * would silently ship with no coverage. `satisfies Record<Union, true>` makes
 * each list exhaustive at compile time in both directions: a missing member
 * and a stale member are both type errors, so extending a union forces the
 * list, and the list drives the vocabulary sweep.
 */
export const HOSTED_BROWSER_STATUSES = Object.keys({
  current: true,
  suspended: true,
  offline: true,
  "checking-access": true,
  synchronizing: true,
  stale: true,
} satisfies Record<HostedBrowserStatus, true>) as ReadonlyArray<HostedBrowserStatus>;

export const HOSTED_RYCO_SESSION_STATUSES = Object.keys({
  synchronizing: true,
  ready: true,
  stale: true,
  replaying: true,
  "delivery-unknown": true,
  closed: true,
} satisfies Record<HostedRycoSessionStatus, true>) as ReadonlyArray<HostedRycoSessionStatus>;

export const HOSTED_SELECTION_STATUSES = Object.keys({
  none: true,
  online: true,
  offline: true,
  incompatible: true,
  revoked: true,
  "authorization-removed": true,
} satisfies Record<HostedSelectionStatus, true>) as ReadonlyArray<HostedSelectionStatus>;

export const HOSTED_RELAY_TRANSPORT_STATUSES = Object.keys({
  idle: true,
  "requesting-ticket": true,
  connecting: true,
  authenticating: true,
  "opening-channel": true,
  online: true,
  reconnecting: true,
  draining: true,
  "terminal-failure": true,
} satisfies Record<HostedRelayTransportStatus, true>) as ReadonlyArray<HostedRelayTransportStatus>;

/**
 * The complete bounded connection status vocabulary, as a type.
 *
 * Naming the union is what lets the collapsed presentation be an exhaustive
 * `Record` over it rather than a string transformation: a state added to any
 * input union has to be given a short label and a connectedness before the
 * repository compiles.
 */
export type HostedConnectionStatusText =
  | "Offline"
  | "Checking access"
  | "Synchronizing"
  | "Stale"
  | "Delivery unknown"
  | "Authorization removed"
  | "Revoked"
  | "Incompatible"
  | "Online"
  | "Encrypted · Verified locally"
  | "Encrypted · Account trusted"
  | "Encrypted web"
  | "Legacy connection"
  | "Not verified"
  | "Securing"
  | "Securing this device"
  | "Device encryption unavailable"
  | "Device removed"
  | "Unavailable"
  | "idle"
  | "requesting ticket"
  | "connecting"
  | "authenticating"
  | "opening channel"
  | "online"
  | "draining"
  | "terminal failure";

/**
 * The transport fall-through's display text, replacing an inline
 * `replaceAll("-", " ")` so the derivation's return type is the named union.
 * Every entry is the string that expression produced, with one exception:
 * `reconnecting` is unreachable here because the dedicated branch above the
 * fall-through already claims it, and mirroring that branch's `Unavailable`
 * keeps a lowercase twin out of the vocabulary.
 */
const HOSTED_TRANSPORT_STATUS_TEXTS: Record<
  HostedRelayTransportStatus,
  HostedConnectionStatusText
> = {
  idle: "idle",
  "requesting-ticket": "requesting ticket",
  connecting: "connecting",
  authenticating: "authenticating",
  "opening-channel": "opening channel",
  online: "online",
  reconnecting: "Unavailable",
  draining: "draining",
  "terminal-failure": "terminal failure",
};

/**
 * What a usable session is CALLED, once §4.4 has had its say.
 *
 * An exhaustive `Record` rather than a chain of comparisons, for the reason the
 * indicator map below exists: adding a channel mode has to force a decision
 * about the word the owner reads. It is consulted at exactly one place — the
 * branch that used to say `Online` unconditionally — so a channel state can
 * never outrank a browser, session, or selection problem, and a session that is
 * not ready cannot be renamed by the mode its channel locked.
 */
const HOSTED_E2EE_READY_TEXTS: Record<HostedE2eeChannelStatus, HostedConnectionStatusText> = {
  unavailable: "Online",
  negotiating: "Securing",
  verified: "Encrypted · Verified locally",
  "account-trusted": "Encrypted · Account trusted",
  unverified: "Not verified",
  // §2.2's web NX row, carrying an explicit tier qualifier rather than the
  // locally verified or account-trusted native claim: on this tier encryption
  // is performed by code the Hub served.
  "web-unsigned": "Encrypted web",
  legacy: "Legacy connection",
};

/**
 * Derive the single bounded connection status text rendered everywhere the
 * hosted connection state appears (extracted unchanged from the node menu so
 * every presentation renders identical state). The vocabulary is the approved
 * bounded set; no raw errors or identifiers ever pass through here.
 */
export function deriveHostedConnectionStatusText(
  input: HostedConnectionStatusInput,
): HostedConnectionStatusText {
  const { browserStatus, sessionStatus, selectionStatus, transportStatus } = input;
  const e2eeStatus = input.e2eeStatus ?? "unavailable";
  return browserStatus === "offline"
    ? "Offline"
    : browserStatus === "checking-access"
      ? "Checking access"
      : browserStatus === "synchronizing"
        ? "Synchronizing"
        : browserStatus === "suspended" || browserStatus === "stale"
          ? "Stale"
          : sessionStatus === "delivery-unknown"
            ? "Delivery unknown"
            : selectionStatus === "authorization-removed"
              ? "Authorization removed"
              : selectionStatus === "revoked"
                ? "Revoked"
                : selectionStatus === "incompatible"
                  ? "Incompatible"
                  : input.nativeDeviceSecurityStatus === "revoked"
                    ? "Device removed"
                    : input.nativeDeviceSecurityStatus === "securing"
                      ? "Securing this device"
                      : input.nativeDeviceSecurityStatus === "unavailable"
                        ? "Device encryption unavailable"
                        : transportStatus === "online" && sessionStatus === "ready"
                          ? HOSTED_E2EE_READY_TEXTS[e2eeStatus]
                          : transportStatus === "reconnecting"
                            ? "Unavailable"
                            : selectionStatus === "offline"
                              ? "Offline"
                              : HOSTED_TRANSPORT_STATUS_TEXTS[transportStatus];
}

/**
 * How the collapsed indicator presents one bounded status.
 *
 * `connected` is the glyph decision, kept here rather than at the call site so
 * the icon cannot contradict the word beside it. Choosing the glyph from
 * `transportStatus` alone — as the presentations did — put a green connected
 * wifi icon next to `Delivery unknown`, next to `Authorization removed`, and
 * next to a closed ryco session, because the text derivation gates on browser,
 * session, and selection state *before* it ever looks at the transport.
 */
export interface HostedConnectionStatusIndicator {
  /** The collapsed chip's visible label. */
  readonly shortLabel: string;
  /** True only where the full text means a usable connection. */
  readonly connected: boolean;
  /**
   * The strongest confidentiality claim this state is allowed to make
   * (`docs/relay-e2ee-protocol.md` §2.2, §12.2).
   *
   * It sits beside `connected` for the same reason `connected` sits here rather
   * than at the call site: a presentation that decided "does this look secure?"
   * on its own would be a second source of truth for the one property §2.2
   * forbids overstating — "implementations and user-facing documentation MUST
   * NOT present a stronger claim for a weaker configuration". `e2ee` is reachable
   * from exactly one status text, and that text is produced only by
   * `HostedE2eeChannelStatus.verified`; a tone or glyph mapper keyed on this
   * cannot dress a `legacy` or `none` state as the verified one.
   */
  readonly guarantee: HostedConnectionGuarantee;
}

/**
 * §2.2's tiers, collapsed to what a status chip may assert.
 *
 * `none` is not "insecure": it is the absence of a claim, which is what every
 * state that is not a locked channel has. `legacy` is §12.2's mandatory label
 * for a channel that fell back — it is an assertion, and a negative one.
 *
 * `web` is §2.2's *Web, unsigned ephemeral* row, and it is a WEAKER claim than
 * `e2ee` rather than a flavour of it: passive and retroactive read are protected
 * only "while the served web code is honest", and an active Hub is **not
 * protected** against, because it can originate an unsigned NX session and
 * controls the JavaScript that draws every indicator including §13.5's advisory
 * `WebSAS`. A tone or glyph mapper keyed on this member cannot dress that row as
 * the verified one; a mapper keyed on `connected` alone can, which is why the
 * member exists rather than the web row reusing `none`.
 */
export type HostedConnectionGuarantee = "none" | "legacy" | "web" | "account" | "e2ee";

/**
 * The collapsed presentation of every bounded status, as an exhaustive map.
 *
 * An earlier revision derived the short label mechanically, as the leading
 * token of the full text. That was wrong three ways and this map exists to fix
 * all three:
 *
 * - It stripped polarity exactly where polarity is the message.
 *   `Authorization removed` became the neutral noun `Authorization`,
 *   `Delivery unknown` — the one state with a mandatory acknowledgement flow —
 *   became `Delivery`, and `terminal failure` became `Terminal`, which on a
 *   product with terminals reads as a feature. Severity then survived only in
 *   glyph and colour, which is the invariant icon-only was rejected to protect.
 * - It collapsed two genuinely different states onto one rendering. `Online`
 *   (a ready ryco session) and `online` (transport up, session synchronizing,
 *   replaying, stale, or CLOSED) differ only in case, so a closed session
 *   rendered a green `Online`.
 * - Nothing about a token forces it to stay short, or to stay a word.
 *
 * Every label here is chosen, not computed, and bounded: no raw error,
 * identifier, ticket, or payload can reach it. The full text is unchanged and
 * still carries the state in the accessible name and in the expanded sheet.
 */
export const HOSTED_CONNECTION_STATUS_INDICATORS = {
  Offline: { shortLabel: "Offline", connected: false, guarantee: "none" },
  "Checking access": { shortLabel: "Checking", connected: false, guarantee: "none" },
  Synchronizing: { shortLabel: "Syncing", connected: false, guarantee: "none" },
  Stale: { shortLabel: "Stale", connected: false, guarantee: "none" },
  "Delivery unknown": { shortLabel: "Unconfirmed", connected: false, guarantee: "none" },
  "Authorization removed": { shortLabel: "No access", connected: false, guarantee: "none" },
  Revoked: { shortLabel: "Revoked", connected: false, guarantee: "none" },
  Incompatible: { shortLabel: "Incompatible", connected: false, guarantee: "none" },
  Online: { shortLabel: "Online", connected: true, guarantee: "none" },
  // The one entry that may claim §2.2's bottom row, and the only one produced
  // by `HostedE2eeChannelStatus.verified`.
  "Encrypted · Verified locally": {
    shortLabel: "Verified",
    connected: true,
    guarantee: "e2ee",
  },
  "Encrypted · Account trusted": {
    shortLabel: "Acct trusted",
    connected: true,
    guarantee: "account",
  },
  // §2.2's web NX row: a usable session, encrypted against a passive Hub while
  // the served code is honest, and NOT the row above. The collapsed label is
  // intentionally not the native verified chip. `Web E2EE` keeps the tier and
  // protection level together; the detailed trust notice explains the
  // served-code ceiling.
  "Encrypted web": { shortLabel: "Web E2EE", connected: true, guarantee: "web" },
  // §12.2: a channel that fell back is labeled legacy in EVERY user-facing
  // surface. It is a usable connection and says so; it makes no E2EE claim.
  "Legacy connection": { shortLabel: "Legacy", connected: true, guarantee: "legacy" },
  // §13.1's release gate: an `e2ee` channel with no verified pin carries the
  // pairing ceremony and no application payload, so it is not a usable session.
  "Not verified": { shortLabel: "Not verified", connected: false, guarantee: "none" },
  Securing: { shortLabel: "Securing", connected: false, guarantee: "none" },
  "Securing this device": {
    shortLabel: "Device setup",
    connected: false,
    guarantee: "none",
  },
  "Device encryption unavailable": {
    shortLabel: "No E2EE key",
    connected: false,
    guarantee: "none",
  },
  // The Hub revoked THIS device's account enrollment. Not the selected node's
  // `Revoked`: every node is closed to the device until it signs in again.
  "Device removed": { shortLabel: "Removed", connected: false, guarantee: "none" },
  Unavailable: { shortLabel: "Unavailable", connected: false, guarantee: "none" },
  idle: { shortLabel: "Idle", connected: false, guarantee: "none" },
  "requesting ticket": { shortLabel: "Preparing", connected: false, guarantee: "none" },
  connecting: { shortLabel: "Connecting", connected: false, guarantee: "none" },
  authenticating: { shortLabel: "Verifying", connected: false, guarantee: "none" },
  "opening channel": { shortLabel: "Opening", connected: false, guarantee: "none" },
  online: { shortLabel: "Not ready", connected: false, guarantee: "none" },
  draining: { shortLabel: "Closing", connected: false, guarantee: "none" },
  "terminal failure": { shortLabel: "Failed", connected: false, guarantee: "none" },
} as const satisfies Record<HostedConnectionStatusText, HostedConnectionStatusIndicator>;

/** The bounded vocabulary as values, ordered by the map above. */
export const HOSTED_CONNECTION_STATUS_TEXTS = Object.keys(
  HOSTED_CONNECTION_STATUS_INDICATORS,
) as ReadonlyArray<HostedConnectionStatusText>;

/** The collapsed indicator's presentation for one bounded state. */
export function deriveHostedConnectionStatusIndicator(
  input: HostedConnectionStatusInput,
): HostedConnectionStatusIndicator {
  return HOSTED_CONNECTION_STATUS_INDICATORS[deriveHostedConnectionStatusText(input)];
}
