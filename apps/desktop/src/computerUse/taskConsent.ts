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
/** Open dialogs across all tasks. */
export const COMPUTER_CONSENT_OPEN_LIMIT = 8;

export type ComputerConsentKind = "task" | "clipboard";
/** What one dialog showed. A dialog closed by our signal reports "decline" (Electron's cancel). */
export type ComputerConsentPrompt = (
  kind: ComputerConsentKind,
  signal: AbortSignal,
) => Promise<"accept" | "decline" | "unavailable" | "busy">;

/** How one dialog ended, before it is turned into a reply. */
type Settled = "accept" | "decline" | "expired" | "unavailable" | "busy" | "stopped";

/**
 * Consent for one Computer task (one thread turn), owned by the desktop.
 *
 * Routine actions share one dialog and one answer for the turn; every clipboard
 * request asks on its own. Only an explicit Cancel binds the turn. A dialog nobody
 * answered, a full prompt queue or a missing window refuses only the call that
 * asked, and after an expiry the agent may ask once more before the turn stops
 * asking. Nothing here approves without an Allow click.
 */
export class ComputerTaskConsent {
  readonly #prompt: ComputerConsentPrompt;
  readonly #taskSignal: AbortSignal;
  #granted = false;
  #declined = false;
  readonly #expired: Record<ComputerConsentKind, number> = { task: 0, clipboard: 0 };
  /** The one routine dialog every routine request of this turn joins. */
  #pending: Promise<Settled> | undefined;

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
    const settled =
      kind === "task"
        ? await this.#waitForRoutineDialog()
        : await this.#open("clipboard", COMPUTER_CONSENT_WAIT_MS);
    switch (settled) {
      case "accept":
      case "decline":
      case "stopped":
        return reply(settled, false);
      case "expired":
        return reply(settled, this.#expired[kind] <= COMPUTER_CONSENT_RE_REQUESTS);
      case "pending":
      case "unavailable":
      case "busy":
        return reply(settled, true);
    }
  }

  /** Joins the open routine dialog, or opens it, and waits one request's share of it. */
  async #waitForRoutineDialog(): Promise<Settled | "pending"> {
    let dialog = this.#pending;
    if (!dialog) {
      const opened = this.#open("task", COMPUTER_CONSENT_EXPIRY_MS);
      const clear = () => {
        if (this.#pending === opened) this.#pending = undefined;
      };
      void opened.then(clear, clear);
      this.#pending = opened;
      dialog = opened;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<"pending">((resolve) => {
      timer = setTimeout(() => resolve("pending"), COMPUTER_CONSENT_WAIT_MS);
    });
    try {
      // The dialog stays open past this request; the next request joins it.
      return await Promise.race([dialog, waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #open(kind: ComputerConsentKind, lifetimeMs: number): Promise<Settled> {
    const expiry = new AbortController();
    const timer = setTimeout(() => expiry.abort(), lifetimeMs);
    try {
      let shown: Awaited<ReturnType<ComputerConsentPrompt>>;
      try {
        shown = await this.#prompt(kind, AbortSignal.any([this.#taskSignal, expiry.signal]));
      } catch {
        shown = "unavailable";
      }
      if (this.#taskSignal.aborted) return "stopped";
      // An Allow click wins even when it lands on the deadline.
      if (shown === "accept") {
        if (kind === "task") this.#granted = true;
        return "accept";
      }
      if (shown === "decline") {
        if (expiry.signal.aborted) {
          // Once per dialog, however many requests were waiting on it.
          this.#expired[kind] += 1;
          return "expired";
        }
        // A clipboard Cancel refuses only that clipboard request.
        if (kind === "task") this.#declined = true;
        return "decline";
      }
      return shown;
    } finally {
      clearTimeout(timer);
    }
  }
}

function reply(outcome: ComputerConsentReply["outcome"], retryable: boolean): ComputerConsentReply {
  return { approved: outcome === "accept", outcome, retryable };
}
