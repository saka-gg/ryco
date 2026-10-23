import type { ThreadAlertSound } from "@ryco/client-runtime/state/settings";

/** The part of an `AudioContext` the chimes use. */
export type ThreadAlertAudioContext = Pick<
  AudioContext,
  | "state"
  | "currentTime"
  | "destination"
  | "resume"
  | "close"
  | "createOscillator"
  | "createGain"
  | "addEventListener"
  | "removeEventListener"
>;

interface ChimeNote {
  readonly frequency: number;
  /** Seconds after the chime starts. */
  readonly at: number;
  readonly duration: number;
}

interface Chime {
  readonly wave: OscillatorType;
  readonly notes: ReadonlyArray<ChimeNote>;
}

/**
 * Synthesized, so no audio file ships or loads: a rising pair of notes when a
 * thread finishes, and a repeated higher note when one needs you.
 */
const CHIMES: Readonly<Record<ThreadAlertSound, Chime>> = {
  completion: {
    wave: "sine",
    notes: [
      { frequency: 659.25, at: 0, duration: 0.16 },
      { frequency: 987.77, at: 0.1, duration: 0.34 },
    ],
  },
  attention: {
    wave: "triangle",
    notes: [
      { frequency: 880, at: 0, duration: 0.12 },
      { frequency: 880, at: 0.17, duration: 0.22 },
    ],
  },
};

const PEAK_GAIN = 0.16;
const SILENT_GAIN = 0.0001;
const ATTACK_SECONDS = 0.01;
const UNLOCK_EVENTS = ["pointerdown", "keydown"] as const;

/** Schedules `chime` from now and returns the context time it ends at. */
function scheduleChime(context: ThreadAlertAudioContext, chime: Chime): number {
  const start = context.currentTime;
  let end = start;
  for (const note of chime.notes) {
    const at = start + note.at;
    const stop = at + note.duration;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = chime.wave;
    oscillator.frequency.setValueAtTime(note.frequency, at);
    envelope.gain.setValueAtTime(SILENT_GAIN, at);
    envelope.gain.exponentialRampToValueAtTime(PEAK_GAIN, at + ATTACK_SECONDS);
    envelope.gain.exponentialRampToValueAtTime(SILENT_GAIN, stop);
    oscillator.connect(envelope).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(stop);
    end = Math.max(end, stop);
  }
  return end;
}

export interface ThreadAlertSoundPlayer {
  /**
   * Plays `sound` unless a chime is still sounding, so a burst of alerts
   * chimes once. `shouldPlay` is asked last, right before the chime starts.
   */
  readonly play: (sound: ThreadAlertSound, shouldPlay: () => boolean) => void;
  readonly dispose: () => void;
}

/**
 * Browsers start audio only after a user gesture. The context is created, or
 * resumed, on a pointer or key press, and listening stops while it runs. A
 * page that already had a gesture gets a running context at once. An alert
 * that arrives while audio is locked stays silent rather than chiming late.
 */
export function createThreadAlertSoundPlayer(input: {
  readonly createAudioContext: () => ThreadAlertAudioContext | null;
  readonly gestureTarget: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** The page has had a user gesture, so a new context may start without one. */
  readonly hasUserActivation: () => boolean;
}): ThreadAlertSoundPlayer {
  let context: ThreadAlertAudioContext | null = null;
  let listening = false;
  let playingUntil = 0;
  let disposed = false;

  const setListening = (next: boolean) => {
    if (listening === next) return;
    listening = next;
    for (const type of UNLOCK_EVENTS) {
      if (next)
        input.gestureTarget.addEventListener(type, unlock, { capture: true, passive: true });
      else input.gestureTarget.removeEventListener(type, unlock, { capture: true });
    }
  };
  // The context can also be suspended later (Safari interrupts it), which
  // waits for the next gesture again.
  const onStateChange = () => {
    if (!disposed) setListening(context?.state !== "running");
  };
  const ensureContext = () => {
    if (context !== null) return context;
    try {
      context = input.createAudioContext();
    } catch {
      context = null;
    }
    context?.addEventListener("statechange", onStateChange);
    return context;
  };
  function unlock() {
    const current = ensureContext();
    if (current === null || current.state === "running") {
      setListening(false);
      return;
    }
    current.resume().catch(() => undefined);
  }

  const initial = input.hasUserActivation() ? ensureContext() : null;
  setListening(initial?.state !== "running");

  return {
    play: (sound, shouldPlay) => {
      if (disposed || context?.state !== "running") return;
      if (context.currentTime < playingUntil || !shouldPlay()) return;
      try {
        playingUntil = scheduleChime(context, CHIMES[sound]);
      } catch (error) {
        console.warn("Thread alert sound failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      setListening(false);
      context?.removeEventListener("statechange", onStateChange);
      context?.close().catch(() => undefined);
      context = null;
    },
  };
}
