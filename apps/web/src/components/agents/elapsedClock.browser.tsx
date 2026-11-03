import "../../index.css";

import type { BackgroundTask } from "@ryco/shared/backgroundWork";
import { page } from "vite-plus/test/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { act } from "react";
import { render } from "vitest-browser-react";

import { BackgroundLivenessChip } from "../chat/BackgroundLivenessChip";
import { useInboxClock } from "../inboxSidebar/useInboxListMotion";
import { AgentElapsed } from "./agentRoster";
import { makeRuntimeAgent } from "./agentRosterTestFixtures";

// Every elapsed label on screen (the agent rows, the background work list, the inbox's running
// rows) ticks on the one shared second clock: a single timer, stopped while the page is hidden.

const task: BackgroundTask = {
  id: "watch",
  title: "Watch CI",
  runtimeSessionId: "epoch",
  status: "running",
  startedAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
  attempt: 0,
  canStop: true,
  elapsedMs: 0,
  activeSince: "2026-08-10T10:00:00.000Z",
};

let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  Reflect.deleteProperty(document, "visibilityState");
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** An inbox row's clock, as seconds since the start of the test. */
function InboxSeconds() {
  const now = useInboxClock();
  return (
    <span data-testid="inbox-seconds">{(now - Date.parse("2026-08-10T10:00:00.000Z")) / 1000}</span>
  );
}

function labels(): string[] {
  return [
    ...[...document.querySelectorAll("[data-testid='agent-elapsed'] span")].map(
      (node) => node.textContent,
    ),
    document.querySelector("[data-background-elapsed]")?.textContent ?? null,
    document.querySelector("[data-testid='inbox-seconds']")?.textContent ?? null,
  ].map(String);
}

it("ticks agent, background work and inbox labels on one timer that stops while the page is hidden", async () => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "Date"],
    now: new Date("2026-08-10T10:00:05.000Z"),
  });
  const setIntervalSpy = vi.spyOn(window, "setInterval");
  const clearIntervalSpy = vi.spyOn(window, "clearInterval");
  const secondTimers = () => setIntervalSpy.mock.calls.filter(([, delay]) => delay === 1000);

  mounted = await render(
    <div>
      <div data-testid="agent-elapsed">
        <AgentElapsed agent={makeRuntimeAgent("first")} />
        <AgentElapsed agent={makeRuntimeAgent("second")} />
      </div>
      <InboxSeconds />
      <BackgroundLivenessChip
        liveness="monitoring"
        liveCount={1}
        work={{ tasks: [task], detailsOmitted: false }}
        onStopTask={async () => {}}
        connected
        mutationReady
        stopping={false}
        onStop={() => {}}
        onOpenAgents={() => {}}
      />
    </div>,
  );
  await page.getByRole("button", { name: "1 background task" }).click();
  expect(labels()).toEqual(["5s", "5s", "5s", "5"]);
  expect(secondTimers()).toHaveLength(1);

  await act(() => vi.advanceTimersByTime(2000));
  expect(labels()).toEqual(["7s", "7s", "7s", "7"]);

  act(() => setVisibility("hidden"));
  const timerId = setIntervalSpy.mock.results.at(-1)?.value;
  expect(clearIntervalSpy).toHaveBeenCalledWith(timerId);
  await act(() => vi.advanceTimersByTime(5000));
  expect(labels()).toEqual(["7s", "7s", "7s", "7"]);

  // Shown again, every label catches up at once and one timer runs again.
  act(() => setVisibility("visible"));
  expect(labels()).toEqual(["12s", "12s", "12s", "12"]);
  expect(secondTimers()).toHaveLength(2);
});
