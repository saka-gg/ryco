import { describe, expect, it } from "vite-plus/test";

import {
  HTML_RENDER_DOCUMENT_CSP,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderMetadataEqual,
  htmlRenderOfAttachment,
  htmlRenderTheme,
  htmlRenderThumbnail,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  htmlRenderThemeWindowName,
  injectHtmlRenderBootstrap,
  isHtmlRenderEscape,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  readHtmlRenderMetadata,
  readHtmlRenderPointerInside,
  stripHtmlRenderBootstrap,
  upgradeHtmlRenderBootstrap,
} from "./htmlRender.ts";
import { RYCO_DARK_THEME_COLORS, RYCO_LIGHT_THEME_COLORS } from "./themePalettes.ts";

const metadata = { title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="ryco-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("carries its own referrer and content security policy", () => {
    const injected = injectHtmlRenderBootstrap("<p>hi</p>");
    expect(injected).toContain('<meta name="referrer" content="no-referrer">');
    expect(injected).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${HTML_RENDER_DOCUMENT_CSP}">`,
    );
    expect(HTML_RENDER_DOCUMENT_CSP).toContain("object-src 'none'");
    expect(HTML_RENDER_DOCUMENT_CSP).not.toContain("script-src");
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"])(
    "keeps the bootstrap outside %s content",
    (tag) => {
      const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
      const injected = injectHtmlRenderBootstrap(fragment);
      expect(injected.startsWith("<!doctype html><head>")).toBe(true);
      expect(injected.indexOf('<style id="ryco-theme">')).toBeLessThan(
        injected.indexOf(`<${tag}>`),
      );
      expect(injected).toContain('<meta name="viewport" content="width=device-width');
      expect(injected.endsWith(fragment)).toBe(true);
    },
  );

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="ryco-theme">')).toBeLessThan(
      injected.indexOf("<template>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="ryco-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });

  it("emits a bootstrap script that parses", () => {
    const injected = injectHtmlRenderBootstrap("<p>hi</p>");
    const script = /<script>([\s\S]*?)<\/script>/.exec(injected)?.[1];
    expect(script).toBeDefined();
    // Parsing (not running) proves the escaped regexes and strings survived templating.
    expect(() => new Function(script!)).not.toThrow();
    expect(script).toContain('"ryco-theme:"');
    expect(script).toContain("ui/notifications/size-changed");
  });
});

describe("readHtmlRenderLinkRequest", () => {
  const link = (url: unknown) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "ui/open-link",
    params: { url },
  });

  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
    });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("https://user:pw@example.com"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link(`https://example.com/${"a".repeat(9000)}`))).toBe(
      undefined,
    );
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderContentHeight", () => {
  it("accepts only positive finite size-changed heights", () => {
    const sized = (height: unknown) => ({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height },
    });
    expect(readHtmlRenderContentHeight(sized(412))).toBe(412);
    expect(readHtmlRenderContentHeight(sized(0))).toBeUndefined();
    expect(readHtmlRenderContentHeight(sized(Number.NaN))).toBeUndefined();
    expect(readHtmlRenderContentHeight(sized("412"))).toBeUndefined();
    expect(readHtmlRenderContentHeight({ method: "ui/notifications/size-changed" })).toBe(
      undefined,
    );
  });
});

describe("htmlRenderThemeMessage", () => {
  it("is an MCP Apps host-context-changed notification carrying the theme variables", () => {
    const theme = htmlRenderTheme(RYCO_DARK_THEME_COLORS, "dark");
    expect(htmlRenderThemeMessage(theme)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", styles: { variables: theme.variables } },
    });
  });
});

describe("htmlRenderTheme", () => {
  it("exposes the brand color as --accent and keeps the handoffs decodable", () => {
    const theme = htmlRenderTheme(RYCO_LIGHT_THEME_COLORS, "light");
    expect(theme.variables["--accent"]).toBe(RYCO_LIGHT_THEME_COLORS.primary);
    expect(theme.variables["--background"]).toBe(RYCO_LIGHT_THEME_COLORS.background);
    expect(theme.variables["--chart-6"]).toBeDefined();
    const fragment = htmlRenderThemeFragment(theme);
    expect(JSON.parse(decodeURIComponent(fragment.slice("#ryco-theme=".length)))).toEqual(theme);
    expect(fragment).not.toContain("&");
    const name = htmlRenderThemeWindowName(theme);
    expect(JSON.parse(name.slice("ryco-theme:".length))).toEqual(theme);
  });

  it("charts with the brand color only when it has a hue", () => {
    const grey = htmlRenderTheme(RYCO_DARK_THEME_COLORS, "dark");
    expect(grey.variables["--chart-1"]).toBe(RYCO_DARK_THEME_COLORS.info);
    const nord = htmlRenderTheme({ ...RYCO_DARK_THEME_COLORS, primary: "#88c0d0" }, "dark");
    expect(nord.variables["--chart-1"]).toBe("#88c0d0");
  });

  it("derives surfaces as plain sRGB colors a canvas accepts", () => {
    const theme = htmlRenderTheme(RYCO_DARK_THEME_COLORS, "dark");
    for (const name of [
      "--accent-surface",
      "--destructive-surface",
      "--warning-surface",
      "--code-background",
    ]) {
      expect(theme.variables[name]).toMatch(/^#[0-9a-f]{6}$/);
    }
    // 16% of #fb414a over #0b0b0c.
    expect(theme.variables["--destructive-surface"]).toBe("#311416");
  });

  it("falls back to color-mix for colors it cannot parse", () => {
    const theme = htmlRenderTheme(
      { ...RYCO_LIGHT_THEME_COLORS, warning: "oklch(0.77 0.17 65)" },
      "light",
    );
    expect(theme.variables["--warning-surface"]).toBe(
      "color-mix(in srgb, oklch(0.77 0.17 65) 8%, #ffffff)",
    );
  });

  it("takes the app's radius and fonts", () => {
    const theme = htmlRenderTheme(RYCO_LIGHT_THEME_COLORS, "light", {
      radius: "0.25rem",
      fonts: { sans: "Inter, sans-serif", mono: "JetBrains Mono, monospace" },
    });
    expect(theme.variables["--radius"]).toBe("0.25rem");
    expect(theme.variables["--font-sans"]).toBe("Inter, sans-serif");
    expect(theme.variables["--font-mono"]).toBe("JetBrains Mono, monospace");
  });
});

describe("readHtmlRenderMetadata", () => {
  it("clamps height and rejects malformed metadata", () => {
    expect(readHtmlRenderMetadata({ ...metadata, height: 99_999 })?.height).toBe(2000);
    expect(readHtmlRenderMetadata({ ...metadata, height: 1 })?.height).toBe(80);
    expect(readHtmlRenderMetadata({ ...metadata, title: "  " })?.title).toBe("HTML");
    expect(readHtmlRenderMetadata({ ...metadata, title: 4 })).toBeUndefined();
    expect(readHtmlRenderMetadata({ ...metadata, height: Number.NaN })).toBeUndefined();
    expect(readHtmlRenderMetadata(null)).toBeUndefined();
  });
});

describe("htmlRenderOfAttachment", () => {
  it("reads render metadata only from html file attachments", () => {
    const file = {
      type: "file",
      id: "thread-1-html",
      name: "Chart.html",
      mimeType: "text/html",
      sizeBytes: 10,
    };
    expect(htmlRenderOfAttachment({ ...file, htmlRender: metadata })).toEqual(metadata);
    expect(htmlRenderOfAttachment(file)).toBeUndefined();
    expect(
      htmlRenderOfAttachment({ ...file, mimeType: "text/plain", htmlRender: metadata }),
    ).toBeUndefined();
    expect(htmlRenderOfAttachment({ ...file, type: "image", htmlRender: metadata })).toBe(
      undefined,
    );
  });
});

describe("htmlRenderFrameHeight", () => {
  const measured = readHtmlRenderMetadata({
    ...metadata,
    height: 1500,
    heights: [
      [760, 1403],
      [390, 1290],
      [1000, 1660],
    ],
  })!;

  it("takes the taller neighbor between measured widths and holds the ends", () => {
    expect(measured.heights?.map(([width]) => width)).toEqual([390, 760, 1000]);
    expect(htmlRenderFrameHeight(measured, 760)).toBe(1403);
    expect(htmlRenderFrameHeight(measured, 559)).toBe(1403);
    expect(htmlRenderFrameHeight(measured, 320)).toBe(1290);
  });

  it("takes the taller layout when a breakpoint falls between measured widths", () => {
    // 900px tall below a 600px media query, 450px above it.
    const responsive = readHtmlRenderMetadata({
      ...metadata,
      height: 2000,
      heights: [
        [520, 900],
        [640, 450],
      ],
    })!;
    expect(htmlRenderFrameHeight(responsive, 590)).toBe(900);
    expect(htmlRenderFrameHeight(responsive, 640)).toBe(450);
  });

  it("fits the page's own reported height", () => {
    expect(htmlRenderFrameHeight(measured, 760, 1420)).toBe(1420);
    expect(htmlRenderFrameHeight(metadata, 760, 300)).toBe(300);
  });

  it("caps at the agent's height only when it asked for a scrolling frame", () => {
    const scrolling = readHtmlRenderMetadata({ ...metadata, height: 400, heights: [[760, 900]] })!;
    expect(htmlRenderFrameHeight(scrolling, 760, 900)).toBe(400);
    expect(htmlRenderFrameHeight(measured, 1400)).toBe(1660);
    expect(htmlRenderFrameHeight(metadata, 760)).toBe(metadata.height);
  });

  it("drops a malformed table and compares tables by value", () => {
    expect(readHtmlRenderMetadata({ ...metadata, heights: [[760, "x"]] })?.heights).toBe(undefined);
    const copy = readHtmlRenderMetadata(JSON.parse(JSON.stringify(measured)))!;
    expect(htmlRenderMetadataEqual(measured, copy)).toBe(true);
    expect(htmlRenderMetadataEqual(measured, { ...copy, heights: [[390, 1290]] })).toBe(false);
  });
});

describe("htmlRenderFileName", () => {
  it("keeps a readable name without path or reserved characters", () => {
    expect(htmlRenderFileName("Q3 / Q4: revenue?")).toBe("Q3 Q4 revenue.html");
    expect(htmlRenderFileName("   ")).toBe("Page.html");
  });
});

describe("stripHtmlRenderBootstrap", () => {
  it.each([
    "<!doctype html><html><head><title>t</title></head><body>x</body></html>",
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=1"></head><body>x</body></html>',
    "<html><body>no head</body></html>",
    "<!doctype html><p>doctype fragment</p>",
    "<p>bare fragment</p>",
  ])("gives back the page as written: %s", (page) => {
    expect(stripHtmlRenderBootstrap(injectHtmlRenderBootstrap(page))).toBe(
      page.startsWith("<p>") ? `<!doctype html>${page}` : page,
    );
  });

  it("leaves pages without this build's bootstrap alone", () => {
    const page = '<head><style id="ryco-theme">:root{}</style></head><p>x</p>';
    expect(stripHtmlRenderBootstrap(page)).toBe(page);
  });
});

describe("readHtmlRenderPointerInside", () => {
  it("reads only boolean pointer-changed notifications", () => {
    const pointer = (inside: unknown) => ({
      jsonrpc: "2.0",
      method: "ryco/notifications/pointer-changed",
      params: { inside },
    });
    expect(readHtmlRenderPointerInside(pointer(true))).toBe(true);
    expect(readHtmlRenderPointerInside(pointer(false))).toBe(false);
    expect(readHtmlRenderPointerInside(pointer("yes"))).toBeUndefined();
    expect(readHtmlRenderPointerInside({ method: "ryco/notifications/pointer-changed" })).toBe(
      undefined,
    );
  });

  it("is reported by the bootstrap of a framed page", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(injectHtmlRenderBootstrap("<p>x</p>"))?.[1];
    expect(script).toContain('"ryco/notifications/pointer-changed"');
  });
});

describe("isHtmlRenderEscape", () => {
  it("recognizes only the escape notification", () => {
    expect(isHtmlRenderEscape({ jsonrpc: "2.0", method: "ryco/notifications/escape" })).toBe(true);
    expect(isHtmlRenderEscape({ method: "ryco/notifications/escape" })).toBe(false);
    expect(isHtmlRenderEscape({ jsonrpc: "2.0", method: "ui/open-link" })).toBe(false);
    expect(isHtmlRenderEscape("escape")).toBe(false);
  });

  it("is reported by a framed page's bootstrap, which also announces theme changes", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(injectHtmlRenderBootstrap("<p>x</p>"))?.[1];
    expect(script).toContain('"ryco/notifications/escape"');
    expect(script).toContain('new Event("ryco-theme-change")');
  });
});

describe("thumbnails", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const webp = "data:image/webp;base64,UklGRg==";

  it("keeps only small image data URLs and picks one per appearance", () => {
    const render = readHtmlRenderMetadata({
      ...metadata,
      thumbnails: { dark: webp, light: png },
    })!;
    expect(render.thumbnails).toEqual({ dark: webp, light: png });
    expect(htmlRenderThumbnail(render, "light")).toBe(png);
    expect(htmlRenderThumbnail(render, "dark")).toBe(webp);
    const darkOnly = readHtmlRenderMetadata({ ...metadata, thumbnails: { dark: webp } })!;
    expect(htmlRenderThumbnail(darkOnly, "light")).toBe(webp);

    for (const bad of [
      "data:image/svg+xml;base64,PHN2Zz4=",
      "javascript:alert(1)",
      "https://example.com/a.png",
      `data:image/png;base64,${"A".repeat(48_001)}`,
      'data:image/png;base64,AA"><script>',
    ]) {
      expect(readHtmlRenderMetadata({ ...metadata, thumbnails: { dark: bad } })?.thumbnails).toBe(
        undefined,
      );
    }
    expect(htmlRenderThumbnail(metadata, "dark")).toBeUndefined();
  });

  it("tells renders apart by their thumbnails", () => {
    const a = readHtmlRenderMetadata({ ...metadata, thumbnails: { dark: webp } })!;
    const b = readHtmlRenderMetadata({ ...metadata, thumbnails: { dark: png } })!;
    expect(htmlRenderMetadataEqual(a, a)).toBe(true);
    expect(htmlRenderMetadataEqual(a, b)).toBe(false);
  });
});

describe("upgradeHtmlRenderBootstrap", () => {
  const page = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";

  it("leaves a page with this build's bootstrap, or none, unchanged", () => {
    const current = injectHtmlRenderBootstrap(page);
    expect(upgradeHtmlRenderBootstrap(current)).toBe(current);
    expect(upgradeHtmlRenderBootstrap(page)).toBe(page);
  });

  it("replaces an older build's bootstrap with this one", () => {
    const current = injectHtmlRenderBootstrap(page);
    const older = current
      .replace(
        /<style id="ryco-theme">[^<]*<\/style>/,
        '<style id="ryco-theme">:root{--old:1}</style>',
      )
      .replace(/<script>[\s\S]*?<\/script>/, "<script>window.oldBootstrap=1</script>");
    expect(older).not.toBe(current);
    expect(upgradeHtmlRenderBootstrap(older)).toBe(current);
    expect(stripHtmlRenderBootstrap(older)).toBe(page);
  });

  it("never touches look-alike markup outside the injected spot", () => {
    const lookAlike =
      '<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="x"><style id="ryco-theme">a</style><script>evil()</script>';
    const html = `<!doctype html><html><head><title>t</title></head><body>${lookAlike}</body></html>`;
    expect(upgradeHtmlRenderBootstrap(html)).toBe(html);
    expect(stripHtmlRenderBootstrap(html)).toBe(html);
  });

  it("keeps the latest theme in the frame name so a reload paints with it", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(injectHtmlRenderBootstrap(page))?.[1];
    expect(script).toContain('window.name="ryco-theme:"+JSON.stringify(');
    expect(script).not.toContain('window.name=""');
  });
});
