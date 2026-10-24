import type { EnvironmentId } from "@ryco/contracts";
import type { UsageCalendarDate, UsageProviderKind } from "@ryco/contracts/usage";

import {
  mergeUsageEnvironmentResults,
  type MergedUsageBucket,
  type UsageEnvironmentResult,
} from "../../usage/merge.ts";
import type { MergedDailyRecap } from "./merge.ts";
import { previousCalendarDate } from "./request.ts";

/** Less agent time than this is not worth a mention. */
const MIN_AGENT_MS = 1_000;

/** A run of recap text: `strong` runs carry the facts, `bad` ones a failure. */
export type DailyRecapPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string; readonly tone?: "bad" };

export interface DailyRecapSentence {
  readonly id: "finished" | "work" | "usage" | "yesterday" | "waiting" | "tasks";
  readonly parts: readonly DailyRecapPart[];
}

export interface DailyRecapTile {
  readonly id:
    | "finished"
    | "agent-time"
    | "top-project"
    | "provider-tokens"
    | "yesterday"
    | "tasks";
  readonly label: string;
  readonly value: string;
  /** One short line under the value; empty when there is nothing to add. */
  readonly detail: readonly DailyRecapPart[];
}

/** Number and name formatting, supplied by the platform so the words stay shared. */
export interface DailyRecapFormat {
  /** A whole count, e.g. "1,234". */
  readonly integer: (value: number) => string;
  /** A run time, e.g. "4h 12m". */
  readonly duration: (ms: number) => string;
  /** A token count, e.g. "41M". */
  readonly compact: (value: number) => string;
  /** A model slug as people say it, e.g. "Claude Opus 5.5". */
  readonly model: (model: string) => string;
  /** US dollars, e.g. "$12.40". */
  readonly cost: (usd: number) => string;
}

/**
 * One local day of provider usage. It comes from provider histories, so it
 * includes work outside Ryco.
 */
export interface DailyRecapUsageDay {
  readonly tokens: number;
  /** Null when none of the day's tokens has a price. */
  readonly costUsd: number | null;
  /** Some of the day's tokens have no price, so `costUsd` covers only the others. */
  readonly costPartial: boolean;
  /** The model with the most tokens; null on a day without tokens. */
  readonly topModel: {
    readonly provider: UsageProviderKind;
    readonly model: string;
    /** Its part of the day's tokens, from 0 to 1. */
    readonly share: number;
  } | null;
}

export interface DailyRecapDigestInput {
  readonly today: MergedDailyRecap;
  /** The day before, from the same nodes; null until it loads. */
  readonly yesterday: MergedDailyRecap | null;
  /** Null where provider usage is not offered or has not loaded. */
  readonly usage: {
    readonly today: DailyRecapUsageDay;
    readonly yesterday: DailyRecapUsageDay;
  } | null;
  /** Open tasks due today and due before today; null where tasks are not offered. */
  readonly tasks: { readonly dueToday: number; readonly overdue: number } | null;
  /** Chats waiting on the user right now (see `createWaitingThreadCountSelector`). */
  readonly waitingThreads: number;
}

/** `date`'s provider usage, from the buckets of a merged Usage summary. */
export function summarizeUsageDay(
  buckets: readonly MergedUsageBucket[],
  date: UsageCalendarDate,
): DailyRecapUsageDay {
  let tokens = 0;
  let costUsd: number | null = null;
  let unpriced = false;
  const models = new Map<string, { provider: UsageProviderKind; model: string; tokens: number }>();
  for (const bucket of buckets) {
    if (bucket.date !== date) continue;
    tokens += bucket.tokens.totalTokens;
    if (bucket.estimatedCostUsd !== undefined) costUsd = (costUsd ?? 0) + bucket.estimatedCostUsd;
    if (bucket.unpricedTokenCount > 0) unpriced = true;
    const key = `${bucket.provider}\0${bucket.model}`;
    const model = models.get(key) ?? { provider: bucket.provider, model: bucket.model, tokens: 0 };
    model.tokens += bucket.tokens.totalTokens;
    models.set(key, model);
  }
  const [top] = [...models.values()].toSorted(
    (left, right) => right.tokens - left.tokens || left.model.localeCompare(right.model),
  );
  return {
    tokens,
    costUsd,
    costPartial: costUsd !== null && unpriced,
    topModel:
      top === undefined || tokens === 0
        ? null
        : { provider: top.provider, model: top.model, share: top.tokens / tokens },
  };
}

/**
 * The recap's two days of provider usage, from a Usage summary's per-device
 * answers. Only the devices in the recap count: one it leaves out (no answer
 * yet, too old for the recap, no access) would add tokens next to turns and a
 * footer that never include it. They are picked before merging, so a source
 * two devices share counts from a device in the recap. Null when none of them
 * has usage.
 */
export function summarizeRecapUsage(
  environments: readonly UsageEnvironmentResult[],
  recapEnvironmentIds: readonly EnvironmentId[],
  date: UsageCalendarDate,
): DailyRecapDigestInput["usage"] {
  const inRecap = new Set(recapEnvironmentIds);
  const merged = mergeUsageEnvironmentResults(
    environments.filter((environment) => inRecap.has(environment.environmentId)),
  );
  if (merged === null) return null;
  return {
    today: summarizeUsageDay(merged.buckets, date),
    yesterday: summarizeUsageDay(merged.buckets, previousCalendarDate(date)),
  };
}

function text(value: string): DailyRecapPart {
  return { kind: "text", text: value };
}

function strong(value: string, tone?: "bad"): DailyRecapPart {
  return tone === undefined
    ? { kind: "strong", text: value }
    : { kind: "strong", text: value, tone };
}

/** "1 chat", "12 chats". */
function count(format: DailyRecapFormat, value: number, one: string, many: string): string {
  return `${format.integer(value)} ${value === 1 ? one : many}`;
}

/** Agent time worth telling, or null. Older nodes report none. */
function agentMs(recap: MergedDailyRecap): number | null {
  const ms = recap.activity?.agentMs ?? 0;
  return ms >= MIN_AGENT_MS ? ms : null;
}

/** "Mostly" only when the top model holds most of the tokens. */
function modelLead(topModel: NonNullable<DailyRecapUsageDay["topModel"]>): "Mostly" | "Led by" {
  return topModel.share > 0.5 ? "Mostly" : "Led by";
}

function finishedParts(recap: MergedDailyRecap, format: DailyRecapFormat): DailyRecapPart[] | null {
  const { completedTurns, failedTurns } = recap.counts;
  if (completedTurns === 0) {
    return failedTurns === 0
      ? null
      : [strong(`${count(format, failedTurns, "turn", "turns")} failed`, "bad"), text(" today.")];
  }
  const parts = [
    text("You finished "),
    strong(count(format, completedTurns, "turn", "turns")),
    text(" in "),
    strong(count(format, recap.completed.totalThreads, "chat", "chats")),
    text("."),
  ];
  if (failedTurns > 0) {
    parts.push(text(" "), strong(`${format.integer(failedTurns)} failed`, "bad"), text("."));
  }
  return parts;
}

function workParts(
  recap: MergedDailyRecap,
  format: DailyRecapFormat,
  afterFinished: boolean,
): DailyRecapPart[] | null {
  const project = recap.activity?.projects[0];
  const ms = agentMs(recap);
  const parts: DailyRecapPart[] = [];
  if (project !== undefined) {
    const { completedTurns, failedTurns, interruptedTurns } = recap.counts;
    // On a busy day the top project may hold only a few of the turns. "It" is the
    // finished sentence's work; without one (every turn was stopped), the sentence
    // names the day, since yesterday's may come just before it.
    const most =
      afterFinished && project.turns * 2 > completedTurns + failedTurns + interruptedTurns;
    parts.push(
      text(
        most
          ? "Most of it went into "
          : afterFinished
            ? "Your busiest project was "
            : "Your busiest project today was ",
      ),
      strong(project.projectTitle),
      text("."),
    );
  }
  if (ms !== null) {
    parts.push(
      text(parts.length > 0 ? " Agents ran for " : "Agents ran for "),
      strong(format.duration(ms)),
      text("."),
    );
  }
  return parts.length > 0 ? parts : null;
}

function usageParts(usage: DailyRecapUsageDay, format: DailyRecapFormat): DailyRecapPart[] | null {
  if (usage.tokens === 0) return null;
  const { topModel } = usage;
  return [
    text("Providers recorded "),
    strong(`${format.compact(usage.tokens)} tokens`),
    ...(topModel === null
      ? []
      : [text(`, ${modelLead(topModel).toLowerCase()} `), strong(format.model(topModel.model))]),
    text("."),
  ];
}

function taskParts(
  tasks: NonNullable<DailyRecapDigestInput["tasks"]>,
  format: DailyRecapFormat,
): DailyRecapPart[] | null {
  const { dueToday, overdue } = tasks;
  if (dueToday === 0) {
    return overdue === 0
      ? null
      : [
          strong(count(format, overdue, "task", "tasks"), "bad"),
          text(overdue === 1 ? " is overdue." : " are overdue."),
        ];
  }
  const parts = [
    strong(count(format, dueToday, "task", "tasks")),
    text(dueToday === 1 ? " is due today" : " are due today"),
  ];
  if (overdue > 0) parts.push(text(", "), strong(`${format.integer(overdue)} overdue`, "bad"));
  parts.push(text("."));
  return parts;
}

/**
 * Today in a few sentences, each only when its data exists: what finished,
 * where the work went, what providers recorded, how many chats wait on the
 * user and which tasks are due. On a day with no turn finished or failed yet,
 * yesterday's turns take the place of the first, even when turns were stopped
 * or providers recorded tokens. Empty when there is nothing to tell.
 */
export function buildDailyRecapDigest(
  input: DailyRecapDigestInput,
  format: DailyRecapFormat,
): DailyRecapSentence[] {
  const sentences: DailyRecapSentence[] = [];
  const push = (id: DailyRecapSentence["id"], parts: readonly DailyRecapPart[] | null) => {
    if (parts !== null) sentences.push({ id, parts });
  };
  const finished = finishedParts(input.today, format);
  const yesterdayTurns = input.yesterday?.counts.completedTurns ?? 0;
  if (finished !== null) {
    push("finished", finished);
  } else if (yesterdayTurns > 0) {
    push("yesterday", [
      text("Nothing finished yet today. Yesterday you finished "),
      strong(count(format, yesterdayTurns, "turn", "turns")),
      text("."),
    ]);
  }
  push("work", workParts(input.today, format, finished !== null));
  push("usage", input.usage === null ? null : usageParts(input.usage.today, format));
  if (input.waitingThreads > 0) {
    push("waiting", [
      strong(count(format, input.waitingThreads, "chat", "chats")),
      text(input.waitingThreads === 1 ? " is waiting on you." : " are waiting on you."),
    ]);
  }
  push("tasks", input.tasks === null ? null : taskParts(input.tasks, format));
  return sentences;
}

/** A tile's detail line from its present pieces. */
function detailLine(...pieces: (string | null)[]): DailyRecapPart[] {
  const present = pieces.filter((piece) => piece !== null);
  return present.length > 0 ? [text(present.join(" · "))] : [];
}

/** The tiles under the digest, in reading order, each only when its data exists. */
export function buildDailyRecapTiles(
  input: DailyRecapDigestInput,
  format: DailyRecapFormat,
): DailyRecapTile[] {
  const { today, yesterday, usage, tasks } = input;
  const tiles: DailyRecapTile[] = [];

  const { completedTurns, failedTurns } = today.counts;
  if (completedTurns > 0 || failedTurns > 0) {
    const detail = detailLine(
      completedTurns > 0
        ? `In ${count(format, today.completed.totalThreads, "chat", "chats")}`
        : null,
    );
    if (failedTurns > 0) {
      if (detail.length > 0) detail.push(text(" · "));
      detail.push(strong(`${format.integer(failedTurns)} failed`, "bad"));
    }
    tiles.push({
      id: "finished",
      label: "Finished",
      value: count(format, completedTurns, "turn", "turns"),
      detail,
    });
  }

  const ms = agentMs(today);
  if (ms !== null) {
    tiles.push({
      id: "agent-time",
      label: "Agent time",
      value: format.duration(ms),
      detail: detailLine("Summed across chats"),
    });
  }

  const [topProject, nextProject] = today.activity?.projects ?? [];
  if (topProject !== undefined) {
    tiles.push({
      id: "top-project",
      label: "Top project",
      value: topProject.projectTitle,
      detail: detailLine(
        nextProject === undefined
          ? count(format, topProject.turns, "turn", "turns")
          : `Then ${nextProject.projectTitle}`,
      ),
    });
  }

  if (usage !== null && usage.today.tokens > 0) {
    const { topModel, costUsd, costPartial } = usage.today;
    const model =
      topModel === null ? null : `${modelLead(topModel)} ${format.model(topModel.model)}`;
    // Part of the day has no price: its cost is a floor, not the day's spend.
    const cost =
      costUsd === null
        ? null
        : costPartial
          ? `${model === null ? "At least" : "at least"} ${format.cost(costUsd)}`
          : format.cost(costUsd);
    tiles.push({
      id: "provider-tokens",
      label: "Provider tokens",
      value: format.compact(usage.today.tokens),
      detail: detailLine(model, cost),
    });
  }

  const yesterdayTokens = usage?.yesterday.tokens ?? 0;
  if (yesterday !== null && (yesterday.counts.completedTurns > 0 || yesterdayTokens > 0)) {
    const yesterdayMs = agentMs(yesterday);
    tiles.push({
      id: "yesterday",
      label: "Yesterday",
      value: count(format, yesterday.counts.completedTurns, "turn", "turns"),
      detail: detailLine(
        yesterdayTokens > 0 ? `${format.compact(yesterdayTokens)} tokens` : null,
        yesterdayMs === null ? null : format.duration(yesterdayMs),
      ),
    });
  }

  if (tasks !== null && tasks.dueToday + tasks.overdue > 0) {
    const overdue = `${format.integer(tasks.overdue)} overdue`;
    tiles.push(
      tasks.dueToday > 0
        ? {
            id: "tasks",
            label: "Tasks",
            value: `${format.integer(tasks.dueToday)} due`,
            detail: tasks.overdue > 0 ? [strong(overdue, "bad")] : [],
          }
        : { id: "tasks", label: "Tasks", value: overdue, detail: [] },
    );
  }
  return tiles;
}
