/**
 * Statistics for the whole machine: the Claude Code and Codex session files on this node, folded
 * into Statistics buckets beside Ryco's own turn records without counting anything twice.
 *
 * The usage pipeline reads every transcript into per-file aggregates (`usageFileAggregate.ts`,
 * cached per file). This module turns those aggregates into `StatisticsDailyBucket`s:
 *
 * 1. De-duplication within the files. Claude Code repeats a response's usage on every content
 *    block and copies earlier responses into resumed and forked sessions; each keyed response
 *    (message and request id) counts once across every file. Codex fork copies are already
 *    dropped by the parser.
 * 2. De-duplication against Ryco. Ryco runs Claude through the Agent SDK and Codex through
 *    `codex app-server`, and both write their sessions to the same directories. A session Ryco
 *    ran is identified by the provider session id Ryco stored for its thread, and for Codex also
 *    by the client Ryco names itself (`originator`). Its main-session usage is already in Ryco's
 *    turn records, so it is left out here. Its subagents' usage (Claude sidechains, threads a
 *    Codex thread spawned) is not in those records, so it is counted here, attributed to Ryco
 *    (`source: "ryco-subagent"`). Everything else is `source: "outside"`.
 *
 *    Ryco-run responses claim their keys first, so a copy of one in a session started outside
 *    Ryco (a terminal `--resume --fork-session` of a Ryco session) is not counted again.
 *
 * Sessions are placed in the Ryco project whose workspace or worktree holds their directory, or
 * else grouped by their folder's name. Only token counts, model names, times, anonymized session
 * ids and directory names are used; nothing here sees message content.
 *
 * @module machineStatistics
 */
import * as NodePath from "node:path";

import {
  ProjectId,
  type StatisticsDailyBucket,
  type StatisticsMachineUsage,
  type StatisticsModelRef,
  type StatisticsProjectRef,
  type StatisticsSnapshot,
  type StatisticsUsageSource,
} from "@ryco/contracts";

import {
  addKeyedValues,
  emptySlotTotals,
  USAGE_KEY_VALUE_STRIDE,
  type UsageFileAggregate,
  type UsageSlot,
} from "./usageFileAggregate.ts";
import type { UsageSlotTotals } from "./usagePricing.ts";
import type { MachineProjectRoot } from "./UsageServiceTag.ts";

/** The transcript providers Statistics read, by the driver name Ryco's buckets use. */
export const MACHINE_STATISTICS_PROVIDERS = {
  claude: "claudeAgent",
  codex: "codex",
} as const;
export type MachineStatisticsProvider = keyof typeof MACHINE_STATISTICS_PROVIDERS;

/** The sessions Ryco ran, as anonymized scan-cache ids (`anonymizeScanCachedSessionId`). */
export interface RycoSessionIndex {
  readonly claude: ReadonlySet<string>;
  readonly codex: ReadonlySet<string>;
}

export interface MachineStatisticsFile {
  readonly provider: MachineStatisticsProvider;
  readonly aggregate: UsageFileAggregate;
}

/** Whose usage a slot is: Ryco's own records already hold `ryco`. */
export type MachineSlotAttribution = "ryco" | StatisticsUsageSource;

export function attributeMachineSlot(
  provider: MachineStatisticsProvider,
  slot: Pick<UsageSlot, "sessionId" | "ownerSessionId" | "sidechain" | "rycoClient">,
  ryco: RycoSessionIndex,
): MachineSlotAttribution {
  const owner = slot.ownerSessionId.length > 0 ? slot.ownerSessionId : slot.sessionId;
  const known = owner.length > 0 && ryco[provider].has(owner);
  if (!known && !slot.rycoClient) return "outside";
  // A Ryco-run session's main work is in Ryco's turn records; its subagents' work is not.
  // A Codex session Ryco started whose thread Ryco no longer knows is a deleted thread, whose
  // usage Ryco's records keep (statistics usage rollups).
  return slot.sidechain ? "ryco-subagent" : "ryco";
}

const FOLDER_PROJECT_PREFIX = "folder:";
const UNKNOWN_FOLDER_TITLE = "Unknown folder";
const CLAUDE_WORKTREE_MARKER = `${NodePath.sep}.claude${NodePath.sep}worktrees${NodePath.sep}`;

function trimTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === NodePath.sep) end -= 1;
  return path.slice(0, end);
}

/** The Statistics project id a folder outside every Ryco project is grouped under. */
export function machineFolderProjectId(title: string): string {
  return `${FOLDER_PROJECT_PREFIX}${title}`;
}

/**
 * The folder name a directory outside every Ryco project is grouped by. A Claude Code worktree
 * (`<repo>/.claude/worktrees/<name>`) counts as its repository.
 */
export function machineFolderTitle(cwd: string): string {
  const trimmed = trimTrailingSeparators(cwd);
  const marker = trimmed.indexOf(CLAUDE_WORKTREE_MARKER);
  const directory = marker > 0 ? trimmed.slice(0, marker) : trimmed;
  const name = NodePath.basename(directory);
  return name.length > 0 && name !== NodePath.sep ? name : UNKNOWN_FOLDER_TITLE;
}

/**
 * Maps a session directory to the Ryco project whose root holds it (the longest matching root),
 * else to a folder group. The home directory and the filesystem root only match exactly: a
 * project there must not claim every session on the machine.
 */
export function makeMachineProjectResolver(
  roots: readonly MachineProjectRoot[],
  homeDirectory: string,
): (cwd: string) => { readonly projectId: string; readonly folderTitle?: string } {
  const home = trimTrailingSeparators(homeDirectory);
  const normalized = roots
    .map((root) => ({ ...root, path: trimTrailingSeparators(root.path) }))
    .filter((root) => root.path.length > 0)
    .toSorted(
      (left, right) =>
        right.path.length - left.path.length ||
        Number(left.deleted === true) - Number(right.deleted === true),
    );
  const memo = new Map<string, { readonly projectId: string; readonly folderTitle?: string }>();
  return (cwd) => {
    const cached = memo.get(cwd);
    if (cached !== undefined) return cached;
    const directory = trimTrailingSeparators(cwd);
    let resolved: { readonly projectId: string; readonly folderTitle?: string } | undefined;
    if (directory.length > 0) {
      for (const root of normalized) {
        const exactOnly = root.path === home || root.path === NodePath.sep;
        if (
          directory === root.path ||
          (!exactOnly && directory.startsWith(`${root.path}${NodePath.sep}`))
        ) {
          resolved = { projectId: root.projectId };
          break;
        }
      }
    }
    if (resolved === undefined) {
      const folderTitle =
        directory.length === 0 ? UNKNOWN_FOLDER_TITLE : machineFolderTitle(directory);
      resolved = { projectId: machineFolderProjectId(folderTitle), folderTitle };
    }
    memo.set(cwd, resolved);
    return resolved;
  };
}

export interface MachineStatisticsAggregation {
  /** Unpriced buckets of session-file usage (`source` set on every one). */
  readonly buckets: readonly StatisticsDailyBucket[];
  /** Folder groups the buckets use, beside Ryco's projects. */
  readonly folders: readonly StatisticsProjectRef[];
  readonly duplicateResponseCount: number;
  readonly rycoResponseCount: number;
  readonly outsideSessionCount: number;
}

type MutableBucket = { -readonly [K in keyof StatisticsDailyBucket]: StatisticsDailyBucket[K] };

/**
 * Folds per-file aggregates into Statistics buckets (UTC days, like Ryco's own buckets), in
 * two passes so Ryco-run responses claim their keys before outside sessions are counted.
 */
export function aggregateMachineStatistics(input: {
  readonly files: readonly MachineStatisticsFile[];
  readonly ryco: RycoSessionIndex;
  readonly resolveProject: (cwd: string) => {
    readonly projectId: string;
    readonly folderTitle?: string;
  };
}): MachineStatisticsAggregation {
  const { files, ryco, resolveProject } = input;
  const buckets = new Map<string, MutableBucket>();
  const folders = new Map<string, StatisticsProjectRef>();
  const outsideSessions = new Set<string>();
  const seenKeys = new Set<string>();
  const dayBySlot = new Map<number, string>();
  let duplicateResponseCount = 0;
  let rycoResponseCount = 0;

  const add = (
    provider: MachineStatisticsProvider,
    slot: UsageSlot,
    source: StatisticsUsageSource,
    totals: UsageSlotTotals,
  ) => {
    if (totals.count === 0) return;
    let date = dayBySlot.get(slot.slotMs);
    if (date === undefined) {
      date = new Date(slot.slotMs).toISOString().slice(0, 10);
      dayBySlot.set(slot.slotMs, date);
    }
    const project = resolveProject(slot.cwd);
    if (project.folderTitle !== undefined && !folders.has(project.projectId)) {
      folders.set(project.projectId, {
        id: ProjectId.make(project.projectId),
        title: project.folderTitle,
        kind: "folder",
      });
    }
    const driver = MACHINE_STATISTICS_PROVIDERS[provider];
    const speed = slot.speed === "fast" || slot.speed === "ultrafast" ? slot.speed : undefined;
    const key = `${date}\u0000${project.projectId}\u0000${driver}\u0000${slot.model}\u0000${speed ?? ""}\u0000${source}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        date,
        projectId: ProjectId.make(project.projectId),
        model: slot.model,
        provider: driver,
        ...(speed === undefined ? {} : { speed }),
        source,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        turns: 0,
        activeMs: 0,
        toolUses: 0,
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        commits: 0,
        pushes: 0,
        threadsCreated: 0,
      };
      buckets.set(key, bucket);
    }
    // Statistics count cache reads and writes inside input tokens.
    bucket.inputTokens +=
      totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationInputTokens;
    bucket.cachedInputTokens += totals.cachedInputTokens;
    bucket.cacheWriteInputTokens =
      (bucket.cacheWriteInputTokens ?? 0) + totals.cacheCreationInputTokens;
    bucket.outputTokens += totals.outputTokens;
    bucket.reasoningTokens += totals.reasoningTokens;
    bucket.totalTokens += totals.totalTokens;
    if (source === "outside" && slot.sessionId.length > 0)
      outsideSessions.add(`${provider}\u0000${slot.sessionId}`);
  };

  const attributions = files.map((file) =>
    file.aggregate.slots.map((slot) => attributeMachineSlot(file.provider, slot, ryco)),
  );

  // Keyed responses, split by owner: Ryco's claim their keys first.
  const addKeyed = (pass: "ryco" | "outside") => {
    for (const [fileIndex, file] of files.entries()) {
      const { aggregate } = file;
      const classes = attributions[fileIndex]!;
      let perSlot: Map<number, ReturnType<typeof emptySlotTotals>> | undefined;
      for (let index = 0; index < aggregate.keys.length; index++) {
        const slotIndex = aggregate.keySlots[index]!;
        const attribution = classes[slotIndex]!;
        if ((attribution === "outside") !== (pass === "outside")) continue;
        const key = aggregate.keys[index]!;
        if (seenKeys.has(key)) {
          duplicateResponseCount += 1;
          continue;
        }
        seenKeys.add(key);
        if (attribution === "ryco") {
          rycoResponseCount += 1;
          continue;
        }
        perSlot ??= new Map();
        let totals = perSlot.get(slotIndex);
        if (totals === undefined) {
          totals = emptySlotTotals();
          perSlot.set(slotIndex, totals);
        }
        addKeyedValues(totals, aggregate.keyValues, index * USAGE_KEY_VALUE_STRIDE);
      }
      if (perSlot === undefined) continue;
      for (const [slotIndex, totals] of perSlot) {
        const attribution = classes[slotIndex]!;
        if (attribution !== "ryco")
          add(file.provider, aggregate.slots[slotIndex]!, attribution, totals);
      }
    }
  };
  addKeyed("ryco");
  addKeyed("outside");

  // Keyless responses (Codex) are folded into their slots already.
  for (const [fileIndex, file] of files.entries()) {
    const classes = attributions[fileIndex]!;
    for (const [slotIndex, slot] of file.aggregate.slots.entries()) {
      if (slot.count === 0) continue;
      const attribution = classes[slotIndex]!;
      if (attribution === "ryco") rycoResponseCount += slot.count;
      else add(file.provider, slot, attribution, slot);
    }
  }

  return {
    buckets: [...buckets.values()].toSorted(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.projectId.localeCompare(right.projectId) ||
        (left.provider ?? "").localeCompare(right.provider ?? "") ||
        left.model.localeCompare(right.model) ||
        (left.source ?? "").localeCompare(right.source ?? ""),
    ),
    folders: [...folders.values()].toSorted((left, right) => left.title.localeCompare(right.title)),
    duplicateResponseCount,
    rycoResponseCount,
    outsideSessionCount: outsideSessions.size,
  };
}

/**
 * Ryco's snapshot with the session-file buckets and folder groups added, as a `machine` snapshot.
 * Ryco's own buckets, projects and counters are unchanged; token totals include the additions.
 */
export function mergeMachineStatistics(
  snapshot: StatisticsSnapshot,
  aggregation: MachineStatisticsAggregation | null,
  machine: StatisticsMachineUsage,
): StatisticsSnapshot {
  if (aggregation === null || aggregation.buckets.length === 0)
    return { ...snapshot, scope: "machine", machine };
  const projectIds = new Set(snapshot.projects.map((project) => project.id));
  const modelKeys = new Set(
    snapshot.models.map((model) => `${model.provider ?? ""}\u0000${model.model}`),
  );
  const models: StatisticsModelRef[] = [...snapshot.models];
  const totals = { ...snapshot.totals };
  let earliest = aggregation.buckets[0]!.date;
  for (const bucket of aggregation.buckets) {
    const modelKey = `${bucket.provider ?? ""}\u0000${bucket.model}`;
    if (!modelKeys.has(modelKey)) {
      modelKeys.add(modelKey);
      models.push(
        bucket.provider === undefined
          ? { model: bucket.model }
          : { model: bucket.model, provider: bucket.provider },
      );
    }
    totals.inputTokens += bucket.inputTokens;
    totals.outputTokens += bucket.outputTokens;
    totals.cachedInputTokens += bucket.cachedInputTokens;
    totals.reasoningTokens += bucket.reasoningTokens;
    totals.totalTokens += bucket.totalTokens;
    if (bucket.date < earliest) earliest = bucket.date;
  }
  const earliestAt = `${earliest}T00:00:00.000Z`;
  return {
    ...snapshot,
    earliestActivityAt:
      snapshot.earliestActivityAt === undefined || earliestAt < snapshot.earliestActivityAt
        ? earliestAt
        : snapshot.earliestActivityAt,
    projects: [
      ...snapshot.projects,
      ...aggregation.folders.filter((folder) => !projectIds.has(folder.id)),
    ],
    models: models.toSorted(
      (left, right) =>
        (left.provider ?? "").localeCompare(right.provider ?? "") ||
        left.model.localeCompare(right.model),
    ),
    dailyBuckets: [...snapshot.dailyBuckets, ...aggregation.buckets],
    totals,
    scope: "machine",
    machine,
  };
}
