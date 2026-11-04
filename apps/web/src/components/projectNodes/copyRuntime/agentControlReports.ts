// FILE: agentControlReports.ts
// Purpose: Delivers an Agent Control client-execution report (A1(4)) to the
//          node a proposal lives on until that node answers. An answer that
//          did not arrive, a node that sleeps, restarts or is offline, a
//          reconnect: all are tried again with backoff, and sooner once the
//          node is back online. Only the node's own answer ends the delivery
//          early, since repeating a report is idempotent there.
// Layer: Web copy runtime, used by `copyManager` (copy reports) and the Agent
//        Control executor (classifying an accept's failure).

import type { AgentControlReportClientExecutionInput, EnvironmentId } from "@ryco/contracts";
import { isTagged } from "effect/Predicate";

/** A report without who sends it (`proposalId`, `executorId`), which the sender adds. */
export type AgentControlReportBody = Omit<
  AgentControlReportClientExecutionInput,
  "proposalId" | "executorId"
>;

/**
 * - `sent`: the node took it.
 * - `refused`: the node answered that it never will (the proposal ended, another executor runs it).
 * - `stopped`: the caller stopped it (a newer report replaced it).
 */
export type AgentControlReportDelivery = "sent" | "refused" | "stopped";

/**
 * The node judged the call: an Agent Control answer, except a storage failure, which may have
 * happened after the node committed part of it and is worth trying again.
 */
export function isAgentControlNodeAnswer(error: unknown): boolean {
  return (
    isTagged(error, "AgentControlRpcError") &&
    (error as { readonly code?: unknown }).code !== "storage"
  );
}

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;

/** How long to wait after failed attempt `attempt`: 2 s, doubling, at most 5 min. */
export function agentControlReportRetryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

export interface DeliverAgentControlReportInput {
  readonly environmentId: EnvironmentId;
  /**
   * What to report, built before every attempt; null while it can't be told yet (the copy's
   * destination did not answer), so the attempt waits for the next round.
   */
  readonly build: () => Promise<AgentControlReportBody | null>;
  readonly send: (body: AgentControlReportBody) => Promise<void>;
  /** Stops the delivery before its next attempt. */
  readonly signal?: AbortSignal | undefined;
  /** Waits before attempt `attempt + 1`; settles early when `signal` aborts. */
  readonly waitToRetry: (
    environmentId: EnvironmentId,
    attempt: number,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
}

export async function deliverAgentControlReport(
  input: DeliverAgentControlReportInput,
): Promise<AgentControlReportDelivery> {
  for (let attempt = 1; ; attempt += 1) {
    if (input.signal?.aborted) return "stopped";
    try {
      const body = await input.build();
      if (body !== null) {
        if (input.signal?.aborted) return "stopped";
        await input.send(body);
        return "sent";
      }
    } catch (error) {
      if (isAgentControlNodeAnswer(error)) {
        console.warn("The node refused a copy's Agent Control report.", error);
        return "refused";
      }
      // Not answered: try again.
    }
    await input.waitToRetry(input.environmentId, attempt, input.signal);
  }
}
