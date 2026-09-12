import "../../index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { SimulatorTestingDrawer } from "./SimulatorTestingDrawer";
import type { DeviceTestingInput } from "@ryco/contracts";

describe("Simulator testing drawer", () => {
  it("sends presets, validates location, and scopes app commands to the selected device", async () => {
    const testing = vi
      .fn<(input: DeviceTestingInput) => Promise<void>>()
      .mockResolvedValue(undefined);
    const screen = await render(
      <SimulatorTestingDrawer udid="TEST-0001" disabled={false} testing={testing} />,
    );
    await screen.getByText("Simulator testing", { exact: true }).click();
    await screen.getByRole("button", { name: "Dark + large text", exact: true }).click();
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Dark + large text applied.");
    expect(testing).toHaveBeenLastCalledWith({
      udid: "TEST-0001",
      action: { type: "preset", value: "dark-large-text" },
    });
    await expect
      .element(screen.getByRole("button", { name: "Set location", exact: true }))
      .toBeDisabled();
    await screen.getByLabelText("Latitude", { exact: true }).fill("0");
    await screen.getByLabelText("Longitude", { exact: true }).fill("181");
    await expect
      .element(screen.getByRole("button", { name: "Set location", exact: true }))
      .toBeDisabled();
    await screen.getByLabelText("Longitude", { exact: true }).fill("-122.5");
    await screen.getByRole("button", { name: "Set location", exact: true }).click();
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Simulated location applied.");
    expect(testing).toHaveBeenLastCalledWith({
      udid: "TEST-0001",
      action: { type: "location", latitude: 0, longitude: -122.5 },
    });
    await expect
      .element(screen.getByRole("button", { name: "Send push", exact: true }))
      .toBeDisabled();
    await screen.getByLabelText("App bundle ID", { exact: true }).fill("com.example.app");
    await screen.getByRole("button", { name: "Reset to prompt", exact: true }).click();
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Permission reset completed.");
    expect(testing).toHaveBeenLastCalledWith({
      udid: "TEST-0001",
      action: {
        type: "permission",
        bundleId: "com.example.app",
        decision: "reset",
        service: "location",
      },
    });
    await screen.getByRole("button", { name: "Send push", exact: true }).click();
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Push delivered to the simulator.");
    expect(testing).toHaveBeenLastCalledWith({
      udid: "TEST-0001",
      action: {
        type: "push",
        bundleId: "com.example.app",
        payload: '{"aps":{"alert":"Hello from Ryco","sound":"default"}}',
      },
    });
  });

  it("disables commands while disconnected or pending and allows retry after errors", async () => {
    let reject: (error: Error) => void = () => {};
    const testing = vi.fn<(input: DeviceTestingInput) => Promise<void>>(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const screen = await render(
      <SimulatorTestingDrawer udid="TEST-0001" disabled testing={testing} />,
    );
    await screen.getByText("Simulator testing", { exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Dark mode", exact: true }))
      .toBeDisabled();
    await screen.rerender(
      <SimulatorTestingDrawer udid="TEST-0001" disabled={false} testing={testing} />,
    );
    await screen.getByRole("button", { name: "Dark mode", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Large text", exact: true }))
      .toBeDisabled();
    reject(new Error("Runtime does not support this action"));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Runtime does not support this action");
    await expect
      .element(screen.getByRole("button", { name: "Dark mode", exact: true }))
      .toBeEnabled();
    testing.mockResolvedValue(undefined);
    await screen.getByRole("button", { name: "Dark mode", exact: true }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Dark mode applied.");
  });

  it("keeps the expanded drawer scrollable beside a usable simulator at a narrow panel width", async () => {
    const host = document.createElement("div");
    host.style.cssText = "width:320px;height:600px;display:flex;flex-direction:column";
    document.body.append(host);
    const screen = await render(
      <>
        <SimulatorTestingDrawer udid="TEST-0001" disabled={false} testing={async () => {}} />
        <div data-testid="simulator" style={{ flex: 1, minHeight: 0 }} />
      </>,
      { container: host },
    );
    try {
      await screen.getByText("Simulator testing", { exact: true }).click();
      const drawer = host.querySelector("details")!;
      expect(drawer.scrollHeight).toBeGreaterThan(drawer.clientHeight);
      expect(drawer.scrollWidth).toBeLessThanOrEqual(drawer.clientWidth);
      expect(
        host.querySelector('[data-testid="simulator"]')!.getBoundingClientRect().height,
      ).toBeGreaterThan(250);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
