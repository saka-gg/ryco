import "../../index.css";
import { EnvironmentId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { resetAppKeybindings, getAppKeybindings } from "../../appKeybindings";
import { replaceAppKeybindings } from "../../appKeybindingsEditing";
import { APP_KEYBINDINGS_STORAGE_KEY } from "@ryco/client-runtime/state/settings";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { SettingsTargetProvider } from "../../settingsTarget";
import { keybindingRowId } from "../../lib/keybindingCategories";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";
import type { SettingsSearchTarget } from "./settingsSearchReveal";
import { useSettingsSubsections } from "./useSettingsSubsections";

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
/** The panel inside the settings page's scroller, which reveals a search result's target. */
function SearchTargetHarness({ searchTarget }: { searchTarget: SettingsSearchTarget }) {
  const { contentRef } = useSettingsSubsections("keybindings", false, searchTarget);
  return (
    <div ref={contentRef} data-testid="settings-scroller" style={{ height: 600, overflow: "auto" }}>
      <KeybindingsSettingsPanel />
    </div>
  );
}
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
  it("treats client-only defaults as defaults when editing and resetting a command", async () => {
    await mount();
    await page.getByLabelText("Search keybindings").fill("without a project");
    const reset = page.getByRole("button", {
      name: "Reset New chat without a project to default",
      exact: true,
    });
    const chip = page.getByRole("button", {
      name: "Edit shortcut for chat.newWithoutProject",
      exact: true,
    });
    await expect.element(chip).toBeInTheDocument();
    expect(reset.elements()).toHaveLength(0);
    await chip.click();
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "y",
        code: "KeyY",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await expect
      .poll(
        () =>
          getAppKeybindings().find((rule) => rule.command === "chat.newWithoutProject")?.shortcut
            .key,
      )
      .toBe("y");
    await reset.click();
    await expect
      .poll(
        () =>
          getAppKeybindings().find((rule) => rule.command === "chat.newWithoutProject")?.shortcut,
      )
      .toMatchObject({ key: "n", altKey: true, modKey: true });
    expect(JSON.parse(localStorage.getItem(APP_KEYBINDINGS_STORAGE_KEY)!)).toEqual({
      rules: [],
      disabledCommands: [],
    });
  });
  it("scrolls to and highlights the row a settings search result names", async () => {
    screen = await render(
      <AppAtomRegistryProvider>
        <SettingsTargetProvider value={target}>
          <SearchTargetHarness searchTarget={{ targetId: keybindingRowId("navigation.back") }} />
        </SettingsTargetProvider>
      </AppAtomRegistryProvider>,
    );
    const scroller = page.getByTestId("settings-scroller").element();
    await vi.waitFor(() => {
      const row = document.activeElement as HTMLElement | null;
      expect(row?.dataset.keybindingCommand).toBe("navigation.back");
      expect(row?.dataset.flash).toBe("true");
      const { top, bottom } = scroller.getBoundingClientRect();
      const rowBox = row!.getBoundingClientRect();
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(rowBox.top).toBeGreaterThanOrEqual(top);
      expect(rowBox.bottom).toBeLessThanOrEqual(bottom);
    });
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
  it("keeps working with shortcuts saved by a newer version and saves them back", async () => {
    await mount();
    const futureRule = { key: "mod+shift+t", command: "view.futureCommand", extra: 1 };
    localStorage.setItem(
      APP_KEYBINDINGS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        rules: [{ key: "mod+x", command: "terminal.toggle" }, futureRule],
        disabledCommands: ["future.command", "chat.newLocal"],
      }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: APP_KEYBINDINGS_STORAGE_KEY }));
    const shortcutKey = (command: string) =>
      getAppKeybindings().find((rule) => rule.command === command)?.shortcut.key;
    await expect.poll(() => shortcutKey("terminal.toggle")).toBe("x");
    expect(getAppKeybindings().some((rule) => rule.command === "chat.newLocal")).toBe(false);
    expect(
      page.getByText("Local keybindings need attention", { exact: true }).elements(),
    ).toHaveLength(0);
    await expect
      .element(page.getByRole("button", { name: "Restore defaults", exact: true }))
      .toBeEnabled();
    await page.getByRole("button", { name: "Edit shortcut for diff.toggle", exact: true }).click();
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "y",
        code: "KeyY",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await expect.poll(() => shortcutKey("diff.toggle")).toBe("y");
    const stored = JSON.parse(localStorage.getItem(APP_KEYBINDINGS_STORAGE_KEY)!);
    expect(stored.version).toBe(2);
    expect(stored.rules).toContainEqual(futureRule);
    expect(stored.disabledCommands).toEqual(
      expect.arrayContaining(["future.command", "chat.newLocal"]),
    );
  });
  it("supports deliberately disabling a shortcut and preserves it through reset/reimport", async () => {
    await replaceAppKeybindings([]);
    await mount();
    expect(getAppKeybindings()).toHaveLength(0);
    await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
    await expect.poll(() => getAppKeybindings().length).toBeGreaterThan(0);
  });
});
