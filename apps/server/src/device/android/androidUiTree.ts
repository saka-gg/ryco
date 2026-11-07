/**
 * Android's accessibility tree in the shape iOS uses (`DeviceUiNode`), so
 * `@eN` refs, label and role targeting, settle fingerprints and diffs work the
 * same on both platforms.
 *
 * Input is uiautomator's window-hierarchy XML, from Ryco's resident helper
 * (`androidUiHelper.ts`) or, without one, `uiautomator dump`. Both write the
 * same element and attribute names.
 *
 * Mapping:
 * - The root is an `Application` labelled with the foreground package, which
 *   is also the bundle id `launch` and `logs` take.
 * - Widget classes map to the iOS role names (`Button`, `TextField`,
 *   `Switch`, `CheckBox`, `StaticText`, `Image`, `ScrollArea`, `Group`).
 * - A clickable container with no text of its own (a settings row) becomes a
 *   `Button` labelled with its first text, valued with its second, and the
 *   plain text inside it is folded into it, so a row is one line and one ref.
 * - Frames are display pixels: Android emulators take pixels as points.
 *
 * @module device/android/androidUiTree
 */
import type { DeviceUiNode } from "@ryco/contracts";

interface RawNode {
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: RawNode[];
}

const TAG = /<(\/?)(node|hierarchy)((?:\s+[A-Za-z_][\w.-]*\s*=\s*"[^"]*")*)\s*(\/?)>/gu;
const ATTRIBUTE = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/gu;
const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u;
/** A real screen has a few hundred nodes; a runaway tree is cut here. */
const MAX_NODES = 4_000;
/** The contract caps children per node. */
const MAX_CHILDREN = 512;

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number(lower.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : match;
  });
}

export class AndroidUiTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AndroidUiTreeError";
  }
}

/** Parse the hierarchy XML into raw nodes; the `<hierarchy>` element's attributes are returned too. */
export function parseUiHierarchyXml(xml: string): {
  readonly rotation: number;
  readonly nodes: readonly RawNode[];
} {
  const stack: RawNode[] = [];
  const top: RawNode[] = [];
  let rotation = 0;
  let sawHierarchy = false;
  let count = 0;
  for (const match of xml.matchAll(TAG)) {
    const [, closing, name, rawAttributes = "", selfClosing] = match;
    if (name === "hierarchy") {
      if (closing) continue;
      sawHierarchy = true;
      const value = /rotation\s*=\s*"(\d)"/u.exec(rawAttributes)?.[1];
      rotation = value === undefined ? 0 : Number(value);
      continue;
    }
    if (closing) {
      stack.pop();
      continue;
    }
    if (++count > MAX_NODES) break;
    const attributes: Record<string, string> = {};
    for (const attribute of rawAttributes.matchAll(ATTRIBUTE))
      attributes[attribute[1]!] = decodeEntities(attribute[2]!);
    const node: RawNode = { attributes, children: [] };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else top.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (!sawHierarchy) throw new AndroidUiTreeError("The Android UI dump returned no hierarchy.");
  return { rotation, nodes: top };
}

function frameOf(node: RawNode): DeviceUiNode["frame"] | null {
  const match = BOUNDS.exec(node.attributes.bounds ?? "");
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1, 5).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

const text = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};
const flag = (node: RawNode, name: string): boolean => node.attributes[name] === "true";

/** The class's simple name, matched against well-known widget families. */
export function androidRole(className: string, node?: { readonly editable?: boolean }): string {
  const simple = className.slice(className.lastIndexOf(".") + 1);
  if (node?.editable || /EditText|AutoCompleteTextView|SearchView/u.test(simple))
    return "TextField";
  if (/Switch|ToggleButton/u.test(simple)) return "Switch";
  if (/CheckBox|CheckedTextView/u.test(simple)) return "CheckBox";
  if (/RadioButton/u.test(simple)) return "RadioButton";
  if (/Button|Chip|Tab(View)?$/u.test(simple)) return "Button";
  if (/Image/u.test(simple)) return "Image";
  if (/SeekBar|Slider/u.test(simple)) return "Slider";
  if (/ProgressBar/u.test(simple)) return "ProgressIndicator";
  if (/TextView$|^Text$/u.test(simple)) return "StaticText";
  if (/ScrollView|RecyclerView|ListView|GridView|ViewPager|Pager|LazyColumn|LazyRow/u.test(simple))
    return "ScrollArea";
  if (/WebView/u.test(simple)) return "WebView";
  return "Group";
}

interface Mapped {
  readonly node: DeviceUiNode;
}

const isPlainText = (node: DeviceUiNode) =>
  node.role === "StaticText" && node.label !== null && node.children.length === 0;
const isWrapper = (node: DeviceUiNode) =>
  node.role === "Group" && node.label === null && node.value === null;

/**
 * Take up to two plain texts out of a row's subtree (through unlabelled
 * layout wrappers) and return what is left: its switch, its icon.
 */
function foldTexts(children: readonly DeviceUiNode[], texts: string[]): DeviceUiNode[] {
  const kept: DeviceUiNode[] = [];
  for (const child of children) {
    if (texts.length < 2 && isPlainText(child)) {
      texts.push(child.label!);
      continue;
    }
    if (isWrapper(child) && child.children.length > 0) {
      const rest = foldTexts(child.children, texts);
      if (rest.length > 0) kept.push({ ...child, children: rest });
      continue;
    }
    kept.push(child);
  }
  return kept;
}

function mapNode(raw: RawNode): Mapped | null {
  const frame = frameOf(raw);
  if (frame === null) return null;
  const editable = flag(raw, "editable");
  let role = androidRole(raw.attributes.class ?? "", { editable });
  const description = text(raw.attributes["content-desc"]);
  const ownText = text(raw.attributes.text);
  const hint = text(raw.attributes.hint);
  const state = text(raw.attributes["state-description"]);
  const clickable = flag(raw, "clickable") || flag(raw, "long-clickable");
  const checkable = flag(raw, "checkable");

  const mappedChildren: Mapped[] = [];
  for (const child of raw.children) {
    const mapped = mapNode(child);
    if (mapped) mappedChildren.push(mapped);
  }

  let label: string | null;
  let value: string | null;
  if (role === "TextField") {
    label = description ?? hint ?? null;
    value = ownText;
    // An empty field shows its hint as its text on some versions.
    if (value !== null && value === hint) value = null;
  } else {
    label = description ?? ownText;
    value = description !== null && ownText !== null && ownText !== description ? ownText : null;
  }
  if (checkable) value = state ?? (flag(raw, "checked") ? "on" : "off");
  else if (state !== null && value === null) value = state;

  let children = mappedChildren.map((entry) => entry.node);
  // A clickable row whose text lives in its children: one element, not three.
  if (label === null && (clickable || checkable) && role !== "TextField") {
    const texts: string[] = [];
    children = foldTexts(children, texts);
    if (texts.length > 0) {
      label = texts[0]!;
      if (value === null && texts[1] !== undefined) value = texts[1];
      if (role === "Group" || role === "StaticText") role = "Button";
    } else {
      children = mappedChildren.map((entry) => entry.node);
    }
  }
  if (clickable && (role === "Group" || role === "StaticText") && label !== null) role = "Button";
  if (
    !flag(raw, "enabled") &&
    raw.attributes.enabled !== undefined &&
    value === null &&
    role !== "TextField"
  )
    value = "disabled";
  else if (flag(raw, "selected") && value === null && role !== "TextField") value = "selected";

  return {
    node: {
      role,
      subrole: null,
      label,
      value,
      frame,
      activationPoint: null,
      children: children.slice(0, MAX_CHILDREN),
    },
  };
}

/**
 * Collapse wrappers that only add depth: an unlabelled `Group` with one child
 * is replaced by that child, so app layout layers do not lengthen the tree.
 */
function unwrapSingle(node: DeviceUiNode): DeviceUiNode {
  let current = node;
  while (
    current.role === "Group" &&
    current.label === null &&
    current.value === null &&
    current.children.length === 1
  ) {
    current = current.children[0]!;
  }
  return { ...current, children: current.children.map(unwrapSingle) };
}

/** The whole screen as one `Application` root, sized to the display. */
export function androidUiRoot(
  xml: string,
  display: { readonly width: number; readonly height: number } | null,
): DeviceUiNode {
  const { nodes } = parseUiHierarchyXml(xml);
  const children: DeviceUiNode[] = [];
  let packageName: string | null = null;
  for (const raw of nodes) {
    packageName ??= text(raw.attributes.package);
    const mapped = mapNode(raw);
    if (mapped) children.push(unwrapSingle(mapped.node));
  }
  const first = children[0]?.frame;
  const width = display?.width ?? (first ? first.x + first.width : 0);
  const height = display?.height ?? (first ? first.y + first.height : 0);
  return {
    role: "Application",
    subrole: null,
    label: packageName,
    value: null,
    frame: { x: 0, y: 0, width, height },
    activationPoint: null,
    children,
  };
}
