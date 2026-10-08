import { describe, expect, it } from "vite-plus/test";

import {
  htmlRenderToolPresentation,
  resolveHtmlRenderToolKind,
  resolveHtmlRenderToolPresentation,
  withoutHtmlRenderMarkup,
} from "./htmlRenderToolPresentation.ts";

describe("resolveHtmlRenderToolKind", () => {
  it.each([
    ["ryco_html_render", "render"],
    ["ryco_html_preview", "preview"],
    ["mcp__ryco__ryco_html_render", "render"],
    ["mcp__ryco__ryco_html_preview", "preview"],
    ["mcp__ryco_agent_control__ryco_html_render", "render"],
    ["ryco_agent_control.ryco_html_render", "render"],
    ["ryco-ryco_html_preview", "preview"],
    ["ryco: ryco_html_render", "render"],
    ["Ryco/ryco_html_render", "render"],
    ["  MCP__RYCO__RYCO_HTML_RENDER  ", "render"],
  ] as const)("recognizes %s", (name, kind) => {
    expect(resolveHtmlRenderToolKind(name)).toBe(kind);
  });

  it.each([
    "mcp__other__ryco_html_render",
    "other.ryco_html_render",
    "mcp__ryco__ryco_html_render_extra",
    "mcp__ryco__ryco_attach_file",
    "html_render",
    "Write",
    "",
  ])("leaves %j to its own presentation", (name) => {
    expect(resolveHtmlRenderToolKind(name)).toBeUndefined();
  });

  it("checks a separately reported server", () => {
    expect(resolveHtmlRenderToolKind("ryco_html_render", "ryco_agent_control")).toBe("render");
    expect(resolveHtmlRenderToolKind("ryco_html_preview", "ryco")).toBe("preview");
    expect(resolveHtmlRenderToolKind("ryco_html_render", "browser")).toBeUndefined();
    expect(resolveHtmlRenderToolKind(undefined, "ryco")).toBeUndefined();
  });
});

describe("htmlRenderToolPresentation", () => {
  it("labels a render with its page title and a preview with its viewport", () => {
    expect(
      htmlRenderToolPresentation("render", {
        html: "<p>x</p>",
        title: "  Quarterly revenue ",
        height: 400,
      }),
    ).toEqual({ title: "Rendered HTML", detail: "Quarterly revenue" });
    expect(htmlRenderToolPresentation("preview", { html: "<p>x</p>" })).toEqual({
      title: "Previewed HTML",
      detail: "760px dark",
    });
    expect(
      htmlRenderToolPresentation("preview", {
        html: "<p>x</p>",
        width: 389.6,
        appearance: "light",
      }),
    ).toEqual({ title: "Previewed HTML", detail: "390px light" });
  });

  it("shows no detail before the input is known", () => {
    expect(htmlRenderToolPresentation("render", {})).toEqual({ title: "Rendered HTML" });
    expect(htmlRenderToolPresentation("preview", undefined)).toEqual({ title: "Previewed HTML" });
    expect(htmlRenderToolPresentation("render", { html: "<p>x</p>" })).toEqual({
      title: "Rendered HTML",
    });
  });

  it("never puts the page markup in the presentation", () => {
    const html = "<script>secret()</script>";
    const presentation = resolveHtmlRenderToolPresentation({
      toolName: "mcp__ryco__ryco_html_render",
      input: { html, title: "Chart", height: 300 },
    });
    expect(JSON.stringify(presentation)).not.toContain("secret");
    expect(
      resolveHtmlRenderToolPresentation({ toolName: "Bash", input: { command: "ls" } }),
    ).toBeUndefined();
  });
});

describe("withoutHtmlRenderMarkup", () => {
  it("replaces the page with its length and keeps the other arguments", () => {
    expect(withoutHtmlRenderMarkup({ html: "<p>hello</p>", title: "T", height: 200 })).toEqual({
      title: "T",
      height: 200,
      htmlChars: 12,
    });
    expect(withoutHtmlRenderMarkup({ html: 42, width: 390 })).toEqual({ width: 390 });
  });

  it("passes through values without a page", () => {
    const input = { title: "T" };
    expect(withoutHtmlRenderMarkup(input)).toBe(input);
    expect(withoutHtmlRenderMarkup("text")).toBe("text");
    expect(withoutHtmlRenderMarkup(null)).toBeNull();
  });
});
