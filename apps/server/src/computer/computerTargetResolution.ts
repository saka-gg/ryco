/**
 * Resolving a tool call's target to a point or an accessibility node, with explicit
 * dependencies on the backend, the window read and the denylist.
 */
import { observedComputerTargetNode } from "./computerElementIdentity.ts";
import {
  ComputerPoint,
  type ComputerInputModifier,
  type ComputerRect,
  type ComputerState,
  type ComputerTarget,
  type ComputerWindow,
} from "@ryco/contracts";
import {
  ComputerBackendError,
  type ComputerAgentDialect,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerMenuTarget,
  type ComputerResolvedTarget,
} from "./ComputerBackend.ts";
import { rectContainsPoint, windowsCoveringPoint } from "./computerGeometry.ts";
import {
  ComputerTargetError,
  activationPointForNode,
  computerTargetCandidates,
  resolveComputerPoint,
  resolveComputerSemanticTarget,
  resolveComputerUniqueTextTarget,
} from "./uiTreeTargeting.ts";
import { ComputerDenylistError } from "./computerDenylist.ts";
import type { ComputerDenylistGuard } from "./computerDenylistGuard.ts";
import {
  clickGestureUnsupportedError,
  errorMessage,
  menuAppNotFoundError,
  tripleClickUnsupportedError,
  windowNotFoundError,
} from "./computerManagerErrors.ts";
import type { ComputerClickGesture } from "./computerManagerTypes.ts";

/**
 * What target resolution reads: the backend, `ComputerManager`'s window read and desktop dialect,
 * and the denylist.
 */
export interface ComputerTargetingDeps {
  readonly backend: ComputerBackend;
  readonly agentDialect: () => ComputerAgentDialect;
  readonly readWindows: () => Promise<readonly ComputerWindow[]>;
  readonly denylist: ComputerDenylistGuard;
}

/**
 * A resolved pointer target, plus what the window read taken while resolving it
 * showed covering the point. The covering list rides along so the raise-failure
 * path can decide whether to refuse without paying a second window read.
 */
export interface ResolvedPointTarget {
  readonly point: ComputerPoint;
  readonly windowId?: string;
  readonly covering?: readonly ComputerWindow[];
  readonly semantic?: ComputerResolvedTarget;
}

/**
 * What the raise/focus step needs. The point is optional because keyboard
 * actions name a window without one, and with no point there is nothing an
 * occlusion check could be about.
 */
export type PreparedTarget = Omit<ResolvedPointTarget, "point"> & {
  readonly point?: ComputerPoint;
};

/**
 * The raise/focus target for a control resolved through the accessibility tree.
 * The point comes along so a failed raise is still checked for occlusion:
 * nothing consulted the stacking order while matching the label, and the click
 * that follows is as misroutable as any other.
 */
export function semanticPointTarget(resolved: ComputerResolvedTarget): PreparedTarget {
  return {
    point: resolved.point,
    ...(resolved.node.windowId ? { windowId: resolved.node.windowId } : {}),
  };
}

export function hasCoordinates(target: ComputerTarget): target is ComputerTarget & ComputerPoint {
  return typeof target.x === "number" && typeof target.y === "number";
}

/** Fields that only the accessibility tree can resolve. */
export function hasLabelFields(target: ComputerTarget): boolean {
  return target.label !== undefined || target.role !== undefined;
}

export function hasSemanticFields(target: ComputerTarget): boolean {
  return hasLabelFields(target) || target.windowId !== undefined;
}

/**
 * Coordinates plus a window id are a window-scoped click: the point is
 * resolved exactly as a bare coordinate, and the window id only decides which
 * window is raised and receives the input. A label or role instead means the
 * coordinate is at most a hint, so those keep going through AT-SPI
 * resolution, which owns the final point.
 */
export function assertTargetCanUseCoordinates(target: ComputerTarget): void {
  if (observedComputerTargetNode(target)) {
    throw new ComputerTargetError({
      code: "computer_target_refused",
      message:
        "This observed element does not support the requested exact pointer action. Use an advertised semantic action or explicitly target a current screenshot; no coordinate fallback was sent.",
    });
  }
}

export async function resolveCoordinatePoint(
  deps: ComputerTargetingDeps,
  target: ComputerTarget,
): Promise<ComputerPoint> {
  if (target.windowId && hasCoordinates(target)) {
    const window = (await deps.readWindows()).find((window) => window.id === target.windowId);
    const bounds = window?.bounds;
    const observed = (target as ComputerTarget & { observedWindowBounds?: ComputerRect })
      .observedWindowBounds;
    if (window && !bounds)
      throw new ComputerTargetError({
        code: "computer_target_offscreen",
        message: "The target window exposes no geometry.",
      });
    if (
      !bounds ||
      (observed &&
        (bounds.x !== observed.x ||
          bounds.y !== observed.y ||
          bounds.width !== observed.width ||
          bounds.height !== observed.height))
    )
      throw new ComputerTargetError({
        code: "computer_target_not_found",
        message:
          "The exact window closed or moved since this screenshot. Observe again before acting.",
      });
    if (
      target.x < bounds.x ||
      target.y < bounds.y ||
      target.x >= bounds.x + bounds.width ||
      target.y >= bounds.y + bounds.height
    )
      throw new ComputerTargetError({
        code: "computer_target_offscreen",
        message: "The coordinate is outside the exact target window.",
      });
    return { x: target.x, y: target.y };
  }
  try {
    return resolveComputerPoint(target, await deps.backend.getScreenSize());
  } catch (error) {
    if (!(error instanceof ComputerTargetError) || error.code !== "computer_target_offscreen") {
      throw error;
    }
    const state = await deps.backend
      .getState({
        includeTree: true,
        ...(target.windowId ? { windowId: target.windowId } : {}),
      })
      .catch(() => undefined);
    throw new ComputerTargetError({
      code: error.code,
      message: error.message,
      candidates: state?.root ? computerTargetCandidates(state.root) : [],
    });
  }
}

/**
 * Checks a scoped coordinate against the window it names, and reports the
 * windows stacked above it that also contain the point.
 *
 * A scoped click is refused rather than redirected. Input is routed to the
 * named window regardless of what covers that coordinate, so a point outside
 * its bounds would deliver a click to a part of the window that does not
 * exist — the one failure mode scoping is meant to remove. The covering list
 * comes from the same window read, so the raise path downstream never has to
 * repeat it.
 */
export async function scopedPointOcclusion(
  deps: ComputerTargetingDeps,
  point: ComputerPoint,
  windowId: string,
): Promise<{
  readonly covering: readonly ComputerWindow[];
  readonly windows: readonly ComputerWindow[];
  readonly ranked: boolean;
}> {
  const windows = await deps.readWindows();
  const window = windows.find((candidate) => candidate.id === windowId);
  if (!window) throw windowNotFoundError(windowId);
  const bounds = window.bounds;
  if (!bounds) {
    // Scoping exists to guarantee the point is inside the named window. A
    // display server with no geometry cannot answer that, and letting the
    // click through unchecked would silently drop the guarantee the caller
    // asked for by passing window_id at all.
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message:
        `This desktop reports no geometry for window ${JSON.stringify(windowId)}, so a coordinate ` +
        "cannot be checked against it. Drop window_id to click whatever is topmost at that point, " +
        "or target the control by label instead.",
    });
  }
  if (!rectContainsPoint(bounds, point)) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message:
        `Computer target (${point.x}, ${point.y}) is outside window ${JSON.stringify(windowId)}, ` +
        `which covers ${bounds.width}x${bounds.height} at (${bounds.x}, ${bounds.y}). ` +
        "Pass a coordinate inside those bounds, or drop window_id to click whatever is topmost.",
    });
  }
  return {
    covering: windowsCoveringPoint(windows, windowId, point),
    windows,
    ranked: window.stackingIndex !== undefined,
  };
}

/** The restack, or the reason this desktop did not perform one. */
export async function raiseTargetWindow(
  deps: ComputerTargetingDeps,
  windowId: string,
): Promise<string | undefined> {
  const raise = deps.backend.raiseWindow?.bind(deps.backend);
  if (!raise) return "this backend exposes no stacking control";
  try {
    await raise(windowId);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

export async function coveringWindowsAt(
  deps: ComputerTargetingDeps,
  point: ComputerPoint,
  windowId: string,
): Promise<readonly ComputerWindow[]> {
  const windows = await deps.readWindows().catch(() => []);
  return windowsCoveringPoint(windows, windowId, point);
}

export async function resolveSemanticTarget(
  deps: ComputerTargetingDeps,
  target: ComputerTarget,
  allowUniqueTextTarget = false,
): Promise<ComputerResolvedTarget> {
  const unnamedTarget = target.label === undefined && target.role === undefined;
  // Without a label or role the query matches every control in scope, and
  // the ambiguity refusal that follows would dump the whole tree at the
  // caller. Refuse up front, before paying for the accessibility walk, with
  // what is actually missing.
  if (unnamedTarget && (!allowUniqueTextTarget || !target.windowId)) {
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message:
        "This target does not name a control: window_id or coordinates alone match everything in scope. " +
        "Pass label (optionally with role and window_id) to pick a control, or use x/y coordinates " +
        "with the pointer tools. Only computer_scroll takes window_id alone, scrolling that window itself.",
    });
  }
  // A semantic resolve walks the accessibility tree before any input check
  // runs, and a denied app's tree is itself refused — ambiguity and
  // not-found errors otherwise carry its labels back as candidates. macOS
  // only answers scoped trees, so an unscoped walk there is already empty;
  // a desktop-wide tree on other dialects refuses while a denied window is
  // visible.
  if (target.windowId !== undefined) {
    await deps.denylist.assertWindowContentAllowed(target.windowId);
  } else if (deps.agentDialect() !== "macos") {
    const denied = await deps.denylist.deniedVisibleWindow();
    if (denied) throw new ComputerDenylistError(denied.match.app, denied.match.matched);
  }
  const observedNode = observedComputerTargetNode(target);
  if (observedNode) {
    if (!observedNode.windowId || observedNode.windowId !== target.windowId) {
      throw new ComputerTargetError({
        code: "computer_target_invalid",
        message: "The observed element and target name different windows; nothing was sent.",
      });
    }
    // The backend revalidates this original native token's window ancestry
    // and freshness at dispatch. Re-resolving a label/ordinal here could
    // silently give a stale ref the token of a different control.
    return { target, node: observedNode, point: activationPointForNode(observedNode) };
  }
  let state = await deps.backend.getState({
    includeTree: true,
    reuseRecentTree: true,
    ...(target.windowId ? { windowId: target.windowId } : {}),
  });
  if (!state.root) {
    throw new ComputerTargetError({
      code: "computer_target_not_found",
      message: "Computer accessibility state did not include a target tree.",
      notFound: true,
    });
  }
  const resolve = (root: NonNullable<ComputerState["root"]>): ComputerResolvedTarget => ({
    target,
    ...(unnamedTarget
      ? resolveComputerUniqueTextTarget(root, target.windowId!, allowUniqueTextTarget)
      : resolveComputerSemanticTarget(root, target, allowUniqueTextTarget)),
  });
  try {
    return resolve(state.root);
  } catch (error) {
    // A tree served from the recent cache can miss a control that only just
    // appeared. Pay for one fresh walk before declaring it absent; on a
    // genuinely-missing target the extra walk is a rare error-path cost.
    // Other failure shapes (ambiguity, bad target) retrying cannot fix.
    if (error instanceof ComputerTargetError && error.code === "computer_target_not_found") {
      state = await deps.backend.getState({
        includeTree: true,
        ...(target.windowId ? { windowId: target.windowId } : {}),
      });
      try {
        if (state.root) return resolve(state.root);
      } catch (freshError) {
        // The miss is confirmed against fresh state; report its candidates.
        // oxlint-disable-next-line no-ex-assign -- the fresh miss replaces the cached one below
        if (freshError instanceof ComputerTargetError) error = freshError;
      }
    }
    // A truncated tree may simply not contain the control: name the narrow
    // query so the miss is recoverable instead of a dead end.
    if (
      error instanceof ComputerTargetError &&
      error.code === "computer_target_not_found" &&
      state.root?.truncated === true
    ) {
      throw new ComputerTargetError({
        code: error.code,
        message: `${error.message} The accessibility tree was truncated; use computer_get_state with label_contains to narrow the list and check whether the control is present.`,
        candidates: error.candidates,
        notFound: true,
      });
    }
    throw error;
  }
}

/**
 * The live process an application-level menu target names. An `app` is
 * resolved through the same running-app inventory the consent path
 * consults — exact name or bundle id, case-insensitive — and refuses when
 * nothing matches; a `pid` is passed through with whatever name the
 * inventory has for it, because an unknown pid is the driver's refusal to
 * make, matching set_app_visibility.
 */
export async function resolveMenuAppTarget(
  deps: ComputerTargetingDeps,
  target: Exclude<ComputerMenuTarget, { readonly windowId: string }>,
): Promise<{ readonly pid: number; readonly name?: string }> {
  const listApps = deps.backend.listApps?.bind(deps.backend);
  if (listApps === undefined) {
    throw new ComputerBackendError(
      "This backend cannot enumerate applications, so a menu target has to name an exact window.",
    );
  }
  if ("pid" in target) {
    // The tool layer already refuses a malformed pid; this is the direct
    // caller's backstop, matching setAppVisibility's own validation gap.
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
      throw new ComputerTargetError({
        code: "computer_target_invalid",
        message: `"pid" must be a positive integer; got ${JSON.stringify(target.pid)}.`,
      });
    }
    const owner = (await listApps()).find((app) => app.pid === target.pid && app.running);
    return { pid: target.pid, ...(owner !== undefined ? { name: owner.name } : {}) };
  }
  const spelling = target.app.trim();
  const owner = (await listApps()).find(
    (app) =>
      app.running &&
      (app.name.trim().toLowerCase() === spelling.toLowerCase() ||
        (app.bundleId !== undefined && app.bundleId.toLowerCase() === spelling.toLowerCase())),
  );
  if (owner === undefined) throw menuAppNotFoundError(spelling);
  return { pid: owner.pid, name: owner.name };
}

/**
 * The backend call behind one click gesture, refused up front when the
 * driver exposes no such path: a left click repeats up to three times and
 * a right click exists only once — every other combination is a refusal
 * before any target resolution, never an approximation. The triple click
 * is also optional on the backend itself, and its absence is a real
 * refusal rather than a degradation: three separate clicks are three
 * carets, not a line selection, so approximating it would answer a request
 * the application never received.
 */
export function clickInjector(
  deps: ComputerTargetingDeps,
  gesture: ComputerClickGesture | undefined,
): (
  point: ComputerPoint,
  windowId: string | undefined,
  modifiers: readonly ComputerInputModifier[] | undefined,
) => Promise<ComputerBackendActionResult | void> {
  const button = gesture?.button ?? "left";
  const count = gesture?.count ?? 1;
  if (button === "left") {
    if (count === 1) {
      return (point, windowId, modifiers) => deps.backend.click(point, windowId, modifiers);
    }
    if (count === 2) {
      return (point, windowId, modifiers) => deps.backend.doubleClick(point, windowId, modifiers);
    }
    const tripleClick = deps.backend.tripleClick?.bind(deps.backend);
    if (!tripleClick) throw tripleClickUnsupportedError();
    return (point, windowId, modifiers) => tripleClick(point, windowId, modifiers);
  }
  if (button === "right" && count === 1) {
    return (point, windowId, modifiers) => deps.backend.rightClick(point, windowId, modifiers);
  }
  throw clickGestureUnsupportedError(button, count);
}

export function keyboardTargetWindow(
  windowId: string | undefined,
  target: ComputerTarget | undefined,
): string | undefined {
  if (windowId !== undefined && target?.windowId !== undefined && target.windowId !== windowId) {
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message: "The keyboard window and element target name different windows; nothing was sent.",
    });
  }
  return windowId ?? target?.windowId;
}
