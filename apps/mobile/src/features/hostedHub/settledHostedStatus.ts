import {
  HOSTED_CONNECTION_STATUS_INDICATORS,
  type HostedConnectionStatusIndicator,
  type HostedConnectionStatusText,
} from "@ryco/client-runtime/authorization";

/**
 * Settling for the hosted connection status chip (plan wave 3a, step 6).
 *
 * Re-targeting the hosted connection walks the derived status through up to
 * seven transient labels in well under a second — `Idle`, `Preparing`,
 * `Connecting`, `Verifying`, `Opening`, `Not ready`, `Securing` — because every
 * `selectNode` bumps the runtime generation, which resets the §4 channel
 * projection synchronously and renegotiates. Rendering each of those is a
 * strobe, and a strobe is unreadable: the owner cannot tell a stuck handshake
 * from a fast one.
 *
 * This module is the *presentation* fix and nothing more. It never invents a
 * status, never reorders one, and never derives one: it takes the pair the pure
 * derivation already produced and decides WHEN to swap what is on screen. The
 * derivation in `client-runtime/authorization/connectionStatus.ts` stays the
 * single source of the vocabulary and is not touched.
 *
 * The claim rules from `docs/relay-e2ee-protocol.md` bound what settling may
 * do, and they are the reason this is a step machine rather than a debounce:
 *
 * - §12.2 (`Legacy`) and §13.1 (`Not verified`) are MANDATORY labels. They are
 *   classified settled, so they are displayed the instant they arrive — a
 *   debounce that delayed them would suppress the one label the owner has to
 *   act on.
 * - §2.2 forbids presenting a stronger claim than the configuration supports.
 *   A guarantee-bearing label (`Encrypted`, `Unsigned web`, `Legacy`) is
 *   therefore never held over a transient and never held across a change of
 *   selection: holding `Encrypted` from the previous node while the next node
 *   is still shaking hands would be exactly that overclaim. Hence the "demote
 *   now" step, which spends one frame rather than waiting out the threshold.
 *
 * What settling actually buys: a fast switch collapses to at most two visible
 * frames (the demote, then the settled result), while a genuinely slow
 * handshake still shows `Verifying` honestly once it has lasted the threshold.
 */

/** The pair a surface renders. Settled as one unit so the collapsed indicator
 * and the full accessible text can never describe different states. */
export interface SettledHostedStatus {
  readonly indicator: HostedConnectionStatusIndicator;
  readonly statusText: HostedConnectionStatusText;
}

/**
 * One observation: the freshly derived pair plus the identity of the selection
 * it describes.
 *
 * `selectionKey` is what makes this more than a debounce. Two statuses with the
 * same text can belong to different nodes, and a label that was true for the
 * previous node is a lie about the next one. The caller builds it from the
 * selected node's id AND environment id (`null` when nothing is selected), so a
 * node re-enrolled under a new environment counts as a different selection.
 */
export interface SettledHostedStatusInput extends SettledHostedStatus {
  readonly selectionKey: string | null;
}

/**
 * The selection identity behind a status, from the selected node itself.
 *
 * Both halves are in the key on purpose: the node id alone would treat a node
 * re-enrolled under a different environment as the same selection, and the
 * environment id alone would do the same for two nodes sharing one. `null` is
 * "nothing is selected", which is itself an identity a status can belong to.
 */
export function hostedSelectionKey(
  selectedNode: { readonly id: string; readonly environmentId: string } | null | undefined,
): string | null {
  return selectedNode ? `${selectedNode.id}\u0000${selectedNode.environmentId}` : null;
}

export type SettledHostedStatusKind = "settled" | "transient";

export type SettledHostedStatusTimerHandle = ReturnType<typeof setTimeout>;

/** The timer seam, so tests drive promotion deterministically. */
export interface SettledHostedStatusTimers {
  readonly setTimeout: (handler: () => void, ms: number) => SettledHostedStatusTimerHandle;
  readonly clearTimeout: (handle: SettledHostedStatusTimerHandle) => void;
}

const DEFAULT_TIMERS: SettledHostedStatusTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** How long one transient must stay current before it earns the screen. */
export const DEFAULT_SETTLED_HOSTED_STATUS_THRESHOLD_MS = 500;

/**
 * Every bounded status, classified once and exhaustively.
 *
 * `satisfies Record<HostedConnectionStatusText, …>` is the whole point: adding a
 * status to the vocabulary fails the build here rather than defaulting into
 * "transient" and being silently withheld from the owner for half a second —
 * which, for a status that turns out to be an attention state, is the §13.1
 * failure this file is supposed to prevent.
 *
 * `settled` means "this is an outcome": a usable connection (`connected`), or a
 * terminal/attention state the owner is meant to read and act on. Everything
 * else is a step on the way to one, and steps are what strobe.
 */
export const HOSTED_STATUS_SETTLEMENT = {
  // Outcomes: connected states.
  Online: "settled",
  "Encrypted · Verified locally": "settled",
  "Encrypted · Account trusted": "settled",
  "Encrypted web": "settled",
  "Legacy connection": "settled",
  // Outcomes: terminal and attention states. `Not verified` and the legacy
  // connection label are
  // mandatory labels (§13.1, §12.2) and are settled so they are never delayed.
  Offline: "settled",
  Stale: "settled",
  "Delivery unknown": "settled",
  "Authorization removed": "settled",
  Revoked: "settled",
  "Device removed": "settled",
  Incompatible: "settled",
  "Not verified": "settled",
  "terminal failure": "settled",
  // Steps.
  "Checking access": "transient",
  Synchronizing: "transient",
  Securing: "transient",
  "Securing this device": "transient",
  "Device encryption unavailable": "settled",
  Reconnecting: "transient",
  idle: "transient",
  "requesting ticket": "transient",
  connecting: "transient",
  authenticating: "transient",
  "opening channel": "transient",
  online: "transient",
  draining: "transient",
} as const satisfies Record<HostedConnectionStatusText, SettledHostedStatusKind>;

export function classifyHostedStatus(
  statusText: HostedConnectionStatusText,
): SettledHostedStatusKind {
  return HOSTED_STATUS_SETTLEMENT[statusText];
}

export interface SettledHostedStatusTracker {
  /** Feed the freshly derived pair. Safe to call every render. */
  readonly update: (input: SettledHostedStatusInput) => void;
  /** The pair to display right now. Stable by identity while unchanged. */
  readonly read: () => SettledHostedStatus;
  /**
   * Notified when the THRESHOLD promotes a pending transient — the one display
   * change nothing else can observe, because it happens with no new state from
   * the runtime and therefore no render of its own.
   *
   * Changes caused by `update` deliberately do not notify: the caller is
   * already rendering (that is why it called `update`) and will `read` in the
   * same pass, and calling back into React from inside a render phase is how a
   * store update ends up scheduled mid-render.
   */
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

/**
 * What the tracker is currently showing, which is not the same question as what
 * the runtime currently reports:
 *
 * - `settled` — an outcome is on screen and nothing is pending.
 * - `grace` — an outcome with no guarantee claim (e.g. `Online`) is still on
 *   screen while a transient has just arrived for the SAME selection. A blip
 *   shorter than the threshold never reaches the screen at all.
 * - `transition` — a transient is on screen; further transients queue behind
 *   the threshold instead of replacing it.
 */
type TrackerMode = "settled" | "grace" | "transition";

const INITIAL_STATUS: SettledHostedStatus = {
  statusText: "idle",
  indicator: HOSTED_CONNECTION_STATUS_INDICATORS.idle,
};

export function createSettledHostedStatusTracker(
  options: {
    readonly thresholdMs?: number;
    readonly timers?: SettledHostedStatusTimers;
  } = {},
): SettledHostedStatusTracker {
  const thresholdMs = options.thresholdMs ?? DEFAULT_SETTLED_HOSTED_STATUS_THRESHOLD_MS;
  const timers = options.timers ?? DEFAULT_TIMERS;
  const listeners = new Set<() => void>();

  let displayed: SettledHostedStatus = INITIAL_STATUS;
  let displayedSelectionKey: string | null = null;
  let mode: TrackerMode = "transition";
  let started = false;
  let pending: SettledHostedStatusInput | null = null;
  let handle: SettledHostedStatusTimerHandle | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (handle === null) return;
    timers.clearTimeout(handle);
    handle = null;
  };

  const display = (input: SettledHostedStatusInput, notify: boolean) => {
    displayedSelectionKey = input.selectionKey;
    if (displayed.statusText === input.statusText && displayed.indicator === input.indicator) {
      return;
    }
    displayed = { indicator: input.indicator, statusText: input.statusText };
    if (notify) listeners.forEach((listener) => listener());
  };

  /**
   * The threshold expired with a transient still current: it has now lasted
   * long enough to be worth reading, so it takes the screen. This is the path
   * that must notify — nothing else is re-rendering the surface, since the
   * runtime state has not changed since the last `update`.
   */
  const promote = () => {
    handle = null;
    if (disposed) return;
    mode = "transition";
    const target = pending;
    pending = null;
    if (target) display(target, true);
  };

  const arm = () => {
    clearTimer();
    handle = timers.setTimeout(promote, thresholdMs);
  };

  const update = (input: SettledHostedStatusInput) => {
    if (disposed) return;

    // The first observation is always shown: there is no earlier frame worth
    // protecting, and withholding it would render the placeholder instead.
    if (!started) {
      started = true;
      clearTimer();
      pending = null;
      mode = classifyHostedStatus(input.statusText) === "settled" ? "settled" : "transition";
      display(input, false);
      return;
    }

    // Step 1. An outcome always wins, immediately, and cancels any pending
    // promotion — including the mandatory `Legacy` and `Not verified` labels,
    // which is why they can never be held back by a transition.
    if (classifyHostedStatus(input.statusText) === "settled") {
      clearTimer();
      pending = null;
      mode = "settled";
      display(input, false);
      return;
    }

    if (mode !== "transition") {
      // Step 2. What is on screen is an outcome, and this transient means it is
      // over. Two cases force the demote to happen NOW rather than after the
      // grace window: a guarantee-bearing label may not be shown over a
      // transient at all (§2.2), and no outcome from the previous selection may
      // survive into the next one.
      if (
        displayed.indicator.guarantee !== "none" ||
        input.selectionKey !== displayedSelectionKey
      ) {
        clearTimer();
        pending = null;
        mode = "transition";
        display(input, false);
        return;
      }

      // Step 4. A claim-free outcome (`Online`, `Offline`, …) for the same
      // selection gets one grace window, so a sub-threshold blip on the current
      // node never flickers. The window is armed once and measures the age of
      // the outcome on screen, not the identity of the transient behind it, so
      // a churning transient cannot extend it indefinitely.
      pending = input;
      if (mode === "settled") {
        mode = "grace";
        arm();
      }
      return;
    }

    // Step 3. A transient is already on screen. Keep it: swapping one step
    // label for another is the strobe. The newcomer only reaches the screen if
    // it is still current a whole threshold later.
    if (input.statusText === displayed.statusText) {
      // It caught up with what is already shown; nothing left to promote.
      clearTimer();
      pending = null;
      displayedSelectionKey = input.selectionKey;
      return;
    }
    // A pending target that merely repeats keeps its existing timer running —
    // re-arming on every store tick would mean a status that never settles also
    // never appears.
    if (pending && pending.statusText === input.statusText) {
      pending = input;
      return;
    }
    pending = input;
    arm();
  };

  return {
    update,
    read: () => displayed,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      disposed = true;
      clearTimer();
      pending = null;
      listeners.clear();
    },
  };
}
