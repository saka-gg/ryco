import { describe, expect, it, vi } from "vite-plus/test";

import { createThreadAlertSoundPlayer, type ThreadAlertAudioContext } from "./threadAlertSound";

/** An audio context that records the notes it is asked to play. */
function fakeAudioContext(initialState: AudioContextState) {
  const stateListeners = new Set<() => void>();
  const notes: number[] = [];
  const setState = (state: AudioContextState) => {
    audio.state = state;
    for (const listener of Array.from(stateListeners)) listener();
  };
  const param = { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined };
  const audio = {
    state: initialState,
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => setState("running")),
    close: vi.fn(async () => setState("closed")),
    createOscillator: () => ({
      type: "sine",
      frequency: { setValueAtTime: (frequency: number) => notes.push(frequency) },
      connect: (node: unknown) => node,
      start: () => undefined,
      stop: () => undefined,
    }),
    createGain: () => ({ gain: param, connect: (node: unknown) => node }),
    addEventListener: (_type: string, listener: () => void) => stateListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => stateListeners.delete(listener),
  };
  return { audio, context: audio as unknown as ThreadAlertAudioContext, notes, setState };
}

function player(input: { readonly state: AudioContextState; readonly activated: boolean }) {
  const fake = fakeAudioContext(input.state);
  const gestureTarget = new EventTarget();
  const createAudioContext = vi.fn(() => fake.context);
  const sound = createThreadAlertSoundPlayer({
    createAudioContext,
    gestureTarget,
    hasUserActivation: () => input.activated,
  });
  const gesture = async () => {
    gestureTarget.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
  };
  return { ...fake, sound, gesture, createAudioContext };
}

describe("thread alert sound", () => {
  it("stays silent until a gesture unlocks audio, then stops listening", async () => {
    const test = player({ state: "suspended", activated: false });
    const shouldPlay = vi.fn(() => true);
    test.sound.play("completion", shouldPlay);
    expect(test.createAudioContext).not.toHaveBeenCalled();
    expect(shouldPlay).not.toHaveBeenCalled();

    await test.gesture();
    expect(test.audio.state).toBe("running");
    test.sound.play("completion", shouldPlay);
    expect(test.notes.length).toBeGreaterThan(0);

    await test.gesture();
    expect(test.createAudioContext).toHaveBeenCalledTimes(1);
    expect(test.audio.resume).toHaveBeenCalledTimes(1);
  });

  it("starts at once on a page that already had a gesture", () => {
    const test = player({ state: "running", activated: true });
    test.sound.play("attention", () => true);
    expect(test.notes).toEqual([880, 880]);
  });

  it("chimes once for a burst of alerts", () => {
    const test = player({ state: "running", activated: true });
    test.sound.play("completion", () => true);
    const chime = test.notes.length;
    test.sound.play("attention", () => true);
    expect(test.notes).toHaveLength(chime);

    test.audio.currentTime = 1;
    test.sound.play("attention", () => true);
    expect(test.notes.length).toBeGreaterThan(chime);
  });

  it("asks whether the alert still matters right before chiming", () => {
    const test = player({ state: "running", activated: true });
    test.sound.play("completion", () => false);
    expect(test.notes).toEqual([]);
    test.sound.play("completion", () => true);
    expect(test.notes.length).toBeGreaterThan(0);
  });

  it("waits for another gesture when the browser suspends audio", async () => {
    const test = player({ state: "running", activated: true });
    test.setState("suspended");
    test.sound.play("completion", () => true);
    expect(test.notes).toEqual([]);

    await test.gesture();
    expect(test.audio.resume).toHaveBeenCalledTimes(1);
    test.sound.play("completion", () => true);
    expect(test.notes.length).toBeGreaterThan(0);
  });

  it("closes audio and stops listening when disposed", async () => {
    const test = player({ state: "suspended", activated: true });
    test.sound.dispose();
    expect(test.audio.close).toHaveBeenCalledTimes(1);

    await test.gesture();
    expect(test.audio.resume).not.toHaveBeenCalled();
    test.sound.play("completion", () => true);
    expect(test.notes).toEqual([]);
  });
});
