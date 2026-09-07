import "../../index.css";

import type { ThreadGoal } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { ComposerGoalHeader } from "./ComposerGoalHeader";

const goal: ThreadGoal = {
  objective: "Finish the migration",
  status: "active",
  tokenBudget: 1000,
  tokensUsed: 250,
  timeUsedSeconds: 60,
  createdAt: "2026-08-17T10:00:00.000Z",
  updatedAt: "2026-08-17T10:00:00.000Z",
};
const actions = () => ({
  onEdit: vi.fn(),
  onStatusChange: vi.fn(),
  onClear: vi.fn(),
  onRetry: vi.fn(),
  onBudgetChange: vi.fn(async () => true),
});

let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe("goal controls", () => {
  it("disables mutations while waiting for provider confirmation", async () => {
    mounted = await render(
      <ComposerGoalHeader
        goal={{
          ...goal,
          synchronization: { requestId: "pending", state: "pending", action: "clear" },
        }}
        isRunning={false}
        {...actions()}
      />,
    );
    await expect.element(page.getByText("Updating goal…")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Clear goal" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Pause goal" })).toBeDisabled();
  });

  it("shows failed changes with a retry action", async () => {
    const handlers = actions();
    mounted = await render(
      <ComposerGoalHeader
        goal={{
          ...goal,
          synchronization: {
            requestId: "failed",
            state: "failed",
            action: "clear",
            error: "Provider disconnected",
          },
        }}
        isRunning={false}
        {...handlers}
      />,
    );
    await expect.element(page.getByRole("alert")).toHaveTextContent("Provider disconnected");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    expect(handlers.onRetry).toHaveBeenCalledOnce();
  });

  it("validates, edits and removes the token budget without marking the goal resumed", async () => {
    const handlers = actions();
    mounted = await render(
      <ComposerGoalHeader
        goal={{ ...goal, status: "budgetLimited" }}
        isRunning={false}
        {...handlers}
      />,
    );
    await page.getByRole("button", { name: /Finish the migration/ }).click();
    const input = page.getByRole("textbox", { name: "Goal token budget" });
    await input.fill("-1");
    await page.getByRole("button", { name: "Save budget" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(handlers.onBudgetChange).not.toHaveBeenCalled();
    await input.fill("2000");
    await page.getByRole("button", { name: "Save budget" }).click();
    expect(handlers.onBudgetChange).toHaveBeenLastCalledWith(2000);
    await input.fill("");
    await page.getByRole("button", { name: "Save budget" }).click();
    expect(handlers.onBudgetChange).toHaveBeenLastCalledWith(null);
    expect(handlers.onStatusChange).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Resume goal" }).click();
    expect(handlers.onStatusChange).toHaveBeenCalledWith("active");
  });

  it.each(["active", "paused"] as const)(
    "labels %s prompt-only support and does not count idle wall time",
    async (status) => {
      mounted = await render(
        <ComposerGoalHeader
          goal={{
            ...goal,
            status,
            synchronization: { requestId: "fallback", state: "unsupported", action: "set" },
          }}
          isRunning={false}
          {...actions()}
        />,
      );
      await expect
        .element(
          page.getByRole("button", { name: status === "active" ? /Goal reminder/ : /Goal paused/ }),
        )
        .toBeVisible();
      await expect
        .element(page.getByText(/Automatic continuation and goal usage tracking are unavailable/))
        .toBeVisible();
      await expect.element(page.getByText("1:00", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: /Finish the migration/ }).click();
      await expect
        .element(page.getByRole("textbox", { name: "Goal token budget" }))
        .not.toBeInTheDocument();
    },
  );
});
