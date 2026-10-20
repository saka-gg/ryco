import { hostedOnly } from "./hostedOnly";

/**
 * Standard-build stand-in for `./bootGate` (wired by `src/clientModeSeams.ts`).
 * A standard build never runs the hosted access check, so the gate and the
 * access check it waits for are hosted-only entry points. The signatures are
 * pinned to the real module.
 */
type Hosted = typeof import("./bootGate");

export const runHostedBootGate: Hosted["runHostedBootGate"] = () => hostedOnly("runHostedBootGate");

export const startHostedAccessCheck: Hosted["startHostedAccessCheck"] = () =>
  hostedOnly("startHostedAccessCheck");
