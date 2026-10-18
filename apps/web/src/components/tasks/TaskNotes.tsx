import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { TASK_NOTES_MAX_LENGTH } from "./tasksUi";

/** How long typing may pause before the notes are saved. */
export const TASK_NOTES_SAVE_DELAY_MS = 500;

/**
 * A task's notes: a borderless field that grows with its text. Typing is
 * saved half a second after it pauses, and at once when the field loses
 * focus, the row closes or the row goes away, so nothing typed is lost.
 * A newer value from the node replaces the text while nothing typed is
 * waiting to be saved and the field isn't being edited, or else once it
 * loses focus with nothing waiting: a save that was undone, or someone
 * else's edit, then shows instead of text the task doesn't hold.
 */
export function TaskNotes(props: {
  readonly taskId: string;
  readonly notes: string;
  /** The row is open; closing it saves at once. */
  readonly open: boolean;
  readonly onNotesChange: (taskId: string, notes: string) => void;
}) {
  const { taskId, notes, open } = props;
  const [value, setValue] = useState(notes);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedRef = useRef(false);
  const savedRef = useRef(notes);
  const latestRef = useRef({ taskId, onNotesChange: props.onNotesChange });
  useLayoutEffect(() => {
    latestRef.current = { taskId, onNotesChange: props.onNotesChange };
  });

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending === null) return;
    pendingRef.current = null;
    if (pending === savedRef.current) return;
    savedRef.current = pending;
    latestRef.current.onNotesChange(latestRef.current.taskId, pending);
  }, []);

  useEffect(() => {
    savedRef.current = notes;
    if (pendingRef.current !== null || focusedRef.current) return;
    setValue(notes);
  }, [notes]);

  useEffect(() => {
    if (!open) flush();
  }, [open, flush]);

  useEffect(() => flush, [flush]);

  return (
    <textarea
      className="tsk-notes block min-h-[22px] w-full resize-none border-0 bg-transparent p-0 text-[13px] leading-[1.55] text-muted-foreground outline-none field-sizing-content"
      rows={1}
      maxLength={TASK_NOTES_MAX_LENGTH}
      value={value}
      placeholder="Notes, context, what done looks like…"
      aria-label="Notes"
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        flush();
        // What the task holds now: the text just saved, or a value that came in while editing.
        setValue(savedRef.current);
      }}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setValue(next);
        pendingRef.current = next;
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flush, TASK_NOTES_SAVE_DELAY_MS);
      }}
    />
  );
}
