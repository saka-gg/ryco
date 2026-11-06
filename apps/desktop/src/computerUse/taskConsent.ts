// Expiry semantics adapted from Synara v1.0.4 (d36a31a29); see docs/licenses/synara-computer-use.txt.
import type { ComputerConsentReply } from "@ryco/contracts";

/** An unanswered dialog closes after Synara's five-minute approval lifetime. */
export const COMPUTER_CONSENT_EXPIRY_MS = 5 * 60_000;
/**
 * One bridge request waits at most this long. Every Agent Control tool call is aborted at 60 s
 * (AGENT_CONTROL_MCP_REQUEST_TIMEOUT_MS) and the approved action still needs the rest of that budget.
 * A clipboard dialog belongs to one call, so this is also its whole lifetime.
 */
export const COMPUTER_CONSENT_WAIT_MS = 30_000;
/** After an expiry the agent may ask once more in the same turn, per consent kind. */
export const COMPUTER_CONSENT_RE_REQUESTS = 1;
/**
 * A dialog that never reached the user (no window, too many open, still queued behind another
 * sheet when its request ran out) refuses only that call. The agent may retry that this many
 * times in a row per consent kind; after that the turn stops asking instead of looping.
 */
export const COMPUTER_CONSENT_UNSHOWN_RETRIES = 2;
/** Dialogs open or waiting to be shown, across all tasks. */
export const COMPUTER_CONSENT_OPEN_LIMIT = 8;

export type ComputerConsentKind = "app" | "clipboard";
/** The app an approval dialog names. The server owns what its answer means. */
export interface ComputerConsentApp {
  readonly key: string;
  readonly name: string;
  /** False for a target that cannot be named; its dialog offers no "Always allow". */
  readonly canAlwaysAllow: boolean;
}
export type ComputerConsentRequest =
  | { readonly kind: "clipboard" }
  | { readonly kind: "app"; readonly app: ComputerConsentApp };
/** What came of one dialog: "accept" allows (an app for this chat), "always" always allows an app. */
export type ComputerConsentShown = "always" | "accept" | "decline" | "unavailable";
/**
 * Shows one dialog and reports what came of it. `onShown` is called once the dialog is on
 * screen, which is when its lifetime starts. A dialog closed by our signal reports "decline"
 * (Electron's cancel).
 */
export type ComputerConsentPrompt = (
  request: ComputerConsentRequest,
  signal: AbortSignal,
  onShown: () => void,
) => Promise<ComputerConsentShown | "busy">;
/** Presents one dialog right away; it calls `onShown` just before the dialog appears. */
export type ComputerConsentPresenter = (
  request: ComputerConsentRequest,
  signal: AbortSignal,
  onShown: () => void,
) => Promise<ComputerConsentShown>;

type Unshown = "unavailable" | "busy";
/** Distinct apps one turn may ask about; beyond it requests are refused as busy. */
export const COMPUTER_CONSENT_APPS_PER_TASK = 32;

/**
 * Shows consent dialogs one at a time, across every task. macOS holds a second sheet on the
 * same window, unseen, until the first is dismissed. This queue does that wait itself, so a
 * dialog's lifetime starts only once the user can see it, and a dialog closed while it waits
 * never counts as one the user left unanswered.
 */
export class ComputerConsentSheets {
  readonly #present: ComputerConsentPresenter;
  #open = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(present: ComputerConsentPresenter) {
    this.#present = present;
  }

  readonly prompt: ComputerConsentPrompt = async (request, signal, onShown) => {
    if (this.#open >= COMPUTER_CONSENT_OPEN_LIMIT) return "busy";
    this.#open += 1;
    const previous = this.#tail;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Chained on `previous` so a dialog that leaves the queue early never lets
    // the one behind it overtake the dialog still on screen.
    this.#tail = previous.then(() => turn);
    try {
      if (!(await settlesBeforeAbort(previous, signal))) return "decline";
      return await this.#present(request, signal, onShown);
    } finally {
      this.#open -= 1;
      release();
    }
  };
}

interface ConsentSlot {
  expired: number;
  /** Dialogs in a row that never reached the user, and why the last one did not. */
  unshown: { count: number; last: Unshown };
  /** The one app dialog every request for this app joins. */
  pending?: Promise<ComputerConsentReply> | undefined;
  /** The user's answer to a dialog whose requests had all stopped waiting. */
  unclaimed?: ComputerConsentReply | undefined;
}

/**
 * The dialogs of one Computer task (one thread turn), owned by the desktop.
 *
 * It only presents: the server decides what an answer means (per-app approval in
 * `ComputerApprovalGate`), so this keeps no grants. Each app has one dialog that every
 * request for that app joins; every clipboard request asks on its own. A dialog nobody
 * answered, a full prompt queue or a missing window refuses only the call that asked.
 * After an expiry the agent may ask once more for that app, and after a few dialogs in a
 * row that could not be shown it stops asking. An answer that lands after its requests
 * stopped waiting is handed to the next request for that app. Nothing here approves
 * without a click.
 */
export class ComputerTaskConsent {
  readonly #prompt: ComputerConsentPrompt;
  readonly #taskSignal: AbortSignal;
  readonly #slots = new Map<string, ConsentSlot>();

  constructor(prompt: ComputerConsentPrompt, taskSignal: AbortSignal) {
    this.#prompt = prompt;
    this.#taskSignal = taskSignal;
  }

  /**
   * Lock, sleep or a session switch: an answer given before it must not approve an action
   * after it, so answers no request collected yet are dropped. A dialog still open stays:
   * its answer postdates the interruption.
   */
  discardUnclaimedAnswers(): void {
    for (const slot of this.#slots.values()) slot.unclaimed = undefined;
  }

  #slot(key: string): ConsentSlot | undefined {
    let slot = this.#slots.get(key);
    if (slot) return slot;
    if (this.#slots.size > COMPUTER_CONSENT_APPS_PER_TASK) return undefined;
    slot = { expired: 0, unshown: { count: 0, last: "unavailable" } };
    this.#slots.set(key, slot);
    return slot;
  }

  async request(request: ComputerConsentRequest): Promise<ComputerConsentReply> {
    if (this.#taskSignal.aborted) return reply("stopped", false);
    const slot = this.#slot(request.kind === "app" ? `app:${request.app.key}` : "clipboard");
    if (!slot) return reply("busy", false);
    if (slot.unclaimed) {
      const answer = slot.unclaimed;
      slot.unclaimed = undefined;
      return answer;
    }
    if (slot.expired > COMPUTER_CONSENT_RE_REQUESTS) return reply("expired", false);
    if (slot.unshown.count > COMPUTER_CONSENT_UNSHOWN_RETRIES)
      return reply(slot.unshown.last, false);
    return request.kind === "app"
      ? this.#waitForAppDialog(request, slot)
      : this.#open(request, slot);
  }

  /** Joins the open dialog for this app, or opens it, and waits one request's share of it. */
  async #waitForAppDialog(
    request: ComputerConsentRequest,
    slot: ConsentSlot,
  ): Promise<ComputerConsentReply> {
    let dialog = slot.pending;
    if (!dialog) {
      const opened = this.#open(request, slot);
      slot.pending = opened;
      dialog = opened;
      void opened.then(
        (answer) => {
          if (slot.pending !== opened) return;
          slot.pending = undefined;
          // Kept for the next request; a request that is still waiting takes it below.
          if (answer.outcome === "accept" || answer.outcome === "decline") slot.unclaimed = answer;
        },
        () => {
          if (slot.pending === opened) slot.pending = undefined;
        },
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<"waited">((resolve) => {
      timer = setTimeout(() => resolve("waited"), COMPUTER_CONSENT_WAIT_MS);
    });
    try {
      // The dialog stays open past this request; the next request joins it.
      const answer = await Promise.race([dialog, waited]);
      if (answer === "waited") return reply("pending", true);
      if (slot.unclaimed === answer) slot.unclaimed = undefined;
      return answer;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One dialog, settled into the reply every request waiting on it gets. The
   * retry verdict is taken here, once per dialog, so concurrent dialogs each
   * report their own count rather than whatever a later one left behind.
   */
  async #open(request: ComputerConsentRequest, slot: ConsentSlot): Promise<ComputerConsentReply> {
    const expiry = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expireAfter = (ms: number) => {
      timer = setTimeout(() => expiry.abort(), ms);
    };
    // A clipboard dialog belongs to one bridge request, so its deadline runs
    // from the request, whether or not it has reached the screen yet.
    if (request.kind === "clipboard") expireAfter(COMPUTER_CONSENT_WAIT_MS);
    let shown = false;
    const onShown = () => {
      if (shown) return;
      shown = true;
      slot.unshown.count = 0;
      // An app dialog's five minutes start when the user can see it, not
      // while it waits behind another sheet.
      if (request.kind === "app") expireAfter(COMPUTER_CONSENT_EXPIRY_MS);
    };
    try {
      let result: Awaited<ReturnType<ComputerConsentPrompt>>;
      try {
        result = await this.#prompt(
          request,
          AbortSignal.any([this.#taskSignal, expiry.signal]),
          onShown,
        );
      } catch {
        result = "unavailable";
      }
      if (this.#taskSignal.aborted) return reply("stopped", false);
      // An Allow click wins even when it lands on the deadline.
      if (result === "accept" || result === "always") {
        if (request.kind !== "app") return reply("accept", false);
        const always = result === "always" && request.app.canAlwaysAllow;
        return { ...reply("accept", false), scope: always ? "always" : "chat" };
      }
      if (result === "decline") {
        if (!expiry.signal.aborted) return reply("decline", false);
        if (shown) {
          slot.expired += 1;
          return reply("expired", slot.expired <= COMPUTER_CONSENT_RE_REQUESTS);
        }
        // Its request ran out while another sheet still held the window.
        result = "busy";
      }
      slot.unshown.count += 1;
      slot.unshown.last = result;
      return reply(result, slot.unshown.count <= COMPUTER_CONSENT_UNSHOWN_RETRIES);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** True once `previous` settles, false as soon as `signal` aborts. */
function settlesBeforeAbort(previous: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(!signal.aborted);
    });
  });
}

function reply(outcome: ComputerConsentReply["outcome"], retryable: boolean): ComputerConsentReply {
  return { approved: outcome === "accept", outcome, retryable };
}
