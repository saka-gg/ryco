// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
/**
 * Window-list parsing and point/rect hit-testing for the computer backends.
 *
 * None of this is compositor-specific. The window-list shape and the rule for
 * which window a coordinate lands on are part of the coordinate contract the
 * agent's tool surface is written against, so every backend has to answer them
 * the same way or a coordinate the model learned on one desktop means something
 * else on another.
 *
 * The payload helpers live here because `parseWindows` is the reason they
 * exist: window JSON arrives either as a plain string or as an already-decoded
 * value, depending on which transport carried it.
 */
import {
  COMPUTER_ID_MAX_LENGTH,
  COMPUTER_LABEL_MAX_LENGTH,
  COMPUTER_OCCLUDERS_MAX_LENGTH,
  COMPUTER_WINDOW_LIST_MAX_LENGTH,
  type ComputerPoint,
  type ComputerRect,
  type ComputerWindow,
} from "@ryco/contracts";

import { ComputerBackendError } from "./ComputerBackend.ts";
const unwrapDbusValue = (value: unknown): unknown => value;
import { clampTextToLength } from "./utf8Truncation.ts";

// ── Payload decoding ─────────────────────────────────────────────────

/**
 * A JSON document that may still be a string, a variant-wrapped string, or an
 * already-decoded value. Malformed JSON decodes to `null` rather than throwing:
 * every caller degrades to "the display server told us nothing", which is a
 * state they all have to handle anyway.
 */
export function parseJsonPayload(value: unknown): unknown {
  const unwrapped = unwrapDbusValue(value);
  if (typeof unwrapped === "string") {
    try {
      return JSON.parse(unwrapped);
    } catch {
      return null;
    }
  }
  return unwrapped;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asNonNegativeInt(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value);
  return numeric === undefined || numeric < 0 ? undefined : Math.trunc(numeric);
}

export function parseComputerRect(value: unknown): ComputerRect | undefined {
  const record = asRecord(value);
  const x = asFiniteNumber(record.x);
  const y = asFiniteNumber(record.y);
  const width = asFiniteNumber(record.width);
  const height = asFiniteNumber(record.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    return undefined;
  if (width < 0 || height < 0) return undefined;
  return { x, y, width, height };
}

/**
 * Occluder ids from a source that reports them. Both the field and its
 * individual entries degrade to absent rather than failing the whole window
 * list, because stacking metadata is an optional hint and a backend may omit
 * it entirely. An empty list is dropped: "nothing above this
 * window" is what an absent field already means. The list is clamped well
 * below the contract's ceiling because an occluder enumeration can be
 * N² in the worst case, and no caller can use hundreds of entries.
 */
function asWindowIds(value: unknown): readonly ComputerWindow["id"][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .slice(0, COMPUTER_OCCLUDERS_MAX_LENGTH)
    .map((id) => clampTextToLength(id, COMPUTER_ID_MAX_LENGTH));
  return ids.length > 0 ? (ids as ComputerWindow["id"][]) : undefined;
}

/**
 * The window list emitted by a backend enumerator.
 *
 * An entry without an id or without a parseable rect is dropped rather than
 * reported bounds-less. `ComputerWindow.bounds` being optional describes a
 * display server that has no geometry to give at all, which is a property of
 * the provider and is declared through `ComputerCapabilities.windowBounds`; a
 * single malformed entry from a source that does report geometry is a bug in
 * that entry, and admitting it would put an unlocatable window in front of a
 * model that has no way to tell the two cases apart.
 *
 * Every free-form string — id, title, app name — is clamped to its contract
 * bound before an object is constructed: one application with a paragraph-long
 * window title (browsers and SPAs do this) must cost that title's tail, not
 * fail the schema encode of every state payload and push event for the whole
 * session. The list itself is clamped to the same ceiling the contract checks.
 */
export function parseWindows(value: unknown, focusedWindowId: string | null): ComputerWindow[] {
  const parsed = parseJsonPayload(value);
  const items = Array.isArray(parsed) ? parsed : [];
  const windows: ComputerWindow[] = [];
  for (const item of items.slice(0, COMPUTER_WINDOW_LIST_MAX_LENGTH)) {
    const record = asRecord(item);
    const rawId = asString(record.id) ?? asString(record.windowId);
    const bounds = parseComputerRect(record.bounds);
    if (!rawId || !bounds) continue;
    // An oversized id cannot be addressed through the schema either way, so
    // the tail is cut rather than the whole window dropped.
    const id = clampTextToLength(rawId, COMPUTER_ID_MAX_LENGTH);
    // Every backend names the owning application, but not with the same key:
    // KWin reports `resourceClass`, Hyprland an `appId`, and the macOS helper an
    // `appName` taken from `kCGWindowOwnerName`. All three land in `appName`,
    // which is the only field the contract has — reading just the two Linux
    // spellings silently dropped the app name from every macOS window.
    const appNameSource =
      asString(record.appName) ?? asString(record.appId) ?? asString(record.resourceClass);
    const stackingIndex = asNonNegativeInt(record.stackingIndex);
    const occludedBy = asWindowIds(record.occludedBy);
    windows.push({
      id: id as ComputerWindow["id"],
      title: clampTextToLength(asString(record.title) ?? "", COMPUTER_LABEL_MAX_LENGTH),
      ...(appNameSource
        ? { appName: clampTextToLength(appNameSource, COMPUTER_LABEL_MAX_LENGTH) }
        : {}),
      ...(typeof record.pid === "number" && record.pid > 0 ? { pid: Math.trunc(record.pid) } : {}),
      bounds,
      focused: record.focused === true || rawId === focusedWindowId,
      ...(typeof record.active === "boolean" ? { active: record.active } : {}),
      minimized: record.minimized === true,
      visible: record.visible !== false,
      ...(stackingIndex !== undefined ? { stackingIndex } : {}),
      ...(occludedBy ? { occludedBy } : {}),
    });
  }
  return windows;
}

/**
 * Windows stacked above `windowId` whose bounds contain `point` — what a bare
 * coordinate click at that point would hit instead of the named window.
 *
 * Empty when the display server reports no stacking order, or none for the
 * named window: an unknown order cannot establish that anything is above
 * anything, and inventing occlusion from bounds alone would refuse clicks that
 * are perfectly safe. Bounds are frame rects, so an overlap is an upper bound
 * on real occlusion — the covering window may be translucent or shaped — which
 * is the safe direction, because the remedy is raising the target either way.
 */
export function windowsCoveringPoint(
  windows: readonly ComputerWindow[],
  windowId: string,
  point: ComputerPoint,
): readonly ComputerWindow[] {
  const depth = windows.find((window) => window.id === windowId)?.stackingIndex;
  if (depth === undefined) return [];
  return windows.filter(
    (window) =>
      window.id !== windowId &&
      window.visible &&
      !window.minimized &&
      window.stackingIndex !== undefined &&
      window.stackingIndex < depth &&
      rectContainsPoint(window.bounds, point),
  );
}

/**
 * The window a bare coordinate action at `point` was delivered to: the topmost
 * visible, unminimized window whose frame contains the point — the same
 * stacking rule the compositor applies to an unscoped click.
 *
 * With one candidate the stacking order is irrelevant. With several, every
 * candidate must report a stacking index: ranking only the windows that have
 * one could crown a window that an unranked one actually covers, and a wrong
 * answer here photographs a window the action never touched.
 */
export function topmostWindowAtPoint(
  windows: readonly ComputerWindow[],
  point: ComputerPoint,
): ComputerWindow | undefined {
  const candidates = windows.filter(
    (window) => window.visible && !window.minimized && rectContainsPoint(window.bounds, point),
  );
  if (candidates.length <= 1) return candidates[0];
  if (candidates.some((window) => window.stackingIndex === undefined)) return undefined;
  return candidates.reduce((top, window) =>
    (window.stackingIndex as number) < (top.stackingIndex as number) ? window : top,
  );
}

export function rectContainsPoint(rect: ComputerRect | undefined, point: ComputerPoint): boolean {
  if (!rect) return false;
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  );
}

// ── Window bounds ────────────────────────────────────────────────────

/**
 * A window's rect, or a refusal that names why there is none.
 *
 * Absent bounds are a property of the backend, not of the window. Every caller
 * here needs a rect to do arithmetic on, and the alternatives are both
 * lies — treating the origin as the window's position puts a click on the wrong
 * monitor, and returning an empty capture tells a model the window is blank. So
 * the geometry-dependent paths refuse, and say which capability is missing so
 * the caller can pick a coordinate-based approach instead.
 */
export function requireWindowBounds(
  window: Pick<ComputerWindow, "id" | "bounds">,
  action: string,
): ComputerRect {
  if (window.bounds) return window.bounds;
  throw new ComputerBackendError(
    `This desktop reports no geometry for window ${JSON.stringify(window.id)}, so ${action} cannot be resolved. ` +
      "The display server exposes window titles and activation but no position or size " +
      "(capabilities.windowBounds is false); use full-screen capture and desktop coordinates instead.",
  );
}
