import type {
  ProviderSession,
  ProviderSessionPrewarmInput,
  ProviderSessionPrewarmResult,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ThreadProviderStart } from "../threadProviderStart.ts";

/**
 * Speculative provider session starts ahead of a send.
 *
 * `prewarm` starts the session a thread's next send would start (Claude CLI boot and MCP
 * connects, Codex app-server initialize and thread start/resume) without binding it to the
 * orchestration thread: no session-set, no turn, no title, no checkpoint, and runtime events
 * of the unbound runtime are dropped by ingestion's runtime fence. The turn start `claim`s it:
 * an exact match is bound and used, anything else is stopped. Unclaimed sessions stop after an
 * idle period; the pool is bounded per provider instance and overall.
 */
export interface ProviderSessionPrewarmShape {
  readonly prewarm: (
    input: ProviderSessionPrewarmInput,
  ) => Effect.Effect<ProviderSessionPrewarmResult>;
  /**
   * The prewarmed session for exactly `start`, waiting for one still starting; `undefined`
   * when there is none, it failed, it no longer runs, or it was started differently (then it
   * is stopped first). Never fails.
   */
  readonly claim: (start: ThreadProviderStart) => Effect.Effect<ProviderSession | undefined>;
}

export class ProviderSessionPrewarm extends Context.Service<
  ProviderSessionPrewarm,
  ProviderSessionPrewarmShape
>()("ryco/orchestration/Services/ProviderSessionPrewarm") {}
