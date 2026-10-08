import {
  RYCO_DARK_THEME_COLORS,
  RYCO_DEFAULT_RADIUS,
  RYCO_LIGHT_THEME_COLORS,
  type ThemeAppearance,
  type ThemeColors,
} from "./themePalettes.ts";

/**
 * Agent-authored HTML pages ("HTML renders") are self-contained documents an
 * agent publishes into its thread with Ryco's `ryco_html_render` tool. The
 * server injects a small bootstrap into each page's head and stores it as a
 * `text/html` file attachment carrying `htmlRender` metadata. Clients never
 * load it from the app origin: they read its bytes and show it in a sandboxed
 * `srcdoc` frame (web, desktop, and inside a WebView on mobile) with an opaque
 * origin, and hand it the active theme as CSS custom properties.
 */

export const HTML_RENDER_TOOL_NAME = "ryco_html_render";
export const HTML_PREVIEW_TOOL_NAME = "ryco_html_preview";
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;
/** Upper bound on the `html` an agent passes to the tools, in UTF-16 code units. */
export const HTML_RENDER_MAX_HTML_CHARS = 512_000;
/** A stored page, local images inlined, may be at most this many bytes. */
export const HTML_RENDER_MAX_PAGE_BYTES = 25 * 1024 * 1024;
/** Each inlined local image may be at most this many bytes. */
export const HTML_RENDER_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** What a client needs to size and label a render; carried on its attachment. */
export interface HtmlRenderMetadata {
  readonly title: string;
  /** The agent's frame height in CSS pixels, and the cap on any measured height. */
  readonly height: number;
  /**
   * `[width, contentHeight]` pairs the server measured at publish, ascending by
   * width. Absent when the preview browser was not installed yet.
   */
  readonly heights?: ReadonlyArray<readonly [width: number, height: number]>;
  /**
   * Small screenshots of the page's top, as `data:image/...;base64` URLs, in
   * Ryco's default dark and light themes. Absent when the preview browser was
   * not installed at publish.
   */
  readonly thumbnails?: HtmlRenderThumbnails;
}

export interface HtmlRenderThumbnails {
  readonly dark?: string;
  readonly light?: string;
}

/** Thumbnail width in CSS pixels; the server stores them at twice this. */
export const HTML_RENDER_THUMBNAIL_WIDTH = 240;
/** Thumbnail height cap in CSS pixels: the top of the page. */
export const HTML_RENDER_THUMBNAIL_MAX_HEIGHT = 150;
/** Each thumbnail data URL may be at most this many characters. */
export const HTML_RENDER_MAX_THUMBNAIL_CHARS = 48_000;
const THUMBNAIL_DATA_URL = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

function readThumbnails(value: unknown): HtmlRenderThumbnails | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const thumbnails: { dark?: string; light?: string } = {};
  for (const appearance of ["dark", "light"] as const) {
    const url = (value as Record<string, unknown>)[appearance];
    if (
      typeof url === "string" &&
      url.length <= HTML_RENDER_MAX_THUMBNAIL_CHARS &&
      THUMBNAIL_DATA_URL.test(url)
    ) {
      thumbnails[appearance] = url;
    }
  }
  return thumbnails.dark === undefined && thumbnails.light === undefined ? undefined : thumbnails;
}

/** The thumbnail that fits an appearance, else the other one. */
export function htmlRenderThumbnail(
  render: HtmlRenderMetadata,
  appearance: ThemeAppearance,
): string | undefined {
  const thumbnails = render.thumbnails;
  if (thumbnails === undefined) return undefined;
  return appearance === "light"
    ? (thumbnails.light ?? thumbnails.dark)
    : (thumbnails.dark ?? thumbnails.light);
}

/**
 * The reply column's width in the web timeline (`max-w-3xl` less the message
 * row's `px-1`). Agents preview at it, and it picks the measured height when a
 * client cannot know its width.
 */
export const HTML_RENDER_COLUMN_WIDTH = 760;

/** Frame widths the server measures a page at, from phones to the reply column. */
export const HTML_RENDER_MEASURE_WIDTHS = [
  320,
  375,
  430,
  520,
  640,
  HTML_RENDER_COLUMN_WIDTH,
] as const;

const MAX_MEASURED_HEIGHTS = 24;

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

/** A display title: trimmed, bounded, never empty. */
export function normalizeHtmlRenderTitle(title: string): string {
  return title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH).trim() || "HTML";
}

function readMeasuredHeights(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) {
    return undefined;
  }
  const heights = value.flatMap((entry) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    Number.isInteger(entry[0]) &&
    entry[0] >= 1 &&
    entry[0] <= 10_000 &&
    typeof entry[1] === "number" &&
    Number.isFinite(entry[1])
      ? [[entry[0] as number, clampHtmlRenderHeight(entry[1])] as const]
      : [],
  );
  return heights.length === value.length
    ? heights.toSorted((left, right) => left[0] - right[0])
    : undefined;
}

// Reading validates thumbnails (data URLs of tens of KB) against a pattern,
// and clients read every page on each streamed update. Metadata objects are
// replaced, never changed in place, so each one is read once.
const metadataByValue = new WeakMap<object, HtmlRenderMetadata | null>();

/** Validated, clamped render metadata, or undefined when `value` is not render metadata. */
export function readHtmlRenderMetadata(value: unknown): HtmlRenderMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const cached = metadataByValue.get(value);
  if (cached !== undefined) return cached ?? undefined;
  const metadata = parseHtmlRenderMetadata(value);
  metadataByValue.set(value, metadata ?? null);
  return metadata;
}

function parseHtmlRenderMetadata(value: object): HtmlRenderMetadata | undefined {
  const { title, height, heights, thumbnails } = value as Record<string, unknown>;
  if (typeof title !== "string" || typeof height !== "number" || !Number.isFinite(height)) {
    return undefined;
  }
  const measured = readMeasuredHeights(heights);
  const pictures = readThumbnails(thumbnails);
  return {
    title: normalizeHtmlRenderTitle(title),
    height: clampHtmlRenderHeight(height),
    ...(measured === undefined ? {} : { heights: measured }),
    ...(pictures === undefined ? {} : { thumbnails: pictures }),
  };
}

/** Whether two renders show at the same sizes under the same title and thumbnails. */
export function htmlRenderMetadataEqual(left: HtmlRenderMetadata, right: HtmlRenderMetadata) {
  return (
    left.title === right.title &&
    left.height === right.height &&
    left.thumbnails?.dark === right.thumbnails?.dark &&
    left.thumbnails?.light === right.thumbnails?.light &&
    (left.heights ?? []).length === (right.heights ?? []).length &&
    (left.heights ?? []).every(
      ([width, height], index) =>
        right.heights?.[index]?.[0] === width && right.heights[index][1] === height,
    )
  );
}

/** The render metadata of an attachment, when it is an HTML render. */
export function htmlRenderOfAttachment(attachment: {
  readonly type: string;
  readonly mimeType?: string | undefined;
  readonly htmlRender?: unknown;
}): HtmlRenderMetadata | undefined {
  if (attachment.type !== "file" || attachment.htmlRender === undefined) return undefined;
  if (attachment.mimeType !== undefined && !/^text\/html\b/i.test(attachment.mimeType)) {
    return undefined;
  }
  return readHtmlRenderMetadata(attachment.htmlRender);
}

// The taller of the heights measured at the nearest widths on each side. A
// breakpoint between two measured widths can make the page as tall as either.
function measuredHeight(heights: NonNullable<HtmlRenderMetadata["heights"]>, width: number) {
  const above = heights.findIndex(([measuredWidth]) => measuredWidth >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/**
 * The frame height for a page at a frame width. It is the page's own reported
 * `contentHeight` when the client has one, else the server's measurement for
 * that width. A page even a few pixels taller than its frame scrolls inside it
 * and takes the reader's scroll, so the frame fits the page. The agent's height
 * caps it only when it is below the page's height at the column width (the
 * agent asked for a scrolling frame) or when the page was never measured.
 */
export function htmlRenderFrameHeight(
  render: HtmlRenderMetadata,
  width: number,
  contentHeight?: number,
) {
  const heights = render.heights;
  if (heights === undefined || heights.length === 0) {
    return clampHtmlRenderHeight(Math.min(render.height, contentHeight ?? render.height));
  }
  const cap =
    measuredHeight(heights, HTML_RENDER_COLUMN_WIDTH) > render.height
      ? render.height
      : HTML_RENDER_MAX_HEIGHT;
  return clampHtmlRenderHeight(Math.min(cap, contentHeight ?? measuredHeight(heights, width)));
}

/** How much of a render's source a client shows; the download has all of it. */
export const HTML_RENDER_SOURCE_PREVIEW_MAX_CHARS = 512 * 1024;

/** A readable file name for a render: the title without characters file systems reject. */
export function htmlRenderFileName(title: string) {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${name || "Page"}.html`;
}

export interface HtmlRenderFonts {
  readonly sans: string;
  readonly mono: string;
}

export const HTML_RENDER_DEFAULT_FONTS: HtmlRenderFonts = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  // Concrete names only: some engines alias `ui-monospace` to the proportional UI font.
  mono: '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
};

/**
 * Fonts the server's headless browser lays pages out with. Arial-metric faces
 * stand in for the system UI fonts readers see, so measured heights and
 * preview screenshots wrap text close to how a client will.
 */
export const HTML_RENDER_MEASURE_FONTS: HtmlRenderFonts = {
  sans: '"Liberation Sans", Arimo, Arial, Helvetica, sans-serif',
  mono: '"Liberation Mono", Cousine, Menlo, Consolas, monospace',
};

/** The resolved theme a client hands an HTML render. */
export interface HtmlRenderTheme {
  readonly appearance: ThemeAppearance;
  readonly variables: Readonly<Record<string, string>>;
}

export interface HtmlRenderThemeOptions {
  readonly fonts?: HtmlRenderFonts;
  /** The app's corner radius, any CSS length. */
  readonly radius?: string;
}

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0-1. */
  readonly a: number;
}

const clampChannel = (value: number) => Math.min(255, Math.max(0, value));

const parseChannel = (value: string) =>
  value.endsWith("%") ? (Number.parseFloat(value) / 100) * 255 : Number.parseFloat(value);

const parseAlpha = (value: string | undefined) =>
  value === undefined
    ? 1
    : value.endsWith("%")
      ? Number.parseFloat(value) / 100
      : Number.parseFloat(value);

/** An sRGB color from hex or `rgb()`/`rgba()` notation, or undefined for anything else. */
function parseCssColor(value: string): Rgba | undefined {
  const color = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(color)?.[1];
  if (hex !== undefined) {
    const full =
      hex.length <= 4
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;
    const channel = (index: number) => Number.parseInt(full.slice(index * 2, index * 2 + 2), 16);
    return {
      r: channel(0),
      g: channel(1),
      b: channel(2),
      a: full.length === 8 ? channel(3) / 255 : 1,
    };
  }
  const functional = /^rgba?\(\s*([^)]*)\)$/.exec(color)?.[1];
  if (functional === undefined) return undefined;
  const [channels, slashAlpha] = functional.split("/").map((part) => part.trim());
  const parts = channels!.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4 || (parts.length === 4 && slashAlpha !== undefined)) {
    return undefined;
  }
  const [r, g, b] = parts.slice(0, 3).map(parseChannel);
  const a = parseAlpha(parts[3] ?? slashAlpha);
  if ([r, g, b, a].some((part) => part === undefined || !Number.isFinite(part))) return undefined;
  return {
    r: clampChannel(r!),
    g: clampChannel(g!),
    b: clampChannel(b!),
    a: Math.min(1, Math.max(0, a)),
  };
}

const hexByte = (value: number) => Math.round(value).toString(16).padStart(2, "0");

function formatCssColor(color: Rgba): string {
  return color.a >= 0.999
    ? `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`
    : `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${Math.round(color.a * 1000) / 1000})`;
}

/** `over` painted on `under`. */
function composite(over: Rgba, under: Rgba): Rgba {
  const a = over.a + under.a * (1 - over.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (top: number, bottom: number) =>
    (top * over.a + bottom * under.a * (1 - over.a)) / a;
  return {
    r: channel(over.r, under.r),
    g: channel(over.g, under.g),
    b: channel(over.b, under.b),
    a,
  };
}

/**
 * `weight` of `color` mixed into `base`, as a plain sRGB color when both parse,
 * so pages can hand it to a canvas. Falls back to CSS `color-mix()`.
 */
function mixColors(color: string, base: string, weight: number): string {
  const top = parseCssColor(color);
  const bottom = parseCssColor(base);
  if (top === undefined || bottom === undefined) {
    return `color-mix(in srgb, ${color} ${Math.round(weight * 100)}%, ${base})`;
  }
  return formatCssColor(composite({ ...top, a: top.a * weight }, bottom));
}

/** Whether a color reads as a hue rather than grey, so it can stand for a chart series. */
function isChromatic(color: string) {
  const parsed = parseCssColor(color);
  return (
    parsed !== undefined &&
    Math.max(parsed.r, parsed.g, parsed.b) - Math.min(parsed.r, parsed.g, parsed.b) > 24
  );
}

// A categorical chart series after the theme's own first color.
const CHART_SERIES = {
  light: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
  dark: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
} as const;

/**
 * Maps a theme to the variables HTML renders style against. Names follow the
 * app's tokens, except `--accent`, which is the theme's brand color (Ryco's
 * `--primary`) rather than the app's neutral hover surface.
 */
export function htmlRenderTheme(
  colors: ThemeColors,
  appearance: ThemeAppearance,
  options: HtmlRenderThemeOptions = {},
): HtmlRenderTheme {
  const fonts = options.fonts ?? HTML_RENDER_DEFAULT_FONTS;
  const surface = (color: string) =>
    mixColors(color, colors.background, appearance === "light" ? 0.08 : 0.16);
  const codeBackground = mixColors(
    mixColors(colors.muted, colors.background, 1),
    colors.background,
    0.78,
  );
  return {
    appearance,
    variables: {
      "--background": colors.background,
      "--foreground": colors.foreground,
      "--muted": colors.muted,
      "--muted-foreground": colors["muted-foreground"],
      "--card": colors.card,
      "--card-foreground": colors["card-foreground"],
      "--popover": colors.popover,
      "--popover-foreground": colors["popover-foreground"],
      "--secondary": colors.secondary,
      "--secondary-foreground": colors["secondary-foreground"],
      "--border": colors.border,
      "--input": colors.input,
      "--ring": colors.ring,
      "--primary": colors.primary,
      "--primary-foreground": colors["primary-foreground"],
      "--accent": colors.primary,
      "--accent-foreground": colors["primary-foreground"],
      "--accent-surface": surface(colors.primary),
      "--accent-surface-foreground": colors.foreground,
      "--destructive": colors.destructive,
      "--destructive-foreground": colors["destructive-foreground"],
      "--destructive-surface": surface(colors.destructive),
      "--warning": colors.warning,
      "--warning-foreground": colors["warning-foreground"],
      "--warning-surface": surface(colors.warning),
      "--success": colors.success,
      "--success-foreground": colors["success-foreground"],
      "--info": colors.info,
      "--info-foreground": colors["info-foreground"],
      "--link": colors["info-foreground"],
      "--code-background": codeBackground,
      "--code-foreground": colors.foreground,
      "--chart-1": isChromatic(colors.primary) ? colors.primary : colors.info,
      ...Object.fromEntries(
        CHART_SERIES[appearance].map((color, index) => [`--chart-${index + 2}`, color]),
      ),
      "--radius": options.radius ?? RYCO_DEFAULT_RADIUS,
      "--font-sans": fonts.sans,
      "--font-mono": fonts.mono,
    },
  };
}

/** The theme a render gets when no client hands it one: Ryco's default palette. */
export function defaultHtmlRenderTheme(
  appearance: ThemeAppearance,
  fonts: HtmlRenderFonts = HTML_RENDER_DEFAULT_FONTS,
): HtmlRenderTheme {
  return htmlRenderTheme(
    appearance === "light" ? RYCO_LIGHT_THEME_COLORS : RYCO_DARK_THEME_COLORS,
    appearance,
    { fonts },
  );
}

/** Agent-facing reference for the injected variables, used in tool descriptions. */
export const HTML_RENDER_THEME_GUIDE = [
  "Ryco injects its active theme as CSS custom properties on :root, and they follow the user's theme and light/dark mode live:",
  "--background (page background, identical to the thread around the frame), --foreground, --muted, --muted-foreground,",
  "--card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring,",
  "--primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --accent-surface, --accent-surface-foreground,",
  "--destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface,",
  "--success, --success-foreground, --info, --info-foreground, --link, --code-background, --code-foreground,",
  "--chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.",
  "Read them with getComputedStyle(document.documentElement).getPropertyValue('--chart-1') when drawing on a canvas, and redraw on window's 'ryco-theme-change' event, which fires after the variables change.",
  "The base stylesheet sets html background/color/font from these, body margin to 0, link color to --link, and hides the page's scrollbar; your own CSS overrides it.",
].join(" ");

/** Agent-facing layout rules for a page that sits inside a reply. */
export const HTML_RENDER_LAYOUT_GUIDE = [
  `The frame is borderless on the thread's background, as wide as the reply column (${HTML_RENDER_COLUMN_WIDTH}px on desktop, narrower in side panels, about 360px on phones), and its left edge lines up with your reply text.`,
  "The page sits on the thread's own background, so by default leave html, body, and the outermost element with no background color. This overrides general style preferences such as a fixed black page background.",
  "Use a fluid width with no horizontal padding on the outermost element, and no outer card, border, or banner title: the page is part of your reply.",
  "If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding on every side and var(--radius) corners, so content never touches its edge.",
  "Give charts fixed pixel heights rather than heights that scale with width.",
  "Let content set the page's height. Avoid viewport-based heights such as 100vh or height:100% on html or body; the frame grows to fit the page, so they can make it grow again and again.",
  "Keep the top-right corner (about 40 by 40px) free of controls: Ryco shows an expand button there while the reader points at the page.",
  "Links to http(s) pages open in the reader's browser; the page cannot open windows, show dialogs, or submit forms, so handle form input with script.",
].join(" ");

/** Agent-facing rules for the HTML both tools accept. */
export const HTML_RENDER_PAGE_RULES =
  'Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths inside this thread\'s workspace or the system temp directory (src="/abs/shot.png", CSS url(/abs/bg.webp), or a JS string) are inlined automatically; symbolic and hard links are refused, so copy such files into the temp directory first. Remote https URLs, such as a CDN chart library, load as-is; use https, since readers on HTTPS clients block plain-http scripts and styles. The page runs in a sandbox with an opaque origin: localStorage, sessionStorage, document.cookie and opening an IndexedDB database throw a SecurityError, so keep state in memory.';

/** The paragraph that tells agents when to reach for HTML renders. */
export const HTML_RENDER_AGENT_INSTRUCTIONS = `When a chart, table, diagram, image collage, or UI mockup would say more than prose, build a self-contained HTML page, check it with ${HTML_PREVIEW_TOOL_NAME}, then publish it with ${HTML_RENDER_TOOL_NAME} before your final reply. The reader sees the page above that reply, so don't announce or restate it; add only what it doesn't say.`;

// The bridge between a render and its client speaks the MCP Apps protocol
// (JSON-RPC over postMessage), so the same host code can later drive upstream
// MCP apps: https://github.com/modelcontextprotocol/ext-apps
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
// Not part of MCP Apps. A sandboxed page runs out of process, so the client's
// document never sees the pointer over it (no :hover, no boundary events); the
// page reports it instead, for hover-only controls such as the expand button.
const POINTER_CHANGED_METHOD = "ryco/notifications/pointer-changed";
// Not part of MCP Apps. Keys pressed inside the out-of-process page never
// reach the client, so a page in a dialog reports Escape for it to close.
const ESCAPE_METHOD = "ryco/notifications/escape";
/** The event a page's own scripts can listen for to redraw after a theme change. */
export const HTML_RENDER_THEME_CHANGE_EVENT = "ryco-theme-change";

/** The content height in a framed render's `ui/notifications/size-changed` notification. */
export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== SIZE_CHANGED_METHOD) return undefined;
  const height =
    typeof params === "object" && params !== null
      ? (params as { height?: unknown }).height
      : undefined;
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
}

/** Whether the pointer is over a framed render, from its `pointer-changed` notification. */
export function readHtmlRenderPointerInside(data: unknown): boolean | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== POINTER_CHANGED_METHOD) return undefined;
  const inside =
    typeof params === "object" && params !== null
      ? (params as { inside?: unknown }).inside
      : undefined;
  return typeof inside === "boolean" ? inside : undefined;
}

/** Whether `data` is a framed render reporting that the reader pressed Escape in it. */
export function isHtmlRenderEscape(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const { jsonrpc, method } = data as Record<string, unknown>;
  return jsonrpc === "2.0" && method === ESCAPE_METHOD;
}

/** A render's `ui/open-link` request, if `data` is one with an http(s) URL. */
export function readHtmlRenderLinkRequest(
  data: unknown,
): { readonly id: string | number; readonly url: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== OPEN_LINK_METHOD) return undefined;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  const url =
    typeof params === "object" && params !== null ? (params as { url?: unknown }).url : undefined;
  if (typeof url !== "string" || url.length > 8192 || !/^https?:\/\//i.test(url)) return undefined;
  // No credentials in the authority, and nothing a URL parser rejects.
  if (/^https?:\/\/[^/?#]*@/i.test(url) || /[\s\p{Cc}]/u.test(url)) return undefined;
  try {
    void new URL(url);
  } catch {
    return undefined;
  }
  return { id, url };
}

/** The empty result a client sends back for a render's request. */
export function htmlRenderResult(id: string | number) {
  return { jsonrpc: "2.0", id, result: {} } as const;
}

export const HTML_RENDER_THEME_STYLE_ID = "ryco-theme";
const THEME_FRAGMENT_KEY = "ryco-theme";
const THEME_WINDOW_NAME_PREFIX = "ryco-theme:";

/** URL fragment that hands a render loaded by URL (the headless preview) its theme before first paint. */
export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

/**
 * Frame `name` that hands a `srcdoc` render its theme before first paint; a
 * srcdoc document has no URL fragment. The bootstrap clears it once read.
 */
export function htmlRenderThemeWindowName(theme: HtmlRenderTheme): string {
  return `${THEME_WINDOW_NAME_PREFIX}${JSON.stringify(theme)}`;
}

/** The `host-context-changed` notification a client posts into a mounted render when the theme changes. */
export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

// The frame scrolls a page taller than itself, but a scrollbar inside the
// reply reads as a box within the thread, so it stays hidden.
const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}a{color:var(--link)}code,kbd,pre,samp{font-family:var(--font-mono)}";

/**
 * Policy a render document carries itself (a srcdoc frame shares no response
 * headers). Scripts, styles, and public resources load freely; plugins never
 * do, and forms cannot navigate the frame away from the page.
 */
export const HTML_RENDER_DOCUMENT_CSP = "object-src 'none'; form-action 'none'";

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

// Runs synchronously in <head>, before the page's own styles and body, so the
// first paint is already themed. The theme comes from the URL fragment (a page
// loaded by URL, which is cleared so the page's own routing never sees it) or
// the frame name (a srcdoc frame). The bootstrap keeps the latest theme in the
// frame name, which survives a reload, so a page that reloads itself paints
// with the reader's current theme from its first frame. It rewrites its own <style> element
// rather than setting inline properties, so a page's later `:root` rules still
// win. A link the reader clicks never replaces the page inside the thread: a
// framed page asks its client to open absolute http(s) links and drops others
// (in-page `#` anchors still scroll), and a top-level page opens them as a new
// window. A framed page also reports its content height, measured as the
// server measures it, so its client can fit the frame to the page.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById(${JSON.stringify(HTML_RENDER_THEME_STYLE_ID)}),n=0,f=window.parent!==window;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;try{window.name=${JSON.stringify(THEME_WINDOW_NAME_PREFIX)}+JSON.stringify({appearance:t.appearance==="light"?"light":"dark",variables:t.variables});}catch(x){}}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash),w=window.name;if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}else if(typeof w==="string"&&w.indexOf(${JSON.stringify(THEME_WINDOW_NAME_PREFIX)})===0){a(JSON.parse(w.slice(${THEME_WINDOW_NAME_PREFIX.length})));}}catch(e){}window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(f&&e.source!==window.parent)return;if(d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles){a({appearance:p.theme,variables:p.styles.variables});try{window.dispatchEvent(new Event(${JSON.stringify(HTML_RENDER_THEME_CHANGE_EVENT)}));}catch(x){}}});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,h,u;if(!l)return;h=(l.getAttribute("href")||"").trim();if(h.charAt(0)==="#")return;try{u=new URL(h,document.baseURI);}catch(x){u=null;}if(!u||!/^https?:\\/\\//i.test(h)||!/^https?:$/.test(u.protocol)){if(f)e.preventDefault();return;}if(u.href.split("#")[0]===location.href.split("#")[0])return;if(f){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"ryco-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener noreferrer");}},true);if(f){window.addEventListener("keydown",function(e){if(e.key==="Escape"&&!e.defaultPrevented&&!e.isComposing)window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(ESCAPE_METHOD)}},"*");});var pv=false,pp=function(v){if(v===pv)return;pv=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(POINTER_CHANGED_METHOD)},params:{inside:v}},"*");};document.addEventListener("pointerover",function(){pp(true);},true);document.addEventListener("pointerout",function(e){if(!e.relatedTarget)pp(false);},true);document.documentElement.addEventListener("pointerleave",function(){pp(false);});window.addEventListener("blur",function(){pp(false);});var h0,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h0)return;h0=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);}})();`;

const INJECTED_CHARSET = '<meta charset="utf-8">';
const INJECTED_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

let currentBootstrapCore: string | undefined;

/** Everything the bootstrap adds that does not depend on the page. */
function bootstrapCore(): string {
  if (currentBootstrapCore !== undefined) return currentBootstrapCore;
  const dark = defaultHtmlRenderTheme("dark");
  const light = defaultHtmlRenderTheme("light");
  // Without a client-provided theme (a direct download, a preview without a
  // fragment) the page follows the OS appearance.
  const defaultCss = `${rootRule(dark)}@media (prefers-color-scheme: light){${rootRule(light)}}${BASE_CSS}`;
  currentBootstrapCore = [
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="Content-Security-Policy" content="${HTML_RENDER_DOCUMENT_CSP}">`,
    `<style id="${HTML_RENDER_THEME_STYLE_ID}">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join("");
  return currentBootstrapCore;
}

function bootstrapMarkup(markup: string): string {
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? "" : INJECTED_CHARSET,
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup) ? "" : INJECTED_VIEWPORT,
    bootstrapCore(),
  ].join("");
}

// The bootstrap any build injected: its shape is stable even when its CSS and
// script change, and neither contains `<` or `</script>`.
const BOOTSTRAP_CORE_PATTERN =
  /<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="[^"<>]*"><style id="ryco-theme">[^<]*<\/style><script>[\s\S]*?<\/script>/;

/**
 * Where a stored page's injected bootstrap sits: right after the head tag the
 * injection opened, behind the charset and viewport tags it may have added.
 * Look-alike markup anywhere else in the page is never taken for it.
 */
function locateBootstrap(html: string) {
  const match = BOOTSTRAP_CORE_PATTERN.exec(html);
  if (match === null) return undefined;
  const coreStart = match.index;
  let start = coreStart;
  if (html.slice(0, start).endsWith(INJECTED_VIEWPORT)) start -= INJECTED_VIEWPORT.length;
  if (html.slice(0, start).endsWith(INJECTED_CHARSET)) start -= INJECTED_CHARSET.length;
  if (!/<head(?:\s[^>]*)?>$/i.test(html.slice(Math.max(0, start - 1024), start))) {
    return undefined;
  }
  return { start, coreStart, end: coreStart + match[0].length };
}

/**
 * A stored page with its bootstrap replaced by this build's, so pages published
 * by an older build get today's bridge and theme handling. A page without a
 * recognizable bootstrap comes back unchanged.
 */
export function upgradeHtmlRenderBootstrap(html: string): string {
  const located = locateBootstrap(html);
  if (located === undefined) return html;
  const core = bootstrapCore();
  if (html.slice(located.coreStart, located.end) === core) return html;
  return html.slice(0, located.coreStart) + core + html.slice(located.end);
}

/**
 * The page as the agent wrote it, for showing a render's source: the
 * bootstrap (from any build) removed with the tags its injection added.
 */
export function stripHtmlRenderBootstrap(html: string): string {
  const located = locateBootstrap(html);
  if (located === undefined) return html;
  const before = html.slice(0, located.start);
  const after = html.slice(located.end);
  // A page without a head got one just for the bootstrap; drop it too.
  return before.endsWith("<head>") && after.startsWith("</head>")
    ? before.slice(0, -"<head>".length) + after.slice("</head>".length)
    : before + after;
}

// Comments, raw text, and template contents are blanked to the same length,
// so offsets still line up and inert tags cannot receive the bootstrap.
const blankNonMarkup = (html: string) => {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join("");
};

/**
 * Inserts the theme bootstrap at the start of the document head, so a page's
 * own styles and scripts come after it.
 */
export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}
