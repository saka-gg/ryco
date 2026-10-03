/**
 * Task-list editing for Markdown bodies. `MarkdownView` reports a toggled
 * checkbox by the source offset of its state character (the one between the
 * brackets), taken from the parser that rendered it, so no line heuristics
 * are needed here. A toggle only ever rewrites that one character, which
 * keeps every other offset in the body stable.
 */

/** `[ ]`, `[\t]` (unchecked) and `[x]`, `[X]` (checked). */
function isTaskStateChar(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "x" || char === "X";
}

function isTaskStateAt(body: string, offset: number): boolean {
  return body[offset - 1] === "[" && body[offset + 1] === "]" && isTaskStateChar(body[offset]);
}

/** Whether the box whose state character sits at `offset` is checked; null if none is there. */
export function readTaskState(body: string, offset: number): boolean | null {
  if (!Number.isSafeInteger(offset) || !isTaskStateAt(body, offset)) return null;
  const char = body[offset];
  return char === "x" || char === "X";
}

/**
 * The body with the box at `offset` checked or unchecked. Returns `body`
 * unchanged (same string) when there is no box there or it already has that state.
 */
export function setTaskState(body: string, offset: number, checked: boolean): string {
  const current = readTaskState(body, offset);
  if (current === null || current === checked) return body;
  return `${body.slice(0, offset)}${checked ? "x" : " "}${body.slice(offset + 1)}`;
}

/**
 * True when `left` and `right` say the same thing apart from which boxes are
 * ticked: the same length, and every differing character is a box's state.
 * Toggles (ours or a teammate's) pass; any other edit does not.
 */
export function sameTextIgnoringTaskStates(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue;
    if (!isTaskStateAt(left, index) || !isTaskStateAt(right, index)) return false;
  }
  return true;
}

/** One click on a task box: the body it was made against and the state asked for. */
export interface TaskToggle {
  /** The description the click was made against. */
  readonly base: string;
  /** Offset of the box's state character, in `base`. */
  readonly offset: number;
  readonly checked: boolean;
}

/**
 * Applies `toggle` to `body`, which may be newer than the body it was made
 * against. Null when `body` changed beyond ticked boxes (the offset may now
 * point elsewhere), so the toggle must not be applied.
 */
export function rebaseTaskToggle(body: string, toggle: TaskToggle): string | null {
  if (!sameTextIgnoringTaskStates(toggle.base, body)) return null;
  if (readTaskState(body, toggle.offset) === null) return null;
  return setTaskState(body, toggle.offset, toggle.checked);
}

/**
 * Applies `toggles` in order. `rejected` counts the ones `body` no longer
 * supports (they are skipped, the rest still apply).
 */
export function applyTaskToggles(
  body: string,
  toggles: ReadonlyArray<TaskToggle>,
): { readonly body: string; readonly rejected: number } {
  let next = body;
  let rejected = 0;
  for (const toggle of toggles) {
    const applied = rebaseTaskToggle(next, toggle);
    if (applied === null) rejected += 1;
    else next = applied;
  }
  return { body: next, rejected };
}
