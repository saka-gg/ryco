import { createThreadSessionCommands } from "@ryco/client-runtime/state/session";

import { newCommandId } from "../lib/utils";

// The checkpoint revert, from its guards to the node's verdict, is shared with mobile:
// `runCheckpointRevert` in `@ryco/client-runtime/state/session`. So are these commands.

export const { interruptThreadTurn, respondToThreadApproval, respondToThreadUserInput } =
  createThreadSessionCommands({ newCommandId });
