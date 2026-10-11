import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { AgentChip } from "./AgentChip";

const agentDescriptor = {
  id: "agent",
  label: "Agent",
  type: "select" as const,
  options: [
    { id: "gpt-5-codex", label: "gpt-5-codex", isDefault: true },
    { id: "gpt-5", label: "gpt-5" },
  ],
  currentValue: "gpt-5-codex",
} as const;

describe("AgentChip", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    document.body.innerHTML = "";
  });

  it("renders current agent label and selects another from menu", async () => {
    const onChangeDescriptors = vi.fn();
    mounted = await render(
      <AgentChip
        descriptor={agentDescriptor}
        descriptors={[agentDescriptor]}
        onChangeDescriptors={onChangeDescriptors}
      />,
    );
    const chip = page.getByRole("button", { name: /agent/i });
    await vi.waitFor(async () => {
      await expect.element(chip).toMatchTextContent("gpt-5-codex");
    });
    await chip.click();
    await page.getByText("gpt-5", { exact: true }).click();
    expect(onChangeDescriptors).toHaveBeenCalledOnce();
    const [next] = onChangeDescriptors.mock.calls[0]!;
    expect(next[0]!.currentValue).toBe("gpt-5");
  });
});
