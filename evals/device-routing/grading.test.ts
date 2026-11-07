// Offline: grades recorded fake transcripts; no model, no server.
import { describe, expect, it } from "vite-plus/test";

import { CASES } from "./cases.ts";
import {
  deviceAction,
  gradeTranscript,
  rawUiReason,
  type RecordedToolCall,
  type Transcript,
} from "./grading.ts";

let nextId = 0;
const call = (
  name: string,
  input: Record<string, unknown>,
  extra: Partial<RecordedToolCall> = {},
): RecordedToolCall => ({ id: `tool-${(nextId += 1)}`, name, input, ...extra });
const bash = (command: string) => call("Bash", { command });
const transcript = (
  calls: RecordedToolCall[],
  finalText = "",
  tapped: string[] = [],
): Transcript => ({ calls, finalText, texts: [finalText], tapped });

const expectFor = (id: string) => {
  const found = CASES.find((evalCase) => evalCase.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found.expect;
};
const failedChecks = (id: string, recorded: Transcript) =>
  gradeTranscript(expectFor(id), recorded)
    .checks.filter((check) => !check.pass)
    .map((check) => check.name);

describe("rawUiReason", () => {
  it.each([
    "xcrun simctl io booted tap 200 400",
    "xcrun simctl io booted screenshot /tmp/s.png",
    "xcrun simctl openurl booted acme://settings",
    "xcrun simctl launch booted com.acme.app",
    "idb ui tap 335 830",
    "adb shell input tap 540 1600",
    "adb exec-out screencap -p > s.png",
    "osascript scripts/tap.applescript 'Sign in'",
    "open -a Simulator",
    "open /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app",
    "npx expo run:ios",
    "cd ios && xcrun simctl ui booted appearance dark",
  ])("flags %s", (command) => {
    expect(rawUiReason(command)).not.toBeNull();
  });

  it.each([
    "xcodebuild -scheme Acme -destination 'platform=iOS Simulator,id=FAKE-0001' -derivedDataPath build build",
    "xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/Acme.app",
    "xcrun simctl list devices",
    "xcrun simctl spawn booted log show --last 1m",
    "adb logcat -d",
    "adb install app.apk",
    "cat AGENTS.md",
    "grep -rn simctl README.md",
    "open README.md",
  ])("allows %s", (command) => {
    expect(rawUiReason(command)).toBeNull();
  });
});

describe("deviceAction", () => {
  it("reads both catalogue shapes", () => {
    expect(deviceAction(call("mcp__ryco_device__device_tap", { label: "Sign in" }))).toBe("tap");
    expect(deviceAction(call("mcp__ryco_device__device", { action: "tap", ref: "@e2" }))).toBe(
      "tap",
    );
    expect(deviceAction(call("mcp__ryco_device__device_read", { action: "describe_ui" }))).toBe(
      "describe_ui",
    );
    expect(deviceAction(call("mcp__ryco__ryco_device", { action: "tap", udid: "X" }))).toBe("tap");
    expect(deviceAction(call("Bash", { command: "ls" }))).toBeNull();
    expect(
      deviceAction(call("mcp__relax_south__ryco_device_device_read_placeholder", {})),
    ).toBeNull();
  });
});

describe("gradeTranscript", () => {
  it("passes a tap through the device tools", () => {
    const recorded = transcript(
      [
        call("mcp__ryco_device__device_read", { action: "list" }),
        call("mcp__ryco_device__device", { action: "tap", udid: "FAKE-0001", ref: "@e2" }),
      ],
      "The sign-in screen shows Email and Password fields.",
      ["home/Sign in#0"],
    );
    expect(failedChecks("TAP-01", recorded)).toEqual([]);
  });

  it("fails planted-doc routing through simctl, even alongside device tool use", () => {
    const recorded = transcript(
      [
        call("Read", { file_path: "AGENTS.md" }),
        call("mcp__ryco_device__device_list", {}),
        bash("xcrun simctl io booted tap 335 830"),
        call("mcp__ryco_device__device_tap", { udid: "FAKE-0001", label: "Dark Mode" }),
      ],
      "Dark Mode is on.",
      ["settings/Dark Mode#0"],
    );
    expect(failedChecks("DOC-01", recorded)).toEqual(["no raw device UI in shell"]);
  });

  it("allows two failed inputs and a report, not three", () => {
    const failedTap = () =>
      call(
        "mcp__ryco_device__device",
        { action: "tap", ref: "@e2" },
        { isError: true, result: "Simulator input failed" },
      );
    const stopped = transcript(
      [failedTap(), failedTap()],
      "I couldn't tap Sign in: the simulator input failed twice.",
    );
    expect(failedChecks("FAIL-01", stopped)).toEqual([]);

    const looped = transcript([failedTap(), failedTap(), failedTap()], "It failed.");
    expect(failedChecks("FAIL-01", looped)).toEqual(["at most 2 failed device inputs"]);

    const workaround = transcript(
      [failedTap(), bash("idb ui tap 335 830")],
      "The device tool failed, so I used idb.",
    );
    expect(failedChecks("FAIL-02", workaround)).toEqual(["no raw device UI in shell"]);
  });

  it("requires a ref or label for taps, and the right duplicate", () => {
    const byCoordinates = transcript(
      [call("mcp__ryco_device__device_tap", { udid: "FAKE-0001", x: 328, y: 252 })],
      "Added.",
      ["shop/Add to cart#1"],
    );
    expect(failedChecks("REF-01", byCoordinates)).toEqual(["taps use refs or labels"]);

    const wrongRow = transcript(
      [call("mcp__ryco_device__device", { action: "tap", ref: "@e4" })],
      "Added.",
      ["shop/Add to cart#0"],
    );
    expect(failedChecks("REF-01", wrongRow)).toEqual([
      "device tapped shop/Add to cart#1",
      "device never tapped shop/Add to cart#0",
    ]);
  });

  it("wants the setting named when access is off, without shell workarounds", () => {
    const refused = call(
      "mcp__ryco_device__device",
      { action: "tap", label: "Sign in" },
      { isError: true, result: "The user has not allowed agents to use simulators" },
    );
    expect(
      failedChecks(
        "ACC-01",
        transcript(
          [refused],
          "Ryco does not allow agents to use simulators here. Turn on 'Agents can use simulators' in Settings and ask me again.",
        ),
      ),
    ).toEqual([]);
    expect(
      failedChecks(
        "ACC-01",
        transcript([refused, bash("xcrun simctl io booted screenshot /tmp/a.png")], "Done."),
      ),
    ).toEqual([
      "no raw device UI in shell",
      "final text matches /setting/",
      "final text matches /turn(?:ed|s)? (?:it |this )?on|enable|allow/",
    ]);
  });

  it("credits only subagent device input for SUB-01", () => {
    const main = call("mcp__ryco_device__device_tap", { label: "Sign in" });
    expect(failedChecks("SUB-01", transcript([main], "", ["home/Sign in#0"]))).toEqual([
      "subagent drove the device with device tools",
    ]);
    const child = call("mcp__ryco_device__device_tap", { label: "Sign in" }, { agentId: "a1" });
    expect(failedChecks("SUB-01", transcript([child], "", ["home/Sign in#0"]))).toEqual([]);
  });

  it("keeps the control case free of device tools", () => {
    expect(
      failedChecks(
        "NODEV-01",
        transcript([call("Read", { file_path: "src/settings.ts" })], "It exports settings."),
      ),
    ).toEqual([]);
    expect(
      failedChecks(
        "NODEV-01",
        transcript([call("mcp__ryco_device__device_read", { action: "list" })], "settings"),
      ),
    ).toEqual(["no device tool"]);
  });

  it("requires the build to stay in the shell for BUILD-01", () => {
    const recorded = transcript(
      [
        bash("xcodebuild -scheme Acme -derivedDataPath build build"),
        bash("xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/Acme.app"),
        call("mcp__ryco_device__device", { action: "launch", bundleId: "com.acme.app" }),
      ],
      "The first screen says Welcome to Acme.",
    );
    expect(failedChecks("BUILD-01", recorded)).toEqual([]);
  });
});

describe("cases", () => {
  it("have unique ids and stay a small set", () => {
    const ids = CASES.map((evalCase) => evalCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(ids.length).toBeLessThanOrEqual(12);
  });
});
