// How the hosted connection surfaces DRAW one bounded status — the glyph and
// the colour beside the word.
//
// ─────────────────────────────────────────────────────────────────────────────
// THERE IS EXACTLY ONE OF THESE, AND IT READS `guarantee`
// ─────────────────────────────────────────────────────────────────────────────
// All three surfaces — the desktop menu, the phone sheet, the phone pill — chose
// their glyph from `connected` (and the menu, from `transportStatus` alone). Both
// `legacy` and `web-unsigned` are usable sessions, so both were `connected:
// true`, so a plaintext downgrade and a locked NX channel drew the identical
// green connected glyph. `docs/relay-e2ee-protocol.md` §2.2 forbids exactly
// that: "implementations and user-facing documentation MUST NOT present a
// stronger claim for a weaker configuration", and §12.2 requires the fallback to
// be labeled legacy "in every user-facing surface" — a label the fallback was
// wearing the verified session's colour under.
//
// `HostedConnectionStatusIndicator.guarantee` exists to be the single source of
// truth for that decision (see its doc comment in the runtime), so this mapper
// switches on it with `satisfies never` in the default arm. A member added to
// `HostedConnectionGuarantee` is then a compile error here rather than a silent
// fall-through into whichever branch happened to be last — which is precisely
// how an `if (guarantee === "legacy")` chain absorbed the web row into the
// connected branch in the first place.
//
// React-free on purpose: glyphs are named, not imported, so every decision below
// is assertable from a node test and the `.tsx` owns only the name-to-component
// mapping.

import type { EnvironmentId } from "@ryco/contracts";

import {
  deriveHostedConnectionStatusIndicator,
  describeHostedConnectionPhase,
  HOSTED_CONNECTION_STATUS_INDICATORS,
  hostedBrowserRevalidated,
  selectedProjectionFields,
  type HostedConnectionGuarantee,
  type HostedConnectionStatusIndicator,
  type HostedConnectionStatusText,
  type HostedEnvironmentSessionRecord,
  type HostedHubState,
  type WebHostedE2eeChannelStatus,
} from "../../hostedHub/connectionStatus";
import type { HostedHubNode } from "../../hostedHub/types";

/**
 * The glyphs the hosted surfaces draw, as names.
 *
 * `connected` / `disconnected` are the reachability pair the surfaces already
 * had. The other three are §2.2 claims and are deliberately a different family
 * of glyph — a shield rather than a signal bar — because a claim about who can
 * read the payload is not a claim about whether the socket is up, and drawing
 * both on the same glyph is what let one be mistaken for the other.
 */
export type HostedConnectionGlyph =
  | "connected"
  | "disconnected"
  | "legacy"
  | "browser-encrypted"
  | "account-trusted"
  | "native-verified";

export interface HostedConnectionStatusPresentation {
  readonly glyph: HostedConnectionGlyph;
  /** The glyph's colour utility. Never the only carrier of the state. */
  readonly iconClassName: string;
}

// THERE IS NO ORDINAL FIELD HERE, and there deliberately is not one. A
// `claimRank: 1 | 2 | 3 | null` shipped in this shape with no reader outside its
// own unit test: nothing rendered it, so the `legacy < web < e2ee` assertion
// written over it restated three integer literals declared eleven lines away and
// credited itself with defending §2.2's ladder. The UI has no ladder — it has
// three claims that must stay TELLABLE APART — so what the suite asserts is what
// the surface draws: a distinct glyph and a distinct colour per claim, none of
// them the plain-connected pair, and the web row never the native one
// (`HostedConnectionControls.logic.test.ts`, and the rendered comparison of
// colour and path in `HostedConnectionControls.browser.tsx`).

/**
 * The presentation of each §2.2 claim that asserts something, as an exhaustive
 * map over the guarantee union minus its one non-claim.
 *
 * A `Record` rather than a conditional chain, for the reason every other
 * exhaustive map in this area exists: adding a member to
 * `HostedConnectionGuarantee` has to force a decision about how it is drawn,
 * and `Exclude<…, "none">` makes the new key required here the moment it is
 * added. `e2ee` is present even though this tier can never reach it
 * (`connectionStatus.ts` fences `verified` out before the derivation sees it):
 * the ladder is only checkable if its top rung exists, and the property worth
 * pinning is that the `web` row's presentation is not the `e2ee` row's.
 */
const HOSTED_CLAIM_PRESENTATIONS = {
  // §12.2's mandatory label, drawn as the negative assertion it is. A struck
  // shield rather than a signal bar, and never the success colour.
  legacy: { glyph: "legacy", iconClassName: "text-amber-500" },
  // §2.2's *Web, unsigned ephemeral* row and §2.4's ceiling: a usable,
  // encrypted channel whose code the Hub serves. It gets the informational
  // colour — the one connected tone that is neither the fallback's amber nor
  // the row the success colour means — so the scale reads legacy, then browser,
  // then verified, rather than grouping the browser row with the one §2.2
  // forbids it from claiming.
  web: { glyph: "browser-encrypted", iconClassName: "text-sky-500" },
  // Signed native E2EE authorized by the account Hub. Kept visually distinct
  // from both the Web ceiling and an independently verified local pin.
  account: { glyph: "account-trusted", iconClassName: "text-indigo-500" },
  // Native only, and unreachable from this tier by construction.
  e2ee: { glyph: "native-verified", iconClassName: "text-emerald-500" },
} as const satisfies Record<
  Exclude<HostedConnectionGuarantee, "none">,
  HostedConnectionStatusPresentation
>;

/**
 * How one bounded status is drawn.
 *
 * Reachability decides only where §2.2 has nothing to say. Where it does, the
 * claim decides — so no surface can render a state that claims `legacy` with the
 * glyph or the colour a state claiming `web` gets, and neither can be drawn as
 * the native verified row.
 */
export function hostedConnectionStatusPresentation(
  indicator: HostedConnectionStatusIndicator,
): HostedConnectionStatusPresentation {
  if (indicator.guarantee !== "none") return HOSTED_CLAIM_PRESENTATIONS[indicator.guarantee];
  return indicator.connected
    ? { glyph: "connected", iconClassName: "text-emerald-500" }
    : { glyph: "disconnected", iconClassName: "text-amber-500" };
}

/**
 * What an intentional connect is called on every surface: one quiet word,
 * never the transport's own steps (`requesting ticket`, `authenticating`, …).
 */
export const HOSTED_CONNECTING_STATUS_TEXT = "Connecting…";

/** The hosted state the connection chip is derived from. */
export type HostedConnectionChipSource = Pick<
  HostedHubState,
  | "accountStatus"
  | "directoryStatus"
  | "browserStatus"
  | "selectionStatus"
  | "transportStatus"
  | "sessionStatus"
  | "errorMessage"
  | "effectiveRole"
  | "selectedNode"
  | "nodes"
>;

export interface HostedConnectionChipInput extends HostedConnectionChipSource {
  /** The node id in the address, `null` outside a node route. */
  readonly routedNodeId: string | null;
  readonly e2eeStatus: WebHostedE2eeChannelStatus;
}

/** The hosted state a chip for one named environment is derived from. */
export interface HostedEnvironmentConnectionChipInput extends HostedConnectionChipSource {
  /** The environment the chip describes, whether or not it is the selected one. */
  readonly environmentId: EnvironmentId;
  /** Its own session record. Only read while it is not the selected environment. */
  readonly record: HostedEnvironmentSessionRecord | undefined;
  /** An earlier action on it is still unconfirmed. Only read while it has no record. */
  readonly deliveryUnknown: boolean;
  /** Its own channel's state, never the selected environment's. */
  readonly e2eeStatus: WebHostedE2eeChannelStatus;
}

export interface HostedConnectionChip {
  /** The node the chip names: the selected one, the one the route is opening, or the one asked for. */
  readonly node: HostedHubNode;
  readonly role: HostedHubState["effectiveRole"];
  readonly statusText: HostedConnectionStatusText | typeof HOSTED_CONNECTING_STATUS_TEXT;
  readonly indicator: HostedConnectionStatusIndicator;
  /** The chip names the node the route is opening, not the selected one. */
  readonly switching: boolean;
}

/**
 * The node an in-app switch is heading to: the routed node when it is not the
 * selected one yet, the directory lists it as one this browser can open, and
 * nothing is wrong. Anything else (a stale browser, an error waiting to be
 * shown) keeps describing the selection, so the chip never calls a problem a
 * switch.
 */
function hostedSwitchTargetNode(input: HostedConnectionChipInput): HostedHubNode | null {
  if (input.routedNodeId === null || input.routedNodeId === input.selectedNode?.id) return null;
  if (
    input.accountStatus !== "authenticated" ||
    input.directoryStatus !== "ready" ||
    input.errorMessage !== null ||
    !hostedBrowserRevalidated(input.browserStatus)
  ) {
    return null;
  }
  const node = input.nodes.find((candidate) => candidate.id === input.routedNodeId);
  if (!node || node.revokedAt !== null || node.capabilities?.nativeClientRequired === true) {
    return null;
  }
  return node;
}

/**
 * One environment's session, as a connection surface describes it: the shared
 * session fields for the selected environment, the environment's own record
 * for any other.
 */
interface HostedEnvironmentConnection {
  readonly node: HostedHubNode;
  readonly role: HostedHubState["effectiveRole"];
  readonly browserStatus: HostedHubState["browserStatus"];
  readonly selectionStatus: HostedHubState["selectionStatus"];
  readonly transportStatus: HostedHubState["transportStatus"];
  readonly sessionStatus: HostedHubState["sessionStatus"];
  /** No error is waiting to be shown, so a session that is not up yet is on its way. */
  readonly quiet: boolean;
  readonly e2eeStatus: WebHostedE2eeChannelStatus;
}

/** The selected environment, as the shared session fields describe it. */
function selectedEnvironmentConnection(
  input: HostedConnectionChipSource & { readonly e2eeStatus: WebHostedE2eeChannelStatus },
  node: HostedHubNode,
): HostedEnvironmentConnection {
  return {
    node,
    role: input.effectiveRole,
    browserStatus: input.browserStatus,
    selectionStatus: input.selectionStatus,
    transportStatus: input.transportStatus,
    sessionStatus: input.sessionStatus,
    quiet: input.errorMessage === null,
    e2eeStatus: input.e2eeStatus,
  };
}

/**
 * Another environment, as its own record describes it — the projection the
 * shared fields get when it is selected. The account and the directory were
 * revalidated once for every environment, so a browser still synchronizing the
 * selection counts as current here, the rule the capability policy applies to
 * the same environment. The directory's revocation wins over a record that has
 * not heard of it yet.
 */
function recordEnvironmentConnection(
  input: HostedEnvironmentConnectionChipInput,
  node: HostedHubNode,
): HostedEnvironmentConnection {
  const fields = selectedProjectionFields(input.record, node, {
    directoryReady: input.directoryStatus === "ready",
    deliveryUnknown: input.deliveryUnknown,
  });
  return {
    node,
    role: fields.effectiveRole,
    browserStatus: hostedBrowserRevalidated(input.browserStatus) ? "current" : input.browserStatus,
    selectionStatus: node.revokedAt !== null ? "revoked" : fields.selectionStatus,
    transportStatus: fields.transportStatus,
    sessionStatus: fields.sessionStatus,
    quiet: fields.error === null,
    e2eeStatus: input.e2eeStatus,
  };
}

/**
 * The one place a session becomes the bounded words and the indicator beside
 * them, for every surface and every environment.
 *
 * An intentional connect reads `Connecting…` and nothing else, so the
 * transport's steps never reach the screen. Failures, an offline node, a stale
 * browser and every channel label come out of the shared derivation unchanged.
 */
function describeHostedEnvironmentConnection(
  input: Pick<HostedHubState, "accountStatus" | "directoryStatus">,
  connection: HostedEnvironmentConnection,
): HostedConnectionChip {
  const statusInput = {
    browserStatus: connection.browserStatus,
    sessionStatus: connection.sessionStatus,
    selectionStatus: connection.selectionStatus,
    transportStatus: connection.transportStatus,
    e2eeStatus: connection.e2eeStatus,
  };
  const phase = describeHostedConnectionPhase({
    ...statusInput,
    accountAuthenticated: input.accountStatus === "authenticated",
    directoryReady: input.directoryStatus === "ready",
    quiet: connection.quiet,
  });
  if (phase === "Connecting") {
    return {
      node: connection.node,
      role: connection.role,
      statusText: HOSTED_CONNECTING_STATUS_TEXT,
      indicator: HOSTED_CONNECTION_STATUS_INDICATORS.connecting,
      switching: false,
    };
  }
  return {
    node: connection.node,
    role: connection.role,
    statusText: phase,
    indicator: deriveHostedConnectionStatusIndicator(statusInput),
    switching: false,
  };
}

/**
 * The chip the phone connection surfaces render: the selected node, with its
 * bounded status words and the indicator beside them.
 *
 * During a switch to the node the route is opening the chip names the TARGET
 * node, not the one still selected, and reads `Connecting…` (or `Offline`).
 * `null` while there is no node to name.
 */
export function deriveHostedConnectionChip(
  input: HostedConnectionChipInput,
): HostedConnectionChip | null {
  const target = hostedSwitchTargetNode(input);
  if (target) {
    return target.presence.online
      ? {
          node: target,
          role: target.effectiveRole,
          statusText: HOSTED_CONNECTING_STATUS_TEXT,
          indicator: HOSTED_CONNECTION_STATUS_INDICATORS.connecting,
          switching: true,
        }
      : {
          node: target,
          role: target.effectiveRole,
          statusText: "Offline",
          indicator: HOSTED_CONNECTION_STATUS_INDICATORS.Offline,
          switching: true,
        };
  }
  const node = input.selectedNode;
  if (!node) return null;
  return describeHostedEnvironmentConnection(input, selectedEnvironmentConnection(input, node));
}

/**
 * The chip for one named environment — the open thread's — whether or not the
 * selection cursor is on it.
 *
 * The selected environment reads the shared session fields, exactly as
 * {@link deriveHostedConnectionChip} does; any other reads its own session
 * record and its own channel, so a warm environment the cursor has left still
 * reports its own legacy or browser channel rather than the selection's.
 * `null` when the directory does not list the environment's node.
 */
export function deriveHostedEnvironmentConnectionChip(
  input: HostedEnvironmentConnectionChipInput,
): HostedConnectionChip | null {
  const selected = input.selectedNode;
  if (selected?.environmentId === input.environmentId) {
    return describeHostedEnvironmentConnection(
      input,
      selectedEnvironmentConnection(input, selected),
    );
  }
  const node = input.nodes.find((candidate) => candidate.environmentId === input.environmentId);
  if (!node) return null;
  return describeHostedEnvironmentConnection(input, recordEnvironmentConnection(input, node));
}

/**
 * Whether a chip may be drawn quietly — muted, without the outline that asks
 * for attention. Only the steady browser channel qualifies (§2.2's `web` row):
 * quiet is itself a claim, so it never stands for a `legacy` fallback (§12.2),
 * for a connected session with no channel, or for anything still on its way.
 */
export function hostedConnectionChipQuiet(indicator: HostedConnectionStatusIndicator): boolean {
  return indicator.guarantee === "web" && indicator.connected;
}

/** The live-region sentence for a chip, without doubling the ellipsis' full stop. */
export function hostedConnectionAnnouncement(label: string, statusText: string): string {
  return `Node ${label}: ${statusText}${statusText.endsWith("…") ? "" : "."}`;
}
