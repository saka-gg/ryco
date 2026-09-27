import "../../index.css";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { ProviderInstanceId, RuntimeSessionId } from "@ryco/contracts";
import {
  ClaudeCacheDetails,
  ClaudeCacheEvidence,
  claudeCacheReviewPresentation,
} from "./ClaudeCacheReview";

const observation = {
  source: "assistant-usage" as const,
  observedAt: "2026-09-27T10:00:00.000Z",
  runtimeSessionId: RuntimeSessionId.make("runtime-fixture"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  model: "sonnet",
  messageId: "fixture-request",
  directInputTokens: 100,
  cacheReadInputTokens: 50_000,
  cacheWriteInputTokens: 2_000,
};
describe("Claude cache review", () => {
  it("labels evidence and unknown lifetime without promising future hits", async () => {
    const screen = await render(<ClaudeCacheEvidence observation={observation} />);
    await expect.element(screen.getByText("Cache reads", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByText("No cache lifetime was reported for this observation."))
      .toBeVisible();
    await expect.element(screen.getByText(/Subagent usage is separate/)).toBeVisible();
    await screen.unmount();
  });
  it("labels missing evidence as unknown", async () => {
    const screen = await render(<ClaudeCacheDetails activities={[]} />);
    await screen.getByText("Observed Claude cache usage", { exact: true }).click();
    await expect
      .element(screen.getByText(/No authoritative cache usage is available/))
      .toBeVisible();
    await screen.unmount();
  });
  it.each([
    ["Continue with full context", "continue"],
    ["Compact then send", "compact"],
    ["Cancel", "cancel"],
  ] as const)("resolves %s without triggering provider calls", async (label, choice) => {
    const decision = claudeCacheReviewPresentation.review({
      observation,
      promptTokens: 52_100,
      reason: "Large idle conversation.",
    });
    await page.getByRole("button", { name: label, exact: true }).click();
    expect(await decision).toBe(choice);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
  it("offers cancellation while compaction holds the original send", async () => {
    const cancel = vi.fn();
    const dispose = claudeCacheReviewPresentation.compacting!(cancel);
    await expect.element(page.getByText("Compacting Claude context…")).toBeVisible();
    await page.getByRole("button", { name: "Cancel pending send" }).click();
    expect(cancel).toHaveBeenCalledOnce();
    dispose();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
});
