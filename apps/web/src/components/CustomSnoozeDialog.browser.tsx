import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { CustomSnoozeDialog } from "./CustomSnoozeDialog";

function control<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`No ${selector}.`);
  return found;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`No ${label} button.`);
  return found;
}

/** Sets a controlled input's value the way typing does. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CustomSnoozeDialog", () => {
  it("snoozes for a duration counted from the confirmation", async () => {
    const onDone = vi.fn();
    const screen = await render(<CustomSnoozeDialog onDone={onDone} />);
    try {
      await vi.waitFor(() => expect(document.body.textContent).toContain("Custom snooze"));
      button("Duration").click();
      await vi.waitFor(() => control<HTMLInputElement>('input[type="number"]'));
      type(control<HTMLInputElement>('input[type="number"]'), "1.5");
      const before = Date.now();
      button("Snooze").click();
      await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      const wake = Date.parse(onDone.mock.calls[0]![0] as string);
      expect(wake).toBeGreaterThanOrEqual(before + 90 * 60_000);
      expect(wake).toBeLessThanOrEqual(Date.now() + 90 * 60_000);
    } finally {
      await screen.unmount();
    }
  });

  it("asks for a future time instead of snoozing into the past", async () => {
    const onDone = vi.fn();
    const screen = await render(<CustomSnoozeDialog onDone={onDone} />);
    try {
      await vi.waitFor(() => control<HTMLInputElement>('input[type="date"]'));
      type(control<HTMLInputElement>('input[type="date"]'), "2020-01-01");
      button("Snooze").click();
      await vi.waitFor(() =>
        expect(control('[role="alert"]').textContent).toBe(
          "Choose a valid date and time in the future.",
        ),
      );
      expect(onDone).not.toHaveBeenCalled();
      button("Cancel").click();
      expect(onDone).toHaveBeenCalledWith(null);
    } finally {
      await screen.unmount();
    }
  });
});
