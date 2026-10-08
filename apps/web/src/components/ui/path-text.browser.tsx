import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { isShownWhole, locateText, rangeRect, textNodesIn } from "../../../test/textLayout";
import { TruncatedPath } from "./path-text";

// A chat folder name as long as the node makes them, under a typical chats root.
const CHAT_LEAF = "2026-10-08-create-a-file-named-notes-md-in-the-current-dire-0fa11298";
const CHAT_PATH = `/private/tmp/ryco-chats-e2e/home/chats/${CHAT_LEAF}`;

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function renderPath(input: {
  readonly path: string;
  readonly monospace: boolean;
}): Promise<{ readonly box: HTMLElement; readonly path: HTMLElement }> {
  mounted = await render(
    <div
      data-testid="box"
      className={input.monospace ? "font-mono text-[11px]" : "font-sans text-sm"}
      style={{ width: 4000 }}
    >
      <TruncatedPath path={input.path} monospace={input.monospace} />
    </div>,
  );
  const box = page.getByTestId("box").element() as HTMLElement;
  return { box, path: box.querySelector<HTMLElement>('[data-slot="truncated-path"]')! };
}

function slot(path: HTMLElement, name: string): HTMLElement {
  return path.querySelector<HTMLElement>(`[data-slot="truncated-path-${name}"]`)!;
}

/** Widths from `from` to `to`, stepping through fractions of a pixel. */
function* widthsBetween(from: number, to: number): Generator<number> {
  for (let width = from; width <= to; width += 0.37) yield width;
}

/** The leaf's text as laid out, wherever it is cut. */
function laidOutWidth(element: HTMLElement): number {
  return textNodesIn(element).reduce((width, node) => width + rangeRect(node).width, 0);
}

describe("TruncatedPath", () => {
  beforeEach(async () => {
    await page.viewport(1200, 900);
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("keeps a long name's start and its id in view at every width, cut at whole characters", async () => {
    const { box, path } = await renderPath({ path: CHAT_PATH, monospace: true });
    const leaf = slot(path, "leaf");
    const start = slot(path, "leaf-start");
    expect(leaf.textContent).toBe(CHAT_LEAF);
    expect(slot(path, "leaf-end").textContent).toBe("e-0fa11298");
    const charWidth = locateText(leaf, "0fa11298").rect.width / 8;
    const parentMin = parseFloat(getComputedStyle(slot(path, "parent")).minWidth);
    const fullLeaf = laidOutWidth(leaf);
    const fullStart = laidOutWidth(start);

    const failures: string[] = [];
    // From "…/" + "…" + the end, up to well past the whole path.
    for (const width of widthsBetween(parentMin + charWidth * 11, path.scrollWidth + 40)) {
      box.style.width = `${width}px`;
      const at = `at ${width.toFixed(2)}px`;
      if (!isShownWhole(path, "-0fa11298")) failures.push(`${at}: the id is cut`);
      const startWidth = start.getBoundingClientRect().width;
      if (width >= parentMin + fullLeaf + 0.01) {
        for (const node of textNodesIn(leaf)) {
          if (!isShownWhole(path, node.data))
            failures.push(`${at}: "${node.data}" cut though it fits`);
        }
        continue;
      }
      if (startWidth >= fullStart - 0.01) continue; // Within a hair of fitting: shown whole.
      // Cut in the middle: the start spans whole characters, so its "…" meets the end.
      const spare = startWidth - Math.floor(startWidth / charWidth + 0.01) * charWidth;
      if (spare > 0.5) failures.push(`${at}: ${spare.toFixed(2)}px between "…" and the end`);
      if (startWidth >= charWidth * 5 && !isShownWhole(path, "2026")) {
        failures.push(`${at}: the start is cut away`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps a name that fits whole while its parent folders shorten, in any font", async () => {
    const { box, path } = await renderPath({ path: CHAT_PATH, monospace: false });
    const leaf = slot(path, "leaf");
    const parentMin = parseFloat(getComputedStyle(slot(path, "parent")).minWidth);
    const fullLeaf = laidOutWidth(leaf);

    const failures: string[] = [];
    for (const width of widthsBetween(parentMin + fullLeaf + 0.01, path.scrollWidth)) {
      box.style.width = `${width}px`;
      for (const node of textNodesIn(leaf)) {
        if (!isShownWhole(path, node.data)) {
          failures.push(`at ${width.toFixed(2)}px: "${node.data}" cut though it fits`);
        }
      }
    }
    expect(failures).toEqual([]);
    // Narrower than the name, the end still stays: the cut is in the middle here too.
    box.style.width = `${parentMin + fullLeaf / 2}px`;
    expect(isShownWhole(path, "-0fa11298")).toBe(true);
  });

  it("splits a long name between whole characters and leaves a short one in one piece", async () => {
    // A decomposed "é" right at the cut stays with its accent.
    const decomposed = `${"a".repeat(15)}é123456789`;
    const { path } = await renderPath({ path: `/home/me/${decomposed}`, monospace: true });
    expect(slot(path, "leaf-end").textContent).toBe("é123456789");
    expect(slot(path, "leaf").textContent).toBe(decomposed);
    await mounted?.unmount();

    const short = await renderPath({ path: "/home/me/Code/plan-a-trip", monospace: true });
    expect(textNodesIn(slot(short.path, "leaf")).map((node) => node.data)).toEqual(["plan-a-trip"]);
  });
});
