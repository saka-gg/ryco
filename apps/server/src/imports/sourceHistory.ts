import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { SessionImportSource } from "@ryco/contracts";

export const IMPORT_LIMITS = {
  files: 2000,
  entries: 10000,
  records: 20000,
  bytes: 16 * 1024 * 1024,
  lineBytes: 1024 * 1024,
  messages: 2000,
  text: 100000,
  pageBytes: 32 * 1024 * 1024,
  pageMillis: 3000,
};
type Row = Record<string, unknown>;
export const record = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const string = (value: unknown) => (typeof value === "string" ? value : "");
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export interface ImportMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}
export interface SourceHistory {
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  readonly messages: readonly ImportMessage[];
  readonly lastMessageId: string;
  readonly forkedFromId: string | null;
}
export interface SourceFile {
  readonly file: string;
  readonly key: string;
  readonly archived: boolean;
}
export function sourceKey(source: SessionImportSource, root: string, id: string) {
  return createHash("sha256")
    .update(JSON.stringify([source, root, id]))
    .digest("hex");
}
export function sourceCwd(value: unknown): string {
  const cwd = string(value);
  return cwd.length <= 4096 &&
    !Array.from(cwd).some((character) => character.charCodeAt(0) < 32) &&
    (path.posix.isAbsolute(cwd) || path.win32.isAbsolute(cwd))
    ? cwd
    : "";
}
export function visibleText(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value
            .flatMap((block) => {
              const item = record(block);
              return ["text", "input_text", "output_text"].includes(string(item.type)) &&
                typeof item.text === "string"
                ? [item.text]
                : [];
            })
            .join("\n")
        : "";
  // Only explicit display text is admitted; raw payloads, reasoning, tools and binary content never cross this boundary.
  if (text.length > IMPORT_LIMITS.text)
    throw new Error("A source message exceeds the import size limit.");
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[redacted private key]",
    )
    .replace(
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
      "[redacted credential]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, "$1[redacted]");
}
function* sourceLines(contents: string): Generator<string> {
  let offset = 0;
  while (offset < contents.length) {
    const end = contents.indexOf("\n", offset);
    if (end === -1) {
      yield contents.slice(offset);
      return;
    }
    yield contents.slice(offset, end);
    offset = end + 1;
  }
}
export function parseHistory(source: SessionImportSource, contents: string): SourceHistory {
  let id = "",
    cwd = "",
    sidechain = false;
  const messages: ImportMessage[] = [];
  const claude = new Map<string, { message?: ImportMessage; parent: string | null; row: Row }>();
  let leaf = "";
  let forkedFromId: string | null = null;
  let records = 0;
  for (const line of sourceLines(contents)) {
    if (++records > IMPORT_LIMITS.records)
      throw new Error("Source history exceeds the record limit.");
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > IMPORT_LIMITS.lineBytes)
      throw new Error("A source record exceeds the import size limit.");
    let row: Row;
    try {
      row = record(JSON.parse(line));
    } catch {
      throw new Error(
        "Source history is malformed or truncated. Retry after the source finishes writing.",
      );
    }
    if (source === "codex" && row.type === "session_meta") {
      const meta = record(row.payload);
      id = string(meta.id);
      cwd = sourceCwd(meta.cwd);
      if (uuid.test(string(meta.forked_from_id))) forkedFromId = string(meta.forked_from_id);
    }
    if (source === "claudeAgent") {
      id ||= string(row.sessionId);
      const forkOrigin = record(row.forkedFrom).sessionId;
      if (uuid.test(string(forkOrigin))) forkedFromId = string(forkOrigin);
      cwd ||= sourceCwd(row.cwd);
      sidechain ||= row.isSidechain === true;
      if (typeof row.uuid !== "string") continue;
      const msg = record(row.message);
      const display = ["user", "assistant"].includes(string(row.type)) && row.isMeta !== true;
      const text = display ? visibleText(msg.content) : "";
      const createdAt = validDate(row.timestamp, messages.length + claude.size);
      claude.set(row.uuid, {
        parent: typeof row.parentUuid === "string" ? row.parentUuid : null,
        row,
        ...(text
          ? { message: { id: row.uuid, role: row.type as "user" | "assistant", text, createdAt } }
          : {}),
      });
      if (row.type === "user" || row.type === "assistant") leaf = row.uuid;
    } else if (row.type === "response_item") {
      const msg = record(row.payload);
      if (msg.type !== "message" || !["user", "assistant"].includes(string(msg.role))) continue;
      // Codex response items carry a separate channel. Never surface analysis,
      // commentary, tool-directed messages or unknown future channels.
      if (
        msg.role === "assistant" &&
        msg.channel !== undefined &&
        msg.channel !== null &&
        msg.channel !== "final"
      )
        continue;
      if (msg.recipient !== undefined && msg.recipient !== null && msg.recipient !== "all")
        continue;
      const text = visibleText(msg.content);
      if (text)
        messages.push({
          id: `message-${messages.length}`,
          role: msg.role as "user" | "assistant",
          text,
          createdAt: validDate(row.timestamp, messages.length),
        });
    }
    if (messages.length + claude.size > IMPORT_LIMITS.messages)
      throw new Error("This conversation exceeds the import message limit.");
  }
  if (source === "claudeAgent") {
    const seen = new Set<string>();
    let current: string | null = leaf;
    while (current) {
      if (seen.has(current)) throw new Error("Source history has a cyclic message chain.");
      seen.add(current);
      const entry = claude.get(current);
      if (!entry) throw new Error("Source history has an incomplete message chain.");
      if (entry.message) messages.unshift(entry.message);
      current = entry.parent;
    }
    const final = record(claude.get(leaf)?.row.message);
    if (final.stop_reason !== "end_turn" && final.stop_reason !== "stop_sequence")
      throw new Error("Claude history must end at a completed assistant turn before importing.");
  }
  if (!uuid.test(id) || sidechain || !messages.length)
    throw new Error("This source is not a supported conversation with visible messages.");
  if (messages.at(-1)?.role !== "assistant")
    throw new Error("Wait for the source conversation to finish its last turn before importing.");
  let previous = Number.NEGATIVE_INFINITY;
  const ordered = messages.map((message) => {
    const timestamp = Math.max(Date.parse(message.createdAt), previous + 1);
    previous = timestamp;
    return { ...message, createdAt: new Date(timestamp).toISOString() };
  });
  return {
    id,
    cwd,
    title: (messages.find((m) => m.role === "user")?.text || "Imported conversation")
      .slice(0, 120)
      .replace(/[\r\n]/g, " "),
    messages: ordered,
    lastMessageId: leaf,
    forkedFromId,
  };
}
function validDate(value: unknown, index: number): string {
  const millis = typeof value === "string" ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(millis) ? millis : index).toISOString();
}
export async function readSource(
  root: string,
  file: string,
): Promise<{ contents: string; fingerprint: string }> {
  const canonical = await realpath(root);
  const resolved = await realpath(file);
  if (
    resolved !== file ||
    !resolved.startsWith(canonical + path.sep) ||
    (await lstat(file)).isSymbolicLink()
  )
    throw new Error("Source paths must be regular files inside the provider history directory.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > IMPORT_LIMITS.bytes)
      throw new Error("Source history exceeds the import file limit.");
    const buffer = Buffer.alloc(Math.min(IMPORT_LIMITS.bytes + 1, before.size + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    const after = await handle.stat();
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("Source history changed while being read. Retry when it is idle.");
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
    } catch {
      throw new Error("Source history contains malformed UTF-8.");
    }
    return { contents, fingerprint: createHash("sha256").update(contents).digest("hex") };
  } finally {
    await handle.close();
  }
}
export async function discoverFiles(
  source: SessionImportSource,
  root: string,
  archived: boolean,
): Promise<{ files: SourceFile[]; capped: boolean }> {
  const files: SourceFile[] = [];
  let entries = 0;
  let capped = false;
  const canonical = await realpath(root);
  const deadline = Date.now() + IMPORT_LIMITS.pageMillis;
  async function visit(dir: string, depth: number, isArchived: boolean) {
    if (capped) return;
    if (depth > (source === "codex" ? 4 : 1)) return;
    let directory;
    try {
      directory = await opendir(dir);
    } catch (error) {
      if (record(error).code === "ENOENT") return;
      throw error;
    }
    for await (const entry of directory) {
      if (
        ++entries > IMPORT_LIMITS.entries ||
        files.length >= IMPORT_LIMITS.files ||
        Date.now() >= deadline
      ) {
        capped = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1, isArchived);
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const match =
        source === "claudeAgent"
          ? entry.name.slice(0, -6)
          : entry.name.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1];
      if (match && uuid.test(match))
        files.push({ file, key: sourceKey(source, canonical, match), archived: isArchived });
    }
  }
  await visit(path.join(canonical, source === "codex" ? "sessions" : "projects"), 0, false);
  if (source === "codex" && archived)
    await visit(path.join(canonical, "archived_sessions"), 0, true);
  return { files: files.toSorted((a, b) => a.key.localeCompare(b.key)), capped };
}
