import { afterEach, describe, expect, it } from "vite-plus/test";

import type { DiffSearchMatch } from "~/lib/diffSearch";

import {
  diffSearchHighlightCss,
  findDiffSearchRanges,
  findRenderedDiffLineElement,
  hasRenderedDiffRows,
  indexMatchesByRenderedLine,
} from "./diffSearchDom";

/*
 * Pierre's DOM, built by hand: a `[data-diff-file-index]` file holding a
 * `diffs-container` whose open shadow root has rows
 * `[data-line][data-line-index="<stacked>,<split>"][data-line-type]`, each with
 * a line-number cell the search must skip.
 */

interface Row {
  readonly stacked: number;
  readonly split: number;
  readonly type: string;
  readonly text: string;
}

/** `oldName` removed, `newName = oldName` added, one context line around them. */
const ROWS: readonly Row[] = [
  { stacked: 0, split: 0, type: "context", text: "const keep = 1;" },
  { stacked: 1, split: 1, type: "change-deletion", text: "const oldName = 2;" },
  { stacked: 2, split: 1, type: "change-addition", text: "const newName = oldName;" },
  { stacked: 3, split: 2, type: "context", text: "const tail = oldName;" },
];

function line(
  field: DiffSearchMatch["field"],
  stacked: number,
  split: number,
  start: number,
  end: number,
): DiffSearchMatch {
  return {
    fileIndex: 0,
    field,
    lineIndex: stacked,
    unifiedLineIndex: stacked,
    splitLineIndex: split,
    start,
    end,
  };
}

/** Every `oldName` of ROWS. */
const MATCHES: readonly DiffSearchMatch[] = [
  line("deletion", 1, 1, 6, 13),
  line("addition", 2, 1, 16, 23),
  line("context", 3, 2, 13, 20),
];

function mountFile(rows: readonly Row[], fileIndex = 0) {
  const viewport = document.createElement("div");
  viewport.style.cssText = "height: 400px; overflow: auto; font: 14px monospace;";
  const file = document.createElement("div");
  file.dataset.diffFileIndex = String(fileIndex);
  const container = document.createElement("diffs-container");
  const shadow = container.attachShadow({ mode: "open" });
  for (const row of rows) {
    const element = document.createElement("div");
    element.setAttribute("data-line", "");
    element.setAttribute("data-line-index", `${row.stacked},${row.split}`);
    element.setAttribute("data-line-type", row.type);
    const number = document.createElement("span");
    number.setAttribute("data-line-number-content", "");
    number.textContent = String(row.stacked + 1);
    // Tokens split the text over several nodes, as the highlighter does.
    const [head, ...rest] = row.text.split(" ");
    const first = document.createElement("span");
    first.textContent = `${head} `;
    const second = document.createElement("span");
    second.textContent = rest.join(" ");
    element.append(number, first, second);
    shadow.append(element);
  }
  file.append(container);
  viewport.append(file);
  document.body.append(viewport);
  return { viewport, file, shadow };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findDiffSearchRanges", () => {
  it("paints every match on its stacked row and the current one apart", () => {
    const { viewport } = mountFile(ROWS);
    const ranges = findDiffSearchRanges({
      rootElement: viewport,
      viewportElement: viewport,
      matchesByFileIndex: new Map([[0, MATCHES]]),
      renderMode: "stacked",
      current: MATCHES[1]!,
    });
    expect(ranges.match.map((range) => range.toString())).toEqual(["oldName", "oldName"]);
    expect(ranges.current.map((range) => range.toString())).toEqual(["oldName"]);
    const currentRow = ranges.current[0]!.startContainer.parentElement!.closest("[data-line]");
    expect(currentRow?.getAttribute("data-line-type")).toBe("change-addition");
  });

  it("maps split rows by their split index and line type", () => {
    // Split rows: the removed and added lines share split index 1, one per column.
    const { viewport } = mountFile([
      ROWS[0]!,
      ROWS[1]!,
      { ...ROWS[2]!, stacked: 2, split: 1 },
      ROWS[3]!,
    ]);
    const ranges = findDiffSearchRanges({
      rootElement: viewport,
      viewportElement: viewport,
      matchesByFileIndex: new Map([[0, MATCHES]]),
      renderMode: "split",
      current: MATCHES[0]!,
    });
    expect(ranges.current).toHaveLength(1);
    expect(
      ranges.current[0]!.startContainer.parentElement!.closest("[data-line]")?.getAttribute(
        "data-line-type",
      ),
    ).toBe("change-deletion");
    expect(ranges.match).toHaveLength(2);
    expect(
      ranges.match.map((range) =>
        range.startContainer.parentElement!.closest("[data-line]")?.getAttribute("data-line-type"),
      ),
    ).toEqual(["change-addition", "context"]);
  });

  it("finds the current match by value, not object identity", () => {
    const { viewport } = mountFile(ROWS);
    // A re-search builds new match objects for the same text.
    const sameMatch = { ...MATCHES[2]! };
    const ranges = findDiffSearchRanges({
      rootElement: viewport,
      viewportElement: viewport,
      matchesByFileIndex: new Map([[0, MATCHES]]),
      renderMode: "stacked",
      current: sameMatch,
    });
    expect(ranges.current).toHaveLength(1);
    expect(
      ranges.current[0]!.startContainer.parentElement!.closest("[data-line]")?.getAttribute(
        "data-line-type",
      ),
    ).toBe("context");
  });

  it("skips files without matches and rows that are not rendered", () => {
    const { viewport } = mountFile(ROWS.slice(0, 2));
    const ranges = findDiffSearchRanges({
      rootElement: viewport,
      viewportElement: viewport,
      matchesByFileIndex: new Map([
        [0, MATCHES],
        [1, MATCHES],
      ]),
      renderMode: "stacked",
      current: MATCHES[2]!,
    });
    expect(ranges.match.map((range) => range.toString())).toEqual(["oldName"]);
    expect(ranges.current).toEqual([]);
  });

  it("reuses the row maps it is given", () => {
    const { viewport } = mountFile(ROWS);
    const lineMaps = new Map<number, ReadonlyMap<number, readonly DiffSearchMatch[]>>();
    const input = {
      rootElement: viewport,
      viewportElement: viewport,
      matchesByFileIndex: new Map([[0, MATCHES]]),
      renderMode: "stacked" as const,
      current: null,
      lineMaps,
    };
    findDiffSearchRanges(input);
    const built = lineMaps.get(0);
    expect(built).toBeDefined();
    findDiffSearchRanges(input);
    expect(lineMaps.get(0)).toBe(built);
  });
});

describe("indexMatchesByRenderedLine", () => {
  it("groups line matches by the rendered row of the layout and skips paths", () => {
    const path: DiffSearchMatch = { fileIndex: 0, field: "path", start: 0, end: 3 };
    expect([...indexMatchesByRenderedLine([...MATCHES, path], "stacked").keys()]).toEqual([
      1, 2, 3,
    ]);
    const split = indexMatchesByRenderedLine(MATCHES, "split");
    expect(split.get(1)).toHaveLength(2);
    expect(split.get(2)).toHaveLength(1);
  });
});

describe("findRenderedDiffLineElement", () => {
  it("finds the row of a match and reports rendered rows", () => {
    const { file, shadow } = mountFile(ROWS);
    expect(hasRenderedDiffRows(file)).toBe(true);
    expect(
      findRenderedDiffLineElement({ fileElement: file, match: MATCHES[1]!, renderMode: "split" }),
    ).toBe(shadow.querySelectorAll("[data-line]")[2]);
    shadow.replaceChildren();
    expect(hasRenderedDiffRows(file)).toBe(false);
  });
});

describe("diffSearchHighlightCss", () => {
  it("styles the match and, unless left out, the current match", () => {
    expect(diffSearchHighlightCss("ryco-test")).toContain("::highlight(ryco-test-match)");
    expect(diffSearchHighlightCss("ryco-test")).toContain("::highlight(ryco-test-current)");
    expect(diffSearchHighlightCss("ryco-test", { current: false })).not.toContain("-current");
  });
});
