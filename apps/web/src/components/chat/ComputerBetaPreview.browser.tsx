import "../../index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { ComputerBetaState, ComputerBetaUpdate, DesktopBridge } from "@ryco/contracts";
import { ComputerBetaPreview } from "./ComputerBetaPreview";
import { ComputerBetaSettings } from "../settings/ComputerBetaSettings";
const previous = window.desktopBridge;
afterEach(() => {
  if (previous) window.desktopBridge = previous;
  else delete window.desktopBridge;
});
function fixture(autoPreview = true, turnId = "turn") {
  let state: ComputerBetaState = {
    supported: true,
    preferences: { defaultEnabled: false, autoPreview, previewSize: "compact", cursorColor: null },
    permissions: {
      platform: "macos",
      supported: true,
      enabled: false,
      status: "ready",
      shortcut: null,
      accessibilityPermission: "granted",
      inputMonitoringPermission: "granted",
      screenRecordingPermission: "granted",
      message: null,
      appDisplayName: "Ryco",
    },
    inputMonitorReady: true,
    error: null,
  };
  const listeners = new Set<(event: ComputerBetaUpdate) => void>();
  const setPreview = vi.fn(async () => {});
  const stopTask = vi.fn(async () => {});
  const setup = vi.fn(async () => state);
  const prepare = vi.fn(async () => null);
  const getHistory = vi.fn(async () => ({
    entries: [],
    nextCursor: null,
    truncated: false,
    status: "available" as const,
  }));
  const setPreferences = vi.fn(async (preferences: ComputerBetaState["preferences"]) => {
    state = { ...state, preferences };
    return state;
  });
  window.desktopBridge = {
    computerBeta: {
      getState: async () => state,
      checkPermissions: async () => state,
      setPreferences,
      setup,
      prepare,
      setPreview,
      stopTask,
      getHistory,
      onUpdate: (listener: (event: ComputerBetaUpdate) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  } as unknown as DesktopBridge;
  const send = (event: ComputerBetaUpdate) => {
    for (const listener of listeners) listener(event);
  };
  const target = (targetId = "cua:100:200") => {
    const target = { threadId: "thread", turnId, targetId, label: "Calculator" };
    state = { ...state, targets: [target] };
    send({ type: "target", ...target });
  };
  const frame = (targetId = "cua:100:200") =>
    send({
      type: "frame",
      threadId: "thread",
      turnId,
      targetId,
      sequence: 1,
      mimeType: "image/png",
      bytes: Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        ),
        (c) => c.charCodeAt(0),
      ),
    });
  return { target, frame, send, setPreview, stopTask, setup, prepare, setPreferences, getHistory };
}
it("keeps preview close separate from Stop, clears replacement pixels and rejects retired frames", async () => {
  const f = fixture();
  const view = await render(
    <div className="relative h-[700px] w-[1000px]">
      <ComputerBetaPreview threadId="thread" />
    </div>,
  );
  f.target();
  f.frame();
  await expect.element(view.getByRole("img")).toBeVisible();
  await vi.waitFor(() => expect(f.setPreview).toHaveBeenLastCalledWith("thread", true));
  await view.getByRole("button", { name: "Hide preview" }).click();
  await expect.element(view.getByRole("button", { name: "Show Computer" })).toBeVisible();
  await vi.waitFor(() => expect(f.setPreview).toHaveBeenLastCalledWith("thread", false));
  expect(f.stopTask).not.toHaveBeenCalled();
  await view.getByRole("button", { name: "Show Computer" }).click();
  f.target("cua:100:201");
  await expect.element(view.getByRole("img")).not.toBeInTheDocument();
  f.frame("cua:100:201");
  await expect.element(view.getByRole("img")).toBeVisible();
  await view.getByRole("button", { name: "Stop", exact: true }).click();
  expect(f.stopTask).toHaveBeenCalledWith("thread");
  f.send({ type: "ended", threadId: "thread", turnId: "turn" });
  f.frame("cua:100:201");
  await expect
    .element(view.getByRole("region", { name: "Computer preview" }))
    .not.toBeInTheDocument();
});
it("does not show another thread's pixels and respects automatic-preview preference", async () => {
  const f = fixture(false);
  const view = await render(<ComputerBetaPreview threadId="thread" />);
  await vi.waitFor(() => expect(f.setPreview).toHaveBeenCalled());
  f.send({
    type: "target",
    threadId: "other",
    turnId: "other-turn",
    targetId: "private",
    label: "Other",
  });
  await expect
    .element(view.getByRole("region", { name: "Computer preview" }))
    .not.toBeInTheDocument();
  f.target();
  await expect.element(view.getByRole("button", { name: "Show Computer" })).toBeVisible();
  expect(f.stopTask).not.toHaveBeenCalled();
});
it("loads history only on request and setup never sends a task", async () => {
  const f = fixture();
  const view = await render(<ComputerBetaSettings />);
  await expect
    .element(view.getByRole("switch", { name: "Enable Computer by default" }))
    .not.toBeChecked();
  expect(f.getHistory).not.toHaveBeenCalled();
  await view.getByRole("button", { name: "Set up Computer" }).click();
  expect(f.setup).toHaveBeenCalledOnce();
  expect(f.prepare).not.toHaveBeenCalled();
  await view.getByRole("button", { name: "Load recent actions" }).click();
  expect(f.getHistory).toHaveBeenCalledOnce();
});
it("restores hidden and expanded presentation when returning to an active task", async () => {
  const f = fixture(true, "remount-turn");
  const first = await render(<ComputerBetaPreview threadId="thread" />);
  f.target();
  await first.getByRole("button", { name: "Expand preview" }).click();
  await first.getByRole("button", { name: "Hide preview" }).click();
  await first.unmount();
  const second = await render(<ComputerBetaPreview threadId="thread" />);
  await expect.element(second.getByRole("button", { name: "Show Computer" })).toBeVisible();
  await vi.waitFor(() => expect(f.setPreview).toHaveBeenLastCalledWith("thread", false));
  await second.getByRole("button", { name: "Show Computer" }).click();
  await expect.element(second.getByRole("button", { name: "Compact preview" })).toBeVisible();
  expect(f.stopTask).not.toHaveBeenCalled();
  f.send({ type: "ended", threadId: "thread", turnId: "remount-turn" });
});
