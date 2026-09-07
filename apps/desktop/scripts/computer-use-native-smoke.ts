import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
const fixture = spawn(executable, [], { stdio: "ignore" });
const helper = new ComputerNativeHelper(
  join(desktop, "resources/ryco-computer-use-helper"),
  join(directory, "helper"),
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
  const apps = decoded(await execute({ action: "apps" }));
  assert(
    apps.some((entry: { id: string }) => entry.id === appPath),
    "Fixture must be discovered",
  );
  const windows = decoded(await execute({ action: "windows", app: appPath }));
  assert.equal(windows.length, 1);
  const window = windows[0].id;
  const observed = await execute({ action: "observe", app: appPath, window });
  assert(
    observed.content.some((part) => part.type === "image"),
    "Must capture the actual fixture window",
  );
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
  const final = decoded(
    await execute({ action: "observe", app: appPath, window, screenshot: false }),
  );
  assert.match(final.accessibility.tree, /Saved Ada/);
  console.log(
    "PASS: live macOS app discovery, capture, accessibility, background value entry and button invocation verified from resulting UI.",
  );
} finally {
  driver.stop();
  fixture.kill("SIGKILL");
  rmSync(directory, { recursive: true, force: true });
}
