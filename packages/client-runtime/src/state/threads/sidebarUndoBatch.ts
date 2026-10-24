import type { CommandId, ScopedThreadRef } from "@ryco/contracts";

import { scopedThreadKey } from "../../scoped.ts";
import {
  SIDEBAR_UNDO_BATCH_LIMIT,
  type SidebarActionCommand,
  type SidebarUndoContext,
  type SidebarUndoDescribe,
  type SidebarUndoHistory,
} from "./sidebarUndo.ts";

// Kept out of the threads barrel (and so out of the boot chunk): only bulk
// actions import it, through its own subpath export.

/** Commands of one bulk action in flight at once. */
export const SIDEBAR_UNDO_BATCH_CONCURRENCY = 4;

export type SidebarBatchCommand = Extract<
  SidebarActionCommand,
  { type: "thread.settle" | "thread.unsettle" | "thread.snooze" | "thread.unsnooze" }
>;

/**
 * Runs `run` for each item, at most SIDEBAR_UNDO_BATCH_CONCURRENCY at once; `run` handles its
 * own failures. Not the shared forEachWithConcurrency: the web app also loads that module with
 * lazy chunks, so importing it on the Inbox's path would give it a chunk file of its own.
 */
async function inPool<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(
    Array.from({ length: Math.min(SIDEBAR_UNDO_BATCH_CONCURRENCY, items.length) }, worker),
  );
}

export interface SidebarUndoBatchResult {
  readonly applied: readonly ScopedThreadRef[];
  /** Threads whose node was not ready; nothing was sent for them. */
  readonly skipped: readonly ScopedThreadRef[];
  readonly failed: readonly { readonly target: ScopedThreadRef; readonly error: unknown }[];
  /** Applied threads whose node is too old to undo the action. */
  readonly withoutUndo: number;
}

/**
 * Sends one lifecycle command to each target through `history`, a few at a time. A target
 * whose node is not ready (`readContext` returns null) is skipped. One notice undoes every
 * applied settle or snooze its node can undo; a failed command leaves the notice.
 */
export async function dispatchSidebarUndoBatch(input: {
  readonly history: SidebarUndoHistory;
  /** The context the history itself reads, with its readiness gates. */
  readonly readContext: (target: ScopedThreadRef) => SidebarUndoContext | null;
  readonly newCommandId: () => CommandId;
  readonly targets: readonly ScopedThreadRef[];
  /** Builds each target's command; every command has the same type. */
  readonly command: (target: ScopedThreadRef) => SidebarBatchCommand;
  readonly describe?: SidebarUndoDescribe | undefined;
}): Promise<SidebarUndoBatchResult> {
  const targets = [
    ...new Map(input.targets.map((target) => [scopedThreadKey(target), target])).values(),
  ];
  if (targets.length > SIDEBAR_UNDO_BATCH_LIMIT) {
    throw new RangeError(`A bulk action changes at most ${SIDEBAR_UNDO_BATCH_LIMIT} threads.`);
  }
  const readContext = (target: ScopedThreadRef) => {
    try {
      return input.readContext(target);
    } catch {
      return null;
    }
  };
  const skipped: ScopedThreadRef[] = [];
  const sent = new Map<
    string,
    { target: ScopedThreadRef; context: SidebarUndoContext; command: SidebarBatchCommand }
  >();
  let commandType: SidebarBatchCommand["type"] | undefined;
  for (const target of targets) {
    const context = readContext(target);
    if (!context) {
      skipped.push(target);
      continue;
    }
    const command = input.command(target);
    commandType ??= command.type;
    if (command.type !== commandType || command.threadId !== target.threadId) {
      throw new Error("A bulk action sends one command type, each to its own thread.");
    }
    sent.set(scopedThreadKey(target), { target, context, command });
  }
  const queue = [...sent.values()];

  const undoable = commandType === "thread.settle" || commandType === "thread.snooze";
  const members = undoable
    ? queue.filter(({ context }) => context.supported).map(({ target }) => target)
    : [];
  const valid = (member: ScopedThreadRef) => {
    const send = sent.get(scopedThreadKey(member));
    return send !== undefined && readContext(member)?.generation === send.context.generation;
  };
  const restore = async (live: readonly ScopedThreadRef[]) => {
    const errors: unknown[] = [];
    await inPool(live, async (member) => {
      const send = sent.get(scopedThreadKey(member))!;
      try {
        await send.context.api.orchestration.dispatchCommand({
          type: "thread.sidebar.undo",
          threadId: send.target.threadId,
          commandId: input.newCommandId(),
          undoCommandId: send.command.commandId,
        });
      } catch (error) {
        errors.push(error);
      }
    });
    if (errors.length === 0) return;
    if (live.length === 1) throw errors[0];
    const [first] = errors;
    throw new Error(
      `${errors.length} of ${live.length} threads could not be restored.${
        first instanceof Error ? ` ${first.message}` : ""
      }`,
    );
  };

  for (const { target } of queue) input.history.supersede(target);
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const notice =
    members.length > 0
      ? input.history.track({
          action: commandType === "thread.settle" ? "settle" : "snooze",
          members,
          ready,
          valid,
          restore,
          describe: input.describe,
        })
      : null;
  const applied: ScopedThreadRef[] = [];
  const failed: { target: ScopedThreadRef; error: unknown }[] = [];
  let withoutUndo = 0;
  await inPool(queue, async ({ target, context, command }) => {
    try {
      await context.api.orchestration.dispatchCommand(command);
      applied.push(target);
      if (undoable && !context.supported) withoutUndo += 1;
    } catch (error) {
      failed.push({ target, error });
      notice?.drop(target);
    }
  });
  notice?.applied();
  finish();
  return { applied, skipped, failed, withoutUndo };
}
