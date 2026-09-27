import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(async () => ({ response: 1 })),
  stopTask: vi.fn(async () => {}),
  send: vi.fn(),
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
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/usr/bin/ryco", getName: () => "Ryco" },
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: { openExternal: vi.fn() },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn(), getSystemIdleState: () => "active" },
}));
vi.mock("../appSnapManager.ts", () => ({
  DesktopAppSnapManager: class {
    getState() {
      return mocks.permissions;
    }
    async refreshState() {
      return mocks.permissions;
    }
    async startPermissionSetup() {}
    async releaseHeldInput() {
      return true;
    }
    dispose() {}
  },
}));
vi.mock("../escapeKillSwitchMonitor.ts", () => ({
  EscapeKillSwitchMonitor: class {
    state = { ready: true };
    async activate() {}
    setArmed() {}
    dispose() {}
  },
}));
vi.mock("../computerFrameTap.ts", () => ({
  ComputerFrameTap: class {
    update() {}
    async stop() {}
    async endTask() {}
    async dispose() {}
  },
}));
vi.mock("../cuaDriverHost.ts", () => ({
  CuaDriverHost: class {
    async listen() {
      return "/tmp/test-cua.sock";
    }
    async stop() {}
    async dispose() {}
    stopTaskByUser = mocks.stopTask;
    async pauseDesktop() {}
    resumeDesktop() {}
  },
}));
import { DesktopComputerBeta } from "./beta.ts";
let directory: string | undefined;
let beta: DesktopComputerBeta | undefined;
afterEach(async () => {
  await beta?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
  beta = undefined;
  vi.clearAllMocks();
});
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), "ryco-beta-test-"));
  await mkdir(join(directory, "cua-driver"));
  await writeFile(join(directory, "cua-driver", "cua-driver"), "fixture");
  beta = new DesktopComputerBeta({
    stateDir: directory,
    resourcesDir: directory,
    getWindow: () =>
      ({ isDestroyed: () => false, webContents: { send: mocks.send } }) as unknown as BrowserWindow,
  });
  await beta.start();
  return beta;
}
it.skipIf(process.platform !== "darwin")(
  "fences one-shot queued requests by thread, Stop and desktop generation",
  async () => {
    const runtime = await fixture();
    expect(await runtime.prepare("thread", false)).toBeNull();
    const intent = await runtime.prepare("thread", true);
    await expect(
      runtime.request({ operation: "begin", threadId: "other", turnId: "turn", intent }),
    ).rejects.toThrow("expired");
    await runtime.request({ operation: "begin", threadId: "thread", turnId: "turn", intent });
    await runtime.stopTask("thread");
    await expect(
      runtime.request({ operation: "begin", threadId: "thread", turnId: "queued-turn", intent }),
    ).rejects.toThrow("expired");
    const fresh = await runtime.prepare("thread", true);
    runtime.binding();
    await expect(
      runtime.request({
        operation: "begin",
        threadId: "thread",
        turnId: "new-turn",
        intent: fresh,
      }),
    ).rejects.toThrow("expired");
  },
);
it.skipIf(process.platform !== "darwin")(
  "shares routine consent and separately asks for every clipboard request",
  async () => {
    const runtime = await fixture();
    const identity = { threadId: "thread", turnId: "turn" };
    await runtime.request({
      operation: "begin",
      ...identity,
      intent: await runtime.prepare("thread", true),
    });
    await Promise.all([
      runtime.request({ operation: "consent", ...identity }),
      runtime.request({ operation: "consent", ...identity }),
    ]);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    await runtime.request({ operation: "consent", ...identity, clipboard: true });
    await runtime.request({ operation: "consent", ...identity, clipboard: true });
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(3);
    await runtime.stopTask("thread");
    await expect(runtime.request({ operation: "consent", ...identity })).rejects.toThrow(
      "no longer active",
    );
  },
);
it.skipIf(process.platform !== "darwin")(
  "drops frames for ended tasks and leaves hidden previews unsubscribed",
  async () => {
    const runtime = await fixture();
    const identity = { threadId: "thread", turnId: "turn" };
    await runtime.request({
      operation: "begin",
      ...identity,
      intent: await runtime.prepare("thread", true),
    });
    mocks.send.mockClear();
    await runtime.request({
      operation: "frame",
      ...identity,
      targetId: "cua:1:2",
      data: "AA==",
      startedAt: Date.now(),
    });
    expect(mocks.send).not.toHaveBeenCalled();
    await runtime.stopTask("thread");
    mocks.send.mockClear();
    await expect(
      runtime.request({
        operation: "frame",
        ...identity,
        targetId: "cua:1:2",
        data: "AA==",
        startedAt: Date.now(),
      }),
    ).rejects.toThrow("no longer active");
    expect(mocks.send).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== "darwin")(
  "rejects a delayed admission when retirement reached the desktop first",
  async () => {
    const runtime = await fixture();
    const identity = { threadId: "thread", turnId: "late-turn" };
    const intent = await runtime.prepare("thread", true);
    await runtime.request({ operation: "end", ...identity });
    await expect(runtime.request({ operation: "begin", ...identity, intent })).rejects.toThrow(
      "expired",
    );
  },
);

it.skipIf(process.platform !== "darwin")(
  "reads bounded persisted history without returning typed values",
  async () => {
    const runtime = await fixture();
    await writeFile(
      join(directory!, "computer-audit.jsonl"),
      JSON.stringify({
        ts: "2026-09-26T00:00:00.000Z",
        tool: "computer_type_text",
        effect: "verified",
        args: { text: "private content" },
      }) + "\n",
    );
    const history = await runtime.readHistory({ limit: 1 });
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.tool).toBe("computer_type_text");
    expect(JSON.stringify(history)).not.toContain("private content");
  },
);
