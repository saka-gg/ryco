// @effect-diagnostics globalDate:off
import type { EnvironmentId } from "@ryco/contracts";
import {
  DAILY_RECAP_TOP_PROJECTS,
  type DailyRecapSnapshot,
  type DailyRecapThread,
} from "@ryco/contracts/daily-recap";
import type { UsageCalendarDate } from "@ryco/contracts/usage";

import type { DailyRecapNodeResult, ReadyDailyRecap } from "./cache.ts";

/** A chat of the merged recap, with the node it ran on. */
export interface MergedDailyRecapThread extends DailyRecapThread {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

export interface MergedDailyRecapSection {
  /** Chats across the ready nodes, listed or not. */
  readonly totalThreads: number;
  /** Most recent activity first. */
  readonly threads: readonly MergedDailyRecapThread[];
  /** Some node counted more chats than it listed. */
  readonly truncated: boolean;
}

type DailyRecapProject = NonNullable<DailyRecapSnapshot["activity"]>["projects"][number];

/** A busy project of the merged recap. The same repository on two nodes is two projects. */
export interface MergedDailyRecapProject extends DailyRecapProject {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

export interface MergedDailyRecap {
  readonly date: UsageCalendarDate;
  readonly timeZone: string;
  readonly counts: DailyRecapSnapshot["counts"];
  readonly completed: MergedDailyRecapSection;
  readonly failed: MergedDailyRecapSection;
  /** Agent time and the busiest projects of the nodes that report them; null when none does. */
  readonly activity: {
    readonly agentMs: number;
    readonly projects: readonly MergedDailyRecapProject[];
  } | null;
  /** Ready nodes that predate `activity`: their turns count, their agent time and projects do not. */
  readonly activityMissing: readonly EnvironmentId[];
  /** The oldest request behind it, in client time: every part is at least this recent. */
  readonly updatedAtMs: number;
}

function compareThreads(left: MergedDailyRecapThread, right: MergedDailyRecapThread): number {
  return (
    Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) ||
    left.environmentId.localeCompare(right.environmentId) ||
    left.threadId.localeCompare(right.threadId)
  );
}

function compareProjects(left: MergedDailyRecapProject, right: MergedDailyRecapProject): number {
  return (
    right.turns - left.turns ||
    right.agentMs - left.agentMs ||
    left.projectTitle.localeCompare(right.projectTitle) ||
    left.environmentId.localeCompare(right.environmentId) ||
    left.projectId.localeCompare(right.projectId)
  );
}

function mergeSection(
  recaps: readonly ReadyDailyRecap[],
  section: "completed" | "failed",
): MergedDailyRecapSection {
  let totalThreads = 0;
  let truncated = false;
  const threads: MergedDailyRecapThread[] = [];
  for (const { environmentId, label, snapshot } of recaps) {
    const nodeSection = snapshot[section];
    totalThreads += nodeSection.totalThreads;
    truncated ||= nodeSection.truncated;
    for (const thread of nodeSection.threads) {
      threads.push({ ...thread, environmentId, environmentLabel: label });
    }
  }
  return { totalThreads, threads: threads.toSorted(compareThreads), truncated };
}

/**
 * One recap across the nodes that answered, or null when none did. Every node
 * was asked for the same local day, so their counts add up. A node's busiest
 * projects are its top few, so the merged top few are among them.
 */
export function mergeDailyRecaps(
  results: readonly DailyRecapNodeResult[],
): MergedDailyRecap | null {
  const recaps = results.filter((result): result is ReadyDailyRecap => result.status === "ready");
  const first = recaps[0];
  if (first === undefined) return null;
  const counts = { completedTurns: 0, failedTurns: 0, interruptedTurns: 0 };
  let agentMs = 0;
  let reported = false;
  const projects: MergedDailyRecapProject[] = [];
  const activityMissing: EnvironmentId[] = [];
  for (const { environmentId, label, snapshot } of recaps) {
    counts.completedTurns += snapshot.counts.completedTurns;
    counts.failedTurns += snapshot.counts.failedTurns;
    counts.interruptedTurns += snapshot.counts.interruptedTurns;
    if (snapshot.activity === undefined) {
      activityMissing.push(environmentId);
      continue;
    }
    reported = true;
    agentMs += snapshot.activity.agentMs;
    for (const project of snapshot.activity.projects) {
      projects.push({ ...project, environmentId, environmentLabel: label });
    }
  }
  return {
    date: first.snapshot.date,
    timeZone: first.snapshot.timeZone,
    counts,
    completed: mergeSection(recaps, "completed"),
    failed: mergeSection(recaps, "failed"),
    activity: reported
      ? {
          agentMs,
          projects: projects.toSorted(compareProjects).slice(0, DAILY_RECAP_TOP_PROJECTS),
        }
      : null,
    activityMissing,
    updatedAtMs: Math.min(...recaps.map((recap) => recap.requestedAtMs)),
  };
}
