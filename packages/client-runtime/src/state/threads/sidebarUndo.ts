import { isArchivedThreadStub, type SidebarThreadOrStub } from "./types.ts";
import type {
  CommandId,
  DispatchableClientOrchestrationCommand,
  EnvironmentApi,
  ScopedThreadRef,
} from "@ryco/contracts";
import { scopedThreadKey } from "../../scoped.ts";

export const SIDEBAR_UNDO_DURATION_MS = 5_000;
/** A bulk notice applies for at most this long, so its Undo still finds the node's 30 s receipts. */
const SIDEBAR_UNDO_APPLYING_LIMIT_MS = 25_000;
/**
 * Most threads one bulk action changes; a node keeps 256 Undo receipts. Here
 * rather than with the batch dispatcher, so the screens that cap a selection
 * do not load it.
 */
export const SIDEBAR_UNDO_BATCH_LIMIT = 100;
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
/** Copy a bulk action supplies for its notice, so presenters need no plural copy of their own. */
export interface SidebarUndoCopy {
  readonly title: string;
  readonly description?: string | undefined;
  /** Accessible name of the Undo control. */
  readonly undoLabel: string;
}
export type SidebarUndoDescribe = (notice: {
  readonly count: number;
  readonly applying: boolean;
}) => SidebarUndoCopy;
export interface SidebarUndoNotice {
  readonly id: number;
  readonly action: SidebarUndoAction;
  /** The first thread the notice covers. */
  readonly target: ScopedThreadRef;
  /** Threads a bulk notice covers; absent for one thread. */
  readonly count?: number | undefined;
  readonly pending: boolean;
  readonly applying?: boolean;
  readonly threadTitle?: string | undefined;
  readonly copy?: SidebarUndoCopy | undefined;
}

/**
 * A local pin restores ordering, without treating response text/status updates as a new action.
 * An archived stub's revision covers the ordering fields it has; it differs from the revision of
 * the same thread's full summary, so swapping one for the other reads as a change.
 */
export function sidebarUndoThreadRevision(thread: SidebarThreadOrStub): string {
  if (isArchivedThreadStub(thread)) {
    return JSON.stringify([
      "archived-stub",
      thread.projectId,
      thread.title,
      thread.createdAt,
      thread.archivedAt,
      thread.branch,
      thread.worktreePath,
      thread.worktreeId,
      thread.latestUserMessageAt,
      thread.latestUserMessageAt == null ? thread.updatedAt : null,
    ]);
  }
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
  type Entry = Pick<SidebarUndoNotice, "id" | "action" | "threadTitle"> & {
    /** Threads Undo still restores; a notice closes with its last one. */
    members: readonly ScopedThreadRef[];
    applying: boolean;
    pending: boolean;
    restoring: boolean;
    expiresAt: number;
    valid: (member: ScopedThreadRef) => boolean;
    restore: (members: readonly ScopedThreadRef[]) => Promise<void>;
    ready: Promise<unknown>;
    describe?: SidebarUndoDescribe | undefined;
    cleanup?: () => void;
  };
  let nextId = 0;
  let entries: Entry[] = [];
  let timer: unknown;
  const notice = ({
    id,
    action,
    members,
    pending,
    applying,
    threadTitle,
    describe,
  }: Entry): SidebarUndoNotice => ({
    id,
    action,
    target: members[0]!,
    count: members.length > 1 ? members.length : undefined,
    pending,
    applying,
    threadTitle,
    copy: describe?.({ count: members.length, applying }),
  });
  const publish = () => deps.changed(entries.map(notice));
  const remove = (id: number) => {
    entries.find((entry) => entry.id === id)?.cleanup?.();
    entries = entries.filter((entry) => entry.id !== id);
    publish();
  };
  /** Drops a thread from its notice (only from `only` when given). */
  const release = (target: ScopedThreadRef, only?: Entry) => {
    const key = scopedThreadKey(target);
    for (const entry of entries) {
      if (only && entry !== only) continue;
      const members = entry.members.filter((member) => scopedThreadKey(member) !== key);
      if (members.length === entry.members.length) continue;
      entry.members = members;
      if (members.length) publish();
      else remove(entry.id);
    }
  };
  const prune = () => {
    let changed = false;
    entries = entries.filter((entry) => {
      const members = entry.members.filter(entry.valid);
      if (members.length !== entry.members.length) changed = true;
      entry.members = members;
      if (members.length && (entry.restoring || now() < entry.expiresAt)) return true;
      entry.cleanup?.();
      changed = true;
      return false;
    });
    if (changed) publish();
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
    duration = SIDEBAR_UNDO_DURATION_MS,
  ) => {
    // A newer action on a thread supersedes its older notice, even while in flight.
    for (const member of input.members) release(member);
    const entry: Entry = {
      ...input,
      id: ++nextId,
      expiresAt: now() + duration,
      pending: false,
      restoring: false,
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
      release(target);
      const ready = context.api.orchestration.dispatchCommand(command);
      const valid = () => readContext(target)?.generation === context.generation;
      const entry =
        context.supported &&
        (command.type === "thread.archive" ||
          command.type === "thread.settle" ||
          command.type === "thread.snooze")
          ? add({
              members: [target],
              threadTitle: context.threadTitle,
              valid,
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
                if (entry && entries.includes(entry) && valid())
                  await onRestored?.(() => entries.includes(entry) && valid());
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
    /**
     * One notice for a bulk action. It stays while the commands apply (at most 25 s), and its
     * five seconds start once `applied()` reports that every command settled.
     */
    track(input: Pick<Entry, "action" | "members" | "valid" | "restore" | "ready" | "describe">) {
      const entry = add({ ...input, applying: true }, SIDEBAR_UNDO_APPLYING_LIMIT_MS);
      return {
        /** Takes out a thread whose command failed. */
        drop: (target: ScopedThreadRef) => release(target, entry),
        applied: () => {
          prune();
          if (!entries.includes(entry)) return;
          entry.applying = false;
          entry.expiresAt = now() + SIDEBAR_UNDO_DURATION_MS;
          publish();
        },
      };
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
        members: [target],
        threadTitle: context.threadTitle,
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
      release(target);
      schedule();
    },
    /** The newest notice whose Undo can still run, for a keyboard Undo. */
    latest(): SidebarUndoNotice | null {
      prune();
      const entry = entries.findLast((entry) => !entry.pending);
      return entry === undefined ? null : notice(entry);
    },
    async undo(id: number) {
      prune();
      const entry = entries.find((entry) => entry.id === id);
      if (!entry || entry.pending) return;
      entry.pending = true;
      publish();
      try {
        await entry.ready;
        prune();
        if (!entries.includes(entry)) return;
        // Once submitted while valid, keep the progress notice until acknowledgment.
        entry.restoring = true;
        await entry.restore(entry.members);
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

export type SidebarUndoHistory = ReturnType<typeof createSidebarUndoHistory>;
