import type { DesktopKeepAwakeState } from "@ryco/contracts";

/**
 * Keep a desktop-hosted node from idle-sleeping while other devices rely on it.
 *
 * The server's own sleep inhibitor only runs for `ryco serve` with
 * `--prevent-sleep`; the desktop launches its backend without node.json, so a
 * desktop that other devices reach through the Hub, the network, or Tailscale
 * used to idle-sleep and drop its relay. Main owns this instead because the
 * preference must apply live, without a relaunch.
 *
 * Plugged-in only: a laptop on battery sleeps as the operator expects, and the
 * hold is reacquired as soon as it is back on AC power. The assertion keeps the
 * system awake but lets the display sleep.
 */

export interface DesktopKeepAwakeInputs {
  /** The operator's preference. On by default. */
  readonly enabled: boolean;
  /** Whether any other device can reach this node right now. */
  readonly reachable: boolean;
  readonly onBattery: boolean;
}

export function shouldKeepDesktopAwake(input: DesktopKeepAwakeInputs): boolean {
  return input.enabled && input.reachable && !input.onBattery;
}

/**
 * Whether this desktop serves other devices.
 *
 * A Hub connector counts only when it is actually configured to run; the
 * network mode is the effective one, so a requested LAN exposure that fell back
 * to loopback does not keep a machine awake for nobody.
 */
export function isDesktopNodeReachable(input: {
  readonly hubConnectorEnabled: boolean;
  readonly effectiveServerExposureMode: "local-only" | "network-accessible";
  readonly tailscaleServeEnabled: boolean;
}): boolean {
  return (
    input.hubConnectorEnabled ||
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
  readonly #read: () => Pick<DesktopKeepAwakeInputs, "enabled" | "reachable">;
  readonly #setInterval: (callback: () => void, ms: number) => { unref?: () => void };
  readonly #clearInterval: (handle: unknown) => void;
  readonly #onChange: ((active: boolean) => void) | undefined;
  #blockerId: number | null = null;
  #timer: unknown = null;
  #started = false;
  readonly #sync = () => {
    this.sync();
  };

  constructor(input: {
    readonly blocker: DesktopPowerSaveBlocker;
    readonly power: DesktopPowerSource;
    readonly read: () => Pick<DesktopKeepAwakeInputs, "enabled" | "reachable">;
    readonly setInterval?: (callback: () => void, ms: number) => { unref?: () => void };
    readonly clearInterval?: (handle: unknown) => void;
    /** Called whenever the hold is acquired or released. */
    readonly onChange?: (active: boolean) => void;
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

  /** Re-evaluate after any preference, reachability, or power change. */
  sync(): DesktopKeepAwakeState {
    const state = this.#evaluate();
    const want = this.#started && shouldKeepDesktopAwake(state);
    if (want && this.#blockerId === null) {
      this.#blockerId = this.#blocker.start("prevent-app-suspension");
      this.#onChange?.(true);
    } else if (!want && this.#blockerId !== null) {
      this.#release();
      this.#onChange?.(false);
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
    const { enabled, reachable } = this.#read();
    let onBattery = true;
    try {
      onBattery = this.#power.isOnBatteryPower();
    } catch {
      // The hold is for machines on AC power only. A power source that cannot
      // be read is not proof of AC, so it is treated as battery.
    }
    return { enabled, reachable, onBattery };
  }

  #release(): void {
    const id = this.#blockerId;
    this.#blockerId = null;
    if (id !== null && this.#blocker.isStarted(id)) this.#blocker.stop(id);
  }
}
