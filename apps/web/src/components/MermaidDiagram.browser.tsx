import "../index.css";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { MermaidDiagram } from "./MermaidDiagram";
import { cachedMermaid, renderMermaid } from "../lib/mermaidRenderer";
import { sanitizeMermaidSvg } from "../lib/mermaidEngine";

it("renders actual flowcharts and sequences, isolates SVG and toggles original source", async () => {
  const source = "flowchart LR\nA[Start] --> B{Ready?}\nB --> C[Done]";
  const screen = await render(
    <MermaidDiagram source={source} theme="light" fallback={<pre>{source}</pre>} />,
  );
  await expect.element(page.getByRole("img")).toBeVisible();
  const image = document.querySelector("img")!;
  expect(image.naturalWidth).toBeGreaterThan(0);
  expect(document.querySelector(".chat-markdown-mermaid svg")).toBeNull();
  await screen.getByRole("button", { name: "Show source" }).click();
  await expect.element(screen.getByText(source)).toBeVisible();
  await screen.getByRole("button", { name: "Show diagram" }).click();
  await expect.element(page.getByRole("img")).toBeVisible();
  const sequence = await renderMermaid(
    "sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Hi",
    "dark",
    () => true,
  );
  expect(sequence?.src).toContain("data:image/svg+xml");
});

it("sanitizes active SVG and rejects external CSS resources", () => {
  const result = sanitizeMermaidSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="alert(1)"><script>alert(1)</script><foreignObject><p>bad</p></foreignObject><a href="javascript:alert(1)"><text>label</text></a><image href="https://invalid.test/x"/><path d="M0 0"/></svg>',
  );
  const svg = decodeURIComponent(result.src.split(",")[1]!);
  expect(svg).not.toMatch(/script|foreignObject|onload|href|<image/);
  for (const css of [
    '@import "https://invalid.test";',
    "path{fill:url(https://invalid.test/x)}",
    "path{fill:u\\72l(https://invalid.test)}",
  ]) {
    expect(() =>
      sanitizeMermaidSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>${css}</style></svg>`,
      ),
    ).toThrow();
  }
});

it("serializes themes, deduplicates, skips abandoned jobs and recovers after syntax failures", async () => {
  const source = "flowchart TD\nCacheA-->CacheB";
  const first = renderMermaid(source, "light", () => true);
  const duplicate = renderMermaid(source, "light", () => true);
  expect(duplicate).toBe(first);
  let active = true;
  const stale = renderMermaid("flowchart TD\nStaleA-->StaleB", "light", () => active);
  active = false;
  const dark = renderMermaid(source, "dark", () => true);
  const [lightImage, staleImage, darkImage] = await Promise.all([first, stale, dark]);
  expect(staleImage).toBeNull();
  expect(lightImage?.src).not.toBe(darkImage?.src);
  expect(cachedMermaid(source, "light")).toBe(lightImage);
  await expect(renderMermaid("flowchart TD\nA[unfinished", "light", () => true)).rejects.toThrow();
  expect(await renderMermaid("flowchart TD\nRecovered-->OK", "light", () => true)).not.toBeNull();
  expect(document.querySelector('[id^="dmermaid"], [id^="dryco-mermaid"]')).toBeNull();
});

it("qualifies bounded dense graphs and sequence input with the real renderer", async () => {
  const cases = [
    `flowchart TD\n${Array.from({ length: 80 }, (_, i) => `N${i}-->N${i + 1}`).join("\n")}`,
    `flowchart LR\n${Array.from({ length: 90 }, (_, i) => `N${i % 10}-->N${10 + Math.floor(i / 10)}`).join("\n")}`,
    `sequenceDiagram\n${Array.from({ length: 90 }, (_, i) => `A->>B: Message ${i}`).join("\n")}`,
  ];
  for (const source of cases) {
    const start = performance.now();
    const image = await renderMermaid(source, "light", () => true);
    const elapsed = performance.now() - start;
    console.info("Mermaid qualification", {
      characters: source.length,
      elapsedMs: Math.round(elapsed),
    });
    expect(image).not.toBeNull();
    // A generous regression ceiling, not a preemptive timeout or UI latency claim.
    expect(elapsed).toBeLessThan(3000);
  }
  expect(
    await renderMermaid("flowchart TD\nA[<script>alert(1)</script>]", "light", () => true),
  ).toBeNull();
});

it("rejects over-budget edges and hostile labels without requests or active DOM", async () => {
  performance.setResourceTimingBufferSize(5000);
  performance.clearResourceTimings();
  const originalAlert = window.alert;
  let alerted = false;
  window.alert = () => {
    alerted = true;
  };
  try {
    const sources = [
      'flowchart TD\nA["#60;img src=https://mermaid-hostile.invalid/x onerror=alert(1)#62;"]',
      "sequenceDiagram\nA->>B: <img src=https://mermaid-hostile.invalid/x onerror=alert(1)>",
      'flowchart TD\nA-->B\nclick A "javascript:alert(1)"',
      'flowchart TD\n%%{init: {"securityLevel":"loose", "themeCSS":"@import url(https://mermaid-hostile.invalid/x)"}}%%\nA-->B',
      'flowchart TD\nA["#60;img src=x onerror=alert(1)#62;"]',
    ];
    for (const source of sources) {
      const result = await renderMermaid(source, "light", () => true);
      if (result) {
        const img = new Image();
        img.src = result.src;
        await img.decode();
      }
    }
    expect(alerted).toBe(false);
    expect(
      performance
        .getEntriesByType("resource")
        .filter(
          (entry) => entry.name.includes("mermaid-hostile.invalid") || entry.name.endsWith("/x"),
        ),
    ).toEqual([]);
    const edges = `flowchart TD\n${Array.from({ length: 101 }, (_, i) => `Budget${i}-->Budget${i + 1}`).join("\n")}`;
    await expect(renderMermaid(edges, "light", () => true)).rejects.toThrow();
    expect(await renderMermaid(edges, "light", () => true)).toBeNull();
    expect(document.querySelector('[id^="dryco-mermaid"]')).toBeNull();
  } finally {
    window.alert = originalAlert;
  }
});

it("does not render an offscreen block until it approaches the viewport", async () => {
  const source = "flowchart TD\nOffscreen-->Visible";
  const screen = await render(
    <div style={{ paddingTop: 5000 }}>
      <MermaidDiagram source={source} theme="light" fallback={<pre>{source}</pre>} />
    </div>,
  );
  expect(cachedMermaid(source, "light")).toBeNull();
  expect(document.querySelector(".chat-markdown-mermaid img")).toBeNull();
  document.querySelector(".chat-markdown-mermaid")?.scrollIntoView();
  await expect.element(screen.getByRole("img")).toBeVisible();
  window.scrollTo(0, 0);
});
