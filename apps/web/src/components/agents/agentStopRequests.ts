/**
 * The app's one registry of stops sent for native agents, shared by every
 * control that offers one (a roster row, the agent's detail header, the crown
 * and the Agents tab). The rules live in the shared runtime with the phone's.
 */
import {
  createStopRequestRegistry,
  STOP_UNCONFIRMED_MS,
} from "@ryco/client-runtime/state/session/subagentStop";

export const agentStopRequests = createStopRequestRegistry(STOP_UNCONFIRMED_MS);
