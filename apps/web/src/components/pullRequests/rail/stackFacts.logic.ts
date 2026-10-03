import type {
  SourceControlChangeRequestStack,
  SourceControlChangeRequestStackEntry,
} from "@ryco/contracts";

import type { FactTone } from "./mergeFacts.logic";

/**
 * Stack derivations shared by the rail's stack section, the bar's stack chip
 * popover and the merge-through picker. Stacks are GitHub-native: entries run
 * from the base upwards and a merge through layer N lands every open layer at
 * or below N in one go.
 */

type StackEntry = SourceControlChangeRequestStackEntry;

function mergeStatus(entry: StackEntry): string {
  return entry.mergeStateStatus?.trim().toLowerCase() ?? "";
}

const LANDABLE_STATUSES = new Set(["clean", "has_hooks", "unstable"]);

/** The host would merge this layer right now (non-required checks may still fail). */
export function isStackLayerLandable(entry: StackEntry): boolean {
  return (
    entry.state === "open" &&
    !entry.isDraft &&
    entry.mergeability !== "conflicting" &&
    LANDABLE_STATUSES.has(mergeStatus(entry))
  );
}

/** Why a layer cannot land, or null when it can (or when only the host can tell yet). */
export function stackLayerBlocker(entry: StackEntry): string | null {
  if (entry.state === "merged") return null;
  if (entry.state === "closed") return `#${entry.number} is closed without being merged`;
  if (entry.isDraft || mergeStatus(entry) === "draft") return `#${entry.number} is a draft`;
  if (entry.mergeability === "conflicting" || mergeStatus(entry) === "dirty") {
    return `#${entry.number} has conflicts`;
  }
  if (mergeStatus(entry) === "blocked") return `#${entry.number} is blocked`;
  if (mergeStatus(entry) === "behind") return `#${entry.number} is behind its base`;
  return null;
}

export interface StackLayerWord {
  readonly text: string;
  readonly tone: FactTone;
}

/** One word for a layer row: what stands out about it from the stack's point of view. */
export function stackLayerWord(entry: StackEntry): StackLayerWord {
  if (entry.state === "merged") return { text: "Merged", tone: "merged" };
  if (entry.state === "closed") return { text: "Closed", tone: "neutral" };
  if (entry.isDraft || mergeStatus(entry) === "draft") return { text: "Draft", tone: "neutral" };
  if (entry.mergeability === "conflicting" || mergeStatus(entry) === "dirty") {
    return { text: "Conflicts", tone: "danger" };
  }
  switch (mergeStatus(entry)) {
    case "clean":
    case "has_hooks":
      return { text: "Ready", tone: "success" };
    case "unstable":
      return { text: "Failing", tone: "warning" };
    case "blocked":
      return { text: "Blocked", tone: "warning" };
    case "behind":
      return { text: "Behind", tone: "warning" };
    default:
      return { text: "Pending", tone: "progress" };
  }
}

export function stackLayersTopDown(
  stack: SourceControlChangeRequestStack,
): ReadonlyArray<StackEntry> {
  return stack.entries.toSorted((left, right) => right.position - left.position);
}

export interface StackAssessment {
  /** Top of the landable stretch above the merged base layers ("#701 can land"). */
  readonly canLand: StackEntry | null;
  /** First open layer from the base that cannot land. */
  readonly blockedAt: StackEntry | null;
  readonly mergedCount: number;
  /** The stack's one-line foot, or null when there is nothing to say. */
  readonly foot: StackLayerWord | null;
}

export function assessStack(stack: SourceControlChangeRequestStack): StackAssessment {
  const bottomUp = stack.entries.toSorted((left, right) => left.position - right.position);
  const mergedCount = bottomUp.filter((entry) => entry.state === "merged").length;
  let canLand: StackEntry | null = null;
  let blockedAt: StackEntry | null = null;
  for (const entry of bottomUp) {
    if (entry.state === "merged") continue;
    if (isStackLayerLandable(entry)) {
      canLand = entry;
      continue;
    }
    blockedAt = entry;
    break;
  }
  const foot: StackLayerWord | null = canLand
    ? { text: `#${canLand.number} can land`, tone: "success" }
    : blockedAt
      ? { text: `blocked at #${blockedAt.number}`, tone: "warning" }
      : mergedCount > 0
        ? { text: `${mergedCount} merged`, tone: "merged" }
        : null;
  return { canLand, blockedAt, mergedCount, foot };
}

/** How the spine segment from a layer down to the layer (or base) beneath it reads. */
export type StackLinkTone = "merged" | "landable" | "plain";

/**
 * Merged layers keep a violet spine; the open stretch above them that could
 * land right now reads as success; everything else is a plain hairline.
 */
export function stackLinkTone(
  stack: SourceControlChangeRequestStack,
  entry: StackEntry,
): StackLinkTone {
  if (entry.state === "merged") return "merged";
  const { canLand } = assessStack(stack);
  return canLand && entry.state === "open" && entry.position <= canLand.position
    ? "landable"
    : "plain";
}

/** "3 of 4": where the selected pull request sits, counted from the base. */
export function stackPositionLabel(
  stack: Pick<SourceControlChangeRequestStack, "position" | "size">,
) {
  return `${stack.position} of ${stack.size}`;
}

export interface StackMergePlan {
  /** Open layers the merge would land, from the base upwards. */
  readonly layers: ReadonlyArray<StackEntry>;
  /** Why merging through this layer is not possible, or null. */
  readonly blocker: string | null;
  /** The layer that stops it (this one or one beneath), when a layer does. */
  readonly blockedBy: number | null;
}

/** What merging through `throughNumber` lands, and what (if anything) stops it. */
export function stackMergeThroughPlan(
  stack: SourceControlChangeRequestStack,
  throughNumber: number,
): StackMergePlan {
  const through = stack.entries.find((entry) => entry.number === throughNumber);
  if (!through) {
    return { layers: [], blocker: `#${throughNumber} is not in this stack`, blockedBy: null };
  }
  if (through.state === "merged") return { layers: [], blocker: "Already merged", blockedBy: null };
  const layers = stack.entries
    .filter((entry) => entry.position <= through.position && entry.state !== "merged")
    .toSorted((left, right) => left.position - right.position);
  for (const entry of layers) {
    const blocker = stackLayerBlocker(entry);
    if (blocker !== null) return { layers, blocker, blockedBy: entry.number };
  }
  return { layers, blocker: null, blockedBy: null };
}

/** The layer the picker opens on: the requested one, else the highest that can land. */
export function defaultMergeThroughLayer(
  stack: SourceControlChangeRequestStack,
  requested: number | null,
): number | null {
  if (requested !== null && stackMergeThroughPlan(stack, requested).blocker === null) {
    return requested;
  }
  const highest = stackLayersTopDown(stack).find(
    (entry) => stackMergeThroughPlan(stack, entry.number).blocker === null,
  );
  return highest?.number ?? requested;
}

/**
 * Layers that just landed (open before, merged now), bottom-up, so the rail
 * can pop their glyphs in the order the host merged them.
 */
export function newlyMergedLayers(
  previous: ReadonlyMap<number, StackEntry["state"]>,
  stack: SourceControlChangeRequestStack,
): ReadonlyArray<number> {
  return stack.entries
    .filter((entry) => entry.state === "merged" && previous.get(entry.number) === "open")
    .toSorted((left, right) => left.position - right.position)
    .map((entry) => entry.number);
}
