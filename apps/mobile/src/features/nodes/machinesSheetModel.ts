// The Machines sheet as the approved mockup draws it ("Machines sheet · per-machine rows",
// layout C, with the 4-button row the owner chose under the header): a calm list that only
// identifies and selects, and one page per machine with its actions, its connection, its
// settings, its access and its appearance. Pure, so every state's actions are tested here.
//
// Which action exists in which state is the code's rule, never this file's:
// `directNodeActions` for a machine paired directly, `deriveHubNodeSectionModel` for a Hub
// node. This model only places those actions.

import {
  isSavedEnvironmentOutOfReach,
  type SavedEnvironmentFailureKind,
} from "@ryco/client-runtime/connection/connectFailure";

import type { AppSymbolName } from "../../components/AppSymbol";
import type { MachineTone } from "../home/machinePickerModel";
import {
  directConnectActionLabel,
  directNodeActions,
  directRoleLabel,
  type DirectNodeAction,
} from "./nodesModel";

export type DirectConnectionState = "connecting" | "connected" | "disconnected" | "error";

/**
 * The state the sheet works from. A machine out of reach that the backoff is trying again reads
 * as failed, so its page offers Retry, as its "Offline" status says, rather than Connect and
 * Disconnect for an attempt that will not land.
 */
export function directMachineConnectionState(
  state: DirectConnectionState,
  failureKind: SavedEnvironmentFailureKind | null | undefined,
): DirectConnectionState {
  return state === "connecting" && isSavedEnvironmentOutOfReach(failureKind) ? "error" : state;
}

/** What the sheet knows about a machine paired directly (`ConnectionRow`). */
export interface DirectMachineFacts {
  readonly plane: "direct";
  readonly label: string;
  /** The saved address, `host[:port]`. */
  readonly host: string;
  readonly transport: "LAN" | "Tailscale" | "Direct";
  readonly role: "owner" | "client" | null;
  readonly connectionState: DirectConnectionState;
  /** The status as the connection rows word it: "Connected", "Needs re-pair", "Switched off". */
  readonly statusLabel: string;
  /**
   * Why it is not connected, in one plain sentence (`ConnectionRow.statusDetail`): "Can't reach
   * this machine. It may be off, asleep or on another network." Never the platform's error text.
   */
  readonly statusDetail: string | null;
  readonly needsRepair: boolean;
  readonly switchedOff: boolean;
  readonly selected: boolean;
  readonly freezeNotice: string | null;
}

/** What the sheet knows about a Hub node (`deriveHubNodeSectionModel`). */
export interface HubMachineFacts {
  readonly plane: "hub";
  readonly label: string;
  /** "Owner", "Operator", "Viewer". */
  readonly role: string;
  readonly tone: MachineTone;
  /** The selected node's live status label, else its directory presence: "Online", "Legacy". */
  readonly status: string;
  readonly revoked: boolean;
  /** Offline in the directory. */
  readonly offline: boolean;
  /** "since 14:02" while offline, when the directory knows. */
  readonly offlineSince: string | null;
  readonly reach: "Hub relay" | "Direct";
  /** "Not verified", "Identity changed", "Encrypted · Account trusted". */
  readonly trustDetail: string | null;
  /** "Adding direct access…" or why the last attempt failed. */
  readonly directNotice: string | null;
  readonly routeNotice: string | null;
  readonly freezeNotice: string | null;
  readonly selected: boolean;
  /** What Use does: select the node, open its verification first, or nothing yet. */
  readonly primary: "use" | "verify" | null;
  readonly canRename: boolean;
  /** Add or remove direct access, when either applies now. */
  readonly directAccess: "add" | "remove" | null;
  readonly linked: boolean;
  readonly canOpenAccess: boolean;
  readonly canOpenSecurity: boolean;
}

export type MachineFacts = DirectMachineFacts | HubMachineFacts;

export type MachineActionId =
  | "use"
  | "connect"
  | "retry"
  | "re-pair"
  | "switch-on"
  | "switch-off"
  | "verify"
  | "in-use"
  | "disconnect"
  | "add-direct"
  | "remove-direct"
  | "rename"
  | "access";

export interface MachineAction {
  readonly id: MachineActionId;
  readonly label: string;
  readonly symbol: AppSymbolName;
  /** Unavailable actions keep their place, dimmed, so the row never reflows. */
  readonly enabled: boolean;
  readonly accessibilityLabel: string;
}

export type MachineInfoRow =
  | { readonly kind: "value"; readonly label: string; readonly value: string }
  | {
      readonly kind: "toggle";
      readonly label: string;
      readonly value: boolean;
      readonly enabled: boolean;
      /** The action the switch runs from its current value. */
      readonly action: MachineActionId;
    }
  | { readonly kind: "action"; readonly label: string; readonly action: MachineActionId };

export interface MachineListRowModel {
  readonly tone: MachineTone;
  /** The detail line's first word, amber while connecting: "Connected", "Connecting…". */
  readonly status: string;
  readonly statusConnecting: boolean;
  /** The rest of the detail line after the status: " · LAN · 127.0.0.1:14144". */
  readonly detailRest: string;
  /** Why the machine just dropped or which part of the way fails, in the warning colour. */
  readonly notice: string | null;
  /** Why a machine is not connected, said calmly in the muted colour (out of reach, refused). */
  readonly hint: string | null;
  readonly dimmed: boolean;
  readonly accessibilityLabel: string;
}

export interface MachineDetailModel {
  readonly tone: MachineTone;
  readonly dimmed: boolean;
  /** Under the name: "Connected · LAN · Direct", "Offline since 14:02". */
  readonly statusLine: string;
  /** Under the status line, muted: why the machine is not connected. */
  readonly hint: string | null;
  readonly notices: ReadonlyArray<string>;
  /** The 4 buttons under the header, always 4, in this order. */
  readonly actions: readonly [MachineAction, MachineAction, MachineAction, MachineAction];
  readonly connection: ReadonlyArray<MachineInfoRow>;
  readonly connectionFooter: string | null;
  /** Hub nodes: their §13.1.1 security page sits in Access. */
  readonly security: boolean;
  readonly accessFooter: string;
  readonly renameEnabled: boolean;
  readonly iconFooter: string | null;
  /** Forget is direct only: a Hub node is revoked from its Access page. */
  readonly forget: boolean;
}

/** The confirmation Forget asks first, the same words the sheet always used. */
export function forgetMachineConfirm(label: string): {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
} {
  return {
    title: `Forget ${label}?`,
    message:
      "This removes the saved direct pairing and its local credential. You can pair the machine again later. Switch it off instead to keep the pairing.",
    confirmText: "Forget",
  };
}

export const MACHINES_SHEET_FOOTER = "Tap a machine for its connection, access, name and icon.";
export const FORGET_FOOTER =
  "Removes the saved pairing and its credential. Switch it off instead to keep the pairing.";
export const ICON_FOOTER = "Connect as the device owner to change its icon.";
export const SWITCHED_OFF_SETTINGS_FOOTER = "Switch it on to change its settings.";

/** Why the machine's settings take no change now, said for the machine's own state. */
export function machineSettingsFooter(
  facts: MachineFacts,
  readOnlyReason: string | null,
): string | null {
  if (facts.plane === "direct" && facts.switchedOff) return SWITCHED_OFF_SETTINGS_FOOTER;
  return readOnlyReason;
}

const CONNECTING = "Connecting";

function directTone(facts: DirectMachineFacts): MachineTone {
  if (facts.switchedOff) return "offline";
  // The connection rows' own words (`connectionTone.ts`), so the ring never disagrees with them.
  if (facts.statusLabel === "Connected") return "connected";
  if (facts.statusLabel === CONNECTING) return "connecting";
  return "offline";
}

/** A switched-off machine is not trying to connect, so it has nothing to explain. */
function directHint(facts: DirectMachineFacts): string | null {
  return facts.switchedOff || facts.statusLabel === "Connected" ? null : facts.statusDetail;
}

function directReach(facts: DirectMachineFacts): string {
  return facts.transport === "Direct" ? "Direct" : `${facts.transport} · Direct`;
}

function statusWord(status: string, connecting: boolean): string {
  return connecting && status === CONNECTING ? "Connecting…" : status;
}

function joinRest(parts: ReadonlyArray<string | null>): string {
  return parts
    .filter((part): part is string => part !== null && part !== "")
    .map((part) => ` · ${part}`)
    .join("");
}

function hubStatus(facts: HubMachineFacts): string {
  if (facts.revoked) return "Revoked";
  if (facts.offline) return facts.offlineSince ? `Offline ${facts.offlineSince}` : "Offline";
  return facts.status;
}

export function machineListRow(facts: MachineFacts): MachineListRowModel {
  if (facts.plane === "direct") {
    const tone = directTone(facts);
    const connecting = tone === "connecting";
    const status = statusWord(facts.statusLabel, connecting);
    const detailRest = joinRest([facts.transport, facts.host]);
    return {
      tone,
      status,
      statusConnecting: connecting,
      detailRest,
      notice: facts.freezeNotice,
      hint: directHint(facts),
      dimmed: facts.switchedOff,
      accessibilityLabel: accessibilityLabel(
        facts.label,
        [`${status}${detailRest}`, directHint(facts)].filter(Boolean).join(", "),
        facts,
      ),
    };
  }
  const connecting = facts.tone === "connecting";
  const status = statusWord(hubStatus(facts), connecting);
  const shortReach =
    facts.offline || facts.revoked ? null : facts.reach === "Direct" ? "Direct" : "Hub";
  const detailRest = joinRest([shortReach, facts.role, facts.directNotice]);
  const lead = facts.trustDetail ? `${facts.trustDetail} · ` : "";
  return {
    tone: facts.tone,
    status: `${lead}${status}`,
    statusConnecting: connecting,
    detailRest,
    notice: facts.routeNotice ?? facts.freezeNotice,
    hint: null,
    dimmed: false,
    accessibilityLabel: accessibilityLabel(facts.label, `${lead}${status}${detailRest}`, facts),
  };
}

function accessibilityLabel(label: string, detail: string, facts: MachineFacts): string {
  const notice =
    facts.plane === "direct" ? facts.freezeNotice : (facts.routeNotice ?? facts.freezeNotice);
  return [label, detail, facts.selected ? "in use on this phone" : null, notice]
    .filter((part): part is string => part !== null)
    .join(", ");
}

function action(
  id: MachineActionId,
  label: string,
  symbol: AppSymbolName,
  machine: string,
  enabled = true,
  spoken?: string,
): MachineAction {
  return {
    id,
    label,
    symbol,
    enabled,
    accessibilityLabel:
      id === "in-use" ? `${machine} is in use on this phone` : `${spoken ?? label} ${machine}`,
  };
}

const IN_USE_SYMBOL: AppSymbolName = "checkmark";

function directActions(
  facts: DirectMachineFacts,
  allowed: ReadonlyArray<DirectNodeAction>,
): MachineDetailModel["actions"] {
  const has = (id: DirectNodeAction) => allowed.includes(id);
  const name = facts.label;
  let primary: MachineAction;
  if (has("switch-on")) primary = action("switch-on", "Switch on", "power", name);
  else if (has("re-pair")) primary = action("re-pair", "Re-pair", "qrcode.viewfinder", name);
  else if (has("connect")) {
    const label = directConnectActionLabel(facts);
    primary =
      label === "Use"
        ? action("use", "Use", "checkmark.circle", name)
        : label === "Retry"
          ? action("retry", "Retry", "arrow.clockwise", name)
          : action("connect", "Connect", "link", name);
  } else primary = action("in-use", "In use", IN_USE_SYMBOL, name, false);
  // A machine that refused its pairing offers Re-pair first and keeps Retry next to it.
  const second = has("disconnect")
    ? action("disconnect", "Disconnect", "wifi.slash", name)
    : has("re-pair") && has("connect")
      ? action("retry", "Retry", "arrow.clockwise", name)
      : action("disconnect", "Disconnect", "wifi.slash", name, false);
  return [
    primary,
    second,
    action("rename", "Rename", "pencil", name, has("rename")),
    action("access", "Access", "key", name),
  ];
}

function hubActions(facts: HubMachineFacts): MachineDetailModel["actions"] {
  const name = facts.label;
  const primary = facts.selected
    ? action("in-use", "In use", IN_USE_SYMBOL, name, false)
    : facts.primary === "verify"
      ? action("verify", "Verify", "checkmark.shield", name)
      : action("use", "Use", "checkmark.circle", name, facts.primary === "use");
  const direct =
    facts.directAccess === "remove"
      ? action(
          "remove-direct",
          "Remove direct",
          "bolt.slash",
          name,
          true,
          "Remove direct access for",
        )
      : action(
          "add-direct",
          "Add direct",
          "bolt.horizontal.circle",
          name,
          facts.directAccess === "add",
          "Add direct access for",
        );
  return [
    primary,
    direct,
    action("rename", "Rename", "pencil", name, facts.canRename),
    action("access", "Access", "key", name, facts.canOpenAccess),
  ];
}

export function machineDetail(
  facts: MachineFacts,
  input: { readonly iconEditable: boolean },
): MachineDetailModel {
  const iconFooter = input.iconEditable ? null : ICON_FOOTER;
  if (facts.plane === "direct") {
    const allowed = directNodeActions(facts);
    const tone = directTone(facts);
    const connection: MachineInfoRow[] = [
      { kind: "value", label: "Status", value: facts.statusLabel },
      { kind: "value", label: "Reach", value: directReach(facts) },
      { kind: "value", label: "Address", value: facts.host },
      // A switched-off machine reports no role; "Role pending" would read as a fault.
      ...(facts.switchedOff && facts.role === null
        ? []
        : [{ kind: "value", label: "Pairing", value: directRoleLabel(facts.role) } as const]),
      {
        kind: "toggle",
        label: "Switched on",
        value: !facts.switchedOff,
        enabled: true,
        action: facts.switchedOff ? "switch-on" : "switch-off",
      },
    ];
    if (allowed.includes("disconnect")) {
      connection.push({ kind: "action", label: "Disconnect", action: "disconnect" });
    }
    return {
      tone,
      dimmed: facts.switchedOff,
      statusLine: `${statusWord(facts.statusLabel, tone === "connecting")} · ${directReach(facts)}`,
      hint: directHint(facts),
      notices: facts.freezeNotice ? [facts.freezeNotice] : [],
      actions: directActions(facts, allowed),
      connection,
      connectionFooter: null,
      security: false,
      accessFooter:
        facts.role === "client"
          ? "This phone is paired as a client, so Access is read-only."
          : "Share a pairing link or remove other clients.",
      renameEnabled: allowed.includes("rename"),
      iconFooter,
      forget: allowed.includes("forget"),
    };
  }
  const status = hubStatus(facts);
  return {
    tone: facts.tone,
    dimmed: false,
    hint: null,
    statusLine: [
      facts.trustDetail,
      statusWord(status, facts.tone === "connecting"),
      facts.offline || facts.revoked ? null : facts.reach,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
    notices: [facts.routeNotice, facts.freezeNotice, facts.directNotice].filter(
      (notice): notice is string => notice !== null,
    ),
    actions: hubActions(facts),
    connection: [
      { kind: "value", label: "Status", value: status },
      { kind: "value", label: "Reach", value: facts.reach },
      { kind: "value", label: "Role", value: facts.role },
      {
        kind: "toggle",
        label: "Direct access",
        value: facts.linked,
        enabled: facts.directAccess !== null,
        action: facts.linked ? "remove-direct" : "add-direct",
      },
    ],
    connectionFooter:
      !facts.linked && facts.directAccess === null
        ? `Direct access can be added while ${facts.label} is connected through the Hub.`
        : null,
    security: facts.canOpenSecurity,
    accessFooter: "Revoking this node from your Hub is in Access too.",
    renameEnabled: facts.canRename,
    iconFooter,
    forget: false,
  };
}
