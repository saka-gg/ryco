// Paste chunking follows t3code's device stream (MIT); see THIRD_PARTY_NOTICES.md.
import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import type {
  DeviceDescriptor,
  DeviceKeyModifier,
  DeviceUdid,
  EnvironmentApi,
  EnvironmentId,
} from "@ryco/contracts";
import { DEVICE_LIVE_PASTE_MAX_LENGTH, chunkDeviceLiveText } from "@ryco/shared/deviceLiveInput";
import { useCallback, useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { toastManager } from "../ui/toast";
import { deviceHidUsageForCode, deviceHidUsageForKey } from "./deviceFrameGate";
import type { DeviceLiveInputChannel } from "./useDeviceVideoStream";

type DeviceApi = NonNullable<EnvironmentApi["device"]>;

/** The type-text RPC's bound; longer pastes go out in several calls. */
const RPC_TEXT_CHUNK_LENGTH = 4_096;

function modifiers(event: KeyboardEvent): DeviceKeyModifier[] {
  const result: DeviceKeyModifier[] = [];
  if (event.metaKey) result.push("command");
  if (event.shiftKey) result.push("shift");
  if (event.altKey) result.push("option");
  if (event.ctrlKey) result.push("control");
  return result;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

let pasteGroups = 0;
/** A new id for one paste's chunks; distinct across panes in this tab. */
function nextPasteGroup(): number {
  pasteGroups += 1;
  return pasteGroups;
}

/**
 * Keyboard and paste for the device canvas.
 *
 * iOS with live input sends each physical key down and up, modifiers
 * included, over the frame socket in order with touches. Without live input
 * iOS keys use the key-event RPC as before. Android emits whole key presses
 * and text through a queue fenced to the attachment, unchanged.
 *
 * Paste hands the clipboard's text to the device's paste (its pasteboard and
 * Command-V on iOS, so any Unicode lands exactly whatever the guest layout):
 * in chunks over the live channel, pasted once the last one arrives, or
 * through the paste RPC. Servers without it get the text typed instead.
 */
export function useDeviceKeyboardInput(options: {
  readonly api: DeviceApi | undefined;
  readonly attached: DeviceDescriptor | null;
  readonly environmentId: EnvironmentId | null;
  readonly threadKey: string | null;
  readonly generation: number;
  readonly live: DeviceLiveInputChannel | null;
  /** True while the preview is paused: keys then only resume it. */
  readonly previewPaused: boolean;
  readonly noteInteraction: () => void;
}) {
  const { api, attached, environmentId, threadKey, generation, live, previewPaused } = options;
  const { noteInteraction } = options;

  const keyboardTail = useRef<Promise<void>>(Promise.resolve());
  const keyboardScope = useRef<{ active: boolean; pending: number } | null>(null);
  useEffect(() => {
    const scope = { active: true, pending: 0 };
    keyboardTail.current = Promise.resolve();
    keyboardScope.current = scope;
    return () => {
      scope.active = false;
    };
  }, [api, generation, threadKey, attached?.udid]);

  // Keys whose press found the preview paused. They only resume it: the frame on
  // screen is stale, so neither the press nor its release may act on the device.
  const resumingKeys = useRef(new Set<string>());
  const noteKeyInteraction = useCallback(
    (event: KeyboardEvent) => {
      if (!event.repeat) {
        if (previewPaused) resumingKeys.current.add(event.code);
        else resumingKeys.current.delete(event.code);
      }
      noteInteraction();
    },
    [noteInteraction, previewPaused],
  );

  // Keys the live path holds down on the device, by physical key, so each
  // comes up as what went down and nothing stays held when focus leaves.
  const heldKeys = useRef(new Map<string, number>());
  const heldScope = useRef<string | null>(null);
  const liveScope = live?.ready && attached ? attached.udid : null;
  // Focus can leave mid-press, and then no key-up arrives here.
  useEffect(() => {
    const release = () => {
      if (live?.ready) {
        for (const usage of heldKeys.current.values()) {
          live.send({ type: "device.key", usage, phase: "up" });
        }
      }
      heldKeys.current.clear();
    };
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, [live]);

  /**
   * The live path: every key by its physical position, modifiers included,
   * so the device's own layout decides the character (see
   * `deviceHidUsageForCode`). iOS repeats a held key itself.
   */
  const liveKey = useCallback(
    (event: KeyboardEvent<HTMLCanvasElement>, direction: "down" | "up"): boolean => {
      if (!live?.ready || attached?.platform !== "ios-simulator") return false;
      if (heldScope.current !== liveScope) {
        heldScope.current = liveScope;
        heldKeys.current.clear();
      }
      const usage = deviceHidUsageForCode(event.code);
      if (usage === null) return false;
      event.preventDefault();
      if (direction === "down") {
        if (event.repeat || heldKeys.current.has(event.code)) return true;
        heldKeys.current.set(event.code, usage);
      } else {
        if (!heldKeys.current.has(event.code)) return true;
        heldKeys.current.delete(event.code);
      }
      live.send({ type: "device.key", usage, phase: direction });
      return true;
    },
    [attached?.platform, live, liveScope],
  );

  const onKey = useCallback(
    (event: KeyboardEvent<HTMLCanvasElement>, direction: "down" | "up") => {
      if (!attached || !api) return;
      if (resumingKeys.current.has(event.code)) {
        event.preventDefault();
        if (direction === "up") resumingKeys.current.delete(event.code);
        return;
      }
      // Command chords belong to the host (copy, paste, shortcuts); a held
      // key's release always goes through so it cannot stay down.
      if (event.metaKey && !(direction === "up" && heldKeys.current.has(event.code))) return;
      if (liveKey(event, direction)) return;
      if (event.ctrlKey) return;
      const text =
        attached.platform === "android-emulator" && event.key.length === 1 ? event.key : null;
      const keyCode = deviceHidUsageForKey(event.key);
      if (text === null && keyCode === null) return;
      event.preventDefault();
      if (attached.platform !== "android-emulator") {
        void api
          .keyEvent({
            udid: attached.udid,
            keyCode: keyCode!,
            modifiers: modifiers(event),
            direction,
          })
          .catch(() => undefined);
        return;
      }
      // Android emits complete key presses, so key-up has no work to queue.
      if (direction === "up") return;
      const scope = keyboardScope.current;
      if (!scope?.active || scope.pending >= 64) return;
      scope.pending++;
      const udid = attached.udid;
      const keyModifiers = modifiers(event);
      keyboardTail.current = keyboardTail.current
        .then(async () => {
          const state = useDeviceStateStore.getState();
          if (
            !scope?.active ||
            !environmentId ||
            !threadKey ||
            state.environmentById[environmentId]?.generation !== generation ||
            state.environmentById[environmentId]?.status !== "connected" ||
            state.threadByKey[threadKey]?.attachedDeviceUdid !== udid ||
            readEnvironmentApi(environmentId)?.device !== api
          )
            return;
          await (text !== null
            ? api.typeText({ udid, text })
            : api.keyEvent({ udid, keyCode: keyCode!, modifiers: keyModifiers, direction }));
        })
        .catch((error) => {
          if (scope?.active) {
            // A failed target must not replay the queued suffix onto a new device.
            // Reattachment or a new connection creates a fresh input scope.
            scope.active = false;
            toastManager.add({
              type: "error",
              title: "Android keyboard input failed",
              description: errorMessage(error, "The input could not be delivered."),
            });
          }
        })
        .finally(() => {
          scope.pending--;
        });
    },
    [api, attached, environmentId, generation, liveKey, threadKey],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLCanvasElement>) => {
      if (!attached || !api) return;
      const raw = event.clipboardData.getData("text/plain");
      if (!raw) return;
      event.preventDefault();
      noteInteraction();
      if (previewPaused) return;
      const text = raw.slice(0, DEVICE_LIVE_PASTE_MAX_LENGTH);
      if (text.length < raw.length) {
        toastManager.add({
          type: "info",
          title: "Pasted the first part only",
          description: `The device received the first ${text.length.toLocaleString()} characters.`,
        });
      }
      if (live?.ready && attached.platform === "ios-simulator") {
        const group = nextPasteGroup();
        const chunks = chunkDeviceLiveText(text);
        chunks.forEach((chunk, index) => {
          live.send({
            type: "device.paste",
            text: chunk,
            group,
            final: index === chunks.length - 1,
          });
        });
        return;
      }
      const udid: DeviceUdid = attached.udid;
      const paste = api.paste;
      void (async () => {
        if (paste) {
          await paste({ udid, text });
          return;
        }
        for (const chunk of chunkDeviceLiveText(text, RPC_TEXT_CHUNK_LENGTH)) {
          await api.typeText({ udid, text: chunk });
        }
      })().catch((error) =>
        toastManager.add({
          type: "error",
          title: "Paste failed",
          description: errorMessage(error, "The text could not be typed."),
        }),
      );
    },
    [api, attached, live, noteInteraction, previewPaused],
  );

  return {
    onKeyDown: (event: KeyboardEvent<HTMLCanvasElement>) => onKey(event, "down"),
    onKeyUp: (event: KeyboardEvent<HTMLCanvasElement>) => onKey(event, "up"),
    onPaste,
    noteKeyInteraction,
  };
}
