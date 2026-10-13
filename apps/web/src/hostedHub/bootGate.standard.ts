import { hostedOnly } from "./hostedOnly";

/**
 * Standard-build stand-in for `./bootGate` (wired by `src/clientModeSeams.ts`).
 * A standard build never runs the hosted access check, so the gate is a
 * hosted-only entry point. The signature is pinned to the real module.
 */
type Hosted = typeof import("./bootGate");

export const runHostedBootGate: Hosted["runHostedBootGate"] = () => hostedOnly("runHostedBootGate");
