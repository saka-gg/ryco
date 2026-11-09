import type {
  EnvironmentId,
  EnvironmentMachineKind,
  ExecutionEnvironmentDescriptor,
  ServerConfig,
} from "@ryco/contracts";
import {
  inferEnvironmentMachineKind,
  resolveEnvironmentMachineKind,
} from "@ryco/shared/environmentIcon";

import type { InboxEnvironment } from "../inbox/inboxModel";

// The machine picker at the top left of a tab: which machine the list is
// narrowed to, drawn as the machine's kind with a ring for how it is
// connected, and a popover to switch machines or manage them.

/** How a machine is connected, as the avatar's ring and dot show it. */
export type MachineTone = "connected" | "connecting" | "offline";

/** How the phone reaches a machine: its own paired socket, or through the Hub. */
export type MachineReach = "direct" | "hub";

/** The SF Symbol each machine kind is drawn with. */
export const MACHINE_KIND_SYMBOL = {
  laptop: "laptopcomputer",
  desktop: "desktopcomputer",
  "mini-pc": "macmini",
  workstation: "macpro.gen3",
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  windows: "pc",
} as const satisfies Record<EnvironmentMachineKind, string>;

export type MachineSymbol = (typeof MACHINE_KIND_SYMBOL)[EnvironmentMachineKind];

/** "All machines" in the popover. */
export const ALL_MACHINES_SYMBOL = "square.grid.2x2";

/** At most this many online machines stack on the "All machines" button. */
export const MACHINE_STACK_LIMIT = 3;

/** What the picker knows about a machine beyond its inbox row. */
export interface MachinePickerFacts {
  readonly kind: EnvironmentMachineKind;
  readonly reach: MachineReach;
  /** Epoch milliseconds it was last seen online; null when unknown. */
  readonly lastSeenAt: number | null;
}

export type MachinePickerEnvironment = Pick<
  InboxEnvironment,
  "environmentId" | "label" | "connectionState" | "stale"
>;

export interface MachinePickerRow {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly symbol: MachineSymbol;
  readonly tone: MachineTone;
  /** Under the name on the button: "Connected", "Connecting…", "Offline". */
  readonly status: string;
  /** In the popover: how it is reached, or when it was last seen. */
  readonly detail: string;
  readonly selected: boolean;
  readonly accessibilityLabel: string;
}

export type MachinePickerButtonFace =
  | { readonly kind: "machine"; readonly machine: MachinePickerRow }
  | {
      readonly kind: "all";
      /** The online machines the button stacks, at most `MACHINE_STACK_LIMIT`. */
      readonly stack: ReadonlyArray<MachinePickerRow>;
      readonly onlineCount: number;
      readonly tone: MachineTone;
    };

export interface MachinePickerModel {
  readonly face: MachinePickerButtonFace;
  /** Changes whenever the button shows another machine: keys its morph. */
  readonly faceKey: string;
  readonly allSelected: boolean;
  /** "2 of 4 online", under "All machines" in the popover. */
  readonly allDetail: string;
  readonly rows: ReadonlyArray<MachinePickerRow>;
  readonly accessibilityLabel: string;
}

/**
 * The tone a machine's ring shows. A machine whose rows are only cached
 * (`stale`) shows offline until a live snapshot arrives, however hopeful its
 * socket looks: a dead node's transport can sit in "reconnecting" for good.
 */
export function machineTone(
  environment: Pick<InboxEnvironment, "connectionState" | "stale">,
): MachineTone {
  if (environment.stale === true) return "offline";
  switch (environment.connectionState) {
    case "connected":
    case "read-only":
      return "connected";
    case "reconnecting":
      return "connecting";
    case "offline":
      return "offline";
  }
}

/** The tone of several machines together: all connected, some, or none. */
export function combinedMachineTone(tones: ReadonlyArray<MachineTone>): MachineTone {
  if (tones.length > 0 && tones.every((tone) => tone === "connected")) return "connected";
  return tones.some((tone) => tone !== "offline") ? "connecting" : "offline";
}

function statusWord(environment: MachinePickerEnvironment, tone: MachineTone): string {
  if (tone === "connected") {
    return environment.connectionState === "read-only" ? "View only" : "Connected";
  }
  return tone === "connecting" ? "Connecting…" : "Offline";
}

/** "just now", "5m ago", "2h ago", "3d ago". */
export function relativeSeen(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function detailLine(
  environment: MachinePickerEnvironment,
  tone: MachineTone,
  facts: MachinePickerFacts,
  now: number,
): string {
  const via = facts.reach === "direct" ? "Direct" : "Hub";
  if (tone === "offline") {
    return facts.lastSeenAt === null
      ? "Offline"
      : `Offline · seen ${relativeSeen(facts.lastSeenAt, now)}`;
  }
  if (tone === "connecting") return `${via} · connecting`;
  return environment.connectionState === "read-only" ? `${via} · view only` : via;
}

/** What the picker shows for a machine it has no other facts about. */
export function fallbackMachineFacts(label: string): MachinePickerFacts {
  return { kind: inferEnvironmentMachineKind(undefined, label), reach: "hub", lastSeenAt: null };
}

export function buildMachinePickerModel(input: {
  readonly environments: ReadonlyArray<MachinePickerEnvironment>;
  readonly selected: EnvironmentId | null;
  readonly factsOf: (environmentId: EnvironmentId, label: string) => MachinePickerFacts;
  readonly now: number;
}): MachinePickerModel {
  const rows = input.environments.map((environment): MachinePickerRow => {
    const facts = input.factsOf(environment.environmentId, environment.label);
    const tone = machineTone(environment);
    const status = statusWord(environment, tone);
    const detail = detailLine(environment, tone, facts, input.now);
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      symbol: MACHINE_KIND_SYMBOL[facts.kind],
      tone,
      status,
      detail,
      selected: environment.environmentId === input.selected,
      accessibilityLabel: `${environment.label}, ${detail}`,
    };
  });
  const selected = rows.find((row) => row.selected);
  const online = rows.filter((row) => row.tone !== "offline");
  const allDetail = `${online.length} of ${rows.length} online`;
  if (selected) {
    return {
      face: { kind: "machine", machine: selected },
      faceKey: `machine:${selected.environmentId}`,
      allSelected: false,
      allDetail,
      rows,
      accessibilityLabel: `Machine: ${selected.label}, ${selected.status}. Show work from`,
    };
  }
  return {
    face: {
      kind: "all",
      stack: online.slice(0, MACHINE_STACK_LIMIT),
      onlineCount: online.length,
      tone: combinedMachineTone(rows.map((row) => row.tone)),
    },
    faceKey: "all",
    allSelected: true,
    allDetail,
    rows,
    accessibilityLabel: `Machine: All machines, ${online.length} online. Show work from`,
  };
}

function epochOrNull(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The sources `machinePickerFactsOf` reads, each keyed by environment. */
export interface MachinePickerFactSources {
  /** Directly paired machines (reached over their own socket). */
  readonly direct: ReadonlyMap<
    EnvironmentId,
    {
      readonly descriptor: Pick<ExecutionEnvironmentDescriptor, "label" | "platform"> | null;
      readonly serverConfig: Pick<ServerConfig, "settings" | "environment"> | null;
      readonly connectedAt: string | null;
      readonly disconnectedAt: string | null;
    }
  >;
  /** What each connected node last reported, its `environmentIcon` setting included. */
  readonly configs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "settings" | "environment">>;
  /** The node catalog: Hub machines' directory platform and last-seen time. */
  readonly catalog: ReadonlyMap<
    EnvironmentId,
    {
      readonly iconKind: EnvironmentMachineKind | null;
      readonly lastSeenAt: number | null;
    }
  >;
  /** The cached Hub roster's last heartbeat (or authentication) per node. */
  readonly hubLastSeen: ReadonlyMap<EnvironmentId, number>;
}

/**
 * A machine's kind, reach and last-seen time. The kind is the machine's own
 * choice first: the desktop's icon setting, then its platform hint, then a
 * guess from its OS and name (`resolveEnvironmentMachineKind`).
 */
export function machinePickerFactsOf(
  sources: MachinePickerFactSources,
  environmentId: EnvironmentId,
  label: string,
): MachinePickerFacts {
  const direct = sources.direct.get(environmentId);
  const config = sources.configs.get(environmentId) ?? direct?.serverConfig ?? null;
  const catalog = sources.catalog.get(environmentId);
  const descriptor = config?.environment ?? direct?.descriptor ?? null;
  const kind =
    config !== null || descriptor !== null
      ? resolveEnvironmentMachineKind(config, descriptor)
      : (catalog?.iconKind ?? inferEnvironmentMachineKind(undefined, label));
  if (direct) {
    return {
      kind,
      reach: "direct",
      lastSeenAt: epochOrNull(direct.disconnectedAt) ?? epochOrNull(direct.connectedAt),
    };
  }
  return {
    kind,
    reach: "hub",
    lastSeenAt: sources.hubLastSeen.get(environmentId) ?? catalog?.lastSeenAt ?? null,
  };
}
