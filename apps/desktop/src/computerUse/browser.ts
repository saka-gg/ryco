import type { ComputerBrowser, ComputerUseResult } from "@ryco/contracts";
import { numberArg, record, result, textArg } from "./native.ts";
import type { ComputerOperationContext } from "./policy.ts";

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
}
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
      shadow.innerHTML='<svg width="28" height="32" viewBox="0 0 28 32"><path d="M3 2L23 17L14 18L10 28Z" fill="#b1a4ff" stroke="#fff" stroke-width="2"/></svg><span style="position:absolute;left:19px;top:23px;background:#252238;color:white;border-radius:5px;padding:2px 5px;font:11px system-ui">Ryco</span>';
      document.documentElement.append(cursor);
    }
    cursor.style.visibility='visible'; cursor.style.transform='translate(${x}px,${y}px)';
    cursor.animate([{filter:'drop-shadow(0 0 0px #b1a4ff)'},{filter:'drop-shadow(0 0 9px #b1a4ff)'},{filter:'drop-shadow(0 0 0px #b1a4ff)'}],{duration:350});
    return new Promise(resolve => setTimeout(() => resolve(true), document.hidden ? 0 : 160));
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
  observed: boolean;
  scope: string;
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
    if (action === "open") {
      const tab = await transport.open(
        browserUrl(textArg(args, "url", 8192)),
        args.visible === true,
        context.signal,
      );
      context.claim(`browser:${browser}:${tab.id}`);
      await context.activity({ target: browser, mode: "background", action });
      return result(tab);
    }
    const tab = textArg(args, "tab");
    const tabs = await transport.tabs(context.signal);
    const target = tabs.find((item) => item.id === tab);
    if (!target) throw new Error("Tab is no longer available. List tabs again.");
    if (target.url !== "about:blank") browserUrl(target.url);
    context.claim(`browser:${browser}:${tab}`);
    context.check();
    await context.activity({ target: browser, mode: "background", action });
    if (action === "show") {
      await transport.show(tab, context.signal);
      return result({ shown: true });
    }
    if (action === "close") {
      await transport.close(tab, context.signal);
      this.observations.delete(`${browser}:${tab}`);
      return result({ closed: true });
    }
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
    const frameTree = record(await transport.send(tab, "Page.getFrameTree", {}, context.signal));
    const frame = record(record(frameTree.frameTree).frame);
    const document = `${frame.id}:${frame.loaderId}:${target.url}`;
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
        observed: false,
        scope,
      };
      this.observations.set(key, observation);
      while (this.observations.size > 2_000)
        this.observations.delete(this.observations.keys().next().value!);
    }
    const evaluate = (expression: string) => {
      context.check();
      return this.evaluate(transport, tab, expression, observation.contextId, context.signal);
    };
    if (action === "observe") {
      const state = await evaluate(BROWSER_SNAPSHOT_SCRIPT);
      observation.observed = true;
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
    if (!observation.observed)
      throw new Error("Observe this document in the current turn before interacting.");
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
      }
      return result({ delivered: "background", verify: "Observe the page to verify the result." });
    }
    if (action === "scroll") {
      const x = args.x === undefined ? 400 : numberArg(args, "x");
      const y = args.y === undefined ? 300 : numberArg(args, "y");
      await evaluate(browserCursorScript(x, y));
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
    }
    if (action === "type")
      return result(
        await transport.send(
          tab,
          "Input.insertText",
          { text: textArg(args, "text", 20_000) },
          context.signal,
        ),
      );
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
      return result({ delivered: "background" });
    }
    throw new Error("Unknown browser action.");
  }

  stop(): void {
    this.observations.clear();
    for (const transport of this.transports.values()) transport.stop();
  }
}
