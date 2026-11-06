import { readComputerAuditHistory } from "@ryco/shared/computerAuditHistory";
import {
  computerAppApprovalsPath,
  readComputerAppApprovals,
  removeComputerAppApproval,
} from "@ryco/shared/computerAppApprovals";
import { ComputerGetAuditHistoryInput } from "@ryco/contracts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync } from "node:fs";
import { app, dialog, powerMonitor, shell, type BrowserWindow } from "electron";
import * as Schema from "effect/Schema";
import {
  ComputerEvent,
  ComputerTurnIntent,
  type ComputerApprovedApp,
  type ComputerBetaPreferences,
  type ComputerBetaSetup,
  type ComputerBetaState,
  type ComputerBetaUpdate,
  type ComputerSetupPermission,
  type DesktopAppSnapPermissionKind,
} from "@ryco/contracts";
import type { CuaPreviewTarget } from "@ryco/shared/cuaDriverProtocol";
import { DesktopAppSnapManager } from "../appSnapManager.ts";
import { CuaDriverHost } from "../cuaDriverHost.ts";
import { ComputerFrameTapPool } from "../computerFrameTap.ts";
import { EscapeKillSwitchMonitor } from "../escapeKillSwitchMonitor.ts";
import { registerComputerDesktopLifecycle } from "../computerDesktopLifecycle.ts";
import { macPrivacySettingsUrl, resolveMacAppBundle } from "../macAppBundle.ts";
import { resolveComputerUsePermissionTarget } from "./permissionTarget.ts";
import { record, textArg } from "./native.ts";
import type { ComputerActivityIndicator } from "./activityIndicator.ts";
import { appNameForPid } from "./processAppName.ts";
import {
  ComputerConsentSheets,
  ComputerTaskConsent,
  type ComputerConsentRequest,
  type ComputerConsentShown,
} from "./taskConsent.ts";

/** Computer Use needs these two; Input Monitoring only adds the physical Escape stop. */
const REQUIRED_PERMISSIONS: readonly ComputerSetupPermission[] = [
  "accessibility",
  "screenRecording",
];
const PERMISSIONS = ["accessibility", "inputMonitoring", "screenRecording"] as const;
const SETUP_FILE = "computer-setup.json";
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
  consent: ComputerTaskConsent;
}
const taskKey = (task: { threadId: string; turnId: string }) =>
  JSON.stringify([task.threadId, task.turnId]);
const INDICATOR_PREFIX = "cua:";
const indicatorKey = (threadId: string) => `${INDICATOR_PREFIX}${threadId}`;

/** Desktop ownership and presentation only. Tool authority remains server-owned. */
export class DesktopComputerBeta {
  readonly host: CuaDriverHost;
  private readonly permissions: DesktopAppSnapManager;
  private readonly monitor: EscapeKillSwitchMonitor;
  private readonly taps: ComputerFrameTapPool;
  private readonly hostOptions: ConstructorParameters<typeof CuaDriverHost>[0];
  private readonly getWindow: () => BrowserWindow | null;
  private readonly indicator: ComputerActivityIndicator | undefined;
  private readonly settingsPath: string;
  private readonly setupPath: string;
  private readonly auditLogPath: string;
  private readonly approvalsPath: string;
  private approvedApps: readonly ComputerApprovedApp[] = [];
  /** The build that last had every required grant; a different build missing one is stale. */
  private grantedBuild: string | null = null;
  private readonly build: string;
  private preferences: ComputerBetaPreferences = defaults;
  private epoch = randomUUID();
  private readonly generations = new Map<string, number>();
  private readonly tasks = new Map<string, Task>();
  private readonly endedTasks = new Set<string>();
  private readonly visible = new Set<string>();
  private endpoint = "";
  private readonly previewTargets = new Map<
    string,
    { turnId: string; targetId: string; label: string }
  >();
  private error: string | null = null;
  private readonly removeLifecycle: () => void;
  private closed = false;
  /** Consent sheets go up one at a time, so each dialog's lifetime starts when it shows. */
  private readonly consentSheets = new ComputerConsentSheets((request, signal, onShown) =>
    this.showConsent(request, signal, onShown),
  );

  constructor(options: {
    stateDir: string;
    auditLogPath?: string;
    resourcesDir: string;
    getWindow(): BrowserWindow | null;
    /** The shared menu-bar status; it names the app each task uses, never the action. */
    indicator?: ComputerActivityIndicator;
  }) {
    this.getWindow = options.getWindow;
    this.indicator = options.indicator;
    this.settingsPath = join(options.stateDir, "computer-beta.json");
    this.auditLogPath = options.auditLogPath ?? join(options.stateDir, "computer-audit.jsonl");
    // The backend owns this file and writes it beside the audit log.
    this.approvalsPath = computerAppApprovalsPath(dirname(this.auditLogPath));
    this.setupPath = join(options.stateDir, SETUP_FILE);
    try {
      this.preferences = Schema.decodeUnknownSync(preferencesSchema)(
        JSON.parse(readFileSync(this.settingsPath, "utf8")),
      );
    } catch {
      /* Missing or invalid preferences retain disabled defaults. */
    }
    try {
      const saved = JSON.parse(readFileSync(this.setupPath, "utf8")) as { grantedBuild?: unknown };
      if (typeof saved.grantedBuild === "string") this.grantedBuild = saved.grantedBuild;
    } catch {
      /* No build has had every grant yet. */
    }
    const executablePath = app.getPath("exe");
    this.build = buildIdentity(executablePath, app.getVersion());
    const { bundleId } = resolveMacAppBundle(executablePath, process.platform);
    const target = resolveComputerUsePermissionTarget({
      executablePath,
      platform: process.platform,
      appName: app.getName(),
    });
    const helperPath = join(options.resourcesDir, "ryco-computer-ui-helper");
    this.permissions = new DesktopAppSnapManager({
      platform: process.platform,
      helperPath,
      captureDirectory: join(options.stateDir, "computer-captures"),
      excludedBundleId: bundleId,
      appDisplayName: target.displayName,
      ...(target.bundlePath ? { appBundlePath: target.bundlePath } : {}),
      onState: () => this.publishState(),
      onCaptured: () => undefined,
      onError: (error) => {
        this.error = error.message;
        this.publishState();
      },
      openSettingsPane: (pane) => {
        void shell.openExternal(macPrivacySettingsUrl(pane));
      },
    });
    this.taps = new ComputerFrameTapPool({
      helperPath,
      // The pool only forwards frames of a visible thread's current target.
      onFrame: (frame, target) => {
        const turnId = target.task.turnId;
        if (!turnId || !this.tasks.has(taskKey({ threadId: target.task.threadId, turnId }))) return;
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
      onError: (threadId, error) => {
        const turnId = this.taps.target(threadId)?.task.turnId;
        if (turnId)
          this.send({
            type: "error",
            threadId,
            turnId,
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
        // Without Input Monitoring the listener is not used, so its state stops nothing.
        if (this.escapeStop()) this.host.inputMonitorStateChanged(state);
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
          // Optional: reported only when granted, so a missing grant is never a missing
          // requirement for the backend.
          ...(state.inputMonitoringPermission === "granted" ? { inputMonitoring: true } : {}),
          screenRecording: state.screenRecordingPermission === "granted",
        };
      },
      releaseHeldInput: async () => {
        if (!(await this.permissions.releaseHeldInput()))
          throw new Error("Native input cleanup was not acknowledged.");
      },
      // Without Input Monitoring there is no Escape listener to wait for: the host runs
      // without the physical kill switch, and Stop in chat or the menu bar ends the task.
      inputMonitorState: () => (this.escapeStop() ? this.monitor.state : { ready: true }),
      activateInputMonitor: () => (this.escapeStop() ? this.monitor.activate() : Promise.resolve()),
      onInputMonitorArmedChange: (armed) => this.monitor.setArmed(armed && this.escapeStop()),
      cursorStyle: () =>
        this.preferences.cursorColor ? { fill: this.preferences.cursorColor } : null,
      frameTap: {
        update: (target) => {
          this.taps.setTarget(target);
          if (!target.task.turnId) return;
          this.send({
            type: "target",
            threadId: target.task.threadId,
            turnId: target.task.turnId,
            targetId: `cua:${target.pid}:${target.windowId}`,
            label: target.task.label ?? "Computer",
          });
          this.noteActivity(target);
        },
        endTask: async (task) => {
          // The status is per thread: a newer turn of the same thread keeps it.
          if (![...this.tasks.values()].some((live) => live.threadId === task.threadId))
            this.indicator?.end(indicatorKey(task.threadId));
          await this.taps.endTask(task);
        },
        stop: async () => {
          this.indicator?.endAll(INDICATOR_PREFIX);
          await this.taps.stopAll();
        },
        dispose: () => this.taps.dispose(),
      },
    };
    this.host = new CuaDriverHost(this.hostOptions);
    this.removeLifecycle = registerComputerDesktopLifecycle(
      powerMonitor,
      {
        // The backend clears chat approvals given before the interruption; answers here that
        // no request collected yet are dropped too.
        pauseDesktop: (reason) => {
          for (const task of this.tasks.values()) task.consent.discardUnclaimedAnswers();
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
    await this.refreshApprovedApps();
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
      setup: this.setupState(),
      approvedApps: this.approvedApps,
      error: this.error,
    };
  }
  /** Input Monitoring is granted, so the Escape listener guards input. */
  private escapeStop(): boolean {
    return this.permissions.getState().inputMonitoringPermission === "granted";
  }
  private missingPermissions(): ComputerSetupPermission[] {
    const permissions = this.permissions.getState();
    return REQUIRED_PERMISSIONS.filter((key) => permissions[`${key}Permission`] !== "granted");
  }
  private setupState(): ComputerBetaSetup {
    const missing = this.missingPermissions();
    return {
      missing,
      escapeStop: this.escapeStop(),
      staleGrant:
        missing.length > 0 && this.grantedBuild !== null && this.grantedBuild !== this.build,
    };
  }
  /** Remembers the build that had every required grant, to explain a later stale grant. */
  private noteGrantedBuild(): void {
    if (this.missingPermissions().length > 0 || this.grantedBuild === this.build) return;
    this.grantedBuild = this.build;
    try {
      writeAtomically(this.setupPath, JSON.stringify({ grantedBuild: this.build }));
    } catch {
      /* Only the stale-grant hint depends on it. */
    }
  }
  private async refreshApprovedApps(): Promise<void> {
    this.approvedApps = await readComputerAppApprovals(this.approvalsPath);
  }
  /** State for settings, with the always-allowed apps the backend may have added re-read. */
  async currentState(): Promise<ComputerBetaState> {
    await this.refreshApprovedApps();
    return this.state();
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
  /** Names the target's app in the menu-bar status while its task is still live. */
  private noteActivity(target: CuaPreviewTarget): void {
    const indicator = this.indicator;
    const turnId = target.task.turnId;
    if (!indicator || !turnId) return;
    const key = taskKey({ threadId: target.task.threadId, turnId });
    void appNameForPid(target.pid).then((app) => {
      if (this.closed || !this.tasks.has(key)) return;
      indicator.touch(indicatorKey(target.task.threadId), app ?? "an app", "background");
    });
  }
  private publishState(): void {
    if (this.permissions && this.monitor) this.send({ type: "state", state: this.state() });
  }
  async check(): Promise<ComputerBetaState> {
    await Promise.all([this.permissions.refreshState(PERMISSIONS), this.refreshApprovedApps()]);
    this.noteGrantedBuild();
    return this.state();
  }
  /** Guides the required permissions that are still missing, Accessibility first. */
  async setup(): Promise<ComputerBetaState> {
    await this.check();
    const missing = this.missingPermissions();
    if (missing.length === 0) return this.state();
    return this.guide(missing);
  }
  /** Guides one permission; Input Monitoring is the optional Escape stop. */
  async setupPermission(permission: DesktopAppSnapPermissionKind): Promise<ComputerBetaState> {
    return this.guide([permission]);
  }
  private async guide(
    permissions: readonly DesktopAppSnapPermissionKind[],
  ): Promise<ComputerBetaState> {
    await this.host.stop();
    await this.permissions.startPermissionSetup(permissions);
    return this.state();
  }
  /** The one Turn on button: available in every chat, then the missing permissions. */
  async turnOn(): Promise<ComputerBetaState> {
    if (!this.preferences.defaultEnabled)
      this.update({ ...this.preferences, defaultEnabled: true });
    return this.setup();
  }
  async revokeApp(key: unknown): Promise<ComputerBetaState> {
    if (typeof key !== "string" || !key || key.length > 256) throw new Error("Unknown app.");
    this.approvedApps = await removeComputerAppApproval(this.approvalsPath, key);
    this.publishState();
    return this.state();
  }
  update(raw: unknown): ComputerBetaState {
    const next = Schema.decodeUnknownSync(preferencesSchema)(raw);
    writeAtomically(this.settingsPath, JSON.stringify(next));
    if (this.preferences.defaultEnabled !== next.defaultEnabled) this.stop();
    this.preferences = next;
    this.publishState();
    return this.state();
  }
  private generation(threadId: string): string {
    return `${this.epoch}:${this.generations.get(threadId) ?? 0}:${createHash("sha256").update(threadId).digest("hex")}`;
  }
  /**
   * The intent one send carries. An explicit `/computer-use` task reports what blocks it; a
   * default (every chat) send that cannot use the computer just goes without it.
   */
  async prepare(threadId: string, explicit: boolean): Promise<ComputerTurnIntent | null> {
    if (!explicit && !this.preferences.defaultEnabled) return null;
    if (process.platform !== "darwin") {
      if (!explicit) return null;
      throw new Error("Computer Use beta is available on macOS desktop.");
    }
    await this.check();
    if (this.missingPermissions().length > 0) {
      if (!explicit) return null;
      await this.setup();
      throw new Error(
        "Complete Computer Use setup, then send your task again. Your prompt has not been sent.",
      );
    }
    if (!existsSync(this.hostOptions.binaryPath)) {
      if (!explicit) return null;
      throw new Error(
        "The Computer driver is missing. Rebuild or reinstall Ryco before sending this task.",
      );
    }
    if (this.escapeStop()) {
      await this.monitor.activate(true);
      if (!this.monitor.state.ready) {
        if (!explicit) return null;
        throw new Error(
          "The Escape listener is not ready. Check Computer Use in Settings and send again.",
        );
      }
    }
    return { mode: explicit ? "request" : "chat", generation: this.generation(threadId) };
  }
  preview(threadId: string, visible: boolean): void {
    if (visible) this.visible.add(threadId);
    else this.visible.delete(threadId);
    this.taps.setVisible(threadId, visible);
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
    this.indicator?.endAll(INDICATOR_PREFIX);
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
        const controller = new AbortController();
        this.tasks.set(key, {
          threadId,
          turnId,
          controller,
          consent: new ComputerTaskConsent(this.consentSheets.prompt, controller.signal),
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
      const reply = await task.consent.request(consentRequest(input));
      // The backend has just added an always-allowed app; settings lists it.
      if (reply.scope === "always")
        void this.refreshApprovedApps().then(
          () => this.publishState(),
          () => undefined,
        );
      return reply;
    }
    if (operation === "event") {
      const event = Schema.decodeUnknownSync(ComputerEvent)(input.event);
      this.send({ type: "event", event });
      return { visible: this.visible.has(threadId) };
    }
    if (operation === "frame") {
      if (this.visible.has(threadId)) {
        const targetId = textArg(input, "targetId");
        if (typeof input.startedAt !== "number" || input.startedAt < this.taps.changedAt(threadId))
          return { visible: true };
        const target = this.taps.target(threadId);
        if (target && targetId !== `cua:${target.pid}:${target.windowId}`)
          await this.taps.clear(threadId);
        if (this.previewTargets.get(threadId)?.targetId !== targetId)
          this.send({
            type: "target",
            threadId,
            turnId,
            targetId,
            label: targetId.startsWith("browser:") ? "Browser" : "Computer",
          });
        if (
          target?.task.turnId === turnId &&
          targetId === `cua:${target.pid}:${target.windowId}` &&
          Date.now() - this.taps.frameAt(threadId) < 1500
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
  /** One dialog on the Ryco window; the backend decides what its answer means. */
  private async showConsent(
    request: ComputerConsentRequest,
    signal: AbortSignal,
    onShown: () => void,
  ): Promise<ComputerConsentShown> {
    const owner = this.getWindow();
    if (!owner || owner.isDestroyed()) return "unavailable";
    onShown();
    const stop = this.escapeStop()
      ? "Stop in chat, the menu bar or the Escape key ends the task."
      : "Stop in chat or the menu bar ends the task.";
    if (request.kind === "clipboard") {
      const response = await dialog.showMessageBox(owner, {
        type: "question",
        title: "Allow clipboard access?",
        message: "Allow this task to access your clipboard?",
        detail: stop,
        buttons: ["Don't allow", "Allow"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal,
      });
      return response.response === 1 ? "accept" : "decline";
    }
    const { name, canAlwaysAllow } = request.app;
    const buttons = canAlwaysAllow
      ? ["Don't allow", "Allow for this chat", "Always allow"]
      : ["Don't allow", "Allow for this chat"];
    const response = await dialog.showMessageBox(owner, {
      type: "question",
      title: "Computer Use",
      message: canAlwaysAllow
        ? `Allow Ryco to use ${name}?`
        : `Allow Ryco to use ${name} in this chat?`,
      detail: canAlwaysAllow
        ? `The agent can click, type and read in ${name}. ${stop}`
        : `The agent could not name the app it wants to use. ${stop}`,
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal,
    });
    return response.response === 2 && canAlwaysAllow
      ? "always"
      : response.response === 1
        ? "accept"
        : "decline";
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

/** A build differs when the version or the executable changed (rebuild, update). */
function buildIdentity(executablePath: string, version: string): string {
  try {
    return `${version}:${Math.trunc(statSync(executablePath).mtimeMs)}`;
  } catch {
    return version;
  }
}

function writeAtomically(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, path);
}

/** The bridge's consent request: a clipboard call, or the app an action targets. */
function consentRequest(input: Record<string, unknown>): ComputerConsentRequest {
  if (input.clipboard === true) return { kind: "clipboard" };
  const app = record(input.app);
  const key = textArg(app, "key", 256);
  const name = textArg(app, "name", 256);
  if (!key || !name) throw new Error("Invalid Computer consent app.");
  return { kind: "app", app: { key, name, canAlwaysAllow: app.canAlwaysAllow === true } };
}
