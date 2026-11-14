/**
 * Timings and limits `ComputerManager` runs with; tests import them to stay in step.
 */

export const COMPUTER_FRAME_QUEUE_LIMIT = 8;
export const COMPUTER_FRAME_SOCKET_BUDGET_BYTES = 2 * 1024 * 1024;

/**
 * How long the enable path waits for in-flight stops and the durable
 * preference write before giving up. The write is a local file store and a
 * stop is a bounded native round trip, so anything past this is wedged — and
 * a wedged enable must fail closed (staying disabled) rather than wedge the
 * caller or open authority on an unrecorded preference.
 */
export const COMPUTER_CONTROL_ENABLE_TIMEOUT_MS = 30_000;

/**
 * How long the desktop is given to settle before the screenshot that rides on
 * an action result is captured. Long enough for a menu to open or a keystroke
 * to paint, short enough not to throttle the action loop the screenshot exists
 * to speed up.
 */
export const COMPUTER_ACTION_SETTLE_MS = 300;

/**
 * The driver-observed settle that replaces the fixed wait when the backend
 * exposes `waitForSettle`: the AX observer debounces
 * the configured `actionSettleMs` of notification silence after a
 * mutation, bounded by `COMPUTER_ACTION_OBSERVER_SETTLE_TIMEOUT_MS` when the
 * surface keeps churning (a busy indicator, a repeating animation). A
 * settled verdict usually lands faster than the fixed budget; a busy surface
 * waits longer than it — both better than the blind sleep they replace.
 */
export const COMPUTER_ACTION_OBSERVER_SETTLE_TIMEOUT_MS = 5_000;
export const COMPUTER_ACTION_OBSERVER_SETTLE_QUIET_MS = COMPUTER_ACTION_SETTLE_MS;

/**
 * How long paste waits before restoring the user's previous clipboard. The
 * target application reads the pasteboard off the keystroke asynchronously, so
 * restoring immediately would hand it the old contents. There is no observable
 * "the app read it" event, so this is a fixed settle like the action-screenshot
 * one above — long enough for the paste to land, short enough that a user who
 * reaches for their own clipboard next is not racing us.
 */
export const COMPUTER_PASTE_RESTORE_MS = 250;

/**
 * Trailing-edge window on the republish that a backend window change triggers.
 *
 * A publish costs one availability read, one window read and one screen-size
 * read per thread, and the window read is itself what reports a change — so a
 * desktop with a ticking window title (a clock, a download percentage, a video
 * player's timer) publishes, observes its own read as a change, and publishes
 * again, once per thread, without ever settling. Coalescing turns that into at
 * most one pass per window, which is the only rate that is bounded by something
 * other than how fast D-Bus answers.
 *
 * The window list itself is not delayed by this: `computer.windows-changed` is
 * emitted immediately from the event, with no backend call at all.
 */
export const COMPUTER_WINDOWS_PUBLISH_DEBOUNCE_MS = 250;

/**
 * The first vertical scroll into a window whose gearing is unknown is split:
 * this many requested pixels go first as a probe whose travel is measured and
 * learned, and the remainder is delivered pre-corrected. Sized so that even a
 * client gearing pixels up by the largest believable ratio keeps the probe's
 * travel inside the correlator's measurable band, while staying above the
 * store's minimum learnable injection.
 */
export const SCROLL_PROBE_PX = 48;
/**
 * Requests at or below this skip the probe: they are already probe-sized, and
 * even a heavily geared client keeps their travel measurable. Anything larger
 * into an unmeasured window is split — a 90 px request at 7x already travels
 * past what a window-height capture pair can correlate.
 */
export const SCROLL_PROBE_TRIGGER_PX = SCROLL_PROBE_PX;

/**
 * How close a leg's measured travel must land to its predicted distance before
 * that measurement itself counts as the settle evidence
 * (`SYNARA_CUA_CONDITIONAL_SETTLE`): the relative slack covers animation and
 * delivery residue on long legs, the floor covers the correlator's row
 * quantization on short ones.
 */
export const SCROLL_SETTLE_ARRIVAL_TOLERANCE = 0.15;
export const SCROLL_SETTLE_ARRIVAL_MIN_PX = 4;

/**
 * How long recordError waits before republishing the threads it touched, so an
 * outage that fails ten calls in a burst costs one publish, not ten.
 */
export const COMPUTER_ERROR_REPUBLISH_DEBOUNCE_MS = 250;
