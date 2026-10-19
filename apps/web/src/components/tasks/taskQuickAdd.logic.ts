import type { ProjectId } from "@ryco/contracts";
import { addDays, dayStart } from "@ryco/shared/automationSchedule";

import { dueAtForDay, nextWeekdayDayStart } from "./taskDue.logic";
import type { TaskProjectOption } from "./tasksViewModel";

/**
 * The add row's shorthand: `#project` files the task under a project and
 * `due:fri` / `@fri` gives it a due day. Recognised tokens leave the title and
 * show as chips while typing; anything that doesn't resolve stays in the title
 * as typed, so "Fix #231" keeps its issue number.
 */

export type TaskQuickAddChip =
  | { readonly kind: "project"; readonly project: TaskProjectOption }
  | { readonly kind: "due"; readonly dueAt: string };

export interface TaskQuickAdd {
  readonly title: string;
  readonly projectId: ProjectId | null;
  readonly dueAt: string | null;
  readonly chips: ReadonlyArray<TaskQuickAddChip>;
}

// A dot may join words ("ryco.app") but never ends a token, so "#ryco." keeps its full stop.
const PROJECT_TOKEN = /(^|\s)#([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*)/gu;
const DUE_TOKEN =
  /(^|\s)(?:due:|@)(today|tomorrow|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?![\p{L}\p{N}_-])/giu;
const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** How a project name is typed after `#`: lower case, spaces as dashes. */
function projectTokenName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * The project a `#token` names: an exact name first (the first in sidebar
 * order when names repeat), else the one project whose name starts with it.
 * An ambiguous prefix names nothing.
 */
export function resolveQuickAddProject(
  token: string,
  projects: ReadonlyArray<TaskProjectOption>,
): TaskProjectOption | null {
  const typed = token.toLowerCase();
  if (typed.length === 0) return null;
  const exact = projects.find((project) => projectTokenName(project.name) === typed);
  if (exact) return exact;
  let match: TaskProjectOption | null = null;
  for (const project of projects) {
    if (!projectTokenName(project.name).startsWith(typed)) continue;
    if (match !== null) return null;
    match = project;
  }
  return match;
}

/** The day a due word names; a weekday is its next occurrence, a week out on that weekday. */
function dueDayFor(word: string, nowMs: number): number {
  const lower = word.toLowerCase();
  if (lower === "today") return dayStart(nowMs);
  if (lower === "tomorrow") return addDays(dayStart(nowMs), 1);
  return nextWeekdayDayStart(nowMs, WEEKDAY_INDEX[lower.slice(0, 3)] ?? 0);
}

/** Reads the add row's text: the title without its tokens, the project and due day they name. */
export function parseTaskQuickAdd(
  raw: string,
  projects: ReadonlyArray<TaskProjectOption>,
  nowMs: number,
): TaskQuickAdd {
  // The last token of each kind wins; every recognised one leaves the title.
  const found: { project: TaskProjectOption | null; dueAt: string | null } = {
    project: null,
    dueAt: null,
  };
  const withoutProject = raw.replace(PROJECT_TOKEN, (token, lead: string, name: string) => {
    const resolved = resolveQuickAddProject(name, projects);
    if (!resolved) return token;
    found.project = resolved;
    return lead;
  });
  const withoutDue = withoutProject.replace(DUE_TOKEN, (_token, lead: string, word: string) => {
    found.dueAt = dueAtForDay(dueDayFor(word, nowMs));
    return lead;
  });
  const chips: TaskQuickAddChip[] = [];
  if (found.project) chips.push({ kind: "project", project: found.project });
  if (found.dueAt) chips.push({ kind: "due", dueAt: found.dueAt });
  return {
    title: withoutDue.replace(/\s+/g, " ").trim(),
    projectId: found.project?.projectId ?? null,
    dueAt: found.dueAt,
    chips,
  };
}

// "- ", "* ", "• ", "1. ", "2) " and a Markdown checkbox after any of them.
// Numbers need the space after them so "1.5x faster" stays whole.
const LIST_MARKER = /^\s*(?:[-*]\s+|•\s*|\d+[.)]\s+)?(?:\[[ xX]\]\s+)?/;

/** A pasted list as one title per line, without list markers or blank lines. */
export function splitPastedTaskLines(text: string): ReadonlyArray<string> {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(LIST_MARKER, "").trim())
    .filter((line) => line.length > 0);
}
