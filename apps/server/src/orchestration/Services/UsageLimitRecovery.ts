/**
 * UsageLimitRecovery - opt-in worker for threads stopped by a provider usage limit.
 *
 * Each sweep fills a missing reset from the provider's usage probe, snoozes limited
 * threads until their reset (`snoozeLimitedThreads`), and resumes them shortly after the
 * reset (`autoResumeLimitedThreads` or a per-thread override). Every action uses a
 * deterministic command id, so restarts and concurrent clients converge on one receipt.
 *
 * @module UsageLimitRecovery
 */
import { Context } from "effect";
import type { Effect } from "effect";

export interface UsageLimitRecoveryShape {
  /** One pass over the persisted limits. Never fails; errors are logged. */
  readonly sweep: () => Effect.Effect<void>;
}

export class UsageLimitRecovery extends Context.Service<
  UsageLimitRecovery,
  UsageLimitRecoveryShape
>()("ryco/orchestration/Services/UsageLimitRecovery") {}
