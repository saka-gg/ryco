import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerNativeHelper } from "../src/computerUse/helper.ts";
import { NativeComputerDriver } from "../src/computerUse/native.ts";
import { ComputerPolicyController, DEFAULT_COMPUTER_POLICY } from "../src/computerUse/policy.ts";

// Explicit device selection: never choose the first booted/personal device.
const udid = process.argv[2];
assert(
  process.platform === "darwin" && udid,
  "Usage: bun apps/desktop/scripts/computer-use-simulator-smoke.ts <booted simulator UDID>",
);
const devices = JSON.parse(
  execFileSync("xcrun", ["simctl", "list", "devices", "booted", "--json"], { encoding: "utf8" }),
);
const device = (
  Object.values(devices.devices).flat() as Array<{ udid: string; name: string }>
).find((item) => item.udid === udid);
assert(device, "The selected simulator must be booted with a Device Hub/Simulator window open.");
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "ryco-simulator-smoke-"));
const bundle = join(directory, "Fixture.app");
const bundleId = "dev.ryco.computer-use-fixture";
mkdirSync(bundle);
const helper = new ComputerNativeHelper(
  process.env.RYCO_COMPUTER_HELPER ?? join(desktop, "resources/ryco-computer-use-helper"),
  join(directory, "helper"),
);
const driver = new NativeComputerDriver(helper, "/Applications/Ryco.app");
const decoded = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  JSON.parse(result.content[0]!.text!);
let installed = false;
try {
  const apps = await driver.listApps();
  const host = apps.find((app) => /\/(DeviceHub|Simulator)\.app$/u.test(app.id));
  assert(host, "Open the selected device in Device Hub or Simulator first.");
  const controller = new ComputerPolicyController({
    policy: { ...DEFAULT_COMPUTER_POLICY, enabled: true, apps: { [host.id]: "allow" } },
    consent: async () => {
      throw new Error("The simulator smoke test must not take foreground control.");
    },
    persist: () => {},
    activity: () => {},
    cancel: () => driver.stop(),
  });
  const execute = (args: Record<string, unknown>) =>
    controller.execute(
      {
        sessionId: "simulator-smoke",
        threadId: "smoke",
        turnId: "turn",
        tool: "computer",
        args: { app: host.id, ...args },
      },
      new AbortController().signal,
      (context) => driver.execute(context),
    );
  const windows = decoded(await execute({ action: "windows" })) as Array<{
    id: number;
    title: string;
  }>;
  const selectedWindow = process.env.RYCO_SIMULATOR_WINDOW;
  const matching = windows.filter(
    (window) =>
      (!selectedWindow || window.id === Number(selectedWindow)) &&
      (window.title === device.name || window.title.startsWith(`${device.name} –`)),
  );
  assert.equal(
    matching.length,
    1,
    "Open exactly one window for this device (prefer Open in New Window).",
  );
  const window = matching[0]!.id;
  execFileSync("xcrun", [
    "--sdk",
    "iphonesimulator",
    "swiftc",
    "-parse-as-library",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-ios26.0-simulator`,
    join(desktop, "scripts/fixtures/SimulatorComputerUseFixture.swift"),
    "-o",
    join(bundle, "Fixture"),
  ]);
  writeFileSync(
    join(bundle, "Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleName</key><string>Ryco Capture Test</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string>
<key>MinimumOSVersion</key><string>26.0</string><key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
<key>UILaunchScreen</key><dict/><key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/></dict>
</dict></plist>`,
  );
  execFileSync("xcrun", ["simctl", "install", udid, bundle]);
  installed = true;
  execFileSync("xcrun", ["simctl", "launch", "--terminate-running-process", udid, bundleId]);
  const durations: number[] = [];
  const observe = async (text: boolean, max_dimension = 1600) => {
    const start = performance.now();
    const result = await execute({ action: "observe", window, accessibility: text, max_dimension });
    durations.push(performance.now() - start);
    assert(!result.isError, "Observation must return pixels");
    const image = result.content.find((part) => part.type === "image");
    assert(image?.type === "image" && image.data.length > 1000);
    const state = decoded(result);
    assert.equal(state.screenshotStatus, "captured");
    assert.equal(state.screenshots[0].captureMethod, "screen_capture_kit_stream");
    assert(state.screenshots[0].scale > 0);
    return { state, image };
  };
  const waitFor = async (expected: string) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await observe(true);
      if (result.state.accessibility?.tree.includes(expected)) return result;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Simulator did not render ${expected}`);
  };
  const find = async (name: string) => {
    const found = decoded(await execute({ action: "find_elements", window, name }));
    const element = found.elements?.find((item: { name: string }) => item.name === name);
    assert(element, `Missing ${name}`);
    return element;
  };
  let previous = await waitFor("Count 0");
  for (let count = 1; count <= 20; count++) {
    const button = await find("Increment");
    const result = decoded(
      await execute({
        action: "click",
        window,
        x: button.bounds.x + button.bounds.width / 2,
        y: button.bounds.y + button.bounds.height / 2,
      }),
    );
    assert.equal(result.delivery?.delivered, "background", JSON.stringify(result));
    const next = await waitFor(`"Count ${count}"`);
    assert.notEqual(previous.image.data, next.image.data, "Fresh pixels must reflect the tap");
    previous = next;
  }
  if (host.id.endsWith("/DeviceHub.app")) {
    const button = await find("Increment");
    const refused = decoded(
      await execute({
        action: "click",
        window,
        mouse_button: "right",
        x: button.bounds.x + button.bounds.width / 2,
        y: button.bounds.y + button.bounds.height / 2,
      }),
    );
    assert(refused.refused, "Unsupported clicks must not silently become a left tap");
    await waitFor('"Count 20"');
  }
  const field = await find("Sample text");
  const entered = decoded(
    await execute({
      action: "set_element_value",
      window,
      element_id: field.id,
      value: "Ryco café 123",
    }),
  );
  assert.equal(entered.delivery?.delivered, "background");
  await waitFor("Entered: Ryco café 123");
  for (let index = 0; index < 10; index++) {
    const captured = await observe(false, index % 2 === 0 ? 1600 : 2400);
    assert.equal(captured.state.accessibility, null);
  }
  durations.sort((a, b) => a - b);
  console.log(
    `PASS: 20 verified phone taps, Unicode text entry, fresh images, 10 screenshot-only captures. Capture median ${Math.round(durations[Math.floor(durations.length / 2)]!)}ms; max ${Math.round(durations.at(-1)!)}ms.`,
  );
} finally {
  driver.stop();
  if (installed) execFileSync("xcrun", ["simctl", "uninstall", udid, bundleId]);
  rmSync(directory, { recursive: true, force: true });
}
