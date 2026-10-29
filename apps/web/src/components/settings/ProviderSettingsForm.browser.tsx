import "../../index.css";

import { ProviderDriverKind } from "@ryco/contracts";
import { REDACTED_SETTING_SECRET } from "@ryco/shared/settingsSecrets";
import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

/** Renders a driver's form over config as the server sends it (secrets redacted). */
async function mountProviderForm(driver: string, config: Record<string, unknown>) {
  const published: Array<Record<string, unknown> | undefined> = [];
  const definition = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make(driver)]!;
  function Harness() {
    const [value, setValue] = useState<Record<string, unknown> | undefined>(config);
    return (
      <ProviderSettingsForm
        definition={definition}
        value={value}
        idPrefix={driver}
        variant="card"
        onChange={(next) => {
          published.push(next);
          setValue(next);
        }}
      />
    );
  }
  await render(<Harness />);
  return { published };
}

const mountOpenCodeForm = (config: Record<string, unknown>) =>
  mountProviderForm("opencode", config);

// The label wraps the description too, so match its start.
const passwordInput = () => page.getByLabelText(/^Server password/);

describe("ProviderSettingsForm saved secrets", () => {
  it("shows a saved password as set and keeps it when the input is left empty", async () => {
    const { published } = await mountOpenCodeForm({ serverPassword: REDACTED_SETTING_SECRET });

    await expect.element(passwordInput()).toHaveValue("");
    await expect
      .element(passwordInput())
      .toHaveAttribute("placeholder", "Saved - enter a new value to replace");
    await expect.element(page.getByText("A value is saved.")).toBeVisible();

    await passwordInput().click();
    await userEvent.keyboard("{Enter}");
    expect(published).toEqual([]);
  });

  it("replaces a saved password with a typed one", async () => {
    const { published } = await mountOpenCodeForm({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: REDACTED_SETTING_SECRET,
    });

    await passwordInput().fill("new-password");
    await userEvent.keyboard("{Enter}");
    expect(published.at(-1)).toStrictEqual({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "new-password",
    });
  });

  it("clears a saved password", async () => {
    const { published } = await mountOpenCodeForm({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: REDACTED_SETTING_SECRET,
    });

    await page.getByRole("button", { name: "Clear Server password" }).click();
    expect(published.at(-1)).toStrictEqual({ serverUrl: "http://127.0.0.1:4096" });
    await expect.element(page.getByText("A value is saved.")).not.toBeInTheDocument();
    await expect.element(passwordInput()).toHaveAttribute("placeholder", "Optional");
  });

  it("flags a URL whose credentials the server hid", async () => {
    await mountOpenCodeForm({
      serverUrl: `http://${REDACTED_SETTING_SECRET}:${REDACTED_SETTING_SECRET}@127.0.0.1:4096/`,
    });

    await expect
      .element(
        page.getByText(
          "Credentials in this URL are hidden. To change the URL, enter it again in full.",
        ),
      )
      .toBeVisible();
  });
});

describe("ProviderSettingsForm select fields", () => {
  const autoCompact = () => page.getByRole("combobox", { name: "Automatic compaction" });

  it("shows the default while unset, stores another choice and omits the default again", async () => {
    const { published } = await mountProviderForm("claudeAgent", { launchArgs: "--chrome" });

    await expect.element(autoCompact()).toHaveTextContent("At 80% between turns (Ryco)");

    await autoCompact().click();
    await page.getByRole("option", { name: "When Claude Code decides" }).click();
    expect(published.at(-1)).toStrictEqual({ launchArgs: "--chrome", autoCompact: "claudeCode" });
    await expect.element(autoCompact()).toHaveTextContent("When Claude Code decides");

    await autoCompact().click();
    await page.getByRole("option", { name: "At 80% between turns (Ryco)" }).click();
    expect(published.at(-1)).toStrictEqual({ launchArgs: "--chrome" });
    await expect.element(autoCompact()).toHaveTextContent("At 80% between turns (Ryco)");
  });

  it("shows no choice for a value this client does not offer", async () => {
    await mountProviderForm("claudeAgent", { autoCompact: "fromANewerClient" });

    await expect.element(autoCompact()).toHaveTextContent("Choose…");
  });
});
