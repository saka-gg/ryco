import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const lifecycle = vi.hoisted(() => ({
  dispatchThreadSnooze: vi.fn(async () => undefined),
  requestCustomSnooze: vi.fn(async (): Promise<string | null> => null),
}));
// Only the notice imports these here; their own tests cover the node round trip.
vi.mock("../../threadLifecycleCommands", () => lifecycle);

import { ComposerBannerStack } from "./ComposerBannerStack";
import { type SnoozeBannerThread, useSnoozeBannerItem } from "./snoozeBanner";

const ENVIRONMENT_ID = EnvironmentId.make("environment-snooze-notice");

function snoozedThread(id: string, untilMs: number): SnoozeBannerThread {
  return {
    environmentId: ENVIRONMENT_ID,
    id: ThreadId.make(id),
    snoozedAt: new Date(Date.now() - 60_000).toISOString(),
    snoozedUntil: new Date(untilMs).toISOString(),
  };
}

function Notice(props: { readonly thread: SnoozeBannerThread | null }) {
  const item = useSnoozeBannerItem({
    thread: props.thread,
    dispatchAllowed: true,
    canSnooze: true,
  });
  return <ComposerBannerStack items={item ? [item] : []} />;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`No ${label} button.`);
  return found;
}

const THREAD_REF = (id: string) => ({ environmentId: ENVIRONMENT_ID, threadId: ThreadId.make(id) });

describe("the composer notice of a snoozed thread", () => {
  beforeEach(() => {
    lifecycle.dispatchThreadSnooze.mockClear();
    lifecycle.requestCustomSnooze.mockClear();
  });

  it("counts down to the wake and wakes the thread with Return now", async () => {
    const screen = await render(
      <Notice thread={snoozedThread("thread-snoozed", Date.now() + 88 * 60_000 + 30_000)} />,
    );
    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("1 hr 28 min left");
        expect(document.body.textContent).toContain("Sending a message ends the snooze.");
      });
      expect(document.body.textContent).toMatch(/Returns .+ · 1 hr 28 min left/u);

      button("Return now").click();
      await vi.waitFor(() =>
        expect(lifecycle.dispatchThreadSnooze).toHaveBeenCalledWith(
          THREAD_REF("thread-snoozed"),
          null,
        ),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("offers the presets and a custom time under Change time", async () => {
    lifecycle.requestCustomSnooze.mockResolvedValueOnce("2026-11-02T08:00:00.000Z");
    const screen = await render(
      <Notice thread={snoozedThread("thread-reschedule", Date.now() + 3_600_000)} />,
    );
    try {
      button("Change time").click();
      await vi.waitFor(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map(
          (item) => item.textContent ?? "",
        );
        expect(items.some((text) => text.startsWith("In 3 hours"))).toBe(true);
        expect(items.at(-1)).toBe("Custom…");
      });
      const custom = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).at(-1);
      custom?.click();
      await vi.waitFor(() =>
        expect(lifecycle.dispatchThreadSnooze).toHaveBeenCalledWith(
          THREAD_REF("thread-reschedule"),
          "2026-11-02T08:00:00.000Z",
        ),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("shows nothing once the snooze ran out, or for an awake thread", async () => {
    const screen = await render(
      <Notice thread={snoozedThread("thread-woke", Date.now() - 1_000)} />,
    );
    try {
      expect(document.body.textContent).not.toContain("Return now");
      await screen.rerender(<Notice thread={null} />);
      expect(document.body.textContent).not.toContain("Return now");
    } finally {
      await screen.unmount();
    }
  });
});
