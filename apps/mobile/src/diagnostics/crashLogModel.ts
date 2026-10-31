/**
 * The crashes Settings > Diagnostics lists: startup crashes from expo-updates' log (port of
 * T3's crash-log-model, #11540) and every fatal error the app recorded itself
 * (`fatalErrorRecorder.ts`), merged, newest first. The app redacts its records when it writes
 * them; expo-updates' log is redacted here, as it is read (`crashTextRedaction.ts`).
 * React-free.
 */
import { redactCrashText } from "./crashTextRedaction";
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
  /** The first line of the message. */
  readonly description: string;
  readonly frames: ReadonlyArray<string>;
  /** The whole message and stack, redacted, for the report. */
  readonly detail: string;
  /** "startup": expo-updates caught it during launch; "app": the app's own record. */
  readonly source: "startup" | "app";
}

const FATAL_PREFIX = "ErrorRecovery fatal exception: ";
const DESCRIPTION_PREFIX = "Description: ";
const UNHANDLED_PREFIX = "Unhandled JS Exception: ";
/** The same crash seen by both sources lands within this window. */
const DUPLICATE_WINDOW_MS = 2_000;

const firstLine = (text: string) => text.split("\n", 1)[0] ?? "";

/** One `at …` line of redacted text: a URL location keeps only its last part too. */
function compactFrame(line: string): string {
  const match = /^at (.+?) \((.*)\)$/u.exec(line);
  if (!match) return line.slice("at ".length);
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
    const body = redactCrashText(entry.message.slice(FATAL_PREFIX.length));
    const descriptionLine = body.split("\n").find((line) => line.startsWith(DESCRIPTION_PREFIX));
    if (descriptionLine === undefined) continue;
    let description = descriptionLine.slice(DESCRIPTION_PREFIX.length).trim();
    if (description.startsWith(UNHANDLED_PREFIX)) {
      description = description.slice(UNHANDLED_PREFIX.length);
    }
    records.push({
      timestamp: entry.timestamp,
      description,
      frames: framesOf(body),
      detail: body.trim(),
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
    // Redacted when written; again here costs little and changes nothing on a clean record.
    const message = redactCrashText(record.message);
    const stack = record.stack === null ? null : redactCrashText(record.stack);
    return [
      {
        timestamp,
        description: firstLine(message),
        frames: stack === null ? [] : framesOf(stack),
        detail: stack === null ? message : `${message}\n${stack}`,
        source: "app" as const,
      },
    ];
  });
}

/**
 * Both sources, newest first; a crash both caught (the same first line within 2 s) once.
 * expo-updates logs only the first line of a message as its description.
 */
export function mergeCrashRecords(
  ...sources: ReadonlyArray<ReadonlyArray<CrashRecord>>
): ReadonlyArray<CrashRecord> {
  const merged: CrashRecord[] = [];
  for (const record of sources.flat().toSorted((left, right) => right.timestamp - left.timestamp)) {
    const duplicate = merged.some(
      (kept) =>
        firstLine(kept.description) === firstLine(record.description) &&
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
          `This launch fell back to the bundled version: ${redactCrashText(context.emergencyLaunchReason)}`,
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
