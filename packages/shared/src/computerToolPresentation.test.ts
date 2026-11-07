import { describe, expect, it } from "vitest";

import { computerToolPresentation, resolveComputerTool } from "./computerToolPresentation.ts";

describe("resolveComputerTool", () => {
  it.each([
    ["mcp__ryco__computer_click", undefined, "click"],
    ["computer_click", "ryco_agent_control", "click"],
    ["ryco-computer_launch_app", undefined, "launch_app"],
    ["ryco_ab12cd_computer_type_text", undefined, "type_text"],
    ["computer_browser_navigate", undefined, "browser_navigate"],
    ["mcp__ryco__computer_something_new", undefined, "use"],
  ])("resolves %s (server %s) to %s", (name, server, action) => {
    expect(resolveComputerTool({ name, ...(server ? { server } : {}) })).toBe(action);
  });

  it.each([
    ["mcp__other__computer_click", undefined],
    ["computer_click", "someone_else"],
    ["mcp__ryco__ryco_browser", undefined],
    ["mcp__ryco_device__device", undefined],
    ["Bash", undefined],
  ])("leaves %s (server %s) alone", (name, server) => {
    expect(resolveComputerTool({ name, ...(server ? { server } : {}) })).toBeNull();
  });
});

describe("computerToolPresentation", () => {
  const label = (
    name: string,
    input: Record<string, unknown> = {},
    status: "running" | "completed" | "failed" = "completed",
  ) => computerToolPresentation({ name: `mcp__ryco__${name}`, input }, status)?.label;

  it("reads a call as plain words instead of its MCP name", () => {
    expect(label("computer_click", { label: "Senden", window_id: "cua:1:2" })).toBe(
      'Clicked "Senden"',
    );
    expect(label("computer_launch_app", { app: "Spark" })).toBe("Opened Spark");
    expect(label("computer_type_text", { text: "hi@saka.at" })).toBe('Typed "hi@saka.at"');
    expect(label("computer_press_key", { key: "meta+n" })).toBe("Pressed ⌘N");
    expect(label("computer_get_state", { window_id: "cua:1:2" })).toBe("Looked at the screen");
    expect(label("computer_browser_navigate", { url: "https://www.amazon.de/s?k=iphone" })).toBe(
      "Opened amazon.de/s?k=iphone",
    );
    expect(label("computer_invoke_menu", { path: ["File", "Save"] })).toBe("Chose File › Save");
    expect(label("computer_run", { steps: [{}, {}, {}] })).toBe("Ran 3 steps");
    expect(label("computer_activate_window")).toBe("Brought a window to the front");
  });

  it("uses running and base forms so a failed call never reads as done", () => {
    expect(label("computer_click", { label: "OK" }, "running")).toBe('Clicking "OK"');
    expect(label("computer_click", { label: "OK" }, "failed")).toBe('Click "OK"');
    expect(label("computer_unknown_tool", {}, "completed")).toBe("Used the computer");
  });

  it("clips long text", () => {
    const text = "x".repeat(80);
    expect(label("computer_type_text", { text })).toBe(`Typed "${"x".repeat(39)}…"`);
  });

  it("returns null for anything that is not Computer Use", () => {
    expect(computerToolPresentation({ name: "Read" }, "completed")).toBeNull();
  });
});
