// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { UsageImportedMetric, UsageSourceStatus } from "@ryco/contracts";
import { anonymizeUsageRecord } from "./usageScanCache.ts";
import { readBoundedUsageFile } from "./usageFileReader.ts";
import { type UsageRecord } from "./usageRecord.ts";

export interface CursorExportSource {
  readonly path: string;
  readonly accountKey: string;
  readonly userEmail: string;
}
export const CURSOR_EXPORT_LIMITS = {
  fileBytes: 4 * 1024 * 1024,
  scanBytes: 32 * 1024 * 1024,
  files: 100,
  entries: 200,
  records: 20_000,
  durationMs: 5_000,
} as const;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string =>
  typeof value === "string" && value.length <= 512 && !value.includes("\0") ? value : "";
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000_000;
export const cursorExportSourceId = (
  source: Pick<CursorExportSource, "accountKey" | "userEmail">,
) => hash(`cursor:declared-export\0${source.accountKey}\0${source.userEmail.trim().toLowerCase()}`);

export interface CursorExportResult {
  readonly sourceId: string;
  readonly records: readonly UsageRecord[];
  readonly imports: readonly UsageImportedMetric[];
  readonly status: UsageSourceStatus;
  readonly diagnosticCode: string;
  readonly malformedCount: number;
  readonly skippedCount: number;
  readonly fileCount: number;
  readonly parsedFileCount: number;
}

/** Only the published /teams/filtered-usage-events response, saved independently
 * by an authorized admin. No endpoint calls or credential discovery occur here. */
export async function readCursorExportUsage(
  source: CursorExportSource,
  signal?: AbortSignal,
  timeZone = "UTC",
): Promise<CursorExportResult> {
  const sourceId = cursorExportSourceId(source);
  const records = new Map<string, UsageRecord>(),
    imports = new Map<string, UsageImportedMetric>();
  const diagnostics = new Set<string>();
  let malformedCount = 0,
    skippedCount = 0,
    parsedFileCount = 0,
    fileCount = 0,
    bytes = 0,
    recordCount = 0;
  const started = Date.now();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const result = (status: UsageSourceStatus, diagnosticCode: string): CursorExportResult => ({
    sourceId,
    records: [...records.values()],
    imports: [...imports.values()],
    status,
    diagnosticCode,
    malformedCount,
    skippedCount,
    fileCount,
    parsedFileCount,
  });
  if (
    !Path.isAbsolute(source.path) ||
    !source.accountKey.trim() ||
    source.accountKey.length > 512 ||
    !source.userEmail.trim() ||
    source.userEmail.length > 512
  )
    return result("unsupported", "cursor-export-configuration-invalid");
  const check = () => {
    signal?.throwIfAborted();
    if (
      bytes > CURSOR_EXPORT_LIMITS.scanBytes ||
      recordCount >= CURSOR_EXPORT_LIMITS.records ||
      Date.now() - started >= CURSOR_EXPORT_LIMITS.durationMs
    ) {
      diagnostics.add("cursor-export-scan-limit");
      return false;
    }
    return true;
  };
  let paths: string[] = [];
  try {
    signal?.throwIfAborted();
    const stat = await FS.lstat(source.path);
    if (stat.isSymbolicLink()) return result("failed", "cursor-export-path-rejected");
    if (stat.isFile()) paths = [source.path];
    else if (stat.isDirectory()) {
      const directory = await FS.opendir(source.path);
      let entries = 0;
      for await (const entry of directory) {
        if (
          ++entries > CURSOR_EXPORT_LIMITS.entries ||
          paths.length >= CURSOR_EXPORT_LIMITS.files
        ) {
          diagnostics.add("cursor-export-scan-limit");
          break;
        }
        if (entry.isSymbolicLink()) diagnostics.add("cursor-export-path-rejected");
        else if (
          entry.isFile() &&
          entry.name.endsWith(".json") &&
          !/^(auth|credentials|config|cli-config)\.json$/i.test(entry.name)
        )
          paths.push(Path.join(source.path, entry.name));
      }
    } else return result("failed", "cursor-export-path-rejected");
  } catch (error) {
    signal?.throwIfAborted();
    return result(
      object(error).code === "ENOENT" ? "not-found" : "failed",
      "cursor-export-unreadable",
    );
  }
  paths = paths.toSorted();
  // Export pages from the same period must form a contiguous page set. Page
  // metadata cannot establish token completeness for request-priced events.
  const pageGroups = new Map<string, { expected: number; pages: Set<number> }>();
  for (const path of paths) {
    if (!check()) break;
    fileCount++;
    try {
      if (
        Path.extname(path).toLowerCase() !== ".json" ||
        /^(auth|credentials|config|cli-config)\.json$/i.test(Path.basename(path))
      ) {
        diagnostics.add("cursor-export-path-rejected");
        continue;
      }
      const before = await FS.lstat(path);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.size > CURSOR_EXPORT_LIMITS.fileBytes ||
        bytes + before.size > CURSOR_EXPORT_LIMITS.scanBytes
      ) {
        diagnostics.add("cursor-export-size-or-path-limit");
        continue;
      }
      bytes += before.size;
      const document = object(
        JSON.parse(await readBoundedUsageFile(path, CURSOR_EXPORT_LIMITS.fileBytes, signal)),
      );
      if (
        !Array.isArray(document.usageEvents) ||
        document.usageEvents.length > CURSOR_EXPORT_LIMITS.records
      ) {
        diagnostics.add("cursor-export-format-unsupported");
        continue;
      }
      const pagination = object(document.pagination),
        period = object(document.period);
      if (
        count(pagination.numPages) &&
        count(pagination.currentPage) &&
        pagination.currentPage >= 1 &&
        pagination.currentPage <= Math.max(1, pagination.numPages) &&
        count(period.startDate) &&
        count(period.endDate)
      ) {
        const key = `${period.startDate}:${period.endDate}`;
        const group = pageGroups.get(key) ?? {
          expected: Math.max(1, pagination.numPages),
          pages: new Set<number>(),
        };
        if (group.expected !== Math.max(1, pagination.numPages))
          diagnostics.add("cursor-export-pages-incomplete");
        group.pages.add(pagination.currentPage);
        pageGroups.set(key, group);
        if (pagination.hasNextPage !== pagination.currentPage < pagination.numPages)
          diagnostics.add("cursor-export-pages-incomplete");
      } else diagnostics.add("cursor-export-pages-incomplete");
      for (const rawEvent of document.usageEvents) {
        if (!check()) break;
        if (++recordCount % 128 === 0) await setImmediate(undefined, { signal });
        const event = object(rawEvent);
        if (text(event.userEmail).trim().toLowerCase() !== source.userEmail.trim().toLowerCase()) {
          skippedCount++;
          continue;
        }
        const model = text(event.model),
          conversationId = text(event.conversationId);
        const timestamp = text(event.timestamp);
        const timestampMs = /^\d{1,16}$/.test(timestamp) ? Number(timestamp) : NaN;
        if (!model || !count(timestampMs) || timestampMs > 8.64e15) {
          malformedCount++;
          diagnostics.add("cursor-export-record-invalid");
          continue;
        }
        const usage = object(event.tokenUsage);
        // The public response has no stable event ID. A metadata fingerprint is
        // deterministic across overlapping pages/copies, but identical genuine
        // calls cannot be distinguished. Always disclose that limitation.
        const recordId = hash(
          JSON.stringify([
            sourceId,
            timestamp,
            conversationId,
            model,
            text(event.kind),
            event.isTokenBasedCall === true,
            amount(event.requestsCosts) ? event.requestsCosts : null,
            amount(event.chargedCents) ? event.chargedCents : null,
            usage.inputTokens,
            usage.outputTokens,
            usage.cacheWriteTokens,
            usage.cacheReadTokens,
            usage.totalCents,
          ]),
        );
        const date = formatter.format(new Date(timestampMs));
        imports.set(`${recordId}:requests`, {
          sourceId,
          recordId: `${recordId}:requests`,
          provider: "cursor",
          date,
          model,
          metric: "requests",
          value: 1,
        });
        if (amount(event.chargedCents))
          imports.set(`${recordId}:billed`, {
            sourceId,
            recordId: `${recordId}:billed`,
            provider: "cursor",
            date,
            model,
            metric: "cost",
            value: event.chargedCents / 100,
            currency: "USD",
          });
        else diagnostics.add("cursor-export-billed-cost-missing");
        if (
          event.isTokenBasedCall !== true ||
          ![
            usage.inputTokens,
            usage.outputTokens,
            usage.cacheWriteTokens,
            usage.cacheReadTokens,
          ].every(count)
        ) {
          skippedCount++;
          diagnostics.add("cursor-export-token-fields-missing");
          continue;
        }
        const total =
          (usage.inputTokens as number) +
          (usage.outputTokens as number) +
          (usage.cacheWriteTokens as number) +
          (usage.cacheReadTokens as number);
        if (!Number.isSafeInteger(total)) {
          malformedCount++;
          diagnostics.add("cursor-export-record-invalid");
          continue;
        }
        const record: UsageRecord = {
          provider: "cursor",
          timestampMs,
          model,
          sessionId: conversationId,
          totals: {
            uncachedInputTokens: usage.inputTokens as number,
            cachedInputTokens: usage.cacheReadTokens as number,
            cacheCreationInputTokens: usage.cacheWriteTokens as number,
            outputTokens: usage.outputTokens as number,
            totalTokens: total,
          },
          reportedCostUsd: amount(usage.totalCents) ? usage.totalCents / 100 : null,
          dedupeKey: recordId,
        };
        // recordId already anonymizes the email; conversation IDs are hashed too.
        records.set(recordId, anonymizeUsageRecord(record));
        if (!amount(usage.totalCents)) diagnostics.add("cursor-export-model-cost-missing");
      }
      parsedFileCount++;
    } catch (error) {
      signal?.throwIfAborted();
      malformedCount++;
      diagnostics.add(text(object(error).code) || "cursor-export-unreadable");
    }
  }
  for (const group of pageGroups.values())
    if (group.pages.size !== group.expected) diagnostics.add("cursor-export-pages-incomplete");
  if (parsedFileCount === 0)
    return result(
      diagnostics.has("cursor-export-format-unsupported")
        ? "unsupported"
        : fileCount === 0
          ? "not-found"
          : "failed",
      diagnostics.values().next().value ?? "cursor-export-not-found",
    );
  diagnostics.add("cursor-export-event-identity-ambiguous");
  return result("partial", [...diagnostics].toSorted().join(","));
}
