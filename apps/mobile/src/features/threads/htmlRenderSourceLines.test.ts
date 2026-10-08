import { injectHtmlRenderBootstrap } from "@ryco/shared/htmlRender";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHtmlRenderSourceLines,
  HTML_RENDER_SOURCE_MAX_CHARS,
  HTML_RENDER_SOURCE_ROW_CHARS,
} from "./htmlRenderSourceLines";

describe("buildHtmlRenderSourceLines", () => {
  it("shows the page as the agent wrote it, without Ryco's bootstrap", () => {
    const page = "<!doctype html>\n<html><head><title>t</title></head>\n<body>x</body></html>\n";
    const { rows, truncated } = buildHtmlRenderSourceLines(injectHtmlRenderBootstrap(page));
    expect(rows).toEqual([
      "<!doctype html>",
      "<html><head><title>t</title></head>",
      "<body>x</body></html>",
    ]);
    expect(rows.join("\n")).not.toContain("ryco-theme");
    expect(truncated).toBe(false);
  });

  it("keeps blank lines and every line ending", () => {
    expect(buildHtmlRenderSourceLines("a\r\n\rb\nc").rows).toEqual(["a", "", "b", "c"]);
    expect(buildHtmlRenderSourceLines("").rows).toEqual([""]);
  });

  it("splits a long line into rows that join back to it", () => {
    const image = `<img src="data:image/png;base64,${"A".repeat(5_000)}">`;
    const { rows } = buildHtmlRenderSourceLines(`<p>\n${image}\n</p>`);
    expect(rows[0]).toBe("<p>");
    expect(rows.at(-1)).toBe("</p>");
    const middle = rows.slice(1, -1);
    expect(middle.length).toBe(Math.ceil(image.length / HTML_RENDER_SOURCE_ROW_CHARS));
    expect(middle.every((row) => row.length <= HTML_RENDER_SOURCE_ROW_CHARS)).toBe(true);
    expect(middle.join("")).toBe(image);
  });

  it("never splits a character in two", () => {
    const line = `${"a".repeat(HTML_RENDER_SOURCE_ROW_CHARS - 1)}😀${"b".repeat(10)}`;
    const { rows } = buildHtmlRenderSourceLines(line);
    expect(rows).toEqual(["a".repeat(HTML_RENDER_SOURCE_ROW_CHARS - 1), `😀${"b".repeat(10)}`]);
  });

  it("shows only the start of a source longer than the cap", () => {
    const source = `${"x".repeat(HTML_RENDER_SOURCE_MAX_CHARS - 1)}😀tail`;
    const { rows, truncated } = buildHtmlRenderSourceLines(source);
    expect(truncated).toBe(true);
    const shown = rows.join("");
    expect(shown).toBe("x".repeat(HTML_RENDER_SOURCE_MAX_CHARS - 1));
    expect(shown).not.toContain("tail");
  });
});
