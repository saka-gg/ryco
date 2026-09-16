import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerNativeHelper } from "../src/computerUse/helper.ts";
import { NativeComputerDriver } from "../src/computerUse/native.ts";
import { ComputerPolicyController, DEFAULT_COMPUTER_POLICY } from "../src/computerUse/policy.ts";
import type { ComputerUseRequest } from "@ryco/contracts";

if (process.platform !== "darwin")
  throw new Error("This live native smoke fixture requires macOS.");
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "ryco-native-smoke-"));
const appPath = join(directory, "Ryco Automation Fixture.app");
const executable = join(appPath, "Contents/MacOS/Fixture");
mkdirSync(dirname(executable), { recursive: true });
writeFileSync(
  join(appPath, "Contents/Info.plist"),
  `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.ryco.automation-fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Ryco Automation Fixture</string><key>LSUIElement</key><true/></dict></plist>`,
);
execFileSync("xcrun", [
  "swiftc",
  "-framework",
  "AppKit",
  join(desktop, "scripts/fixtures/ComputerUseFixture.swift"),
  "-o",
  executable,
]);
const focusLog = join(directory, "focus.json");
const fixture = spawn(executable, [focusLog], { stdio: "ignore" });
let captureStopped = false;
const helper = new ComputerNativeHelper(
  process.env.RYCO_COMPUTER_HELPER ?? join(desktop, "resources/ryco-computer-use-helper"),
  join(directory, "helper"),
  () => {
    captureStopped = true;
    controller.stop();
  },
);
const driver = new NativeComputerDriver(helper, "/Applications/Ryco.app");
const controller = new ComputerPolicyController({
  policy: { ...DEFAULT_COMPUTER_POLICY, enabled: true, apps: { [appPath]: "allow" } },
  consent: async () => {
    throw new Error("Unexpected consent");
  },
  persist: () => {},
  activity: () => {},
  cancel: () => driver.stop(),
});
const execute = (args: Record<string, unknown>) => {
  const request: ComputerUseRequest = {
    sessionId: "native-smoke",
    threadId: "smoke",
    turnId: "turn",
    tool: "computer",
    args,
  };
  return controller.execute(request, new AbortController().signal, (context) =>
    driver.execute(context),
  );
};
const decoded = (value: Awaited<ReturnType<typeof execute>>) =>
  JSON.parse((value.content[0] as { text: string }).text);
try {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const focus = () =>
    JSON.parse(readFileSync(focusLog, "utf8")) as {
      activeApps: number[];
      mouseX: number;
      mouseY: number;
    };
  const beforeFocus = focus();
  assert(!beforeFocus.activeApps.includes(fixture.pid!), "Fixture must be inactive for this test");
  const apps = decoded(await execute({ action: "apps" }));
  assert(
    apps.some((entry: { id: string }) => entry.id === appPath),
    "Fixture must be discovered",
  );
  const windows = decoded(await execute({ action: "windows", app: appPath }));
  assert.equal(windows.length, 2);
  const window = windows.find(
    (entry: { title: string }) => entry.title === "Ryco automation fixture",
  )?.id;
  const otherWindow = windows.find(
    (entry: { title: string }) => entry.title === "Ryco alternate fixture",
  )?.id;
  assert(window && otherWindow);
  const refused = decoded(
    await execute({
      action: "type_text",
      app: appPath,
      window: otherWindow,
      text: "Must not take focus",
    }),
  );
  assert.equal(refused.refused?.code, "background_unavailable");
  const observed = await execute({ action: "observe", app: appPath, window });
  assert(
    observed.content.some((part) => part.type === "image"),
    "Must capture the actual fixture window",
  );
  assert.equal(decoded(observed).screenshots[0].captureMethod, "screen_capture_kit_stream");
  const typed = decoded(
    await execute({ action: "type_text", app: appPath, window, text: "Background" }),
  );
  assert.equal(typed.delivery?.delivered, "background", JSON.stringify(typed));
  const afterTyping = decoded(await execute({ action: "observe", app: appPath, window }));
  assert.match(afterTyping.accessibility.tree, /Background/);
  const fields = decoded(
    await execute({ action: "find_elements", app: appPath, window, name: "Sample name" }),
  );
  const field = fields.elements?.[0];
  assert(field, "Must find the native text field");
  const set = decoded(
    await execute({
      action: "set_element_value",
      app: appPath,
      window,
      element_id: field.id,
      value: "Ada",
    }),
  );
  assert.equal(set.delivery?.delivered, "background");
  const buttons = decoded(
    await execute({ action: "find_elements", app: appPath, window, name: "Save sample" }),
  );
  const button = buttons.elements?.[0];
  assert(button, "Must find the native save button");
  const click = decoded(
    await execute({
      action: "invoke_element",
      app: appPath,
      window,
      element_id: button.id,
      element_action: "invoke",
    }),
  );
  assert.equal(click.delivery?.delivered, "background");
  const finalObservation = await execute({ action: "observe", app: appPath, window });
  const final = decoded(finalObservation);
  assert.match(final.accessibility.tree, /Saved Ada/);
  assert.equal(final.screenshotStatus, "captured");
  const firstImage = observed.content.find((part) => part.type === "image");
  const finalImage = finalObservation.content.find((part) => part.type === "image");
  assert(firstImage?.type === "image" && finalImage?.type === "image");
  assert.notEqual(firstImage.data, finalImage.data, "Capture must reflect the updated window");
  const pixelsOnly = await execute({
    action: "observe",
    app: appPath,
    window,
    accessibility: false,
    max_dimension: 2400,
  });
  assert.equal(pixelsOnly.isError, undefined);
  assert.equal(decoded(pixelsOnly).accessibility, null);
  assert(pixelsOnly.content.some((part) => part.type === "image"));
  const afterFocus = focus();
  assert(
    !afterFocus.activeApps.includes(fixture.pid!),
    "Background input must never activate the target app",
  );
  assert.deepEqual(
    afterFocus.activeApps,
    beforeFocus.activeApps,
    "Another app must stay active throughout control",
  );
  assert.equal(
    afterFocus.mouseX,
    beforeFocus.mouseX,
    "Background input must not move the system cursor",
  );
  assert.equal(
    afterFocus.mouseY,
    beforeFocus.mouseY,
    "Background input must not move the system cursor",
  );
  fixture.kill("SIGTERM");
  for (let attempt = 0; attempt < 30; attempt++) {
    if (captureStopped) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(captureStopped, "Closing the shared window must report native capture termination");
  await assert.rejects(execute({ action: "windows", app: appPath }), /stopped/);
  console.log(
    "PASS: live macOS app discovery, capture, accessibility, background value entry and button invocation verified from resulting UI; native stream termination revokes the active turn.",
  );
} finally {
  driver.stop();
  fixture.kill("SIGKILL");
  rmSync(directory, { recursive: true, force: true });
}
