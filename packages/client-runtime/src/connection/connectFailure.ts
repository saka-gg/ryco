import { isTransportConnectionErrorMessage } from "../errors/transportError.ts";
import { isAbortOrTimeoutError } from "./fetchWithDeadline.ts";

/**
 * Why a saved machine could not be connected, in the few kinds a person can act
 * on. A machine that is off, asleep or on another network is an everyday state,
 * not a fault: every surface shows it as offline with a retry, never the
 * platform's error text (a URL, a native file name, "unexpected exception").
 */
export type SavedEnvironmentFailureKind =
  /** The request never reached the machine: off, asleep, another network, wrong address. */
  | "unreachable"
  /** The machine took the request but did not answer, or finish connecting, in time. */
  | "timed-out"
  /** The machine answered and turned the connection down. */
  | "refused"
  /** Anything else: the details stay in diagnostics. */
  | "failed";

// Its own constant, so a client that only throws the error below (the web app's
// remote API) does not bundle the other sentences and the classifier.
const UNREACHABLE_MESSAGE =
  "Can't reach this machine. It may be off, asleep or on another network.";

/**
 * A request to a machine's HTTP API that never got an answer: the platform's
 * fetch rejected (no route, connection refused, the device offline, a TLS
 * failure) or its deadline passed. The message is the plain sentence people
 * see; the URL and the platform's own message stay on the error for logs.
 */
export class RemoteEnvironmentUnreachableError extends Error {
  readonly requestUrl: string;

  /** `cause` keeps the platform's own error, for diagnostics only. */
  constructor(requestUrl: string, cause: unknown) {
    super(UNREACHABLE_MESSAGE, { cause });
    this.name = "RemoteEnvironmentUnreachableError";
    this.requestUrl = requestUrl;
  }
}

export const SAVED_ENVIRONMENT_FAILURE_MESSAGES: Readonly<
  Record<SavedEnvironmentFailureKind, string>
> = {
  unreachable: UNREACHABLE_MESSAGE,
  "timed-out": "This machine did not answer in time.",
  refused: "This machine turned the connection down.",
  failed: "Couldn't connect to this machine.",
};

/** What the platform's networking stacks say when a request never got through. */
const UNREACHABLE_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /network request failed/i,
  /failed to fetch/i,
  /load failed/i,
  /fetch failed/i,
  /appears to be offline/i,
  /could not connect to the server/i,
  /could not be found/i,
  /network connection was lost/i,
  /\bECONNREFUSED\b|\bECONNRESET\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|\bENOTFOUND\b/,
  /Unable to prepare the Ryco server WebSocket connection/i,
];

const TIMED_OUT_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /did not answer within/i,
  /did not connect in time/i,
  /did not finish connecting in time/i,
  /timed out/i,
];

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

function hasHttpStatus(error: unknown): error is { readonly status: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { readonly status?: unknown }).status === "number"
  );
}

/**
 * Sorts a connect failure (a thrown error, or the message a socket reported)
 * into the kinds a person can act on. A wrapper is judged by what it wraps:
 * an unreachable request whose deadline passed reads as timed out.
 */
export function classifySavedEnvironmentFailure(error: unknown): SavedEnvironmentFailureKind {
  if (error instanceof RemoteEnvironmentUnreachableError) {
    return isAbortOrTimeoutError(error.cause) ? "timed-out" : "unreachable";
  }
  const name = (error as { readonly name?: unknown } | null)?.name;
  if (isAbortOrTimeoutError(error) || name === "SavedEnvironmentTimeoutError") {
    return "timed-out";
  }
  if (hasHttpStatus(error)) return "refused";
  const message = errorMessageOf(error);
  if (TIMED_OUT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) return "timed-out";
  if (
    isTransportConnectionErrorMessage(message) ||
    UNREACHABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return "unreachable";
  }
  return "failed";
}

/** A message the node itself wrote: one short plain line, no markup and no stack. */
function isPlainNodeMessage(message: string): boolean {
  return (
    message.length > 0 &&
    message.length <= 160 &&
    !/[<>{}\n]/.test(message) &&
    !/https?:\/\//i.test(message)
  );
}

export interface SavedEnvironmentFailure {
  readonly kind: SavedEnvironmentFailureKind;
  /** One plain sentence for the machine's row and the workspace status. */
  readonly message: string;
}

/**
 * The kind and the sentence people see for a connect failure. A machine that
 * turned the connection down may say why in its own words (a 4xx answer's
 * message); everything else gets the fixed sentence of its kind.
 */
export function describeSavedEnvironmentFailure(error: unknown): SavedEnvironmentFailure {
  const kind = classifySavedEnvironmentFailure(error);
  if (kind === "refused" && hasHttpStatus(error) && error.status < 500) {
    const message = errorMessageOf(error).trim();
    if (isPlainNodeMessage(message)) return { kind, message };
  }
  return { kind, message: SAVED_ENVIRONMENT_FAILURE_MESSAGES[kind] };
}

/**
 * The sentence for a failure of one named machine, for a surface that speaks
 * about the workspace rather than inside the machine's own row.
 */
export function savedEnvironmentFailureMessageFor(
  kind: SavedEnvironmentFailureKind,
  machineLabel: string,
): string {
  const label = machineLabel.trim();
  if (label.length === 0) return SAVED_ENVIRONMENT_FAILURE_MESSAGES[kind];
  switch (kind) {
    case "unreachable":
      return `Can't reach ${label}. It may be off, asleep or on another network.`;
    case "timed-out":
      return `${label} did not answer in time.`;
    case "refused":
      return `${label} turned the connection down.`;
    case "failed":
      return `Couldn't connect to ${label}.`;
  }
}

/** Whether a failure means only that the machine is out of reach for now. */
export function isSavedEnvironmentOutOfReach(kind: SavedEnvironmentFailureKind | null | undefined) {
  return kind === "unreachable" || kind === "timed-out";
}
