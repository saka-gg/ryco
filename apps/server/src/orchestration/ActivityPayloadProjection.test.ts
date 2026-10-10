import { EventId, type OrchestrationThreadActivity } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  projectActivityPayload,
  withoutHtmlRenderToolMarkup,
} from "./ActivityPayloadProjection.ts";

describe("provider output projection", () => {
  it.each([
    { result: { content: [{ type: "text", text: "first line\nsecond line" }] } },
    { result: { detailedContent: "first line\nsecond line" } },
    { state: { output: "first line\nsecond line" } },
    { rawOutput: "first line\nsecond line" },
    {
      content: [
        {
          type: "content",
          content: { type: "resource", resource: { text: "first line\nsecond line" } },
        },
      ],
    },
  ])("retains compact progress without persisting repeated full outputs", (data) => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("event"),
      createdAt: "2026-09-07T00:00:00.000Z",
      tone: "tool",
      kind: "tool.updated",
      summary: "Tool",
      turnId: null,
      payload: { itemType: "dynamic_tool_call", data, agentId: "owner", parentToolUseId: "launch" },
    };
    expect(projectActivityPayload(activity).payload).toEqual({
      itemType: "dynamic_tool_call",
      agentId: "owner",
      parentToolUseId: "launch",
      data: { rawOutput: { content: "first line" } },
    });
  });

  const page = "<!doctype html><script>draw()</script>";
  const mcpActivity = (data: Record<string, unknown>): OrchestrationThreadActivity => ({
    id: EventId.make("event-html"),
    createdAt: "2026-10-07T00:00:00.000Z",
    tone: "tool",
    kind: "tool.updated",
    summary: "Rendered HTML",
    turnId: null,
    payload: { itemType: "mcp_tool_call", data },
  });

  it.each(["mcp__ryco__ryco_html_render", "ryco_html_preview", "ryco-ryco_html_render"])(
    "keeps only the page length of a %s call's input",
    (toolName) => {
      const projected = projectActivityPayload(
        mcpActivity({ toolName, input: { html: page, title: "Chart", height: 300 } }),
      );
      expect(projected.payload).toEqual({
        itemType: "mcp_tool_call",
        data: { toolName, input: { title: "Chart", height: 300, htmlChars: page.length } },
      });
    },
  );

  it("keeps only the page length of a Codex HTML tool item's arguments", () => {
    const projected = projectActivityPayload(
      mcpActivity({
        item: {
          type: "mcpToolCall",
          id: "call-1",
          server: "ryco_agent_control",
          tool: "ryco_html_render",
          status: "inProgress",
          arguments: { html: page, title: "Chart", height: 300 },
        },
      }),
    );
    expect(JSON.stringify(projected.payload)).not.toContain("draw()");
    expect(
      (projected.payload as { data: { item: { arguments: unknown } } }).data.item.arguments,
    ).toEqual({ title: "Chart", height: 300, htmlChars: page.length });
  });

  it("leaves other servers' tools of the same name untouched", () => {
    const item = {
      type: "mcpToolCall",
      server: "other",
      tool: "ryco_html_render",
      arguments: { html: page },
    };
    const projected = projectActivityPayload(mcpActivity({ item }));
    expect((projected.payload as { data: { item: unknown } }).data.item).toEqual(item);
  });
});

describe("withoutHtmlRenderToolMarkup", () => {
  const page = "<!doctype html><p>secret page</p>";

  it("replaces the page in every place a lifecycle event can carry it", () => {
    expect(
      withoutHtmlRenderToolMarkup({
        toolName: "mcp__ryco__ryco_html_render",
        input: { html: page, title: "Chart", height: 300 },
        rawInput: { html: page },
      }),
    ).toEqual({
      toolName: "mcp__ryco__ryco_html_render",
      input: { title: "Chart", height: 300, htmlChars: page.length },
      rawInput: { htmlChars: page.length },
    });
    expect(
      withoutHtmlRenderToolMarkup({
        item: {
          type: "mcpToolCall",
          server: "ryco_agent_control",
          tool: "ryco_html_preview",
          arguments: { html: page, width: 390 },
        },
      }),
    ).toEqual({
      item: {
        type: "mcpToolCall",
        server: "ryco_agent_control",
        tool: "ryco_html_preview",
        arguments: { width: 390, htmlChars: page.length },
      },
    });
  });

  it("leaves other tools, including another server's same-named tool, untouched", () => {
    const other = { toolName: "mcp__docs__write", input: { html: page } };
    expect(withoutHtmlRenderToolMarkup(other)).toBe(other);
    const foreign = {
      item: { server: "acme", tool: "ryco_html_render", arguments: { html: page } },
    };
    expect(withoutHtmlRenderToolMarkup(foreign)).toBe(foreign);
    expect(withoutHtmlRenderToolMarkup("text")).toBe("text");
  });
});

describe("withoutHtmlRenderToolMarkup for a call that names no tool", () => {
  // A page as agents write them: well past the 1 KB a fallback needs.
  const page = `<!doctype html><html><body><p>secret page</p>${"<i>bar</i>".repeat(120)}</body></html>`;

  it("recognizes the render and preview arguments carrying a page by their shape alone", () => {
    expect(
      withoutHtmlRenderToolMarkup({
        toolCallId: "call-1",
        kind: "other",
        rawInput: { html: page, title: "Chart", height: 300 },
        rawOutput: { content: [{ type: "text", text: "Shown to the reader." }] },
      }),
    ).toEqual({
      toolCallId: "call-1",
      kind: "other",
      rawInput: { title: "Chart", height: 300, htmlChars: page.length },
      rawOutput: { content: [{ type: "text", text: "Shown to the reader." }] },
    });
    for (const { html, ...rest } of [
      { html: page },
      { html: page, width: 390, appearance: "light" },
    ]) {
      expect(withoutHtmlRenderToolMarkup({ input: { html, ...rest } })).toEqual({
        input: { ...rest, htmlChars: page.length },
      });
    }
  });

  it.each([
    { name: "a short html argument", rawInput: { html: "<p>hi</p>", title: "T", height: 300 } },
    { name: "html that is not markup", rawInput: { html: "x".repeat(4_096) } },
    { name: "another argument", rawInput: { html: page, title: "T", height: 300, path: "/a" } },
    { name: "a render without its height", rawInput: { html: page, title: "T" } },
    { name: "a mistyped width", rawInput: { html: page, width: "390" } },
    { name: "an unknown appearance", rawInput: { html: page, appearance: "sepia" } },
  ])("leaves $name alone", ({ rawInput }) => {
    const data = { toolCallId: "call-1", rawInput };
    expect(withoutHtmlRenderToolMarkup(data)).toBe(data);
  });

  it("leaves a named tool's matching arguments to its name", () => {
    const named = { toolName: "mcp__docs__publish", input: { html: page, title: "T", height: 1 } };
    expect(withoutHtmlRenderToolMarkup(named)).toBe(named);
    const item = {
      item: { server: "docs", tool: "publish", arguments: {} },
      input: { html: page },
    };
    expect(withoutHtmlRenderToolMarkup(item)).toBe(item);
  });
});
