/**
 * Agent Control's checks of the person's delegation limits, loaded with `import()` the first
 * time a limit is set, so a server whose limits are off never loads it. The rules themselves
 * are `orchestration/delegationLimits.ts`.
 *
 * @module delegationLimitCheck
 */
import type { ThreadId } from "@ryco/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

import {
  exceedsDelegationLimits,
  mayDelegateAtDepth,
  type DelegationLimits,
} from "../orchestration/delegationLimits.ts";
import { readDelegationTree } from "../persistence/delegationTreeQueries.ts";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const RAISE_HINT = "The person can change delegation limits in Settings → Integrations.";

/**
 * Why a thread at `callerDepth` in a tree that already has `treeTasks` tasks may not create
 * `newTasks` more, or null when the limits allow it.
 */
export function delegationLimitRefusal(input: {
  readonly limits: DelegationLimits;
  readonly callerDepth: number;
  readonly treeTasks: number;
  readonly newTasks: number;
}): string | null {
  if (!exceedsDelegationLimits(input)) return null;
  const { maxDepth, maxTasksPerTree } = input.limits;
  if (!mayDelegateAtDepth(input.limits, input.callerDepth)) {
    return input.callerDepth === 0 || maxDepth === null
      ? `Delegation limit: this chat may not delegate. ${RAISE_HINT}`
      : `Delegation limit: tasks may sit at most ${plural(maxDepth, "level")} below the chat that started them, and this chat is ${plural(input.callerDepth, "level")} down, so it may not delegate. Do the work here instead. ${RAISE_HINT}`;
  }
  const left = Math.max(0, (maxTasksPerTree ?? 0) - input.treeTasks);
  return `Delegation limit: this delegation tree may create ${plural(maxTasksPerTree ?? 0, "task")} in all and has ${plural(input.treeTasks, "task")}, so ${plural(left, "more task")} fit and ${input.newTasks} were requested. ${RAISE_HINT}`;
}

/** The refusal for `newTasks` more tasks from `callerThreadId`, read from the projection. */
export const readDelegationLimitRefusal = (
  sql: SqlClient.SqlClient,
  limits: DelegationLimits,
  input: { readonly callerThreadId: ThreadId; readonly newTasks: number },
) =>
  readDelegationTree(sql, input.callerThreadId).pipe(
    Effect.map((tree) =>
      tree === null
        ? "Delegation limit: this chat's place in its delegation tree is unknown."
        : delegationLimitRefusal({
            limits,
            callerDepth: tree.depth,
            treeTasks: tree.treeTasks,
            newTasks: input.newTasks,
          }),
    ),
  );

/** Whether `threadId` may be offered delegation tools at all. Fails closed on an unknown thread. */
export const readMayDelegate = (
  sql: SqlClient.SqlClient,
  limits: DelegationLimits,
  threadId: ThreadId,
) =>
  readDelegationTree(sql, threadId).pipe(
    Effect.map((tree) => tree !== null && mayDelegateAtDepth(limits, tree.depth)),
  );
