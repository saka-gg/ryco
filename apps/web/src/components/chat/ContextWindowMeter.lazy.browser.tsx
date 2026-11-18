import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { deriveContextWindowUsage } from "../../lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

// The popup body arrives only once the test lets it: a slow first load.
const chunk = vi.hoisted(() => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
});

vi.mock("./ContextWindowDetails", async (importOriginal) => {
  await chunk.gate;
  return importOriginal();
});

describe("ContextWindowMeter usage popup on a slow first load", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays closed when the pointer left before the popup body loaded", async () => {
    const mounted = await render(
      <ContextWindowMeter usage={deriveContextWindowUsage([], "200k")} available />,
    );
    const trigger = page.getByRole("button", { name: /Context window/ });

    // Rest past the hover delay so the trigger asks to open, then leave. The popup is not
    // mounted yet; Base UI still reports the leave, so the popup must not open on its own
    // once the body lands (without the leave it does, which this assertion catches).
    await userEvent.hover(trigger);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await userEvent.unhover(trigger);

    chunk.release();
    // Give the chunk time to land and a would-be popup time to mount.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(document.querySelector('[data-slot="popover-viewport"]')).toBeNull();

    // Hovering again opens it as usual.
    await userEvent.hover(trigger);
    await expect.element(page.getByText("Context window", { exact: true })).toBeVisible();
    await mounted.unmount();
  });
});
