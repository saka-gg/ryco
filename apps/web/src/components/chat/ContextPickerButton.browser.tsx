import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { page } from "vite-plus/test/browser";
import type { EnvironmentId } from "@ryco/contracts";

vi.mock("./ContextPickerPopup", () => ({
  ContextPickerPopup: (props: { hasSourceControlRemote: boolean }) => (
    <div data-testid="context-picker-popup" data-remote={String(props.hasSourceControlRemote)} />
  ),
}));

import { appAtomRegistry } from "@ryco/client-runtime/rpc";
import { sourceControlDiscoveryStateAtom } from "@ryco/client-runtime/sourceControlDiscoveryState";
import {
  resetSourceControlDiscoveryStateForTests,
  sourceControlDiscoveryManager,
} from "~/lib/sourceControlDiscoveryState";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { parkPointer } from "../../../test/browserPointer";
import { ContextPickerButton } from "./ContextPickerButton";

beforeEach(async () => {
  // The suite shares one pointer across files, and some park it in the
  // top-left corner, where this button renders. A button that appears under
  // the pointer gets `pointerenter`, which counts as wanting the picker.
  await parkPointer(200, 400);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSourceControlDiscoveryStateForTests();
  document.body.innerHTML = "";
});

describe("ContextPickerButton", () => {
  it("starts source-control discovery only once the picker is wanted", async () => {
    const refresh = vi.spyOn(sourceControlDiscoveryManager, "refresh").mockResolvedValue(null);
    const screen = await render(
      <AppAtomRegistryProvider>
        <ContextPickerButton
          environmentId={"environment-local" as unknown as EnvironmentId}
          cwd="/repo/project"
          onSelectIssue={vi.fn()}
          onSelectChangeRequest={vi.fn()}
          onAttachFile={vi.fn()}
        />
      </AppAtomRegistryProvider>,
    );

    try {
      const button = page.getByRole("button", { name: "Add context" });
      await expect.element(button).toBeVisible();
      // Mounting with the composer reads no auth state.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(refresh).not.toHaveBeenCalled();

      await button.click();
      const popup = page.getByTestId("context-picker-popup");
      await expect.element(popup).toBeInTheDocument();
      await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
      // While discovery has not answered yet, the picker does not claim that
      // there is no remote.
      await expect.element(popup).toHaveAttribute("data-remote", "true");

      appAtomRegistry.set(sourceControlDiscoveryStateAtom("primary"), {
        data: { versionControlSystems: [], sourceControlProviders: [] },
        error: null,
        isPending: false,
      });
      await expect.element(popup).toHaveAttribute("data-remote", "false");
    } finally {
      await screen.unmount();
    }
  });
});
