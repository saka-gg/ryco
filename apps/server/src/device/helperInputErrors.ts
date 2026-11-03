/**
 * Reading the device helper's input-delivery errors.
 *
 * The helper refuses to ack input it could not hand to the simulator, and the
 * error says how much of the operation went out: "nothing was sent: <why>" or
 * "input may have been partially delivered; do not replay: <why>"
 * (native/device-helper/HEADER.md, "Input transports"). The server's replay
 * rules and the device-helper smoke both decide through here, so a smoke run
 * retries exactly what the server would.
 *
 * @module device/helperInputErrors
 */
import type { HelperInputTransport } from "./helperCapabilities.ts";

/** What may be done with an input the helper did not deliver. */
export type InputRetry =
  /** Surface the error: retrying could repeat input, or cannot help. */
  | "none"
  /** Send it once more on the current attachment. */
  | "same-attachment"
  /** Rebuild the attachment first, then send it once more. */
  | "reattach";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Did the helper accept an injection it could not deliver? Distinct from a
 * stale descriptor: the attachment is live enough to answer, but its input
 * path is not (a HID client bound to a boot that is gone, dtuhidd not up yet).
 * Whether a retry is safe depends on the rest of the message; see
 * `inputRetryFor`.
 */
export function isInputNotDeliveredError(error: unknown): boolean {
  return /not delivered to the simulator/iu.test(messageOf(error));
}

/**
 * The one retry an undelivered input may get, given the transport of the
 * attachment that refused it. The rules, in order:
 *
 * 1. Not a delivery failure: none.
 * 2. Refused because it cannot finish inside the input deadline: none. The
 *    transport is fine; the caller decides whether to send something shorter.
 * 3. Anything but "nothing was sent:": none. Part of it went out, and a
 *    replay would type text twice or repeat half a gesture.
 * 4. dtuhidd still starting: the same attachment. It keeps warming up in the
 *    background, and a re-attach would restart that.
 * 5. Any other failure on dtuhidd: the same attachment. The transport
 *    reconnects by itself on the next input, so a re-attach would only build
 *    a new one and restart its warm-up.
 * 6. Otherwise (Indigo): re-attach. A stale Indigo client never recovers, and
 *    a forced re-attach rebuilds it against the current boot.
 */
export function inputRetryFor(
  error: unknown,
  transport: HelperInputTransport | null | undefined,
): InputRetry {
  if (!isInputNotDeliveredError(error)) return "none";
  const message = messageOf(error);
  if (/input deadline/iu.test(message)) return "none";
  if (!/(?:^|: )nothing was sent:/iu.test(message)) return "none";
  if (/still starting/iu.test(message)) return "same-attachment";
  if (transport === "dtuhid") return "same-attachment";
  return "reattach";
}
