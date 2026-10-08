import {
  HTML_PREVIEW_TOOL_NAME,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_TOOL_NAME,
  normalizeHtmlRenderTitle,
} from "./htmlRender.ts";

/**
 * Work-log presentation of Ryco's HTML tools. Every provider spells the tool
 * differently (`mcp__ryco__ryco_html_render` in Claude, server
 * `ryco_agent_control` plus tool `ryco_html_render` in Codex, a server/tool
 * pair or `ryco-ryco_html_render` in Copilot), and a call's input carries the
 * whole page. Adapters and the activity projection resolve the name here and
 * show the call as a short label; the page markup is never persisted or shown.
 */

export type HtmlRenderToolKind = "render" | "preview";

/** MCP server names Ryco registers its private Agent Control tools under. */
export const RYCO_AGENT_CONTROL_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([
  "ryco",
  "ryco_agent_control",
]);

const TOOL_KINDS: ReadonlyMap<string, HtmlRenderToolKind> = new Map([
  [HTML_RENDER_TOOL_NAME, "render"],
  [HTML_PREVIEW_TOOL_NAME, "preview"],
]);

const TITLES: Readonly<Record<HtmlRenderToolKind, string>> = {
  render: "Rendered HTML",
  preview: "Previewed HTML",
};

// `mcp__ryco__x`, `ryco_agent_control.x`, `ryco-x`, `ryco: x`, `mcp_ryco_x`. The tool
// alternatives are the exact names, so a server name with separators in it still splits right.
const PREFIXED_TOOL_NAME = new RegExp(
  `^(?:mcp[-_]{1,2})?(?<server>[a-z0-9][a-z0-9_-]*?)(?:__|\\s*[.:/·]\\s*|[-_ ])(?<tool>${[...TOOL_KINDS.keys()].join("|")})$`,
  "i",
);

const isRycoServer = (server: string) =>
  RYCO_AGENT_CONTROL_MCP_SERVER_NAMES.has(server.trim().toLowerCase().replaceAll("-", "_"));

/**
 * Which Ryco HTML tool a provider's tool name refers to. Pass `serverName`
 * when the provider reports the MCP server separately; a server other than
 * Ryco's never matches, so another server's same-named tool keeps its own
 * presentation.
 */
export function resolveHtmlRenderToolKind(
  toolName: string | null | undefined,
  serverName?: string | null,
): HtmlRenderToolKind | undefined {
  if (typeof toolName !== "string") return undefined;
  const name = toolName.trim();
  if (serverName !== undefined && serverName !== null) {
    return isRycoServer(serverName) ? TOOL_KINDS.get(name.toLowerCase()) : undefined;
  }
  const direct = TOOL_KINDS.get(name.toLowerCase());
  if (direct !== undefined) return direct;
  const groups = PREFIXED_TOOL_NAME.exec(name)?.groups;
  return groups?.server !== undefined && groups.tool !== undefined && isRycoServer(groups.server)
    ? TOOL_KINDS.get(groups.tool.toLowerCase())
    : undefined;
}

export interface HtmlRenderToolPresentation {
  readonly title: string;
  readonly detail?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * A work-log title and detail for an HTML tool call: the page title for a
 * render, the viewport (`760px dark`) for a preview. No detail until the
 * call's input is known, so a half-streamed call never shows a guess.
 */
export function htmlRenderToolPresentation(
  kind: HtmlRenderToolKind,
  input: unknown,
): HtmlRenderToolPresentation {
  const title = TITLES[kind];
  const args = asRecord(input);
  if (args === undefined || Object.keys(args).length === 0) return { title };
  if (kind === "render") {
    return typeof args.title === "string" && args.title.trim().length > 0
      ? { title, detail: normalizeHtmlRenderTitle(args.title) }
      : { title };
  }
  const width =
    typeof args.width === "number" && Number.isFinite(args.width)
      ? Math.round(args.width)
      : HTML_RENDER_COLUMN_WIDTH;
  return { title, detail: `${width}px ${args.appearance === "light" ? "light" : "dark"}` };
}

/** The presentation of a provider tool call, when it is one of Ryco's HTML tools. */
export function resolveHtmlRenderToolPresentation(call: {
  readonly toolName: string | null | undefined;
  readonly serverName?: string | null | undefined;
  readonly input: unknown;
}): HtmlRenderToolPresentation | undefined {
  const kind = resolveHtmlRenderToolKind(call.toolName, call.serverName);
  return kind === undefined ? undefined : htmlRenderToolPresentation(kind, call.input);
}

/**
 * An HTML tool's input with the page replaced by its length (`{ htmlChars }`),
 * safe to persist and show. Anything that is not an object passes through.
 */
export function withoutHtmlRenderMarkup(input: unknown): unknown {
  const args = asRecord(input);
  if (args === undefined || !("html" in args)) return input;
  const { html, ...rest } = args;
  return typeof html === "string" ? { ...rest, htmlChars: html.length } : rest;
}
