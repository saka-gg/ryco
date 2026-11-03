import type { DesktopKeepAwakeMode, DesktopKeepAwakeState } from "@ryco/contracts";

/**
 * Keep a desktop-hosted node from idle-sleeping while other devices rely on it,
 * or while agents work on its own backend.
 *
 * The server's own lifetime hold only runs with `--prevent-sleep`, and its
 * agent-work hold never runs in desktop mode; the desktop launches its backend
 * without node.json, so a desktop that other devices reach through the Hub, the
 * network, or Tailscale used to idle-sleep and drop its relay, and a local-only
 * desktop slept in the middle of a turn. Main owns this instead because the
 * preference must apply live, without a relaunch. The backend reports agent
 * work over the private desktop pipe (`agent-work` frames, see
 * {@link BackendAgentWorkTracker}).
 *
 * Plugged-in only: a laptop on battery sleeps as the operator expects, and the
 * hold is reacquired as soon as it is back on AC power. The assertion keeps the
 * system awake but lets the display sleep.
 */

export interface DesktopKeepAwakeInputs {
  /** The operator's preference. */
  readonly mode: DesktopKeepAwakeMode;
  /** Whether any other device can reach this node right now. */
  readonly reachable: boolean;
  /** The running backend reports agent work (its `keepAwake`, which includes the 2-minute tail). */
  readonly agentWorking: boolean;
  readonly onBattery: boolean;
}

export type DesktopKeepAwakeReason = "reachable" | "agent-work";

/** Why the hold applies right now, or null. AC power only. */
export function desktopKeepAwakeReason(
  input: DesktopKeepAwakeInputs,
): DesktopKeepAwakeReason | null {
  if (input.mode === "off" || input.onBattery) return null;
  if (input.reachable) return "reachable";
  if (input.mode === "reachable-or-working" && input.agentWorking) return "agent-work";
  return null;
}

/**
 * Whether this desktop serves other devices.
 *
 * Every input describes what the running backend serves, never a saved
 * preference: the Hub counts only while the backend reports an enrolled
 * connector that is connected or reconnecting, so an enrollment nobody approves
 * or a connector waiting on a restart does not keep a machine awake for nobody.
 * The network mode is the effective one, so a requested LAN exposure that fell
 * back to loopback does not either.
 */
export function isDesktopNodeReachable(input: {
  readonly hubReachable: boolean;
  readonly effectiveServerExposureMode: "local-only" | "network-accessible";
  readonly tailscaleServeEnabled: boolean;
}): boolean {
  return (
    input.hubReachable ||
    input.effectiveServerExposureMode === "network-accessible" ||
    input.tailscaleServeEnabled
  );
}

/** The subset of Electron's `powerSaveBlocker` this controller needs. */
export interface DesktopPowerSaveBlocker {
  readonly start: (type: "prevent-app-suspension") => number;
  readonly stop: (id: number) => void;
  readonly isStarted: (id: number) => boolean;
}

/** The subset of Electron's `powerMonitor` this controller needs. */
export interface DesktopPowerSource {
  isOnBatteryPower(): boolean;
  on(event: "on-ac", listener: () => void): unknown;
  on(event: "on-battery", listener: () => void): unknown;
  on(event: "resume", listener: () => void): unknown;
  removeListener(event: "on-ac", listener: () => void): unknown;
  removeListener(event: "on-battery", listener: () => void): unknown;
  removeListener(event: "resume", listener: () => void): unknown;
}

/** Power-source events are not emitted on every platform; re-check this often. */
export const DESKTOP_KEEP_AWAKE_RECHECK_MS = 60_000;

export class DesktopKeepAwakeController {
  readonly #blocker: DesktopPowerSaveBlocker;
  readonly #power: DesktopPowerSource;
  readonly #read: () => Pick<DesktopKeepAwakeInputs, "mode" | "reachable" | "agentWorking">;
  readonly #setInterval: (callback: () => void, ms: number) => { unref?: () => void };
  readonly #clearInterval: (handle: unknown) => void;
  readonly #onChange:
    | ((active: boolean, reason: DesktopKeepAwakeReason | null) => void)
    | undefined;
  #blockerId: number | null = null;
  #timer: unknown = null;
  #started = false;
  readonly #sync = () => {
    this.sync();
  };

  constructor(input: {
    readonly blocker: DesktopPowerSaveBlocker;
    readonly power: DesktopPowerSource;
    readonly read: () => Pick<DesktopKeepAwakeInputs, "mode" | "reachable" | "agentWorking">;
    readonly setInterval?: (callback: () => void, ms: number) => { unref?: () => void };
    readonly clearInterval?: (handle: unknown) => void;
    /**
     * Called whenever the hold is acquired (with the reason that acquired it) or released (with
     * `null`). A change of reason while held is not reported.
     */
    readonly onChange?: (active: boolean, reason: DesktopKeepAwakeReason | null) => void;
  }) {
    this.#blocker = input.blocker;
    this.#power = input.power;
    this.#read = input.read;
    this.#setInterval = input.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.#clearInterval =
      input.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    this.#onChange = input.onChange;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#power.on("on-ac", this.#sync);
    this.#power.on("on-battery", this.#sync);
    // Re-check after sleep too: the power source may have changed meanwhile.
    this.#power.on("resume", this.#sync);
    const timer = this.#setInterval(this.#sync, DESKTOP_KEEP_AWAKE_RECHECK_MS);
    timer.unref?.();
    this.#timer = timer;
    this.sync();
  }

  /** Re-evaluate after any preference, reachability, agent-work, or power change. */
  sync(): DesktopKeepAwakeState {
    const state = this.#evaluate();
    const reason = this.#started ? desktopKeepAwakeReason(state) : null;
    if (reason !== null && this.#blockerId === null) {
      this.#blockerId = this.#blocker.start("prevent-app-suspension");
      this.#onChange?.(true, reason);
    } else if (reason === null && this.#blockerId !== null) {
      this.#release();
      this.#onChange?.(false, null);
    }
    return { ...state, active: this.#blockerId !== null };
  }

  state(): DesktopKeepAwakeState {
    return { ...this.#evaluate(), active: this.#blockerId !== null };
  }

  dispose(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#power.removeListener("on-ac", this.#sync);
    this.#power.removeListener("on-battery", this.#sync);
    this.#power.removeListener("resume", this.#sync);
    if (this.#timer !== null) this.#clearInterval(this.#timer);
    this.#timer = null;
    if (this.#blockerId !== null) this.#release();
  }

  #evaluate(): DesktopKeepAwakeInputs {
    const { mode, reachable, agentWorking } = this.#read();
    let onBattery = true;
    try {
      onBattery = this.#power.isOnBatteryPower();
    } catch {
      // The hold is for machines on AC power only. A power source that cannot
      // be read is not proof of AC, so it is treated as battery.
    }
    return { mode, reachable, agentWorking, onBattery };
  }

  #release(): void {
    const id = this.#blockerId;
    this.#blockerId = null;
    if (id !== null && this.#blocker.isStarted(id)) this.#blocker.stop(id);
  }
}

/**
 * How long a working backend's report outlives that backend. A backend that exits mid-turn is
 * restarted, and its successor reports only once its own startup command gate opens, which
 * can take a while on a large database; the turns the restart continues need the machine awake
 * meanwhile. Bounded, so a backend that never comes back cannot pin the hold.
 */
export const DESKTOP_AGENT_WORK_EXIT_HOLD_MS = 120_000;

/**
 * The agent-work reports of the desktop's backend generations (`agent-work` frames).
 *
 * Only the current generation counts: a report from a replaced child, or one drained from the
 * pipe after its child exited, is dropped. When a child that reported work exits while the app
 * is not quitting, the exit ends that work like any other stop: it keeps counting for the
 * release tail ({@link DESKTOP_AGENT_WORK_EXIT_HOLD_MS}), unless the next child reports work
 * sooner and takes over. The next child's idle reports do not cut the tail short: its first one
 * is made before it continues the turns the restart interrupted.
 */
export class BackendAgentWorkTracker {
  readonly #onChange: () => void;
  readonly #setTimeout: (callback: () => void, ms: number) => { unref?: () => void };
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #exitHoldMs: number;
  #child: object | null = null;
  // The current child's last `keepAwake`; null until it reports.
  #reported: boolean | null = null;
  // Set while an exited child's work still counts.
  #exitHold: unknown = null;

  constructor(input: {
    /** Called whenever {@link agentWorking} changes. */
    readonly onChange: () => void;
    readonly setTimeout?: (callback: () => void, ms: number) => { unref?: () => void };
    readonly clearTimeout?: (handle: unknown) => void;
    readonly exitHoldMs?: number;
  }) {
    this.#onChange = input.onChange;
    this.#setTimeout = input.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimeout =
      input.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#exitHoldMs = input.exitHoldMs ?? DESKTOP_AGENT_WORK_EXIT_HOLD_MS;
  }

  /** Whether the backend's agent work should keep this machine awake now. */
  get agentWorking(): boolean {
    return this.#reported === true || this.#exitHold !== null;
  }

  /** `child` is the backend now; earlier children's reports no longer count. */
  begin(child: object): void {
    this.#change(() => {
      this.#child = child;
      this.#reported = null;
    });
  }

  /** A report from `child`, dropped unless it is the current backend. */
  report(child: object, keepAwake: boolean): void {
    if (child !== this.#child) return;
    this.#change(() => {
      // Work on the current backend carries its own release tail from now on.
      if (keepAwake) this.#cancelExitHold();
      this.#reported = keepAwake;
    });
  }

  /**
   * `child` exited. With `holdIfWorking` (the app is not quitting), work it last reported keeps
   * counting for a while; see {@link DESKTOP_AGENT_WORK_EXIT_HOLD_MS}.
   */
  end(child: object, options: { readonly holdIfWorking: boolean }): void {
    if (child !== this.#child) return;
    this.#change(() => {
      const wasWorking = this.#reported === true;
      this.#child = null;
      this.#reported = null;
      if (!options.holdIfWorking) {
        this.#cancelExitHold();
      } else if (wasWorking) {
        this.#cancelExitHold();
        const timer = this.#setTimeout(() => {
          if (this.#exitHold !== timer) return;
          this.#change(() => {
            this.#exitHold = null;
          });
        }, this.#exitHoldMs);
        timer.unref?.();
        this.#exitHold = timer;
      }
      // A child that exits before reporting leaves a running hold as it is: a crash loop must
      // not extend it past the first exit's bound.
    });
  }

  /** Forget everything without reporting a change; the app is quitting. */
  dispose(): void {
    this.#cancelExitHold();
    this.#child = null;
    this.#reported = null;
  }

  #cancelExitHold(): void {
    if (this.#exitHold === null) return;
    this.#clearTimeout(this.#exitHold);
    this.#exitHold = null;
  }

  #change(mutate: () => void): void {
    const before = this.agentWorking;
    mutate();
    if (this.agentWorking !== before) this.#onChange();
  }
}
