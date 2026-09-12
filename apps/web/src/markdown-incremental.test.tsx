import type { Root } from "mdast";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { createIncrementalMarkdownPlugin } from "./markdown-incremental";

function render(source: string, incremental?: Plugin<[], Root>, parsedSources?: string[]) {
  let tree: Root | undefined;
  const observe: Plugin<[], Root> = function () {
    const original = this.parser!;
    this.parser = (text, file) => {
      parsedSources?.push(text);
      return original(text, file);
    };
  };
  const capture: Plugin<[], Root> = () => (root) => {
    tree = structuredClone(root);
    // Downstream plugins may mutate any part of the tree; cached nodes must
    // remain pristine even across React retries and repeated document renders.
    root.children.push({ type: "paragraph", children: [{ type: "text", value: "transformed" }] });
  };
  const html = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, observe, ...(incremental ? [incremental] : []), capture]}
    >
      {source}
    </ReactMarkdown>,
  );
  return { tree, html };
}

const prefix = "# Complete\n\n```ts\nconst value = 1;\n```\n\n";

describe("incremental Markdown", () => {
  it.each([
    "*emphasis* and **strong** and `inline`",
    "Heading\n===\n\nnext\n---\n",
    "- first\n\n  continued\n\n- [x] task\n",
    "> quote\n>\n> ```js\n> nested\n> ```\n\nend",
    "<div>\nhello\n\n</div>\n\nend",
    "[link](https://example.com) ![image](./assets/a.png)",
    "[file](file:///repo/app.ts#L7) <https://example.com>",
    "a | b\n--|--\na | b\n",
    "```\nopen\n\ncode\n```\n\n~~~js\nmore\n~~~\n\nend",
    '```ryco-attachments\n{"files":[{"path":"output/a.png"}]}\n```\n\nend',
    "\n\n\tindented code\n\nend",
    "[later]\n\n[later]: /target",
    "note[^x]\n\n[^x]: footnote",
    "\uFEFFbyte-order mark",
  ])("matches whole-document HTML and source positions at every character: %j", (tail) => {
    const plugin = createIncrementalMarkdownPlugin();
    const source = prefix + tail;
    for (let end = 0; end <= source.length; end++) {
      const chunk = source.slice(0, end);
      expect(render(chunk, plugin), `character ${end}`).toEqual(render(chunk));
    }
  });

  it.each(["\r", "\r\n"])("preserves partial %j line endings", (newline) => {
    const source = (prefix + "next\n\n~~~\nlast\n~~~\n\nend").replaceAll("\n", newline);
    const plugin = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const chunk = source.slice(0, end);
      expect(render(chunk, plugin)).toEqual(render(chunk));
    }
  });

  it.each([
    "```\nopen\n\n",
    "````\n```\n\n",
    "> ```\n> code\n> ```\n\n",
    "- ```\n  code\n  ```\n\n",
    "    ```\n    code\n    ```\n\n",
    "<script>\n```\ncode\n```\n\n",
  ])("does not freeze unsafe fence boundaries: %j", (start) => {
    const plugin = createIncrementalMarkdownPlugin();
    for (const tail of ["", "text", "\n```\n", "\n```\n\nnext"]) {
      expect(render(start + tail, plugin)).toEqual(render(start + tail));
    }
  });

  it("resolves late references and footnotes in the previously cached prefix", () => {
    const plugin = createIncrementalMarkdownPlugin();
    const start = "[later] and footnote[^note]\n\n" + prefix;
    for (const tail of ["text", "[later]: /target", "[later]: /target\n\n[^note]: a note"]) {
      expect(render(start + tail, plugin)).toEqual(render(start + tail));
    }
  });

  it("handles replacement, truncation, retries and separate renderer caches", () => {
    const plugin = createIncrementalMarkdownPlugin();
    const other = createIncrementalMarkdownPlugin();
    for (const source of [
      prefix,
      prefix + "tail",
      prefix.slice(0, 20),
      "replacement",
      prefix.replace("1", "2"),
      prefix,
      prefix,
    ]) {
      expect(render(source, plugin)).toEqual(render(source));
      expect(render("other\n\n" + source, other)).toEqual(render("other\n\n" + source));
    }
  });

  it("reuses completed fences and advances the cache, reducing parser input by over 95%", () => {
    const plugin = createIncrementalMarkdownPlugin();
    const completed = Array.from(
      { length: 12 },
      (_, block) =>
        "```ts\n" +
        Array.from({ length: 30 }, (_, line) => `const v${block}_${line} = ${line};\n`).join("") +
        "```\n\n",
    ).join("");
    const parsed: string[] = [];
    render(completed, plugin, parsed);
    parsed.length = 0;
    let baselineCharacters = 0;
    for (let update = 1; update <= 120; update++) {
      const source = completed + "word ".repeat(update);
      baselineCharacters += source.length;
      expect(render(source, plugin, parsed)).toEqual(render(source));
    }
    const parsedCharacters = parsed.reduce((sum, source) => sum + source.length, 0);
    expect(parsed).toHaveLength(120);
    expect(parsed.every((source) => !source.includes("const v"))).toBe(true);
    expect(parsedCharacters / baselineCharacters).toBeLessThan(0.05);
    expect({ baselineCharacters, parsedCharacters }).toEqual({
      baselineCharacters: 808_140,
      parsedCharacters: 36_300,
    });

    render(completed + "tail\n\n~~~js\nnew block\n~~~\t\n\n", plugin);
    parsed.length = 0;
    render(completed + "tail\n\n~~~js\nnew block\n~~~\t\n\nend", plugin, parsed);
    expect(parsed).toEqual(["end"]);
  });
});
