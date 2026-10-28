/**
 * fileHolders - which other processes have a file open.
 *
 * `ryco doctor` swaps a compacted copy in by renaming it over `state.sqlite`. A process that
 * opened the old file before the rename keeps a descriptor to the old inode, but SQLite opens
 * `-wal` and `-shm` by name, and after the rename those belong to the new file: two databases
 * sharing one write-ahead log corrupt each other. SQLite's own lock does not prevent this (it
 * blocks reads, not `open()`), and an idle process that opened the file but never read it holds
 * no lock at all. So before the rename the doctor asks the operating system: `lsof` on macOS,
 * `/proc/<pid>/fd` on Linux.
 *
 * The answer must name this process (the doctor has the database open while it asks), otherwise
 * it cannot be trusted (a missing or broken `lsof`, a `/proc` hidden from us). That, any other
 * platform, and any error count as "unavailable": the doctor then does not swap. Only processes
 * of this user are visible, as with `lsof` without root.
 *
 * @module fileHolders
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";

import { runProcess } from "../processRunner.ts";

export interface FileHolder {
  readonly pid: number;
  /** The process name, when the system reports one. */
  readonly command: string | null;
}

export type FileHoldersResult =
  | { readonly kind: "checked"; readonly others: ReadonlyArray<FileHolder> }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface FindFileHoldersInput {
  /** Files to check; missing ones are skipped. At least one must be open in this process. */
  readonly paths: ReadonlyArray<string>;
  readonly selfPid?: number;
  readonly platform?: NodeJS.Platform;
}

const LSOF_CANDIDATES = ["/usr/sbin/lsof", "/usr/bin/lsof"];

/**
 * Whether {@link findFileHolders} can answer on `platform` at all. Elsewhere `ryco doctor` never
 * swaps a copy in, so it cannot shrink the file there (and is not suggested).
 */
export const canCheckFileHolders = (platform: NodeJS.Platform): boolean =>
  platform === "darwin" || platform === "linux";

/** `lsof -F pc` output: `p<pid>` starts a process, `c<command>` names it, other lines are files. */
export function parseLsofFields(output: string): ReadonlyArray<FileHolder> {
  const holders = new Map<number, string | null>();
  let current: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      current = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
      if (current !== null && !holders.has(current)) holders.set(current, null);
    } else if (line.startsWith("c") && current !== null) {
      holders.set(current, line.slice(1) || null);
    }
  }
  return [...holders].map(([pid, command]) => ({ pid, command }));
}

async function holdersFromLsof(paths: ReadonlyArray<string>): Promise<ReadonlyArray<FileHolder>> {
  const lsof = LSOF_CANDIDATES.find((candidate) => existsSync(candidate)) ?? "lsof";
  // `lsof` exits 1 whenever one of the files is open nowhere; only its output counts.
  const result = await runProcess(lsof, ["-w", "-n", "-P", "-F", "pc", "--", ...paths], {
    timeoutMs: 30_000,
    allowNonZeroExit: true,
    outputMode: "truncate",
    shell: false,
  });
  if (result.timedOut) throw new Error("lsof timed out");
  return parseLsofFields(result.stdout);
}

async function holdersFromProc(paths: ReadonlyArray<string>): Promise<ReadonlyArray<FileHolder>> {
  const targets = new Set<string>();
  for (const path of paths) {
    const info = await stat(path, { bigint: true });
    targets.add(`${info.dev}:${info.ino}`);
  }
  const holders: Array<FileHolder> = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    let descriptors: ReadonlyArray<string>;
    try {
      descriptors = await readdir(`/proc/${entry}/fd`);
    } catch {
      // Another user's process, or one that just exited.
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        // `stat` follows the descriptor's link to the open file itself.
        const info = await stat(`/proc/${entry}/fd/${descriptor}`, { bigint: true });
        if (!targets.has(`${info.dev}:${info.ino}`)) continue;
      } catch {
        continue;
      }
      const command = await readFile(`/proc/${entry}/comm`, "utf8").then(
        (text) => text.trim() || null,
        () => null,
      );
      holders.push({ pid: Number(entry), command });
      break;
    }
  }
  return holders;
}

/** The other processes of this user that have one of `paths` open, if that can be known. */
export async function findFileHolders(input: FindFileHoldersInput): Promise<FileHoldersResult> {
  const selfPid = input.selfPid ?? process.pid;
  const platform = input.platform ?? process.platform;
  const paths = input.paths.filter((path) => existsSync(path));
  if (paths.length === 0) return { kind: "unavailable", reason: "none of the files exist" };
  if (!canCheckFileHolders(platform)) {
    return { kind: "unavailable", reason: `not supported on ${platform}` };
  }
  let holders: ReadonlyArray<FileHolder>;
  try {
    holders = platform === "darwin" ? await holdersFromLsof(paths) : await holdersFromProc(paths);
  } catch (cause) {
    return {
      kind: "unavailable",
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
  if (!holders.some((holder) => holder.pid === selfPid)) {
    return {
      kind: "unavailable",
      reason:
        platform === "darwin"
          ? "lsof did not list this process, so its answer cannot be trusted"
          : "/proc did not list this process, so its answer cannot be trusted",
    };
  }
  return { kind: "checked", others: holders.filter((holder) => holder.pid !== selfPid) };
}

/** "pid 4242 (node), pid 77 (DB Browser for SQLite)" */
export const describeFileHolders = (holders: ReadonlyArray<FileHolder>): string =>
  holders
    .map((holder) => `pid ${holder.pid}${holder.command ? ` (${holder.command})` : ""}`)
    .join(", ");
