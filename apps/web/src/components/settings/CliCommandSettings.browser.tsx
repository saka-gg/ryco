import "../../index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { DesktopBridge, DesktopCliCommandState } from "@ryco/contracts";
import { CliCommandSettings } from "./CliCommandSettings";

const previous = window.desktopBridge;
afterEach(() => {
  if (previous) window.desktopBridge = previous;
  else delete window.desktopBridge;
});

const notInstalled: DesktopCliCommandState = {
  supported: true,
  commandName: "ryco",
  installedPath: null,
  onPath: false,
  launcherPath: null,
};

it("installs and removes the ryco command, and shows why an install was refused", async () => {
  let state = notInstalled;
  const install = vi.fn(async () => {
    if (install.mock.calls.length === 1) {
      throw new Error(
        "Error invoking remote method 'desktop:cli-command-install': Error: Another ryco at /usr/local/bin/ryco runs first in a new terminal.",
      );
    }
    state = {
      ...state,
      installedPath: "/Users/me/.local/bin/ryco",
      onPath: true,
      launcherPath: "/Users/me/.ryco/bin/ryco",
    };
    return state;
  });
  const uninstall = vi.fn(async () => {
    state = { ...state, installedPath: null, onPath: false };
    return state;
  });
  window.desktopBridge = {
    cliCommand: { getState: async () => state, install, uninstall },
  } as unknown as DesktopBridge;
  const view = await render(<CliCommandSettings scope="This device" />);

  await view.getByRole("button", { name: "Install the ryco command" }).click();
  await expect
    .element(view.getByRole("alert"))
    .toHaveTextContent("Another ryco at /usr/local/bin/ryco runs first in a new terminal.");

  await view.getByRole("button", { name: "Install the ryco command" }).click();
  await expect
    .element(
      view.getByText("Installed at /Users/me/.local/bin/ryco. Open a new terminal to use it."),
    )
    .toBeVisible();
  await view.getByRole("button", { name: "Remove the ryco command" }).click();
  expect(uninstall).toHaveBeenCalledOnce();
  await expect
    .element(view.getByRole("button", { name: "Install the ryco command" }))
    .toBeVisible();
});

it("shows nothing where the command is not offered", async () => {
  window.desktopBridge = {
    cliCommand: {
      getState: async () => ({ ...notInstalled, supported: false }),
      install: async () => notInstalled,
      uninstall: async () => notInstalled,
    },
  } as unknown as DesktopBridge;
  const view = await render(<CliCommandSettings scope="This device" />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.container.textContent).toBe("");
});
