/**
 * Live pane input for one device frame socket.
 *
 * The pane streams touch phases, keys and pastes over its frame socket
 * (`@ryco/shared/deviceLiveInput`). This turns them into manager calls, one at
 * a time and in arrival order, so a key typed after a tap can never overtake
 * it, and a paste lands between the keys typed around it.
 *
 * What it guarantees:
 *
 * - Moves coalesce. A move still waiting behind a slower injection is
 *   replaced by the newer one, so a helper that falls behind skips stale
 *   positions instead of replaying a backlog. Down, up, keys and pastes are
 *   never dropped or merged.
 * - A paste arrives in chunks and is pasted whole once its last chunk is in,
 *   so a socket that drops mid-paste pastes nothing rather than a prefix.
 * - A gesture belongs to the boot it started on. Its later phases are dropped
 *   once the device reboots, shuts down or its host disconnects
 *   (`DeviceManager.inputFence`), so they cannot land on a newer boot.
 * - A failed gesture is not replayed. The backend already retried what the
 *   helper says sent nothing (`helperInputErrors.ts`); anything that still
 *   fails is reported once, the finger is lifted where it was, and the rest of
 *   that gesture is dropped until the next down.
 * - Nothing stays pressed. Closing the socket, a new down without an up, or a
 *   failed phase lifts the finger, and closing releases every held key.
 *
 * @module device/deviceInputSession
 */
import {
  DEVICE_LIVE_PASTE_MAX_LENGTH,
  type DeviceLiveInput,
  type DeviceLiveInputKind,
} from "@ryco/shared/deviceLiveInput";

import type { DeviceKeyEvent, DeviceTouchPhase } from "./DeviceBackend.ts";

/** The manager calls a session needs; `DeviceManager` provides them. */
export interface DeviceInputTarget {
  touch(udid: string, phase: DeviceTouchPhase, x: number, y: number): Promise<void>;
  keyEvent(udid: string, event: DeviceKeyEvent): Promise<void>;
  paste(udid: string, text: string): Promise<void>;
  inputFence(udid: string): () => boolean;
}

export interface DeviceInputSession {
  readonly push: (input: DeviceLiveInput) => void;
  /** Drops queued input, lifts the finger, releases held keys. Idempotent. */
  readonly close: () => Promise<void>;
}

/**
 * Bounded so a client that floods the socket cannot grow server memory. Moves
 * coalesce, so this only fills with keys and pastes sent faster than the
 * simulator takes them.
 */
export const DEVICE_INPUT_QUEUE_LIMIT = 512;

type Touch = Extract<DeviceLiveInput, { type: "device.touch" }>;
type Key = Extract<DeviceLiveInput, { type: "device.key" }>;
/** What waits in the queue: touches and keys as sent, pastes once complete. */
type Queued = Touch | Key | { readonly type: "paste"; readonly text: string };

type Gesture = {
  readonly current: () => boolean;
  x: number;
  y: number;
};

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message.trim() ? error.message.trim() : String(error);

export function createDeviceInputSession(options: {
  readonly udid: string;
  readonly target: DeviceInputTarget;
  readonly report: (input: DeviceLiveInputKind, message: string) => void;
  readonly queueLimit?: number;
}): DeviceInputSession {
  const { udid, target, report } = options;
  const queueLimit = options.queueLimit ?? DEVICE_INPUT_QUEUE_LIMIT;
  const queue: Queued[] = [];
  const heldKeys = new Set<number>();
  let gesture: Gesture | null = null;
  /** The paste being received, until its last chunk. */
  let pending: { group: number; text: string; rejected: boolean } | null = null;
  let draining: Promise<void> | null = null;
  let closed = false;
  let overflowReported = false;

  /** Lift the finger where it is, quietly: a second failure says nothing new. */
  const liftQuietly = async (lifted: Gesture) => {
    if (!lifted.current()) return;
    await target.touch(udid, "up", lifted.x, lifted.y).catch(() => undefined);
  };

  const runTouch = async (input: Touch) => {
    if (input.phase === "down") {
      // A down without an up ends the previous gesture first.
      const previous = gesture;
      gesture = null;
      if (previous) await liftQuietly(previous);
      const next: Gesture = { current: target.inputFence(udid), x: input.x, y: input.y };
      try {
        await target.touch(udid, "down", input.x, input.y);
        gesture = next;
      } catch (error) {
        report("touch", messageOf(error));
        await liftQuietly(next);
      }
      return;
    }
    const active = gesture;
    // No gesture: it never started, already failed, or was lifted for it.
    if (!active) return;
    if (!active.current()) {
      gesture = null;
      return;
    }
    active.x = input.x;
    active.y = input.y;
    if (input.phase === "up") gesture = null;
    try {
      await target.touch(udid, input.phase, input.x, input.y);
    } catch (error) {
      gesture = null;
      report("touch", messageOf(error));
      if (input.phase === "move") await liftQuietly(active);
    }
  };

  const runKey = async (input: Key) => {
    if (input.phase === "down") heldKeys.add(input.usage);
    else heldKeys.delete(input.usage);
    try {
      await target.keyEvent(udid, { keyCode: input.usage, modifiers: [], direction: input.phase });
    } catch (error) {
      report("key", messageOf(error));
    }
  };

  const runPaste = async (text: string) => {
    try {
      await target.paste(udid, text);
    } catch (error) {
      report("paste", messageOf(error));
    }
  };

  const isClosed = () => closed;
  const drain = async () => {
    let input = queue.shift();
    while (input && !isClosed()) {
      if (input.type === "device.touch") await runTouch(input);
      else if (input.type === "device.key") await runKey(input);
      else await runPaste(input.text);
      input = queue.shift();
    }
  };

  const kick = () => {
    if (draining || closed) return;
    draining = drain().finally(() => {
      draining = null;
      if (queue.length > 0) kick();
    });
  };

  const enqueue = (item: Queued, kind: DeviceLiveInputKind) => {
    // A release is never dropped: losing it would leave a key or finger down
    // on the device. Releases follow presses, so they cannot grow unbounded.
    const release = item.type !== "paste" && item.phase === "up";
    if (queue.length >= queueLimit && !release) {
      if (!overflowReported) {
        overflowReported = true;
        report(kind, "Input arrived faster than the simulator accepts it; some of it was dropped.");
      }
      return;
    }
    queue.push(item);
    kick();
  };

  return {
    push: (input) => {
      if (closed) return;
      if (input.type === "device.paste") {
        if (pending?.group !== input.group) {
          pending = { group: input.group, text: "", rejected: false };
        }
        const paste = pending;
        if (!paste.rejected) {
          paste.text += input.text;
          if (paste.text.length > DEVICE_LIVE_PASTE_MAX_LENGTH) {
            // The rest of this group is ignored; nothing of it is pasted.
            paste.rejected = true;
            paste.text = "";
            report("paste", "The pasted text is too long for the device.");
          }
        }
        if (!input.final) return;
        pending = null;
        if (!paste.rejected && paste.text.length > 0) {
          enqueue({ type: "paste", text: paste.text }, "paste");
        }
        return;
      }
      if (input.type === "device.touch" && input.phase === "move") {
        const last = queue.at(-1);
        if (last?.type === "device.touch" && last.phase === "move") {
          queue[queue.length - 1] = input;
          return;
        }
      }
      enqueue(input, input.type === "device.touch" ? "touch" : "key");
    },
    close: async () => {
      if (closed) {
        await draining;
        return;
      }
      closed = true;
      queue.length = 0;
      // Let the injection in flight finish before lifting, so the release
      // cannot overtake it and leave a finger down.
      await draining;
      const active = gesture;
      gesture = null;
      if (active) await liftQuietly(active);
      for (const usage of heldKeys) {
        await target
          .keyEvent(udid, { keyCode: usage, modifiers: [], direction: "up" })
          .catch(() => undefined);
      }
      heldKeys.clear();
    },
  };
}
