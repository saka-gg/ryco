import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

const indexHtml = readFileSync(path.resolve(import.meta.dirname, "../../index.html"), "utf8");

describe("index.html", () => {
  it("keeps exactly one classic inline script", () => {
    // The build turns the inline module entry into a src script. Every other inline
    // script stays inline, and the hosted CSP allows exactly one, by hash.
    const classicInline = [...indexHtml.matchAll(/<script\b([^>]*)>/gi)].filter(
      ([, attributes = ""]) => !/\bsrc=/i.test(attributes) && !/\btype="module"/i.test(attributes),
    );
    expect(classicInline).toHaveLength(1);
  });

  it("sends no API request from the document head", () => {
    // The same document serves the standard, desktop and hosted builds, so a
    // head tag for an API URL would run in every one of them. The hosted access
    // check starts from the entry module instead, behind the hosted-mode check.
    const apiLinks = [...indexHtml.matchAll(/<link\b[^>]*\bhref=["']?\/api\//gi)];
    expect(apiLinks).toEqual([]);
    expect(indexHtml).not.toMatch(/\/api\/(?:auth\/session|nodes)\b/);
  });
});
