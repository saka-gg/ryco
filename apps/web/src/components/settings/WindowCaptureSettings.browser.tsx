import "../../index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { userEvent } from "vite-plus/test/browser";
import type {
  DesktopAppSnapShortcut,
  DesktopBridge,
  DesktopWindowCaptureShortcutResult,
  DesktopWindowCaptureState,
} from "@ryco/contracts";
import { replaceAppKeybindings, resetAppKeybindings } from "../../appKeybindings";
import { WindowCaptureSettings } from "./WindowCaptureSettings";

const previous = window.desktopBridge;
// The desktop app's keybindings document, which the app keybindings store reads.
let keybindingsDocument: string | null = null;
afterEach(async () => {
  await resetAppKeybindings();
  if (previous) window.desktopBridge = previous;
  else delete window.desktopBridge;
});

function installBridge(initial: Partial<DesktopWindowCaptureState> = {}) {
  let state: DesktopWindowCaptureState = {
    supported: true,
    shortcut: null,
    screenRecordingPermission: "granted",
    inputMonitoringPermission: "denied",
    missingPermissions: [],
    message: null,
    appDisplayName: "Ryco Dev",
    ...initial,
  };
  const setShortcut = vi.fn(
    async (
      shortcut: DesktopAppSnapShortcut | null,
    ): Promise<DesktopWindowCaptureShortcutResult> => {
      state = {
        ...state,
        shortcut,
        missingPermissions: shortcut?.kind === "both-option-keys" ? ["inputMonitoring"] : [],
      };
      return { state, availability: { available: true, reason: null } };
    },
  );
  const setup = vi.fn(async () => state);
  window.desktopBridge = {
    windowCapture: {
      getState: async () => state,
      setup,
      setShortcut,
      onState: () => () => {},
    },
    appKeybindings: {
      read: async () => keybindingsDocument,
      write: async (document: string) => {
        keybindingsDocument = document;
      },
      onChanged: () => () => {},
    },
  } as unknown as DesktopBridge;
  return { setShortcut, setup };
}

it("stays off by default and asks for Input Monitoring only for the Option-key shortcut", async () => {
  const { setShortcut, setup } = installBridge();
  const view = await render(<WindowCaptureSettings />);
  const select = view.getByRole("combobox", { name: "Capture shortcut" });
  await expect.element(select).toHaveTextContent("Off");
  await expect.element(view.getByRole("button", { name: "Set up" })).toBeDisabled();
  await expect.element(view.getByText("Input Monitoring")).not.toBeInTheDocument();

  await select.click();
  await view.getByRole("option", { name: "Both ⌥ Option keys" }).click();
  expect(setShortcut).toHaveBeenCalledWith({ kind: "both-option-keys" });
  await expect.element(view.getByText("Input Monitoring")).toBeVisible();
  await expect
    .element(view.getByText("The shortcut starts working once the permissions below are allowed."))
    .toBeVisible();
  await view.getByRole("button", { name: "Set up" }).click();
  expect(setup).toHaveBeenCalledOnce();
});

it("records a custom chord and shows why a taken one was not saved", async () => {
  const { setShortcut } = installBridge();
  setShortcut.mockImplementationOnce(async () => ({
    state: {
      supported: true,
      shortcut: null,
      screenRecordingPermission: "granted",
      inputMonitoringPermission: "denied",
      missingPermissions: [],
      message: null,
      appDisplayName: "Ryco Dev",
    },
    availability: {
      available: false,
      reason: "macOS or another app is already using this shortcut.",
    },
  }));
  const view = await render(<WindowCaptureSettings />);
  await view.getByRole("combobox", { name: "Capture shortcut" }).click();
  await view.getByRole("option", { name: "Custom shortcut" }).click();
  await expect.element(view.getByText("Press shortcut…")).toBeVisible();

  await userEvent.keyboard("{Control>}g{/Control}");
  expect(setShortcut).toHaveBeenLastCalledWith({
    kind: "key-chord",
    modifier: "control",
    key: "KeyG",
  });
  await expect
    .element(view.getByRole("alert"))
    .toHaveTextContent("macOS or another app is already using this shortcut.");

  await view.getByRole("combobox", { name: "Capture shortcut" }).click();
  await view.getByRole("option", { name: "Custom shortcut" }).click();
  await userEvent.keyboard("{Control>}g{/Control}");
  await expect.element(view.getByText("⌃ Control")).toBeVisible();
  await expect.element(view.getByRole("button", { name: "Change" })).toBeVisible();
});

it("refuses a chord Ryco itself uses without saving it", async () => {
  const { setShortcut } = installBridge();
  const view = await render(<WindowCaptureSettings />);
  await view.getByRole("combobox", { name: "Capture shortcut" }).click();
  await view.getByRole("option", { name: "Custom shortcut" }).click();
  await expect.element(view.getByText("Press shortcut…")).toBeVisible();

  await userEvent.keyboard("{Meta>}k{/Meta}");
  await expect
    .element(view.getByRole("alert"))
    .toHaveTextContent("⌘ K already runs “Open command palette” in Ryco. Choose another shortcut.");
  expect(setShortcut).not.toHaveBeenCalled();
});

it("warns when Ryco's keybindings come to use the saved chord", async () => {
  installBridge({ shortcut: { kind: "key-chord", modifier: "command", key: "KeyG" } });
  const view = await render(<WindowCaptureSettings />);
  await expect.element(view.getByText("⌘ Command")).toBeVisible();
  await expect.element(view.getByRole("alert")).not.toBeInTheDocument();

  await replaceAppKeybindings([{ key: "mod+g", command: "thread.find" }]);
  await expect
    .element(view.getByRole("alert"))
    .toHaveTextContent(
      "⌘ G also runs “Find in current thread” in Ryco, and the capture shortcut takes it over. Choose another shortcut.",
    );

  await replaceAppKeybindings([{ key: "mod+f", command: "thread.find" }]);
  await expect.element(view.getByRole("alert")).not.toBeInTheDocument();
});

it("keeps the desktop's message beside the keybinding warning while the shortcut is off", async () => {
  installBridge({
    shortcut: { kind: "key-chord", modifier: "command", key: "KeyG" },
    message: "macOS or another app is already using this shortcut.",
  });
  const view = await render(<WindowCaptureSettings />);
  await expect
    .element(view.getByRole("alert"))
    .toHaveTextContent("macOS or another app is already using this shortcut.");

  await replaceAppKeybindings([{ key: "mod+g", command: "thread.find" }]);
  const alert = view.getByRole("alert");
  await expect
    .element(
      alert.getByText(
        "⌘ G also runs “Find in current thread” in Ryco, which the capture shortcut would take over once it works. Choose another shortcut.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect
    .element(
      alert.getByText("macOS or another app is already using this shortcut.", { exact: true }),
    )
    .toBeVisible();
  await expect.element(alert.getByText("takes it over")).not.toBeInTheDocument();
});

it("renders nothing where the desktop app cannot capture windows", async () => {
  delete window.desktopBridge;
  const view = await render(<WindowCaptureSettings />);
  expect(view.container.textContent).toBe("");
});
