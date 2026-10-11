import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { GenericSelectChip } from "./GenericSelectChip";

const variantDescriptor = {
  id: "variant",
  label: "Variant",
  type: "select" as const,
  options: [
    { id: "small", label: "Small" },
    { id: "large", label: "Large", isDefault: true },
  ],
  currentValue: "large",
} as const;

describe("GenericSelectChip", () => {
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

  it("renders the descriptor label in aria-label and the current option's label as text", async () => {
    const onChangeDescriptors = vi.fn();
    mounted = await render(
      <GenericSelectChip
        descriptor={variantDescriptor}
        descriptors={[variantDescriptor]}
        onChangeDescriptors={onChangeDescriptors}
      />,
    );
    const chip = page.getByRole("button", { name: /variant/i });
    await vi.waitFor(async () => {
      await expect.element(chip).toMatchTextContent("Large");
    });
    await chip.click();
    await page.getByText("Small").click();
    expect(onChangeDescriptors).toHaveBeenCalledOnce();
    const [next] = onChangeDescriptors.mock.calls[0]!;
    expect(next[0]!.currentValue).toBe("small");
  });
});
