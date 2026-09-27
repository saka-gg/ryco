import "../../index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { ProviderInstanceId } from "@ryco/contracts";
import { createResetCreditController, type ResetCreditApi } from "@ryco/client-runtime/usage";
import { CodexResetCredits } from "./CodexResetCredits";

const instanceId = ProviderInstanceId.make("fixture-codex");
const account = {
  accountBinding: "fixture-a",
  accountLabel: "fixture@example.test",
  credits: { availableCount: 2 },
};
function fixture() {
  const api: ResetCreditApi = {
    readCodexResetCredits: vi.fn(async () => account),
    consumeCodexResetCredit: vi.fn(async () => ({ outcome: "reset" as const })),
    refreshProviders: vi.fn(async () => ({})),
  };
  const controller = createResetCreditController(instanceId, () => "fixture-key");
  return { api, controller, environmentId: "fixture-node", instanceId, allowed: true };
}
describe("banked resets (no live provider)", () => {
  it("requires explicit confirmation, supports cancellation, and refreshes success", async () => {
    const props = fixture();
    const mounted = await render(<CodexResetCredits {...props} />);
    await expect.element(page.getByText("Banked resets · 2")).toBeVisible();
    await expect.element(page.getByText(/only the count is known/)).toBeVisible();
    await page.getByRole("button", { name: "Use one reset…", exact: true }).click();
    expect(props.api.consumeCodexResetCredit).not.toHaveBeenCalled();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(props.api.consumeCodexResetCredit).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Use one reset…", exact: true }).click();
    await page.getByRole("button", { name: "Confirm redemption", exact: true }).click();
    await expect.element(page.getByText("Reset redeemed. Account limits refreshed.")).toBeVisible();
    expect(props.api.consumeCodexResetCredit).toHaveBeenCalledOnce();
    await mounted.unmount();
  });
  it("retains the attempt through a disconnect and blocks switched accounts", async () => {
    const props = fixture();
    vi.mocked(props.api.consumeCodexResetCredit).mockRejectedValueOnce(new Error("timeout"));
    const mounted = await render(<CodexResetCredits {...props} />);
    await page.getByRole("button", { name: "Use one reset…", exact: true }).click();
    await page.getByRole("button", { name: "Confirm redemption", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Retry same reset attempt" }))
      .toBeEnabled();
    await mounted.rerender(<CodexResetCredits {...props} allowed={false} />);
    await expect
      .element(page.getByRole("button", { name: "Retry same reset attempt" }))
      .toBeDisabled();
    vi.mocked(props.api.readCodexResetCredits).mockResolvedValue({
      ...account,
      accountBinding: "fixture-b",
    });
    await mounted.rerender(<CodexResetCredits {...props} />);
    await expect.element(page.getByRole("button", { name: "Refresh resets" })).toBeEnabled();
    await expect
      .element(page.getByRole("button", { name: "Retry same reset attempt" }))
      .toBeDisabled();
    vi.mocked(props.api.readCodexResetCredits).mockResolvedValue(account);
    await page.getByRole("button", { name: "Refresh resets" }).click();
    await page.getByRole("button", { name: "Retry same reset attempt" }).click();
    await expect.element(page.getByText("Reset redeemed. Account limits refreshed.")).toBeVisible();
    expect(vi.mocked(props.api.consumeCodexResetCredit).mock.calls[0]).toEqual(
      vi.mocked(props.api.consumeCodexResetCredit).mock.calls[1],
    );
    await mounted.unmount();
  });
  it("shows errors and unavailable accounts without enabling redemption", async () => {
    const props = fixture();
    vi.mocked(props.api.readCodexResetCredits).mockRejectedValueOnce(new Error("offline"));
    const mounted = await render(<CodexResetCredits {...props} />);
    await expect.element(page.getByText(/Could not load reset credits/)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Use one reset…", exact: true }))
      .toBeDisabled();
    vi.mocked(props.api.readCodexResetCredits).mockResolvedValue({
      unavailableReason: "Update Codex to verify account identity.",
    });
    await page.getByRole("button", { name: "Refresh resets" }).click();
    await expect.element(page.getByText("Update Codex to verify account identity.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Use one reset…", exact: true }))
      .toBeDisabled();
    expect(props.api.consumeCodexResetCredit).not.toHaveBeenCalled();
    await mounted.unmount();
  });
});
