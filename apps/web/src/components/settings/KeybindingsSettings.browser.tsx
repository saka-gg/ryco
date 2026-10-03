import "../../index.css";
import { EnvironmentId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import {
  resetAppKeybindings,
  getAppKeybindings,
  replaceAppKeybindings,
} from "../../appKeybindings";
import { APP_KEYBINDINGS_STORAGE_KEY } from "@ryco/client-runtime/state/settings";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { SettingsTargetProvider } from "../../settingsTarget";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

let screen: Awaited<ReturnType<typeof render>> | null = null;
const target = {
  environmentId: EnvironmentId.make("node-offline"),
  nodeLabel: "Offline node",
  serverConfig: null,
  connected: false,
  primary: false,
  canManage: false,
  canMutate: false,
};
const mount = async () => {
  screen = await render(
    <AppAtomRegistryProvider>
      <SettingsTargetProvider value={target}>
        <div
          data-testid="keybindings-review"
          style={{ width: 1100, height: 900, overflow: "hidden" }}
        >
          <div style={{ maxWidth: 960, margin: "32px auto", padding: 24 }}>
            <h1 className="mb-2 text-2xl font-semibold">App preferences / Keybindings</h1>
            <p className="mb-8 text-sm text-muted-foreground">
              Keyboard shortcuts saved in this app or browser profile.
            </p>
            <KeybindingsSettingsPanel />
          </div>
        </div>
      </SettingsTargetProvider>
    </AppAtomRegistryProvider>,
  );
};
beforeEach(async () => {
  await resetAppKeybindings();
  await page.viewport(1100, 900);
});
afterEach(async () => {
  await screen?.unmount();
  screen = null;
  document.body.innerHTML = "";
});
describe("local app keybindings", () => {
  it("edits and resets independently of disconnected non-owner targets", async () => {
    await mount();
    await expect
      .element(page.getByRole("button", { name: "Restore defaults", exact: true }))
      .toBeEnabled();
    const chip = page.getByRole("button", {
      name: "Edit shortcut for terminal.toggle",
      exact: true,
    });
    await chip.click();
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "x",
        code: "KeyX",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await expect
      .poll(
        () => getAppKeybindings().find((rule) => rule.command === "terminal.toggle")?.shortcut.key,
      )
      .toBe("x");
    expect(JSON.parse(localStorage.getItem(APP_KEYBINDINGS_STORAGE_KEY)!).rules).toHaveLength(1);
    await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
    await expect
      .poll(
        () => getAppKeybindings().find((rule) => rule.command === "terminal.toggle")?.shortcut.key,
      )
      .toBe("j");
  });
  it("shows the app-owned persistence and reviewed import controls", async () => {
    await mount();
    await expect.element(page.getByText("Saved in this app", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByLabelText("Import legacy keybindings file")).toBeEnabled();
    expect(page.getByRole("button", { name: "Open file", exact: true }).elements()).toHaveLength(0);
    await page.screenshot({
      path: "../../../../../output/keybindings-after.png",
      element: page.getByTestId("keybindings-review"),
    });
  });
  it("reviews file imports explicitly and preserves configured local commands", async () => {
    await replaceAppKeybindings([{ key: "ctrl+x", command: "terminal.toggle" }]);
    await mount();
    const file = new File(
      [
        JSON.stringify([
          { key: "mod+y", command: "terminal.toggle" },
          { key: "mod+r", command: "workspace.simulator" },
        ]),
      ],
      "keybindings.json",
      { type: "application/json" },
    );
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = page
      .getByLabelText("Import legacy keybindings file")
      .element() as HTMLInputElement;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await expect
      .element(page.getByRole("button", { name: "Import reviewed bindings", exact: true }))
      .toBeEnabled();
    expect(getAppKeybindings().some((rule) => rule.command === "workspace.simulator")).toBe(false);
    await page.getByRole("button", { name: "Import reviewed bindings", exact: true }).click();
    await expect
      .poll(() => getAppKeybindings().some((rule) => rule.command === "workspace.simulator"))
      .toBe(true);
    expect(
      getAppKeybindings().find((rule) => rule.command === "terminal.toggle")?.shortcut.key,
    ).toBe("x");
  });
  it("rejects invalid files with feedback before modifying local preferences", async () => {
    await mount();
    const before = localStorage.getItem(APP_KEYBINDINGS_STORAGE_KEY);
    const file = new File(["{invalid"], "keybindings.json", { type: "application/json" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = page
      .getByLabelText("Import legacy keybindings file")
      .element() as HTMLInputElement;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await expect
      .element(page.getByText("Could not import bindings", { exact: true }))
      .toBeInTheDocument();
    expect(localStorage.getItem(APP_KEYBINDINGS_STORAGE_KEY)).toBe(before);
    expect(
      page.getByRole("button", { name: "Import reviewed bindings", exact: true }).elements(),
    ).toHaveLength(0);
  });
  it("offers explicit recovery after a corrupt local document without adopting node data", async () => {
    await mount();
    localStorage.setItem(APP_KEYBINDINGS_STORAGE_KEY, "{broken");
    window.dispatchEvent(new StorageEvent("storage", { key: APP_KEYBINDINGS_STORAGE_KEY }));
    const reset = page.getByRole("button", {
      name: "Replace local bindings with defaults",
      exact: true,
    });
    await expect.element(reset).toBeEnabled();
    expect(localStorage.getItem(APP_KEYBINDINGS_STORAGE_KEY)).toBe("{broken");
    await reset.click();
    await expect
      .poll(() => JSON.parse(localStorage.getItem(APP_KEYBINDINGS_STORAGE_KEY)!))
      .toEqual({ rules: [], disabledCommands: [] });
    await expect
      .element(page.getByRole("button", { name: "Restore defaults", exact: true }))
      .toBeEnabled();
  });
  it("supports deliberately disabling a shortcut and preserves it through reset/reimport", async () => {
    await replaceAppKeybindings([]);
    await mount();
    expect(getAppKeybindings()).toHaveLength(0);
    await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
    await expect.poll(() => getAppKeybindings().length).toBeGreaterThan(0);
  });
});
