/**
 * The refusals and messages `ComputerManager` raises for targets and capabilities it cannot serve.
 */
import { ComputerPoint, type ComputerHealth, type ComputerWindow } from "@ryco/contracts";
import { clampComputerMessage, ComputerBackendError } from "./ComputerBackend.ts";
import { ComputerTargetError } from "./uiTreeTargeting.ts";

/**
 * Why a healthy-looking availability is being withheld. The failure text comes
 * from the display server, so the whole message is clamped rather than only the
 * part this composes.
 */
export function healthUnavailableMessage(health: ComputerHealth): string {
  const reason =
    health.status === "reconnecting"
      ? "Reconnecting to the desktop."
      : "The desktop backend is not connected.";
  return clampComputerMessage(
    health.lastFailure ? `${reason} Last failure: ${health.lastFailure.message}` : reason,
    reason,
  );
}

export function windowNotFoundError(windowId: string): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_not_found",
    message:
      `No desktop window has id ${JSON.stringify(windowId)}. ` +
      "Call computer_list_windows for the current window ids.",
    notFound: true,
  });
}

/**
 * Refusal for an app-named menu target the running inventory does not know.
 * The name may be a bundle id or a display name, so the message names both
 * spellings the caller can check against computer_list_apps.
 */
export function menuAppNotFoundError(app: string): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_not_found",
    message:
      `No running application matches ${JSON.stringify(app)}. ` +
      "Call computer_list_apps for the running apps and their pids, then name one by app or pid.",
    notFound: true,
  });
}

/**
 * Refusal for a scoped action whose window is covered at the point and could
 * not be raised out from under the windows covering it.
 *
 * Refusing beats warning. The input would land in another application, and a
 * warning read after the fact cannot undo a click that already fired — the live
 * failure this exists for was a model clicking a buried window repeatedly and
 * concluding the button was broken. The message names what is in the way and
 * both ways out, so the next call is a correct one rather than a retry.
 */
export function occludedTargetError(
  windowId: string,
  point: ComputerPoint,
  covering: readonly ComputerWindow[],
  reason: string,
): ComputerTargetError {
  const blockers = covering
    .slice(0, 4)
    .map((window) => `${JSON.stringify(window.title || window.id)} (${window.id})`)
    .join(", ");
  return new ComputerTargetError({
    code: "computer_target_occluded",
    message:
      `Window ${JSON.stringify(windowId)} is covered at (${point.x}, ${point.y}) by ${blockers}, ` +
      `and this desktop could not raise it: ${reason}. The input would go to the covering window. ` +
      "Aim at a part of the target window that nothing covers, or move the covering window out of " +
      "the way first; or drop window_id to act on whatever is topmost at that point.",
  });
}

/**
 * Refusal for a scoped pointer action the desktop declined to deliver.
 *
 * A coordinate is validated against the window's frame, which includes the
 * invisible resize and shadow margins around it, so a point can sit inside
 * those bounds and still be outside the region the window accepts input in.
 * The window may equally have closed since it was listed. Either way the
 * remedy is the same, and it is not retrying the identical coordinate.
 */
export function refusedInjectionError(
  action: string,
  windowId: string,
  point: ComputerPoint,
): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_refused",
    message:
      `The desktop refused to deliver ${action} to window ${JSON.stringify(windowId)} at ` +
      `(${point.x}, ${point.y}), so no input was sent. The window is not accepting input at that ` +
      "point: a window's bounds include invisible resize and shadow margins, and the window may " +
      "also have closed since it was listed. Aim nearer the middle of the control, target it by " +
      "label instead of a coordinate, or drop window_id to act on whatever is topmost there.",
  });
}

export function tripleClickUnsupportedError(): ComputerBackendError {
  return new ComputerBackendError(
    "This desktop backend cannot send a triple click. Select the line another way — " +
      "click at its start and shift-click at its end, or use the application's own " +
      "select-all shortcut with computer_press_key.",
  );
}

/**
 * The click combinations the driver has no dispatch for at all — a middle
 * button, or a right button pressed more than once. Named in the refusal so
 * the model can pick a supported gesture instead of retrying.
 */
export function clickGestureUnsupportedError(
  button: "right" | "middle",
  count: 1 | 2 | 3,
): ComputerBackendError {
  return new ComputerBackendError(
    `This desktop backend cannot send a ${button} click with count ${count}. ` +
      "Supported gestures are a left click with count 1-3 and a single right click.",
  );
}

export function activationUnsupportedError(): ComputerBackendError {
  return new ComputerBackendError(
    "This desktop backend cannot bring a window forward. Ask the user to click the window " +
      "they want in front, or aim the action at it with window_id instead.",
  );
}

export function clipboardUnsupportedError(): ComputerBackendError {
  return new ComputerBackendError("This computer backend does not support clipboard access.");
}

export function errorMessage(error: unknown): string {
  if (error instanceof ComputerBackendError || error instanceof ComputerTargetError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
