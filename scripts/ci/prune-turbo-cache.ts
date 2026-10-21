import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// CI restores `.turbo/cache` from the previous commit's blob and saves it again
// under a new key, and Turbo never evicts local entries, so without pruning the
// blob only grows (2+ GB of mostly dead entries). Entries are content-addressed
// by task hash, so dropping one can only cost a cache miss, never a stale hit.

// `<hash>.tar.zst` holds a task's outputs and log; `-meta.json` and
// `-manifest.json` are its sidecars (Turbo also reads an uncompressed `.tar`).
const ENTRY_FILE = /^([0-9a-f]+)(?:(\.tar\.zst|\.tar)|-meta\.json|-manifest\.json)$/u;

export const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

interface RunSummary {
  readonly execution?: { readonly attempted?: unknown; readonly exitCode?: unknown };
  readonly tasks?: unknown;
}

interface RunSummaries {
  readonly hashes: ReadonlySet<string>;
  // False when a summary does not name every entry its job still needs: a
  // failed run stops scheduling, so tasks that never started are missing even
  // though their restored entries are still live, and a run that selected no
  // task (`--affected` on a docs-only change) names nothing at all.
  readonly complete: boolean;
}

function readRunSummary(path: string): RunSummary {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function taskHashes(summary: RunSummary): readonly string[] | undefined {
  if (!Array.isArray(summary.tasks)) return undefined;
  const hashes = summary.tasks.map((task: unknown) => (task as { hash?: unknown } | null)?.hash);
  return hashes.every((hash): hash is string => typeof hash === "string") ? hashes : undefined;
}

function readRunSummaries(runsDir: string): RunSummaries {
  const files = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".json")) : [];
  const hashes = new Set<string>();
  let complete = true;
  for (const file of files) {
    const summary = readRunSummary(join(runsDir, file));
    const listed = taskHashes(summary);
    if (!listed) {
      // Surface a Turbo format change instead of silently degrading to the
      // age fallback on every run.
      console.log(`::warning::Unrecognized Turbo run summary ${file}; pruning by age as well.`);
      complete = false;
      continue;
    }
    if (listed.length === 0) {
      console.log(`Turbo run ${file} selected no tasks; pruning by age as well.`);
      complete = false;
      continue;
    }
    for (const hash of listed) hashes.add(hash);
    const { attempted, exitCode } = summary.execution ?? {};
    if (exitCode !== 0 || typeof attempted !== "number" || listed.length < attempted) {
      console.log(`Turbo run ${file} did not finish every task; pruning by age as well.`);
      complete = false;
    }
  }
  return { hashes, complete };
}

interface CacheEntry {
  readonly files: string[];
  bytes: number;
  newestMtimeMs: number;
}

function readCacheEntries(cacheDir: string): Map<string, CacheEntry> {
  const entries = new Map<string, CacheEntry>();
  if (!existsSync(cacheDir)) return entries;
  for (const name of readdirSync(cacheDir)) {
    // Anything that is not a Turbo entry file is left untouched.
    const match = ENTRY_FILE.exec(name);
    const stats = match ? statSync(join(cacheDir, name)) : undefined;
    if (!match || !stats?.isFile()) continue;
    const hash = match[1]!;
    const entry = entries.get(hash) ?? { files: [], bytes: 0, newestMtimeMs: 0 };
    // Archives first: an interrupted prune then leaves only orphaned sidecars,
    // which Turbo treats as a miss, never an archive without its metadata.
    if (match[2]) entry.files.unshift(name);
    else entry.files.push(name);
    entry.bytes += stats.size;
    entry.newestMtimeMs = Math.max(entry.newestMtimeMs, stats.mtimeMs);
    entries.set(hash, entry);
  }
  return entries;
}

export interface PruneOptions {
  readonly cacheDir: string;
  readonly runsDir: string;
  readonly maxAgeMs?: number;
  readonly now?: number;
}

export interface PruneResult {
  // "summaries": exactly the summarized task hashes survive. "age": no summary
  // names a task (e.g. the job failed before Turbo ran), so entries used within
  // maxAgeMs of the cache's last use survive. "summaries+age": a summary is
  // incomplete, so both.
  readonly mode: "summaries" | "age" | "summaries+age";
  readonly keptEntries: number;
  readonly keptBytes: number;
  readonly removedEntries: number;
  readonly removedBytes: number;
}

export function pruneTurboCache(options: PruneOptions): PruneResult {
  const now = options.now ?? Date.now();
  const summaries = readRunSummaries(options.runsDir);
  const mode =
    summaries.hashes.size === 0 ? "age" : summaries.complete ? "summaries" : "summaries+age";
  const entries = readCacheEntries(options.cacheDir);
  // Turbo does not touch an entry it replays and actions/cache keeps mtimes,
  // so pruning stamps every entry a run used: an entry's mtime is then when
  // this cache's lineage last used it. The age window ends at the newest entry
  // this job did not use (the lineage's previous run), not at the wall clock,
  // so a scope that runs less often than maxAgeMs still keeps what its last
  // run used when this job gives incomplete evidence.
  let lastUseMs = 0;
  for (const [hash, entry] of entries) {
    if (!summaries.hashes.has(hash)) lastUseMs = Math.max(lastUseMs, entry.newestMtimeMs);
  }
  const cutoff = Math.min(lastUseMs, now) - (options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  const stamp = new Date(now);
  let keptEntries = 0;
  let keptBytes = 0;
  let removedEntries = 0;
  let removedBytes = 0;
  for (const [hash, entry] of entries) {
    const used = summaries.hashes.has(hash);
    if (used || (mode !== "summaries" && entry.newestMtimeMs >= cutoff)) {
      // Only used entries are stamped; refreshing the ones kept by age would
      // let a run of failed jobs keep dead entries forever.
      if (used) {
        for (const name of entry.files) utimesSync(join(options.cacheDir, name), stamp, stamp);
      }
      keptEntries += 1;
      keptBytes += entry.bytes;
      continue;
    }
    for (const name of entry.files) rmSync(join(options.cacheDir, name), { force: true });
    removedEntries += 1;
    removedBytes += entry.bytes;
  }
  return { mode, keptEntries, keptBytes, removedEntries, removedBytes };
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function main(): void {
  // Paths match the `.turbo/cache` that setup-ryco restores and
  // save-turbo-cache saves; `.turbo/runs` is never cached, so every summary
  // here was written by this job.
  const result = pruneTurboCache({
    cacheDir: resolve(".turbo/cache"),
    runsDir: resolve(".turbo/runs"),
  });
  console.log(
    `Pruned Turbo cache by ${result.mode}: kept ${result.keptEntries} entries ` +
      `(${megabytes(result.keptBytes)} MB), removed ${result.removedEntries} ` +
      `(${megabytes(result.removedBytes)} MB).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
