/**
 * The crashes Settings > Diagnostics lists: startup crashes from expo-updates' log (port of
 * T3's crash-log-model, #11540) and every fatal error the app recorded itself
 * (`fatalErrorRecorder.ts`), merged, newest first, with paths reduced to file names.
 * React-free.
 */
import type { FatalErrorRecord } from "./fatalErrorRecorder";

/** The fields of an `Updates.readLogEntriesAsync` entry this model reads. */
export interface UpdatesLogEntryLike {
  readonly timestamp: number;
  readonly message: string;
  readonly code: string;
  readonly level: string;
}

export interface CrashRecord {
  readonly timestamp: number;
  readonly description: string;
  readonly frames: ReadonlyArray<string>;
  /** The whole message and stack, paths reduced to file names, for the report. */
  readonly detail: string;
  /** "startup": expo-updates caught it during launch; "app": the app's own record. */
  readonly source: "startup" | "app";
}

const FATAL_PREFIX = "ErrorRecovery fatal exception: ";
const DESCRIPTION_PREFIX = "Description: ";
const UNHANDLED_PREFIX = "Unhandled JS Exception: ";
/** The same crash seen by both sources lands within this window. */
const DUPLICATE_WINDOW_MS = 2_000;

/**
 * Absolute paths (and file:// URLs) say where the app is installed on this device, not
 * anything about the crash: keep only the file name.
 */
export function stripPaths(text: string): string {
  return text.replaceAll(/(?:file:\/\/)?(?:\/[^\s/():]+)+\/([^\s/():]+)/gu, "$1");
}

function compactFrame(line: string): string {
  const match = /^at (.+?) \((.*)\)$/u.exec(line);
  if (!match) return stripPaths(line.slice("at ".length));
  const [, name = "", location = ""] = match;
  const file = location.slice(location.lastIndexOf("/") + 1);
  return location === "<anonymous>" ? name : `${name} (${file})`;
}

const framesOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .map(compactFrame);

export function parseStartupCrashRecords(
  entries: ReadonlyArray<UpdatesLogEntryLike>,
): ReadonlyArray<CrashRecord> {
  const records: CrashRecord[] = [];
  for (const entry of entries) {
    if (entry.code !== "JSRuntimeError" || !entry.message.startsWith(FATAL_PREFIX)) continue;
    const body = entry.message.slice(FATAL_PREFIX.length);
    const descriptionLine = body.split("\n").find((line) => line.startsWith(DESCRIPTION_PREFIX));
    if (descriptionLine === undefined) continue;
    let description = descriptionLine.slice(DESCRIPTION_PREFIX.length).trim();
    if (description.startsWith(UNHANDLED_PREFIX)) {
      description = description.slice(UNHANDLED_PREFIX.length);
    }
    records.push({
      timestamp: entry.timestamp,
      description: stripPaths(description),
      frames: framesOf(body),
      detail: stripPaths(body.trim()),
      source: "startup",
    });
  }
  return records;
}

export function appCrashRecords(
  records: ReadonlyArray<FatalErrorRecord>,
): ReadonlyArray<CrashRecord> {
  return records.flatMap((record) => {
    const timestamp = Date.parse(record.at);
    if (!Number.isFinite(timestamp)) return [];
    const detail = record.stack === null ? record.message : `${record.message}\n${record.stack}`;
    return [
      {
        timestamp,
        description: stripPaths(record.message),
        frames: record.stack === null ? [] : framesOf(record.stack),
        detail: stripPaths(detail),
        source: "app" as const,
      },
    ];
  });
}

/** Both sources, newest first; a crash both caught (same description within 2 s) once. */
export function mergeCrashRecords(
  ...sources: ReadonlyArray<ReadonlyArray<CrashRecord>>
): ReadonlyArray<CrashRecord> {
  const merged: CrashRecord[] = [];
  for (const record of sources.flat().toSorted((left, right) => right.timestamp - left.timestamp)) {
    const duplicate = merged.some(
      (kept) =>
        kept.description === record.description &&
        Math.abs(kept.timestamp - record.timestamp) <= DUPLICATE_WINDOW_MS,
    );
    if (!duplicate) merged.push(record);
  }
  return merged;
}

export interface CrashReportContext {
  readonly version: string;
  readonly build: string;
  readonly updateId: string | null;
  readonly channel: string | null;
  readonly runtimeVersion: string | null;
  readonly emergencyLaunchReason: string | null;
}

/** The text "Copy crash report" puts on the clipboard. */
export function formatCrashReport(
  records: ReadonlyArray<CrashRecord>,
  context: CrashReportContext,
): string {
  const header = [
    `Ryco ${context.version} (${context.build})`,
    ...(context.runtimeVersion === null ? [] : [`Runtime: ${context.runtimeVersion}`]),
    ...(context.channel === null ? [] : [`Channel: ${context.channel}`]),
    ...(context.updateId === null ? [] : [`Update: ${context.updateId}`]),
    ...(context.emergencyLaunchReason === null
      ? []
      : [
          `This launch fell back to the bundled version: ${stripPaths(context.emergencyLaunchReason)}`,
        ]),
  ];
  if (records.length === 0) return [...header, "No crashes recorded."].join("\n");
  return [
    ...header,
    ...records.map(
      (record) =>
        `\n--- ${new Date(record.timestamp).toISOString()} (${record.source === "startup" ? "at startup" : "while running"}) ---\n${record.detail}`,
    ),
  ].join("\n");
}
