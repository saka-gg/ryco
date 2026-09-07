import { describe, expect, it } from "vite-plus/test";
import { extractToolContentText, extractToolResultText } from "./toolOutput.ts";

describe("provider tool output", () => {
  it.each([
    ["ACP plain result", "Found the bug", "Found the bug"],
    [
      "Copilot detailed result",
      { content: "short", detailedContent: "full\nreport" },
      "full\nreport",
    ],
    [
      "command stderr",
      { stdout: "partial", stderr: "permission denied" },
      "partial\npermission denied",
    ],
    [
      "Claude result",
      { type: "tool_result", content: [{ type: "text", text: "review done" }] },
      "review done",
    ],
    ["structured MCP result", { structuredContent: { count: 3 } }, '{\n  "count": 3\n}'],
    ["ACP summary", { summary: "Review complete" }, "Review complete"],
  ])("reads %s", (_name, value, expected) => {
    expect(extractToolResultText(value)).toBe(expected);
  });

  it("reads embedded text resources while skipping binary content", () => {
    expect(
      extractToolContentText([
        {
          type: "content",
          content: { type: "resource", resource: { uri: "file:///report", text: "report text" } },
        },
        { type: "image", data: "opaque-image-bytes", mimeType: "image/png" },
        { type: "resource", resource: { blob: "opaque-resource-bytes" } },
      ]),
    ).toBe("report text");
    expect(
      extractToolResultText({ arguments: { prompt: "not output" }, data: "opaque" }),
    ).toBeUndefined();
  });
});
