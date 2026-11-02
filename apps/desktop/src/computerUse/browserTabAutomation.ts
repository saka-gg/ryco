// Dialog backstop adapted from Synara (MIT) commit 8f6521a67 dialogHandling.ts (its shim lives in browserDialogs.ts); expected-input matching from main 299fd573b browserManager.ts; the human hold is Ryco's own design. See docs/licenses/synara-computer-use.txt.
import type { WebContents } from "electron";
import type { CdpLease, CdpSend } from "../browser/cdpLease.ts";
import {
  BROWSER_PENDING_DIALOG_MESSAGE,
  type BrowserCommandScope,
  type BrowserDialogPolicy,
  type BrowserFileChooser,
  type BrowserFileChooserMode,
  type BrowserHandledDialog,
  type BrowserPendingDialog,
  type BrowserTabAutomation,
  type ExpectedAgentInput,
} from "./browser.ts";
import { BrowserTabDiagnostics, type BrowserDiagnosticsRead } from "./browserDiagnostics.ts";
import {
  DIALOG_SHIM_CLEANUP_TIMEOUT_MS,
  MAX_DIALOGS_PER_COMMAND,
  dialogShimInstall,
  normalizeDialog,
  shimDialogs,
} from "./browserDialogs.ts";

/** How long a user's input in a shown, focused tab keeps agent input out of it. */
export const BROWSER_HUMAN_HOLD_MS = 30_000;
const EXPECTED_INPUT_TTL_MS = 1_000;
// sendCommand resolves when CDP accepts the event; Electron reports it on a later main-loop turn.
const EXPECTED_INPUT_RELEASE_GRACE_MS = 100;
const EXPECTED_INPUT_TOLERANCE_PX = 1.5;
const MAX_EXPECTED_INPUTS = 64;
/**
 * Console capture stops after this long without agent use (and network capture too in the user's
 * project tabs); the next agent call turns it back on.
 */
export const DIAGNOSTICS_IDLE_QUIESCE_MS = 60_000;
/** How long a file chooser the page opened in a hidden tab waits for the agent's upload. */
export const FILE_CHOOSER_TTL_MS = 60_000;
/** Synara's network buffer limits; post data is never kept. */
const NETWORK_ENABLE = {
  maxTotalBufferSize: 1_048_576,
  maxResourceBufferSize: 262_144,
  maxPostDataSize: 0,
} as const;
/** Puts the page's own functions back, then hands over what the shim answered. */
const SHIM_FINISH = "function () { this.restore(); return this.drain(); }";
const SHIM_RESTORE = "function () { return this.restore(); }";

/** How EmbeddedComputerBrowser presents one tab and lets this page talk to its debugger as the agent. */
export interface TabPresentation {
  /** The agent opened this tab (it belongs to no project); the user's own tabs are project tabs. */
  readonly agentTab: boolean;
  /**
   * The page was created with Electron's `disableDialogs` (the agent's tabs): Electron answers every
   * alert, confirm and prompt itself at once (alert closed, confirm and prompt cancelled) and never
   * shows a box, while CDP still reports each one. Elsewhere Electron shows its native box, which
   * an answer over CDP leaves on screen.
   */
  readonly dialogsDisabled: boolean;
  /** Mounted in a visible, non-minimized panel window, or shown as a visible pop-out window. */
  presented(): boolean;
  /** presented() and that window is focused and the page itself has focus. */
  focused(): boolean;
  /** Holds the session as the agent and runs its ready steps (withAgentCdp: sign-in rules first). */
  attach(signal: AbortSignal): Promise<void>;
  /** EmbeddedComputerBrowser.send() for this tab (sign-in rules, 15 s timeout, abortable). */
  send(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

interface PendingInput {
  readonly input: ExpectedAgentInput;
  expiresAt: number;
}

interface CommandScope {
  readonly policy: BrowserDialogPolicy;
  /** The debugger session the shim handle belongs to; handles die with their session. */
  session: number;
  objectId: string | undefined;
  readonly records: BrowserHandledDialog[];
  readonly handling: Set<Promise<void>>;
  readonly onUnload: (event: Electron.Event) => void;
  /**
   * The page's dialogs are the user's again (they used the tab, or the agent's hold is ending): the
   * shim is restored, leave-page prompts go to Electron's default and the backstop answers as it
   * does between actions.
   */
  handedBack: boolean;
  ending: boolean;
}

type Emulation = { viewport?: { width: number; height: number }; colorScheme?: "dark" | "light" };

interface PendingFileChooser {
  /** Null for a picker without an input element (showOpenFilePicker): no upload can answer it. */
  readonly backendNodeId: number | null;
  readonly mode: BrowserFileChooserMode;
  readonly frameId: string;
  readonly at: number;
  reported: boolean;
}

const normalizeAutomationKey = (value: string): string =>
  value === "Space" || value === "Spacebar" || value === " " ? " " : value.toLowerCase();

function inputMatches(expected: ExpectedAgentInput, actual: ExpectedAgentInput): boolean {
  if (expected.kind === "key" && actual.kind === "key")
    return (
      normalizeAutomationKey(expected.key) === normalizeAutomationKey(actual.key) &&
      expected.alt === actual.alt &&
      expected.control === actual.control &&
      expected.meta === actual.meta &&
      expected.shift === actual.shift
    );
  if (expected.kind !== "mouse" || actual.kind !== "mouse") return false;
  return (
    expected.type === actual.type &&
    (expected.button === undefined || expected.button === actual.button) &&
    Math.abs(expected.x - actual.x) <= EXPECTED_INPUT_TOLERANCE_PX &&
    Math.abs(expected.y - actual.y) <= EXPECTED_INPUT_TOLERANCE_PX
  );
}

const ignore = () => undefined;

/**
 * One embedded page's agent automation: its CDP domains and diagnostics, JavaScript dialogs, file
 * choosers in hidden tabs, the human-input epoch and hold, and the agent's emulation overrides.
 * Created with the page and disposed with it; it talks to the debugger only through the page's
 * CdpLease.
 */
export class EmbeddedTabAutomation implements BrowserTabAutomation {
  private readonly wc: WebContents;
  private readonly cdp: CdpLease;
  private readonly presentation: TabPresentation;
  private readonly now: () => number;
  private readonly recorder: BrowserTabDiagnostics;
  private readonly unsubscribe: Array<() => void> = [];
  private epoch = 0;
  private lastHumanAt = Number.NEGATIVE_INFINITY;
  private expected: PendingInput[] = [];
  /** Bumped on every session end; work begun on an older session never touches the current one. */
  private session = 0;
  /** The ready step finished on the current session: Page, Network, Runtime and Log are enabled. */
  private captureReady = false;
  /** The idle quiesce turned console capture off (and network capture in project tabs). */
  private quiesced = false;
  private quiescing: Promise<void> = Promise.resolve();
  private activating: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private scope: CommandScope | null = null;
  private pending: BrowserPendingDialog | null = null;
  /** A pending dialog whose session ended; only the page itself can tell when it closed. */
  private carried: BrowserPendingDialog | null = null;
  private backlog: BrowserHandledDialog[] = [];
  private emulated: Emulation = {};
  /** Network.enable sent ahead of the ready step (an agent tab's first load) and its session. */
  private earlyNetwork: { readonly session: number; readonly enabled: Promise<boolean> } | null =
    null;
  /** File chooser interception as last sent on the current session; undefined before it is. */
  private interception: boolean | undefined;
  /** The newest file chooser the page opened while intercepted, until upload answers it. */
  private chooser: PendingFileChooser | null = null;
  private disposed = false;

  constructor(
    wc: WebContents,
    cdp: CdpLease,
    presentation: TabPresentation,
    now: () => number = () => performance.now(),
  ) {
    this.wc = wc;
    this.cdp = cdp;
    this.presentation = presentation;
    this.now = now;
    this.recorder = new BrowserTabDiagnostics(now);
    this.unsubscribe.push(
      cdp.onReady(this.onSessionReady),
      cdp.onEvent(this.onMessage),
      cdp.onDetach(() => this.onDetached()),
    );
    wc.on("before-input-event", this.onKey);
    wc.on("before-mouse-event", this.onMouse);
    wc.on("did-navigate", this.onDocumentGone);
    wc.on("render-process-gone", this.onDocumentGone);
  }

  get humanEpoch(): number {
    return this.epoch;
  }

  /** Remaining hold while the user works in this shown, focused page; 0 otherwise. */
  humanHoldMs(): number {
    if (!this.presentation.focused()) return 0;
    return Math.max(0, this.lastHumanAt + BROWSER_HUMAN_HOLD_MS - this.now());
  }

  /**
   * Genuine user input (or a toolbar command): the agent's refs for this tab are stale, the hold
   * starts, and dialogs are the user's again even while an agent action runs.
   */
  markHuman(): void {
    this.epoch += 1;
    this.lastHumanAt = this.now();
    if (this.scope) this.handBack(this.scope);
    // The user took the tab over: a chooser the agent's click opened is no longer its to answer, and
    // the user's own clicks open the native picker.
    this.chooser = null;
    this.syncFileChooserInterception();
  }

  /**
   * The agent's hold on this page's session is about to end (stop, an aborted or timed-out
   * command): hand the page its own dialogs back while the session that installed the shim is
   * still open. The restore is sent without waiting, so it goes out before the release detaches.
   */
  beforeAgentRelease(): void {
    if (this.scope) this.handBack(this.scope);
  }

  /**
   * An agent tab is about to load its first page on the session just opened. Its ready steps settle
   * only once the page's renderer answers, after the load has begun, so network capture is turned on
   * now: Chromium applies Network.enable in the browser process at once and reports the page's own
   * requests. The ready step waits for this command instead of sending its own.
   */
  captureFirstLoad(): void {
    if (this.disposed || !this.cdp.isAttached()) return;
    this.earlyNetwork = {
      session: this.session,
      enabled: this.cdp.send("Network.enable", NETWORK_ENABLE, { skipReady: true }).then(
        () => true,
        () => false,
      ),
    };
  }

  /** Every agent call, after the ready steps: capture back on, idle timer re-armed. */
  async activate(): Promise<void> {
    if (this.disposed) return;
    if (this.captureReady && this.quiesced) {
      this.activating ??= this.resumeCapture().finally(() => {
        this.activating = null;
      });
      await this.activating;
    }
    this.armIdleQuiesce();
    // A window can be hidden or minimized without a presentation change reaching this tab.
    this.syncFileChooserInterception();
  }

  /**
   * Opens one action's dialog scope. `maxMs` bounds how long its shim may answer dialogs: the
   * action's own budget plus slack, never the page's lifetime.
   */
  async begin(
    policy: BrowserDialogPolicy,
    signal: AbortSignal,
    maxMs: number,
  ): Promise<BrowserCommandScope> {
    if (this.pending) throw new Error(BROWSER_PENDING_DIALOG_MESSAGE);
    if (this.disposed) throw new Error("Browser tab closed.");
    const scope: CommandScope = {
      policy,
      session: this.session,
      objectId: undefined,
      records: [],
      handling: new Set(),
      onUnload: (event) => {
        const accept = policy.dialog === "accept";
        // Electron keeps the page unless the event is prevented; it never shows a dialog for it.
        if (accept) event.preventDefault();
        if (scope.records.length < MAX_DIALOGS_PER_COMMAND)
          scope.records.push({
            kind: "beforeunload",
            message: "",
            action: accept ? "accepted" : "dismissed",
            openedAt: new Date().toISOString(),
            during: "command",
          });
      },
      handedBack: false,
      ending: false,
    };
    this.scope = scope;
    const end: BrowserCommandScope = {
      end: (input) => this.endScope(scope, input?.failed === true),
    };
    // The user is working in this tab (a read such as wait still runs): their dialogs stay theirs.
    if (this.humanHoldMs() > 0) {
      scope.handedBack = true;
      return end;
    }
    this.wc.on("will-prevent-unload", scope.onUnload);
    try {
      const response = await this.presentation.send(
        "Runtime.evaluate",
        { expression: dialogShimInstall(policy, maxMs), returnByValue: false, silent: true },
        signal,
      );
      const value =
        response && typeof response === "object" ? (response as Record<string, unknown>) : {};
      const result = value.result as { objectId?: unknown } | undefined;
      // The handle belongs to the session the evaluate ran on (it may have just been opened).
      if (!value.exceptionDetails && typeof result?.objectId === "string") {
        scope.objectId = result.objectId;
        scope.session = this.session;
      }
    } catch {
      // A page that froze alert, or a document that is going away: the CDP backstop still applies.
    }
    // The user (or a stop) took the tab back while the shim went in.
    if (scope.handedBack) this.restoreShim(scope);
    return end;
  }

  pendingDialog(): BrowserPendingDialog | null {
    return this.pending;
  }

  /** The file chooser waiting in this tab for an upload without ref, if any. */
  peekFileChooser(): BrowserFileChooser | null {
    const chooser = this.liveChooser();
    return chooser && chooser.backendNodeId !== null
      ? { backendNodeId: chooser.backendNodeId, mode: chooser.mode }
      : null;
  }

  /** Returns the waiting file chooser and forgets it: only one upload can answer it. */
  takeFileChooser(): BrowserFileChooser | null {
    const chooser = this.peekFileChooser();
    this.chooser = null;
    return chooser;
  }

  /**
   * A waiting file chooser that no result has mentioned yet (once per chooser); `answerable:
   * false` for a picker an upload cannot answer, so the agent does not wait for one that works.
   */
  noteFileChooser(): { mode: BrowserFileChooserMode; answerable?: false } | null {
    const chooser = this.liveChooser();
    if (!chooser || chooser.reported) return null;
    chooser.reported = true;
    return chooser.backendNodeId === null
      ? { mode: chooser.mode, answerable: false }
      : { mode: chooser.mode };
  }

  /** Dialogs Electron answered in the agent's tab between actions (and records of failed actions). */
  takeBacklog(): BrowserHandledDialog[] {
    return this.backlog.splice(0);
  }

  expectInput(input: ExpectedAgentInput): () => void {
    const now = this.now();
    // CDP dispatches CSS pixels; Electron reports zoomed widget coordinates.
    const zoom = this.zoomFactor();
    const pending: PendingInput = {
      input: input.kind === "mouse" ? { ...input, x: input.x * zoom, y: input.y * zoom } : input,
      expiresAt: now + EXPECTED_INPUT_TTL_MS,
    };
    this.expected = [
      ...this.expected.filter((entry) => entry.expiresAt > now).slice(-(MAX_EXPECTED_INPUTS - 1)),
      pending,
    ];
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pending.expiresAt = Math.min(pending.expiresAt, this.now() + EXPECTED_INPUT_RELEASE_GRACE_MS);
    };
  }

  /** The tab's page zoom (the toolbar's): CSS pixels per device-independent pixel. */
  zoomFactor(): number {
    return this.wc.isDestroyed() ? 1 : this.wc.getZoomFactor();
  }

  networkIdle(): { idle: boolean; inFlight: number; quietMs: number } {
    // Not idle without capture on this session: nothing would report the requests.
    if (
      !this.captureReady ||
      (this.quiesced && !this.presentation.agentTab) ||
      this.wc.isDestroyed()
    )
      return { idle: false, inFlight: 0, quietMs: 0 };
    return this.recorder.networkIdle(this.wc.isLoading());
  }

  async diagnostics(
    kind: "console" | "network",
    limit: number,
    signal: AbortSignal,
  ): Promise<BrowserDiagnosticsRead> {
    // Turns quiesced console capture back on; V8 replays what the page logged meanwhile.
    await this.presentation.attach(signal);
    return this.recorder.read(kind, limit);
  }

  recordEmulation(change: {
    viewport?: { width: number; height: number } | null;
    colorScheme?: "dark" | "light" | null;
  }): void {
    const next: Emulation = { ...this.emulated };
    if (change.viewport !== undefined) {
      if (change.viewport) next.viewport = { ...change.viewport };
      else delete next.viewport;
    }
    if (change.colorScheme !== undefined) {
      if (change.colorScheme) next.colorScheme = change.colorScheme;
      else delete next.colorScheme;
    }
    this.emulated = next;
  }

  emulation(): Emulation {
    return { ...this.emulated };
  }

  /** Drops the agent's viewport and color-scheme overrides (fire-and-forget). */
  clearEmulation(): void {
    if (!this.emulated.viewport && !this.emulated.colorScheme) return;
    this.emulated = {};
    if (!this.cdp.isAttached()) return;
    void this.cdp
      .send("Emulation.clearDeviceMetricsOverride", {}, { skipReady: true })
      .catch(ignore);
    void this.cdp
      .send(
        "Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-color-scheme", value: "" }] },
        { skipReady: true },
      )
      .catch(ignore);
  }

  /** The user showed, hid or resized this tab: showing or resizing it ends the agent's emulation. */
  presentationChanged(input: { resized: boolean }): void {
    if (this.disposed) return;
    if (input.resized || this.presentation.presented()) this.clearEmulation();
    // Showing the tab gives the user the native file picker back; hiding it intercepts again.
    this.syncFileChooserInterception();
  }

  /** The session ended (last release, Electron's detach): CDP dropped its domains and overrides. */
  onDetached(): void {
    this.session += 1;
    this.captureReady = false;
    this.quiesced = false;
    this.quiescing = Promise.resolve();
    this.clearIdleTimer();
    this.emulated = {};
    this.earlyNetwork = null;
    // Interception ends with the session; an intercepted chooser cannot be answered without one.
    this.interception = undefined;
    this.chooser = null;
    this.recorder.resetSession();
    // A dialog the user still has open stays pending: Chromium does not report it to a new session.
    if (this.pending) this.watchCarried(this.pending);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe.splice(0)) off();
    this.clearIdleTimer();
    if (!this.wc.isDestroyed()) {
      this.wc.removeListener("before-input-event", this.onKey);
      this.wc.removeListener("before-mouse-event", this.onMouse);
      this.wc.removeListener("did-navigate", this.onDocumentGone);
      this.wc.removeListener("render-process-gone", this.onDocumentGone);
      if (this.scope) this.wc.removeListener("will-prevent-unload", this.scope.onUnload);
    }
    this.scope = null;
    this.pending = null;
    this.carried = null;
    this.chooser = null;
    this.backlog = [];
    this.expected = [];
    this.emulated = {};
    this.recorder.clear();
  }

  /** CdpLease ready step: once per session, whoever opened it, after groundwork's focus step. */
  private readonly onSessionReady = async (send: CdpSend): Promise<void> => {
    const session = this.session;
    const early = this.earlyNetwork?.session === session ? this.earlyNetwork : null;
    this.earlyNetwork = null;
    // Requests recorded since an early Network.enable on this session are this session's own.
    if (early) this.recorder.beforeConsoleReplay();
    else this.recorder.resetSession();
    await send("Page.enable");
    // A hidden tab cannot receive the user's clicks, so a file chooser there is the agent's: it
    // waits for an upload instead of opening a native panel on an invisible window. Shown tabs keep
    // the native picker (Chromium's default).
    const intercept = !this.presentation.presented();
    if (session === this.session) this.interception = intercept;
    await send("Page.setInterceptFileChooserDialog", { enabled: intercept }).catch(() => {
      if (session === this.session && this.interception === intercept)
        this.interception = undefined;
    });
    if (!(early && (await early.enabled))) await send("Network.enable", NETWORK_ENABLE);
    await send("Runtime.enable");
    await send("Log.enable");
    if (session !== this.session || this.disposed) return;
    // The page answered: a dialog carried over from an earlier session has closed.
    if (this.carried && this.pending === this.carried) this.pending = null;
    this.carried = null;
    this.captureReady = true;
    this.quiesced = false;
    this.armIdleQuiesce();
    // The tab may have been shown or hidden while the steps ran.
    this.syncFileChooserInterception();
  };

  /**
   * Interception follows presentation: on while the tab is hidden, off while the user can see it.
   * Sent only when the value changes, without waiting for ready steps.
   */
  private syncFileChooserInterception(): void {
    if (this.disposed || !this.captureReady || !this.cdp.isAttached()) return;
    const intercept = !this.presentation.presented();
    if (this.interception === intercept) return;
    const session = this.session;
    this.interception = intercept;
    void this.cdp
      .send("Page.setInterceptFileChooserDialog", { enabled: intercept }, { skipReady: true })
      .catch(() => {
        if (session === this.session && this.interception === intercept)
          this.interception = undefined;
      });
  }

  private liveChooser(): PendingFileChooser | null {
    if (this.chooser && this.now() - this.chooser.at > FILE_CHOOSER_TTL_MS) this.chooser = null;
    return this.chooser;
  }

  /** Page.fileChooserOpened: Chromium did not show a picker; the page waits for files. */
  private onFileChooser(params: Record<string, unknown>): void {
    const { backendNodeId } = params;
    // Chromium names the input only for <input type=file>; a picker without one
    // (showOpenFilePicker) is reported to the agent as one an upload cannot answer.
    const input =
      typeof backendNodeId === "number" && Number.isSafeInteger(backendNodeId) && backendNodeId > 0
        ? backendNodeId
        : null;
    const agentAction = this.scope !== null && !this.scope.handedBack;
    if (this.presentation.presented() && !agentAction) {
      // Interception was still on from when the tab was hidden, so the user's own click opened
      // nothing. Turn it off: their next click gets the native picker.
      this.syncFileChooserInterception();
      return;
    }
    this.chooser = {
      backendNodeId: input,
      mode: params.mode === "selectMultiple" ? "selectMultiple" : "selectSingle",
      frameId: typeof params.frameId === "string" ? params.frameId : "",
      at: this.now(),
      reported: false,
    };
  }

  private async resumeCapture(): Promise<void> {
    // A quiesce still sending its disables must finish first, or a late disable would win.
    await this.quiescing;
    const session = this.session;
    if (this.disposed || !this.captureReady || !this.quiesced) return;
    if (!this.presentation.agentTab) {
      // Requests that started while Network was off never report their end.
      this.recorder.resetSession();
      await this.cdp.send("Network.enable", NETWORK_ENABLE);
    }
    this.recorder.beforeConsoleReplay();
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("Log.enable");
    if (session === this.session && !this.disposed) this.quiesced = false;
  }

  private armIdleQuiesce(): void {
    this.clearIdleTimer();
    if (this.disposed || !this.captureReady || this.quiesced) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.quiesce();
    }, DIAGNOSTICS_IDLE_QUIESCE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /**
   * Console and log capture off until the next agent call. Agent tabs keep Network for idle
   * tracking; the user's project tabs drop it too, so their later browsing is not recorded.
   */
  private quiesce(): void {
    if (this.disposed || !this.captureReady || this.quiesced) return;
    this.quiesced = true;
    const session = this.session;
    const methods = [
      "Runtime.disable",
      "Log.disable",
      "Runtime.discardConsoleEntries",
      "Log.clear",
      ...(this.presentation.agentTab ? [] : ["Network.disable"]),
    ];
    this.quiescing = (async () => {
      // Captured entries stay readable. Discarding the page-side buffers keeps the next enable from
      // replaying them as duplicates; messages logged from now on are replayed then.
      for (const method of methods) {
        if (session !== this.session || !this.cdp.isAttached()) return;
        await this.cdp.send(method, {}, { skipReady: true }).catch(ignore);
      }
    })();
  }

  private readonly onMessage = (method: string, raw: unknown, sessionId?: string): void => {
    if (sessionId || this.disposed) return;
    const params =
      raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (method === "Page.javascriptDialogOpening") {
      this.onDialogOpening(normalizeDialog(params));
      return;
    }
    if (method === "Page.javascriptDialogClosed") {
      this.pending = null;
      return;
    }
    if (method === "Page.fileChooserOpened") {
      this.onFileChooser(params);
      return;
    }
    if (method === "Page.frameNavigated") {
      const frame = params.frame as { id?: unknown; parentId?: unknown } | undefined;
      // A new main document cannot still show the old document's dialog.
      if (frame && !frame.parentId) this.pending = null;
      // Nor wait for files in the old document's (or that frame's old) input.
      if (frame && this.chooser && (!frame.parentId || frame.id === this.chooser.frameId))
        this.chooser = null;
    }
    this.recorder.onMessage(method, params);
  };

  /** The CDP backstop: dialogs the shim could not see (frames, replaced documents, saved references). */
  private onDialogOpening(dialog: BrowserPendingDialog): void {
    // Electron answers beforeunload through will-prevent-unload, synchronously and without UI.
    if (dialog.kind === "beforeunload") return;
    const scope = this.scope && !this.scope.handedBack ? this.scope : null;
    if (this.presentation.dialogsDisabled) {
      // Electron has already answered it, without a box, whoever opened it and whether or not the
      // tab is shown: only report it, with the answer the page really got.
      const handled: BrowserHandledDialog = {
        ...dialog,
        action: dialog.kind === "alert" ? "accepted" : "dismissed",
        during: scope ? "command" : "background",
      };
      if (!scope) this.pushBacklog([handled]);
      else if (scope.records.length < MAX_DIALOGS_PER_COMMAND) scope.records.push(handled);
      return;
    }
    if (scope) {
      // Electron answers prompt() itself with null and shows nothing, so a prompt is always dismissed.
      const accept =
        dialog.kind === "alert" || (dialog.kind === "confirm" && scope.policy.dialog === "accept");
      const handling = this.answer(accept);
      scope.handling.add(handling);
      if (scope.records.length < MAX_DIALOGS_PER_COMMAND)
        scope.records.push({
          ...dialog,
          action: accept ? "accepted" : "dismissed",
          during: "command",
        });
      return;
    }
    // The user's own tabs keep their dialogs between actions, and the agent waits until they close:
    // answering one over CDP would leave Electron's native box behind.
    this.pending = dialog;
  }

  private answer(accept: boolean): Promise<void> {
    // Directly on the session: never behind the blocked command or a ready step it may never finish.
    return this.cdp
      .send(
        "Page.handleJavaScriptDialog",
        { accept },
        { skipReady: true, timeoutMs: DIALOG_SHIM_CLEANUP_TIMEOUT_MS },
      )
      .then(ignore, ignore);
  }

  private pushBacklog(records: readonly BrowserHandledDialog[]): void {
    this.backlog.push(...records);
    if (this.backlog.length > MAX_DIALOGS_PER_COMMAND)
      this.backlog.splice(0, this.backlog.length - MAX_DIALOGS_PER_COMMAND);
  }

  /** Native dialogs again for this page, at once: restore the shim and drop the unload answer. */
  private handBack(scope: CommandScope): void {
    if (scope.handedBack || scope.ending) return;
    scope.handedBack = true;
    if (!this.wc.isDestroyed()) this.wc.removeListener("will-prevent-unload", scope.onUnload);
    this.restoreShim(scope);
  }

  /**
   * Sends the shim's restore on the session that installed it, without waiting for ready steps:
   * the command goes out synchronously, before a release that follows can detach.
   */
  private restoreShim(scope: CommandScope): void {
    const objectId = scope.objectId;
    if (!objectId || this.disposed || scope.session !== this.session || !this.cdp.isAttached())
      return;
    void this.cdp
      .send(
        "Runtime.callFunctionOn",
        { objectId, functionDeclaration: SHIM_RESTORE, returnByValue: true, silent: true },
        { skipReady: true, timeoutMs: DIALOG_SHIM_CLEANUP_TIMEOUT_MS },
      )
      .catch(ignore);
  }

  private async endScope(
    scope: CommandScope,
    failed: boolean,
  ): Promise<{ dialogs: BrowserHandledDialog[] }> {
    if (scope.ending) return { dialogs: [] };
    scope.ending = true;
    // Dialogs that open while the shim is drained still belong to this action.
    const shim = await this.cleanUpShim(scope);
    if (this.scope === scope) this.scope = null;
    if (!this.wc.isDestroyed()) this.wc.removeListener("will-prevent-unload", scope.onUnload);
    await Promise.allSettled(scope.handling);
    const records = [...shim, ...scope.records].slice(0, MAX_DIALOGS_PER_COMMAND);
    if (this.disposed) return { dialogs: [] };
    if (failed) {
      // The action's error is the result; report these with the next successful command.
      this.pushBacklog(records);
      return { dialogs: [] };
    }
    return { dialogs: [...this.backlog.splice(0), ...records].slice(-MAX_DIALOGS_PER_COMMAND) };
  }

  /**
   * Restores and drains the shim in one call through its handle on the session that installed it.
   * Never through withAgentCdp: after a stop or abort that must not attach again or take the
   * agent's hold back, and a handle never outlives its session (beforeAgentRelease already restored
   * it then, and the shim expires on its own).
   */
  private async cleanUpShim(scope: CommandScope): Promise<BrowserHandledDialog[]> {
    const objectId = scope.objectId;
    const usable = () => !this.disposed && scope.session === this.session && this.cdp.isAttached();
    if (!objectId || !usable()) return [];
    const options = { skipReady: true, timeoutMs: DIALOG_SHIM_CLEANUP_TIMEOUT_MS };
    let drained: unknown;
    try {
      const response = (await this.cdp.send(
        "Runtime.callFunctionOn",
        { objectId, functionDeclaration: SHIM_FINISH, returnByValue: true, silent: true },
        options,
      )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      drained = response?.exceptionDetails ? undefined : response?.result?.value;
    } catch {
      // A navigation destroyed the document, and the shim with it.
    }
    if (usable()) void this.cdp.send("Runtime.releaseObject", { objectId }, options).catch(ignore);
    return shimDialogs(drained, scope.policy);
  }

  /**
   * Keeps refusing the agent while a dialog whose session ended may still be open, and finds out
   * without a session when it closed: a blocked page runs this no-op only after the user answered
   * (or the page went away).
   */
  private watchCarried(dialog: BrowserPendingDialog): void {
    if (this.carried === dialog) return;
    this.carried = dialog;
    const closed = () => this.clearCarried(dialog);
    try {
      if (this.wc.isDestroyed()) return closed();
      void this.wc.mainFrame.executeJavaScript("0").then(closed, closed);
    } catch {
      closed();
    }
  }

  private clearCarried(dialog: BrowserPendingDialog): void {
    if (this.carried !== dialog) return;
    this.carried = null;
    if (this.pending === dialog) this.pending = null;
  }

  /** The main document was replaced or its renderer died: no dialog of it can still be open. */
  private readonly onDocumentGone = (): void => {
    if (this.carried) this.clearCarried(this.carried);
    this.pending = null;
    this.chooser = null;
  };

  /** Input reaching the page: no dialog blocks it, so a carried one has closed. */
  private onPageInput(): void {
    if (this.carried) this.clearCarried(this.carried);
    this.markHuman();
  }

  private consumeExpected(actual: ExpectedAgentInput): boolean {
    const now = this.now();
    const pending = this.expected.filter((entry) => entry.expiresAt > now);
    const index = pending.findIndex((entry) => inputMatches(entry.input, actual));
    if (index >= 0) pending.splice(index, 1);
    this.expected = pending;
    return index >= 0;
  }

  private readonly onKey = (_event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== "keyDown" && input.type !== "rawKeyDown") return;
    // A hidden host cannot receive the user's input: everything there is the agent's.
    if (this.disposed || !this.presentation.presented()) return;
    if (
      this.consumeExpected({
        kind: "key",
        key: input.key,
        alt: input.alt === true,
        control: input.control === true,
        meta: input.meta === true,
        shift: input.shift === true,
      })
    )
      return;
    this.onPageInput();
  };

  private readonly onMouse = (_event: Electron.Event, input: Electron.MouseInputEvent): void => {
    if (input.type !== "mouseDown" && input.type !== "mouseWheel" && input.type !== "contextMenu")
      return;
    if (this.disposed || !this.presentation.presented()) return;
    if (
      this.consumeExpected({
        kind: "mouse",
        type: input.type,
        x: input.x,
        y: input.y,
        ...(input.button === undefined ? {} : { button: input.button }),
      })
    )
      return;
    this.onPageInput();
  };
}
