import type { DesktopQuitShortcutMode } from "@ryco/contracts";

export const QUIT_DOUBLE_PRESS_MS = 1500;
export const QUIT_HOLD_MS = 1000;
export type QuitShortcutFeedback = "press-twice" | "hold" | null;

export function isQuitShortcutChord(
  input: { key: string; control: boolean; meta: boolean; alt: boolean; shift: boolean },
  mac: boolean,
): boolean {
  return (
    input.key.toLowerCase() === "q" &&
    (mac ? input.meta && !input.control : input.control && !input.meta) &&
    !input.alt &&
    !input.shift
  );
}

/** Owns one focused window's gesture. Key repeat never counts as a second press. */
export function createQuitShortcutGuard(options: {
  mode: () => DesktopQuitShortcutMode;
  mac: boolean;
  now?: () => number;
  quit: () => void;
  feedback: (state: QuitShortcutFeedback) => void;
}) {
  const now = options.now ?? (() => performance.now());
  let pressedAt: number | null = null;
  let firstPress: number | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    pressedAt = null;
    firstPress = null;
    clearTimeout(timeout);
    options.feedback(null);
  };
  return {
    reset,
    input(input: {
      type: string;
      key: string;
      control: boolean;
      meta: boolean;
      alt: boolean;
      shift: boolean;
      isAutoRepeat: boolean;
    }): boolean {
      const q = input.key.toLowerCase() === "q";
      const modifier = options.mac ? input.meta && !input.control : input.control && !input.meta;
      const chord = isQuitShortcutChord(input, options.mac);
      if (input.type === "keyUp") {
        if (q && pressedAt !== null) {
          const held = now() - pressedAt;
          pressedAt = null;
          if (options.mode() === "hold") {
            reset();
            if (chord && held >= QUIT_HOLD_MS) options.quit();
          }
          return true;
        }
        if (!modifier && pressedAt !== null) {
          const held = now() - pressedAt;
          pressedAt = null;
          if (options.mode() === "hold") {
            reset();
            if ((input.key === "Meta" || input.key === "Control") && held >= QUIT_HOLD_MS)
              options.quit();
          }
        }
        return false;
      }
      if (input.type !== "keyDown") return false;
      if (!chord) {
        if (q || input.alt || input.shift || (!modifier && pressedAt !== null)) reset();
        return false;
      }
      if (input.isAutoRepeat || pressedAt !== null) return true;
      pressedAt = now();
      const mode = options.mode();
      if (mode === "immediately") {
        reset();
        options.quit();
        return true;
      }
      if (mode === "hold") {
        options.feedback("hold");
        return true;
      }
      if (firstPress !== null && pressedAt - firstPress <= QUIT_DOUBLE_PRESS_MS) {
        reset();
        options.quit();
        return true;
      }
      firstPress = pressedAt;
      options.feedback("press-twice");
      clearTimeout(timeout);
      timeout = setTimeout(reset, QUIT_DOUBLE_PRESS_MS);
      return true;
    },
  };
}
