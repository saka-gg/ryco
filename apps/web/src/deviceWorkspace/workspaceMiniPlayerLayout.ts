// Adapted from t3code's previewMiniPlayerLayout (pingdotgg/t3code, MIT); see THIRD_PARTY_NOTICES.md.
import type {
  WorkspaceMiniPlayerPosition,
  WorkspaceMiniPlayerSize,
} from "./workspaceMiniPlayerStore";

/*
 * Where the mini-player sits and how big it is, inside the chat column. The
 * window keeps its source's aspect ratio, stays a gap away from every edge,
 * and keeps clear of the composer below it.
 */

export const MINI_PLAYER_EDGE_GAP = 12;
/** Height of the drag handle above the content. */
export const MINI_PLAYER_HANDLE_HEIGHT = 28;
/**
 * The window's height beyond its scaled content: the handle, plus whatever a
 * source draws at a fixed height (a control rail). Keeps the aspect ratio on
 * the content rather than on the whole window.
 */
export type MiniPlayerChrome = number;
const DEFAULT_BOX = { width: 300, height: 560 } as const;
const MIN_SIZE = { width: 160, height: 150 } as const;

export type MiniPlayerResizeDirection =
  | "north"
  | "south"
  | "east"
  | "west"
  | "north-east"
  | "north-west"
  | "south-east"
  | "south-west";

export const MINI_PLAYER_RESIZE_DIRECTIONS: readonly MiniPlayerResizeDirection[] = [
  "north",
  "south",
  "east",
  "west",
  "north-east",
  "north-west",
  "south-east",
  "south-west",
];

export interface MiniPlayerFrame extends WorkspaceMiniPlayerPosition, WorkspaceMiniPlayerSize {}

/**
 * What the window must keep clear of: the composer's span along the bottom,
 * and the chat header floating along the top.
 */
export interface MiniPlayerObstacles {
  readonly composer: {
    readonly left: number;
    readonly right: number;
    readonly height: number;
  } | null;
  /** Height of the header bar over the column's top edge. */
  readonly header?: number;
}

const NO_OBSTACLES: MiniPlayerObstacles = { composer: null };

const ceilingOf = (obstacles: MiniPlayerObstacles) =>
  Math.max(MINI_PLAYER_EDGE_GAP, obstacles.header ?? 0);

interface Span {
  readonly left: number;
  readonly right: number;
}
const spanOf = (x: number, width: number): Span => ({ left: x, right: x + width });
const spansOverlap = (a: Span, b: Span) => a.left < b.right && a.right > b.left;

function floorFor(
  span: Span,
  container: WorkspaceMiniPlayerSize,
  obstacles: MiniPlayerObstacles,
): number {
  const { composer } = obstacles;
  return composer && spansOverlap(span, composer)
    ? container.height - Math.max(0, composer.height)
    : container.height;
}

/** Height of the whole window (chrome included) for a content width. */
const frameHeight = (width: number, aspect: number, chrome: MiniPlayerChrome) =>
  width / aspect + chrome;

const minimumWidth = (aspect: number, chrome: MiniPlayerChrome) =>
  Math.max(MIN_SIZE.width, Math.max(0, MIN_SIZE.height - chrome) * aspect);

function fitWidth(
  desired: number,
  aspect: number,
  chrome: MiniPlayerChrome,
  max: WorkspaceMiniPlayerSize,
  minimum = minimumWidth(aspect, chrome),
): WorkspaceMiniPlayerSize {
  const width = Math.min(
    Math.max(desired, minimum),
    Math.max(1, max.width),
    Math.max(1, (max.height - chrome) * aspect),
  );
  return { width: Math.round(width), height: Math.round(frameHeight(width, aspect, chrome)) };
}

function defaultWidth(aspect: number, chrome: MiniPlayerChrome): number {
  return Math.min(DEFAULT_BOX.width, (DEFAULT_BOX.height - chrome) * aspect);
}

export function clampMiniPlayerPosition(
  position: WorkspaceMiniPlayerPosition,
  container: WorkspaceMiniPlayerSize,
  size: WorkspaceMiniPlayerSize,
  obstacles: MiniPlayerObstacles = NO_OBSTACLES,
): WorkspaceMiniPlayerPosition {
  const gap = MINI_PLAYER_EDGE_GAP;
  const ceiling = ceilingOf(obstacles);
  const x = Math.min(Math.max(position.x, gap), Math.max(gap, container.width - size.width - gap));
  const floor = floorFor(spanOf(x, size.width), container, obstacles);
  const y = Math.min(Math.max(position.y, ceiling), Math.max(ceiling, floor - size.height - gap));
  return { x, y };
}

/**
 * The frame for a stored placement in this container. Clamped per layout and
 * not written back, so a narrow window keeps the width the user chose for a
 * wide one.
 */
export function resolveMiniPlayerFrame(input: {
  readonly width: number | null;
  readonly position: WorkspaceMiniPlayerPosition | null;
  /** Content aspect ratio, width over height. */
  readonly aspect: number;
  readonly chrome?: MiniPlayerChrome;
  readonly container: WorkspaceMiniPlayerSize;
  readonly obstacles?: MiniPlayerObstacles;
}): MiniPlayerFrame {
  const { position, aspect, container, obstacles = NO_OBSTACLES } = input;
  const chrome = input.chrome ?? MINI_PLAYER_HANDLE_HEIGHT;
  const gap = MINI_PLAYER_EDGE_GAP;
  const span = position && input.width ? spanOf(position.x, input.width) : null;
  const available = {
    width: container.width - gap * 2,
    height:
      (span
        ? floorFor(span, container, obstacles)
        : container.height - Math.max(0, obstacles.composer?.height ?? 0)) -
      ceilingOf(obstacles) -
      gap,
  };
  const size = fitWidth(
    input.width ?? defaultWidth(aspect, chrome),
    aspect,
    chrome,
    available,
    input.width ?? undefined,
  );
  const anchored = position ?? { x: container.width - gap - size.width, y: ceilingOf(obstacles) };
  return { ...clampMiniPlayerPosition(anchored, container, size, obstacles), ...size };
}

/** Resize from an edge or corner, keeping the aspect ratio and the opposite edge in place. */
export function resizeMiniPlayer(input: {
  readonly start: MiniPlayerFrame;
  readonly direction: MiniPlayerResizeDirection;
  readonly delta: WorkspaceMiniPlayerPosition;
  readonly aspect: number;
  readonly chrome?: MiniPlayerChrome;
  readonly container: WorkspaceMiniPlayerSize;
  readonly obstacles?: MiniPlayerObstacles;
}): MiniPlayerFrame {
  const { start, direction, delta, aspect, container, obstacles = NO_OBSTACLES } = input;
  const chrome = input.chrome ?? MINI_PLAYER_HANDLE_HEIGHT;
  const gap = MINI_PLAYER_EDGE_GAP;
  const east = direction.includes("east");
  const west = direction.includes("west");
  const north = direction.includes("north");
  const south = direction.includes("south");
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const floor = floorFor(spanOf(start.x, start.width), container, obstacles);
  const max = {
    width: west ? right - gap : east ? container.width - gap - start.x : container.width - gap * 2,
    height: north
      ? bottom - ceilingOf(obstacles)
      : south
        ? floor - gap - start.y
        : floor - ceilingOf(obstacles) - gap,
  };
  const desiredWidth = start.width + (east ? delta.x : west ? -delta.x : 0);
  // Compare content heights: the chrome does not scale with the window.
  const desiredContentHeight = start.height - chrome + (south ? delta.y : north ? -delta.y : 0);
  const horizontal = east || west;
  const vertical = north || south;
  // Project onto the aspect-ratio diagonal; switching on the dominant axis
  // jumps when the two axes move in opposite directions.
  const desired =
    horizontal && vertical
      ? (desiredWidth + desiredContentHeight / aspect) / (1 + 1 / aspect ** 2)
      : horizontal
        ? desiredWidth
        : desiredContentHeight * aspect;
  const size = fitWidth(
    desired,
    aspect,
    chrome,
    max,
    Math.min(start.width, minimumWidth(aspect, chrome)),
  );
  const position = clampMiniPlayerPosition(
    { x: west ? right - size.width : start.x, y: north ? bottom - size.height : start.y },
    container,
    size,
    obstacles,
  );
  return { ...position, ...size };
}
