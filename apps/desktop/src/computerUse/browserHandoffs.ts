/**
 * The desktop's part of handing a Ryco browser tab to the user (`ryco_browser` action `handoff`):
 * the node keeps the request (the card, the answer, the wait, `userActionRequests.ts`) and asks
 * this bridge (`POST /handoff`) to give the tab to the user, to probe its condition, and to give
 * it back.
 *
 * While the user has the tab, no agent can read or use it (`refusal`, checked before every
 * `ryco_browser` action), the budget keeps it live, the Browser panel marks it, and what the page
 * logs and sends is withheld from the tab's diagnostics. Before the tab is given back, password
 * and one-time-code fields still on the page are emptied in every frame; if that fails, the tab
 * stays with the user (`stillPaused`), so nothing they typed becomes readable.
 *
 * Runs outside the computer-use action queue (`policy.ts`): a hand-off waits on a person, and
 * other threads' browser use must not wait with it. Its own work is a few bounded page
 * evaluations.
 *
 * @module computerUse/browserHandoffs
 */
import type {
  BrowserHandoffBridgeRequest,
  BrowserHandoffBridgeResponse,
  BrowserHandoffDoneWhen,
  BrowserHandoffPage,
} from "@ryco/contracts/browser-handoff";
import { randomBytes } from "node:crypto";

import type { ProjectBrowserTab, UserActionNeed, UserActionOutcome } from "@ryco/contracts";
import {
  coalesceInput,
  isDroppedHandoffInput,
  makeNodeBrowserPressedState,
  nodeBrowserInputCommands,
  releaseHeldCommands,
  type NodeBrowserCdpCommand,
  type NodeBrowserPressedState,
} from "@ryco/shared/nodeBrowserInputCdp";
import {
  BROWSER_HANDOFF_SETTLE_MS,
  BROWSER_SCRUB_SCRIPT,
  BROWSER_TRACK_SECRET_FIELDS_SCRIPT,
  browserDoneWhenHolds,
  browserTabLabelAtStart,
  browserProbeExpression,
  parseBrowserProbe,
  validateBrowserDoneWhen,
  type BrowserPageProbe,
} from "@ryco/shared/browserHandoff";

/** What the controller needs of the Ryco browser (EmbeddedComputerBrowser). */
export interface BrowserHandoffHost {
  hasTab(tab: string): boolean;
  tabUrl(tab: string): string;
  setHandoff(tab: string, handoff: NonNullable<ProjectBrowserTab["handoff"]> | null): void;
  evaluateInFrames(
    tab: string,
    code: string,
    options: { allFrames: boolean; timeoutMs: number },
  ): Promise<unknown[]>;
  /** Withholds what the tab logs and sends, on every page it gets, until `endWithholding`. */
  beginWithholding(tab: string): void;
  /**
   * Takes the tab from every agent: agent work in flight on it is cut off and refused, and this
   * resolves once none is left (false: it could not, or the tab is gone). Until `releaseAgents`,
   * every agent path into the page refuses.
   */
  holdAgents(tab: string): Promise<boolean>;
  releaseAgents(tab: string): void;
  endWithholding(tab: string): { requests: number; messages: number };
  /** Remote view: a frame of the tab (EmbeddedComputerBrowser.captureHandoffFrame). */
  captureHandoffFrame(
    tab: string,
    options: { readonly maxWidth: number; readonly maxHeight: number; readonly quality: number },
  ): Promise<{
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly width: number;
    readonly height: number;
    readonly fingerprint: string;
    readonly encode: () => Buffer;
  }>;
  /** Remote input: CDP commands on the tab's page, held apart from the agent's. */
  sendHandoffInput(tab: string, commands: ReadonlyArray<NodeBrowserCdpCommand>): Promise<void>;
  releaseHandoffInput(tab: string): void;
  handoffViewport(tab: string): { width: number; height: number } | null;
}

const PROBE_TIMEOUT_MS = 2_000;
const TRACK_TIMEOUT_MS = 1_000;
const SCRUB_TIMEOUT_MS = 3_000;
/** How long `end` lets a page that the user just finished on load before describing it. */
const END_LOAD_WAIT_MS = 3_000;
/** The desktop gives a tab back by itself this long after the node's own expiry should have. */
const SAFETY_GRACE_MS = 60_000;
/** Ended hand-offs remembered for a repeated `end` (the agent's call after the card's answer). */
const ENDED_KEPT = 64;

interface Handoff {
  readonly requestId: string;
  readonly threadId: string;
  readonly tab: string;
  readonly message: string;
  readonly need: UserActionNeed;
  readonly doneWhen: BrowserHandoffDoneWhen | undefined;
  readonly since: number;
  metSince: number | null;
  /** Set while it is being given back: the tab is still the user's meanwhile. */
  ending: Promise<BrowserHandoffBridgeResponse> | null;
  /** The scrub failed: the tab stays with the user until a later `end` succeeds. */
  stuck: boolean;
  readonly safety: ReturnType<typeof setTimeout>;
  /**
   * The remote viewer token: random per hand-off and process, a generation marker, not a secret
   * (`view` returns it to the bridge's caller, the node). Frames and input must name it, the
   * request and the tab; it dies with the hand-off (`gone`), and a token of an earlier hand-off or
   * process is `stale`.
   */
  readonly viewer: string;
  /** Keys and buttons the remote user holds down, let go of before the tab is given back. */
  readonly pressed: NodeBrowserPressedState;
  /** Remote input is dispatched one batch at a time, in order. */
  inputs: Promise<unknown>;
}

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export class BrowserHandoffs {
  private readonly byTab = new Map<string, Handoff>();
  private readonly byRequest = new Map<string, Handoff>();
  /** Hand-offs being begun: agents are already refused (their thread and message, for the text). */
  private readonly starting = new Map<string, { threadId: string; message: string }>();
  private readonly ended = new Map<
    string,
    Extract<BrowserHandoffBridgeResponse, { status: "ended" }>
  >();
  private readonly host: BrowserHandoffHost;
  private readonly now: () => number;
  private readonly enabled: () => boolean;

  constructor(
    host: BrowserHandoffHost,
    options: {
      now?: () => number;
      /** Whether the Ryco browser is enabled in Computer use settings; read on every request. */
      enabled?: () => boolean;
    } = {},
  ) {
    this.host = host;
    this.now = options.now ?? Date.now;
    this.enabled = options.enabled ?? (() => true);
  }

  /**
   * Why an agent's `ryco_browser` action on `tab` is refused, or null when the tab is not with the
   * user. Every action is refused, reads included: the page shows what the user types.
   */
  refusal(tab: string, threadId: string): string | null {
    const handoff = this.byTab.get(tab) ?? this.starting.get(tab);
    if (!handoff) return null;
    if (handoff.threadId === threadId) {
      return `${browserTabLabelAtStart(tab)} is with the user for your request ("${clip(handoff.message, 80)}"). Do not use it meanwhile: call ryco_browser action "handoff" again with the same requestId to wait until they are done. Your other tabs still work.`;
    }
    return `${browserTabLabelAtStart(tab)} is with the user for another thread's request, so no agent can read or use it until they are done. Open your own tab (action "open") or try later.`;
  }

  /** Whether `tab` is with the user now (the tab list marks it). */
  isHandedOff(tab: string): boolean {
    return this.byTab.has(tab) || this.starting.has(tab);
  }

  async handle(request: BrowserHandoffBridgeRequest): Promise<BrowserHandoffBridgeResponse> {
    switch (request.op) {
      case "begin":
        if (!this.enabled()) {
          return {
            status: "refused",
            text: "The Ryco browser is disabled in Computer use settings.",
          };
        }
        return this.begin(request);
      case "probe":
        // The Ryco browser was turned off: a pending hand-off is over. `missing` makes the node
        // end it as cancelled; its `end` then gives the tab back (scrubbed) as always.
        if (!this.enabled() && this.byRequest.has(request.requestId)) return { status: "missing" };
        return this.probe(request.requestId);
      case "end":
        return this.end(request.requestId, request.outcome);
      case "view":
      case "frame":
      case "input":
        return this.remote(request);
    }
  }

  /**
   * The gate of remote view and input: only a hand-off this desktop itself tracks as pending, for
   * that request and that tab, not ending (a scrub in progress), and with its current viewer token.
   * Everything else is refused: `gone` (no such pending hand-off, or the Ryco browser turned off
   * in Computer use settings), `refused` (another tab), `stale` (an earlier hand-off's or
   * process's viewer token). The node checks the owner role and the request before it asks; this
   * is the desktop's own check of its own state. Who may ask at all is the bridge's bearer token
   * (`runtime.ts`): only the node holds it. The viewer token is no second authentication: `view`
   * hands it to any bridge caller. It marks the hand-off's generation, so a caller still holding
   * an earlier hand-off's token (the same tab handed off again, a restarted desktop) is `stale`
   * rather than served the new one by accident.
   */
  private remoteGate(
    request: Extract<BrowserHandoffBridgeRequest, { op: "view" | "frame" | "input" }>,
  ): Handoff | Extract<BrowserHandoffBridgeResponse, { status: "gone" | "stale" | "refused" }> {
    const handoff = this.byRequest.get(request.requestId);
    if (
      !this.enabled() ||
      !handoff ||
      handoff.ending !== null ||
      this.byTab.get(handoff.tab) !== handoff
    ) {
      return { status: "gone" };
    }
    if (handoff.tab !== request.tab) {
      return { status: "refused", text: "That tab is not the one handed to the user." };
    }
    if (!this.host.hasTab(handoff.tab)) return { status: "gone" };
    if (request.op !== "view" && request.viewer !== handoff.viewer) return { status: "stale" };
    return handoff;
  }

  private async remote(
    request: Extract<BrowserHandoffBridgeRequest, { op: "view" | "frame" | "input" }>,
  ): Promise<BrowserHandoffBridgeResponse> {
    const gate = this.remoteGate(request);
    if (!("requestId" in gate)) return gate;
    const handoff = gate;
    if (request.op === "view") {
      const viewport = this.host.handoffViewport(handoff.tab) ?? { width: 0, height: 0 };
      return {
        status: "viewing",
        viewer: handoff.viewer,
        cssWidth: viewport.width,
        cssHeight: viewport.height,
      };
    }
    if (request.op === "frame") {
      const frame = await this.host.captureHandoffFrame(handoff.tab, request);
      // Ended while it was captured: nothing of the page leaves after the hand-off.
      if (this.remoteGate(request) !== handoff) return { status: "gone" };
      if (request.since !== undefined && request.since === frame.fingerprint) {
        return { status: "unchanged" };
      }
      return {
        status: "frame",
        jpeg: frame.encode().toString("base64"),
        width: frame.width,
        height: frame.height,
        cssWidth: frame.cssWidth,
        cssHeight: frame.cssHeight,
        fingerprint: frame.fingerprint,
      };
    }
    // Batches in order; each one is checked again when its turn comes.
    const run = handoff.inputs.then(async () => {
      if (this.remoteGate(request) !== handoff) return false;
      const viewport = this.host.handoffViewport(handoff.tab);
      if (viewport === null) return false;
      // App-level chords (close, quit, reload, devtools…) never reach the tab: Electron routes
      // unhandled keys to menu accelerators on Windows and Linux. Nor do key pastes (the desktop's
      // clipboard; the viewer's paste arrives as text) or middle clicks (a link in a new tab).
      const commands = coalesceInput(request.events)
        .filter((event) => !isDroppedHandoffInput(event))
        .flatMap((event) => nodeBrowserInputCommands(event, handoff.pressed, viewport));
      await this.host.sendHandoffInput(handoff.tab, commands);
      return true;
    });
    handoff.inputs = run.catch(() => undefined);
    return (await run) ? { status: "accepted" } : { status: "gone" };
  }

  private async begin(
    request: Extract<BrowserHandoffBridgeRequest, { op: "begin" }>,
  ): Promise<BrowserHandoffBridgeResponse> {
    const repeated = this.byRequest.get(request.requestId);
    if (repeated) return { status: "handed-off", remoteView: true };
    if (!this.host.hasTab(request.tab)) {
      return { status: "refused", text: "Tab is no longer available. List tabs again." };
    }
    const problem = validateBrowserDoneWhen(request.doneWhen);
    if (problem) return { status: "refused", text: problem };
    if (this.byTab.has(request.tab) || this.starting.has(request.tab)) {
      return {
        status: "refused",
        text: `${request.tab} is already with the user for another request. Wait for it to end.`,
      };
    }
    // From here no agent reads or uses the tab: actions in flight on it are cut off and what they
    // read is dropped, later and queued ones are refused, before anything is handed over.
    this.starting.set(request.tab, { threadId: request.threadId, message: request.message });
    let handedOff = false;
    try {
      if (!(await this.host.holdAgents(request.tab))) {
        return {
          status: "refused",
          text: this.host.hasTab(request.tab)
            ? `An agent action on ${request.tab} did not stop in time. Try the hand-off again.`
            : "Tab is no longer available. List tabs again.",
        };
      }
      const response = await this.beginHeld(request);
      handedOff = response.status === "handed-off";
      return response;
    } finally {
      this.starting.delete(request.tab);
      if (!handedOff) this.host.releaseAgents(request.tab);
    }
  }

  /** `begin` once agents are off the tab. */
  private async beginHeld(
    request: Extract<BrowserHandoffBridgeRequest, { op: "begin" }>,
  ): Promise<BrowserHandoffBridgeResponse> {
    // Nothing to hand over when the condition already holds.
    const first = await this.loadedProbe(request.tab, request.doneWhen, true, END_LOAD_WAIT_MS);
    if (first?.selector === "invalid") {
      return {
        status: "refused",
        text: `done_when.selector "${request.doneWhen?.selector ?? ""}" is not a valid CSS selector.`,
      };
    }
    if (request.doneWhen && first && browserDoneWhenHolds(request.doneWhen, first)) {
      return { status: "already-met", page: pageOf(first) };
    }
    // The tab may have closed or been handed over while the probe ran.
    if (!this.host.hasTab(request.tab)) {
      return { status: "refused", text: "Tab is no longer available. List tabs again." };
    }
    if (this.byTab.has(request.tab)) {
      return {
        status: "refused",
        text: `${request.tab} is already with the user for another request. Wait for it to end.`,
      };
    }
    const handoff: Handoff = {
      requestId: request.requestId,
      threadId: request.threadId,
      tab: request.tab,
      message: request.message,
      need: request.need,
      doneWhen: request.doneWhen,
      since: this.now(),
      metSince: null,
      ending: null,
      stuck: false,
      viewer: randomBytes(16).toString("hex"),
      pressed: makeNodeBrowserPressedState(),
      inputs: Promise.resolve(),
      safety: setTimeout(
        () => void this.end(request.requestId, "timeout"),
        request.ttlMs + SAFETY_GRACE_MS,
      ),
    };
    // A safety timer must never keep the process alive.
    (handoff.safety as { unref?: () => void }).unref?.();
    this.byTab.set(request.tab, handoff);
    this.byRequest.set(request.requestId, handoff);
    this.host.beginWithholding(request.tab);
    await this.trackSecretFields(request.tab);
    this.host.setHandoff(request.tab, {
      thread: request.threadId,
      request: request.requestId,
      need: request.need,
      message: request.message,
    });
    return { status: "handed-off", remoteView: true };
  }

  private async probe(requestId: string): Promise<BrowserHandoffBridgeResponse> {
    const handoff = this.byRequest.get(requestId);
    if (!handoff) {
      const ended = this.ended.get(requestId);
      return ended ? { status: "active", met: false } : { status: "missing" };
    }
    if (handoff.ending) return { status: "active", met: false };
    if (!this.host.hasTab(handoff.tab)) return { status: "closed" };
    // New documents and frames since the last tick get their secret fields marked too.
    await this.trackSecretFields(handoff.tab);
    if (!handoff.doneWhen) return { status: "active", met: false };
    const probe = await this.probeOnce(handoff.tab, handoff.doneWhen, false);
    const now = this.now();
    // Between documents only a URL condition can be checked.
    const holds = probe
      ? browserDoneWhenHolds(handoff.doneWhen, probe)
      : !handoff.doneWhen.text &&
        !handoff.doneWhen.gone &&
        !handoff.doneWhen.selector &&
        browserDoneWhenHolds(handoff.doneWhen, { href: this.host.tabUrl(handoff.tab) });
    if (!holds) {
      handoff.metSince = null;
      return { status: "active", met: false };
    }
    handoff.metSince ??= now;
    // Settled: the page finished loading, or it has held for a while (a page that never loads).
    const settled =
      probe?.ready === "complete" || now - handoff.metSince >= BROWSER_HANDOFF_SETTLE_MS;
    return { status: "active", met: settled };
  }

  /**
   * Gives the tab back: empties secret fields in every frame, stops withholding, and only then
   * lets agents use it. Idempotent: a repeated `end` answers what the first one did.
   */
  private async end(
    requestId: string,
    outcome: UserActionOutcome,
  ): Promise<BrowserHandoffBridgeResponse> {
    const earlier = this.ended.get(requestId);
    if (earlier) return earlier;
    const handoff = this.byRequest.get(requestId);
    if (!handoff) return { status: "missing" };
    handoff.ending ??= this.finish(handoff, outcome).finally(() => {
      handoff.ending = null;
    });
    return handoff.ending;
  }

  private async finish(
    handoff: Handoff,
    outcome: UserActionOutcome,
  ): Promise<BrowserHandoffBridgeResponse> {
    const { tab } = handoff;
    const open = this.host.hasTab(tab);
    // Remote input already queued finishes first (the gate refuses new batches now that it is
    // ending), and anything the remote user held down is let go of, before the scrub.
    await handoff.inputs;
    if (open) {
      await this.host
        .sendHandoffInput(tab, releaseHeldCommands(handoff.pressed))
        .catch(() => undefined);
    }
    let scrubbed = 0;
    let scrubFailed = false;
    if (open) {
      const values = await this.host.evaluateInFrames(tab, BROWSER_SCRUB_SCRIPT, {
        allFrames: true,
        timeoutMs: SCRUB_TIMEOUT_MS,
      });
      // The main frame must answer: without it nothing says the fields are empty.
      if (values.length > 0 && typeof values[0] !== "number") scrubFailed = true;
      for (const value of values) if (typeof value === "number") scrubbed += value;
    }
    if (scrubFailed) {
      // Stays with the user; withholding goes on until a later end succeeds.
      const withheld = { requests: 0, messages: 0 };
      handoff.stuck = true;
      return {
        status: "ended",
        outcome,
        tab,
        url: this.host.tabUrl(tab),
        withheld,
        scrubbed,
        stillPaused: true,
        waitedMs: this.now() - handoff.since,
      };
    }
    const withheld = open ? this.host.endWithholding(tab) : { requests: 0, messages: 0 };
    if (open) this.host.releaseHandoffInput(tab);
    clearTimeout(handoff.safety);
    this.byTab.delete(tab);
    this.byRequest.delete(handoff.requestId);
    this.host.releaseAgents(tab);
    if (open) this.host.setHandoff(tab, null);
    const page =
      open && outcome !== "closed"
        ? await this.loadedProbe(
            tab,
            undefined,
            true,
            outcome === "done" || outcome === "condition-met" ? END_LOAD_WAIT_MS : 0,
          )
        : undefined;
    const response: Extract<BrowserHandoffBridgeResponse, { status: "ended" }> = {
      status: "ended",
      outcome: open ? outcome : "closed",
      tab,
      url: open ? this.host.tabUrl(tab) : "about:blank",
      ...(page ? { page: pageOf(page) } : {}),
      withheld,
      scrubbed,
      stillPaused: false,
      waitedMs: this.now() - handoff.since,
    };
    this.ended.set(handoff.requestId, response);
    if (this.ended.size > ENDED_KEPT) {
      const oldest = this.ended.keys().next().value;
      if (oldest !== undefined) this.ended.delete(oldest);
    }
    return response;
  }

  private async trackSecretFields(tab: string): Promise<void> {
    await this.host.evaluateInFrames(tab, BROWSER_TRACK_SECRET_FIELDS_SCRIPT, {
      allFrames: true,
      timeoutMs: TRACK_TIMEOUT_MS,
    });
  }

  private async probeOnce(
    tab: string,
    doneWhen: BrowserHandoffDoneWhen | undefined,
    describe: boolean,
  ): Promise<BrowserPageProbe | undefined> {
    const [value] = await this.host.evaluateInFrames(
      tab,
      browserProbeExpression(doneWhen, describe),
      { allFrames: false, timeoutMs: PROBE_TIMEOUT_MS },
    );
    return parseBrowserProbe(value);
  }

  /** Probes until the page has loaded or `waitMs` passed. */
  private async loadedProbe(
    tab: string,
    doneWhen: BrowserHandoffDoneWhen | undefined,
    describe: boolean,
    waitMs: number,
  ): Promise<BrowserPageProbe | undefined> {
    const deadline = this.now() + waitMs;
    for (;;) {
      const probe = await this.probeOnce(tab, doneWhen, describe);
      if ((probe && probe.ready === "complete") || this.now() >= deadline || !this.host.hasTab(tab))
        return probe;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Ends every hand-off (the app quits): nothing stays withheld in a process that is going away. */
  dispose(): void {
    for (const handoff of this.byTab.values()) clearTimeout(handoff.safety);
    this.byTab.clear();
    this.byRequest.clear();
  }
}

function pageOf(probe: BrowserPageProbe): BrowserHandoffPage {
  return {
    href: probe.href,
    title: probe.title,
    ready: probe.ready,
    ...(probe.heading === undefined ? {} : { heading: probe.heading }),
    ...(probe.secretFields === undefined ? {} : { secretFields: probe.secretFields }),
  };
}
