import {
  COMPUTER_LANE_INPUT,
  computerAppLane,
  computerExclusiveLane,
  computerKeyedLane,
  computerLaneClaim,
  computerReadLane,
  computerWindowLane,
  withComputerLaneClaims,
  type ComputerLaneClaim,
} from "@ryco/shared/computerLanes";
import {
  CUA_ACTION_TOOLS,
  CUA_BROWSER_TOOLS,
  cuaUsesConcurrentInputLease,
} from "@ryco/shared/cuaDriverProtocol";

/**
 * Actions that change the whole desktop rather than one app's input: focus,
 * the clipboard, a pointer gesture, a launch, window or app visibility. They
 * run alone, as before; everything else runs in a narrower lane.
 */
export const CUA_DESKTOP_EXCLUSIVE_TOOLS: ReadonlySet<string> = new Set([
  "bring_to_front",
  "drag",
  "clipboard_read",
  "clipboard_write",
  "launch_app",
  "invoke_menu",
  "set_window_frame",
  "set_window_minimized",
  "set_app_visibility",
  "kill_app",
]);

const nativeId = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
    ? value
    : undefined;

/** Lane resource for one thread's driver browser namespace. */
export const cuaBrowserLaneResource = (threadId: string) => `browser:${threadId}`;
/** Lane resource a task's cursor session lives under; its cleanup claims it exclusively. */
export const cuaCursorLaneResource = (threadId: string) => `cursor:${threadId}`;

export interface CuaHostLaneRequest {
  readonly name: string;
  readonly args: unknown;
  /** The attributed thread, when the call has one. */
  readonly threadId?: string | undefined;
  /** Foreground delivery requested by the caller's envelope. */
  readonly foreground: boolean;
  /** Whether a browser call can change the page (Linux may prove a call read-only). */
  readonly browserMutation: boolean;
}

/**
 * The lanes one driver call runs in, mirroring what the patched driver can
 * overlap (see docs/superpowers/specs/2026-11-06-computer-use-parallel-sessions.md):
 *
 * - reads take no driver lease and run next to everything but whole-desktop work;
 * - exact semantic writes share the driver's input gate, one per window;
 * - all other input holds the input gate alone, so the driver never refuses
 *   our own overlap with `native_input_busy`;
 * - foreground and desktop-changing actions hold the whole desktop.
 */
export function cuaHostLaneClaims(request: CuaHostLaneRequest): readonly ComputerLaneClaim[] {
  const { name } = request;
  const args =
    request.args && typeof request.args === "object" && !Array.isArray(request.args)
      ? (request.args as Record<string, unknown>)
      : {};
  const cursor =
    request.threadId !== undefined && !CUA_BROWSER_TOOLS.has(name)
      ? [computerLaneClaim.shared(cuaCursorLaneResource(request.threadId))]
      : [];
  if (CUA_BROWSER_TOOLS.has(name)) {
    const lane = computerKeyedLane(cuaBrowserLaneResource(request.threadId ?? "anonymous"));
    return request.browserMutation
      ? withComputerLaneClaims(lane, computerLaneClaim.exclusive(COMPUTER_LANE_INPUT))
      : lane;
  }
  if (!CUA_ACTION_TOOLS.has(name)) return withComputerLaneClaims(computerReadLane(), ...cursor);
  const foreground = request.foreground || args.delivery_mode === "foreground";
  if (foreground || CUA_DESKTOP_EXCLUSIVE_TOOLS.has(name)) return computerExclusiveLane();
  const pid = nativeId(args.pid);
  const windowId = nativeId(args.window_id);
  if (pid !== undefined && windowId !== undefined && cuaUsesConcurrentInputLease(name, args))
    return withComputerLaneClaims(
      computerWindowLane(windowId, pid),
      computerLaneClaim.shared(COMPUTER_LANE_INPUT),
      ...cursor,
    );
  return withComputerLaneClaims(
    pid === undefined ? computerReadLane() : computerAppLane(pid),
    computerLaneClaim.exclusive(COMPUTER_LANE_INPUT),
    ...cursor,
  );
}

/** Whether a lane set holds the whole desktop. */
export function cuaLanesAreExclusive(claims: readonly ComputerLaneClaim[]): boolean {
  return claims.some((claim) => claim.resource === "desktop" && claim.mode === "exclusive");
}
