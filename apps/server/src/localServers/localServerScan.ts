/**
 * What the local server monitor reads from the operating system, and the rules it applies to it
 * (docs/thread-servers.md). Loaded with the first `threads.subscribeLocalServers` or
 * `threads.stopLocalServer`: nothing here is needed at boot.
 *
 * - Listeners: `lsof -nP -iTCP -sTCP:LISTEN -F pcn`, loopback and wildcard addresses only.
 * - The process table: `ps -A -o pid=,ppid=,pgid=,stat=,tty=,lstart=` in the C locale. A start
 *   time (whole seconds) makes a pid name one process.
 * - Thread markers: only `RYCO_THREAD_ID`, from a listener's launch environment. Linux reads
 *   `/proc/<pid>/environ`; macOS compares `ps -E` (argv followed by the environment) with plain
 *   `ps`, so a marker spelled out in the arguments never counts. The rest of the environment can
 *   hold credentials: it is read into a bounded buffer, never kept, logged or sent anywhere.
 *
 * @module localServerScan
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";

import { sanitizeUntrustedLine } from "@ryco/shared/untrustedText";

import { RYCO_THREAD_ID_ENV } from "./threadAttributionEnv.ts";

export const LSOF_TIMEOUT_MS = 5_000;
/** Partial output could hide another process sharing a port, so a larger one fails the scan. */
export const LSOF_MAX_BYTES = 1024 * 1024;
export const PS_TIMEOUT_MS = 5_000;
export const PS_MAX_BYTES = 8 * 1024 * 1024;
/** Per process: a marker past this much environment is not seen (and so not attributed). */
export const PROC_ENVIRON_MAX_BYTES = 1024 * 1024;
const PROC_ENVIRON_CONCURRENCY = 8;
/** A thread id longer than this is not one Ryco wrote. */
const THREAD_MARKER_MAX_CHARS = 256;
const PROCESS_NAME_MAX_CHARS = 128;

export interface LocalListener {
  readonly pid: number;
  /** The executable's short name as `lsof` reports it, never its arguments. */
  readonly processName: string | null;
  readonly host: string;
  readonly port: number;
}

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** `ps` state flags: `s` marks a session leader. */
  readonly stat: string;
  /** Whether the process has a controlling terminal. */
  readonly hasTty: boolean;
  readonly startTimeMs: number;
}

export type ProcessTable = ReadonlyMap<number, ProcessRow>;

const LOCAL_LISTEN_HOSTS = new Set(["*", "0.0.0.0", "localhost", "[::]", "[::1]", "::", "::1"]);

/** An address a process on this machine reaches over loopback: loopback or every interface. */
export function isLocalListenHost(host: string): boolean {
  return LOCAL_LISTEN_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

/**
 * `lsof -F pcn` output: `p<pid>` starts a process, `c<name>` names it, each `n<host>:<port>` is
 * one listening socket. One row per (pid, host, port); other addresses are dropped.
 */
export function parseLsofListeners(output: string): ReadonlyArray<LocalListener> {
  const rows = new Map<string, LocalListener>();
  let pid: number | null = null;
  let processName: string | null = null;
  for (const line of output.split("\n")) {
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number(value);
      pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      processName = null;
    } else if (tag === "c") {
      processName = sanitizeUntrustedLine(value, PROCESS_NAME_MAX_CHARS) || null;
    } else if (tag === "n" && pid !== null) {
      const name = value.split(" ", 1)[0] ?? "";
      const colon = name.lastIndexOf(":");
      if (colon <= 0) continue;
      const host = name.slice(0, colon);
      const port = Number(name.slice(colon + 1));
      if (!isLocalListenHost(host) || !Number.isInteger(port) || port <= 0 || port > 65_535) {
        continue;
      }
      rows.set(`${pid}\u0000${host}\u0000${port}`, { pid, processName, host, port });
    }
  }
  return [...rows.values()];
}

const PROCESS_ROW =
  /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)$/u;

/** `ps -A -o pid=,ppid=,pgid=,stat=,tty=,lstart=` output, in the C locale. */
export function parseProcessTable(output: string): ProcessTable {
  const rows = new Map<number, ProcessRow>();
  for (const line of output.split("\n")) {
    const match = PROCESS_ROW.exec(line.trim());
    if (!match) continue;
    const [, pidText, ppidText, pgidText, stat, tty, started] = match;
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const pgid = Number(pgidText);
    const startTimeMs = Date.parse(started ?? "");
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(pgid) ||
      !Number.isFinite(startTimeMs) ||
      startTimeMs <= 0
    ) {
      continue;
    }
    rows.set(pid, {
      pid,
      ppid,
      pgid,
      stat: stat ?? "",
      hasTty: tty !== undefined && tty !== "?" && tty !== "??" && tty !== "-",
      startTimeMs,
    });
  }
  return rows;
}

/** The marker's value when `values` agree on one, else null (none, or ambiguous). */
function singleMarker(values: ReadonlyArray<string>): string | null {
  const distinct = new Set(values);
  if (distinct.size !== 1) return null;
  const [value] = distinct;
  return value !== undefined && value.length > 0 && value.length <= THREAD_MARKER_MAX_CHARS
    ? value
    : null;
}

/** `/proc/<pid>/environ`: NUL-separated `KEY=value` entries. Reads only the marker. */
export function parseProcEnvironThreadId(raw: string): string | null {
  const prefix = `${RYCO_THREAD_ID_ENV}=`;
  return singleMarker(
    raw
      .split("\0")
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length)),
  );
}

/** `ps -o pid=,command=` output by pid; a pid listed twice (an argv with a newline) is dropped. */
function commandLinesByPid(output: string): ReadonlyMap<number, string> {
  const lines = new Map<number, string>();
  const repeated = new Set<number>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+) (.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (lines.has(pid)) repeated.add(pid);
    lines.set(pid, match[2] ?? "");
  }
  for (const pid of repeated) lines.delete(pid);
  return lines;
}

const MARKER_ASSIGNMENT = new RegExp(`(?:^|\\s)${RYCO_THREAD_ID_ENV}=(\\S+)`, "gu");

/**
 * macOS: each pid's marker from `ps -E -ww -o pid=,command=` (`withEnvironment`: the arguments,
 * then the launch environment, joined by spaces) and `ps -ww -o pid=,command=` (`commandOnly`).
 * Only the text after the plain command line is environment, so a marker spelled out in the
 * arguments never counts. A pid whose two lines disagree (it exited, or was reused, between the
 * reads) gets null. Only `pids` are answered.
 */
export function parsePsEnvironmentThreadIds(
  withEnvironment: string,
  commandOnly: string,
  pids: ReadonlyArray<number>,
): ReadonlyMap<number, string | null> {
  const environments = commandLinesByPid(withEnvironment);
  const commands = commandLinesByPid(commandOnly);
  const markers = new Map<number, string | null>();
  for (const pid of pids) {
    const full = environments.get(pid);
    const command = commands.get(pid);
    if (full === undefined || command === undefined || !full.startsWith(command)) {
      markers.set(pid, null);
      continue;
    }
    const environment = full.slice(command.length);
    markers.set(
      pid,
      singleMarker([...environment.matchAll(MARKER_ASSIGNMENT)].map((match) => match[1] ?? "")),
    );
  }
  return markers;
}

/**
 * The process group stopping `pid` signals, or null when it may not be signaled. Shells with job
 * control and agent tool shells give every job its own group, so the group is the job. Null when
 * the group also holds this server or one of its ancestors, a direct child of this server (agent
 * CLIs, the terminal shells, helpers), or a session leader with a terminal (a terminal or
 * persistent agent shell whose jobs share its group).
 */
export function stoppableProcessGroup(
  table: ProcessTable,
  pid: number,
  serverPid: number,
): number | null {
  const group = table.get(pid)?.pgid;
  if (group === undefined || group <= 1) return null;
  return isSharedProcessGroup(table, group, serverPid) ? null : group;
}

/** Whether signaling `group` would reach a process {@link stoppableProcessGroup} protects. */
export function isSharedProcessGroup(
  table: ProcessTable,
  group: number,
  serverPid: number,
): boolean {
  // Without the server's own row its ancestors are unknown: refuse rather than guess.
  if (!table.has(serverPid)) return true;
  const guarded = new Set([serverPid]);
  for (
    let parent = table.get(serverPid)?.ppid;
    parent !== undefined && parent > 1 && !guarded.has(parent);
    parent = table.get(parent)?.ppid
  ) {
    guarded.add(parent);
  }
  for (const row of table.values()) {
    if (row.pgid !== group) continue;
    if (guarded.has(row.pid) || row.ppid === serverPid) return true;
    if (row.hasTty && row.stat.includes("s")) return true;
  }
  return false;
}

/**
 * Where a listener runs from: under a thread terminal (a terminal shell is a direct child of this
 * server with a terminal of its own), under an agent process (a direct child without one), or
 * nowhere this server can see any more.
 */
export function listenerOrigin(
  table: ProcessTable,
  pid: number,
  serverPid: number,
): "agent" | "terminal" | "unknown" {
  const seen = new Set<number>();
  for (let row = table.get(pid); row !== undefined && !seen.has(row.pid);) {
    seen.add(row.pid);
    if (row.ppid === serverPid) return row.hasTty ? "terminal" : "agent";
    if (row.ppid <= 1) return "unknown";
    row = table.get(row.ppid);
  }
  return "unknown";
}

// ── Reading the operating system ───────────────────────────────────────────────

export interface CommandOutput {
  readonly code: number;
  readonly stdout: string;
}

/**
 * Runs a read-only system command in the C locale. Fails on a spawn error, a timeout or output
 * past `maxBytes`; any exit code is returned (`lsof` exits 1 when nothing listens, `ps -p` when one
 * of the pids is gone). The error never carries the output.
 */
export function runSystemCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly maxBytes: number },
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: options.maxBytes,
        windowsHide: true,
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ code: 0, stdout });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === "number" && !error.killed) {
          resolve({ code, stdout });
          return;
        }
        reject(
          Object.assign(new Error(`${command} failed or exceeded its limits`), {
            missing: code === "ENOENT",
          }),
        );
      },
    );
  });
}

const LSOF_CANDIDATES = ["/usr/sbin/lsof", "/usr/bin/lsof"];
const PS_CANDIDATES = ["/bin/ps", "/usr/bin/ps"];

const firstExisting = (candidates: ReadonlyArray<string>, fallback: string) =>
  candidates.find((candidate) => existsSync(candidate)) ?? fallback;

/**
 * Listening loopback and wildcard TCP sockets. Null when `lsof` failed this time (a timeout, its
 * output cap), so the caller keeps what it last knew; none on a machine without `lsof`.
 */
export async function readLocalListeners(): Promise<ReadonlyArray<LocalListener> | null> {
  try {
    const result = await runSystemCommand(
      firstExisting(LSOF_CANDIDATES, "lsof"),
      ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"],
      { timeoutMs: LSOF_TIMEOUT_MS, maxBytes: LSOF_MAX_BYTES },
    );
    if (result.code !== 0 && result.stdout.length === 0) return result.code === 1 ? [] : null;
    return parseLsofListeners(result.stdout);
  } catch (cause) {
    return (cause as { readonly missing?: boolean }).missing === true ? [] : null;
  }
}

/** Every process's pid, parent, group, flags and start time. Fails rather than reading partly. */
export async function readProcessTable(): Promise<ProcessTable> {
  const result = await runSystemCommand(
    firstExisting(PS_CANDIDATES, "ps"),
    ["-A", "-o", "pid=,ppid=,pgid=,stat=,tty=,lstart="],
    { timeoutMs: PS_TIMEOUT_MS, maxBytes: PS_MAX_BYTES },
  );
  if (result.code !== 0) throw new Error("ps failed");
  return parseProcessTable(result.stdout);
}

const READ_CHUNK_BYTES = 64 * 1024;

/** At most `maxBytes` of a file whose size `stat` does not report (`/proc` files). */
async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    return Buffer.concat(chunks, length).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Each pid's `RYCO_THREAD_ID`, or null for a process without one (or one that can never be read:
 * another user's, one that exited). A pid that could not be read this time (`ps` timed out, a
 * read failed for another reason) is left out, so the caller reads it again on its next scan.
 * Only darwin and linux can answer; elsewhere every pid gets null.
 */
export async function readThreadMarkers(
  pids: ReadonlyArray<number>,
  platform: NodeJS.Platform = process.platform,
): Promise<ReadonlyMap<number, string | null>> {
  if (pids.length === 0) return new Map();
  if (platform === "linux") {
    const markers = new Map<number, string | null>();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(PROC_ENVIRON_CONCURRENCY, pids.length) }, async () => {
        while (next < pids.length) {
          const pid = pids[next++]!;
          try {
            markers.set(
              pid,
              parseProcEnvironThreadId(
                await readBoundedFile(`/proc/${pid}/environ`, PROC_ENVIRON_MAX_BYTES),
              ),
            );
          } catch (cause) {
            // Gone, or another user's: no marker this process will ever show. Anything else
            // (out of file descriptors) is tried again.
            const code = (cause as NodeJS.ErrnoException | null)?.code;
            if (code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM") {
              markers.set(pid, null);
            }
          }
        }
      }),
    );
    return markers;
  }
  if (platform !== "darwin") return new Map(pids.map((pid) => [pid, null]));
  const ps = firstExisting(PS_CANDIDATES, "ps");
  const list = pids.join(",");
  try {
    const [withEnvironment, commandOnly] = await Promise.all([
      runSystemCommand(ps, ["-E", "-ww", "-o", "pid=,command=", "-p", list], {
        timeoutMs: PS_TIMEOUT_MS,
        maxBytes: PS_MAX_BYTES,
      }),
      runSystemCommand(ps, ["-ww", "-o", "pid=,command=", "-p", list], {
        timeoutMs: PS_TIMEOUT_MS,
        maxBytes: PS_MAX_BYTES,
      }),
    ]);
    return parsePsEnvironmentThreadIds(withEnvironment.stdout, commandOnly.stdout, pids);
  } catch {
    // Nothing was read: every pid is tried again on the next scan.
    return new Map();
  }
}

/**
 * Signals a whole process group. `gone` when no member is left; throws when the signal is
 * refused for another reason (EPERM).
 */
export function signalProcessGroup(group: number, signal: "SIGTERM" | "SIGKILL"): "sent" | "gone" {
  if (!Number.isSafeInteger(group) || group <= 1) throw new Error("Refusing to signal this group.");
  try {
    process.kill(-group, signal);
    return "sent";
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null)?.code === "ESRCH") return "gone";
    throw cause;
  }
}
