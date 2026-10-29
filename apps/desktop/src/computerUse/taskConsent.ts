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

export type ComputerConsentKind = "task" | "clipboard";
/**
 * Shows one dialog and reports what came of it. `onShown` is called once the dialog is on
 * screen, which is when its lifetime starts. A dialog closed by our signal reports "decline"
 * (Electron's cancel).
 */
export type ComputerConsentPrompt = (
  kind: ComputerConsentKind,
  signal: AbortSignal,
  onShown: () => void,
) => Promise<"accept" | "decline" | "unavailable" | "busy">;
/** Presents one dialog right away; it calls `onShown` just before the dialog appears. */
export type ComputerConsentPresenter = (
  kind: ComputerConsentKind,
  signal: AbortSignal,
  onShown: () => void,
) => Promise<"accept" | "decline" | "unavailable">;

type Unshown = "unavailable" | "busy";

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

  readonly prompt: ComputerConsentPrompt = async (kind, signal, onShown) => {
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
      return await this.#present(kind, signal, onShown);
    } finally {
      this.#open -= 1;
      release();
    }
  };
}

/**
 * Consent for one Computer task (one thread turn), owned by the desktop.
 *
 * Routine actions share one dialog and one answer for the turn; every clipboard
 * request asks on its own. Only an explicit Cancel binds the turn. A dialog nobody
 * answered, a full prompt queue or a missing window refuses only the call that
 * asked. After an expiry the agent may ask once more, and after a few dialogs in a
 * row that could not be shown the turn stops asking. Nothing here approves
 * without an Allow click.
 */
export class ComputerTaskConsent {
  readonly #prompt: ComputerConsentPrompt;
  readonly #taskSignal: AbortSignal;
  #granted = false;
  #declined = false;
  readonly #expired: Record<ComputerConsentKind, number> = { task: 0, clipboard: 0 };
  /** Dialogs in a row that never reached the user, and why the last one did not. */
  readonly #unshown: Record<ComputerConsentKind, { count: number; last: Unshown }> = {
    task: { count: 0, last: "unavailable" },
    clipboard: { count: 0, last: "unavailable" },
  };
  /** The one routine dialog every routine request of this turn joins. */
  #pending: Promise<ComputerConsentReply> | undefined;

  constructor(prompt: ComputerConsentPrompt, taskSignal: AbortSignal) {
    this.#prompt = prompt;
    this.#taskSignal = taskSignal;
  }

  /**
   * Lock, sleep, session switch, listener loss: a granted consent must be asked
   * again. An open dialog survives (its answer postdates the interruption); a
   * decline stays a decline.
   */
  revokeGrant(): void {
    this.#granted = false;
  }

  async request(kind: ComputerConsentKind): Promise<ComputerConsentReply> {
    if (this.#taskSignal.aborted) return reply("stopped", false);
    // A routine Cancel also refuses clipboard access for the rest of the turn.
    if (this.#declined) return reply("decline", false);
    if (kind === "task" && this.#granted) return reply("accept", false);
    if (this.#expired[kind] > COMPUTER_CONSENT_RE_REQUESTS) return reply("expired", false);
    const unshown = this.#unshown[kind];
    if (unshown.count > COMPUTER_CONSENT_UNSHOWN_RETRIES) return reply(unshown.last, false);
    return kind === "task" ? this.#waitForRoutineDialog() : this.#open("clipboard");
  }

  /** Joins the open routine dialog, or opens it, and waits one request's share of it. */
  async #waitForRoutineDialog(): Promise<ComputerConsentReply> {
    let dialog = this.#pending;
    if (!dialog) {
      const opened = this.#open("task");
      const clear = () => {
        if (this.#pending === opened) this.#pending = undefined;
      };
      void opened.then(clear, clear);
      this.#pending = opened;
      dialog = opened;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<ComputerConsentReply>((resolve) => {
      timer = setTimeout(() => resolve(reply("pending", true)), COMPUTER_CONSENT_WAIT_MS);
    });
    try {
      // The dialog stays open past this request; the next request joins it.
      return await Promise.race([dialog, waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One dialog, settled into the reply every request waiting on it gets. The
   * retry verdict is taken here, once per dialog, so concurrent dialogs each
   * report their own count rather than whatever a later one left behind.
   */
  async #open(kind: ComputerConsentKind): Promise<ComputerConsentReply> {
    const expiry = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expireAfter = (ms: number) => {
      timer = setTimeout(() => expiry.abort(), ms);
    };
    // A clipboard dialog belongs to one bridge request, so its deadline runs
    // from the request, whether or not it has reached the screen yet.
    if (kind === "clipboard") expireAfter(COMPUTER_CONSENT_WAIT_MS);
    let shown = false;
    const onShown = () => {
      if (shown) return;
      shown = true;
      this.#unshown[kind].count = 0;
      // A routine dialog's five minutes start when the user can see it, not
      // while it waits behind another sheet.
      if (kind === "task") expireAfter(COMPUTER_CONSENT_EXPIRY_MS);
    };
    try {
      let result: Awaited<ReturnType<ComputerConsentPrompt>>;
      try {
        result = await this.#prompt(
          kind,
          AbortSignal.any([this.#taskSignal, expiry.signal]),
          onShown,
        );
      } catch {
        result = "unavailable";
      }
      if (this.#taskSignal.aborted) return reply("stopped", false);
      // An Allow click wins even when it lands on the deadline.
      if (result === "accept") {
        if (kind === "task") this.#granted = true;
        return reply("accept", false);
      }
      if (result === "decline") {
        if (!expiry.signal.aborted) {
          // A clipboard Cancel refuses only that clipboard request.
          if (kind === "task") this.#declined = true;
          return reply("decline", false);
        }
        if (shown) {
          this.#expired[kind] += 1;
          return reply("expired", this.#expired[kind] <= COMPUTER_CONSENT_RE_REQUESTS);
        }
        // Its request ran out while another sheet still held the window.
        result = "busy";
      }
      const unshown = this.#unshown[kind];
      unshown.count += 1;
      unshown.last = result;
      return reply(result, unshown.count <= COMPUTER_CONSENT_UNSHOWN_RETRIES);
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
