import { describe, expect, it } from "vitest";

import {
  deviceToolPresentation,
  resolveDeviceTool,
  type DeviceToolIdentity,
  type DeviceToolStatus,
} from "./deviceToolPresentation.ts";

const label = (identity: DeviceToolIdentity, status: DeviceToolStatus = "completed") =>
  deviceToolPresentation(identity, status)?.label ?? null;

describe("resolveDeviceTool", () => {
  it("reads the action of the device server's tools from their arguments", () => {
    expect(
      resolveDeviceTool({ name: "mcp__ryco_device__device", input: { action: "tap" } }),
    ).toEqual({ action: "tap", proposal: false });
    expect(
      resolveDeviceTool({
        name: "mcp__ryco_device__device_read",
        input: { action: "describe_ui" },
      }),
    ).toEqual({ action: "describe_ui", proposal: false });
  });

  it("recognises every provider's spelling of the server and tool", () => {
    const input = { action: "swipe" };
    for (const identity of [
      { name: "mcp__ryco_device__device", input },
      { name: "device", server: "ryco_device", input },
      { name: "device", server: "ryco-device", input },
      { name: "ryco-device-device", input },
      { name: "ryco-device: device", input },
      { name: "ryco_device_0f6c1d2e-aa11-4bb2-9cc3-ddeeff001122_device", input },
      { name: "ryco_device.device", input },
    ] satisfies DeviceToolIdentity[]) {
      expect(resolveDeviceTool(identity), identity.name).toEqual({
        action: "swipe",
        proposal: false,
      });
    }
  });

  it("recognises the older one-tool-per-action names", () => {
    expect(resolveDeviceTool({ name: "mcp__ryco_device__device_press_button" })).toEqual({
      action: "press_button",
      proposal: false,
    });
    expect(resolveDeviceTool({ name: "device_scroll_to_element", server: "ryco_device" })).toEqual({
      action: "scroll_to_element",
      proposal: false,
    });
    expect(resolveDeviceTool({ name: "ryco_device_ses_42_device_list" })).toEqual({
      action: "list",
      proposal: false,
    });
    expect(resolveDeviceTool({ name: "device_screenshot" })).toEqual({
      action: "screenshot",
      proposal: false,
    });
  });

  it("recognises Agent Control's device tools and proposals", () => {
    expect(
      resolveDeviceTool({ name: "mcp__ryco__ryco_device", input: { action: "describe" } }),
    ).toEqual({ action: "describe_ui", proposal: false });
    expect(resolveDeviceTool({ name: "ryco_list_devices", server: "ryco_agent_control" })).toEqual({
      action: "list",
      proposal: false,
    });
    expect(resolveDeviceTool({ name: "mcp__ryco__ryco_propose_device_boot" })).toEqual({
      action: "boot",
      proposal: true,
    });
  });

  it("leaves other servers' tools and unknown names alone", () => {
    expect(resolveDeviceTool({ name: "device" })).toBeNull();
    expect(resolveDeviceTool({ name: "mcp__other__device", input: { action: "tap" } })).toBeNull();
    expect(resolveDeviceTool({ name: "device_tap", server: "other" })).toBeNull();
    expect(resolveDeviceTool({ name: "ryco_list_devices", server: "other" })).toBeNull();
    expect(resolveDeviceTool({ name: "mcp__ryco_device__device_frobnicate" })).toBeNull();
    expect(resolveDeviceTool({ name: "mcp__ryco__ryco_propose_device_explode" })).toBeNull();
    expect(resolveDeviceTool({ name: "MCP tool call" })).toBeNull();
  });

  it("falls back to a generic action when the arguments did not arrive", () => {
    expect(resolveDeviceTool({ name: "mcp__ryco_device__device" })?.action).toBe("use");
    expect(resolveDeviceTool({ name: "ryco_device-device_read" })?.action).toBe("read");
    expect(
      resolveDeviceTool({ name: "mcp__ryco_device__device", input: { action: "dance" } })?.action,
    ).toBe("use");
  });
});

describe("deviceToolPresentation", () => {
  const tap = { name: "mcp__ryco_device__device", input: { action: "tap", label: "Sign in" } };

  it("uses the running form while the call runs and the settled form after", () => {
    expect(label(tap, "running")).toBe('Tapping "Sign in"');
    expect(label(tap, "completed")).toBe('Tapped "Sign in"');
  });

  it("keeps the base form for a failed call", () => {
    expect(label(tap, "failed")).toBe('Tap "Sign in"');
  });

  it("splits verb and target", () => {
    expect(deviceToolPresentation(tap, "completed")).toEqual({
      verb: "Tapped",
      target: '"Sign in"',
      label: 'Tapped "Sign in"',
    });
  });

  it("shows an element ref as-is, with its label when given", () => {
    const name = "mcp__ryco_device__device";
    expect(label({ name, input: { action: "tap", ref: "@e5" } })).toBe("Tapped @e5");
    expect(label({ name, input: { action: "tap", ref: "@e5", label: "Done" } })).toBe(
      'Tapped @e5 "Done"',
    );
    expect(label({ name, input: { action: "tap", x: 120, y: 340.256 } })).toBe(
      "Tapped at 120, 340.26",
    );
    expect(label({ name, input: { action: "tap" } })).toBe("Tapped");
  });

  it("clips long labels and typed text to 40 characters", () => {
    const long = "a".repeat(60);
    const typed = label({ name: "device_type", input: { text: `${long}\nmore` } }, "running");
    expect(typed).toBe(`Typing "${"a".repeat(39)}…"`);
    expect(label({ name: "device_tap", input: { label: long } })).toBe(
      `Tapped "${"a".repeat(39)}…"`,
    );
  });

  it("labels every action", () => {
    const name = "mcp__ryco_device__device";
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ action: "type", text: "hello" }, 'Typed "hello"'],
      [
        { action: "swipe", fromX: 10, fromY: 600, toX: 10, toY: 100 },
        "Swiped from 10, 600 to 10, 100",
      ],
      [{ action: "press_button", button: "home" }, "Pressed Home"],
      [{ action: "press_button", button: "volume-up" }, "Pressed Volume up"],
      [{ action: "scroll_to_element", label: "Privacy" }, 'Scrolled to "Privacy"'],
      [{ action: "launch", bundleId: "com.example.app" }, "Launched com.example.app"],
      [{ action: "open_url", url: "myapp://settings" }, "Opened myapp://settings"],
      [{ action: "boot", udid: "X" }, "Booted the device"],
      [{ action: "install", appPath: "/tmp/build/My App.app/" }, "Installed My App.app"],
      [
        { action: "configure", setting: { type: "appearance", value: "dark" } },
        "Configured dark appearance",
      ],
      [
        { action: "configure", setting: { type: "text-size", value: "extra-large" } },
        "Configured text size extra large",
      ],
      [
        { action: "configure", setting: { type: "location", latitude: 52.52, longitude: 13.4 } },
        "Configured location 52.52, 13.4",
      ],
      [
        {
          action: "configure",
          setting: { type: "permission", service: "photos", decision: "grant" },
        },
        "Configured photos permission",
      ],
      [{ action: "configure" }, "Configured the device"],
    ];
    for (const [input, expected] of cases) {
      expect(label({ name, input })).toBe(expected);
    }
    const read = "mcp__ryco_device__device_read";
    expect(label({ name: read, input: { action: "list" } })).toBe("Listed devices");
    expect(label({ name: read, input: { action: "screenshot" } }, "running")).toBe(
      "Taking a screenshot",
    );
    expect(label({ name: read, input: { action: "screenshot" } })).toBe("Took a screenshot");
    expect(label({ name: read, input: { action: "describe_ui" } }, "running")).toBe(
      "Reading the screen",
    );
    expect(label({ name: read, input: { action: "logs", bundleId: "com.x" } })).toBe(
      "Read device logs",
    );
    expect(label({ name: read, input: { action: "wait", label: "Done" } }, "running")).toBe(
      'Waiting for "Done"',
    );
    expect(label({ name: read, input: { action: "wait", ref: "@e2", gone: true } })).toBe(
      "Waited for @e2 to disappear",
    );
    expect(label({ name: read, input: { action: "wait" } })).toBe(
      "Waited for the screen to settle",
    );
  });

  it("labels the legacy names like the new ones", () => {
    expect(label({ name: "mcp__ryco_device__device_tap", input: { ref: "@e5" } })).toBe(
      "Tapped @e5",
    );
    expect(
      label({ name: "device_launch", server: "ryco_device", input: { bundleId: "a.b" } }),
    ).toBe("Launched a.b");
    expect(label({ name: "mcp__ryco_device__device_list" }, "running")).toBe("Listing devices");
  });

  it("labels Agent Control's tools", () => {
    expect(
      label({ name: "mcp__ryco__ryco_device", input: { action: "describe" } }, "running"),
    ).toBe("Reading the screen");
    expect(label({ name: "mcp__ryco__ryco_read_device_screenshot" })).toBe("Took a screenshot");
    expect(label({ name: "mcp__ryco__ryco_read_device_state" })).toBe("Read device state");
    expect(label({ name: "mcp__ryco__ryco_describe_device_ui" })).toBe("Read the screen");
    expect(label({ name: "mcp__ryco__ryco_list_devices" }, "running")).toBe("Listing devices");
  });

  it("labels proposals as requests", () => {
    const name = (action: string) => `mcp__ryco__ryco_propose_device_${action}`;
    expect(label({ name: name("boot") })).toBe("Requested device boot");
    expect(label({ name: name("boot") }, "running")).toBe("Requesting device boot");
    expect(label({ name: name("launch"), input: { bundleId: "com.example.app" } })).toBe(
      "Requested app launch com.example.app",
    );
    expect(label({ name: name("input"), input: { action: { kind: "tap", x: 1, y: 2 } } })).toBe(
      "Requested a tap at 1, 2",
    );
    expect(
      label({ name: name("input"), input: { action: { kind: "press-button", button: "home" } } }),
    ).toBe("Requested a Home button press");
    expect(label({ name: name("input") })).toBe("Requested device input");
    expect(label({ name: name("recording"), input: { action: "start" } })).toBe(
      "Requested recording start",
    );
  });

  it("says only that the device was used when the arguments are missing", () => {
    expect(label({ name: "mcp__ryco_device__device" }, "running")).toBe("Using the device");
    expect(label({ name: "mcp__ryco_device__device_read" })).toBe("Read the device");
  });

  it("returns null for other tools", () => {
    expect(deviceToolPresentation({ name: "mcp__github__device" }, "completed")).toBeNull();
  });
});
