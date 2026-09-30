import type { SidebarThreadSummary } from "./types.ts";
import type {
  CommandId,
  DispatchableClientOrchestrationCommand,
  EnvironmentApi,
  ScopedThreadRef,
} from "@ryco/contracts";
import { scopedThreadKey } from "../../scoped.ts";

export const SIDEBAR_UNDO_DURATION_MS = 5_000;
export type SidebarUndoAction = "archive" | "settle" | "snooze" | "unpin";
export type SidebarUndoCommand = Extract<
  DispatchableClientOrchestrationCommand,
  { type: "thread.archive" | "thread.settle" | "thread.snooze" }
>;
export type SidebarActionCommand = Extract<
  DispatchableClientOrchestrationCommand,
  {
    type:
      | "thread.archive"
      | "thread.unarchive"
      | "thread.settle"
      | "thread.unsettle"
      | "thread.snooze"
      | "thread.unsnooze";
  }
>;
export interface SidebarUndoContext {
  /** Accepted shell attempt, not the active environment or an API facade. */
  readonly generation: object;
  readonly api: EnvironmentApi;
  readonly supported: boolean;
  readonly threadRevision?: object | string;
  readonly parentRevision?: object;
  readonly threadTitle?: string | undefined;
}
/** Local pin state does not require a connection or server mutation authority. */
export interface SidebarUndoLocalContext {
  readonly threadRevision: object | string;
  readonly parentRevision: object;
  readonly threadTitle?: string | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}
export interface SidebarUndoNotice {
  readonly id: number;
  readonly action: SidebarUndoAction;
  readonly target: ScopedThreadRef;
  readonly pending: boolean;
  readonly applying?: boolean;
  readonly threadTitle?: string | undefined;
}

/** A local pin restores ordering, without treating response text/status updates as a new action. */
export function sidebarUndoThreadRevision(thread: SidebarThreadSummary): string {
  return JSON.stringify([
    thread.projectId,
    thread.title,
    thread.modelSelection,
    thread.interactionMode,
    thread.tokenMode,
    thread.createdAt,
    thread.archivedAt,
    thread.settledOverride,
    thread.settledAt,
    thread.snoozedUntil,
    thread.snoozedAt,
    thread.branch,
    thread.worktreePath,
    thread.worktreeId,
    thread.manualStatusBucket,
    thread.manualPosition,
    thread.latestUserMessageAt,
    thread.priority,
    // The existing sorter uses updatedAt only when no user message provides recency.
    thread.latestUserMessageAt == null ? thread.updatedAt : null,
  ]);
}

/** Five-second, bounded sidebar action history shared by web and native presenters. */
export function createSidebarUndoHistory(deps: {
  readonly readContext: (target: ScopedThreadRef) => SidebarUndoContext | null;
  readonly readLocalContext?: (target: ScopedThreadRef) => SidebarUndoLocalContext | null;
  readonly newCommandId: () => CommandId;
  readonly changed: (notices: readonly SidebarUndoNotice[]) => void;
  readonly failed: (error: unknown) => void;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delay: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}) {
  const now = deps.now ?? (() => Date.now());
  const readContext = (target: ScopedThreadRef) => {
    try {
      return deps.readContext(target);
    } catch {
      return null;
    }
  };
  const readLocalContext = (target: ScopedThreadRef) => {
    try {
      return deps.readLocalContext?.(target) ?? null;
    } catch {
      return null;
    }
  };
  const setTimer = deps.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  type Entry = Omit<SidebarUndoNotice, "pending" | "applying"> & {
    applying: boolean;
    pending: boolean;
    restoring: boolean;
    expiresAt: number;
    context: SidebarUndoContext | SidebarUndoLocalContext;
    valid: () => boolean;
    restore: () => Promise<void>;
    ready: Promise<unknown>;
    cleanup?: () => void;
  };
  let nextId = 0;
  let entries: Entry[] = [];
  let timer: unknown;
  const current = (entry: Entry) => (entry.restoring || now() < entry.expiresAt) && entry.valid();
  const publish = () =>
    deps.changed(
      entries.map(({ id, action, target, pending, applying, threadTitle }) => ({
        id,
        action,
        target,
        pending,
        applying,
        threadTitle,
      })),
    );
  const remove = (id: number) => {
    entries.find((entry) => entry.id === id)?.cleanup?.();
    entries = entries.filter((entry) => entry.id !== id);
    publish();
  };
  const prune = () => {
    const next = entries.filter((entry) => {
      if (current(entry)) return true;
      entry.cleanup?.();
      return false;
    });
    if (next.length !== entries.length) {
      entries = next;
      publish();
    }
  };
  const schedule = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (entries.length)
      timer = setTimer(() => {
        timer = undefined;
        prune();
        schedule();
      }, 100);
  };
  const add = (
    input: Omit<Entry, "id" | "expiresAt" | "pending" | "applying" | "restoring"> & {
      applying?: boolean;
    },
  ) => {
    // A newer action on the same thread supersedes its older notice, even while in flight.
    entries = entries.filter((entry) => {
      if (scopedThreadKey(entry.target) !== scopedThreadKey(input.target)) return true;
      entry.cleanup?.();
      return false;
    });
    const entry: Entry = {
      ...input,
      id: ++nextId,
      expiresAt: now() + SIDEBAR_UNDO_DURATION_MS,
      pending: false,
      restoring: false,
      threadTitle: input.context.threadTitle,
      applying: input.applying ?? false,
    };
    entries.push(entry);
    if (entries.length > 5) entries.shift()?.cleanup?.();
    publish();
    schedule();
    return entry;
  };
  const history = {
    async dispatch(
      target: ScopedThreadRef,
      command: SidebarActionCommand,
      onRestored?: (isCurrent: () => boolean) => void | Promise<void>,
    ) {
      const context = readContext(target);
      if (!context || command.threadId !== target.threadId)
        throw new Error("The owning node is not ready for this action.");
      for (const entry of entries)
        if (scopedThreadKey(entry.target) === scopedThreadKey(target)) remove(entry.id);
      const ready = context.api.orchestration.dispatchCommand(command);
      const entry =
        context.supported &&
        (command.type === "thread.archive" ||
          command.type === "thread.settle" ||
          command.type === "thread.snooze")
          ? add({
              target,
              context,
              valid: () => readContext(target)?.generation === context.generation,
              action: command.type.slice(7) as SidebarUndoAction,
              ready,
              applying: true,
              restore: async () => {
                await context.api.orchestration.dispatchCommand({
                  type: "thread.sidebar.undo",
                  threadId: target.threadId,
                  commandId: deps.newCommandId(),
                  undoCommandId: command.commandId,
                });
                if (
                  entry &&
                  entries.includes(entry) &&
                  readContext(target)?.generation === context.generation
                )
                  await onRestored?.(
                    () =>
                      entries.includes(entry) &&
                      readContext(target)?.generation === context.generation,
                  );
              },
            })
          : null;
      try {
        await ready;
      } catch (error) {
        if (entry) remove(entry.id);
        throw error;
      }
      if (entry && entries.includes(entry)) {
        entry.applying = false;
        publish();
      }
      prune();
    },
    async archive(
      target: ScopedThreadRef,
      commandId: CommandId,
      navigation: {
        currentRoute: () => string | null;
        shouldLeave: () => boolean;
        leave: () => Promise<string | null>;
        reopen: () => void | Promise<void>;
      },
    ): Promise<void> {
      const generation = readContext(target)?.generation;
      const originRoute = navigation.currentRoute();
      let displacedRoute: string | null = null;
      let finishOriginal!: () => void;
      const originalFinished = new Promise<void>((resolve) => {
        finishOriginal = resolve;
      });
      try {
        await history.dispatch(
          target,
          { type: "thread.archive", commandId, threadId: target.threadId },
          async (isCurrent) => {
            await originalFinished;
            if (
              isCurrent() &&
              displacedRoute !== null &&
              navigation.currentRoute() === displacedRoute
            )
              await navigation.reopen();
          },
        );
        if (
          generation &&
          readContext(target)?.generation === generation &&
          originRoute !== null &&
          navigation.currentRoute() === originRoute &&
          navigation.shouldLeave()
        ) {
          displacedRoute = await navigation.leave();
        }
      } finally {
        finishOriginal();
      }
    },
    /** Always apply the local action; only offer Undo when its local state can be guarded. */
    unpin(
      target: ScopedThreadRef,
      pin: {
        read: () => boolean;
        write: (pinned: boolean) => void;
        subscribe: (listener: () => void) => () => void;
      },
    ) {
      if (!pin.read()) return;
      history.supersede(target);
      const context = readLocalContext(target);
      pin.write(false);
      if (!context) return;
      let changed = false;
      const sameLocalState = () => {
        const current = readLocalContext(target);
        return (
          current?.threadRevision === context.threadRevision &&
          current.parentRevision === context.parentRevision
        );
      };
      if (!sameLocalState()) return;
      const check = () => {
        // Keep invalidation sticky so a pin or cached thread ABA cannot revive an old Undo.
        if (pin.read() || !sameLocalState()) changed = true;
      };
      const unsubscribePin = pin.subscribe(check);
      const unsubscribeLocal = context.subscribe(check);
      const cleanup = () => {
        unsubscribePin();
        unsubscribeLocal();
      };
      add({
        target,
        context,
        valid: () => !changed && !pin.read() && sameLocalState(),
        action: "unpin",
        ready: Promise.resolve(),
        cleanup,
        restore: async () => {
          if (changed || pin.read() || !sameLocalState())
            throw new Error("The pin changed. Its current position was kept.");
          pin.write(true);
        },
      });
    },
    supersede(target: ScopedThreadRef) {
      for (const entry of entries)
        if (scopedThreadKey(entry.target) === scopedThreadKey(target)) remove(entry.id);
      schedule();
    },
    async undo(id: number) {
      prune();
      const entry = entries.find((entry) => entry.id === id);
      if (!entry || entry.pending) return;
      entry.pending = true;
      publish();
      try {
        await entry.ready;
        if (!entries.includes(entry) || !current(entry)) return;
        // Once submitted while valid, keep the progress notice until acknowledgment.
        entry.restoring = true;
        await entry.restore();
      } catch (error) {
        deps.failed(error);
      } finally {
        remove(id);
        schedule();
      }
    },
    dismiss(id: number) {
      remove(id);
      schedule();
    },
    invalidate: prune,
    dispose() {
      for (const entry of entries) entry.cleanup?.();
      entries = [];
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      publish();
    },
  };
  return history;
}
