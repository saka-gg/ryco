// Reading the helper's raw `describe-ui` tree for scripts/device-helper-smoke.ts.
//
// The smoke's input check proves that buttons, touches and keys reach the
// guest by watching the accessibility tree change. These helpers are the only
// part of it that does not need a booted simulator, so they live here, with
// tests. They read the tree with the server's own normalization and tap at the
// server's own tap point, so the smoke exercises what agents use. Selectors
// are deliberately loose: the qualification run may tune them for a new iOS
// release.

import type { DeviceUiNode } from "@ryco/contracts";
import { flattenUiTree as flattenNodes } from "@ryco/shared/uiTreeTargeting";

import {
  isTargetable,
  normalizeUiNode,
  tapPointForNode,
  visibleLabels as labelsOnScreen,
} from "../../apps/server/src/device/uiTreeTargeting.ts";

/** The helper's raw tree in the contract's shape, as the server reads it. */
export function readUiTree(tree: unknown): DeviceUiNode {
  return normalizeUiNode(tree);
}

/**
 * The root node's label: the frontmost app's name, e.g. "Settings".
 * Undefined when blank: SpringBoard's root is labelled " " on iOS 27, which
 * names no app.
 */
export function rootLabel(root: DeviceUiNode): string | undefined {
  const label = root.label?.trim();
  return label === undefined || label.length === 0 ? undefined : label;
}

/**
 * Whether the tree shows an app other than the one whose root label is
 * `previousRoot`: a different root label (SpringBoard's is blank) and at least
 * one labelled element a tap could land on. The second half keeps a transient
 * accessibility answer (a bare root, no children) from reading as a change.
 */
export function showsAnotherApp(root: DeviceUiNode, previousRoot: string): boolean {
  if (rootLabel(root) === previousRoot) return false;
  return flattenUiTree(root)
    .slice(1)
    .some((node) => (node.label?.trim().length ?? 0) > 0 && isTargetable(node));
}

/**
 * A `describe-ui` failure that clears up by itself: the accessibility
 * translator finds no frontmost application while SpringBoard starts after a
 * first boot or while an app launches on a loaded machine.
 */
export function isTransientUiTreeError(error: unknown): boolean {
  return error instanceof Error && /no frontmost application/iu.test(error.message);
}

/** Every node, depth first, root included. */
export function flattenUiTree(root: DeviceUiNode): readonly DeviceUiNode[] {
  return flattenNodes(root, (node) => node.children);
}

/**
 * A search or text field a tap can land on (Settings' search field). A field
 * found by its role wins over one found by its label: Settings on iOS 26+
 * lists a "Search" row (its Spotlight settings) before the search field
 * itself, and tapping that row opens a page with nothing to type into.
 */
export function findSearchField(root: DeviceUiNode): DeviceUiNode | undefined {
  const candidates = flattenUiTree(root).filter(isTargetable);
  return (
    candidates.find((node) => /SearchField|TextField/u.test(node.role)) ??
    candidates.find((node) => /^search$/iu.test(node.label ?? ""))
  );
}

/**
 * Where the server would tap `node`, in the helper's normalized 0..1
 * coordinates; undefined without a screen size or when that point is off the
 * screen (the server refuses those rather than clamping them).
 */
export function normalizedTapPoint(
  node: DeviceUiNode,
  pointWidth: number,
  pointHeight: number,
): { readonly x: number; readonly y: number } | undefined {
  if (!(pointWidth > 0) || !(pointHeight > 0)) return undefined;
  const point = tapPointForNode(node);
  const x = point.x / pointWidth;
  const y = point.y / pointHeight;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : undefined;
}

/**
 * Letters on the same key in US QWERTY, German QWERTZ and French AZERTY. Text
 * goes in as HID key usages that the guest maps through its own keyboard
 * layout (a German simulator types "z" as "y"), so the typed token uses only
 * these.
 */
const LAYOUT_STABLE_LETTERS = "bcdefghijklnoprstuvx";

/**
 * A fresh lowercase token for the typing check: a fixed word could already be
 * on screen (a field Settings kept from an earlier run), and then its presence
 * would prove nothing about this run's keystrokes.
 */
export function layoutStableToken(random: () => number = Math.random, length = 6): string {
  let token = "";
  for (let index = 0; index < length; index += 1) {
    const pick = Math.min(
      LAYOUT_STABLE_LETTERS.length - 1,
      Math.floor(random() * LAYOUT_STABLE_LETTERS.length),
    );
    token += LAYOUT_STABLE_LETTERS[pick];
  }
  return token;
}

/** Whether some node's value or label contains `needle`, ignoring case. */
export function mentions(root: DeviceUiNode, needle: string): boolean {
  const wanted = needle.toLowerCase();
  return flattenUiTree(root).some((node) =>
    [node.value, node.label].some((text) => text?.toLowerCase().includes(wanted) === true),
  );
}

/** The distinct labels on screen, for a failure message. */
export function visibleLabels(root: DeviceUiNode, limit = 40): string[] {
  return [...new Set(labelsOnScreen(root))].slice(0, limit);
}
