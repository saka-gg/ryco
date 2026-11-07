// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
/** Durable human-message projection supplied by Ryco orchestration. */
export interface ComputerTaskMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly source: string;
  readonly dispatchOrigin?: string | undefined;
  readonly streaming: boolean;
  readonly turnId?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly attachments?: readonly unknown[];
  readonly skills?: readonly unknown[];
  readonly mentions?: readonly unknown[];
  readonly asyncUserInput?: {
    readonly questions: readonly { readonly title: string; readonly options?: readonly string[] }[];
    readonly response?: { readonly messageId: string; readonly answers: readonly string[] } | null;
  };
}

/**
 * Whether one computer task may move a window in front of the user.
 *
 * Background first: input goes to the target window without raising it. When
 * that does not reach the app, a task the user typed may come to the front,
 * because getting it done is what they asked for; the Escape stop and the
 * pause on their own input keep them in charge (the Helium incident: twenty-one
 * excursions while the user was typing, which the input pause now stops). A
 * task that asks to stay in the background, and any automation- or
 * agent-dispatched turn, never raises anything.
 *
 * Reconstructed from durable human messages in this task: routine
 * continuations and short answers keep the task's scope; a new request starts
 * a new one.
 */
export interface ComputerForegroundAuthorization {
  /** This task may come to the foreground (a human task that did not ask to stay in the background). */
  readonly userRequestedVisibleUse: boolean;
  /**
   * Requested, but the desktop cannot take the foreground safely right now: without
   * Input Monitoring there is no Escape stop and the user's own input does not pause the
   * agent. Every foreground gate refuses with this before dispatch.
   */
  readonly blocked?: { readonly code: string; readonly message: string };
}

/** Refusal code: foreground use needs Input Monitoring (the Escape stop) and it is missing. */
export const COMPUTER_FOREGROUND_NEEDS_INPUT_MONITORING_CODE = "foreground_needs_input_monitoring";

/** What the desktop reports about its Escape and human-input listener. */
export interface ComputerEscapeStopState {
  /** Input Monitoring is granted to the app. */
  readonly granted: boolean;
  readonly listener: { readonly ready: boolean; readonly error?: string | undefined };
}

/** Listener states that are not failures: it starts on demand before the next input. */
const LISTENER_ON_DEMAND = new Set(["input_monitor_idle", "input_monitor_starting"]);

/**
 * Foreground takeover needs the Escape stop: Input Monitoring granted and a listener that
 * has not failed. Background use needs neither. Unknown state blocks.
 */
export function computerForegroundEscapeStopBlock(
  state: ComputerEscapeStopState | undefined,
): ComputerForegroundAuthorization["blocked"] {
  if (state?.granted !== true)
    return {
      code: COMPUTER_FOREGROUND_NEEDS_INPUT_MONITORING_CODE,
      message:
        'Foreground use needs Input Monitoring, so the user can stop you with Escape and their own input pauses your work. No input was sent. Keep working in the background, or ask the user to turn on Input Monitoring ("Stop with Escape") in Settings → Computer Use.',
    };
  if (!state.listener.ready && !LISTENER_ON_DEMAND.has(state.listener.error ?? ""))
    return {
      code: COMPUTER_FOREGROUND_NEEDS_INPUT_MONITORING_CODE,
      message:
        'The Escape listener is not running, so foreground use is paused. No input was sent. Keep working in the background, or ask the user to check Input Monitoring ("Stop with Escape") in Settings → Computer Use.',
    };
  return undefined;
}

export interface ComputerForegroundContext {
  /** Names from the desktop's observed app inventory, never model arguments or window titles. */
  readonly knownAppNames?: readonly string[];
}

/** The authorization a call carries when nothing asked for visible use. */
export const COMPUTER_FOREGROUND_NOT_AUTHORIZED: ComputerForegroundAuthorization = {
  userRequestedVisibleUse: false,
};

/** Refusal code: the task never asked to see the app or window. */
export const COMPUTER_FOREGROUND_NOT_REQUESTED_CODE = "foreground_not_requested";

/** Refusal code: the user was interacting with the desktop moments ago. */
export const COMPUTER_FOREGROUND_USER_INTERACTION_CODE = "foreground_user_interaction";

/**
 * How long after the user's own desktop input a foreground excursion is
 * refused. The desktop queue already serializes pane input and agent calls, so
 * this window only has to cover rapid interleaving — the user clicking or
 * typing through the computer pane while the agent works. Two seconds is the
 * measured pace of a click-then-read cycle and stays short enough that an
 * authorized task resumes promptly once the user stops.
 */
export const COMPUTER_USER_INTERACTION_QUIET_MS = 2_000;

/**
 * The phrases that count as the user asking to see the desktop. Deliberately
 * explicit and visible-use-only: "use Chrome" is not "show me Chrome", and a
 * task that only names an app stays background. A false negative costs one
 * refusal that asks the model to have the user confirm; a false positive
 * re-opens the exact focus theft this gate exists to stop, so the list errs
 * toward refusing.
 */
const VISIBLE_USE_PATTERNS: readonly RegExp[] = [
  /\bshow (?:me )?(?:the |my )?(?:[\w-]+ ){0,3}(?:window|app|screen|desktop|browser|page)(?=\s*(?:[.!?,;:]|$))/i,
  /\bshow me what you(?: are|'re) doing\b/i,
  /\b(?:i (?:want|would like|'d like) to |let me )watch (?:you|it|the (?:app|browser|window))\b/i,
  /\blet me see (?:it|you) work(?:ing)?\b/i,
  /\bi (?:want|would like|'d like) to see (?:the |my )?(?:[\w-]+ ){0,3}(?:window|app|screen|desktop|browser|page)(?=\s*(?:[.!?,;:]|$))/i,
  /\b(?:put|show|display)\b[^.!?\n]{0,40}\bon (?:my|the) screen\b/i,
  /\b(?:make|keep) (?:it|(?:the |my )?(?:[\w-]+ ){0,3}(?:app|window|browser)) visible\b/i,
  /\b(?:bring|put|move)\b[^.!?]{0,40}\b(?:front|foreground)(?=\s*(?:[.!?,;:]|$))/i,
  /\buse (?:the )?foreground(?: mode)?(?=\s*(?:[.!?,;:]|$))/i,
  /\btake over (?:my|the) (?:screen|desktop|computer)\b/i,
  /\bdrive (?:my|the) (?:screen|desktop|computer)\b/i,
  /\b(?:mostra(?:mi|re)?|porta(?:re)?|metti|mettere)\b[^.!?\n]{0,60}\b(?:sullo schermo|in primo piano)\b/i,
  /\bvoglio vedere (?:la finestra|il browser|lo schermo|il desktop)\b/i,
];

// Explicit background/negative instructions take precedence, even when the
// message also contains a visible-use phrase. Ambiguous requests stay hidden.
const BACKGROUND_USE_PATTERNS: readonly RegExp[] = [
  /\b(?:do not|don['’]t|never|not|avoid|without|stop)\b[^.!?\n]{0,100}\b(?:show|watch|visible|foreground|front|focus|raise|screen|desktop)\b/i,
  /\b(?:keep|stay|remain|work|run|use)\b[^.!?\n]{0,60}\b(?:background|hidden|invisible)\b/i,
  /\bbackground[- ]only\b/i,
  /\bin the background\b/i,
  /\b(?:im hintergrund|nicht (?:in den )?vordergrund)\b/i,
  /\b(?:non|senza|evita|smetti di)\b[^.!?\n]{0,100}\b(?:mostrare|mostrarmi|primo piano|schermo|focus)\b/i,
  /\b(?:lavora|resta|rimani|mantieni)\b[^.!?\n]{0,60}\b(?:background|nascost[ao])\b/i,
];

function unquotedRequest(text: string): string {
  return text
    .replace(/<untrusted_text\b[^>]*>[\s\S]*?(?:<\/untrusted_text>|$)/gi, "")
    .replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, "")
    .replace(/(^|[\s(])'[^'\n]+'(?=$|[\s.,;:)])/g, "$1")
    .replace(/^\s*>.*$/gm, "");
}

function requestsKnownAppVisibility(text: string, context: ComputerForegroundContext): boolean {
  const app = text
    .trim()
    .match(/^(?:please[, ]+)?(?:show(?: me)?|display|mostra(?:mi)?)\s+(.+?)[.!?]*$/iu)?.[1];
  if (!app) return false;
  const name = app.trim().toLocaleLowerCase();
  return (
    context.knownAppNames?.some((candidate) => candidate.trim().toLocaleLowerCase() === name) ===
    true
  );
}

/** Whether one message text explicitly asks to see the desktop. Pure. */
export function messageRequestsVisibleUse(
  text: string,
  context: ComputerForegroundContext = {},
): boolean {
  const request = unquotedRequest(text);
  return (
    !BACKGROUND_USE_PATTERNS.some((pattern) => pattern.test(request)) &&
    (VISIBLE_USE_PATTERNS.some((pattern) => pattern.test(request)) ||
      requestsKnownAppVisibility(request, context))
  );
}

function isAffirmativeReply(text: string): boolean {
  return /^(?:yes|yeah|yep|ok(?:ay)?|sure|go ahead|s[iì]|va bene|certo|procedi|vai)(?:[, ]+(?:please|go ahead|per favore|fallo))?[.!]*$/iu.test(
    text.trim(),
  );
}

function isLocalHumanMessage(message: ComputerTaskMessage): boolean {
  return (
    message.role === "user" &&
    message.dispatchOrigin !== "automation" &&
    message.dispatchOrigin !== "agent" &&
    (message.source === "native" || message.source === "async-user-input")
  );
}

/** Whether a reply only continues the current task ("continue", "retry"). Pure. */
export function isRoutineComputerContinuation(text: string): boolean {
  return isRoutineContinuation({ text }) || isAffirmativeReply(text);
}

/** Only a whole, scope-preserving reply may carry earlier consent into this turn. */
function isRoutineContinuation(
  message: Pick<ComputerTaskMessage, "text" | "attachments" | "skills" | "mentions">,
): boolean {
  if (message.attachments?.length || message.skills?.length || message.mentions?.length)
    return false;
  return /^(?:(?:ok(?:ay)?|yes|s[iì])[, ]+)?(?:please[, ]+)?(?:continue(?: (?:working|with (?:the |this |our )?(?:same |current )?(?:task|work|plan)))?|keep (?:going|working)|carry on|go (?:on|ahead)|proceed(?: with (?:the |this |our )?(?:same |current )?(?:task|work|plan))?|(?:try|retry)(?: (?:again|that|it|the same step))?|continua(?: pure)?|prosegui|procedi|vai|riprova)(?:[, ]+(?:please|per favore))?[.!]*$/iu.test(
    message.text.trim(),
  );
}

/**
 * The latest user-authored message in a thread's message list, or undefined
 * when the thread has none. Automation- and agent-dispatched messages are
 * skipped: only a person's own words can authorize visible use.
 */
export function latestUserAuthoredMessage(
  messages: readonly ComputerTaskMessage[],
): ComputerTaskMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    if (message.dispatchOrigin === "automation" || message.dispatchOrigin === "agent") continue;
    return message;
  }
  return undefined;
}

/** Whether one message text asks to keep the work out of sight. Pure. */
export function messageRequestsBackgroundOnly(text: string): boolean {
  const request = unquotedRequest(text);
  return BACKGROUND_USE_PATTERNS.some((pattern) => pattern.test(request));
}

/**
 * This task's grant. A task a person typed on this Mac may come to the front
 * when background control is not enough: that is what they asked the agent
 * to get done, and the Escape stop (Input Monitoring) plus the pause on their
 * own input keep them in charge. It stays in the background when the task
 * says so ("in the background", "don't show it"), and automation- or
 * agent-dispatched turns never raise anything.
 *
 * Routine continuations ("continue", "retry") and answers to a question card
 * carry the task they continue, so an earlier background-only request still
 * holds after them.
 */
export function computerForegroundAuthorizationForMessages(
  messages: readonly ComputerTaskMessage[],
  _context: ComputerForegroundContext = {},
): ComputerForegroundAuthorization {
  let sawHumanMessage = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    if (!isLocalHumanMessage(message)) return COMPUTER_FOREGROUND_NOT_AUTHORIZED;
    sawHumanMessage = true;
    if (message.source === "async-user-input") continue;
    if (messageRequestsBackgroundOnly(message.text)) return COMPUTER_FOREGROUND_NOT_AUTHORIZED;
    // "yes" / "ok" answers the agent's question about the same task: it keeps that task's scope.
    if (!isRoutineContinuation(message) && !isAffirmativeReply(message.text))
      return { userRequestedVisibleUse: true };
  }
  return sawHumanMessage ? { userRequestedVisibleUse: true } : COMPUTER_FOREGROUND_NOT_AUTHORIZED;
}
