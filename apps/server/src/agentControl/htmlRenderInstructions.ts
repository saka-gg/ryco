import { HTML_RENDER_AGENT_INSTRUCTIONS, HTML_RENDER_TOOL_NAME } from "@ryco/shared/htmlRender";

/**
 * When to reach for an HTML render, for every channel that announces Agent
 * Control (MCP initialize, host context, Codex developer instructions). The
 * tools are granted per session, so the note is conditional; the long theme
 * and layout guides stay in the tool descriptions.
 */
export const AGENT_CONTROL_HTML_RENDER_INSTRUCTIONS = `Visual replies (when ${HTML_RENDER_TOOL_NAME} is available): ${HTML_RENDER_AGENT_INSTRUCTIONS}`;
