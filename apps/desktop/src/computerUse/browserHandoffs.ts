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
import type { ProjectBrowserTab, UserActionNeed, UserActionOutcome } from "@ryco/contracts";
import {
  BROWSER_HANDOFF_SETTLE_MS,
  BROWSER_SCRUB_SCRIPT,
  BROWSER_TRACK_SECRET_FIELDS_SCRIPT,
  browserDoneWhenHolds,
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
  endWithholding(tab: string): { requests: number; messages: number };
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
}

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export class BrowserHandoffs {
  private readonly byTab = new Map<string, Handoff>();
  private readonly byRequest = new Map<string, Handoff>();
  private readonly ended = new Map<
    string,
    Extract<BrowserHandoffBridgeResponse, { status: "ended" }>
  >();
  private readonly host: BrowserHandoffHost;
  private readonly now: () => number;

  constructor(host: BrowserHandoffHost, options: { now?: () => number } = {}) {
    this.host = host;
    this.now = options.now ?? Date.now;
  }

  /**
   * Why an agent's `ryco_browser` action on `tab` is refused, or null when the tab is not with the
   * user. Every action is refused, reads included: the page shows what the user types.
   */
  refusal(tab: string, threadId: string): string | null {
    const handoff = this.byTab.get(tab);
    if (!handoff) return null;
    if (handoff.threadId === threadId) {
      return `${tab} is with the user for your request ("${clip(handoff.message, 80)}"). Do not use it meanwhile: call ryco_browser action "handoff" again with the same requestId to wait until they are done. Your other tabs still work.`;
    }
    return `${tab} is with the user for another thread's request, so no agent can read or use it until they are done. Open your own tab (action "open") or try later.`;
  }

  /** Whether `tab` is with the user now (the tab list marks it). */
  isHandedOff(tab: string): boolean {
    return this.byTab.has(tab);
  }

  async handle(request: BrowserHandoffBridgeRequest): Promise<BrowserHandoffBridgeResponse> {
    switch (request.op) {
      case "begin":
        return this.begin(request);
      case "probe":
        return this.probe(request.requestId);
      case "end":
        return this.end(request.requestId, request.outcome);
    }
  }

  private async begin(
    request: Extract<BrowserHandoffBridgeRequest, { op: "begin" }>,
  ): Promise<BrowserHandoffBridgeResponse> {
    const repeated = this.byRequest.get(request.requestId);
    if (repeated) return { status: "handed-off" };
    if (!this.host.hasTab(request.tab)) {
      return { status: "refused", text: "Tab is no longer available. List tabs again." };
    }
    const problem = validateBrowserDoneWhen(request.doneWhen);
    if (problem) return { status: "refused", text: problem };
    if (this.byTab.has(request.tab)) {
      return {
        status: "refused",
        text: `${request.tab} is already with the user for another request. Wait for it to end.`,
      };
    }
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
    return { status: "handed-off" };
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
    clearTimeout(handoff.safety);
    this.byTab.delete(tab);
    this.byRequest.delete(handoff.requestId);
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
