import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AutoSettleSettingsSection } from "./AiFocusSettings";

describe("AutoSettleSettingsSection", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("starts Off, explains the safeguards, and offers every supported preset", async () => {
    const onChange = vi.fn();
    mounted = await render(
      <AutoSettleSettingsSection node={null} deviceValue={null} onChange={onChange} />,
    );

    await expect
      .element(page.getByText("Auto-settle inactive tasks", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(/Running work, queued messages, pending input, open pull requests/))
      .toBeInTheDocument();

    await page.getByLabelText("Auto-settle inactive tasks").click();
    for (const label of [
      "Off",
      "After 1 day",
      "After 3 days",
      "After 7 days",
      "After 14 days",
      "After 30 days",
      "After 90 days",
    ]) {
      await expect.element(page.getByText(label, { exact: true }).last()).toBeInTheDocument();
    }

    await page.getByText("After 14 days", { exact: true }).last().click();
    expect(onChange).toHaveBeenCalledWith(14);
  });

  it("shows the node's own rule, names the node, and offers to apply it everywhere", async () => {
    const onChange = vi.fn();
    const onApplyToAll = vi.fn();
    mounted = await render(
      <AutoSettleSettingsSection
        node={{ label: "Studio", ownsRule: true, value: 30, editable: true }}
        deviceValue={3}
        onChange={onChange}
        onApplyToAll={onApplyToAll}
        status={<span role="status">Applied to Studio. Not changed: Laptop (not connected).</span>}
      />,
    );

    await expect.element(page.getByText("After 30 days", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText(/Set on Studio, so every device lists its tasks the same way\./))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Applied to Studio. Not changed: Laptop (not connected).");

    await page.getByRole("button", { name: "Apply to all connected nodes" }).click();
    expect(onApplyToAll).toHaveBeenCalledOnce();

    await page.getByLabelText("Auto-settle inactive tasks").click();
    await page.getByText("Off", { exact: true }).last().click();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps a node's rule read-only for a client that may not change it", async () => {
    mounted = await render(
      <AutoSettleSettingsSection
        node={{ label: "Studio", ownsRule: true, value: 7, editable: false }}
        deviceValue={3}
        onChange={vi.fn()}
      />,
    );

    await expect.element(page.getByLabelText("Auto-settle inactive tasks")).toBeDisabled();
    await expect.element(page.getByText(/Only its owner can change it/)).toBeInTheDocument();
  });

  it("falls back to this device's rule, with a note, for a node that keeps none", async () => {
    const onChange = vi.fn();
    mounted = await render(
      <AutoSettleSettingsSection
        node={{ label: "Old box", ownsRule: false, value: 7, editable: true }}
        deviceValue={3}
        onChange={onChange}
      />,
    );

    await expect.element(page.getByText("After 3 days", { exact: true })).toBeInTheDocument();
    await expect
      .element(
        page.getByText(/Old box does not keep this rule yet, so it applies on this device only\./),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Apply to all connected nodes" }))
      .not.toBeInTheDocument();
  });
});
