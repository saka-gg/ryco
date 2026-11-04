// FILE: nodePicker.logic.ts
// Purpose: What a node picker shows for one node and whether it can be picked: its machine
//          icon and tone, OS and presence line, project and code-root summary, and the reason
//          it is disabled.
// Layer: Web UI logic, pure. The catalog entries come from `@ryco/client-runtime/state/nodes`.

import { describeOfflineSince } from "@ryco/client-runtime/connection";
import type { EnvironmentId, EnvironmentMachineKind } from "@ryco/contracts";
import type { NodePathHints } from "@ryco/contracts/project-copy";
import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { inferEnvironmentMachineKind } from "@ryco/shared/environmentIcon";

import { formatProjectPath } from "../../lib/projectPaths";

/** What a picker knows about a node beyond the catalog, keyed by environment id. */
export interface NodePickerNodeExtras {
  /** Non-chat projects on the node; omitted from the summary when unknown. */
  readonly projectCount?: number | null | undefined;
  /** The node's path hints: its code roots join the summary line. */
  readonly pathHints?: Pick<NodePathHints, "homeDirectory" | "codeRoots"> | null | undefined;
  /** Disables the node with this reason on top of the catalog's own checks ("has it · ~/dev/ryco"). */
  readonly disabledReason?: string | null | undefined;
  /** Replaces the summary line (project count and code roots) of a selectable node. */
  readonly detail?: string | null | undefined;
}

export type NodePickerExtrasMap = Readonly<Partial<Record<EnvironmentId, NodePickerNodeExtras>>>;

/** Which nodes a picker accepts. */
export interface NodePickerRequirements {
  /** Nodes the client cannot mutate (create projects, browse, import) are disabled. Default true. */
  readonly requireMutate?: boolean | undefined;
  /** Offline nodes stay visible but disabled unless this is set. Default false. */
  readonly allowOffline?: boolean | undefined;
  /**
   * Nodes known to lack the project copy RPCs are disabled with an update hint. Nodes not
   * connected yet (`unknown`) stay selectable: selecting one connects and then checks.
   */
  readonly requireProjectCopy?: boolean | undefined;
}

export interface NodePickerAvailability {
  readonly selectable: boolean;
  /** Why the node cannot be picked; null when it can. */
  readonly reason: string | null;
  /** The reason is that the node is offline, which its presence line already says. */
  readonly reasonIsPresence: boolean;
}

/**
 * Whether a node can be picked. The picker's own disabled reason wins, then
 * presence (an offline node cannot be reached), then the catalog's mutate check,
 * then project copy support.
 */
export function resolveNodePickerAvailability(
  entry: NodeCatalogEntry,
  requirements: NodePickerRequirements,
  extras: NodePickerNodeExtras | undefined,
): NodePickerAvailability {
  const disabledReason = extras?.disabledReason?.trim();
  if (disabledReason) {
    return { selectable: false, reason: disabledReason, reasonIsPresence: false };
  }
  if (entry.presence === "offline" && requirements.allowOffline !== true) {
    return { selectable: false, reason: `${entry.label} is offline`, reasonIsPresence: true };
  }
  if (requirements.requireMutate !== false && !entry.canMutate) {
    return {
      selectable: false,
      reason: entry.mutateBlockedReason ?? `You can't add projects on ${entry.label}`,
      reasonIsPresence: false,
    };
  }
  if (requirements.requireProjectCopy === true && entry.projectCopySupport === "no") {
    return {
      selectable: false,
      reason: `Update Ryco on ${entry.label} to copy projects here`,
      reasonIsPresence: false,
    };
  }
  return { selectable: true, reason: null, reasonIsPresence: false };
}

/** The machine icon a node shows: its configured kind, else one inferred from OS and name. */
export function nodeMachineKind(
  entry: Pick<NodeCatalogEntry, "iconKind" | "platformOs" | "label">,
): EnvironmentMachineKind {
  return entry.iconKind ?? inferEnvironmentMachineKind(entry.platformOs ?? undefined, entry.label);
}

const OS_LABELS: Readonly<Record<string, string>> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  win32: "Windows",
  freebsd: "FreeBSD",
};

/** "macOS", "Linux", "Windows"; null when the node has not reported its OS. */
export function nodeOsLabel(platformOs: string | null | undefined): string | null {
  const os = platformOs?.trim().toLowerCase();
  if (!os) return null;
  return OS_LABELS[os] ?? `${os.charAt(0).toUpperCase()}${os.slice(1)}`;
}

export type NodePresenceTone = "online" | "connecting" | "offline";

/** "online", "connecting…", or "offline since 09:05" (`describeOfflineSince`). */
export function describeNodePresence(
  entry: Pick<NodeCatalogEntry, "presence" | "lastSeenAt">,
  nowMs: number,
): { readonly tone: NodePresenceTone; readonly text: string } {
  switch (entry.presence) {
    case "online":
      return { tone: "online", text: "online" };
    case "connecting":
      return { tone: "connecting", text: "connecting…" };
    case "offline": {
      const since = describeOfflineSince(entry.lastSeenAt, { nowMs });
      return { tone: "offline", text: since === null ? "offline" : `offline ${since}` };
    }
  }
}

/** The OS and presence line of a node card: "macOS · online". */
export function nodeStatusLine(
  entry: Pick<NodeCatalogEntry, "presence" | "lastSeenAt" | "platformOs">,
  nowMs: number,
): { readonly os: string | null; readonly tone: NodePresenceTone; readonly presence: string } {
  const presence = describeNodePresence(entry, nowMs);
  return { os: nodeOsLabel(entry.platformOs), tone: presence.tone, presence: presence.text };
}

/** Code roots worth naming: every root but home itself, home-relative, best first. */
export function nodeCodeRootLabels(
  pathHints: Pick<NodePathHints, "homeDirectory" | "codeRoots"> | null | undefined,
  limit = 3,
): string[] {
  if (!pathHints) return [];
  const home = pathHints.homeDirectory.replace(/[\\/]+$/u, "");
  const labels: string[] = [];
  for (const root of pathHints.codeRoots) {
    if (root.path.replace(/[\\/]+$/u, "") === home) continue;
    const label = formatProjectPath(root.path, pathHints.homeDirectory);
    if (!labels.includes(label)) labels.push(label);
    if (labels.length >= limit) break;
  }
  return labels;
}

/**
 * What a node card says under its status: the caller's detail, or its projects and code
 * roots ("3 projects · ~/Code, ~/Dropbox/Code/Web", the roots cut at their start).
 */
export type NodeSummaryParts =
  | { readonly kind: "detail"; readonly text: string }
  | {
      readonly kind: "projects";
      /** "3 projects"; null when the count is unknown. */
      readonly projects: string | null;
      /** "~/Code, ~/Dropbox/Code/Web"; null when the node named none. */
      readonly roots: string | null;
    };

export function nodeSummaryParts(
  extras: NodePickerNodeExtras | undefined,
): NodeSummaryParts | null {
  if (!extras) return null;
  const detail = extras.detail?.trim();
  if (detail) return { kind: "detail", text: detail };
  const projects =
    typeof extras.projectCount === "number"
      ? `${extras.projectCount} project${extras.projectCount === 1 ? "" : "s"}`
      : null;
  const roots = nodeCodeRootLabels(extras.pathHints);
  if (projects === null && roots.length === 0) return null;
  return { kind: "projects", projects, roots: roots.length > 0 ? roots.join(", ") : null };
}

/**
 * Each node keeps one colour across pickers, chips and badges: this device gets
 * the first series colour (the theme's info blue, as `--chart-1` resolves for
 * Ryco's neutral primary), every other node one of the five categorical tones
 * after it, picked from a stable hash of its id so no list order or filter
 * changes it.
 */
export const NODE_TONES = ["info", "teal", "amber", "purple", "rose", "lime"] as const;
export type NodeTone = (typeof NODE_TONES)[number];

export function nodeTone(
  entry: Pick<NodeCatalogEntry, "environmentId" | "isThisDevice">,
): NodeTone {
  if (entry.isThisDevice) return "info";
  let hash = 0;
  for (let index = 0; index < entry.environmentId.length; index += 1) {
    hash = (hash * 31 + entry.environmentId.charCodeAt(index)) | 0;
  }
  // Other nodes take the five categorical tones after this device's.
  return NODE_TONES[1 + (Math.abs(hash) % (NODE_TONES.length - 1))]!;
}
