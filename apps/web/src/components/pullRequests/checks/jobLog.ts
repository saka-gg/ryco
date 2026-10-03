/**
 * GitHub Actions job logs, made readable: timestamps, ANSI codes and runner
 * markers are stripped, the log is cut into per-step sections at the runner's
 * `##[group]Run …` boundaries, and `path:line` references become links into
 * the change request's Files tab when they name a changed file.
 */

export type JobLogTone = "plain" | "error" | "warning" | "command" | "muted";

export interface JobLogLine {
  readonly text: string;
  readonly tone: JobLogTone;
}

export interface JobLogSection {
  /** The step the runner announced (`Run bun test`), or null for setup / cleanup output. */
  readonly title: string | null;
  readonly lines: ReadonlyArray<JobLogLine>;
  /** The section reports a runner error (`##[error]`). */
  readonly failed: boolean;
}

// `2026-10-03T09:41:12.1234567Z ` — the runner's per-line timestamp.
const TIMESTAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/u;
// oxlint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/gu;
const RUNNER_MARKER = /^##\[(group|endgroup|error|warning|notice|debug|command|section)\](.*)$/u;
const ERROR_HINT =
  /(?:^|\s)(?:FAIL|ERR!)\b|\b(?:AssertionError|TypeError|ReferenceError|SyntaxError)\b|^\s*(?:error|Error)(?:\[[^\]]*\])?:|^::error\b|\bexited with code [1-9]|(?:^|\s)[×✗✘](?:\s|$)/u;
const WARNING_HINT = /^::warning\b|^\s*(?:warning|Warning):/u;
// Phases the runner prints without a group after the last step.
const CLEANUP_START = /^(?:Post job cleanup\.|Cleaning up orphan processes)/u;

function cleanLine(raw: string): string {
  return raw.replace(TIMESTAMP, "").replace(ANSI, "").replace(/\r$/u, "");
}

function toneFor(text: string): JobLogTone {
  if (ERROR_HINT.test(text)) return "error";
  if (WARNING_HINT.test(text)) return "warning";
  return "plain";
}

/**
 * Split a raw job log into sections. Each `##[group]Run …` opens a step
 * section whose own header group (the echoed command and its environment) is
 * dropped — the step row already names it. Other groups keep their content.
 */
export function splitJobLog(raw: string): ReadonlyArray<JobLogSection> {
  const sections: Array<{ title: string | null; lines: JobLogLine[]; failed: boolean }> = [
    { title: null, lines: [], failed: false },
  ];
  let skippingHeader = false;
  const current = () => sections[sections.length - 1]!;

  for (const rawLine of raw.split("\n")) {
    const text = cleanLine(rawLine);
    const marker = RUNNER_MARKER.exec(text);
    if (marker) {
      const [, kind, rest = ""] = marker;
      if (kind === "group") {
        if (rest.startsWith("Run ")) {
          sections.push({ title: rest, lines: [], failed: false });
          skippingHeader = true;
        }
        continue;
      }
      if (kind === "endgroup") {
        skippingHeader = false;
        continue;
      }
      if (skippingHeader) continue;
      if (kind === "error") {
        current().lines.push({ text: `Error: ${rest}`, tone: "error" });
        current().failed = true;
      } else if (kind === "warning") {
        current().lines.push({ text: `Warning: ${rest}`, tone: "warning" });
      } else if (kind === "command") {
        current().lines.push({ text: rest, tone: "command" });
      } else if (kind !== "debug") {
        current().lines.push({ text: rest, tone: "muted" });
      }
      continue;
    }
    if (skippingHeader) continue;
    if (CLEANUP_START.test(text) && current().title !== null) {
      sections.push({ title: null, lines: [], failed: false });
    }
    current().lines.push({ text, tone: text.startsWith("$ ") ? "command" : toneFor(text) });
  }

  // Step sections stay even when empty, so sections and steps line up by position.
  return sections.filter(
    (section, index) =>
      index === 0 || section.title !== null || section.lines.length > 0 || section.failed,
  );
}

function normalizeStepName(name: string): string {
  return name.trim().replace(/^Run /u, "").trim();
}

// Steps the runner wraps around the user's steps; their output is ungrouped.
const SETUP_STEP = /^Set up job$/iu;
const TEARDOWN_STEP = /^(?:Complete job|Post .+)$/iu;

/**
 * The section a step printed: the group the runner opened for it by name;
 * otherwise by position, since the runner opens one `Run …` group per user
 * step in order (`Checkout` prints as `Run actions/checkout@v5`), with setup
 * output before the first group and post-step cleanup after the last.
 */
function sectionForStep(
  sections: ReadonlyArray<JobLogSection>,
  step: { readonly name: string },
  steps: ReadonlyArray<{ readonly name: string }> | undefined,
): JobLogSection | null {
  const wanted = normalizeStepName(step.name);
  const named = sections.find(
    (candidate) => candidate.title !== null && normalizeStepName(candidate.title) === wanted,
  );
  if (named) return named;
  const titled = sections.filter((candidate) => candidate.title !== null);
  if (SETUP_STEP.test(step.name)) {
    const first = sections[0];
    return first && first.title === null && first.lines.length > 0 ? first : null;
  }
  if (TEARDOWN_STEP.test(step.name)) {
    const last = sections.at(-1);
    return last && last.title === null && titled.length > 0 ? last : null;
  }
  if (!steps) return null;
  const userSteps = steps.filter(
    (candidate) => !SETUP_STEP.test(candidate.name) && !TEARDOWN_STEP.test(candidate.name),
  );
  const index = userSteps.findIndex((candidate) => candidate.name === step.name);
  // Positions only line up when every user step opened exactly one group.
  return index !== -1 && userSteps.length === titled.length ? (titled[index] ?? null) : null;
}

/**
 * The lines of one step (see `sectionForStep`). The failing step falls back
 * to the section that reported the error, and is cut after its last error
 * line so post-step noise does not bury the failure.
 */
export function jobLogStepLines(
  sections: ReadonlyArray<JobLogSection>,
  step: { readonly name: string },
  options: {
    readonly failing: boolean;
    /** Every step of the job, in order, for matching by position. */
    readonly steps?: ReadonlyArray<{ readonly name: string }> | undefined;
  },
): ReadonlyArray<JobLogLine> | null {
  let section = sectionForStep(sections, step, options.steps);
  if (section === null && options.failing) {
    section =
      sections.find((candidate) => candidate.failed) ??
      sections.findLast((candidate) => candidate.title !== null) ??
      null;
  }
  if (section === null) return null;
  if (!options.failing) return section.lines;
  let lastError = -1;
  section.lines.forEach((line, index) => {
    if (line.tone === "error") lastError = index;
  });
  return lastError === -1 ? section.lines : section.lines.slice(0, lastError + 1);
}

/** Every section flattened, each step introduced by its `Run …` title. */
export function jobLogAllLines(sections: ReadonlyArray<JobLogSection>): ReadonlyArray<JobLogLine> {
  return sections.flatMap((section) =>
    section.title === null
      ? section.lines
      : [{ text: section.title, tone: "command" as const }, ...section.lines],
  );
}

/** How much of a step's log the Checks tab shows before "Show full log". */
export const JOB_LOG_TAIL_LINES = 200;

/** The last `count` lines, with the 1-based number of the first one shown. */
export function jobLogTail(
  lines: ReadonlyArray<JobLogLine>,
  count: number = JOB_LOG_TAIL_LINES,
): { readonly lines: ReadonlyArray<JobLogLine>; readonly firstLineNumber: number } {
  const start = Math.max(0, lines.length - count);
  return { lines: start === 0 ? lines : lines.slice(start), firstLineNumber: start + 1 };
}

/** Plain text of the last `count` lines, for agent hand-offs. */
export function jobLogTailText(lines: ReadonlyArray<JobLogLine>, count: number): string {
  return lines
    .slice(-count)
    .map((line) => line.text)
    .join("\n")
    .trim();
}

// ── path:line links ──────────────────────────────────────────────────

export type JobLogSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly path: string; readonly line: number };

// `src/a/b.ts:40`, `/home/runner/work/r/r/src/b.ts:40:43`, `apps\web\x.tsx:3`.
const PATH_LINE =
  /((?:[A-Za-z]:)?[\\/]?(?:[\w.@+~-]+[\\/])*[\w.@+~-]*\.[A-Za-z]\w{0,9}):(\d+)(?::\d+)?/gu;
// Workflow commands: `::error file=src/b.ts,line=40,col=3::message` (any parameter order).
const WORKFLOW_COMMAND = /^::(?:error|warning|notice)\s+([^:]*(?::(?!:)[^:]*)*)::/u;

interface LinkMatch {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly line: number;
}

function workflowCommandMatch(text: string): LinkMatch | null {
  const command = WORKFLOW_COMMAND.exec(text);
  if (!command?.[1]) return null;
  const params = command[1];
  const paramsStart = text.indexOf(params);
  const file = /(?:^|,)file=([^,]+)/u.exec(params);
  const line = /(?:^|,)line=(\d+)/u.exec(params);
  if (!file?.[1] || !line?.[1] || file.index === undefined) return null;
  const start = paramsStart + file.index + file[0].indexOf(file[1]);
  return { start, end: start + file[1].length, raw: file[1], line: Number(line[1]) };
}

/**
 * Split a log line into text and Files links. `resolvePath` maps the raw path
 * (relative to wherever the tool ran, or an absolute runner path) to a changed
 * file of the change request; unresolved paths stay plain text.
 */
export function linkifyJobLogLine(
  text: string,
  resolvePath: (raw: string) => string | null,
): ReadonlyArray<JobLogSegment> {
  const matches: LinkMatch[] = [];
  const command = workflowCommandMatch(text);
  if (command) matches.push(command);
  for (const match of text.matchAll(PATH_LINE)) {
    const raw = match[1];
    const line = Number(match[2]);
    if (!raw || !Number.isSafeInteger(line) || line <= 0 || match.index === undefined) continue;
    matches.push({ start: match.index, end: match.index + match[0].length, raw, line });
  }
  if (matches.length === 0) return [{ kind: "text", text }];

  const segments: JobLogSegment[] = [];
  let cursor = 0;
  for (const match of matches.toSorted((left, right) => left.start - right.start)) {
    if (match.start < cursor) continue;
    const path = resolvePath(match.raw);
    if (path === null) continue;
    if (match.start > cursor)
      segments.push({ kind: "text", text: text.slice(cursor, match.start) });
    segments.push({
      kind: "link",
      text: text.slice(match.start, match.end),
      path,
      line: match.line,
    });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments.length === 0 ? [{ kind: "text", text }] : segments;
}

/**
 * Resolve log paths against the change request's files: exact, a relative
 * suffix (`src/x.ts` → `apps/web/src/x.ts`, only when unambiguous), or an
 * absolute runner path that ends in a changed file.
 */
export function createJobLogPathResolver(
  files: ReadonlyArray<string>,
): (raw: string) => string | null {
  const known = new Set(files);
  const cache = new Map<string, string | null>();
  return (raw) => {
    const cached = cache.get(raw);
    if (cached !== undefined) return cached;
    const path = raw.replaceAll("\\", "/").replace(/^\.\//u, "");
    let resolved: string | null = null;
    if (known.has(path)) {
      resolved = path;
    } else {
      const containing = files.filter((file) => path.endsWith(`/${file}`));
      if (containing.length > 0) {
        resolved = containing.reduce((best, file) => (file.length > best.length ? file : best));
      } else if (!path.startsWith("/")) {
        const suffixed = files.filter((file) => file.endsWith(`/${path}`));
        resolved = suffixed.length === 1 ? suffixed[0]! : null;
      }
    }
    cache.set(raw, resolved);
    return resolved;
  };
}
