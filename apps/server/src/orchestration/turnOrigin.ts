/**
 * Where the user sent a turn from. The connection edge stamps it on client turn starts and
 * steers (`stampTurnOrigin`); the provider reactor tells the agent in one fixed line when the
 * user is on another device, so it stops handing out links to `localhost` the user cannot open.
 * The stored message never carries the line.
 *
 * Pure module: no services, no I/O.
 *
 * @module turnOrigin
 */
import type { OrchestrationCommand, TurnOrigin } from "@ryco/contracts";

const ORIGIN_LINES: Record<TurnOrigin["connection"], string | null> = {
  local: null,
  remote:
    "<ryco_sent_from>The user sent this from another device over the network. Links to localhost or 127.0.0.1 on this machine do not open for them.</ryco_sent_from>",
  relay:
    "<ryco_sent_from>The user sent this from another device through the Ryco relay (hosted web or the mobile app). Links to localhost or 127.0.0.1 on this machine do not open for them.</ryco_sent_from>",
};

/** The provider-input line for a turn from another device; null for a local or unknown one. */
export function turnOriginLine(origin: TurnOrigin | undefined): string | null {
  return origin === undefined ? null : ORIGIN_LINES[origin.connection];
}

/** The provider input with the origin line in front, when the turn came from another device. */
export function withTurnOriginLine(
  input: string | undefined,
  origin: TurnOrigin | undefined,
): string | undefined {
  const line = turnOriginLine(origin);
  if (line === null) return input;
  return input === undefined ? line : `${line}\n\n${input}`;
}

/** A normalized client command with the connection's origin, when it is a turn start or steer. */
export function stampTurnOrigin(
  command: OrchestrationCommand,
  origin: TurnOrigin | undefined,
): OrchestrationCommand {
  if (origin === undefined) return command;
  return command.type === "thread.turn.start" || command.type === "thread.turn.steer"
    ? { ...command, origin }
    : command;
}
