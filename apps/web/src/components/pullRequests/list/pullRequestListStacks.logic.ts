import type {
  ChangeRequest,
  ChangeRequestState,
  SourceControlChangeRequestStack,
} from "@ryco/contracts";
import type { ChangeRequestListGroup } from "@ryco/client-runtime/state/pull-request-review";

/**
 * Stacks in the pull request list. A GitHub-native stack renders as one unit:
 * its loaded layers sit together, top layer first, in the most urgent group
 * any open layer qualifies for, drawn on a spine that ends in a base-branch
 * foot ("main · #701 can land"). Everything here is pure so the page model
 * (which owns J/K order) and the list (which draws the spine) agree.
 */

type StackRow = Pick<ChangeRequest, "number" | "state" | "stackSummary">;

/** How a spine segment reads: neutral, part of the stretch that can land now, or merged. */
export type StackSpineTone = "none" | "landable" | "merged";

/** Where a row sits on its stack's spine (`top` draws no segment above the glyphs). */
export type StackSpineEdge = "top" | "mid" | "bottom";

export interface PullRequestRowSpine {
  /** Stack number, shared by every layer of the stack. */
  readonly stack: number;
  readonly edge: StackSpineEdge;
  /** Segment above the row's glyphs (toward the layer above). */
  readonly up: StackSpineTone;
  /** Segment below the row's glyphs (toward the layer below, or the base). */
  readonly down: StackSpineTone;
}

export interface PullRequestStackFoot {
  readonly stack: number;
  readonly baseRefName: string;
  /** Segment from the lowest loaded layer down to the base ring. */
  readonly tone: StackSpineTone;
  /** Merged layers the list knows about (loaded rows or the selected stack's detail). */
  readonly mergedCount: number;
  /** Open layers that can land right now, from the base up. */
  readonly landable: ReadonlyArray<number>;
  /** First unmerged layer that cannot land, when nothing can. */
  readonly blockedAt: number | null;
}

export type PullRequestListItem<T> =
  | {
      readonly kind: "row";
      readonly key: string;
      readonly entry: T;
      readonly spine: PullRequestRowSpine | null;
    }
  | { readonly kind: "foot"; readonly key: string; readonly foot: PullRequestStackFoot };

export interface PullRequestStackLayer {
  readonly number: number;
  readonly position: number;
  readonly state: ChangeRequestState;
  /** Open and clear to merge on its own once the layers below have landed. */
  readonly landable: boolean;
}

function stackOf(entry: StackRow): number | null {
  return entry.stackSummary?.number ?? null;
}

function byPositionDescending(left: StackRow, right: StackRow): number {
  return (
    (right.stackSummary?.position ?? 0) - (left.stackSummary?.position ?? 0) ||
    right.number - left.number
  );
}

/**
 * Moves each stack's layers together, top layer first. The unit lands in the
 * first group (most urgent first) that holds an open layer — or, for a stack
 * with nothing open, the first group holding any layer — at the slot of that
 * group's best-ranked qualifying layer. Groups left empty are dropped, like
 * `rankChangeRequests` drops them.
 */
export function arrangePullRequestStacks<T extends StackRow>(
  groups: ReadonlyArray<ChangeRequestListGroup<T>>,
): ReadonlyArray<ChangeRequestListGroup<T>> {
  const members = new Map<number, T[]>();
  for (const group of groups) {
    for (const entry of group.entries) {
      const stack = stackOf(entry);
      if (stack === null) continue;
      const layers = members.get(stack) ?? [];
      if (!layers.some((layer) => layer.number === entry.number)) layers.push(entry);
      members.set(stack, layers);
    }
  }
  if (members.size === 0) return groups;

  // The row each stack unit is emitted at: the first open layer in group order.
  const anchors = new Map<number, number>();
  for (const [stack, layers] of members) {
    const hasOpen = layers.some((layer) => layer.state === "open");
    for (const group of groups) {
      const anchor = group.entries.find(
        (entry) => stackOf(entry) === stack && (!hasOpen || entry.state === "open"),
      );
      if (anchor) {
        anchors.set(stack, anchor.number);
        break;
      }
    }
  }

  return groups
    .map((group) => {
      const entries: T[] = [];
      for (const entry of group.entries) {
        const stack = stackOf(entry);
        if (stack === null) {
          entries.push(entry);
          continue;
        }
        if (anchors.get(stack) !== entry.number) continue;
        entries.push(...(members.get(stack) ?? []).toSorted(byPositionDescending));
      }
      return { ...group, entries };
    })
    .filter((group) => group.entries.length > 0);
}

/**
 * Every layer of one stack the list knows about, bottom first: its loaded rows
 * plus, when the selected pull request belongs to the stack, the layers its
 * detail reports (merged layers are usually not in an open list). Loaded rows
 * win; a detail-only layer can land when the host says its merge state is clean.
 */
export function collectStackLayers<T extends StackRow>(input: {
  readonly rows: ReadonlyArray<T>;
  readonly isLandable: (entry: T) => boolean;
  readonly detailStack?: SourceControlChangeRequestStack | null | undefined;
}): ReadonlyArray<PullRequestStackLayer> {
  const layers = new Map<number, PullRequestStackLayer>();
  const stack = input.rows[0] ? stackOf(input.rows[0]) : null;
  if (input.detailStack && input.detailStack.number === stack) {
    for (const entry of input.detailStack.entries) {
      const status = entry.mergeStateStatus?.trim().toLowerCase() ?? "";
      layers.set(entry.number, {
        number: entry.number,
        position: entry.position,
        state: entry.state,
        landable:
          entry.state === "open" &&
          !entry.isDraft &&
          entry.mergeability !== "conflicting" &&
          (status === "clean" || status === "unstable" || status === "has_hooks"),
      });
    }
  }
  for (const row of input.rows) {
    layers.set(row.number, {
      number: row.number,
      position: row.stackSummary?.position ?? layers.get(row.number)?.position ?? 0,
      state: row.state,
      landable: row.state === "open" && input.isLandable(row),
    });
  }
  return [...layers.values()].toSorted(
    (left, right) => left.position - right.position || left.number - right.number,
  );
}

/** Highest position that can land now; merged layers count as landed. 0 when none. */
export function landableThrough(layers: ReadonlyArray<PullRequestStackLayer>): number {
  let through = 0;
  for (const layer of layers) {
    if (layer.state === "merged" || (layer.state === "open" && layer.landable)) {
      through = layer.position;
    } else {
      break;
    }
  }
  return through;
}

/** Tone of the segment from a layer down to the layer (or base) below it. */
export function stackLayerTone(layer: PullRequestStackLayer, through: number): StackSpineTone {
  if (layer.state === "merged") return "merged";
  return layer.state === "open" && layer.position <= through ? "landable" : "none";
}

export function describeStackFoot(input: {
  readonly stack: number;
  readonly baseRefName: string;
  readonly layers: ReadonlyArray<PullRequestStackLayer>;
  /** The lowest loaded layer; the foot segment continues its tone. */
  readonly lowest: number | null;
}): PullRequestStackFoot {
  const through = landableThrough(input.layers);
  const landable = input.layers
    .filter((layer) => layer.state === "open" && layer.position <= through)
    .map((layer) => layer.number);
  const blocker =
    landable.length === 0
      ? input.layers.find((layer) => layer.state !== "merged" && layer.position > through)
      : undefined;
  const lowest = input.layers.find((layer) => layer.number === input.lowest);
  return {
    stack: input.stack,
    baseRefName: input.baseRefName,
    tone: lowest ? stackLayerTone(lowest, through) : "none",
    mergedCount: input.layers.filter((layer) => layer.state === "merged").length,
    landable,
    blockedAt: blocker?.number ?? null,
  };
}

export type StackFootPartTone = "merged" | "landable" | "blocked";

/** "2 merged", "#701 can land" / "#701–#702 can land", "blocked at #702", in reading order. */
export function stackFootParts(
  foot: PullRequestStackFoot,
): ReadonlyArray<{ readonly text: string; readonly tone: StackFootPartTone }> {
  const parts: Array<{ readonly text: string; readonly tone: StackFootPartTone }> = [];
  if (foot.mergedCount > 0) parts.push({ text: `${foot.mergedCount} merged`, tone: "merged" });
  const first = foot.landable[0];
  const last = foot.landable.at(-1);
  if (first !== undefined && last !== undefined) {
    const range = first === last ? `#${first}` : `#${first}–#${last}`;
    parts.push({ text: `${range} can land`, tone: "landable" });
  } else if (foot.blockedAt !== null) {
    parts.push({ text: `blocked at #${foot.blockedAt}`, tone: "blocked" });
  }
  return parts;
}

/**
 * The rendered sequence for one group: plain rows, and for each stack unit its
 * rows (each carrying its own spine segments, so rows can be virtualized or
 * animated independently) followed by the foot. Stack units must be contiguous,
 * as `arrangePullRequestStacks` leaves them.
 */
export function buildPullRequestListItems<T extends StackRow>(
  entries: ReadonlyArray<T>,
  options: {
    readonly isLandable: (entry: T) => boolean;
    /**
     * Every loaded row, filtered out or not: a foot describes the whole stack
     * even while a filter or search hides some of its layers.
     */
    readonly allRows?: ReadonlyArray<T> | undefined;
    /** The selected pull request's stack (from its detail), to fill unloaded layers. */
    readonly detailStack?: SourceControlChangeRequestStack | null | undefined;
  },
): ReadonlyArray<PullRequestListItem<T>> {
  const items: PullRequestListItem<T>[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    const stack = stackOf(entry);
    if (stack === null) {
      items.push({ kind: "row", key: `pr:${entry.number}`, entry, spine: null });
      index += 1;
      continue;
    }
    const unit: T[] = [];
    while (index < entries.length && stackOf(entries[index]!) === stack) {
      unit.push(entries[index]!);
      index += 1;
    }
    const hidden = (options.allRows ?? []).filter(
      (row) => stackOf(row) === stack && !unit.some((shown) => shown.number === row.number),
    );
    const layers = collectStackLayers({
      rows: [...unit, ...hidden],
      isLandable: options.isLandable,
      detailStack: options.detailStack,
    });
    const through = landableThrough(layers);
    const toneOf = (row: T): StackSpineTone => {
      const layer = layers.find((candidate) => candidate.number === row.number);
      return layer ? stackLayerTone(layer, through) : "none";
    };
    unit.forEach((row, position) => {
      const above = unit[position - 1];
      items.push({
        kind: "row",
        key: `pr:${row.number}`,
        entry: row,
        spine: {
          stack,
          edge: position === 0 ? "top" : position === unit.length - 1 ? "bottom" : "mid",
          up: above ? toneOf(above) : "none",
          down: toneOf(row),
        },
      });
    });
    const lowest = unit.at(-1) ?? null;
    items.push({
      kind: "foot",
      key: `stack:${stack}`,
      foot: describeStackFoot({
        stack,
        baseRefName:
          (options.detailStack?.number === stack ? options.detailStack.baseRefName : null) ??
          entry.stackSummary?.baseRefName ??
          "",
        layers,
        lowest: lowest?.number ?? null,
      }),
    });
  }
  return items;
}
