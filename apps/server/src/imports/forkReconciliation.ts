import { randomUUID, createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { SessionImportRecovery, SessionImportSource } from "@ryco/contracts";
import {
  discoverFiles,
  IMPORT_LIMITS,
  parseHistory,
  readSource,
  sourceKey,
  sourceStamp,
  type SourceHistory,
} from "./sourceHistory.ts";

export interface ForkCandidate {
  readonly file: string;
  readonly fingerprint: string;
  readonly history: SourceHistory;
  readonly read?: Awaited<ReturnType<typeof readSource>>;
}
interface Scan {
  readonly key: string;
  readonly root: string;
  readonly source: SessionImportSource;
  readonly sourceId: string;
  readonly pinned: string;
  readonly expires: number;
  readonly files: Awaited<ReturnType<typeof discoverFiles>>["files"];
  readonly stamps: Map<string, string>;
  readonly candidates: { id: string; messageCount: number }[];
  candidate: { file: string; fingerprint: string; id: string; bytes: number } | null;
  approved: boolean;
  count: number;
  offset: number;
  unknown: boolean;
}
const stamp = sourceStamp;
const sameFiles = (a: Scan["files"], b: Scan["files"]) =>
  a.length === b.length && a.every((file, index) => file.file === b[index]?.file);

// Opaque, process-local scan receipts expire to bound memory. Losing a receipt
// only requires inspection again; it never changes the durable fork phase.
export function makeForkScanner() {
  const scans = new Map<string, Scan>();
  const get = (token: string, key: string, pinned: string) => {
    const scan = scans.get(token);
    if (!scan || scan.key !== key || scan.pinned !== pinned || scan.expires < Date.now())
      throw new Error("Inspection expired or its configuration changed. Inspect again.");
    return scan;
  };
  const unchanged = async (scan: Scan) => {
    const catalog = await discoverFiles(scan.source, scan.root, true);
    if (catalog.capped || catalog.blocked || !sameFiles(scan.files, catalog.files)) return false;
    const deadline = Date.now() + IMPORT_LIMITS.pageMillis;
    for (const [file, previous] of scan.stamps) {
      if (Date.now() >= deadline || (await stamp(file)) !== previous) return false;
    }
    return true;
  };
  const validate = async (token: string, key: string, pinned: string, requireApproved = false) => {
    const scan = get(token, key, pinned);
    if (
      scan.unknown ||
      scan.offset !== scan.files.length ||
      scan.count !== 1 ||
      (requireApproved && !scan.approved) ||
      !(await unchanged(scan))
    )
      throw new Error("Fork evidence changed or is ambiguous. Inspect again.");
    return scan;
  };
  return {
    async page(input: {
      key: string;
      root: string;
      source: SessionImportSource;
      sourceId: string;
      pinned: string;
      cursor?: string | undefined;
      reservedBytes?: number;
      reservedFiles?: number;
    }): Promise<{
      scan: Scan;
      token: string;
      result: SessionImportRecovery;
      bytes: number;
      reads: number;
    }> {
      for (const [token, scan] of scans) if (scan.expires < Date.now()) scans.delete(token);
      let scan: Scan;
      if (input.cursor) {
        scan = get(input.cursor, input.key, input.pinned);
        scans.delete(input.cursor);
      } else {
        if (scans.size >= 32) scans.delete(scans.keys().next().value!);
        const catalog = await discoverFiles(input.source, input.root, true);
        scan = {
          ...input,
          expires: Date.now() + 10 * 60_000,
          files: catalog.files,
          stamps: new Map(),
          candidates: [],
          candidate: null,
          count: 0,
          approved: false,
          offset: 0,
          unknown: catalog.capped || catalog.blocked,
        };
      }
      let bytes = input.reservedBytes ?? 0;
      let reads = input.reservedFiles ?? 0;
      const deadline = Date.now() + IMPORT_LIMITS.pageMillis;
      const end = Math.min(scan.files.length, scan.offset + 50 - reads);
      for (; scan.offset < end; scan.offset++) {
        if (Date.now() >= deadline) break;
        const file = scan.files[scan.offset]!;
        try {
          const info = await stat(file.file);
          if (info.size > IMPORT_LIMITS.bytes) {
            scan.unknown = true;
            continue;
          }
          if (bytes + info.size > IMPORT_LIMITS.pageBytes) break;
          bytes += info.size;
          reads++;
          const before = await stamp(file.file);
          const read = await readSource(scan.root, file.file);
          const history = parseHistory(scan.source, read.contents);
          if (
            sourceKey(scan.source, scan.root, history.id) !== file.key ||
            before !== (await stamp(file.file))
          )
            throw new Error("identity changed");
          scan.stamps.set(file.file, before);
          if (history.forkedFromId === scan.sourceId && history.id !== scan.sourceId) {
            scan.count++;
            scan.candidate =
              scan.count === 1
                ? {
                    file: file.file,
                    fingerprint: read.fingerprint,
                    id: history.id,
                    bytes: info.size,
                  }
                : null;
            if (scan.candidates.length < 8)
              scan.candidates.push({ id: history.id, messageCount: history.messages.length });
          }
        } catch {
          // An unreadable/incomplete file might be another fork. It cannot prove
          // uniqueness or absence, even when a compatible candidate was found.
          scan.unknown = true;
        }
      }
      const scanning = scan.offset < scan.files.length;
      if (!scanning && !(await unchanged(scan))) scan.unknown = true;
      const token = randomUUID();
      scans.set(token, scan);
      const state = scanning
        ? "scanning"
        : scan.unknown
          ? "unknown"
          : scan.count > 1
            ? "multiple"
            : scan.count
              ? "unique"
              : "missing";
      return {
        scan,
        token,
        bytes,
        reads,
        result: {
          state,
          candidates: scan.candidates,
          nextCursor: scanning ? token : null,
          adoptionToken: null,
          notice: scanning
            ? "Continue inspecting the next bounded page."
            : state === "unique"
              ? "One fork found. Native compatibility must be verified before adoption."
              : state === "missing"
                ? "No proven fork found. The outcome remains uncertain; creating another copy is disabled."
                : state === "multiple"
                  ? "Multiple forks found. Adoption is paused because a unique copy cannot be proven."
                  : "The bounded scan cannot prove a unique fork. Import remains paused.",
        },
      };
    },
    async approve(token: string, key: string, pinned: string) {
      (await validate(token, key, pinned)).approved = true;
    },
    async validate(token: string, key: string, pinned: string) {
      await validate(token, key, pinned, true);
    },
    async candidate(token: string, key: string, pinned: string, requireApproved = false) {
      const scan = await validate(token, key, pinned, requireApproved);
      const candidate = scan.candidate!;
      const read = await readSource(scan.root, candidate.file);
      const history = parseHistory(scan.source, read.contents);
      if (
        read.fingerprint !== candidate.fingerprint ||
        history.id !== candidate.id ||
        history.forkedFromId !== scan.sourceId
      )
        throw new Error("Fork identity changed. Inspect again.");
      return { file: candidate.file, fingerprint: read.fingerprint, history, read };
    },
  };
}

// Compare provider-native context as well as redacted display messages. IDs and
// parent links are remapped by Claude; message payloads must remain identical.
export function nativeContext(source: SessionImportSource, contents: string): string {
  const hash = createHash("sha256");
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const context =
      source === "codex"
        ? row.type === "response_item"
          ? row.payload
          : undefined
        : row.message
          ? { type: row.type, message: row.message, isMeta: row.isMeta ?? false }
          : undefined;
    if (context !== undefined) hash.update(JSON.stringify(context) + "\n");
  }
  return hash.digest("hex");
}
