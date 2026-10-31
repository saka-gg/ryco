import type { WebContents } from "electron";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CdpLease } from "../browser/cdpLease.ts";
import { FakeWebContents, fakeEvent } from "./embeddedBrowser.fixtures.ts";
import {
  BROWSER_HUMAN_HOLD_MS,
  DIAGNOSTICS_IDLE_QUIESCE_MS,
  EmbeddedTabAutomation,
  FILE_CHOOSER_TTL_MS,
  type TabPresentation,
} from "./browserTabAutomation.ts";
import {
  DIALOG_SHIM_MAX_MS,
  MAX_DIALOGS_PER_COMMAND,
  dialogShimFinish,
  dialogShimInstall,
  normalizeDialog,
} from "./browserDialogs.ts";
import { DIAGNOSTICS_OUTPUT_MAX_BYTES } from "./browserDiagnostics.ts";

/** This unit's ready step; browser-agent-upload's file chooser interception follows Page.enable. */
const READY = [
  "Page.enable",
  "Page.setInterceptFileChooserDialog",
  "Network.enable",
  "Runtime.enable",
  "Log.enable",
];
const FINISH = "function () { this.restore(); return this.drain(); }";
const RESTORE = "function () { return this.restore(); }";
/** The shim budget the driver gives an input action. */
const SCOPE_MS = 15_000;
const signal = () => new AbortController().signal;
/** Lets queued microtasks (the fake's command responses) run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const automations: EmbeddedTabAutomation[] = [];
afterEach(() => {
  for (const automation of automations.splice(0)) automation.dispose();
  vi.useRealTimers();
});

function setup(options: { agentTab?: boolean } = {}) {
  const agentTab = options.agentTab ?? true;
  let time = 10_000;
  const wc = new FakeWebContents();
  const cdp = new CdpLease(wc as unknown as WebContents);
  const view = { presented: false, focused: false };
  // Like EmbeddedComputerBrowser: agent calls hold the session as "agent" and wait for its ready steps.
  const presentation = {
    agentTab,
    // Like createPage: only the agent's tabs are created with disableDialogs.
    dialogsDisabled: agentTab,
    presented: vi.fn(() => view.presented),
    focused: vi.fn(() => view.presented && view.focused),
    attach: vi.fn(async (_signal: AbortSignal) => {
      cdp.acquire("agent");
      await cdp.ready();
    }),
    send: vi.fn(async (method: string, params: Record<string, unknown>, _signal: AbortSignal) => {
      cdp.acquire("agent");
      return cdp.send(method, params);
    }),
  } satisfies TabPresentation;
  const automation = new EmbeddedTabAutomation(
    wc as unknown as WebContents,
    cdp,
    presentation,
    () => time,
  );
  automations.push(automation);
  const methods = () => wc.debugger.commands.map(({ method }) => method);
  return {
    wc,
    cdp,
    view,
    presentation,
    automation,
    methods,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** A fake page whose shim install returns a handle and whose drain returns `drained`. */
function withShim(wc: FakeWebContents, drained: unknown[] = []) {
  wc.debugger.respond = (method, params) => {
    const call = params as { functionDeclaration?: string };
    if (method === "Runtime.evaluate") return { result: { type: "object", objectId: "shim-1" } };
    if (method === "Runtime.callFunctionOn" && call.functionDeclaration === FINISH)
      return { result: { value: drained } };
    if (method === "Runtime.callFunctionOn") return { result: { value: true } };
    return {};
  };
}

describe("session ready step", () => {
  it("enables Page, Network, Runtime and Log once per session, whoever opened it", async () => {
    const { cdp, wc, automation, methods } = setup();
    expect(automation.networkIdle().idle).toBe(false);
    cdp.acquire("agent");
    await cdp.send("Page.getFrameTree");
    await cdp.send("Runtime.evaluate", { expression: "1" });
    expect(methods()).toEqual([...READY, "Page.getFrameTree", "Runtime.evaluate"]);
    expect(wc.debugger.commands[2]).toEqual({
      method: "Network.enable",
      params: { maxTotalBufferSize: 1_048_576, maxResourceBufferSize: 262_144, maxPostDataSize: 0 },
    });
    expect(methods()).not.toContain("Emulation.setFocusEmulationEnabled");
    // The last release ends the session; a picker-opened session gets the steps too.
    cdp.release("agent");
    expect(wc.debugger.isAttached()).toBe(false);
    cdp.acquire("picker");
    await cdp.send("DOM.enable");
    expect(methods().slice(-READY.length - 1)).toEqual([...READY, "DOM.enable"]);
    // Electron's own detach resets the capture state; the next session enables again.
    wc.debugger.externalDetach();
    expect(automation.networkIdle()).toEqual({ idle: false, inFlight: 0, quietMs: 0 });
    cdp.acquire("agent");
    await cdp.ready();
    expect(methods().slice(-READY.length)).toEqual(READY);
  });

  it("turns network capture on before an agent tab's first load and keeps what it recorded", async () => {
    const { cdp, wc, automation, methods } = setup();
    // Not attached yet: nothing to send.
    automation.captureFirstLoad();
    expect(methods()).toEqual([]);
    cdp.acquire("agent");
    automation.captureFirstLoad();
    expect(wc.debugger.commands).toEqual([
      {
        method: "Network.enable",
        params: {
          maxTotalBufferSize: 1_048_576,
          maxResourceBufferSize: 262_144,
          maxPostDataSize: 0,
        },
      },
    ]);
    // The document request Chromium reports before the ready step runs.
    wc.debugger.message("Network.requestWillBeSent", {
      requestId: "doc",
      loaderId: "L1",
      type: "Document",
      request: { url: "https://app.test/", method: "GET" },
    });
    wc.debugger.message("Network.responseReceived", {
      requestId: "doc",
      response: { url: "https://app.test/", status: 200, mimeType: "text/html" },
    });
    await cdp.ready();
    // The ready step waited for the early Network.enable instead of sending its own.
    expect(methods()).toEqual([
      "Network.enable",
      "Page.enable",
      "Page.setInterceptFileChooserDialog",
      "Runtime.enable",
      "Log.enable",
    ]);
    const read = await automation.diagnostics("network", 10, signal());
    expect(read.entries).toEqual([
      expect.objectContaining({ phase: "request", url: "https://app.test/", method: "GET" }),
      expect.objectContaining({ phase: "response", url: "https://app.test/", status: 200 }),
    ]);
    expect(automation.networkIdle().inFlight).toBe(1);
    // The next session has no early enable: the ready step sends Network.enable itself.
    cdp.release("agent");
    cdp.acquire("agent");
    await cdp.ready();
    expect(methods().slice(-READY.length)).toEqual(READY);
  });

  it("enables Network in the ready step when the early enable failed or belongs to an old session", async () => {
    const { cdp, wc, automation, methods } = setup();
    let networkEnables = 0;
    wc.debugger.respond = (method) => {
      if (method === "Network.enable" && ++networkEnables === 1) throw new Error("no target");
      return {};
    };
    cdp.acquire("agent");
    automation.captureFirstLoad();
    await cdp.ready();
    expect(methods()).toEqual(["Network.enable", ...READY]);
    wc.debugger.respond = () => ({});
    automation.captureFirstLoad();
    // Electron ended that session before its ready step ran.
    wc.debugger.externalDetach();
    cdp.acquire("agent");
    await cdp.ready();
    expect(methods().slice(-READY.length)).toEqual(READY);
  });

  it("tracks network idle only once the session is ready", async () => {
    const { cdp, wc, automation, advance } = setup();
    cdp.acquire("agent");
    await cdp.ready();
    advance(500);
    expect(automation.networkIdle().idle).toBe(true);
    wc.loading = true;
    expect(automation.networkIdle().idle).toBe(false);
    wc.loading = false;
    wc.debugger.message("Network.requestWillBeSent", {
      requestId: "1",
      request: { url: "https://app.test/slow", method: "GET" },
    });
    // Child-target events are ignored.
    wc.debugger.message("Network.loadingFinished", { requestId: "1" }, "child-session");
    advance(1_000);
    expect(automation.networkIdle()).toEqual({ idle: false, inFlight: 1, quietMs: 1_000 });
    wc.debugger.message("Network.loadingFinished", { requestId: "1" });
    advance(500);
    expect(automation.networkIdle().idle).toBe(true);
  });

  it("reads diagnostics through the presentation's attach", async () => {
    const { wc, presentation, automation } = setup();
    const read = automation.diagnostics("console", 10, signal());
    await read;
    expect(presentation.attach).toHaveBeenCalledTimes(1);
    wc.debugger.message("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ type: "string", value: "fixture-error" }],
    });
    await expect(automation.diagnostics("console", 10, signal())).resolves.toEqual(
      expect.objectContaining({
        entries: [expect.objectContaining({ level: "error", text: "fixture-error" })],
      }),
    );
  });
});

describe("dialog shim", () => {
  it("installs a closure-held shim in the main world for the action and drains, restores and releases it", async () => {
    const { wc, cdp, presentation, automation, methods } = setup();
    const long = "é".repeat(2_600); // 5 200 bytes
    withShim(
      wc,
      Array.from({ length: 25 }, (_, index) => ({
        kind: index === 0 ? "confirm" : "alert",
        message: index === 0 ? long : `alert ${index}`,
        action: "accepted", // Page data: never trusted for the action.
        openedAt: "2026-10-24T10:00:00.000Z",
      })),
    );
    cdp.acquire("agent");
    const scope = await automation.begin(
      { dialog: "dismiss", promptText: "ignored" },
      signal(),
      SCOPE_MS,
    );
    expect(presentation.send).toHaveBeenCalledTimes(1);
    const [method, params] = presentation.send.mock.calls[0]!;
    expect(method).toBe("Runtime.evaluate");
    expect(params).toEqual({
      expression: expect.any(String),
      returnByValue: false,
      silent: true,
    });
    expect(params).not.toHaveProperty("contextId");
    const expression = String(params.expression);
    // The shim answers only for the action's budget.
    expect(expression).toContain(
      JSON.stringify({ accept: false, promptText: "ignored", maxMs: SCOPE_MS }),
    );
    expect(expression).not.toContain("window[");
    const { dialogs } = await scope.end();
    // One call restores and drains (nothing can land in between); the handle's release is not awaited.
    expect(methods().slice(-3)).toEqual([
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
    ]);
    const calls = wc.debugger.commands.slice(-2).map(({ params }) => params);
    expect(calls).toEqual([
      { objectId: "shim-1", functionDeclaration: FINISH, returnByValue: true, silent: true },
      { objectId: "shim-1" },
    ]);
    expect(dialogs).toHaveLength(20);
    expect(dialogs[0]).toEqual({
      kind: "confirm",
      // Cut to 1 KiB: two bytes per "é".
      message: "é".repeat(512),
      action: "dismissed",
      openedAt: "2026-10-24T10:00:00.000Z",
      during: "command",
    });
    expect(Buffer.byteLength(dialogs[0]!.message, "utf8")).toBe(1_024);
    expect(dialogs[1]).toEqual(expect.objectContaining({ kind: "alert", action: "accepted" }));
  });

  it("still gives a working scope when the install or the drain fails", async () => {
    const { wc, cdp, automation, methods } = setup();
    wc.debugger.respond = (method) => {
      if (method === "Runtime.evaluate") throw new Error("Object is frozen");
      return {};
    };
    cdp.acquire("agent");
    const scope = await automation.begin({}, signal(), SCOPE_MS);
    await expect(scope.end()).resolves.toEqual({ dialogs: [] });
    expect(methods()).not.toContain("Runtime.callFunctionOn");
    // The document went away during the action: drain and restore fail, the scope still ends.
    withShim(wc);
    const base = wc.debugger.respond;
    wc.debugger.respond = (method, params) => {
      if (method === "Runtime.callFunctionOn") throw new Error("Cannot find context");
      return base(method, params);
    };
    const second = await automation.begin({}, signal(), SCOPE_MS);
    wc.debugger.message("Page.javascriptDialogOpening", { type: "alert", message: "late" });
    await expect(second.end()).resolves.toEqual({
      dialogs: [expect.objectContaining({ kind: "alert", message: "late", action: "accepted" })],
    });
  });

  it("never attaches again to clean up after the session ended", async () => {
    const { wc, cdp, presentation, automation, methods } = setup();
    withShim(wc);
    cdp.acquire("agent");
    const scope = await automation.begin({}, signal(), SCOPE_MS);
    cdp.release("agent"); // Stop or abort while the action ran.
    const count = wc.debugger.commands.length;
    await expect(scope.end({ failed: true })).resolves.toEqual({ dialogs: [] });
    expect(wc.debugger.attach).toHaveBeenCalledTimes(1);
    expect(wc.debugger.commands).toHaveLength(count);
    expect(presentation.send).toHaveBeenCalledTimes(1);
    expect(methods()).not.toContain("Runtime.releaseObject");
  });

  it("answers alert, confirm and prompt per policy in a page, and restores only its own functions", () => {
    let now = 1_000;
    class PageDate extends Date {
      static override now() {
        return now;
      }
    }
    const native = { alert: vi.fn(), confirm: vi.fn(() => true), prompt: vi.fn(() => "native") };
    const page: Record<string, unknown> = { ...native };
    const install = (policy: Parameters<typeof dialogShimInstall>[0], maxMs = SCOPE_MS) =>
      runInNewContext(dialogShimInstall(policy, maxMs), { window: page, Date: PageDate }) as {
        drain(): unknown[];
        restore(): boolean;
      };

    const dismiss = install({});
    const call = (name: string, ...args: unknown[]) =>
      (page[name] as (...a: unknown[]) => unknown)(...args);
    expect(call("alert", "hello")).toBeUndefined();
    expect(call("confirm", "sure?")).toBe(false);
    expect(call("prompt", "name?", "Ada")).toBeNull();
    expect(native.alert).not.toHaveBeenCalled();
    expect(dismiss.drain()).toEqual([
      expect.objectContaining({ kind: "alert", message: "hello" }),
      expect.objectContaining({ kind: "confirm", message: "sure?" }),
      expect.objectContaining({ kind: "prompt", message: "name?", defaultPrompt: "Ada" }),
    ]);
    expect(dismiss.drain()).toEqual([]);
    dismiss.restore();
    expect(page.alert).toBe(native.alert);
    expect(page.confirm).toBe(native.confirm);

    const accept = install({ dialog: "accept", promptText: "Grace" });
    expect(call("confirm", "sure?")).toBe(true);
    expect(call("prompt", "name?", "Ada")).toBe("Grace");
    const acceptDefault = install({ dialog: "accept" });
    expect(call("prompt", "name?", "Ada")).toBe("Ada");
    acceptDefault.restore();
    // The page replaced alert meanwhile: restore() leaves the page's own function alone.
    const pageAlert = vi.fn();
    page.alert = pageAlert;
    accept.restore();
    expect(page.alert).toBe(pageAlert);
    expect(page.confirm).toBe(native.confirm);
    expect(page.prompt).toBe(native.prompt);

    // A shim whose cleanup never ran hands every call back to the page once the action's budget
    // is over.
    page.alert = native.alert;
    const forgotten = install({ dialog: "accept" });
    for (let index = 0; index < 30; index += 1) call("alert", index);
    expect(forgotten.drain()).toHaveLength(20);
    now += SCOPE_MS - 1;
    expect(call("confirm", "late")).toBe(true);
    expect(native.confirm).not.toHaveBeenCalled();
    now += 1;
    native.confirm.mockReturnValueOnce(false);
    expect(call("confirm", "after")).toBe(false);
    call("alert", "after");
    expect(native.alert).toHaveBeenCalledWith("after");
    expect(forgotten.drain()).toEqual([expect.objectContaining({ message: "late" })]);
    forgotten.restore();
    // Budgets are bounded: at least 1 s, never longer than a desktop request.
    expect(dialogShimInstall({}, 10 * 60_000)).toContain(`"maxMs":${DIALOG_SHIM_MAX_MS}`);
    expect(dialogShimInstall({}, 0)).toContain('"maxMs":1000');
  });

  it("keeps a paired browser's handle only under its one-off key, which finishing removes", () => {
    const native = { alert: vi.fn(), confirm: vi.fn(() => true), prompt: vi.fn(() => "native") };
    const page: Record<string, unknown> = { ...native };
    const run = (expression: string) => runInNewContext(expression, { window: page, Date });
    const key = "__rycoDialogsabc";
    run(`${dialogShimInstall({ dialog: "accept" }, SCOPE_MS, key)}, true`);
    // Not enumerable: the page's own scans of window do not list it.
    expect(Object.keys(page)).toEqual(["alert", "confirm", "prompt"]);
    expect((page.confirm as (message: string) => unknown)("sure?")).toBe(true);
    expect(native.confirm).not.toHaveBeenCalled();
    expect(run(dialogShimFinish(key))).toEqual([
      expect.objectContaining({ kind: "confirm", message: "sure?" }),
    ]);
    expect(key in page).toBe(false);
    expect(page.confirm).toBe(native.confirm);
    // Finishing twice (or after a navigation) drains nothing.
    expect(run(dialogShimFinish(key))).toEqual([]);
    expect(dialogShimInstall({}, SCOPE_MS)).not.toContain("defineProperty");
  });

  it("hands the page its dialogs back before the agent's hold ends", async () => {
    const { wc, cdp, automation, methods } = setup();
    withShim(wc);
    cdp.acquire("agent");
    const scope = await automation.begin({ dialog: "accept" }, signal(), SCOPE_MS);
    expect(wc.listenerCount("will-prevent-unload")).toBe(1);
    // Stop, an abort or a timed-out command: what EmbeddedComputerBrowser does before release().
    automation.beforeAgentRelease();
    cdp.release("agent");
    expect(wc.debugger.isAttached()).toBe(false);
    // The restore went out on the session that installed the shim, before the detach.
    const restore = wc.debugger.commands.at(-1);
    expect(restore).toEqual({
      method: "Runtime.callFunctionOn",
      params: {
        objectId: "shim-1",
        functionDeclaration: RESTORE,
        returnByValue: true,
        silent: true,
      },
    });
    expect(wc.debugger.sendCommand.mock.invocationCallOrder.at(-1)).toBeLessThan(
      wc.debugger.detach.mock.invocationCallOrder.at(-1) ?? 0,
    );
    // Leave-page prompts are Electron's again.
    expect(wc.listenerCount("will-prevent-unload")).toBe(0);
    const count = methods().length;
    await expect(scope.end({ failed: true })).resolves.toEqual({ dialogs: [] });
    expect(methods()).toHaveLength(count);
    // Nothing to hand back between actions.
    expect(() => automation.beforeAgentRelease()).not.toThrow();
  });
});

describe("dialog records", () => {
  it("keep a result's page-chosen dialog text within the diagnostics cap", () => {
    const noisy = "\u0001".repeat(8_192);
    const dialogs = Array.from({ length: MAX_DIALOGS_PER_COMMAND }, () =>
      normalizeDialog({ type: "prompt", message: noisy, defaultPrompt: noisy }),
    );
    expect(dialogs[0]?.message).not.toContain("\u0001");
    expect(Buffer.byteLength(JSON.stringify({ dialogs }), "utf8")).toBeLessThanOrEqual(
      DIAGNOSTICS_OUTPUT_MAX_BYTES,
    );
    // Line breaks stay readable.
    expect(normalizeDialog({ message: "Leave?\nUnsaved changes" }).message).toBe(
      "Leave?\nUnsaved changes",
    );
  });
});

describe("dialog backstop", () => {
  it("answers dialogs an action opens in the user's tab: alerts accepted, confirm per policy, at most 20 recorded", async () => {
    const { wc, cdp, automation } = setup({ agentTab: false });
    wc.debugger.respond = (method) =>
      method === "Runtime.evaluate" ? { exceptionDetails: { text: "frozen" } } : {};
    cdp.acquire("agent");
    const scope = await automation.begin({}, signal(), SCOPE_MS);
    wc.debugger.message("Page.javascriptDialogOpening", { type: "alert", message: "hi" });
    wc.debugger.message("Page.javascriptDialogOpening", { type: "confirm", message: "sure?" });
    wc.debugger.message("Page.javascriptDialogOpening", {
      type: "prompt",
      message: "name?",
      defaultPrompt: "Ada",
    });
    const { dialogs } = await scope.end();
    expect(dialogs).toEqual([
      expect.objectContaining({
        kind: "alert",
        message: "hi",
        action: "accepted",
        during: "command",
      }),
      expect.objectContaining({ kind: "confirm", action: "dismissed" }),
      expect.objectContaining({ kind: "prompt", defaultPrompt: "Ada", action: "dismissed" }),
    ]);
    const answers = wc.debugger.commands
      .filter(({ method }) => method === "Page.handleJavaScriptDialog")
      .map(({ params }) => params);
    expect(answers).toEqual([{ accept: true }, { accept: false }, { accept: false }]);

    const accepting = await automation.begin(
      { dialog: "accept", promptText: "Grace" },
      signal(),
      SCOPE_MS,
    );
    for (let index = 0; index < 25; index += 1)
      wc.debugger.message("Page.javascriptDialogOpening", {
        type: "confirm",
        message: `c${index}`,
      });
    const accepted = await accepting.end();
    expect(accepted.dialogs).toHaveLength(20);
    expect(accepted.dialogs.every(({ action }) => action === "accepted")).toBe(true);
    const handled = wc.debugger.commands.filter(
      ({ method }) => method === "Page.handleJavaScriptDialog",
    );
    expect(handled).toHaveLength(28);
    expect(handled.at(-1)?.params).toEqual({ accept: true });
  });

  it("reports the dialogs Electron answered in the agent's tab, shown or hidden, and never answers them over CDP", async () => {
    const { wc, cdp, view, automation } = setup();
    cdp.acquire("agent");
    await cdp.ready();
    // Between actions, hidden and then shown in the panel: no box, nothing pending, all reported.
    wc.debugger.message("Page.javascriptDialogOpening", { type: "confirm", message: "leave?" });
    view.presented = true;
    wc.debugger.message("Page.javascriptDialogOpening", { type: "alert", message: "shown" });
    await flush();
    expect(automation.pendingDialog()).toBeNull();
    expect(automation.takeBacklog()).toEqual([
      expect.objectContaining({ kind: "confirm", action: "dismissed", during: "background" }),
      expect.objectContaining({ kind: "alert", action: "accepted", during: "background" }),
    ]);
    expect(automation.takeBacklog()).toEqual([]);
    // During an action the record carries the answer the page really got: Electron cancelled the
    // confirm, whatever the action's policy says, and a scope reports the backlog too.
    wc.debugger.message("Page.javascriptDialogOpening", { type: "alert", message: "timer" });
    const scope = await automation.begin({ dialog: "accept" }, signal(), SCOPE_MS);
    wc.debugger.message("Page.javascriptDialogOpening", { type: "confirm", message: "frame" });
    wc.debugger.message("Page.javascriptDialogOpening", { type: "prompt", message: "name?" });
    expect((await scope.end()).dialogs).toEqual([
      expect.objectContaining({ kind: "alert", message: "timer", during: "background" }),
      expect.objectContaining({ kind: "confirm", action: "dismissed", during: "command" }),
      expect.objectContaining({ kind: "prompt", action: "dismissed", during: "command" }),
    ]);
    expect(wc.debugger.commands.map(({ method }) => method)).not.toContain(
      "Page.handleJavaScriptDialog",
    );
    // The user working in it does not change that: the page never waits for an answer.
    view.focused = true;
    automation.markHuman();
    const held = await automation.begin({}, signal(), SCOPE_MS);
    wc.debugger.message("Page.javascriptDialogOpening", { type: "confirm", message: "theirs" });
    expect(automation.pendingDialog()).toBeNull();
    expect((await held.end()).dialogs).toEqual([
      expect.objectContaining({ message: "theirs", action: "dismissed", during: "background" }),
    ]);
  });

  it("leaves a dialog in the user's tab to the user and refuses new scopes until it closes", async () => {
    const { wc, cdp, view, automation } = setup({ agentTab: false });
    cdp.acquire("agent");
    await cdp.ready();
    view.presented = true;
    wc.debugger.message("Page.javascriptDialogOpening", { type: "alert", message: "for you" });
    await flush();
    expect(wc.debugger.commands.map(({ method }) => method)).not.toContain(
      "Page.handleJavaScriptDialog",
    );
    expect(automation.pendingDialog()).toEqual(
      expect.objectContaining({ kind: "alert", message: "for you" }),
    );
    await expect(automation.begin({}, signal(), SCOPE_MS)).rejects.toThrow("waiting for the user");
    wc.debugger.message("Page.javascriptDialogClosed", { result: true });
    expect(automation.pendingDialog()).toBeNull();
    // A new main document cannot still show it either.
    wc.debugger.message("Page.javascriptDialogOpening", { type: "confirm", message: "again" });
    wc.debugger.message("Page.frameNavigated", { frame: { id: "main", loaderId: "l2" } });
    expect(automation.pendingDialog()).toBeNull();
  });

  it("leaves dialogs in the user's own tabs to the user between actions, even hidden ones", async () => {
    const { wc, cdp, automation } = setup({ agentTab: false });
    cdp.acquire("agent");
    await cdp.ready();
    wc.debugger.message("Page.javascriptDialogOpening", { type: "confirm", message: "stay?" });
    await flush();
    expect(wc.debugger.commands.map(({ method }) => method)).not.toContain(
      "Page.handleJavaScriptDialog",
    );
    expect(automation.takeBacklog()).toEqual([]);
    expect(automation.pendingDialog()).toEqual(expect.objectContaining({ message: "stay?" }));
    // The agent's own actions there are still answered.
    wc.debugger.message("Page.javascriptDialogClosed", { result: false });
    const scope = await automation.begin({}, signal(), SCOPE_MS);
    wc.debugger.message("Page.javascriptDialogOpening", { type: "alert", message: "agent's" });
    expect((await scope.end()).dialogs).toEqual([
      expect.objectContaining({ message: "agent's", action: "accepted", during: "command" }),
    ]);
  });

  it("keeps a dialog the user still has open pending after the session ends", async () => {
    const { wc, cdp, view, automation } = setup({ agentTab: false });
    let unblock!: () => void;
    wc.mainFrameExecuteJavaScript.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          unblock = () => resolve(0);
        }),
    );
    cdp.acquire("agent");
    await cdp.ready();
    view.presented = true;
    wc.debugger.message("Page.javascriptDialogOpening", { type: "confirm", message: "yours" });
    // A stop or a timed-out command ends the session; Chromium never reports the dialog again.
    cdp.release("agent");
    expect(automation.pendingDialog()).toEqual(expect.objectContaining({ message: "yours" }));
    // The blocked page runs the probe only once the user answered.
    expect(wc.mainFrameExecuteJavaScript).toHaveBeenCalledWith("0");
    unblock();
    await flush();
    expect(automation.pendingDialog()).toBeNull();

    // Without an answer from the probe: a new document, the user's input in the page, or a
    // session that becomes ready all show the dialog is gone.
    wc.mainFrameExecuteJavaScript.mockImplementation(() => new Promise<unknown>(() => undefined));
    const reopen = async () => {
      cdp.acquire("agent");
      await cdp.ready();
      wc.debugger.message("Page.javascriptDialogOpening", { type: "alert", message: "again" });
      cdp.release("agent");
      expect(automation.pendingDialog()).not.toBeNull();
    };
    await reopen();
    wc.emit("did-navigate", fakeEvent(), "https://app.test/next");
    expect(automation.pendingDialog()).toBeNull();
    await reopen();
    wc.emit("before-mouse-event", fakeEvent(), { type: "mouseDown", x: 1, y: 1, button: "left" });
    expect(automation.pendingDialog()).toBeNull();
    await reopen();
    cdp.acquire("picker");
    await cdp.ready();
    expect(automation.pendingDialog()).toBeNull();
    cdp.release("picker");
  });

  it("ignores beforeunload over CDP; Electron's will-prevent-unload answers it", async () => {
    const { wc, cdp, automation } = setup();
    cdp.acquire("agent");
    const scope = await automation.begin({}, signal(), SCOPE_MS);
    wc.debugger.message("Page.javascriptDialogOpening", { type: "beforeunload", message: "" });
    const stay = fakeEvent();
    wc.emit("will-prevent-unload", stay);
    expect(stay.defaultPrevented).toBe(false);
    expect((await scope.end()).dialogs).toEqual([
      expect.objectContaining({ kind: "beforeunload", action: "dismissed", during: "command" }),
    ]);
    expect(wc.listenerCount("will-prevent-unload")).toBe(0);
    expect(wc.debugger.commands.map(({ method }) => method)).not.toContain(
      "Page.handleJavaScriptDialog",
    );

    const leaving = await automation.begin({ dialog: "accept" }, signal(), SCOPE_MS);
    const leave = fakeEvent();
    wc.emit("will-prevent-unload", leave);
    expect(leave.defaultPrevented).toBe(true);
    expect((await leaving.end()).dialogs).toEqual([
      expect.objectContaining({ kind: "beforeunload", action: "accepted" }),
    ]);
    expect(wc.listenerCount("will-prevent-unload")).toBe(0);
    // Outside a scope Ryco adds no listener: Electron keeps the page.
    automation.takeBacklog();
    expect(wc.listenerCount("will-prevent-unload")).toBe(0);
  });

  it("moves a failed action's dialogs into the backlog for the next successful command", async () => {
    const { wc, cdp, automation } = setup();
    cdp.acquire("agent");
    const failed = await automation.begin({}, signal(), SCOPE_MS);
    wc.debugger.message("Page.javascriptDialogOpening", {
      type: "alert",
      message: "during failure",
    });
    await expect(failed.end({ failed: true })).resolves.toEqual({ dialogs: [] });
    expect(automation.takeBacklog()).toEqual([
      expect.objectContaining({ message: "during failure", during: "command" }),
    ]);
  });

  it("sends dialog answers and emulation clears without waiting for ready steps", async () => {
    const { wc, cdp, automation } = setup({ agentTab: false });
    let finishNetwork!: () => void;
    wc.debugger.respond = (method) =>
      method === "Network.enable"
        ? new Promise<object>((resolve) => {
            finishNetwork = () => resolve({});
          })
        : {};
    cdp.acquire("agent");
    const ready = cdp.ready();
    await flush();
    expect(wc.debugger.commands.map(({ method }) => method)).toEqual([
      "Page.enable",
      "Page.setInterceptFileChooserDialog",
      "Network.enable",
    ]);
    // The action's shim install waits for the ready steps; its backstop does not.
    const begun = automation.begin({}, signal(), SCOPE_MS);
    wc.debugger.message("Page.javascriptDialogOpening", { type: "alert", message: "blocked" });
    automation.recordEmulation({ viewport: { width: 390, height: 844 } });
    automation.clearEmulation();
    await flush();
    expect(wc.debugger.commands.map(({ method }) => method)).toEqual([
      "Page.enable",
      "Page.setInterceptFileChooserDialog",
      "Network.enable",
      "Page.handleJavaScriptDialog",
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setEmulatedMedia",
    ]);
    finishNetwork();
    await ready;
    expect((await (await begun).end()).dialogs).toEqual([
      expect.objectContaining({ message: "blocked", action: "accepted" }),
    ]);
  });
});

describe("human input", () => {
  it("counts the user's input in a shown tab and ignores the agent's expected input", () => {
    const { wc, view, automation, advance } = setup();
    const mouse = (input: Record<string, unknown>) =>
      wc.emit("before-mouse-event", fakeEvent(), input);
    const key = (input: Record<string, unknown>) =>
      wc.emit("before-input-event", fakeEvent(), {
        alt: false,
        control: false,
        meta: false,
        shift: false,
        ...input,
      });
    // A hidden host cannot receive the user's input.
    mouse({ type: "mouseDown", x: 10, y: 10, button: "left" });
    expect(automation.humanEpoch).toBe(0);
    view.presented = true;
    mouse({ type: "mouseMove", x: 10, y: 10 });
    mouse({ type: "mouseUp", x: 10, y: 10, button: "left" });
    expect(automation.humanEpoch).toBe(0);
    mouse({ type: "mouseDown", x: 10, y: 10, button: "left" });
    expect(automation.humanEpoch).toBe(1);
    key({ type: "keyDown", key: "a" });
    key({ type: "rawKeyDown", key: "b" });
    key({ type: "keyUp", key: "a" });
    expect(automation.humanEpoch).toBe(3);

    // CDP dispatches CSS pixels; Electron reports zoomed widget coordinates.
    wc.zoom = 1.25;
    const release = automation.expectInput({
      kind: "mouse",
      type: "mouseDown",
      x: 100,
      y: 40,
      button: "left",
    });
    mouse({ type: "mouseDown", x: 126.4, y: 48.6, button: "left" });
    expect(automation.humanEpoch).toBe(3);
    release();
    // Consumed once: the same event again is the user's.
    mouse({ type: "mouseDown", x: 125, y: 50, button: "left" });
    expect(automation.humanEpoch).toBe(4);
    // Beyond the 1.5 px tolerance.
    automation.expectInput({ kind: "mouse", type: "mouseWheel", x: 100, y: 40 });
    mouse({ type: "mouseWheel", x: 127, y: 50 });
    expect(automation.humanEpoch).toBe(5);
    // Released inputs stay expected for 100 ms only.
    const late = automation.expectInput({
      kind: "key",
      key: "Enter",
      alt: false,
      control: false,
      meta: false,
      shift: false,
    });
    late();
    advance(150);
    key({ type: "rawKeyDown", key: "Enter" });
    expect(automation.humanEpoch).toBe(6);
    const space = automation.expectInput({
      kind: "key",
      key: "Space",
      alt: false,
      control: false,
      meta: false,
      shift: false,
    });
    key({ type: "keyDown", key: " " });
    space();
    expect(automation.humanEpoch).toBe(6);
  });

  it("gives dialogs back to the user as soon as they use their tab during an agent action", async () => {
    const { wc, cdp, view, automation, methods } = setup({ agentTab: false });
    withShim(wc);
    cdp.acquire("agent");
    view.presented = true;
    const scope = await automation.begin({ dialog: "accept" }, signal(), SCOPE_MS);
    expect(wc.listenerCount("will-prevent-unload")).toBe(1);
    wc.emit("before-mouse-event", fakeEvent(), { type: "mouseDown", x: 3, y: 3, button: "left" });
    // Restored at once, not when the action ends.
    expect(wc.debugger.commands.at(-1)).toEqual({
      method: "Runtime.callFunctionOn",
      params: {
        objectId: "shim-1",
        functionDeclaration: RESTORE,
        returnByValue: true,
        silent: true,
      },
    });
    expect(wc.listenerCount("will-prevent-unload")).toBe(0);
    // A dialog now is the user's: never answered over CDP, and the agent waits for it.
    wc.debugger.message("Page.javascriptDialogOpening", { type: "confirm", message: "Discard?" });
    await flush();
    expect(methods()).not.toContain("Page.handleJavaScriptDialog");
    expect(automation.pendingDialog()).toEqual(expect.objectContaining({ message: "Discard?" }));
    wc.debugger.message("Page.javascriptDialogClosed", { result: true });
    await expect(scope.end()).resolves.toEqual({ dialogs: [] });
  });

  it("installs no shim while the user works in the tab, so a wait there leaves their dialogs alone", async () => {
    const { wc, cdp, view, presentation, automation } = setup({ agentTab: false });
    withShim(wc);
    cdp.acquire("agent");
    await cdp.ready();
    view.presented = true;
    view.focused = true;
    automation.markHuman();
    const scope = await automation.begin({ dialog: "accept" }, signal(), SCOPE_MS);
    expect(presentation.send).not.toHaveBeenCalled();
    expect(wc.listenerCount("will-prevent-unload")).toBe(0);
    wc.debugger.message("Page.javascriptDialogOpening", { type: "confirm", message: "yours" });
    expect(automation.pendingDialog()).toEqual(expect.objectContaining({ message: "yours" }));
    await expect(scope.end()).resolves.toEqual({ dialogs: [] });
  });

  it("restores a shim that went in while the user took the tab back", async () => {
    const { wc, cdp, view, automation } = setup();
    let finishInstall!: () => void;
    wc.debugger.respond = (method) =>
      method === "Runtime.evaluate"
        ? new Promise<object>((resolve) => {
            finishInstall = () => resolve({ result: { type: "object", objectId: "shim-2" } });
          })
        : {};
    cdp.acquire("agent");
    await cdp.ready();
    view.presented = true;
    const begun = automation.begin({}, signal(), SCOPE_MS);
    await flush();
    automation.markHuman(); // A toolbar command: no hold, but the tab is the user's again.
    finishInstall();
    const scope = await begun;
    expect(wc.debugger.commands.at(-1)).toEqual({
      method: "Runtime.callFunctionOn",
      params: {
        objectId: "shim-2",
        functionDeclaration: RESTORE,
        returnByValue: true,
        silent: true,
      },
    });
    await scope.end();
  });

  it("holds the agent out only while the user works in the shown, focused page", () => {
    const { view, automation, advance } = setup();
    view.presented = true;
    view.focused = true;
    expect(automation.humanHoldMs()).toBe(0);
    automation.markHuman();
    expect(automation.humanHoldMs()).toBe(BROWSER_HUMAN_HOLD_MS);
    advance(10_000);
    expect(automation.humanHoldMs()).toBe(20_000);
    view.focused = false;
    expect(automation.humanHoldMs()).toBe(0);
    view.focused = true;
    advance(20_000);
    expect(automation.humanHoldMs()).toBe(0);
  });
});

describe("console capture quiesce", () => {
  it("turns console capture off 60 s after the last agent call and back on with the next", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { cdp, automation, methods } = setup();
    cdp.acquire("picker"); // A user's element pick holds the session too.
    cdp.acquire("agent");
    await cdp.ready();
    await automation.activate();
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_IDLE_QUIESCE_MS - 1);
    expect(methods()).toEqual(READY);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(methods()).toHaveLength(READY.length + 4));
    expect(methods().slice(READY.length)).toEqual([
      "Runtime.disable",
      "Log.disable",
      "Runtime.discardConsoleEntries",
      "Log.clear",
    ]);
    // Never another owner's domains.
    expect(methods().some((method) => /^(DOM|Overlay)\./u.test(method))).toBe(false);
    await automation.activate();
    expect(methods().slice(READY.length + 4)).toEqual(["Runtime.enable", "Log.enable"]);
    await automation.activate();
    expect(methods()).toHaveLength(READY.length + 6);
    expect(vi.getTimerCount()).toBe(1);
    cdp.release("agent");
    cdp.release("picker");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also stops network capture in the user's own tabs and starts it fresh on the next call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { cdp, wc, automation, methods, advance } = setup({ agentTab: false });
    cdp.acquire("agent");
    await cdp.ready();
    await automation.activate();
    wc.debugger.message("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://app.test/a", method: "GET" },
    });
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_IDLE_QUIESCE_MS);
    await vi.waitFor(() => expect(methods()).toHaveLength(READY.length + 5));
    expect(methods().slice(READY.length)).toEqual([
      "Runtime.disable",
      "Log.disable",
      "Runtime.discardConsoleEntries",
      "Log.clear",
      "Network.disable",
    ]);
    // Nothing reports requests now: never idle.
    advance(1_000);
    expect(automation.networkIdle()).toEqual({ idle: false, inFlight: 0, quietMs: 0 });
    await automation.activate();
    expect(methods().slice(READY.length + 5)).toEqual([
      "Network.enable",
      "Runtime.enable",
      "Log.enable",
    ]);
    expect(wc.debugger.commands[READY.length + 5]?.params).toEqual({
      maxTotalBufferSize: 1_048_576,
      maxResourceBufferSize: 262_144,
      maxPostDataSize: 0,
    });
    // The request from before the pause never reports its end; it no longer counts.
    advance(500);
    expect(automation.networkIdle()).toEqual({ idle: true, inFlight: 0, quietMs: 500 });
  });
});

describe("file choosers", () => {
  const INTERCEPT = "Page.setInterceptFileChooserDialog";
  const interceptions = (wc: FakeWebContents) =>
    wc.debugger.commands.flatMap(({ method, params }) =>
      method === INTERCEPT ? [(params as { enabled: boolean }).enabled] : [],
    );
  const opened = (wc: FakeWebContents, params: Record<string, unknown> = {}) =>
    wc.debugger.message("Page.fileChooserOpened", {
      frameId: "main",
      mode: "selectSingle",
      backendNodeId: 7,
      ...params,
    });

  it("intercepts choosers in hidden tabs right after Page.enable, on every attachment", async () => {
    const { cdp, wc, view, methods } = setup();
    cdp.acquire("agent");
    await cdp.ready();
    expect(methods().slice(0, 2)).toEqual(["Page.enable", INTERCEPT]);
    expect(wc.debugger.commands[1]?.params).toEqual({ enabled: true });
    cdp.release("agent");
    // A session opened on a shown tab (a user's element pick) keeps the native picker.
    view.presented = true;
    cdp.acquire("picker");
    await cdp.ready();
    expect(interceptions(wc)).toEqual([true, false]);
    wc.debugger.externalDetach();
    view.presented = false;
    cdp.acquire("agent");
    await cdp.ready();
    expect(interceptions(wc)).toEqual([true, false, true]);
  });

  it("follows presentation without waiting for ready steps, only on change and only while attached", async () => {
    const { cdp, wc, view, automation } = setup();
    cdp.acquire("agent");
    await cdp.ready();
    const send = vi.spyOn(cdp, "send");
    automation.presentationChanged({ resized: false });
    expect(interceptions(wc)).toEqual([true]);
    // Shown: the user's clicks open the native picker; hidden again: choosers wait for the agent.
    view.presented = true;
    automation.presentationChanged({ resized: false });
    automation.presentationChanged({ resized: true });
    view.presented = false;
    automation.presentationChanged({ resized: false });
    expect(interceptions(wc)).toEqual([true, false, true]);
    expect(send).toHaveBeenCalledWith(INTERCEPT, { enabled: false }, { skipReady: true });
    // No session, nothing to send; the next session starts from the presentation again.
    cdp.release("agent");
    view.presented = true;
    automation.presentationChanged({ resized: false });
    expect(interceptions(wc)).toEqual([true, false, true]);
    cdp.acquire("agent");
    await cdp.ready();
    expect(interceptions(wc)).toEqual([true, false, true, false]);
  });

  it("catches up at the next agent call and on the user's input when no presentation hook ran", async () => {
    const { cdp, wc, view, automation } = setup();
    cdp.acquire("agent");
    await cdp.ready();
    // The Ryco window was minimized and restored, which reaches no presentation hook.
    view.presented = true;
    await automation.activate();
    expect(interceptions(wc)).toEqual([true, false]);
    view.presented = false;
    await automation.activate();
    expect(interceptions(wc)).toEqual([true, false, true]);
    // Shown again: the user's click turns interception off before the page opens a chooser.
    view.presented = true;
    wc.emit("before-mouse-event", fakeEvent(), { type: "mouseDown", x: 5, y: 5, button: "left" });
    expect(interceptions(wc)).toEqual([true, false, true, false]);
  });

  it("keeps one chooser for one upload, mentions it once, and drops it with its document", async () => {
    const { cdp, wc, automation, advance } = setup();
    cdp.acquire("agent");
    await cdp.ready();
    expect(automation.peekFileChooser()).toBeNull();
    opened(wc);
    expect(automation.peekFileChooser()).toEqual({ backendNodeId: 7, mode: "selectSingle" });
    expect(automation.noteFileChooser()).toEqual({ mode: "selectSingle" });
    expect(automation.noteFileChooser()).toBeNull();
    expect(automation.takeFileChooser()).toEqual({ backendNodeId: 7, mode: "selectSingle" });
    expect(automation.takeFileChooser()).toBeNull();
    // A newer chooser replaces an older one; unknown modes count as single.
    opened(wc, { backendNodeId: 8, mode: "selectMultiple" });
    opened(wc, { backendNodeId: 9, mode: "upload" });
    expect(automation.peekFileChooser()).toEqual({ backendNodeId: 9, mode: "selectSingle" });
    // Another frame's navigation keeps it; its own frame's or the main frame's ends it.
    wc.debugger.message("Page.frameNavigated", { frame: { id: "ad", parentId: "main" } });
    expect(automation.peekFileChooser()).not.toBeNull();
    wc.debugger.message("Page.frameNavigated", { frame: { id: "main" } });
    expect(automation.peekFileChooser()).toBeNull();
    opened(wc, { frameId: "form" });
    wc.debugger.message("Page.frameNavigated", { frame: { id: "form", parentId: "main" } });
    expect(automation.peekFileChooser()).toBeNull();
    // Choosers without an input element (showOpenFilePicker) cannot be answered; the agent hears
    // so once instead of clicking again and again.
    opened(wc, { backendNodeId: undefined, mode: "selectMultiple" });
    expect(automation.peekFileChooser()).toBeNull();
    expect(automation.noteFileChooser()).toEqual({ mode: "selectMultiple", answerable: false });
    expect(automation.noteFileChooser()).toBeNull();
    expect(automation.takeFileChooser()).toBeNull();
    // A newer chooser with an input replaces it.
    opened(wc, { backendNodeId: undefined });
    opened(wc, { backendNodeId: 10 });
    expect(automation.noteFileChooser()).toEqual({ mode: "selectSingle" });
    wc.debugger.message("Page.frameNavigated", { frame: { id: "main" } });
    expect(automation.peekFileChooser()).toBeNull();
    // Child targets are not this page.
    wc.debugger.message(
      "Page.fileChooserOpened",
      { frameId: "x", mode: "selectSingle", backendNodeId: 3 },
      "child-session",
    );
    expect(automation.peekFileChooser()).toBeNull();
    opened(wc);
    advance(FILE_CHOOSER_TTL_MS + 1);
    expect(automation.peekFileChooser()).toBeNull();
    expect(automation.noteFileChooser()).toBeNull();
    opened(wc);
    wc.emit("did-navigate");
    expect(automation.peekFileChooser()).toBeNull();
    opened(wc);
    wc.debugger.externalDetach();
    expect(automation.peekFileChooser()).toBeNull();
  });

  it("leaves a chooser in a tab the user can see to the user unless an agent action opened it", async () => {
    const { cdp, wc, view, automation } = setup();
    cdp.acquire("agent");
    await cdp.ready();
    // Shown, but interception is still on (no hook ran yet): the user's click opened nothing.
    view.presented = true;
    opened(wc);
    expect(automation.peekFileChooser()).toBeNull();
    // Their next click gets the native picker.
    expect(interceptions(wc)).toEqual([true, false]);
    // During an agent action that is not handed back, the chooser is the agent's.
    const scope = await automation.begin({}, signal(), SCOPE_MS);
    opened(wc, { backendNodeId: 11 });
    expect(automation.peekFileChooser()).toEqual({ backendNodeId: 11, mode: "selectSingle" });
    await scope.end();
    // The user's input in the tab takes it over: the agent may no longer answer it.
    wc.emit("before-mouse-event", fakeEvent(), { type: "mouseDown", x: 5, y: 5, button: "left" });
    expect(automation.peekFileChooser()).toBeNull();
  });
});

describe("emulation", () => {
  it("clears the agent's overrides when the user shows or resizes the tab", async () => {
    const { cdp, view, automation, methods } = setup();
    cdp.acquire("agent");
    await cdp.ready();
    const clears = () => methods().filter((method) => method.startsWith("Emulation."));
    automation.clearEmulation();
    automation.presentationChanged({ resized: true });
    await flush();
    expect(clears()).toEqual([]);
    automation.recordEmulation({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    expect(automation.emulation()).toEqual({
      viewport: { width: 390, height: 844 },
      colorScheme: "dark",
    });
    // Hidden again: nothing to undo.
    automation.presentationChanged({ resized: false });
    await flush();
    expect(clears()).toEqual([]);
    view.presented = true;
    automation.presentationChanged({ resized: false });
    await flush();
    expect(clears()).toEqual([
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setEmulatedMedia",
    ]);
    expect(automation.emulation()).toEqual({});
    view.presented = false;
    automation.recordEmulation({ colorScheme: "light" });
    automation.presentationChanged({ resized: true });
    await flush();
    expect(clears()).toHaveLength(4);
    // The session's end drops overrides with it.
    automation.recordEmulation({ viewport: { width: 500, height: 500 } });
    cdp.release("agent");
    expect(automation.emulation()).toEqual({});
  });
});

describe("dispose", () => {
  it("unregisters its ready step and listeners", async () => {
    const { wc, cdp, automation, methods } = setup();
    automation.dispose();
    expect(wc.listenerCount("before-input-event")).toBe(0);
    expect(wc.listenerCount("before-mouse-event")).toBe(0);
    cdp.acquire("agent");
    await cdp.send("Page.reload");
    expect(methods()).toEqual(["Page.reload"]);
  });

  it("never touches destroyed contents", () => {
    const { wc, cdp, automation } = setup();
    cdp.acquire("agent");
    automation.recordEmulation({ colorScheme: "dark" });
    wc.destroy();
    expect(() => automation.dispose()).not.toThrow();
    expect(() => automation.clearEmulation()).not.toThrow();
  });
});
