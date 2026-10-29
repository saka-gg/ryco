import type { ComputerBrowser, ComputerUseResult } from "@ryco/contracts";
import { numberArg, record, result, textArg } from "./native.ts";
import type { ComputerOperationContext } from "./policy.ts";
import { COMPUTER_CURSOR_HTML } from "./cursor.ts";
import {
  DIAGNOSTICS_DEFAULT_LIMIT,
  DIAGNOSTICS_MAX_LIMIT,
  type BrowserDiagnosticsRead,
} from "./browserDiagnostics.ts";

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  /** The Ryco browser unloaded the page to save memory; using the tab reloads it. */
  suspended?: boolean;
  /** Ryco only: shown to the user in the panel or a pop-out window. */
  presented?: boolean;
  /** Ryco only: the user is working in this tab right now; the agent should open its own. */
  userActive?: boolean;
  /** Ryco only: the agent opened this tab (it belongs to no project). */
  agentTab?: boolean;
}

export type BrowserDialogDecision = "accept" | "dismiss";
/** How the action's page dialogs are answered. Default: alerts accepted, everything else dismissed. */
export interface BrowserDialogPolicy {
  dialog?: BrowserDialogDecision;
  promptText?: string;
}
export interface BrowserHandledDialog {
  kind: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
  action: "accepted" | "dismissed";
  openedAt: string;
  /** "command": opened by the action; "background": opened in a hidden tab between actions. */
  during: "command" | "background";
}
export type BrowserPendingDialog = Omit<BrowserHandledDialog, "action" | "during">;
/** Input the agent is about to dispatch, so the tab does not count it as the user's. */
export type ExpectedAgentInput =
  | { kind: "key"; key: string; alt: boolean; control: boolean; meta: boolean; shift: boolean }
  | {
      kind: "mouse";
      type: "mouseDown" | "mouseWheel" | "contextMenu";
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
    };
/** One action's dialog handling; `end` restores the page and reports the dialogs it answered. */
export interface BrowserCommandScope {
  end(input?: { failed?: boolean }): Promise<{ dialogs: BrowserHandledDialog[] }>;
}
/** Per-tab automation the Ryco browser offers the driver (EmbeddedTabAutomation). */
export interface BrowserTabAutomation {
  /** Bumped by every user input in the tab; refs observed under an older epoch are stale. */
  readonly humanEpoch: number;
  /** > 0 while the user works in this shown, focused tab. */
  humanHoldMs(): number;
  /** A dialog the user can see blocks the page until they answer it. */
  pendingDialog(): BrowserPendingDialog | null;
  /** One action's dialog scope; its shim answers dialogs for at most `maxMs`. */
  begin(
    policy: BrowserDialogPolicy,
    signal: AbortSignal,
    maxMs: number,
  ): Promise<BrowserCommandScope>;
  /** Dialogs answered between actions; returned once. */
  takeBacklog(): BrowserHandledDialog[];
  /** Returns the release function; call it once the input was dispatched. */
  expectInput(input: ExpectedAgentInput): () => void;
  /** The tab's page zoom: CSS pixels per device-independent pixel. */
  zoomFactor(): number;
  networkIdle(): { idle: boolean; inFlight: number; quietMs: number };
  diagnostics(
    kind: "console" | "network",
    limit: number,
    signal: AbortSignal,
  ): Promise<BrowserDiagnosticsRead>;
  recordEmulation(change: {
    viewport?: { width: number; height: number } | null;
    colorScheme?: "dark" | "light" | null;
  }): void;
  /** The agent's overrides as recorded. */
  emulation(): { viewport?: { width: number; height: number }; colorScheme?: "dark" | "light" };
}
/**
 * A tab's reload since the agent's last command (BrowserTransport.wake). "now": this wake revived
 * the suspended tab or waited for its reload, so the page was just loaded from its address and has
 * no history. "earlier": the user or the thumbnail preview revived it and that load had finished;
 * the page may have moved on since. null: the page the agent last used is still there.
 */
export type BrowserTabRevival = "now" | "earlier" | null;
export interface BrowserTransport {
  tabs(signal: AbortSignal): Promise<BrowserTab[]>;
  open(url: string, visible: boolean, signal: AbortSignal): Promise<BrowserTab>;
  show(tab: string, signal: AbortSignal): Promise<void>;
  close(tab: string, signal: AbortSignal): Promise<void>;
  send(
    tab: string,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  stop(): void;
  /**
   * Called after claim and activity and before the first command of a BROWSER_MUTATING_ACTIONS action
   * on `tab`; the returned function runs when the action settles (success or failure). The Ryco
   * browser ends a user's element pick here and refuses new picks until it runs (browser-picker).
   * The returned function must tolerate a tab that is gone by then (it also runs after a `close`);
   * the driver ignores its errors, so they never replace the action's result or error.
   */
  beginAgentMutation?(tab: string, signal: AbortSignal): Promise<() => void>;
  /**
   * Makes a suspended tab live before CDP use. Reports each suspension once (BrowserTabRevival):
   * the page state the agent saw, its observations included, is gone.
   */
  wake?(tab: string, signal: AbortSignal): Promise<BrowserTabRevival>;
  /** The tab's dialogs, diagnostics, human-input guard and emulation. Only the Ryco browser has it. */
  automation?(tab: string): BrowserTabAutomation | undefined;
}

/**
 * Actions that change the page or its tab: input, navigation, reload, close, viewport and color
 * scheme. The driver brackets each with BrowserTransport.beginAgentMutation, refuses them while the
 * user works in the tab, and answers the dialogs they open; browser-agent-upload adds "upload".
 * Reads (tabs, observe, screenshot, wait, console, network) are never in it.
 */
export const BROWSER_MUTATING_ACTIONS: ReadonlySet<string> = new Set([
  "navigate",
  "reload",
  "back",
  "forward",
  "click",
  "hover",
  "fill",
  "select",
  "scroll",
  "type",
  "key",
  "close",
  "resize",
  "appearance",
]);

/** Actions that act on an observed element or the focused one: a reloaded page needs a new observation first. */
const BROWSER_INTERACTIONS: ReadonlySet<string> = new Set([
  "click",
  "fill",
  "select",
  "hover",
  "scroll",
  "type",
  "key",
]);
export const REVIVED_TAB_NOTE =
  "This Ryco tab had been suspended to save memory and was reloaded from its address. Page state such as form input and history was reset, and so were your viewport and color-scheme overrides and the tab's console and network history.";
export const REVIVED_TAB_ERROR = `${REVIVED_TAB_NOTE} Observe it again before interacting.`;
const withRevivedNote = (output: ComputerUseResult): ComputerUseResult => ({
  ...output,
  content: [...output.content, { type: "text", text: REVIVED_TAB_NOTE }],
});
/** Actions only the Ryco browser offers: they need CDP events or Emulation, which the extension lacks. */
const RYCO_ONLY: ReadonlySet<string> = new Set(["console", "network", "resize", "appearance"]);
/** Actions that can run page code, so a page dialog can open while they run. */
const DIALOG_SCOPED: ReadonlySet<string> = new Set(
  [...BROWSER_MUTATING_ACTIONS, "wait"].filter((action) => action !== "close"),
);
export const BROWSER_WAIT_DEFAULT_MS = 10_000;
export const BROWSER_WAIT_MIN_MS = 100;
export const BROWSER_WAIT_MAX_MS = 30_000;
export const BROWSER_WAIT_POLL_MS = 100;
/**
 * How much longer than its own budget an action's dialog shim may answer dialogs (one CDP command's
 * guard). Input and emulation actions have no budget of their own; a wait has its timeout.
 */
export const BROWSER_DIALOG_SCOPE_SLACK_MS = 15_000;
const EMULATION_NOTE =
  "Lasts until the user shows or resizes this tab, you reset it, control stops, or the tab is suspended to save memory.";
const HUMAN_CHANGED =
  "The user used this tab after your last observe. Observe it again before interacting.";
/** The refusal while a page dialog blocks the tab until the user answers it. */
export const BROWSER_PENDING_DIALOG_MESSAGE =
  "A page dialog in this tab is waiting for the user. Use another tab, or ask the user to answer it.";
const VIEWPORT_SCRIPT = "({ width: innerWidth, height: innerHeight, devicePixelRatio })";

function integerArg(args: Record<string, unknown>, name: string, min: number, max: number): number {
  const value = numberArg(args, name, min, max);
  if (!Number.isInteger(value)) throw new Error(`Invalid ${name}.`);
  return value;
}
function booleanArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (value !== undefined && typeof value !== "boolean") throw new Error(`Invalid ${name}.`);
  return value === true;
}
function enumArg<T extends string>(
  args: Record<string, unknown>,
  name: string,
  values: readonly T[],
): T | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) throw new Error(`Invalid ${name}.`);
  return value as T;
}
function dialogPolicy(args: Record<string, unknown>): BrowserDialogPolicy {
  const dialog = enumArg(args, "dialog", ["accept", "dismiss"] as const);
  return {
    ...(dialog === undefined ? {} : { dialog }),
    ...(args.promptText === undefined ? {} : { promptText: textArg(args, "promptText", 4096) }),
  };
}
function waitTimeout(args: Record<string, unknown>): number {
  return args.timeout === undefined
    ? BROWSER_WAIT_DEFAULT_MS
    : integerArg(args, "timeout", BROWSER_WAIT_MIN_MS, BROWSER_WAIT_MAX_MS);
}
/** Refuses agent input, navigation and emulation while the user works in this tab. */
function refuseWhileUserWorks(automation: BrowserTabAutomation, action: string): void {
  if (!BROWSER_MUTATING_ACTIONS.has(action)) return;
  const hold = automation.humanHoldMs();
  if (hold > 0)
    throw new Error(
      `The user is working in this tab. Open your own background tab with action "open" (same URL), or wait ${Math.ceil(hold / 1000)} s and observe again.`,
    );
}
/** Resolves after `ms`, or at once when the operation is cancelled (its next check throws). */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
function withDialogs(
  value: ComputerUseResult,
  dialogs: readonly BrowserHandledDialog[],
): ComputerUseResult {
  if (dialogs.length === 0) return value;
  return {
    ...value,
    content: [...value.content, { type: "text", text: JSON.stringify({ dialogs }) }],
  };
}

export function browserUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Browser navigation requires an HTTP(S) URL without embedded credentials.");
  return url.href;
}

// Runs in a CDP isolated world. Neither the model nor page scripts choose this code.
export const BROWSER_SNAPSHOT_SCRIPT = `(() => {
  const refs = new Map(); let next = 0; const rows = [];
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const walk = root => { for (const el of root.querySelectorAll('*')) {
    if (next >= 500) break;
    if (el.shadowRoot) walk(el.shadowRoot);
    if (!visible(el) || el.id === '__ryco_agent_cursor') continue;
    if (!el.matches('a,button,input,textarea,select,summary,[role],[contenteditable="true"]')) continue;
    const ref = 'e' + (++next); refs.set(ref, el);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const name = (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || '').trim().slice(0, 160);
    rows.push({ref, role, name, disabled: !!el.disabled, ...(el.tagName === 'SELECT' ? {options: Array.from(el.options).slice(0,50).map(o => ({label:o.label,value:o.value}))} : {})});
  }};
  walk(document); globalThis.__rycoRefs = refs;
  return { title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0,24000), elements: rows, truncated: next >= 500 };
})()`;

export function browserCursorScript(x: number, y: number): string {
  return `(() => {
    let cursor = document.getElementById('__ryco_agent_cursor');
    if (!cursor) {
      cursor = document.createElement('div'); cursor.id='__ryco_agent_cursor'; cursor.setAttribute('aria-hidden','true');
      cursor.style.cssText='position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform 160ms ease-out;will-change:transform;';
      const shadow=cursor.attachShadow({mode:'closed'});
      shadow.innerHTML=${JSON.stringify(COMPUTER_CURSOR_HTML)};
      document.documentElement.append(cursor);
    }
    cursor.style.visibility='visible'; cursor.style.transform='translate(${x}px,${y}px)';
    cursor.animate([{filter:'drop-shadow(0 0 0px #b1a4ff)'},{filter:'drop-shadow(0 0 9px #b1a4ff)'},{filter:'drop-shadow(0 0 0px #b1a4ff)'}],{duration:350});
    return new Promise(resolve => setTimeout(() => resolve(true), document.hidden ? 0 : 160));
  })()`;
}

/**
 * One `wait` poll in the isolated world. The model's selector and text arrive only as JSON data;
 * an invalid selector is reported instead of thrown.
 */
export function browserWaitScript(input: { selector?: string; text?: string }): string {
  return `(() => {
    const input = ${JSON.stringify(input)};
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    let selector = null;
    if (input.selector !== undefined) {
      let all; try { all = document.querySelectorAll(input.selector); } catch { return { invalidSelector: true }; }
      selector = false; for (let i = 0; i < Math.min(all.length, 200); i++) if (visible(all[i])) { selector = true; break; }
    }
    const text = input.text === undefined ? null : (document.body?.innerText || '').includes(input.text);
    return { selector, text, url: location.href, title: document.title, readyState: document.readyState };
  })()`;
}

/** Check the actual hit target, including open shadow roots, before delivering input. */
function elementActionScript(ref: string, action: string, value?: string, scroll = false): string {
  return `(() => {
    const el=globalThis.__rycoRefs?.get(${JSON.stringify(ref)});
    if(!el?.isConnected) throw Error('stale');
    if(el.closest('[inert]')) throw Error('inert');
    if(${action !== "hover"} && (el.matches(':disabled') || el.closest('[aria-disabled="true"]'))) throw Error('disabled');
    if(${action === "fill"}) {
      if(el.readOnly) throw Error('readonly');
      if(!(el instanceof HTMLTextAreaElement || el.isContentEditable ||
        (el instanceof HTMLInputElement && ['text','search','email','url','tel','password','number','date','datetime-local','month','time','week'].includes(el.type)))) throw Error('not fillable');
    }
    if(${action === "select"}) {
      if(!(el instanceof HTMLSelectElement)) throw Error('not a select');
      const option=Array.from(el.options).find(o=>o.value===${JSON.stringify(value)});
      if(!option || option.disabled || option.parentElement?.disabled) throw Error('unavailable option');
    }
    ${scroll ? "el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});" : ""}
    const r=el.getBoundingClientRect(), style=getComputedStyle(el);
    const left=Math.max(0,r.left), right=Math.min(innerWidth,r.right), top=Math.max(0,r.top), bottom=Math.min(innerHeight,r.bottom);
    if(right<=left || bottom<=top || style.visibility!=='visible' || style.display==='none') throw Error('hidden');
    const x=(left+right)/2,y=(top+bottom)/2;
    let hit=document.elementFromPoint(x,y);
    while(hit?.shadowRoot) { const inner=hit.shadowRoot.elementFromPoint(x,y); if(!inner || inner===hit) break; hit=inner; }
    let current=hit;
    while(current && current!==el) current=current.parentElement || current.getRootNode()?.host;
    if(current!==el) throw Error('covered');
    return {el,x,y};
  })()`;
}

interface Observation {
  transport: BrowserTransport;
  contextId: number;
  document: string;
  /** The main frame's loader when the isolated world was made; a new document has a new one. */
  loaderId: string;
  observed: boolean;
  scope: string;
  /** The tab's human epoch when it was observed (Ryco browser; 0 elsewhere). */
  humanEpoch: number;
}

interface MainFrame {
  id: unknown;
  loaderId: string;
}

export class BrowserComputerDriver {
  private readonly observations = new Map<string, Observation>();
  private readonly transports: Map<ComputerBrowser, BrowserTransport>;
  constructor(transports: Map<ComputerBrowser, BrowserTransport>) {
    this.transports = transports;
  }

  private async evaluate(
    transport: BrowserTransport,
    tab: string,
    expression: string,
    contextId: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = record(
      await transport.send(
        tab,
        "Runtime.evaluate",
        { expression, contextId, returnByValue: true, awaitPromise: true },
        signal,
      ),
    );
    if (response.exceptionDetails)
      throw new Error("Page state changed. Observe the page again before interacting.");
    return record(response.result).value;
  }

  async execute(
    context: ComputerOperationContext,
    browser: ComputerBrowser,
  ): Promise<ComputerUseResult> {
    const transport = this.transports.get(browser);
    if (!transport)
      throw new Error("This browser is not connected. Pair it in Computer use settings.");
    const args = context.request.args;
    const action = textArg(args, "action");
    if (action === "tabs") return result(await transport.tabs(context.signal));
    const visible =
      browser !== "ryco" && (action === "show" || (action === "open" && args.visible === true));
    // Showing an external tab changes the user's selected tab; even an inactive
    // preview can cover their work. Presentation is a consent-gated operation.
    if (visible) await context.authorizeForeground();
    if (action === "open") {
      const tab = await transport.open(
        browserUrl(textArg(args, "url", 8192)),
        visible,
        context.signal,
      );
      context.claim(`browser:${browser}:${tab.id}`);
      await context.activity({
        target: browser,
        mode: visible ? "foreground" : "background",
        action,
      });
      return result(tab);
    }
    const tab = textArg(args, "tab");
    const tabs = await transport.tabs(context.signal);
    const target = tabs.find((item) => item.id === tab);
    if (!target) throw new Error("Tab is no longer available. List tabs again.");
    if (target.url !== "about:blank") browserUrl(target.url);
    // Refusals that need no claim: the target stays free for the user and other turns.
    // The capability belongs to the transport, not to the page: a tab whose page is not live yet
    // (suspended) still offers it once the page is back.
    const automates = transport.automation !== undefined;
    if (!automates) {
      if (RYCO_ONLY.has(action)) throw new Error(`${action} is available only for browser "ryco".`);
      if (action === "wait" && args.idle === "network")
        throw new Error('wait idle:"network" is available only for browser "ryco".');
    }
    const early = transport.automation?.(tab);
    if (early?.pendingDialog() && action !== "close")
      throw new Error(BROWSER_PENDING_DIALOG_MESSAGE);
    if (early) refuseWhileUserWorks(early, action);
    const policy = automates && DIALOG_SCOPED.has(action) ? dialogPolicy(args) : undefined;
    // A wait's shim answers dialogs for as long as the wait may run.
    const scopeMs = (action === "wait" ? waitTimeout(args) : 0) + BROWSER_DIALOG_SCOPE_SLACK_MS;
    context.claim(`browser:${browser}:${tab}`);
    context.check();
    await context.activity({
      target: target.title ? `${browser} — ${target.title}`.slice(0, 512) : browser,
      mode: visible ? "foreground" : "background",
      action: action === "observe" ? "find_elements" : action,
    });
    const endMutation = BROWSER_MUTATING_ACTIONS.has(action)
      ? await transport.beginAgentMutation?.(tab, context.signal)
      : undefined;
    try {
      if (endMutation) context.check(); // The bracket may have waited.
      if (action === "show") {
        await transport.show(tab, context.signal);
        return result(
          browser === "ryco" ? { shown: false, presentation: "workspace" } : { shown: true },
        );
      }
      if (action === "close") {
        await transport.close(tab, context.signal);
        this.observations.delete(`${browser}:${tab}`);
        return result({ closed: true });
      }
      // A tab the Ryco browser suspended reloads first; the page state the agent saw is gone.
      const revival = transport.wake ? await transport.wake(tab, context.signal) : null;
      if (transport.wake) context.check(); // The reload may have waited.
      if (revival) {
        this.observations.delete(`${browser}:${tab}`);
        // Only a page loaded just now makes a reload redundant and has no history to go to; one
        // the user revived earlier may have reloaded stale content or built new history since.
        if (revival === "now") {
          if (action === "reload") return withRevivedNote(result({ reloaded: true }));
          if (action === "back" || action === "forward") throw new Error(REVIVED_TAB_ERROR);
        }
        if (BROWSER_INTERACTIONS.has(action)) throw new Error(REVIVED_TAB_ERROR);
      }
      // The page as it is now (browser-tab-budget's wake revives a suspended one right above this):
      // its guards apply again, since the checks before the claim may have seen no page or an
      // older one.
      const automation = transport.automation?.(tab);
      if (
        automates &&
        !automation &&
        (RYCO_ONLY.has(action) || (action === "wait" && args.idle === "network"))
      )
        throw new Error("Browser tab closed.");
      if (automation?.pendingDialog()) throw new Error(BROWSER_PENDING_DIALOG_MESSAGE);
      if (automation) refuseWhileUserWorks(automation, action);
      // Dialogs the action's page code opens are answered while it runs (Ryco browser).
      const scope =
        policy && automation ? await automation.begin(policy, context.signal, scopeMs) : undefined;
      let value: ComputerUseResult;
      try {
        value = await this.act(context, browser, transport, tab, target, action, automation);
      } catch (error) {
        await scope?.end({ failed: true });
        throw error;
      }
      const dialogs = scope ? (await scope.end()).dialogs : (automation?.takeBacklog() ?? []);
      const output = withDialogs(value, dialogs);
      return revival ? withRevivedNote(output) : output;
    } finally {
      try {
        endMutation?.();
      } catch {
        // The bracket's end only lifts the transport's own restrictions; the action's outcome stands.
      }
    }
  }

  private async mainFrame(
    transport: BrowserTransport,
    tab: string,
    signal: AbortSignal,
  ): Promise<MainFrame> {
    const frameTree = record(await transport.send(tab, "Page.getFrameTree", {}, signal));
    const frame = record(record(frameTree.frameTree).frame);
    return { id: frame.id, loaderId: String(frame.loaderId) };
  }

  /** The isolated world for the tab's current document, kept while document and turn stay. */
  private async world(
    context: ComputerOperationContext,
    browser: ComputerBrowser,
    transport: BrowserTransport,
    tab: string,
    documentUrl: string,
    known?: MainFrame,
  ): Promise<Observation> {
    const frame = known ?? (await this.mainFrame(transport, tab, context.signal));
    const document = `${frame.id}:${frame.loaderId}:${documentUrl}`;
    const key = `${browser}:${tab}`;
    const scope = JSON.stringify([context.request.sessionId, context.request.turnId]);
    let observation = this.observations.get(key);
    if (
      !observation ||
      observation.transport !== transport ||
      observation.document !== document ||
      observation.scope !== scope
    ) {
      const world = record(
        await transport.send(
          tab,
          "Page.createIsolatedWorld",
          { frameId: frame.id, worldName: "ryco-computer-use" },
          context.signal,
        ),
      );
      observation = {
        transport,
        contextId: numberArg(world, "executionContextId", 0, Number.MAX_SAFE_INTEGER),
        document,
        loaderId: frame.loaderId,
        observed: false,
        scope,
        humanEpoch: 0,
      };
      this.observations.set(key, observation);
      while (this.observations.size > 2_000)
        this.observations.delete(this.observations.keys().next().value!);
    }
    return observation;
  }

  /** Everything after show/close: history, navigation, observe, screenshot and the interactions. */
  private async act(
    context: ComputerOperationContext,
    browser: ComputerBrowser,
    transport: BrowserTransport,
    tab: string,
    target: BrowserTab,
    action: string,
    automation: BrowserTabAutomation | undefined,
  ): Promise<ComputerUseResult> {
    const args = context.request.args;
    if (action === "reload" || action === "back" || action === "forward") {
      this.observations.delete(`${browser}:${tab}`);
      if (action === "reload")
        return result(await transport.send(tab, "Page.reload", {}, context.signal));
      const history = record(
        await transport.send(tab, "Page.getNavigationHistory", {}, context.signal),
      );
      const entries = history.entries;
      const index = numberArg(history, "currentIndex") + (action === "back" ? -1 : 1);
      if (!Array.isArray(entries) || !entries[index])
        throw new Error("No history entry in that direction.");
      const entry = record(entries[index]);
      browserUrl(textArg(entry, "url", 8192));
      return result(
        await transport.send(
          tab,
          "Page.navigateToHistoryEntry",
          { entryId: numberArg(entry, "id") },
          context.signal,
        ),
      );
    }
    if (action === "navigate") {
      this.observations.delete(`${browser}:${tab}`);
      return result(
        await transport.send(
          tab,
          "Page.navigate",
          { url: browserUrl(textArg(args, "url", 8192)) },
          context.signal,
        ),
      );
    }
    if ((action === "console" || action === "network") && automation) {
      const limit =
        args.limit === undefined
          ? DIAGNOSTICS_DEFAULT_LIMIT
          : integerArg(args, "limit", 1, DIAGNOSTICS_MAX_LIMIT);
      return result(await automation.diagnostics(action, limit, context.signal));
    }
    const observation = await this.world(context, browser, transport, tab, target.url);
    const evaluate = (expression: string) => {
      context.check();
      return this.evaluate(transport, tab, expression, observation.contextId, context.signal);
    };
    if (action === "observe") {
      // Input during the snapshot already makes its refs stale.
      const humanEpoch = automation?.humanEpoch ?? 0;
      const state = await evaluate(BROWSER_SNAPSHOT_SCRIPT);
      observation.observed = true;
      observation.humanEpoch = humanEpoch;
      return result(state);
    }
    if (action === "screenshot") {
      await evaluate(
        "document.getElementById('__ryco_agent_cursor')?.style.setProperty('visibility','hidden')",
      );
      try {
        const shot = record(
          await transport.send(
            tab,
            "Page.captureScreenshot",
            { format: "png", captureBeyondViewport: false },
            context.signal,
          ),
        );
        return {
          content: [
            { type: "image", data: textArg(shot, "data", 16 * 1024 * 1024), mimeType: "image/png" },
          ],
        };
      } finally {
        await evaluate(
          "document.getElementById('__ryco_agent_cursor')?.style.removeProperty('visibility')",
        ).catch(() => undefined);
      }
    }
    if (action === "wait")
      return this.wait(context, browser, transport, tab, observation, automation);
    if (action === "resize" && automation) {
      const reset = booleanArg(args, "reset");
      const width = reset ? 0 : integerArg(args, "width", 320, 3840);
      const height = reset ? 0 : integerArg(args, "height", 240, 2160);
      context.check();
      const previous = reset ? automation.emulation().viewport : undefined;
      if (reset) {
        await transport.send(tab, "Emulation.clearDeviceMetricsOverride", {}, context.signal);
        automation.recordEmulation({ viewport: null });
      } else {
        // Recorded first: an override that lands just before an abort is still cleared later.
        automation.recordEmulation({ viewport: { width, height } });
        await transport.send(
          tab,
          "Emulation.setDeviceMetricsOverride",
          // deviceScaleFactor 0 keeps the screen's own ratio.
          {
            width,
            height,
            deviceScaleFactor: 0,
            mobile: false,
            screenWidth: width,
            screenHeight: height,
          },
          context.signal,
        );
      }
      // The renderer applies the new metrics (and a reset) asynchronously; report them once the
      // page sees them. The override is in device-independent pixels; the page measures CSS pixels
      // at its zoom.
      const zoom = automation.zoomFactor();
      const near = (value: unknown, pixels: number) => Math.abs(Number(value) - pixels / zoom) <= 1;
      let viewport = record(await evaluate(VIEWPORT_SCRIPT));
      const settled = () =>
        reset
          ? previous === undefined ||
            !(near(viewport.width, previous.width) && near(viewport.height, previous.height))
          : viewport.width === width || near(viewport.width, width);
      for (let attempt = 0; !settled() && attempt < 10; attempt += 1) {
        await pause(50, context.signal);
        viewport = record(await evaluate(VIEWPORT_SCRIPT));
      }
      return result(
        reset
          ? { viewport, note: "The viewport follows the tab's size again." }
          : { viewport, note: EMULATION_NOTE },
      );
    }
    if (action === "appearance" && automation) {
      const scheme = enumArg(args, "scheme", ["dark", "light", "system"] as const);
      if (scheme === undefined) throw new Error("Invalid scheme.");
      context.check();
      // A forced scheme is recorded first (see resize); going back to the system's only once sent.
      if (scheme !== "system") automation.recordEmulation({ colorScheme: scheme });
      await transport.send(
        tab,
        "Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-color-scheme", value: scheme === "system" ? "" : scheme }] },
        context.signal,
      );
      if (scheme === "system") automation.recordEmulation({ colorScheme: null });
      const prefersDark = await evaluate("matchMedia('(prefers-color-scheme: dark)').matches");
      return result({
        scheme,
        prefersDark,
        ...(scheme === "system" ? {} : { note: EMULATION_NOTE }),
      });
    }
    if (!observation.observed)
      throw new Error("Observe this document in the current turn before interacting.");
    if (automation && observation.humanEpoch !== automation.humanEpoch) {
      observation.observed = false;
      throw new Error(HUMAN_CHANGED);
    }
    // The user can start working in the tab while the action validates its target; check again
    // right before each input-dispatching command. Input that lands after it fails the next one.
    const assertHumanUnchanged = () => {
      if (!automation) return;
      if (automation.humanEpoch !== observation.humanEpoch || automation.humanHoldMs() > 0) {
        observation.observed = false;
        throw new Error(HUMAN_CHANGED);
      }
    };
    if (action === "click" || action === "fill" || action === "select" || action === "hover") {
      const value =
        action === "fill" || action === "select"
          ? textArg(args, action === "fill" ? "text" : "value", 20_000)
          : undefined;
      const ref = textArg(args, "ref", 16);
      const prepare = elementActionScript(ref, action, value, true);
      const point = record(await evaluate(`(() => { const {x,y}=${prepare}; return {x,y}; })()`));
      const x = numberArg(point, "x");
      const y = numberArg(point, "y");
      await evaluate(browserCursorScript(x, y));
      context.check();
      await transport.send(
        tab,
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x, y },
        context.signal,
      );
      // Hover handlers, scrolling and the cursor animation can change the layout.
      // Revalidate in the same document immediately before clicking or editing.
      const validate = `const {el,x,y}=${elementActionScript(ref, action, value)};
        if(Math.abs(x-${x})>1 || Math.abs(y-${y})>1) throw Error('target moved');`;
      if (action === "fill" || action === "select") {
        assertHumanUnchanged();
        // Do not click a select first: its native popup can intercept later input.
        await evaluate(`(() => { ${validate}
          el.focus({preventScroll:true});
          if(!el.isConnected || el.matches(':disabled') || el.readOnly) throw Error('state changed');
          if(el instanceof HTMLSelectElement) el.value=${JSON.stringify(value)};
          else if(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { const proto=el instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)}); }
          else el.textContent=${JSON.stringify(value)};
          el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
      } else {
        await evaluate(`(() => { ${validate} return true; })()`);
        if (action === "hover") return result({ delivered: "background" });
        assertHumanUnchanged();
        const release = automation?.expectInput({
          kind: "mouse",
          type: "mouseDown",
          x,
          y,
          button: "left",
        });
        try {
          await transport.send(
            tab,
            "Input.dispatchMouseEvent",
            { type: "mousePressed", x, y, button: "left", clickCount: 1 },
            context.signal,
          );
          await transport.send(
            tab,
            "Input.dispatchMouseEvent",
            { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
            context.signal,
          );
        } finally {
          release?.();
        }
      }
      return result({ delivered: "background", verify: "Observe the page to verify the result." });
    }
    if (action === "scroll") {
      const x = args.x === undefined ? 400 : numberArg(args, "x");
      const y = args.y === undefined ? 300 : numberArg(args, "y");
      await evaluate(browserCursorScript(x, y));
      assertHumanUnchanged();
      const release = automation?.expectInput({ kind: "mouse", type: "mouseWheel", x, y });
      try {
        return result(
          await transport.send(
            tab,
            "Input.dispatchMouseEvent",
            {
              type: "mouseWheel",
              x,
              y,
              deltaX: args.scrollX === undefined ? 0 : numberArg(args, "scrollX", -5000, 5000),
              deltaY: numberArg(args, "scrollY", -5000, 5000),
            },
            context.signal,
          ),
        );
      } finally {
        release?.();
      }
    }
    if (action === "type") {
      const text = textArg(args, "text", 20_000);
      assertHumanUnchanged();
      return result(await transport.send(tab, "Input.insertText", { text }, context.signal));
    }
    if (action === "key") {
      const keys: Record<string, number> = {
        Enter: 13,
        Tab: 9,
        Escape: 27,
        Backspace: 8,
        Delete: 46,
        ArrowLeft: 37,
        ArrowUp: 38,
        ArrowRight: 39,
        ArrowDown: 40,
        Home: 36,
        End: 35,
        PageUp: 33,
        PageDown: 34,
      };
      const keyName = textArg(args, "key", 32);
      const code = Object.hasOwn(keys, keyName) ? keys[keyName] : undefined;
      if (code === undefined)
        throw new Error(
          "Unsupported browser key. Use Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp or PageDown.",
        );
      assertHumanUnchanged();
      const release = automation?.expectInput({
        kind: "key",
        key: keyName,
        alt: false,
        control: false,
        meta: false,
        shift: false,
      });
      try {
        await transport.send(
          tab,
          "Input.dispatchKeyEvent",
          { type: "keyDown", key: keyName, windowsVirtualKeyCode: code },
          context.signal,
        );
        await transport.send(
          tab,
          "Input.dispatchKeyEvent",
          { type: "keyUp", key: keyName, windowsVirtualKeyCode: code },
          context.signal,
        );
      } finally {
        release?.();
      }
      return result({ delivered: "background" });
    }
    throw new Error("Unknown browser action.");
  }

  /** Polls until every given condition holds, or throws when the timeout passes. */
  private async wait(
    context: ComputerOperationContext,
    browser: ComputerBrowser,
    transport: BrowserTransport,
    tab: string,
    initial: Observation,
    automation: BrowserTabAutomation | undefined,
  ): Promise<ComputerUseResult> {
    const args = context.request.args;
    const selector = args.selector === undefined ? undefined : textArg(args, "selector", 1024);
    const text = args.text === undefined ? undefined : textArg(args, "text", 1024);
    const urlIncludes =
      args.urlIncludes === undefined ? undefined : textArg(args, "urlIncludes", 2048);
    const idle = enumArg(args, "idle", ["network", "load"] as const);
    const gone = booleanArg(args, "gone");
    const timeout = waitTimeout(args);
    if (selector === undefined && text === undefined && urlIncludes === undefined && !idle)
      throw new Error("Give wait a selector, text, urlIncludes or idle condition.");
    if (gone && selector === undefined && text === undefined)
      throw new Error("gone applies to selector or text.");
    const script = browserWaitScript({
      ...(selector === undefined ? {} : { selector }),
      ...(text === undefined ? {} : { text }),
    });
    const started = Date.now();
    const deadline = started + timeout;
    let observation = initial;
    let documentChanged = false;
    for (;;) {
      context.check();
      // The page is blocked until the user answers; its next command would only time out.
      if (automation?.pendingDialog()) throw new Error(BROWSER_PENDING_DIALOG_MESSAGE);
      const frame = await this.mainFrame(transport, tab, context.signal);
      if (frame.loaderId !== observation.loaderId) {
        // A new document: refresh the tab's URL the way execute() does, then a fresh world.
        const fresh = (await transport.tabs(context.signal)).find((item) => item.id === tab);
        if (!fresh) throw new Error("Tab is no longer available. List tabs again.");
        if (fresh.url !== "about:blank") browserUrl(fresh.url);
        observation = await this.world(context, browser, transport, tab, fresh.url, frame);
        documentChanged = true;
      }
      let state: Record<string, unknown> | undefined;
      try {
        context.check();
        state = record(
          await this.evaluate(transport, tab, script, observation.contextId, context.signal),
        );
      } catch (error) {
        // A navigation can replace the document between the frame check and the evaluate.
        context.check();
        if (
          (await this.mainFrame(transport, tab, context.signal)).loaderId === observation.loaderId
        )
          throw error;
      }
      if (state?.invalidSelector === true) throw new Error("Invalid CSS selector.");
      const unmet: string[] = [];
      if (state) {
        if (selector !== undefined && state.selector !== !gone)
          unmet.push(gone ? "the selector to disappear" : "the selector to appear");
        if (text !== undefined && state.text !== !gone)
          unmet.push(gone ? "the text to disappear" : "the text to appear");
        if (urlIncludes !== undefined && !String(state.url ?? "").includes(urlIncludes))
          unmet.push("the URL to match urlIncludes");
        if (idle === "load" && state.readyState !== "complete") unmet.push("the page to load");
      } else unmet.push("the new document");
      if (idle === "network") {
        const network = automation?.networkIdle();
        if (!network?.idle)
          unmet.push(`network idle (${network?.inFlight ?? 0} requests in flight)`);
      }
      if (unmet.length === 0 && state)
        return result({
          matched: true,
          elapsedMs: Date.now() - started,
          url: state.url,
          title: state.title,
          documentChanged,
          ...(documentChanged
            ? { verify: "The document changed; observe again before interacting." }
            : {}),
        });
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          `Wait timed out after ${timeout} ms; still waiting for ${unmet.join(", ")}.`,
        );
      await pause(Math.min(BROWSER_WAIT_POLL_MS, remaining), context.signal);
    }
  }

  stop(): void {
    this.observations.clear();
    for (const transport of this.transports.values()) transport.stop();
  }
}
