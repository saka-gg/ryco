import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(async () => ({ response: 1 })),
  stopTask: vi.fn(async () => {}),
  send: vi.fn(),
  startPermissionSetup: vi.fn(async (_kinds: readonly string[]) => {}),
  monitorActivate: vi.fn(async () => {}),
  monitorArmed: vi.fn((_armed: boolean) => {}),
  monitorStart: vi.fn(() => {}),
  refreshState: vi.fn(async () => {}),
  monitorState: { ready: true } as { ready: boolean; error?: string },
  hostOptions: undefined as
    | undefined
    | {
        inputMonitorState(): { ready: boolean };
        activateInputMonitor(): Promise<void>;
        onInputMonitorArmedChange(armed: boolean): void;
        checkPermissions(): Promise<Record<string, boolean>>;
        frameTap: {
          update(
            target: { task: { threadId: string; turnId?: string }; pid: number; windowId: number },
            delivery?: { foreground: boolean },
          ): void;
        };
      },
  version: "1.0.0",
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
  app: { getPath: () => "/usr/bin/ryco", getName: () => "Ryco", getVersion: () => mocks.version },
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: { openExternal: vi.fn() },
  systemPreferences: {
    isTrustedAccessibilityClient: () => false,
    getMediaAccessStatus: () => "denied",
  },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn(), getSystemIdleState: () => "active" },
}));
vi.mock("../appSnapManager.ts", () => ({
  DesktopAppSnapManager: class {
    getState() {
      return mocks.permissions;
    }
    async refreshState() {
      await mocks.refreshState();
      return mocks.permissions;
    }
    async startPermissionSetup(kinds: readonly string[]) {
      await mocks.startPermissionSetup(kinds);
    }
    async releaseHeldInput() {
      return true;
    }
    dispose() {}
  },
}));
vi.mock("../escapeKillSwitchMonitor.ts", () => ({
  EscapeKillSwitchMonitor: class {
    get state() {
      return mocks.monitorState;
    }
    activate = mocks.monitorActivate;
    setArmed = mocks.monitorArmed;
    start = mocks.monitorStart;
    dispose() {}
  },
}));
vi.mock("../computerFrameTap.ts", () => ({
  ComputerFrameTapPool: class {
    target() {
      return undefined;
    }
    changedAt() {
      return 0;
    }
    frameAt() {
      return 0;
    }
    setTarget() {}
    setVisible() {}
    async clear() {}
    async endTask() {}
    async stopAll() {}
    async dispose() {}
  },
}));
vi.mock("../cuaDriverHost.ts", () => ({
  CuaDriverHost: class {
    constructor(options: typeof mocks.hostOptions) {
      mocks.hostOptions = options;
    }
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
import type { ComputerActivityIndicator } from "./activityIndicator.ts";
import { readBundleIdentifier } from "../macAppBundle.ts";
let directory: string | undefined;
let beta: DesktopComputerBeta | undefined;
const GRANTED = { ...mocks.permissions };
afterEach(async () => {
  await beta?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
  beta = undefined;
  vi.clearAllMocks();
  Object.assign(mocks.permissions, GRANTED);
  mocks.monitorState = { ready: true };
  mocks.version = "1.0.0";
});
async function fixture(
  isDestroyed: () => boolean = () => false,
  reuseDirectory = false,
  extra: Partial<ConstructorParameters<typeof DesktopComputerBeta>[0]> = {},
) {
  if (!reuseDirectory || !directory) directory = await mkdtemp(join(tmpdir(), "ryco-beta-test-"));
  await mkdir(join(directory, "cua-driver"), { recursive: true });
  await writeFile(join(directory, "cua-driver", "cua-driver"), "fixture");
  beta = new DesktopComputerBeta({
    stateDir: directory,
    resourcesDir: directory,
    getWindow: () =>
      ({ isDestroyed, webContents: { send: mocks.send } }) as unknown as BrowserWindow,
    ...extra,
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
const SAFARI = { key: "safari", name: "Safari", canAlwaysAllow: true };
it.skipIf(process.platform !== "darwin")(
  "shares one dialog per app and separately asks for every clipboard request",
  async () => {
    const runtime = await fixture();
    const identity = { threadId: "thread", turnId: "turn" };
    await runtime.request({
      operation: "begin",
      ...identity,
      intent: await runtime.prepare("thread", true),
    });
    const replies = await Promise.all([
      runtime.request({ operation: "consent", ...identity, app: SAFARI }),
      runtime.request({ operation: "consent", ...identity, app: SAFARI }),
    ]);
    expect(replies).toEqual([
      { approved: true, outcome: "accept", retryable: false, scope: "chat" },
      { approved: true, outcome: "accept", retryable: false, scope: "chat" },
    ]);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: "Allow Ryco to use Safari?",
        buttons: ["Don't allow", "Allow for this chat", "Always allow"],
      }),
    );
    await runtime.request({ operation: "consent", ...identity, clipboard: true });
    await runtime.request({ operation: "consent", ...identity, clipboard: true });
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(3);
    await expect(runtime.request({ operation: "consent", ...identity })).rejects.toThrow(
      "Expected an object",
    );
    await runtime.stopTask("thread");
    await expect(
      runtime.request({ operation: "consent", ...identity, app: SAFARI }),
    ).rejects.toThrow("no longer active");
  },
);
it.skipIf(process.platform !== "darwin")(
  "reports Always allow, and offers it only for an app it can name",
  async () => {
    const runtime = await fixture();
    const identity = { threadId: "thread", turnId: "turn" };
    await runtime.request({
      operation: "begin",
      ...identity,
      intent: await runtime.prepare("thread", true),
    });
    mocks.showMessageBox.mockResolvedValueOnce({ response: 2 });
    expect(await runtime.request({ operation: "consent", ...identity, app: SAFARI })).toEqual({
      approved: true,
      outcome: "accept",
      retryable: false,
      scope: "always",
    });
    const unnamed = { key: "\u0000mac", name: "your Mac", canAlwaysAllow: false };
    mocks.showMessageBox.mockResolvedValueOnce({ response: 2 });
    expect(await runtime.request({ operation: "consent", ...identity, app: unnamed })).toEqual({
      approved: false,
      outcome: "decline",
      retryable: false,
    });
    expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: "Allow Ryco to use your Mac in this chat?",
        buttons: ["Don't allow", "Allow for this chat"],
      }),
    );
  },
);
it.skipIf(process.platform !== "darwin")(
  "does not bind the turn when no window can show the consent dialog",
  async () => {
    let destroyed = true;
    const runtime = await fixture(() => destroyed);
    const identity = { threadId: "thread", turnId: "turn" };
    await runtime.request({
      operation: "begin",
      ...identity,
      intent: await runtime.prepare("thread", true),
    });
    expect(await runtime.request({ operation: "consent", ...identity, app: SAFARI })).toEqual({
      approved: false,
      outcome: "unavailable",
      retryable: true,
    });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    destroyed = false;
    expect(await runtime.request({ operation: "consent", ...identity, app: SAFARI })).toEqual({
      approved: true,
      outcome: "accept",
      retryable: false,
      scope: "chat",
    });
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
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

it.skipIf(process.platform !== "darwin")(
  "runs without the Escape listener when Input Monitoring is not granted",
  async () => {
    mocks.permissions.inputMonitoringPermission = "denied";
    mocks.monitorState = { ready: false, error: "input-monitoring-required" };
    const runtime = await fixture();
    const intent = await runtime.prepare("thread", true);
    expect(intent?.mode).toBe("request");
    expect(mocks.monitorActivate).not.toHaveBeenCalled();
    const host = mocks.hostOptions!;
    expect(host.inputMonitorState()).toEqual({ ready: true });
    await host.activateInputMonitor();
    expect(mocks.monitorActivate).not.toHaveBeenCalled();
    host.onInputMonitorArmedChange(true);
    expect(mocks.monitorArmed).toHaveBeenLastCalledWith(false);
    // The backend never sees the optional grant as missing.
    expect(await host.checkPermissions()).toEqual({ accessibility: true, screenRecording: true });
    expect(runtime.state().setup).toEqual({
      missing: [],
      escapeStop: false,
      staleGrant: false,
      movedToHelper: false,
    });
    // The backend refuses foreground use from this report.
    expect(await runtime.request({ operation: "state" })).toMatchObject({
      escapeStop: {
        granted: false,
        listener: { ready: false, error: "input-monitoring-required" },
      },
    });
  },
);
it.skipIf(process.platform !== "darwin")(
  "keeps today's Escape listener gate when Input Monitoring is granted",
  async () => {
    mocks.monitorState = { ready: false, error: "input_monitor_unavailable" };
    const runtime = await fixture();
    await expect(runtime.prepare("thread", true)).rejects.toThrow("Escape listener");
    expect(mocks.monitorActivate).toHaveBeenCalledWith(true);
    const host = mocks.hostOptions!;
    expect(host.inputMonitorState()).toEqual(mocks.monitorState);
    host.onInputMonitorArmedChange(true);
    expect(mocks.monitorArmed).toHaveBeenLastCalledWith(true);
    expect(await host.checkPermissions()).toEqual({
      accessibility: true,
      inputMonitoring: true,
      screenRecording: true,
    });
  },
);
it.skipIf(process.platform !== "darwin")(
  "never holds a default send for the Escape listener, and starts it in the background",
  async () => {
    mocks.monitorState = { ready: false, error: "input_monitor_starting" };
    mocks.monitorActivate.mockImplementation(() => new Promise<void>(() => {}));
    const runtime = await fixture();
    runtime.update({ ...runtime.state().preferences, defaultEnabled: true });
    expect(await runtime.prepare("thread", false)).toMatchObject({ mode: "chat" });
    expect(mocks.monitorActivate).toHaveBeenCalledWith(true);
    mocks.monitorActivate.mockImplementation(async () => {});
    mocks.monitorState = { ready: false, error: "event_tap_disabled" };
    expect(await runtime.prepare("thread", false)).toMatchObject({ mode: "chat" });
    // `/computer-use` still reports the listener that blocks it.
    await expect(runtime.prepare("thread", true)).rejects.toThrow("Escape listener");
  },
);
it.skipIf(process.platform !== "darwin")(
  "warms the helper and the Escape listener at start when Computer Use is on",
  async () => {
    let runtime = await fixture();
    expect(mocks.refreshState).not.toHaveBeenCalled();
    runtime.update({ ...runtime.state().preferences, defaultEnabled: true });
    await runtime.dispose();
    runtime = await fixture(undefined, true);
    await vi.waitFor(() => expect(mocks.monitorStart).toHaveBeenCalledOnce());
    expect(mocks.refreshState).toHaveBeenCalled();
  },
);
it.skipIf(process.platform !== "darwin")(
  "does not count a permission a check could not read as missing for a default send",
  async () => {
    const runtime = await fixture();
    runtime.update({ ...runtime.state().preferences, defaultEnabled: true });
    expect(await runtime.prepare("thread", false)).toMatchObject({ mode: "chat" });
    // A cold helper start timed the next probe out: the last complete report holds.
    mocks.permissions.accessibilityPermission = "unknown";
    mocks.permissions.screenRecordingPermission = "unknown";
    mocks.permissions.inputMonitoringPermission = "unknown";
    expect(await runtime.prepare("thread", false)).toMatchObject({ mode: "chat" });
    expect(runtime.state().setup).toMatchObject({ staleGrant: false, movedToHelper: false });
    // A completed check that reports it missing does block.
    mocks.permissions.accessibilityPermission = "denied";
    expect(await runtime.prepare("thread", false)).toBeNull();
    mocks.permissions.accessibilityPermission = "unknown";
    expect(await runtime.prepare("thread", false)).toBeNull();
  },
);
it.skipIf(process.platform !== "darwin")(
  "after a restart, falls back to the build that had every grant while permissions are unknown",
  async () => {
    let runtime = await fixture();
    await runtime.check();
    runtime.update({ ...runtime.state().preferences, defaultEnabled: true });
    await runtime.dispose();
    mocks.version = "1.0.1";
    mocks.permissions.accessibilityPermission = "unknown";
    mocks.permissions.screenRecordingPermission = "unknown";
    runtime = await fixture(undefined, true);
    expect(await runtime.prepare("thread", false)).toMatchObject({ mode: "chat" });
    // An update with grants not read yet is no stale grant.
    expect((await runtime.check()).setup.staleGrant).toBe(false);
  },
);
it.skipIf(process.platform !== "darwin")(
  "names foreground-delivered work as foreground in the menu-bar status",
  async () => {
    const indicator = { touch: vi.fn(), end: vi.fn(), endAll: vi.fn() };
    const runtime = await fixture(undefined, false, {
      indicator: indicator as unknown as ComputerActivityIndicator,
    });
    const intent = await runtime.prepare("thread", true);
    await runtime.request({ operation: "begin", threadId: "thread", turnId: "turn", intent });
    const target = { task: { threadId: "thread", turnId: "turn" }, pid: process.pid, windowId: 1 };
    mocks.hostOptions!.frameTap.update(target, { foreground: true });
    await vi.waitFor(() =>
      expect(indicator.touch).toHaveBeenCalledWith("cua:thread", expect.any(String), "foreground"),
    );
    mocks.hostOptions!.frameTap.update(target);
    await vi.waitFor(() =>
      expect(indicator.touch).toHaveBeenLastCalledWith(
        "cua:thread",
        expect.any(String),
        "background",
      ),
    );
  },
);
it.skipIf(process.platform !== "darwin")(
  "ends the thread's older turn when a newer one begins",
  async () => {
    const runtime = await fixture();
    const intent = await runtime.prepare("thread", true);
    await runtime.request({ operation: "begin", threadId: "thread", turnId: "turn-1", intent });
    await runtime.request({
      operation: "begin",
      threadId: "other",
      turnId: "turn-1",
      intent: await runtime.prepare("other", true),
    });
    mocks.send.mockClear();
    await runtime.request({ operation: "begin", threadId: "thread", turnId: "turn-2", intent });
    expect(mocks.stopTask).toHaveBeenCalledWith({ threadId: "thread", turnId: "turn-1" });
    expect(mocks.stopTask).not.toHaveBeenCalledWith({ threadId: "other", turnId: "turn-1" });
    expect(mocks.send).toHaveBeenCalledWith("desktop:computer-beta:update", {
      type: "ended",
      threadId: "thread",
      turnId: "turn-1",
    });
    await expect(
      runtime.request({
        operation: "consent",
        threadId: "thread",
        turnId: "turn-1",
        clipboard: true,
      }),
    ).rejects.toThrow("no longer active");
    await expect(
      runtime.request({ operation: "begin", threadId: "thread", turnId: "turn-1", intent }),
    ).rejects.toThrow("expired");
    expect(
      await runtime.request({
        operation: "consent",
        threadId: "other",
        turnId: "turn-1",
        clipboard: true,
      }),
    ).toMatchObject({ approved: true });
  },
);
it.skipIf(process.platform !== "darwin")(
  "sends a default chat without Computer Use when setup is missing, and blocks an explicit task",
  async () => {
    mocks.permissions.screenRecordingPermission = "denied";
    const runtime = await fixture();
    runtime.update({ ...runtime.state().preferences, defaultEnabled: true });
    expect(await runtime.prepare("thread", false)).toBeNull();
    expect(mocks.startPermissionSetup).not.toHaveBeenCalled();
    await expect(runtime.prepare("thread", true)).rejects.toThrow("Complete Computer Use setup");
    // Only the missing required permission is guided.
    expect(mocks.startPermissionSetup).toHaveBeenCalledWith(["screenRecording"]);
  },
);
it.skipIf(process.platform !== "darwin")(
  "turns on for every chat and guides only the missing required permissions",
  async () => {
    mocks.permissions.accessibilityPermission = "denied";
    mocks.permissions.screenRecordingPermission = "not-determined";
    mocks.permissions.inputMonitoringPermission = "denied";
    const runtime = await fixture();
    const state = await runtime.turnOn();
    expect(state.preferences.defaultEnabled).toBe(true);
    expect(state.setup.missing).toEqual(["accessibility", "screenRecording"]);
    expect(mocks.startPermissionSetup).toHaveBeenCalledWith(["accessibility", "screenRecording"]);
    await runtime.setupPermission("inputMonitoring");
    expect(mocks.startPermissionSetup).toHaveBeenLastCalledWith(["inputMonitoring"]);
  },
);
it.skipIf(process.platform !== "darwin")(
  "flags a stale grant only when an earlier build had every required grant",
  async () => {
    let runtime = await fixture();
    await runtime.check();
    await runtime.dispose();
    mocks.version = "1.0.1";
    mocks.permissions.accessibilityPermission = "denied";
    runtime = await fixture(undefined, true);
    expect((await runtime.check()).setup).toEqual({
      missing: ["accessibility"],
      escapeStop: true,
      staleGrant: true,
      movedToHelper: false,
    });
    await runtime.dispose();
    mocks.version = "1.0.0";
    runtime = await fixture(undefined, true);
    expect((await runtime.check()).setup.staleGrant).toBe(false);
  },
);
const helperGrants = {
  target: {
    bundlePath: "/Applications/Ryco.app/Contents/Helpers/Ryco Computer Use.app",
    bundleId: "com.laurinfrank.ryco.computer-use",
    displayName: "Ryco Computer Use",
    hostBundleId: "com.laurinfrank.ryco",
    helper: {
      bundlePath: "/Applications/Ryco.app/Contents/Helpers/Ryco Computer Use.app",
      bundleId: "com.laurinfrank.ryco.computer-use",
      displayName: "Ryco Computer Use",
      version: "1.0.0",
    },
  },
  spawn: undefined,
};
it.skipIf(process.platform !== "darwin")(
  "tells a user whose grants were on Ryco once that Ryco Computer Use needs allowing",
  async () => {
    mocks.permissions.accessibilityPermission = "denied";
    const runtime = await fixture(undefined, false, {
      grants: helperGrants,
      hostHadGrants: () => true,
    });
    runtime.update({ ...runtime.state().preferences, defaultEnabled: true });
    expect((await runtime.check()).setup).toMatchObject({ movedToHelper: true, staleGrant: false });
    // A default send goes without Computer Use, but not silently: one dialog, never again.
    expect(await runtime.prepare("thread", false)).toBeNull();
    expect(await runtime.prepare("thread", false)).toBeNull();
    await vi.waitFor(() => expect(mocks.startPermissionSetup).toHaveBeenCalled());
    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
    expect(mocks.showMessageBox.mock.calls[0]).toMatchObject([
      {},
      { message: expect.stringContaining("now runs as its own app") },
    ]);
    await expect(runtime.prepare("thread", true)).rejects.toThrow("now runs as its own app");
    const saved = JSON.parse(await readFile(join(directory!, "computer-setup.json"), "utf8"));
    expect(saved.moveNoticeShown).toBe(true);
    await runtime.dispose();
    // The notice stays shown across restarts.
    mocks.showMessageBox.mockClear();
    const again = await fixture(undefined, true, {
      grants: helperGrants,
      hostHadGrants: () => true,
    });
    expect(await again.prepare("thread", false)).toBeNull();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  },
);
it.skipIf(process.platform !== "darwin")(
  "treats a full grant recorded before the helper as Ryco's, and the helper's own as current",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "ryco-beta-test-"));
    await writeFile(join(directory, "computer-setup.json"), JSON.stringify({ grantedBuild: "x" }));
    mocks.permissions.accessibilityPermission = "denied";
    let runtime = await fixture(undefined, true, {
      grants: helperGrants,
      hostHadGrants: () => false,
    });
    expect((await runtime.check()).setup).toMatchObject({ movedToHelper: true, staleGrant: false });
    mocks.permissions.accessibilityPermission = "granted";
    await runtime.check();
    const saved = JSON.parse(await readFile(join(directory, "computer-setup.json"), "utf8"));
    expect(saved.grantedBundleId).toBe("com.laurinfrank.ryco.computer-use");
    await runtime.dispose();
    mocks.permissions.accessibilityPermission = "denied";
    runtime = await fixture(undefined, true, { grants: helperGrants, hostHadGrants: () => true });
    expect((await runtime.check()).setup.movedToHelper).toBe(false);
  },
);
it.skipIf(process.platform !== "darwin")(
  "lists the always-allowed apps the backend stored and removes one",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "ryco-beta-test-"));
    await writeFile(
      join(directory, "computer-app-approvals.json"),
      JSON.stringify({
        version: 1,
        apps: [
          { key: "safari", name: "Safari", allowedAt: "2026-11-06T00:00:00.000Z" },
          { key: "notes", name: "Notes", allowedAt: "2026-11-06T00:00:00.000Z" },
        ],
      }),
    );
    const runtime = await fixture(undefined, true);
    expect((await runtime.currentState()).approvedApps.map((app) => app.name)).toEqual([
      "Safari",
      "Notes",
    ]);
    const state = await runtime.revokeApp("safari");
    expect(state.approvedApps.map((app) => app.key)).toEqual(["notes"]);
    expect(
      JSON.parse(await readFile(join(directory, "computer-app-approvals.json"), "utf8")).apps,
    ).toHaveLength(1);
  },
);

it("reads the bundle identifier from an XML Info.plist without spawning PlistBuddy", () => {
  const plist = Buffer.from(
    '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key>\n  <string>com.laurinfrank.ryco</string></dict></plist>',
  );
  expect(readBundleIdentifier("/Ryco.app/Contents/Info.plist", () => plist)).toBe(
    "com.laurinfrank.ryco",
  );
  expect(
    readBundleIdentifier("/missing/Info.plist", () => {
      throw new Error("ENOENT");
    }),
  ).toBeNull();
});
