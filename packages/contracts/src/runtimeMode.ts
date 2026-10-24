import * as Schema from "effect/Schema";

/**
 * How much a thread's agent may do without asking. A leaf module, so schemas
 * that capture a runtime (pull request watches) can import it without a cycle
 * through `orchestration.ts`, which re-exports it.
 */
export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
