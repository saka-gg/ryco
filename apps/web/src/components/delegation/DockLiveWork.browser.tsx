import "../../index.css";
import { page } from "vite-plus/test/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { BackgroundTask, BackgroundWork } from "@ryco/shared/backgroundWork";

import { deriveAgentPanelModel } from "../../threadWorkspaceViewModel";
import { makeRuntimeAgent } from "../agents/agentRosterTestFixtures";
import { LiveWorkDock, makeThreadLiveWork } from "./threadLiveWorkTestFixtures";

// The dock's live work: the thread's working agents and its background tasks.
const twoAgents = deriveAgentPanelModel({
  agents: [
    makeRuntimeAgent("a", { title: "visual:reading-pos", progress: "Using Read" }),
    makeRuntimeAgent("b", { title: "impl:paste-recall", status: "completed" }),
  ],
});

const task = (id: string, overrides: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id,
  title: id,
  runtimeSessionId: "epoch",
  status: "running",
  startedAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:10Z",
  attempt: 0,
  canStop: true,
  elapsedMs: 0,
  activeSince: null,
  ...overrides,
});
let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
});
function view(
  work: BackgroundWork,
  onStopTask = vi.fn(async () => {}),
  options: { connected?: boolean; mutationReady?: boolean; onOpenAgents?: () => void } = {},
) {
  return (
    <div style={{ width: "100%", maxWidth: 620, padding: 20 }}>
      <LiveWorkDock
        liveWork={makeThreadLiveWork({
          agentPanelModel: twoAgents,
          work,
          onStopTask,
          connected: options.connected ?? true,
          mutationReady: options.mutationReady ?? true,
          ...(options.onOpenAgents ? { onOpenAgents: options.onOpenAgents } : {}),
        })}
      />
    </div>
  );
}
it("is one line until opened, then discloses agents and commands, keeps Agents navigation, and waits for lifecycle settlement after stop acceptance", async () => {
  const onStop = vi.fn(async () => {});
  const work = {
    tasks: [task("Run tests"), task("Watch CI", { canStop: false })],
    detailsOmitted: false,
  };
  const onOpenAgents = vi.fn();
  mounted = await render(view(work, onStop, { onOpenAgents }));
  // One line until opened: who works, of how many, and how many tasks run.
  const header = page.getByRole("button", { name: /2 background tasks/ });
  await expect.element(header).toMatchTextContent(/1 agent working of 2\s*2 background tasks/);
  expect(document.querySelectorAll("[data-agent-row]")).toHaveLength(0);
  await header.click();
  expect(document.querySelectorAll("[data-agent-row]")).toHaveLength(1);
  await page.getByRole("button", { name: "Open Agents" }).click();
  expect(onOpenAgents).toHaveBeenCalledOnce();
  await expect.element(page.getByRole("button", { name: "Stop Watch CI" })).toBeDisabled();
  await page.getByRole("button", { name: "Stop Run tests" }).click();
  expect(onStop).toHaveBeenCalledExactlyOnceWith(work.tasks[0]);
  await expect
    .element(page.getByRole("button", { name: "Stop Run tests" }))
    .toMatchTextContent("Stopping…");
  await expect.element(page.getByRole("button", { name: "Stop Run tests" })).toBeDisabled();
  await page.getByRole("button", { name: /2 background tasks/ }).click();
  await page.getByRole("button", { name: /2 background tasks/ }).click();
  await expect
    .element(page.getByRole("button", { name: "Stop Run tests" }))
    .toMatchTextContent("Stopping…");
  await mounted.rerender(view({ ...work, tasks: work.tasks.slice(1) }, onStop));
  await expect
    .element(page.getByRole("button", { name: "Stop Run tests" }))
    .not.toBeInTheDocument();
});
it("shows stop errors and allows retry without reporting completion", async () => {
  const onStop = vi.fn(async () => {
    throw new Error("Provider stop timed out");
  });
  mounted = await render(view({ tasks: [task("Run tests")], detailsOmitted: false }, onStop));
  await page.getByRole("button", { name: /1 background task/ }).click();
  await page.getByRole("button", { name: "Stop Run tests" }).click();
  await expect.element(page.getByRole("alert")).toMatchTextContent("Provider stop timed out");
  await expect.element(page.getByRole("button", { name: "Stop Run tests" })).toBeEnabled();
});
it("keeps uncertain tasks on reconnect and gates stop with shared mutation readiness", async () => {
  const work = {
    tasks: [task("Watch CI", { status: "idle", elapsedMs: 10_000 })],
    detailsOmitted: false,
  };
  mounted = await render(view(work, undefined, { connected: false }));
  await page.getByRole("button", { name: /1 background task/ }).click();
  await expect
    .element(page.getByText("Connection lost · task status is unconfirmed"))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Stop Watch CI" })).toBeDisabled();
  await mounted.rerender(view(work, undefined, { mutationReady: false }));
  await expect.element(page.getByText("Paused / idle", { exact: false })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Stop Watch CI" })).toBeDisabled();
  await mounted.rerender(view(work));
  await expect.element(page.getByRole("button", { name: "Stop Watch CI" })).toBeEnabled();
});
it("bounds the list visually and labels omitted details without inventing a live count", async () => {
  const work = {
    tasks: Array.from({ length: 100 }, (_, i) =>
      task(`Check ${i}`, { title: `Check ${i} — ` + "long command ".repeat(12) }),
    ),
    detailsOmitted: true,
  };
  mounted = await render(view(work));
  await page.getByRole("button", { name: /100 background tasks · details limited/ }).click();
  await expect.element(page.getByText(/Additional details are unavailable/)).toBeVisible();
  const list = document.querySelector("ul")!;
  expect(list.clientHeight).toBeLessThanOrEqual(256);
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  expect(document.querySelectorAll("[data-background-task]")).toHaveLength(100);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

it("allows retry when acceptance never settles and ignores a late failed request", async () => {
  let rejectFirst: ((error: Error) => void) | undefined;
  const onStop = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectFirst ??= reject;
      }),
  );
  const work = { tasks: [task("Run tests")], detailsOmitted: false };
  mounted = await render(view(work, onStop));
  await page.getByRole("button", { name: /1 background task/ }).click();
  vi.useFakeTimers();
  const button = document.querySelector<HTMLButtonElement>('[aria-label="Stop Run tests"]')!;
  button.click();
  await vi.advanceTimersByTimeAsync(20_001);
  vi.useRealTimers();
  await expect.element(page.getByRole("button", { name: "Stop Run tests" })).toBeEnabled();
  await expect.element(page.getByRole("alert")).toMatchTextContent("Stop has not been confirmed");
  await page.getByRole("button", { name: "Stop Run tests" }).click();
  rejectFirst?.(new Error("Late failure"));
  await expect.element(page.getByRole("button", { name: "Stop Run tests" })).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Stop Run tests" }))
    .toMatchTextContent("Stopping…");
});

it("sends displayed activation identity and synchronously rejects a same-tick duplicate stop", async () => {
  const onStop = vi.fn(async () => {});
  const displayed = task("Reused task", { runtimeSessionId: "displayed-runtime", attempt: 4 });
  mounted = await render(view({ tasks: [displayed], detailsOmitted: false }, onStop));
  await page.getByRole("button", { name: /1 background task/ }).click();
  const button = document.querySelector<HTMLButtonElement>('[aria-label="Stop Reused task"]')!;
  button.click();
  button.click();
  expect(onStop).toHaveBeenCalledExactlyOnceWith(displayed);
});

it("renders nothing without live work and names background work it has no details for", async () => {
  mounted = await render(<LiveWorkDock liveWork={makeThreadLiveWork({ liveness: null })} />);
  expect(document.querySelector('[data-testid="delegation-dock"]')).toBeNull();

  const onStopAll = vi.fn();
  await mounted.rerender(
    <LiveWorkDock liveWork={makeThreadLiveWork({ liveness: "working", onStopAll })} />,
  );
  await page.getByRole("button", { name: "Background work running" }).click();
  // No agents ran, so there is no Agents panel to open.
  expect(page.getByRole("button", { name: "Open Agents" }).elements()).toHaveLength(0);
  await page.getByRole("button", { name: "Stop all" }).click();
  expect(onStopAll).toHaveBeenCalledOnce();

  // A working turn's own agents show, but stop with the composer's Stop.
  await mounted.rerender(
    <LiveWorkDock liveWork={makeThreadLiveWork({ liveness: null, agentPanelModel: twoAgents })} />,
  );
  await expect
    .element(page.getByRole("button", { name: /1 agent working of 2/ }))
    .toHaveAttribute("aria-expanded", "true");
  expect(page.getByRole("button", { name: "Stop all" }).elements()).toHaveLength(0);
});
