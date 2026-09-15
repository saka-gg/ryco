// This entire module is lazy. Neither Mermaid nor the sanitizer belongs in the entry graph.
import mermaid from "mermaid";
import DOMPurify from "dompurify";
import { MERMAID_LIMITS } from "./mermaidPolicy";
import type { MermaidImage, MermaidTheme } from "./mermaidRenderer";

/** Sanitize before encoding as an inert SVG image; never insert diagram HTML into the app. */
export function sanitizeMermaidSvg(svg: string): MermaidImage {
  if (svg.length > 1_000_000) throw new Error("Diagram output too large");
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true },
    FORBID_TAGS: [
      "foreignObject",
      "a",
      "image",
      "use",
      "animate",
      "animateMotion",
      "animateTransform",
      "set",
    ],
    FORBID_ATTR: ["href", "xlink:href", "tabindex"],
  });
  const doc = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = doc.documentElement;
  if (root.localName !== "svg" || doc.querySelector("parsererror"))
    throw new Error("Invalid diagram SVG");
  for (const element of [root, ...root.querySelectorAll("*")]) {
    const css =
      element.localName === "style"
        ? (element.textContent ?? "")
        : (element.getAttribute("style") ?? "");
    // Only local marker/gradient references are permitted in generated CSS.
    if (/@(?!keyframes\b)|\\|url\s*\(\s*(?!#[\w-]+\s*\))/i.test(css))
      throw new Error("Unsafe diagram CSS");
    for (const attribute of element.attributes) {
      if (/url\s*\(\s*(?!#[\w-]+\s*\))/i.test(attribute.value))
        throw new Error("Unsafe diagram resource");
    }
  }
  const box = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = box?.[2];
  const height = box?.[3];
  if (
    box?.length !== 4 ||
    width === undefined ||
    height === undefined ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 20_000 ||
    height > 20_000
  )
    throw new Error("Invalid diagram dimensions");
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`,
    width,
    height,
  };
}

export async function renderMermaidImage(
  source: string,
  theme: MermaidTheme,
  id: string,
): Promise<MermaidImage> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: MERMAID_LIMITS.sourceCharacters,
    maxEdges: MERMAID_LIMITS.edges,
    theme: theme === "dark" ? "dark" : "default",
    fontFamily: "system-ui, sans-serif",
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "suppressErrorRendering",
      "htmlLabels",
      "maxTextSize",
      "maxEdges",
      "theme",
      "themeCSS",
      "fontFamily",
      "altFontFamily",
    ],
    flowchart: { htmlLabels: false },
    sequence: { useMaxWidth: true },
  });
  // Supply a dedicated measurement host so parse/render failures cannot leave
  // Mermaid's temporary SVG/error UI in document.body.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
  document.body.append(host);
  try {
    const { svg } = await mermaid.render(id, source, host);
    return sanitizeMermaidSvg(svg);
  } finally {
    host.remove();
  }
}
