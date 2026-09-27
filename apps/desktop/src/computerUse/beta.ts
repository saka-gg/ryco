import { readComputerAuditHistory } from "@ryco/shared/computerAuditHistory";
import { ComputerGetAuditHistoryInput } from "@ryco/contracts";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { app, dialog, powerMonitor, shell, type BrowserWindow } from "electron";
import { Schema } from "effect";
import {
  ComputerEvent,
  ComputerTurnIntent,
  type ComputerBetaPreferences,
  type ComputerBetaState,
  type ComputerBetaUpdate,
} from "@ryco/contracts";
import type { CuaPreviewTarget } from "@ryco/shared/cuaDriverProtocol";
import { DesktopAppSnapManager } from "../appSnapManager.ts";
import { CuaDriverHost } from "../cuaDriverHost.ts";
import { ComputerFrameTap } from "../computerFrameTap.ts";
import { EscapeKillSwitchMonitor } from "../escapeKillSwitchMonitor.ts";
import { registerComputerDesktopLifecycle } from "../computerDesktopLifecycle.ts";
import { record, textArg } from "./native.ts";

const PERMISSIONS = ["accessibility", "inputMonitoring", "screenRecording"] as const;
const preferencesSchema = Schema.Struct({
  defaultEnabled: Schema.Boolean,
  autoPreview: Schema.Boolean,
  previewSize: Schema.Literals(["compact", "large"]),
  cursorColor: Schema.NullOr(Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i))),
});
const defaults: ComputerBetaPreferences = {
  defaultEnabled: false,
  autoPreview: true,
  previewSize: "compact",
  cursorColor: null,
};
interface Task {
  threadId: string;
  turnId: string;
  controller: AbortController;
  consent?: Promise<boolean>;
  denied: boolean;
  consentGeneration: number;
}
const taskKey = (task: { threadId: string; turnId: string }) =>
  JSON.stringify([task.threadId, task.turnId]);

/** Desktop ownership and presentation only. Tool authority remains server-owned. */
export class DesktopComputerBeta {
  readonly host: CuaDriverHost;
  private readonly permissions: DesktopAppSnapManager;
  private readonly monitor: EscapeKillSwitchMonitor;
  private readonly tap: ComputerFrameTap;
  private readonly hostOptions: ConstructorParameters<typeof CuaDriverHost>[0];
  private readonly getWindow: () => BrowserWindow | null;
  private readonly settingsPath: string;
  private readonly auditLogPath: string;
  private preferences: ComputerBetaPreferences = defaults;
  private epoch = randomUUID();
  private readonly generations = new Map<string, number>();
  private readonly tasks = new Map<string, Task>();
  private readonly endedTasks = new Set<string>();
  private readonly visible = new Set<string>();
  private target: CuaPreviewTarget | undefined;
  private endpoint = "";
  private lastNativeFrameAt = 0;
  private targetChangedAt = 0;
  private readonly previewTargets = new Map<
    string,
    { turnId: string; targetId: string; label: string }
  >();
  private error: string | null = null;
  private readonly removeLifecycle: () => void;
  private closed = false;
  private pendingApprovals = 0;

  constructor(options: {
    stateDir: string;
    auditLogPath?: string;
    resourcesDir: string;
    getWindow(): BrowserWindow | null;
  }) {
    this.getWindow = options.getWindow;
    this.settingsPath = join(options.stateDir, "computer-beta.json");
    this.auditLogPath = options.auditLogPath ?? join(options.stateDir, "computer-audit.jsonl");
    try {
      this.preferences = Schema.decodeUnknownSync(preferencesSchema)(
        JSON.parse(readFileSync(this.settingsPath, "utf8")),
      );
    } catch {
      /* Missing or invalid preferences retain disabled defaults. */
    }
    const executable = app.getPath("exe");
    const appEnd = executable.indexOf(".app/");
    const bundlePath = appEnd >= 0 ? executable.slice(0, appEnd + 4) : undefined;
    let bundleId = "com.laurinfrank.ryco";
    if (bundlePath && process.platform === "darwin") {
      try {
        bundleId =
          execFileSync(
            "/usr/libexec/PlistBuddy",
            ["-c", "Print:CFBundleIdentifier", join(bundlePath, "Contents", "Info.plist")],
            { encoding: "utf8", timeout: 1000 },
          ).trim() || bundleId;
      } catch {
        /* Packaged identity remains the fallback. */
      }
    }
    const helperPath = join(options.resourcesDir, "ryco-computer-ui-helper");
    this.permissions = new DesktopAppSnapManager({
      platform: process.platform,
      helperPath,
      captureDirectory: join(options.stateDir, "computer-captures"),
      excludedBundleId: bundleId,
      appDisplayName: app.getName(),
      ...(bundlePath ? { appBundlePath: bundlePath } : {}),
      onState: () => this.publishState(),
      onCaptured: () => undefined,
      onError: (error) => {
        this.error = error.message;
        this.publishState();
      },
      openSettingsPane: (pane) => {
        const suffix = {
          accessibility: "Accessibility",
          "input-monitoring": "ListenEvent",
          "screen-recording": "ScreenCapture",
        }[pane];
        void shell.openExternal(
          `x-apple.systempreferences:com.apple.preference.security?Privacy_${suffix}`,
        );
      },
    });
    this.tap = new ComputerFrameTap({
      helperPath,
      send: (_channel, frame) => {
        const target = this.target;
        if (
          !target ||
          !this.visible.has(target.task.threadId) ||
          target.windowId !== frame.windowId ||
          frame.task.threadId !== target.task.threadId ||
          frame.task.turnId !== target.task.turnId
        )
          return;
        const turnId = target.task.turnId;
        if (!turnId || !this.tasks.has(taskKey({ threadId: target.task.threadId, turnId }))) return;
        this.lastNativeFrameAt = Date.now();
        this.send({
          type: "frame",
          threadId: target.task.threadId,
          turnId,
          targetId: `cua:${target.pid}:${target.windowId}`,
          sequence: frame.seq,
          mimeType: "image/jpeg",
          bytes: frame.jpeg,
        });
      },
      onError: (error) => {
        if (this.target?.task.turnId)
          this.send({
            type: "error",
            threadId: this.target.task.threadId,
            turnId: this.target.task.turnId,
            message: error instanceof Error ? error.message : "Preview unavailable.",
          });
      },
    });
    this.monitor = new EscapeKillSwitchMonitor({
      helperPath,
      onEscape: () => {
        this.host.emergencyStopInput();
      },
      onPhysicalInput: (event) => {
        this.host.physicalInput(event);
      },
      onStateChange: (state) => {
        if (!state.ready)
          for (const task of this.tasks.values()) {
            delete task.consent;
            task.consentGeneration += 1;
          }
        this.host.inputMonitorStateChanged(state);
        this.publishState();
      },
      onError: (message) => {
        this.error = message;
        this.publishState();
      },
    });
    this.hostOptions = {
      binaryPath: join(options.resourcesDir, "cua-driver", "cua-driver"),
      bundleId,
      capability: randomBytes(32).toString("base64url"),
      setup: async () => {
        await this.setup();
      },
      checkPermissions: async () => {
        const state = await this.permissions.refreshState(PERMISSIONS);
        return {
          accessibility: state.accessibilityPermission === "granted",
          inputMonitoring: state.inputMonitoringPermission === "granted",
          screenRecording: state.screenRecordingPermission === "granted",
        };
      },
      releaseHeldInput: async () => {
        if (!(await this.permissions.releaseHeldInput()))
          throw new Error("Native input cleanup was not acknowledged.");
      },
      inputMonitorState: () => this.monitor.state,
      activateInputMonitor: () => this.monitor.activate(),
      onInputMonitorArmedChange: (armed) => this.monitor.setArmed(armed),
      cursorStyle: () =>
        this.preferences.cursorColor ? { fill: this.preferences.cursorColor } : null,
      frameTap: {
        update: (target) => {
          this.target = target;
          this.targetChangedAt = Date.now();
          if (!target.task.turnId) return;
          this.send({
            type: "target",
            threadId: target.task.threadId,
            turnId: target.task.turnId,
            targetId: `cua:${target.pid}:${target.windowId}`,
            label: target.task.label ?? "Computer",
          });
          if (this.visible.has(target.task.threadId)) this.tap.update(target);
          else void this.tap.stop().catch(() => undefined);
        },
        endTask: async (task) => {
          if (
            this.target?.task.threadId === task.threadId &&
            this.target.task.turnId === task.turnId
          )
            this.target = undefined;
          await this.tap.endTask(task);
        },
        stop: async () => {
          this.target = undefined;
          await this.tap.stop();
        },
        dispose: () => this.tap.dispose(),
      },
    };
    this.host = new CuaDriverHost(this.hostOptions);
    this.removeLifecycle = registerComputerDesktopLifecycle(
      powerMonitor,
      {
        pauseDesktop: (reason) => {
          for (const task of this.tasks.values()) {
            delete task.consent;
            task.consentGeneration += 1;
          }
          return this.host.pauseDesktop(reason);
        },
        resumeDesktop: (reason) => this.host.resumeDesktop(reason),
      },
      () => {
        this.error = "Computer input paused after a desktop lifecycle change.";
        this.publishState();
      },
    );
  }
  async start(): Promise<void> {
    if (process.platform === "darwin") this.endpoint = await this.host.listen();
  }
  binding() {
    this.stop();
    this.hostOptions.capability = randomBytes(32).toString("base64url");
    return this.endpoint
      ? { endpoint: this.endpoint, capability: this.hostOptions.capability }
      : undefined;
  }
  state(): ComputerBetaState {
    return {
      supported: process.platform === "darwin",
      preferences: this.preferences,
      targets: [...this.previewTargets].map(([threadId, target]) => ({
        threadId,
        turnId: target.turnId,
        targetId: target.targetId,
        label: target.label,
      })),
      permissions: this.permissions.getState(),
      inputMonitorReady: this.monitor.state.ready,
      error: this.error,
    };
  }
  readHistory(input: unknown = {}) {
    return readComputerAuditHistory(
      this.auditLogPath,
      Schema.decodeUnknownSync(ComputerGetAuditHistoryInput)(input),
    );
  }
  private send(update: ComputerBetaUpdate): void {
    if (update.type === "target")
      this.previewTargets.set(update.threadId, {
        turnId: update.turnId,
        targetId: update.targetId,
        label: update.label,
      });
    if (
      update.type === "ended" &&
      this.previewTargets.get(update.threadId)?.turnId === update.turnId
    )
      this.previewTargets.delete(update.threadId);
    const window = this.getWindow();
    if (!this.closed && window && !window.isDestroyed())
      window.webContents.send("desktop:computer-beta:update", update);
  }
  private publishState(): void {
    if (this.permissions && this.monitor) this.send({ type: "state", state: this.state() });
  }
  async check(): Promise<ComputerBetaState> {
    await this.permissions.refreshState(PERMISSIONS);
    return this.state();
  }
  async setup(): Promise<ComputerBetaState> {
    await this.host.stop();
    await this.permissions.startPermissionSetup(PERMISSIONS);
    return this.state();
  }
  update(raw: unknown): ComputerBetaState {
    const next = Schema.decodeUnknownSync(preferencesSchema)(raw);
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.settingsPath);
    if (this.preferences.defaultEnabled !== next.defaultEnabled) this.stop();
    this.preferences = next;
    this.publishState();
    return this.state();
  }
  private generation(threadId: string): string {
    return `${this.epoch}:${this.generations.get(threadId) ?? 0}:${createHash("sha256").update(threadId).digest("hex")}`;
  }
  async prepare(threadId: string, explicit: boolean): Promise<ComputerTurnIntent | null> {
    if (!explicit && !this.preferences.defaultEnabled) return null;
    if (process.platform !== "darwin")
      throw new Error("Computer Use beta is available on macOS desktop.");
    const state = await this.check();
    if (PERMISSIONS.some((key) => state.permissions[`${key}Permission`] !== "granted")) {
      await this.setup();
      throw new Error(
        "Complete Computer Use setup, then send your task again. Your prompt has not been sent.",
      );
    }
    if (!existsSync(this.hostOptions.binaryPath))
      throw new Error(
        "The Computer driver is missing. Rebuild or reinstall Ryco before sending this task.",
      );
    await this.monitor.activate(true);
    if (!this.monitor.state.ready)
      throw new Error("Input Monitoring is not ready. Check Computer setup and send again.");
    return { mode: explicit ? "request" : "chat", generation: this.generation(threadId) };
  }
  preview(threadId: string, visible: boolean): void {
    if (visible) this.visible.add(threadId);
    else this.visible.delete(threadId);
    if (this.target?.task.threadId === threadId) {
      if (visible) this.tap.update(this.target);
      else void this.tap.stop();
    }
  }
  async stopTask(threadId: string): Promise<void> {
    this.generations.set(threadId, (this.generations.get(threadId) ?? 0) + 1);
    for (const [key, task] of this.tasks) {
      if (task.threadId !== threadId) continue;
      task.controller.abort();
      this.tasks.delete(key);
      await this.host.stopTaskByUser({ threadId, turnId: task.turnId });
      this.send({ type: "ended", threadId, turnId: task.turnId });
    }
  }
  stop(): void {
    this.epoch = randomUUID();
    this.generations.clear();
    for (const task of this.tasks.values()) {
      task.controller.abort();
      this.send({ type: "ended", threadId: task.threadId, turnId: task.turnId });
    }
    this.tasks.clear();
    void this.host.stop().catch((error: unknown) => {
      this.error = error instanceof Error ? error.message : "Computer stop failed.";
      this.publishState();
    });
  }
  /** Only the authenticated backend calls this, never renderer/model supplied task claims. */
  async request(raw: unknown): Promise<unknown> {
    const input = record(raw);
    const operation = textArg(input, "operation");
    if (operation === "state") return { ...this.state(), visibleThreads: [...this.visible] };
    const threadId = textArg(input, "threadId", 256);
    const turnId = textArg(input, "turnId", 256);
    const key = taskKey({ threadId, turnId });
    if (operation === "end") {
      this.endedTasks.add(key);
      while (this.endedTasks.size > 256)
        this.endedTasks.delete(this.endedTasks.values().next().value!);
      if (!this.tasks.has(key)) return { ended: true };
    }
    if (operation === "begin") {
      const intent = Schema.decodeUnknownSync(ComputerTurnIntent)(input.intent);
      if (
        this.endedTasks.has(key) ||
        intent.generation !== this.generation(threadId) ||
        (intent.mode === "chat" && !this.preferences.defaultEnabled)
      )
        throw new Error("Computer task expired or was stopped. Send a new request to resume.");
      if (!this.tasks.has(key)) {
        if (this.tasks.size >= 64) throw new Error("Too many active Computer tasks.");
        this.tasks.set(key, {
          threadId,
          turnId,
          controller: new AbortController(),
          denied: false,
          consentGeneration: 0,
        });
        this.send({ type: "target", threadId, turnId, targetId: "pending", label: "Computer" });
      }
      return { ready: true };
    }
    const task = this.tasks.get(key);
    if (!task || task.controller.signal.aborted)
      throw new Error("Computer task is no longer active.");
    if (operation === "end") {
      task.controller.abort();
      this.tasks.delete(key);
      await this.host.stopTaskByUser({ threadId, turnId });
      this.send({ type: "ended", threadId, turnId });
      return { ended: true };
    }
    if (operation === "consent") {
      if (task.denied) return { approved: false };
      const clipboard = input.clipboard === true;
      const ask = async () => {
        if (this.pendingApprovals >= 8) return false;
        const generation = task.consentGeneration;
        const owner = this.getWindow();
        if (!owner || owner.isDestroyed()) return false;
        this.pendingApprovals += 1;
        try {
          const response = await dialog.showMessageBox(owner, {
            type: "question",
            title: clipboard ? "Allow clipboard access?" : "Allow Computer for this task?",
            message: clipboard
              ? "Allow this task to access your clipboard?"
              : "Allow the agent to work in Mac apps and browsers for this task?",
            detail:
              "Use Stop in chat to end the task. Physical Escape interrupts the current action. Foreground use still requires your explicit request.",
            buttons: ["Cancel", "Allow"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            signal: task.controller.signal,
          });
          return (
            response.response === 1 &&
            !task.controller.signal.aborted &&
            generation === task.consentGeneration
          );
        } finally {
          this.pendingApprovals -= 1;
        }
      };
      if (!clipboard) task.consent ??= ask();
      const approved = await (clipboard ? ask() : task.consent!);
      if (!approved && !clipboard) task.denied = true;
      return { approved };
    }
    if (operation === "event") {
      const event = Schema.decodeUnknownSync(ComputerEvent)(input.event);
      this.send({ type: "event", event });
      return { visible: this.visible.has(threadId) };
    }
    if (operation === "frame") {
      if (this.visible.has(threadId)) {
        const targetId = textArg(input, "targetId");
        if (typeof input.startedAt !== "number" || input.startedAt < this.targetChangedAt)
          return { visible: true };
        if (this.target && targetId !== `cua:${this.target.pid}:${this.target.windowId}`) {
          this.target = undefined;
          await this.tap.stop();
        }
        if (this.previewTargets.get(threadId)?.targetId !== targetId)
          this.send({
            type: "target",
            threadId,
            turnId,
            targetId,
            label: targetId.startsWith("browser:") ? "Browser" : "Computer",
          });
        if (
          this.target?.task.threadId === threadId &&
          this.target.task.turnId === turnId &&
          targetId === `cua:${this.target.pid}:${this.target.windowId}` &&
          Date.now() - this.lastNativeFrameAt < 1500
        )
          return { visible: true };
        const data = textArg(input, "data", 6 * 1024 * 1024);
        const mimeType = input.mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
        this.send({
          type: "frame",
          threadId,
          turnId,
          targetId: textArg(input, "targetId"),
          sequence: typeof input.sequence === "number" ? input.sequence : 0,
          mimeType,
          bytes: Buffer.from(data, "base64"),
        });
      }
      return { visible: this.visible.has(threadId) };
    }
    throw new Error("Unknown Computer request.");
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.stop();
    this.removeLifecycle();
    this.monitor.dispose();
    this.permissions.dispose();
    await this.host.dispose();
  }
}
