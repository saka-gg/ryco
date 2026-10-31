import "../../index.css";
import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { getClientSettingsSnapshot } from "../../hooks/clientSettingsStore";
import { ClientSettingsFileActions } from "./ClientSettingsFileActions";

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

it("shows what a preferences file would change, then applies it", async () => {
  const view = await render(<ClientSettingsFileActions />);
  const file = new File(
    [
      JSON.stringify({
        format: "ryco-client-settings",
        version: 1,
        client: { chatWidth: "wide", favorites: [] },
      }),
    ],
    "ryco-client-settings.json",
    { type: "application/json" },
  );
  await userEvent.upload(view.getByLabelText("Preferences file to import"), file);

  await expect.element(page.getByText('chatWidth: "comfortable" -> "wide"')).toBeVisible();
  await expect
    .element(page.getByText("favorites: not a setting this file carries, left as it is"))
    .toBeVisible();
  expect(getClientSettingsSnapshot().chatWidth).toBe("comfortable");

  await page.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => getClientSettingsSnapshot().chatWidth).toBe("wide");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("refuses a file that is not a preferences file before anything changes", async () => {
  const view = await render(<ClientSettingsFileActions />);
  await userEvent.upload(
    view.getByLabelText("Preferences file to import"),
    new File(["{}"], "other.json", { type: "application/json" }),
  );
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("This is not a Ryco preferences file.");
});
