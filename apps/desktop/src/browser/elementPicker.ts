import type { WebContents } from "electron";
import * as Schema from "effect/Schema";
import {
  ProjectBrowserPickedElement,
  type ProjectBrowserPickCancelReason,
  type ProjectBrowserPickResult,
} from "@ryco/contracts/project-browser";
import {
  BROWSER_ELEMENT_DESCRIBE_FUNCTION,
  BROWSER_ELEMENT_PAGE_NODE_FUNCTION,
} from "@ryco/shared/browserElementPickScript";
import { normalizeBrowserElementPick } from "@ryco/shared/browserElementReference";
import type { CdpLease } from "./cdpLease.ts";

/** Chromium's inspect overlay while the user chooses (DevTools' default colours). */
export const PICKER_HIGHLIGHT = {
  showInfo: true,
  showStyles: true,
  showAccessibilityInfo: true,
  showExtensionLines: false,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
} as const;
/** The picked element while the user writes a note: Ryco's cursor purple (#b1a4ff). */
export const PICKED_HIGHLIGHT = {
  showInfo: false,
  contentColor: { r: 177, g: 164, b: 255, a: 0.25 },
  borderColor: { r: 177, g: 164, b: 255, a: 0.9 },
} as const;
/**
 * Turns inspect mode off. Chromium rejects `Overlay.setInspectMode` without a `highlightConfig` for
 * every mode, "none" included ("highlight configuration parameter is missing").
 */
export const INSPECT_MODE_OFF = { mode: "none", highlightConfig: {} } as const;
/**
 * Attaches to out-of-process (cross-site) iframes while the user chooses. Chromium routes input over
 * such a frame to the frame's own renderer, where the page's inspect tool never sees it, so each one
 * gets its own inspect mode; a click there picks the frame's element in the page.
 */
export const FRAME_AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "iframe" }],
} as const;
export const NO_AUTO_ATTACH = { autoAttach: false, waitForDebuggerOnStart: false } as const;

const WORLD_NAME = "ryco-element-picker";
const START_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 2_000;
/** A pick that has not found an element by then ends with "timeout". */
export const PICKING_TIMEOUT_MS = 120_000;
/** DOM.resolveNode's answer for a node that is gone; any other failure on a cached world retries once on a fresh one. */
const NODE_GONE = /no node with given id/iu;

const START_FAILED = "Couldn't start picking on this page.";
const UNRESOLVABLE =
  "This element can't be picked. It may be inside an embedded frame, or the page removed it.";
const UNDESCRIBABLE = "This element can't be picked. Try one next to it.";

type PickContents = Pick<WebContents, "getURL" | "isDestroyed">;
type Phase = "starting" | "picking" | "describing" | "picked";
/** An out-of-process iframe a pick attached to, and the CDP session it was attached from (undefined: the page). */
interface PickFrame {
  readonly frameId: string;
  readonly parent: string | undefined;
}
interface PickSession {
  readonly lease: CdpLease;
  readonly contents: PickContents;
  phase: Phase;
  settled: boolean;
  readonly resolve: (result: ProjectBrowserPickResult) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly unsubscribers: Array<() => void>;
  /** Out-of-process iframes attached while choosing, by their CDP session id. */
  readonly frames: Map<string, PickFrame>;
  /** The page's Target auto-attach is on (from choosing until the choice or the end). */
  autoAttach: boolean;
}
/** A pick waiting for an earlier pick's cleanup. An `end()` meanwhile cancels it. */
interface WaitingPick {
  cancelled: ProjectBrowserPickCancelReason | undefined;
}
/** What the user clicked: a node of the page, or somewhere in an out-of-process iframe. */
type PickTarget = { readonly backendNodeId: unknown } | { readonly frameSession: string };
/** A tab's isolated world for one document (`frameId:loaderId`). */
interface PickerWorld {
  readonly document: string;
  readonly contextId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** Fire-and-forget commands still settle; this only keeps their rejections handled. */
function quiet(commands: ReadonlyArray<Promise<unknown>>): void {
  for (const command of commands) command.catch(() => undefined);
}

/**
 * The user's element picker in the Ryco browser, driven from the main process over the page's
 * shared debugger session (held as "picker"). Chromium's inspect overlay shows the hover outline
 * and info; the page sees no Ryco code. The picked element is described by a function in the
 * `ryco-element-picker` isolated world and normalized with the browser's own URL and title.
 *
 * One session per tab. Every continuation after an `await` stops unless its session is still the
 * tab's current one, so a late answer never re-enables inspect mode or draws a highlight on a
 * session that ended. Domain ownership (browser-groundwork 4.6): the picker enables and disables
 * only `DOM` and `Overlay`, and owns the page's `Target` auto-attach and the iframe sessions it
 * attaches (detached again once the user chose or the pick ended).
 */
export class BrowserElementPicker {
  private readonly host: { publish(): void };
  private readonly sessions = new Map<string, PickSession>();
  /** Cleanups still sending their commands, so a caller of `end()` can wait for inspect mode to go off. */
  private readonly cleanups = new Map<string, Promise<void>>();
  private readonly waiting = new Map<string, WaitingPick>();
  private readonly worlds = new Map<string, PickerWorld>();

  constructor(host: { publish(): void }) {
    this.host = host;
  }

  /**
   * "picking" while the user chooses (and while the choice is described, or a new pick waits for
   * the previous one's cleanup), "picked" after.
   */
  state(tab: string): "picking" | "picked" | undefined {
    const session = this.sessions.get(tab);
    if (!session) return this.waiting.has(tab) ? "picking" : undefined;
    return session.phase === "picked" ? "picked" : "picking";
  }

  /**
   * Starts a pick on `tab`, replacing one already there, and settles with the picked element or
   * the reason the pick ended. `admit` runs right before the session opens, after any earlier
   * session's cleanup: it throws to refuse (the tab changed meanwhile).
   */
  async pick(
    tab: string,
    lease: CdpLease,
    contents: PickContents,
    admit: () => void = () => undefined,
  ): Promise<ProjectBrowserPickResult> {
    const previous = this.sessions.get(tab);
    if (previous?.lease === lease && lease.holds("picker") && !contents.isDestroyed()) {
      // Same session: the new pick takes over the hold and the domains instead of turning them off
      // and detaching, only to attach again.
      admit();
      this.retire(tab, previous, { kind: "cancelled", reason: "replaced" });
      return this.open(tab, lease, contents, true);
    }
    if (previous || this.cleanups.has(tab)) {
      const waiting: WaitingPick = { cancelled: undefined };
      const earlier = this.waiting.get(tab);
      if (earlier) earlier.cancelled ??= "replaced";
      this.waiting.set(tab, waiting);
      this.publish();
      try {
        while (waiting.cancelled === undefined) {
          const session = this.sessions.get(tab);
          const cleanup = session
            ? this.close(tab, session, { kind: "cancelled", reason: "replaced" })
            : this.cleanups.get(tab);
          if (!cleanup) break;
          await cleanup;
        }
      } finally {
        if (this.waiting.get(tab) === waiting) this.waiting.delete(tab);
      }
      if (waiting.cancelled !== undefined) {
        this.publish();
        return { kind: "cancelled", reason: waiting.cancelled };
      }
    }
    try {
      admit();
      return this.open(tab, lease, contents, false);
    } catch (error) {
      this.publish();
      throw error;
    }
  }

  /**
   * Ends the tab's pick: a pending pick resolves `{ kind: "cancelled", reason }`, then inspect mode,
   * the highlight and the picker's domains go off and the picker's hold is released. Resolves once
   * that cleanup finished (each command waits at most 2 s); with no session, it cancels a pick
   * still waiting for an earlier cleanup and joins that cleanup. Never rejects.
   */
  end(tab: string, reason: ProjectBrowserPickCancelReason): Promise<void> {
    // A new document has a new loaderId, so only a destroyed page needs its world forgotten here.
    if (reason === "destroyed") this.worlds.delete(tab);
    const waiting = this.waiting.get(tab);
    if (waiting) waiting.cancelled ??= reason;
    const session = this.sessions.get(tab);
    if (!session) return this.cleanups.get(tab) ?? Promise.resolve();
    return this.close(tab, session, { kind: "cancelled", reason });
  }

  /** Ends every pick (the browser is shutting down). */
  dispose(): void {
    for (const waiting of this.waiting.values()) waiting.cancelled ??= "destroyed";
    for (const tab of Array.from(this.sessions.keys())) void this.end(tab, "destroyed");
    this.worlds.clear();
  }

  private current(tab: string, session: PickSession): boolean {
    return this.sessions.get(tab) === session;
  }

  private publish(): void {
    try {
      this.host.publish();
    } catch {
      // A state broadcast must never break the pick's lifecycle.
    }
  }

  /** Opens the tab's session (`handover`: on the hold and domains of the pick it replaced). */
  private open(
    tab: string,
    lease: CdpLease,
    contents: PickContents,
    handover: boolean,
  ): Promise<ProjectBrowserPickResult> {
    lease.acquire("picker");
    let resolve!: (result: ProjectBrowserPickResult) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<ProjectBrowserPickResult>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    const session: PickSession = {
      lease,
      contents,
      phase: "starting",
      settled: false,
      resolve,
      reject,
      timer: undefined,
      unsubscribers: [],
      frames: new Map(),
      autoAttach: false,
    };
    this.sessions.set(tab, session);
    session.unsubscribers.push(
      lease.onEvent((method, params, sessionId) =>
        this.onEvent(tab, session, method, params, sessionId),
      ),
      lease.onDetach(() => {
        if (this.current(tab, session)) void this.end(tab, "detached");
      }),
    );
    this.publish();
    void this.start(tab, session, handover);
    return result;
  }

  private onEvent(
    tab: string,
    session: PickSession,
    method: string,
    params: unknown,
    sessionId: string | undefined,
  ): void {
    if (!this.current(tab, session)) return;
    // Other sessions' events are not this pick's, except those of the frames it attached.
    if (sessionId !== undefined && !session.frames.has(sessionId)) return;
    switch (method) {
      case "Overlay.inspectNodeRequested":
        // Only the first click counts (a double click is ignored).
        if (session.phase === "picking")
          void this.describe(
            tab,
            session,
            sessionId === undefined
              ? { backendNodeId: field(params, "backendNodeId") }
              : { frameSession: sessionId },
          );
        return;
      case "Overlay.inspectModeCanceled":
        void this.end(tab, "user");
        return;
      case "Target.attachedToTarget":
        this.frameAttached(session, params, sessionId);
        return;
      case "Target.detachedFromTarget": {
        const child = field(params, "sessionId");
        if (typeof child === "string") session.frames.delete(child);
        return;
      }
    }
  }

  private async start(tab: string, session: PickSession, handover: boolean): Promise<void> {
    const { lease } = session;
    const options = { timeoutMs: START_TIMEOUT_MS };
    try {
      // The replaced pick's highlight may still show; queued first, best effort.
      if (handover) quiet([lease.send("Overlay.hideHighlight", {}, options)]);
      // The lease runs its ready steps (focus emulation, whoever opened the session) first.
      await lease.send("DOM.enable", {}, options);
      if (!this.current(tab, session)) return;
      await lease.send("Overlay.enable", {}, options);
      if (!this.current(tab, session)) return;
      await lease.send(
        "Overlay.setInspectMode",
        { mode: "searchForNode", highlightConfig: PICKER_HIGHLIGHT },
        options,
      );
    } catch {
      if (this.current(tab, session)) void this.close(tab, session, new Error(START_FAILED));
      return;
    }
    if (!this.current(tab, session)) return;
    session.phase = "picking";
    session.timer = setTimeout(() => {
      if (this.current(tab, session) && session.phase === "picking") void this.end(tab, "timeout");
    }, PICKING_TIMEOUT_MS);
    this.publish();
    session.autoAttach = true;
    void this.autoAttach(session, undefined);
  }

  /**
   * Turns on auto-attach for the out-of-process iframes under `parent` (the page when undefined).
   * Best effort: a frame that is not attached lets its clicks through, as before.
   */
  private async autoAttach(session: PickSession, parent: string | undefined): Promise<void> {
    await session.lease
      .send("Target.setAutoAttach", FRAME_AUTO_ATTACH, {
        timeoutMs: START_TIMEOUT_MS,
        sessionId: parent,
      })
      .catch(() => undefined);
  }

  /** An attached target: an iframe gets its own inspect mode while the user chooses; anything else is let go. */
  private frameAttached(session: PickSession, params: unknown, parent: string | undefined): void {
    const child = field(params, "sessionId");
    if (typeof child !== "string") return;
    const info = field(params, "targetInfo");
    const frameId = field(info, "targetId");
    const { lease } = session;
    // Auto-attach never asks to pause; resume a frame that waits anyway, so it never hangs.
    if (field(params, "waitingForDebugger") === true)
      quiet([
        lease.send(
          "Runtime.runIfWaitingForDebugger",
          {},
          {
            timeoutMs: CLEANUP_TIMEOUT_MS,
            sessionId: child,
          },
        ),
      ]);
    if (
      field(info, "type") === "iframe" &&
      typeof frameId === "string" &&
      session.autoAttach &&
      session.phase === "picking"
    ) {
      session.frames.set(child, { frameId, parent });
      void this.armFrame(session, child);
      return;
    }
    quiet([
      lease.send(
        "Target.detachFromTarget",
        { sessionId: child },
        { timeoutMs: CLEANUP_TIMEOUT_MS },
      ),
    ]);
  }

  /** Inspect mode in an attached iframe, and auto-attach for the frames inside it. */
  private async armFrame(session: PickSession, child: string): Promise<void> {
    const { lease } = session;
    const options = { timeoutMs: START_TIMEOUT_MS, sessionId: child };
    // Disarming clears the frames, so this also stops once the pick chose or ended.
    const armed = () => session.frames.has(child);
    try {
      await lease.send("DOM.enable", {}, options);
      if (!armed()) return;
      await lease.send("Overlay.enable", {}, options);
      if (!armed()) return;
      await lease.send(
        "Overlay.setInspectMode",
        { mode: "searchForNode", highlightConfig: PICKER_HIGHLIGHT },
        options,
      );
      if (!armed()) return;
      await this.autoAttach(session, child);
    } catch {
      // A frame that cannot be armed lets its clicks through, as before; the pick goes on.
    }
  }

  /**
   * Turns the page's auto-attach off and lets go of every frame the pick attached (a frame's
   * inspect mode ends with its session). Returns the commands sent.
   */
  private disarmFrames(session: PickSession): Array<Promise<unknown>> {
    const { lease, contents } = session;
    const children = Array.from(session.frames.keys());
    const autoAttach = session.autoAttach;
    session.frames.clear();
    session.autoAttach = false;
    if ((!autoAttach && children.length === 0) || !lease.holds("picker") || contents.isDestroyed())
      return [];
    const options = { timeoutMs: CLEANUP_TIMEOUT_MS };
    const sent: Array<Promise<unknown>> = [];
    if (autoAttach) sent.push(lease.send("Target.setAutoAttach", NO_AUTO_ATTACH, options));
    for (const child of children)
      sent.push(lease.send("Target.detachFromTarget", { sessionId: child }, options));
    quiet(sent);
    return sent;
  }

  /** The id of the outermost attached frame at or above `child`: its element is in the page. */
  private topFrame(session: PickSession, child: string): string | undefined {
    let frame = session.frames.get(child);
    for (let hops = 0; frame?.parent !== undefined && hops < session.frames.size; hops += 1)
      frame = session.frames.get(frame.parent);
    return frame?.parent === undefined ? frame?.frameId : undefined;
  }

  private async describe(tab: string, session: PickSession, target: PickTarget): Promise<void> {
    session.phase = "describing";
    clearTimeout(session.timer);
    const pageNode =
      "backendNodeId" in target && typeof target.backendNodeId === "number"
        ? target.backendNodeId
        : undefined;
    // A click inside an out-of-process iframe picks that frame's element in the page.
    const frameId =
      "frameSession" in target ? this.topFrame(session, target.frameSession) : undefined;
    // The frames stop choosing too.
    this.disarmFrames(session);
    const { lease, contents } = session;
    try {
      await lease.send("Overlay.setInspectMode", INSPECT_MODE_OFF, { timeoutMs: START_TIMEOUT_MS });
      if (!this.current(tab, session)) return;
      const reported = pageNode ?? (await this.frameOwner(session, frameId));
      if (!this.current(tab, session)) return;
      const resolved = await this.resolve(tab, session, reported);
      if (resolved === null) return;
      // The reported node, or an out-of-process frame's owner, may sit in a same-process frame.
      const node = await this.pageElement(tab, session, resolved, reported);
      if (node === null) return;
      let value: unknown;
      try {
        if (!this.current(tab, session)) return;
        const response = await lease.send(
          "Runtime.callFunctionOn",
          {
            objectId: node.objectId,
            functionDeclaration: BROWSER_ELEMENT_DESCRIBE_FUNCTION,
            returnByValue: true,
          },
          { timeoutMs: START_TIMEOUT_MS },
        );
        if (field(response, "exceptionDetails") !== undefined) throw new Error(UNDESCRIBABLE);
        value = field(field(response, "result"), "value");
      } finally {
        await this.releaseObject(session, node.objectId);
      }
      if (!this.current(tab, session)) return;
      const title = await this.pageTitle(session);
      if (!this.current(tab, session)) return;
      const element = this.element(value, contents, title);
      // Cosmetic: the element is described, so a failed highlight (the page just removed the node,
      // a busy page) does not fail the pick.
      await lease
        .send(
          "Overlay.highlightNode",
          { backendNodeId: node.backendNodeId, highlightConfig: PICKED_HIGHLIGHT },
          { timeoutMs: START_TIMEOUT_MS },
        )
        .catch(() => undefined);
      if (!this.current(tab, session)) return;
      session.phase = "picked";
      this.publish();
      this.settle(session, { kind: "picked", element });
    } catch (error) {
      if (!this.current(tab, session)) return;
      const message = errorMessage(error);
      void this.close(
        tab,
        session,
        new Error(message === UNRESOLVABLE ? UNRESOLVABLE : UNDESCRIBABLE),
      );
    }
  }

  /** The page element (`<iframe>`, `<frame>`) of an out-of-process frame. */
  private async frameOwner(session: PickSession, frameId: string | undefined): Promise<number> {
    if (frameId === undefined) throw new Error(UNRESOLVABLE);
    let owner: unknown;
    try {
      owner = await session.lease.send(
        "DOM.getFrameOwner",
        { frameId },
        { timeoutMs: START_TIMEOUT_MS },
      );
    } catch (error) {
      throw new Error(UNRESOLVABLE, { cause: error });
    }
    const backendNodeId = field(owner, "backendNodeId");
    if (typeof backendNodeId !== "number") throw new Error(UNRESOLVABLE);
    return backendNodeId;
  }

  /**
   * The picked node as an element of the page. Chromium's inspect tool also reports nodes inside
   * same-process (same-site) iframes, and DOM.resolveNode wraps them in the page's world; such a
   * pick becomes the frame's outermost element in the page, like a click in an out-of-process frame
   * (BROWSER_ELEMENT_PAGE_NODE_FUNCTION). Owns `objectId`: returns it, or releases it for the frame
   * element's. Null once the session ended.
   */
  private async pageElement(
    tab: string,
    session: PickSession,
    objectId: string,
    backendNodeId: number,
  ): Promise<{ readonly objectId: string; readonly backendNodeId: number } | null> {
    const { lease } = session;
    const options = { timeoutMs: START_TIMEOUT_MS };
    let frame: string | undefined;
    try {
      const response = await lease.send(
        "Runtime.callFunctionOn",
        { objectId, functionDeclaration: BROWSER_ELEMENT_PAGE_NODE_FUNCTION },
        options,
      );
      const result = field(response, "result");
      const failed = field(response, "exceptionDetails") !== undefined;
      if (!failed && field(result, "type") === "undefined") return { objectId, backendNodeId };
      const id = field(result, "objectId");
      // null: a frame on the way is out of reach (another origin).
      if (failed || typeof id !== "string") throw new Error(UNRESOLVABLE);
      frame = id;
    } catch (error) {
      await this.releaseObject(session, objectId);
      throw new Error(UNRESOLVABLE, { cause: error });
    }
    await this.releaseObject(session, objectId);
    try {
      if (!this.current(tab, session)) return null;
      const described = await lease.send("DOM.describeNode", { objectId: frame }, options);
      const frameNode = field(field(described, "node"), "backendNodeId");
      if (typeof frameNode !== "number") throw new Error(UNRESOLVABLE);
      if (!this.current(tab, session)) return null;
      const element = { objectId: frame, backendNodeId: frameNode };
      frame = undefined;
      return element;
    } catch (error) {
      throw new Error(UNRESOLVABLE, { cause: error });
    } finally {
      if (frame !== undefined) await this.releaseObject(session, frame);
    }
  }

  /** The picked node in the picker's isolated world, or null once the session ended. */
  private async resolve(
    tab: string,
    session: PickSession,
    backendNodeId: number,
  ): Promise<string | null> {
    const { lease } = session;
    let world = await this.world(tab, session, false);
    for (;;) {
      if (world === null || !this.current(tab, session)) return null;
      let response: unknown;
      try {
        response = await lease.send(
          "DOM.resolveNode",
          { backendNodeId, executionContextId: world.contextId },
          { timeoutMs: START_TIMEOUT_MS },
        );
      } catch (error) {
        // Blink reports a context that is gone like a node of another document ("does not belong
        // to the document"), so a cached world gets one fresh try unless the node itself is gone.
        if (world.cached && !NODE_GONE.test(errorMessage(error))) {
          if (!this.current(tab, session)) return null;
          world = await this.world(tab, session, true);
          continue;
        }
        throw new Error(UNRESOLVABLE, { cause: error });
      }
      const objectId = field(field(response, "object"), "objectId");
      if (typeof objectId !== "string") throw new Error(UNRESOLVABLE);
      if (this.current(tab, session)) return objectId;
      await this.releaseObject(session, objectId);
      return null;
    }
  }

  /**
   * The context id of the tab's `ryco-element-picker` world for the current document, created once
   * per document (each world is a V8 context in the page); null once the session ended.
   */
  private async world(
    tab: string,
    session: PickSession,
    fresh: boolean,
  ): Promise<{ readonly contextId: number; readonly cached: boolean } | null> {
    const { lease } = session;
    const tree = await lease.send("Page.getFrameTree", {}, { timeoutMs: START_TIMEOUT_MS });
    if (!this.current(tab, session)) return null;
    const frame = field(field(tree, "frameTree"), "frame");
    const frameId = field(frame, "id");
    const loaderId = field(frame, "loaderId");
    if (typeof frameId !== "string" || typeof loaderId !== "string") throw new Error(UNRESOLVABLE);
    const document = `${frameId}:${loaderId}`;
    const cached = this.worlds.get(tab);
    if (!fresh && cached?.document === document)
      return { contextId: cached.contextId, cached: true };
    const world = await lease.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: WORLD_NAME },
      { timeoutMs: START_TIMEOUT_MS },
    );
    const contextId = field(world, "executionContextId");
    if (typeof contextId !== "number") throw new Error(UNRESOLVABLE);
    if (!this.current(tab, session)) return null;
    this.worlds.set(tab, { document, contextId });
    return { contextId, cached: false };
  }

  /**
   * The page's own title, from its current history entry: empty when it has none. Not
   * webContents.getTitle(), which stands in the URL, query and hash included, for an untitled page.
   * A failed lookup only loses the title, never the pick.
   */
  private async pageTitle(session: PickSession): Promise<string> {
    const history = await session.lease
      .send("Page.getNavigationHistory", {}, { timeoutMs: START_TIMEOUT_MS })
      .catch(() => undefined);
    const index = field(history, "currentIndex");
    const entries = field(history, "entries");
    if (typeof index !== "number" || !Array.isArray(entries)) return "";
    const title = field(entries[index], "title");
    return typeof title === "string" ? title : "";
  }

  /** The bounded, redacted element, with the browser's URL and the page's title; throws when it is not one. */
  private element(
    value: unknown,
    contents: PickContents,
    title: string,
  ): ProjectBrowserPickedElement {
    if (contents.isDestroyed()) throw new Error(UNDESCRIBABLE);
    const element = normalizeBrowserElementPick(value, { url: contents.getURL(), title });
    if (!element) throw new Error(UNDESCRIBABLE);
    try {
      return Schema.decodeUnknownSync(ProjectBrowserPickedElement)(element);
    } catch (error) {
      throw new Error(UNDESCRIBABLE, { cause: error });
    }
  }

  private async releaseObject(session: PickSession, objectId: string): Promise<void> {
    const { lease, contents } = session;
    // Whenever the session is still open, even after this pick ended: the object would leak.
    if (!lease.isAttached() || contents.isDestroyed()) return;
    await lease
      .send("Runtime.releaseObject", { objectId }, { timeoutMs: CLEANUP_TIMEOUT_MS })
      .catch(() => undefined);
  }

  private settle(session: PickSession, outcome: ProjectBrowserPickResult | Error): void {
    if (session.settled) return;
    session.settled = true;
    if (outcome instanceof Error) session.reject(outcome);
    else session.resolve(outcome);
  }

  /** Removes the session, settles its pick and lets go of its frames; returns those commands. */
  private retire(
    tab: string,
    session: PickSession,
    outcome: ProjectBrowserPickResult | Error,
  ): Array<Promise<unknown>> {
    this.sessions.delete(tab);
    for (const unsubscribe of session.unsubscribers.splice(0)) unsubscribe();
    clearTimeout(session.timer);
    this.settle(session, outcome);
    return this.disarmFrames(session);
  }

  /** Removes the session at once, settles its pick, then cleans up its page state. */
  private close(
    tab: string,
    session: PickSession,
    outcome: ProjectBrowserPickResult | Error,
  ): Promise<void> {
    const phase = session.phase;
    const disarming = this.retire(tab, session, outcome);
    this.publish();
    const cleanup = this.cleanup(session, phase, disarming).finally(() => {
      if (this.cleanups.get(tab) === cleanup) this.cleanups.delete(tab);
    });
    this.cleanups.set(tab, cleanup);
    return cleanup;
  }

  private async cleanup(
    session: PickSession,
    phase: Phase,
    disarming: ReadonlyArray<Promise<unknown>>,
  ): Promise<void> {
    const { lease, contents } = session;
    try {
      if (lease.holds("picker") && !contents.isDestroyed()) {
        // Sent back to back, so CDP handles them in order. They queue behind the session's ready
        // steps like the start's commands, so an enable still waiting there cannot overtake them.
        const options = { timeoutMs: CLEANUP_TIMEOUT_MS };
        const commands: Array<Promise<unknown>> = [...disarming];
        if (phase !== "picked")
          commands.push(lease.send("Overlay.setInspectMode", INSPECT_MODE_OFF, options));
        commands.push(
          lease.send("Overlay.hideHighlight", {}, options),
          lease.send("Overlay.disable", {}, options),
          lease.send("DOM.disable", {}, options),
        );
        await Promise.allSettled(commands);
      }
    } finally {
      lease.release("picker");
    }
  }
}
