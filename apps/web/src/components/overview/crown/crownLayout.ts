import type { CSSProperties } from "react";

/**
 * Crown geometry and timing, mirrored from the approved prototype
 * (output/overview-concepts/rail-island.html, "Crown"). The sizes the
 * stylesheet shares with the TypeScript geometry reach CSS through
 * {@link CROWN_GEOMETRY_STYLE}, so this module is their single source.
 */

/** Rail column width; the crown face is the same size. */
export const CROWN_RAIL_WIDTH_PX = 48;
/** Gutter between the rail and the chat column edge. */
export const CROWN_RAIL_GUTTER_PX = 12;
/** Width the docked rail reserves in the chat row (rail + gutters). */
export const CROWN_RAIL_SLOT_WIDTH_PX = CROWN_RAIL_WIDTH_PX + 2 * CROWN_RAIL_GUTTER_PX;
/** Crown face height plus the gap above the rail (48 + 8). */
export const CROWN_HEAD_OFFSET_PX = 56;
/** Expanded card width (content + spine). */
export const CROWN_CARD_WIDTH_PX = 372;
/** Hover flyout width. */
export const CROWN_FLYOUT_WIDTH_PX = 272;
/** Space between the rail edge and the flyout. */
export const CROWN_FLYOUT_GAP_PX = 10;

/** Delay before an un-hovered flyout closes. */
export const CROWN_FLYOUT_CLOSE_DELAY_MS = 240;
/** Rail enter/exit; ChatView delays unmount by this much. */
export const CROWN_RAIL_EXIT_MS = 550;
/** The crown's ease-out (`--crown-ease-out`), for transitions outside its root. */
export const CROWN_EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

/** How long an alert stays when nothing else is queued. */
export const CROWN_ALERT_DWELL_MS = 2900;
/** Shorter dwell while more alerts wait. */
export const CROWN_ALERT_DWELL_QUEUED_MS = 1800;
/** Pending alerts kept; older ones are dropped. */
export const CROWN_ALERT_QUEUE_MAX = 3;
/** After a user-started git action ends, branch/PR alerts stay quiet this long (the action already toasted). */
export const CROWN_GIT_ACTION_SUPPRESS_MS = 4000;

/** Gap (in `pathLength=100` units) between check-ring segments on a rail icon (r=12.5). */
export const CROWN_RAIL_RING_GAP_PCT = 9;
/** Above this many runs the ring collapses to one arc per state. */
export const CROWN_RING_MAX_SEGMENTS = 24;
/** Shortest drawn ring segment, so a crowded ring still shows a tick per run. */
export const CROWN_RING_MIN_SEGMENT_PCT = 0.6;

/** Inset the flyout and the expanded card keep from the bounds' edges. */
export const CROWN_BOUNDS_PADDING_PX = 12;
/** Card chrome (header row + padding) subtracted from the cap to size the detail scroller. */
export const CROWN_CARD_CHROME_PX = 64;
/** Dedupe window: alert keys remembered to drop repeats of the same transition. */
export const CROWN_ALERT_RECENT_MAX = 50;
/** Workflow members listed per workflow card before "+N more", by detail variant. */
export const CROWN_WORKFLOW_MEMBER_LIMIT = { flyout: 3, card: 5 } as const;

/** Geometry custom properties on `.crown-root`; the stylesheet sizes the rail, spine, card and flyout from them. */
export const CROWN_GEOMETRY_STYLE = {
  "--crown-rail-width": `${CROWN_RAIL_WIDTH_PX}px`,
  "--crown-head-offset": `${CROWN_HEAD_OFFSET_PX}px`,
  "--crown-card-width": `${CROWN_CARD_WIDTH_PX}px`,
  "--crown-flyout-gap": `${CROWN_FLYOUT_GAP_PX}px`,
} as CSSProperties;
