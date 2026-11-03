import "../../index.css";

import {
  updateEverythingNodeItem,
  updateEverythingProviderItem,
} from "@ryco/client-runtime/updates";
import { ProviderInstanceId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { UpdateEverythingController } from "../../updates/useUpdateEverything";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import {
  EMPTY_PLAN,
  FULL_PLAN,
  LINUX_DEVICE,
  M4_DEVICE,
  M4_ID,
  OFFLINE_DEVICE,
  runDevice,
  runState,
  THIS_MAC_DEVICE,
  THIS_MAC_ID,
  updatePlan,
} from "./updateEverythingTestFixtures";

function controller(
  overrides: Partial<UpdateEverythingController> = {},
): UpdateEverythingController {
  return {
    plan: FULL_PLAN,
    run: null,
    result: null,
    running: false,
    start: vi.fn(),
    checkAll: vi.fn(async () => undefined),
    checking: false,
    dismissRun: vi.fn(),
    ...overrides,
  };
}

const card = (name: string) => page.getByRole("group", { name, exact: true });
const checkbox = (name: string) => page.getByRole("checkbox", { name, exact: true });

describe("the Update everything dialog", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("shows the plan for every device and runs it with one button", async () => {
    const onOpenChange = vi.fn();
    const control = controller();
    mounted = await render(
      <UpdateEverythingDialog open onOpenChange={onOpenChange} controller={control} />,
    );

    const dialog = page.getByRole("dialog", { name: "Update everything" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog)
      .toMatchTextContent(
        "Providers update first, then each node restarts on the new Ryco. This app restarts last.",
      );

    const m4 = card("MacBook Pro M4");
    await expect.element(m4).toMatchTextContent("CLI service · npm");
    await expect.element(m4).toMatchTextContent(/0\.1\.33.*0\.1\.35/);
    await expect.element(m4).toMatchTextContent(/Claude Code.*2\.1\.40.*2\.1\.44/);
    await expect.element(m4).toMatchTextContent(/Codex.*0\.130.*0\.132/);
    await expect.element(m4).toMatchTextContent("1 chat running. It continues after the restart.");
    await expect.element(m4).toMatchTextContent("Copilot needs a manual update.");

    await expect.element(card("This Mac")).toMatchTextContent("This app");
    await expect.element(card("This Mac")).toMatchTextContent(/OpenCode.*1\.18\.2.*1\.18\.9/);
    await expect.element(card("Linux box")).toMatchTextContent("Up to date.");
    await expect.element(card("Studio PC")).toMatchTextContent("Not connected right now.");

    // This app comes first, as the plan orders it.
    const names = [...document.querySelectorAll('[data-slot="update-device-card"]')].map(
      (element) => element.getAttribute("aria-label"),
    );
    expect(names).toEqual(["This Mac", "Linux box", "MacBook Pro M4", "Studio PC"]);

    await page.getByRole("button", { name: "Update all" }).click();
    expect(control.start).toHaveBeenCalledExactlyOnceWith();

    await page.getByRole("button", { name: "Cancel" }).click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("checks every one-click update and leaves the unchecked ones out of the run", async () => {
    const control = controller();
    mounted = await render(
      <UpdateEverythingDialog open onOpenChange={() => undefined} controller={control} />,
    );
    const dialog = page.getByRole("dialog", { name: "Update everything" });
    await expect.element(dialog).toBeVisible();
    expect(page.getByRole("checkbox").elements()).toHaveLength(5);
    for (const name of [
      "Update Ryco on This Mac",
      "Update OpenCode on This Mac",
      "Update Ryco on MacBook Pro M4",
      "Update Claude Code on MacBook Pro M4",
      "Update Codex on MacBook Pro M4",
    ]) {
      await expect.element(checkbox(name)).toBeChecked();
    }

    await checkbox("Update Ryco on This Mac").click();
    await expect.element(checkbox("Update Ryco on This Mac")).not.toBeChecked();
    await expect.element(dialog).not.toMatchTextContent("This app restarts last.");
    await checkbox("Update Ryco on MacBook Pro M4").click();
    // No restart there, so its chat keeps running.
    await expect.element(card("MacBook Pro M4")).not.toMatchTextContent("1 chat running.");
    // The provider's name toggles it too.
    await card("MacBook Pro M4").getByText("Codex", { exact: true }).click();
    await expect.element(checkbox("Update Codex on MacBook Pro M4")).not.toBeChecked();
    await expect.element(page.getByText("2 of 5 updates selected")).toBeVisible();
    expect(page.getByRole("button", { name: "Update all" }).elements()).toHaveLength(0);

    await page.getByRole("button", { name: "Update selected" }).click();
    expect(control.start).toHaveBeenCalledExactlyOnceWith({
      exclude: [
        updateEverythingNodeItem(THIS_MAC_ID),
        updateEverythingNodeItem(M4_ID),
        updateEverythingProviderItem(M4_ID, ProviderInstanceId.make("codex")),
      ],
    });
  });

  it("runs nothing with every update unchecked, and checks them all again when reopened", async () => {
    const control = controller({ plan: updatePlan([M4_DEVICE]) });
    mounted = await render(
      <UpdateEverythingDialog open onOpenChange={() => undefined} controller={control} />,
    );
    for (const name of [
      "Update Ryco on MacBook Pro M4",
      "Update Claude Code on MacBook Pro M4",
      "Update Codex on MacBook Pro M4",
    ]) {
      await checkbox(name).click();
    }
    await expect.element(page.getByText("0 of 3 updates selected")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Update selected" })).toBeDisabled();

    await mounted.rerender(
      <UpdateEverythingDialog open={false} onOpenChange={() => undefined} controller={control} />,
    );
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await mounted.rerender(
      <UpdateEverythingDialog open onOpenChange={() => undefined} controller={control} />,
    );
    await expect.element(checkbox("Update Codex on MacBook Pro M4")).toBeChecked();
    await expect.element(page.getByRole("button", { name: "Update all" })).toBeEnabled();
    expect(page.getByText(/updates selected/).elements()).toHaveLength(0);
  });

  it("copies a manual command", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    mounted = await render(
      <UpdateEverythingDialog open onOpenChange={() => undefined} controller={controller()} />,
    );
    await page.getByRole("button", { name: "Copy command npm i -g @github/copilot" }).click();
    expect(write).toHaveBeenCalledWith("npm i -g @github/copilot");
  });

  it("offers nothing to run when one click has no work", async () => {
    mounted = await render(
      <UpdateEverythingDialog
        open
        onOpenChange={() => undefined}
        controller={controller({ plan: updatePlan([LINUX_DEVICE, OFFLINE_DEVICE]) })}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Update all" })).toBeDisabled();
    await expect
      .element(page.getByRole("dialog"))
      .not.toMatchTextContent("This app restarts last.");
  });

  it("says when no device is connected", async () => {
    mounted = await render(
      <UpdateEverythingDialog
        open
        onOpenChange={() => undefined}
        controller={controller({ plan: EMPTY_PLAN })}
      />,
    );
    await expect.element(page.getByText("No devices connected.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Update all" })).toBeDisabled();
  });

  it("follows each device's live status instead of the button while a run is active", async () => {
    const onOpenChange = vi.fn();
    const run = runState([
      runDevice(THIS_MAC_DEVICE, "queued"),
      runDevice(LINUX_DEVICE, "skipped", "Up to date."),
      runDevice(M4_DEVICE, "updating", "Installing Ryco 0.1.35…"),
      runDevice(OFFLINE_DEVICE, "skipped", "Not connected right now."),
    ]);
    mounted = await render(
      <UpdateEverythingDialog
        open
        onOpenChange={onOpenChange}
        controller={controller({ run, running: true })}
      />,
    );
    await expect.element(card("MacBook Pro M4")).toMatchTextContent("Updating Ryco");
    await expect.element(card("MacBook Pro M4")).toMatchTextContent("Installing Ryco 0.1.35…");
    await expect.element(card("This Mac")).toMatchTextContent("Waiting");
    await expect.element(card("Linux box")).toMatchTextContent("Skipped");
    await expect.element(page.getByText("0 of 2 done")).toBeVisible();
    expect(page.getByRole("button", { name: "Update all" }).elements()).toHaveLength(0);
    expect(page.getByRole("checkbox").elements()).toHaveLength(0);

    const footer = page.elementLocator(document.querySelector('[data-slot="dialog-footer"]')!);
    await footer.getByRole("button", { name: "Close", exact: true }).click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the outcome and forgets the run when done", async () => {
    const onOpenChange = vi.fn();
    const control = controller({
      run: runState(
        [
          runDevice(M4_DEVICE, "failed", "1 provider update failed.", ["Codex: exit code 1"]),
          runDevice(THIS_MAC_DEVICE, "done", "Updated Ryco to 0.1.35."),
        ],
        "finished",
      ),
      result: {
        updatedNodes: 1,
        updatedProviders: 1,
        failures: [`MacBook Pro M4 · Codex: exit code 1`],
        postponed: [],
        unknown: [],
        skipped: [],
      },
    });
    mounted = await render(
      <UpdateEverythingDialog open onOpenChange={onOpenChange} controller={control} />,
    );
    await expect.element(card("MacBook Pro M4")).toMatchTextContent("Failed");
    await expect.element(card("MacBook Pro M4")).toMatchTextContent("Codex: exit code 1");
    await expect.element(card("This Mac")).toMatchTextContent("Done");
    await expect.element(page.getByText("An update failed")).toBeVisible();

    await page.getByRole("button", { name: "Done" }).click();
    expect(control.dismissRun).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps a device that left the plan during the run", async () => {
    mounted = await render(
      <UpdateEverythingDialog
        open
        onOpenChange={() => undefined}
        controller={controller({
          plan: updatePlan([THIS_MAC_DEVICE]),
          run: runState([
            {
              environmentId: M4_ID,
              label: "MacBook Pro M4",
              status: "restarting",
              message: "Restarting on Ryco 0.1.35…",
              providerFailures: [],
            },
            runDevice(THIS_MAC_DEVICE, "queued"),
          ]),
          running: true,
        })}
      />,
    );
    await expect.element(card("MacBook Pro M4")).toMatchTextContent("Restarting on Ryco 0.1.35…");
  });
});
