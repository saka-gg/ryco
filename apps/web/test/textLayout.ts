/**
 * What one-line text actually shows, for browser tests.
 *
 * An ellipsized or clipped box still lays out all of its text, so
 * `textContent` and box sizes say nothing about which characters a reader
 * sees. These helpers measure the laid-out text with ranges and check it
 * against every clipping box around it, to the fraction of a pixel that is
 * enough to make Chromium draw a "…".
 */

export function textNodesIn(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/** The laid-out box of `node`'s text from `start` to `end`, painted or not. */
export function rangeRect(node: Text, start = 0, end = node.length): DOMRect {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range.getBoundingClientRect();
}

/** Where `text` (inside one text node under `root`) is laid out, painted or not. */
export function locateText(root: Element, text: string): { node: Text; rect: DOMRect } {
  for (const node of textNodesIn(root)) {
    const index = node.data.indexOf(text);
    if (index >= 0) return { node, rect: rangeRect(node, index, index + text.length) };
  }
  throw new Error(`No text "${text}"`);
}

/**
 * Whether `text` is drawn in full: no clipping box between it and `root` cuts
 * it off, and no ellipsizing box whose content overflows it, by any fraction
 * of a pixel, reaches it with its "…". Assumes a monospace font, where the
 * "…" is as wide as any character of `text`.
 */
export function isShownWhole(root: Element, text: string): boolean {
  const { node, rect } = locateText(root, text);
  const charWidth = rect.width / Array.from(text).length;
  for (let element = node.parentElement; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (style.overflowX !== "visible") {
      const box = element.getBoundingClientRect();
      const content = textNodesIn(element).map((each) => rangeRect(each));
      const rtl = style.direction === "rtl";
      // The "…" takes the end edge: the left one when right to left.
      const ellipsized =
        style.textOverflow === "ellipsis" &&
        (rtl
          ? Math.min(...content.map((each) => each.left)) < box.left - 0.001
          : Math.max(...content.map((each) => each.right)) > box.right + 0.001);
      const left = ellipsized && rtl ? box.left + charWidth : box.left;
      const right = ellipsized && !rtl ? box.right - charWidth : box.right;
      // A plain clip may shave a glyph's blank side bearing (a fraction of a pixel).
      if (rect.left < left - 0.25 || rect.right > right + 0.25) return false;
    }
    if (element === root) break;
  }
  return true;
}
