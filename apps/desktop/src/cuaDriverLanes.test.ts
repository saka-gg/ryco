import { describe, expect, it } from "vitest";
import { cuaHostLaneClaims, cuaLanesAreExclusive } from "./cuaDriverLanes.ts";

const claims = (name: string, args: object, extra: { foreground?: boolean } = {}) =>
  cuaHostLaneClaims({
    name,
    args,
    threadId: "thread",
    foreground: extra.foreground ?? false,
    browserMutation: name.startsWith("browser_"),
  });

describe("cuaHostLaneClaims", () => {
  it("lets reads run next to everything but whole-desktop work", () => {
    expect(claims("get_window_state", { pid: 1, window_id: 2 })).toEqual([
      { resource: "desktop", mode: "shared" },
      { resource: "cursor:thread", mode: "shared" },
    ]);
  });

  it("gives exact semantic writes a window lane under the shared input gate", () => {
    expect(claims("set_value", { pid: 1, window_id: 2, element_token: "t" })).toEqual([
      { resource: "desktop", mode: "shared" },
      { resource: "app:1/window:2", mode: "exclusive" },
      { resource: "input", mode: "shared" },
      { resource: "cursor:thread", mode: "shared" },
    ]);
    expect(
      claims("type_text", { pid: 1, window_id: 2, text: "x", semantic_only: true }),
    ).toContainEqual({ resource: "input", mode: "shared" });
  });

  it("gives all other input the driver gate alone", () => {
    for (const [name, args] of [
      ["click", { pid: 1, window_id: 2, x: 1, y: 1 }],
      ["press_key", { pid: 1, key: "a" }],
      ["type_text", { pid: 1, window_id: 2, text: "x" }],
      // Element-addressed but without a window: the driver cannot lease a window.
      ["set_value", { pid: 1, element_token: "t" }],
    ] as const) {
      expect(claims(name, args)).toContainEqual({ resource: "input", mode: "exclusive" });
      expect(cuaLanesAreExclusive(claims(name, args))).toBe(false);
    }
  });

  it("runs foreground and desktop-changing actions alone", () => {
    for (const name of [
      "bring_to_front",
      "drag",
      "clipboard_read",
      "clipboard_write",
      "launch_app",
      "set_window_frame",
      "kill_app",
    ])
      expect(cuaLanesAreExclusive(claims(name, { pid: 1, window_id: 2 }))).toBe(true);
    expect(
      cuaLanesAreExclusive(
        claims("set_value", {
          pid: 1,
          window_id: 2,
          element_token: "t",
          delivery_mode: "foreground",
        }),
      ),
    ).toBe(true);
    expect(cuaLanesAreExclusive(claims("click", { pid: 1 }, { foreground: true }))).toBe(true);
  });

  it("keeps each thread's browser calls in its own lane, with input for mutations", () => {
    expect(claims("get_browser_state", { target_id: "t" })).toEqual([
      { resource: "desktop", mode: "shared" },
      { resource: "browser:thread", mode: "exclusive" },
    ]);
    expect(claims("browser_click", { target_id: "t" })).toContainEqual({
      resource: "input",
      mode: "exclusive",
    });
  });
});
