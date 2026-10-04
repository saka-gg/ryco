import {
  deriveHostedConnectionStatusIndicator,
  HOSTED_CONNECTION_STATUS_INDICATORS,
  HOSTED_CONNECTION_STATUS_TEXTS,
  type HostedConnectionStatusText,
} from "@ryco/client-runtime/authorization";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  classifyHostedStatus,
  createSettledHostedStatusTracker,
  DEFAULT_SETTLED_HOSTED_STATUS_THRESHOLD_MS,
  HOSTED_STATUS_SETTLEMENT,
  hostedSelectionKey,
  type SettledHostedStatusInput,
  type SettledHostedStatusTracker,
} from "./settledHostedStatus";

// No react-native, no store, no runtime: the step machine is a pure module, so
// this suite exercises it directly rather than through a screen it could not
// render anyway.

const THRESHOLD = DEFAULT_SETTLED_HOSTED_STATUS_THRESHOLD_MS;

function observation(
  statusText: HostedConnectionStatusText,
  selectionKey: string | null,
): SettledHostedStatusInput {
  return {
    statusText,
    indicator: HOSTED_CONNECTION_STATUS_INDICATORS[statusText],
    selectionKey,
  };
}

/**
 * Records every DISPLAYED value: the read after each observation plus every
 * threshold promotion. A "frame" here is what the owner would actually see, so
 * a strobe shows up as extra entries and a suppressed mandatory label shows up
 * as a missing one.
 */
function createRecorder(tracker: SettledHostedStatusTracker) {
  const frames: HostedConnectionStatusText[] = [tracker.read().statusText];
  const record = () => {
    const current = tracker.read().statusText;
    if (frames[frames.length - 1] !== current) frames.push(current);
  };
  const unsubscribe = tracker.subscribe(record);
  return {
    frames,
    observe: (statusText: HostedConnectionStatusText, selectionKey: string | null) => {
      tracker.update(observation(statusText, selectionKey));
      record();
    },
    unsubscribe,
  };
}

/** The seven step labels a `selectNode` walks the chip through, in order. */
const RETARGET_WALK = [
  "idle",
  "requesting ticket",
  "connecting",
  "authenticating",
  "opening channel",
  "online",
  "Securing",
] as const satisfies ReadonlyArray<HostedConnectionStatusText>;

let tracker: SettledHostedStatusTracker | null = null;

function makeTracker(thresholdMs = THRESHOLD): SettledHostedStatusTracker {
  tracker = createSettledHostedStatusTracker({ thresholdMs });
  return tracker;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  tracker?.dispose();
  tracker = null;
  vi.useRealTimers();
});

describe("hosted status settlement classification", () => {
  /**
   * Prevents the failure where a status added to the bounded vocabulary falls
   * through into "transient" by default and is then withheld from the owner for
   * the whole threshold — which, for an attention state, is the §13.1/§12.2
   * suppression this module exists to avoid.
   */
  it("classifies every status in the bounded vocabulary exactly once", () => {
    expect(Object.keys(HOSTED_STATUS_SETTLEMENT).sort()).toEqual(
      [...HOSTED_CONNECTION_STATUS_TEXTS].sort(),
    );
    for (const statusText of HOSTED_CONNECTION_STATUS_TEXTS) {
      expect(classifyHostedStatus(statusText)).toMatch(/^(settled|transient)$/);
    }
  });

  /**
   * Prevents a usable connection from being treated as a step and delayed, and
   * prevents a guarantee-bearing label from ever entering the pool of statuses
   * this module is allowed to withhold (§2.2: the claim is either true now or
   * not shown, never queued).
   */
  it("treats every connected status and every guarantee-bearing status as settled", () => {
    for (const statusText of HOSTED_CONNECTION_STATUS_TEXTS) {
      const indicator = HOSTED_CONNECTION_STATUS_INDICATORS[statusText];
      if (indicator.connected || indicator.guarantee !== "none") {
        expect(classifyHostedStatus(statusText)).toBe("settled");
      }
    }
  });

  /**
   * The attention states are the ones the owner must act on. Prevents a future
   * edit from reclassifying `Not verified` (§13.1's release gate) or a terminal
   * failure as a step, which would hide it behind the threshold.
   */
  it("treats the terminal and attention statuses as settled and the handshake steps as transient", () => {
    for (const statusText of [
      "Offline",
      "Stale",
      "Delivery unknown",
      "Authorization removed",
      "Revoked",
      "Device removed",
      "Incompatible",
      "Not verified",
      "terminal failure",
    ] as const) {
      expect(classifyHostedStatus(statusText)).toBe("settled");
    }
    for (const statusText of [
      ...RETARGET_WALK,
      "Checking access",
      "Synchronizing",
      "Reconnecting",
      "draining",
    ] as const) {
      expect(classifyHostedStatus(statusText)).toBe("transient");
    }
  });
});

describe("settled hosted status on a rapid re-target", () => {
  /**
   * The strobe this module exists to kill: switching hosted nodes walks the
   * chip Idle → Preparing → Connecting → Verifying → Opening → Not ready →
   * Securing in a few hundred milliseconds, which reads as noise rather than
   * progress.
   */
  it("collapses the seven-label handshake walk to a single visible step before it settles", async () => {
    const recorder = createRecorder(makeTracker());
    recorder.observe("Encrypted · Verified locally", "node-a env-a");

    for (const statusText of RETARGET_WALK) {
      recorder.observe(statusText, "node-b env-b");
      await vi.advanceTimersByTimeAsync(40);
    }
    recorder.observe("Encrypted · Verified locally", "node-b env-b");
    await vi.advanceTimersByTimeAsync(THRESHOLD * 2);

    // The placeholder, Encrypted(A), one demote frame, Encrypted(B) — the walk
    // itself contributes exactly one visible frame instead of seven.
    expect(recorder.frames).toEqual([
      "idle",
      "Encrypted · Verified locally",
      "idle",
      "Encrypted · Verified locally",
    ]);
  });

  /**
   * §2.2's overclaim: `Encrypted` describes a channel that has just been torn
   * down and a pin that has not been checked for the node now being connected.
   * Prevents a settling rule from "smoothing" it across the switch.
   */
  it("drops a guarantee-bearing label the instant a transient arrives for a new selection", async () => {
    const current = makeTracker();
    current.update(observation("Encrypted · Verified locally", "node-a env-a"));
    expect(current.read().statusText).toBe("Encrypted · Verified locally");

    current.update(observation("idle", "node-b env-b"));
    expect(current.read().statusText).toBe("idle");
    expect(current.read().indicator.guarantee).toBe("none");

    // And it stays gone for the whole handshake, not just for one frame.
    await vi.advanceTimersByTimeAsync(THRESHOLD);
    expect(current.read().indicator.guarantee).toBe("none");
  });

  /**
   * The same overclaim without a node switch: an `Encrypted` session that drops
   * back into `Securing` on the SAME node is a renegotiation, and the grace
   * window must not keep the claim on screen through it.
   */
  it("drops a guarantee-bearing label immediately even when the selection is unchanged", () => {
    const current = makeTracker();
    current.update(observation("Encrypted · Verified locally", "node-a env-a"));
    current.update(observation("Securing", "node-a env-a"));
    expect(current.read().statusText).toBe("Securing");
  });
});

describe("settled hosted status and mandatory claims", () => {
  /**
   * §13.1 and §12.2 make these labels mandatory on every user-facing surface.
   * Prevents the settling from queueing them behind a threshold, which is the
   * one way a presentation fix could turn into a protocol violation.
   */
  it("displays Not verified and Legacy at once, even mid-transition", () => {
    for (const mandatory of ["Not verified", "Legacy connection"] as const) {
      const current = createSettledHostedStatusTracker({ thresholdMs: THRESHOLD });
      current.update(observation("Encrypted · Verified locally", "node-a env-a"));
      current.update(observation("connecting", "node-b env-b"));
      current.update(observation("authenticating", "node-b env-b"));
      expect(current.read().statusText).toBe("connecting");

      current.update(observation(mandatory, "node-b env-b"));
      expect(current.read().statusText).toBe(mandatory);
      current.dispose();
    }
  });

  /**
   * A settled arrival is an outcome, so any transient still waiting for the
   * threshold is stale. Prevents the promotion from firing afterwards and
   * replacing a real result with a step label the connection has left behind.
   */
  it("cancels a pending promotion when a settled status arrives first", async () => {
    const recorder = createRecorder(makeTracker());
    recorder.observe("connecting", "node-a env-a");
    recorder.observe("authenticating", "node-a env-a");
    await vi.advanceTimersByTimeAsync(THRESHOLD - 50);
    recorder.observe("Encrypted · Verified locally", "node-a env-a");
    await vi.advanceTimersByTimeAsync(THRESHOLD * 2);

    expect(recorder.frames).toEqual(["idle", "connecting", "Encrypted · Verified locally"]);
  });
});

describe("settled hosted status on a slow handshake", () => {
  /**
   * The other half of the bargain: settling may not lie about a connection that
   * is genuinely stuck. Prevents a fix that simply suppresses transients, which
   * would leave a hung handshake looking like a healthy connection.
   */
  it("displays a transient that stays current past the threshold and notifies subscribers", async () => {
    const current = makeTracker();
    const notifications: HostedConnectionStatusText[] = [];
    current.subscribe(() => notifications.push(current.read().statusText));

    current.update(observation("connecting", "node-a env-a"));
    current.update(observation("authenticating", "node-a env-a"));
    expect(current.read().statusText).toBe("connecting");

    await vi.advanceTimersByTimeAsync(THRESHOLD);
    expect(current.read().statusText).toBe("authenticating");
    // The promotion has no render of its own — nothing else would repaint it.
    expect(notifications).toEqual(["authenticating"]);
  });

  /**
   * Prevents the timer from being re-armed by every identical store tick: a
   * handshake that reports `authenticating` on a heartbeat would then never
   * cross the threshold and the chip would sit on a stale step forever.
   */
  it("keeps the armed threshold running while the same transient repeats", async () => {
    const current = makeTracker();
    current.update(observation("connecting", "node-a env-a"));
    current.update(observation("authenticating", "node-a env-a"));

    for (let elapsed = 0; elapsed < THRESHOLD; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
      current.update(observation("authenticating", "node-a env-a"));
    }
    expect(current.read().statusText).toBe("authenticating");
  });
});

describe("settled hosted status on a same-node blip", () => {
  /**
   * A brief reconnect on the node already on screen: nothing about the
   * selection changed and no claim is at stake, so the owner should never see
   * the chip twitch.
   */
  it("shows no transient at all for a sub-threshold blip on the current selection", async () => {
    const recorder = createRecorder(makeTracker());
    recorder.observe("Online", "node-a env-a");
    recorder.observe("Reconnecting", "node-a env-a");
    await vi.advanceTimersByTimeAsync(THRESHOLD - 100);
    recorder.observe("Online", "node-a env-a");
    await vi.advanceTimersByTimeAsync(THRESHOLD * 2);

    expect(recorder.frames).toEqual(["idle", "Online"]);
  });

  /**
   * The grace window is a hold, not a suppression: a blip that outlasts it has
   * to surface, or a node that quietly went away would still read `Online`.
   */
  it("gives up the held status once the blip outlasts the grace window", async () => {
    const recorder = createRecorder(makeTracker());
    recorder.observe("Online", "node-a env-a");
    recorder.observe("Reconnecting", "node-a env-a");
    await vi.advanceTimersByTimeAsync(THRESHOLD);

    expect(recorder.frames).toEqual(["idle", "Online", "Reconnecting"]);
  });

  /**
   * A claim-free settled label still belongs to a selection. Prevents `Online`
   * from being held over the first frames of a DIFFERENT node's handshake,
   * where it would report a connection that no longer exists.
   */
  it("never holds a settled label across a change of selection", () => {
    const current = makeTracker();
    current.update(observation("Online", "node-a env-a"));
    current.update(observation("requesting ticket", "node-b env-b"));
    expect(current.read().statusText).toBe("requesting ticket");
  });
});

describe("settled hosted status plumbing", () => {
  /**
   * The tracker must be honest on first paint: withholding the very first
   * observation would render the placeholder instead of the real state.
   */
  it("displays the first observation immediately, settled or not", () => {
    const current = makeTracker();
    current.update(observation("authenticating", "node-a env-a"));
    expect(current.read().statusText).toBe("authenticating");
  });

  /**
   * The indicator and the full text are one claim rendered twice (chip label
   * and accessible name). Prevents them from being settled independently, which
   * would let the chip read `Encrypted` beside the text `Securing`.
   */
  it("settles the indicator and the status text as one pair", async () => {
    const current = makeTracker();
    current.update(observation("Encrypted · Verified locally", "node-a env-a"));
    current.update(observation("connecting", "node-b env-b"));
    current.update(observation("authenticating", "node-b env-b"));
    await vi.advanceTimersByTimeAsync(THRESHOLD);

    const settled = current.read();
    expect(settled.indicator).toBe(HOSTED_CONNECTION_STATUS_INDICATORS[settled.statusText]);
    expect(settled.indicator.shortLabel).toBe("Verifying");
    // `Verifying` is the TRANSPORT `authenticating` label, not an E2EE state —
    // the same pair the shared derivation produces, unaltered.
    expect(settled.indicator).toBe(
      deriveHostedConnectionStatusIndicator({
        browserStatus: "current",
        sessionStatus: "synchronizing",
        selectionStatus: "online",
        transportStatus: "authenticating",
        e2eeStatus: "negotiating",
      }),
    );
  });

  /**
   * The timers are injected so a host with its own scheduler (or a test) drives
   * promotion deterministically. Prevents the module from silently reaching for
   * a global timer.
   */
  it("uses the injected timers rather than the global ones", () => {
    const scheduled: Array<{ readonly handler: () => void; readonly ms: number }> = [];
    let cleared = 0;
    const current = createSettledHostedStatusTracker({
      thresholdMs: 250,
      timers: {
        setTimeout: (handler, ms) => {
          scheduled.push({ handler, ms });
          return scheduled.length as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: () => {
          cleared += 1;
        },
      },
    });

    current.update(observation("connecting", "node-a env-a"));
    current.update(observation("authenticating", "node-a env-a"));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(250);

    // A different transient re-arms, and re-arming cancels through the same
    // seam rather than leaking the old handle.
    current.update(observation("opening channel", "node-a env-a"));
    expect(scheduled).toHaveLength(2);
    expect(cleared).toBe(1);

    scheduled[1]?.handler();
    expect(current.read().statusText).toBe("opening channel");

    current.dispose();
  });

  /**
   * A promotion firing after the surface unmounted would call back into a dead
   * subscriber. Prevents a disposed tracker from moving or notifying.
   */
  it("stops promoting and notifying once disposed", async () => {
    const current = makeTracker();
    const notifications: string[] = [];
    current.subscribe(() => notifications.push(current.read().statusText));
    current.update(observation("connecting", "node-a env-a"));
    current.update(observation("authenticating", "node-a env-a"));
    current.dispose();

    await vi.advanceTimersByTimeAsync(THRESHOLD * 2);
    expect(current.read().statusText).toBe("connecting");
    expect(notifications).toEqual([]);
  });

  /**
   * The key is the selection's identity, and both halves matter: a node
   * re-enrolled under a new environment is a different connection, and holding
   * the old node's status over it would be the stale-claim bug.
   */
  it("keys a selection on the node id and the environment id together", () => {
    expect(hostedSelectionKey(null)).toBeNull();
    expect(hostedSelectionKey({ id: "node-a", environmentId: "env-1" })).not.toBe(
      hostedSelectionKey({ id: "node-a", environmentId: "env-2" }),
    );
    expect(hostedSelectionKey({ id: "node-a", environmentId: "env-1" })).toBe(
      hostedSelectionKey({ id: "node-a", environmentId: "env-1" }),
    );
  });
});
