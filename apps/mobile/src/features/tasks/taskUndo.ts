// The Tasks tab's Undo notice: one at a time, the newest, lapsing after five
// seconds like the thread actions' notice. Kept outside React so a change made
// in the task sheet can still offer its Undo on the list.

export interface TaskUndoNotice {
  readonly id: number;
  readonly message: string;
  readonly undo: () => void;
}

export const TASK_UNDO_LAPSE_MS = 5_000;

let notice: TaskUndoNotice | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

export const taskUndoNotices = {
  read: (): TaskUndoNotice | null => notice,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Offers Undo for a change just made; replaces the notice before it. */
export function offerTaskUndo(message: string, undo: () => void): number {
  clearTimer();
  const id = nextId++;
  notice = { id, message, undo };
  timer = setTimeout(() => dismissTaskUndo(id), TASK_UNDO_LAPSE_MS);
  emit();
  return id;
}

export function dismissTaskUndo(id: number): void {
  if (notice?.id !== id) return;
  clearTimer();
  notice = null;
  emit();
}

/** Runs the notice's undo once and takes the notice away. */
export function runTaskUndo(id: number): void {
  const current = notice;
  if (current?.id !== id) return;
  dismissTaskUndo(id);
  current.undo();
}
