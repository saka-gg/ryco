import type { OrchestrationEvent } from "@ryco/contracts";

import { makeCachedJsonBytes } from "../streamBatching.ts";

/**
 * Approximate encoded size of one orchestration event, measured once. Every
 * live subscriber receives the same event object from the engine's PubSub, so
 * the live-queue byte ledger, the progress coalescer and the chunk splitter of
 * every subscription share one measurement.
 */
export const orchestrationEventBytes = makeCachedJsonBytes<OrchestrationEvent>();
