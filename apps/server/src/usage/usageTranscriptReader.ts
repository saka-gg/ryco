// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { UsageProviderKind } from "@ryco/contracts";

import { parseClaudeTranscriptLine } from "./claudeTranscript.ts";
import { initialCodexTranscriptState, parseCodexTranscriptLine } from "./codexTranscript.ts";
import { mightCarryUsage, type UsageRecord } from "./usageRecord.ts";

export const USAGE_TRANSCRIPT_LIMITS = {
  entries: 50_000,
  files: 10_000,
  depth: 16,
  fileBytes: 64 * 1024 * 1024,
  lineBytes: 1024 * 1024,
  records: 100_000,
} as const;

export interface UsageTranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly fingerprint?: string;
}
export interface UsageTranscriptListing {
  readonly files: readonly UsageTranscriptFile[];
  readonly skippedEntryCount: number;
  readonly errorCount: number;
}

export async function listUsageTranscriptFiles(
  root: string,
  modifiedAfterMs: number,
  signal?: AbortSignal,
): Promise<UsageTranscriptListing> {
  const files: UsageTranscriptFile[] = [];
  let skippedEntryCount = 0,
    errorCount = 0,
    count = 0;
  const directories = [{ path: root, depth: 0 }];
  while (
    directories.length &&
    count < USAGE_TRANSCRIPT_LIMITS.entries &&
    files.length < USAGE_TRANSCRIPT_LIMITS.files
  ) {
    signal?.throwIfAborted();
    const directory = directories.pop()!;
    try {
      const directoryStat = await NodeFSP.lstat(directory.path);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        errorCount++;
        continue;
      }
      const entries = await NodeFSP.opendir(directory.path);
      for await (const entry of entries) {
        signal?.throwIfAborted();
        if (
          ++count >= USAGE_TRANSCRIPT_LIMITS.entries ||
          files.length >= USAGE_TRANSCRIPT_LIMITS.files
        ) {
          errorCount++;
          break;
        }
        const child = NodePath.join(directory.path, entry.name);
        if (entry.isSymbolicLink()) {
          errorCount++;
          continue;
        }
        if (entry.isDirectory()) {
          if (directory.depth >= USAGE_TRANSCRIPT_LIMITS.depth) errorCount++;
          else directories.push({ path: child, depth: directory.depth + 1 });
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          skippedEntryCount++;
          continue;
        }
        try {
          const stat = await NodeFSP.lstat(child);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            errorCount++;
            continue;
          }
          if (stat.mtimeMs >= modifiedAfterMs)
            files.push({
              path: child,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              fingerprint: `${stat.dev}:${stat.ino}:${stat.ctimeMs}`,
            });
          else skippedEntryCount++;
        } catch {
          errorCount++;
        }
      }
    } catch {
      signal?.throwIfAborted();
      errorCount++;
    }
  }
  if (directories.length) errorCount++;
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, skippedEntryCount, errorCount };
}

export interface UsageTranscriptReadResult {
  readonly records: readonly UsageRecord[];
  readonly skippedLineCount: number;
  readonly malformedLineCount: number;
  readonly limited: boolean;
}
function isJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/** Bounded lines: readline's unbounded accumulation is unsafe for partial files. */
export async function readUsageTranscript(
  filePath: string,
  provider: UsageProviderKind,
  signal?: AbortSignal,
): Promise<UsageTranscriptReadResult | null> {
  if (provider !== "claude" && provider !== "codex") return null;
  const records: UsageRecord[] = [];
  const started = Date.now();
  const codexState = initialCodexTranscriptState();
  let skippedLineCount = 0,
    malformedLineCount = 0,
    lineCount = 0,
    limited = false;
  const consume = (line: string) => {
    const carriesUsage = mightCarryUsage(line, provider);
    if (provider === "claude") {
      if (!carriesUsage) {
        skippedLineCount++;
        return;
      }
      const record = parseClaudeTranscriptLine(line);
      if (record !== null) records.push(record);
      else if (isJson(line)) skippedLineCount++;
      else malformedLineCount++;
    } else {
      const carriesContext = line.includes('"turn_context"') || line.includes('"session_meta"');
      if (!carriesUsage && !carriesContext) {
        skippedLineCount++;
        return;
      }
      const record = parseCodexTranscriptLine(line, codexState);
      if (record !== null) records.push(record);
      else if (!isJson(line)) malformedLineCount++;
      else if (carriesUsage) skippedLineCount++;
    }
  };
  let file: NodeFSP.FileHandle | undefined;
  try {
    signal?.throwIfAborted();
    const pathBefore = await NodeFSP.lstat(filePath);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) return null;
    file = await NodeFSP.open(
      filePath,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    const before = await file.stat();
    if (
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.ctimeMs !== pathBefore.ctimeMs
    )
      return null;
    if (!before.isFile() || before.size > USAGE_TRANSCRIPT_LIMITS.fileBytes) {
      return { records, skippedLineCount, malformedLineCount, limited: true };
    }
    const stream = file.createReadStream({
      encoding: "utf8",
      autoClose: false,
      end: USAGE_TRANSCRIPT_LIMITS.fileBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    let pending = "",
      discarding = false;
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      if (Date.now() - started >= 2_000) {
        limited = true;
        break;
      }
      const parts = String(chunk).split("\n");
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        if (
          !discarding &&
          Buffer.byteLength(pending) + Buffer.byteLength(part) > USAGE_TRANSCRIPT_LIMITS.lineBytes
        ) {
          discarding = true;
          pending = "";
          limited = true;
          malformedLineCount++;
        }
        if (!discarding) pending += part;
        if (index < parts.length - 1) {
          if (++lineCount > USAGE_TRANSCRIPT_LIMITS.records) {
            limited = true;
            break;
          }
          if (!discarding) consume(pending);
          pending = "";
          discarding = false;
        }
      }
      if (lineCount > USAGE_TRANSCRIPT_LIMITS.records) break;
    }
    if (pending && !limited) consume(pending);
    const after = await file.stat();
    const pathAfter = await NodeFSP.lstat(filePath);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      pathAfter.isSymbolicLink()
    )
      return null;
  } catch {
    signal?.throwIfAborted();
    return null;
  } finally {
    await file?.close();
  }
  return { records, skippedLineCount, malformedLineCount, limited };
}
