import type { Root } from "mdast";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  buildStreamingMarkdownChildren,
  renderMarkdownBlock,
  splitMarkdownBlocks,
  type MarkdownBlock,
  type StreamingMarkdownChildren,
} from "./markdown-blocks";
import { createIncrementalMarkdownPlugin } from "./markdown-incremental";

// Samples exercising every construct the splitter must not cut through.
const CORPUS: Readonly<Record<string, string>> = {
  headings:
    "# Title\n\nIntro paragraph.\n\n## Part one\n\nBody one.\n\n### Part two\n\nBody two.\n",
  prose:
    "Intro with **bold**, `code`, [a link](https://example.com) and ~~strike~~.\n\nSecond paragraph\nwith a soft break.\n\n## Next\n\nSetext\n===\n\nMore *emphasis\nacross lines*.\n",
  fences:
    "Intro.\n\n```ts\nconst a = 1;\n\n# not a heading\n\n---\n```\n\nAfter code.\n\n~~~\nraw\n\n```\nstill raw\n~~~\n\n````md\n```\ninner\n```\n````\n\n## Done\n",
  fenceAfterFence: "```\na\n```\n```\nb\n```\nafter\n- item\n",
  unclosedFence: "## Start\n\n```js\nlet x = 1;\n\n# inside\n\n---\n",
  attachments:
    '## Files\n\n```ryco-attachments\n{"files":[{"path":"output/a.png"}]}\n```\n\nReady.\n',
  nestedLists:
    "- one\n- two\n\n  continued two\n\n  - nested a\n\n  - nested b\n- three\n\n1. Step\n\n   ```bash\n   npm i\n\n   npm test\n   ```\n\n2. Next step\n3. Last\n\n## After lists\n\n- [ ] open task\n- [x] done task\n\nText.\n",
  listFenceClosedByHeading:
    "- item\n\n  ```\n  code\n\n# heading\n  ```\n\n## later\n\n```\nopen\n\n# inside\n",
  tables:
    "| a | b |\n|---|---|\n| 1 | 2 |\n\n## Next\n\n| x | y | z |\n|---|---|\n| 3 | 4 | 5 |\n---\n\nAfter.\n",
  blockquotes:
    "> quote line\n>\n> # quoted heading\n\n# Real heading\n\n> lazy\ncontinuation\n> ```\n> code\n\n```\nfence after quote\n```\n\n---\n\nEnd.\n",
  dollars: "Before.\n\n$$\na = b\n$$\nafter dollars\n\n## Next\n\n$$x$$\n",
  htmlBlocks:
    "<details>\n<summary>More</summary>\n\n# inside details\n\n</details>\n\n## After\n\n<!--\n\n# hidden\n\n-->\n\n## Final\n",
  htmlLine: "## One\n\n<div>\n\n## Two\n\n<br>\n\n## Three\n",
  referenceLinks:
    "See [the docs][docs].\n\n## Section\n\nMore [docs].\n\n[docs]: https://example.com\n",
  footnotes: "Claim[^1].\n\n## Section\n\nText.\n\n[^1]: The note.\n",
  thematicBreaks:
    "Para one.\n\n---\n\nPara two.\n\n***\n\nPara three.\n\n___\n\nSetext\n---\n\n## End\n",
  indentedCode: "Text.\n\n    code line\n\n    # indented hash\n\n## Heading\n",
  lazyContinuation: "## Start\n\n- item\nlazy line\n\n## Heading\n\nText.\n",
  tabs: "## Start\n\n- item\n\tmore\n\n## Heading\n\n```go\nfunc main() {\n\tfmt.Println(1)\n}\n```\n\n## End\n",
  orderedInterrupt: "Paragraph\n3. not a list\n\n## Heading\n\n1. real\n2. list\n\n## End\n",
  tsIndexSignature:
    "## Types\n\n```ts\ninterface Bag {\n  [key: string]: number;\n}\n```\n\n## End\n",
  fileLinks:
    "## Links\n\n[one](./src/a.ts) and [two](file:///repo/other/a.ts#L7)\n\n## Images\n\n![diagram](./assets/a.png) <https://example.com>\n",
  carriageReturns: "# a\r\n\r\nbody\r\n\r\n# b\r\n\rmore",
  byteOrderMark: "# a\n\n\uFEFF# b\n\nbody",
};

const BASE_PLUGINS: PluggableList = [remarkGfm];

// ChatMarkdown's configuration: the tail also goes through the streaming
// renderer's prefix cache.
function chatMarkdownParser() {
  const tailPlugins: PluggableList = [remarkGfm, createIncrementalMarkdownPlugin()];
  const parsed: string[] = [];
  const parseBlock = (block: MarkdownBlock, _options: object, tail: boolean) => {
    parsed.push(block.text);
    return renderMarkdownBlock(block, { remarkPlugins: tail ? tailPlugins : BASE_PLUGINS });
  };
  return { parsed, parseBlock };
}

function wholeParse(text: string): readonly ReactNode[] {
  return renderMarkdownBlock({ text, offset: 0, line: 1 }, { remarkPlugins: BASE_PLUGINS });
}

// Element types, keys, props and the source positions of the `node` prop:
// everything React reconciles by and every renderer reads.
function elementShape(node: ReactNode): unknown {
  if (Array.isArray(node)) return node.map(elementShape);
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  const { children, node: hast, ...props } = node.props;
  return {
    type: typeof node.type === "string" ? node.type : String(node.type),
    key: node.key,
    props,
    position: (hast as { position?: unknown } | undefined)?.position,
    children: elementShape(children as ReactNode),
  };
}

const html = (children: readonly ReactNode[]) => renderToStaticMarkup(<>{children}</>);

type TopLevelRange = { start: number; end: number };

function topLevelRanges(text: string): TopLevelRange[] {
  const ranges: TopLevelRange[] = [];
  const capture = () => (tree: Root) => {
    for (const child of tree.children) {
      ranges.push({
        start: child.position?.start.offset ?? -1,
        end: child.position?.end.offset ?? -1,
      });
    }
  };
  ReactMarkdown({ children: text, remarkPlugins: [remarkGfm, capture] });
  return ranges;
}

function boundaries(blocks: readonly MarkdownBlock[]): number[] {
  return blocks.slice(1).map((block) => block.offset);
}

function expectValidBoundaries(text: string, blocks: readonly MarkdownBlock[]): void {
  const ranges = topLevelRanges(text);
  for (const boundary of boundaries(blocks)) {
    // Every boundary starts a top-level node and falls inside none.
    expect(ranges.some((range) => range.start === boundary)).toBe(true);
    expect(ranges.some((range) => range.start < boundary && boundary < range.end)).toBe(false);
  }
}

describe("splitMarkdownBlocks", () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    it(`reproduces "${name}" byte for byte and only splits between top-level blocks`, () => {
      const { blocks } = splitMarkdownBlocks(text);
      expect(blocks.map((block) => block.text).join("")).toBe(text);
      for (const block of blocks) {
        expect(text.slice(block.offset, block.offset + block.text.length)).toBe(block.text);
        expect(text.slice(0, block.offset).split("\n").length).toBe(block.line);
      }
      expectValidBoundaries(text, blocks);
    });

    it(`keeps settled "${name}" blocks stable while the text streams in`, () => {
      let previous = splitMarkdownBlocks("");
      for (let length = 1; length <= text.length; length += 1) {
        const prefix = text.slice(0, length);
        const resumed = splitMarkdownBlocks(prefix, previous);
        expect(resumed.blocks).toEqual(splitMarkdownBlocks(prefix).blocks);
        // Settled blocks of the shorter prefix stay settled, unchanged, unless
        // a definition arrived and the whole text falls back to one parse.
        const settled = previous.blocks.slice(0, -1);
        if (resumed.blocks.length > 1 || !/\]:/.test(prefix)) {
          expect(resumed.blocks.slice(0, settled.length)).toEqual(settled);
        }
        expectValidBoundaries(prefix, resumed.blocks);
        previous = resumed;
      }
    });
  }

  it("splits before headings, fences and breaks after a blank line, and after fences", () => {
    expect(splitMarkdownBlocks(CORPUS.fences!).blocks.map((block) => block.text)).toEqual([
      "Intro.\n\n",
      "```ts\nconst a = 1;\n\n# not a heading\n\n---\n```\n\n",
      "After code.\n\n",
      "~~~\nraw\n\n```\nstill raw\n~~~\n\n",
      "````md\n```\ninner\n```\n````\n\n",
      "## Done\n",
    ]);
    expect(splitMarkdownBlocks(CORPUS.fenceAfterFence!).blocks.map((block) => block.text)).toEqual([
      "```\na\n```\n",
      "```\nb\n```\n",
      "after\n- item\n",
    ]);
  });

  it("splits prose answers at headings and thematic breaks, not between paragraphs", () => {
    const text = CORPUS.thematicBreaks!;
    expect(boundaries(splitMarkdownBlocks(text).blocks)).toEqual([
      text.indexOf("---"),
      text.indexOf("***"),
      text.indexOf("___"),
      text.indexOf("## End"),
    ]);
    expect(boundaries(splitMarkdownBlocks(CORPUS.prose!).blocks)).toEqual([
      CORPUS.prose!.indexOf("## Next"),
    ]);
  });

  it("never splits lists, list fences, tables, quotes or HTML blocks", () => {
    expect(boundaries(splitMarkdownBlocks(CORPUS.nestedLists!).blocks)).toEqual([
      CORPUS.nestedLists!.indexOf("## After lists"),
    ]);
    const tableText = CORPUS.tables!;
    expect(boundaries(splitMarkdownBlocks(tableText).blocks)).toEqual([
      tableText.indexOf("## Next"),
    ]);
    // HTML blocks that can span blank lines stop all further splitting.
    expect(splitMarkdownBlocks(CORPUS.htmlBlocks!).blocks).toHaveLength(1);
    // Single-line HTML blocks end at their blank line.
    expect(splitMarkdownBlocks(CORPUS.htmlLine!).blocks).toHaveLength(3);
  });

  it("treats dollar signs as text: Ryco renders no math blocks", () => {
    // `$$` neither opens a block nor ends one, so `after dollars` stays in the
    // paragraph it continues.
    const text = CORPUS.dollars!;
    expect(boundaries(splitMarkdownBlocks(text).blocks)).toEqual([text.indexOf("## Next")]);
  });

  it("does not split at a heading that closes a list item's fence, and tracks the next fence", () => {
    // On its own the item's fence would keep the blank line before the heading.
    // The indented fence after the heading is top-level; it swallows `## later`.
    const text = CORPUS.listFenceClosedByHeading!;
    expect(boundaries(splitMarkdownBlocks(text).blocks)).toEqual([
      text.indexOf("open\n"),
      text.indexOf("# inside"),
    ]);
  });

  it("does not split text with definitions, carriage returns or a byte order mark", () => {
    for (const name of ["referenceLinks", "footnotes", "carriageReturns", "byteOrderMark"]) {
      expect(splitMarkdownBlocks(CORPUS[name]!).blocks, name).toHaveLength(1);
    }
    // A definition that is still streaming in counts once its `]:` arrived.
    expect(splitMarkdownBlocks("## a\n\nb\n\n## c\n\n[x").blocks).toHaveLength(2);
    expect(splitMarkdownBlocks("## a\n\nb\n\n## c\n\n[x]:").blocks).toHaveLength(1);
    // Inside fenced code, `[key: string]:` is code, not a definition.
    expect(splitMarkdownBlocks(CORPUS.tsIndexSignature!).blocks.length).toBeGreaterThan(1);
  });

  it("stops splitting after lines it cannot classify with certainty", () => {
    for (const name of ["lazyContinuation", "tabs", "orderedInterrupt"]) {
      const { blocks } = splitMarkdownBlocks(CORPUS[name]!);
      // Whatever settled before the uncertain line stays settled.
      expect(blocks.length, name).toBeLessThanOrEqual(2);
      expect(blocks.at(-1)!.text, name).toContain("## Heading");
    }
  });
});

const FUZZ_LINES = [
  ["", "", "", "", "", "", "# H", "## H2", "text", "more *text*", "a **b** `c`", "- a", "- b"],
  ["  - c", "  text", "    code", "1. one", "2. two", "3) three", "   x", "```", "```js"],
  ["  ```", "   ```", "~~~", "````", "$$", "$$ x", "> q", ">", "> ```", "> # h", "---", "***"],
  ["___", "* * *", "| a | b |", "|---|---|", "<div>", "</div>", "<!--", "-->", "<br>", "==="],
  ["-", "1.", "+ p", "      deep", "\tTab", "- ```", "- # h", "- > q", "  > q", "[x](y)"],
  ["[f](./src/a.ts)", "[r]", "[r]: /target", "note[^1]", "[^1]: n", "*", "10. ten"],
  ["- [ ] task", "- [x] done", "www.example.com", "~~gone~~", "\uFEFFbom", "  code", "  ```"],
  ["   ~~~", "```` x", "#", "####### seven", " # h", "--- x"],
].flat();
// Without definitions, byte order marks, tabs, HTML and empty list items.
const SPLITTABLE_FUZZ_LINES = FUZZ_LINES.filter(
  (line) => !/^(?:\uFEFF|\t|<|-$|1\.$)/.test(line) && !line.includes("]:"),
);

/**
 * Streams `text` into the builder one prefix at a time, checking each against a
 * whole parse. Returns how many prefixes it checked and how many were split.
 */
function expectStreamingParity(
  text: string,
  step: (end: number) => number = () => 1,
): { checked: number; split: number } {
  const { parseBlock } = chatMarkdownParser();
  let previous: StreamingMarkdownChildren<object> | null = null;
  let checked = 0;
  let split = 0;
  for (let end = 0; end <= text.length; end += step(end)) {
    const prefix = text.slice(0, end);
    const result: StreamingMarkdownChildren<object> = buildStreamingMarkdownChildren(
      previous,
      prefix,
      true,
      {},
      parseBlock,
    );
    // Equal element trees render equal markup; the shape also covers keys and
    // the source positions renderers receive.
    expect(elementShape(result.children), JSON.stringify(prefix)).toEqual(
      elementShape(wholeParse(prefix)),
    );
    previous = result;
    checked += 1;
    if (result.blocks.length > 1) split += 1;
  }
  return { checked, split };
}

describe("buildStreamingMarkdownChildren", () => {
  it.each(Object.entries(CORPUS))(
    "renders %s like a single parse at every character, keys and positions included",
    (_name, text) => {
      expectStreamingParity(text);
    },
  );

  // 8 seeds x 4,096 = 32,768 fuzzed streaming prefixes. Seeded so a failure
  // reproduces; each line is a construct the scanner has to classify (or give
  // up on) correctly.
  it.each([7, 11, 13, 17, 19, 23, 29, 31])(
    "renders 4,096 fuzzed streaming prefixes like a single parse (seed %i)",
    (initialSeed) => {
      let seed = initialSeed;
      const random = () => {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      let prefixes = 0;
      let splitPrefixes = 0;
      while (prefixes < 4_096) {
        const count = 3 + Math.floor(random() * 25);
        // Half the documents leave out the lines that stop all splitting, and
        // half space their lines with the blank lines split points need.
        const vocabulary = random() < 0.5 ? FUZZ_LINES : SPLITTABLE_FUZZ_LINES;
        const blankRate = random() < 0.5 ? 0 : 0.5;
        const text = Array.from({ length: count }, () => {
          const line = vocabulary[Math.floor(random() * vocabulary.length)]!;
          return random() < blankRate ? `${line}\n` : line;
        }).join("\n");
        const { checked, split } = expectStreamingParity(text, () => 1 + Math.floor(random() * 3));
        prefixes += checked;
        splitPrefixes += split;
      }
      // Most fuzzed documents hold a line that stops all splitting.
      expect(splitPrefixes).toBeGreaterThan(400);
    },
    15_000,
  );

  it("matches a single parse when splitting starts or stops mid-stream", () => {
    const { parseBlock } = chatMarkdownParser();
    const text = CORPUS.headings! + CORPUS.fences!;
    let previous: StreamingMarkdownChildren<object> | null = null;
    for (let end = 0; end <= text.length; end += 5) {
      const prefix = text.slice(0, end);
      previous = buildStreamingMarkdownChildren(previous, prefix, end % 3 !== 0, {}, parseBlock);
      expect(elementShape(previous.children)).toEqual(elementShape(wholeParse(prefix)));
    }
  });

  // A ~30 KB prose answer: sections of paragraphs, lists, quotes and links.
  const proseAnswer = (() => {
    let text = "";
    for (let section = 1; text.length < 30_000; section += 1) {
      const paragraph = (n: number) =>
        `Paragraph ${n} of section ${section} explains **why**, with \`code\` and a ` +
        `[link](https://example.com/${section}/${n}) in prose that runs as long as a real one does.`;
      text += [
        `## Section ${section}`,
        paragraph(1),
        paragraph(2),
        "- First point\n- Second point with `code`\n- Third point",
        paragraph(3),
        `> A quote closing section ${section}.`,
      ].join("\n\n");
      text += "\n\n";
    }
    return text.slice(0, 30_000);
  })();

  it("parses a streaming 30 KB prose answer's settled blocks once, 98% less parser input", () => {
    const { parsed, parseBlock } = chatMarkdownParser();
    let result: StreamingMarkdownChildren<object> | null = null;
    let wholeCharacters = 0;
    let updates = 0;
    const settledIdentity = new Map<number, readonly ReactNode[]>();
    for (let end = 24; end < proseAnswer.length + 24; end += 24) {
      const text = proseAnswer.slice(0, Math.min(end, proseAnswer.length));
      result = buildStreamingMarkdownChildren(result, text, true, {}, parseBlock);
      wholeCharacters += text.length;
      updates += 1;
      // A settled block keeps its element objects: React skips it.
      for (const block of result.blocks.slice(0, -1)) {
        const known = settledIdentity.get(block.block.offset);
        if (known) expect(block.keyed).toBe(known);
        else settledIdentity.set(block.block.offset, block.keyed);
      }
    }
    const parsedCharacters = parsed.reduce((sum, text) => sum + text.length, 0);
    expect(result!.blocks.length).toBeGreaterThan(50);
    expect(parsed.length).toBeLessThan(updates + result!.blocks.length);
    expect(parsedCharacters / wholeCharacters).toBeLessThan(0.025);
    expect({ updates, wholeCharacters, parsedCharacters }).toEqual({
      updates: 1250,
      wholeCharacters: 18_765_000,
      parsedCharacters: 373_059,
    });
    expect(html(result!.children)).toBe(html(wholeParse(proseAnswer)));
  });

  it("re-parses every block when the options change, and every call without splitting", () => {
    const { parsed, parseBlock } = chatMarkdownParser();
    const text = CORPUS.headings!;
    const first = buildStreamingMarkdownChildren(null, text, true, { components: 1 }, parseBlock);
    const blockCount = first.blocks.length;
    expect(blockCount).toBe(3);
    expect(buildStreamingMarkdownChildren(first, text, true, { components: 1 }, parseBlock)).toBe(
      first,
    );
    parsed.length = 0;
    const changed = buildStreamingMarkdownChildren(
      first,
      text,
      true,
      { components: 2 },
      parseBlock,
    );
    expect(parsed).toHaveLength(blockCount);
    parsed.length = 0;
    // Renderers may read render-time state (the search highlight cursor), so
    // a whole-text render never reuses elements, even for the same text.
    const whole = buildStreamingMarkdownChildren(
      changed,
      text,
      false,
      { components: 2 },
      parseBlock,
    );
    const again = buildStreamingMarkdownChildren(whole, text, false, { components: 2 }, parseBlock);
    expect(parsed).toEqual([text, text]);
    expect(again.children[0]).not.toBe(whole.children[0]);
  });
});
