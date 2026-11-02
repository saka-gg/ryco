import "../../index.css";
import { EnvironmentId } from "@ryco/contracts";
import { page } from "vitest/browser";
import { expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

// The search field's chunk never arrives (a deploy removed it, the network dropped).
vi.mock("./SettingsNodeCombobox", () => ({
  get SettingsNodeCombobox(): never {
    throw new Error("Failed to fetch dynamically imported module");
  },
}));

import { type SettingsNodeMenuModel, SettingsNodeMenu } from "./SettingsNodeMenu";

it("keeps the plain menu when the search field cannot load", async () => {
  const select = vi.fn();
  const model: SettingsNodeMenuModel = {
    choices: Array.from({ length: 8 }, (_, index) => ({
      environmentId: EnvironmentId.make(`node_${String(index).repeat(22)}`),
      label: `Rack ${index + 1}`,
      disabled: false,
      status: null,
    })),
    value: EnvironmentId.make(`node_${"0".repeat(22)}`),
    select,
  };
  await render(
    <SettingsNodeMenu model={model} trigger={<button type="button">Switch device</button>} />,
  );
  await page.getByRole("button", { name: "Switch device" }).click();
  await page.getByRole("menuitemradio", { name: "Rack 4" }).click();
  expect(select).toHaveBeenCalledWith(`node_${"3".repeat(22)}`);
});
