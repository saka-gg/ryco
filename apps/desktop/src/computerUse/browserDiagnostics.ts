// Adapted from Synara (MIT) commit 8f6521a67 and main 299fd573b apps/desktop/src/browserAutomation/browserDiagnostics.ts and navigationTracker.ts; see docs/licenses/synara-computer-use.txt.
import { redactDiagnosticText } from "@ryco/shared/diagnosticRedaction";

/** Entries kept per tab (console and network together); the oldest are dropped first. */
export const MAX_DIAGNOSTIC_ENTRIES = 1_000;
/** Requests remembered for response/failure entries and the in-flight count (LRU). */
export const MAX_TRACKED_REQUESTS = 2_048;
/** One read's JSON; results go straight into the model's context (Synara allows 320 KiB). */
export const DIAGNOSTICS_OUTPUT_MAX_BYTES = 64 * 1024;
/** No tracked request for this long (and the page not loading) counts as network idle. */
export const NETWORK_IDLE_WINDOW_MS = 500;
export const DIAGNOSTICS_DEFAULT_LIMIT = 100;
export const DIAGNOSTICS_MAX_LIMIT = 200;

export interface BrowserConsoleEntry {
  readonly kind: "console";
  readonly timestamp: string;
  readonly level: "debug" | "info" | "log" | "warn" | "error" | "exception";
  readonly text: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}
export interface BrowserNetworkEntry {
  readonly kind: "network";
  readonly timestamp: string;
  readonly phase: "request" | "response" | "failure";
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType?: string;
  readonly status?: number;
  readonly mimeType?: string;
  readonly durationMs?: number;
  readonly errorText?: string;
}
export type BrowserDiagnosticEntry = BrowserConsoleEntry | BrowserNetworkEntry;
export interface BrowserDiagnosticsRead {
  readonly startedAt: string;
  readonly capturedAt: string;
  /** Entries of this kind the ring dropped since capture started. */
  readonly droppedCount: number;
  /** Entries were dropped, or more matched than `limit` or the output cap allowed. */
  readonly truncated: boolean;
  readonly entries: BrowserDiagnosticEntry[];
}

interface TrackedRequest {
  readonly url: string;
  readonly method: string;
  readonly startedAt: number;
  readonly loaderId: string | undefined;
  readonly resourceType: string | undefined;
  /** Streams (WebSocket, EventSource) never finish, so they never hold network idle. */
  readonly counts: boolean;
}

type Params = Record<string, unknown>;

/** At most `maximumBytes` of UTF-8, cut before a code point that would not fit. */
export function truncateUtf8(value: string, maximumBytes: number): string {
  // Each UTF-16 unit needs at most 3 bytes; shorter strings fit without encoding them.
  if (value.length * 3 <= maximumBytes) return value;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

const boundedUtf8 = (value: unknown, maximumBytes: number, fallback = ""): string =>
  truncateUtf8(
    String(value ?? fallback)
      // oxlint-disable-next-line no-control-regex -- page text: control characters become spaces.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
    maximumBytes,
  );

/** Credentials, fragments and every query value are removed; other schemes keep only their name. */
export const boundedUrl = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "about:blank";
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "ws:", "wss:", "about:"].includes(url.protocol))
      return boundedUtf8(`${url.protocol}[redacted]`, 8_192, "about:blank") || "about:blank";
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of new Set(url.searchParams.keys())) {
      const count = url.searchParams.getAll(key).length;
      url.searchParams.delete(key);
      for (let index = 0; index < count; index += 1) url.searchParams.append(key, "[REDACTED]");
    }
    // URLSearchParams percent-encodes the marker's brackets; keep it readable.
    const href = url.href.replaceAll("%5BREDACTED%5D", "[REDACTED]");
    return boundedUtf8(href, 8_192, "about:blank") || "about:blank";
  } catch {
    return "invalid:[redacted]";
  }
};

const boundedMethod = (value: unknown): string => boundedUtf8(value, 32, "GET") || "GET";

const consoleLevel = (value: unknown): BrowserConsoleEntry["level"] => {
  switch (String(value).toLowerCase()) {
    case "debug":
    case "verbose":
      return "debug";
    case "info":
      return "info";
    case "warning":
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "exception":
      return "exception";
    default:
      return "log";
  }
};

const remoteObjectText = (raw: unknown): string => {
  if (!raw || typeof raw !== "object") return boundedUtf8(raw, 1_024);
  const object = raw as { value?: unknown; description?: unknown; unserializableValue?: unknown };
  if (typeof object.value === "string") return boundedUtf8(object.value, 1_024);
  if (object.value !== undefined) {
    try {
      return boundedUtf8(JSON.stringify(object.value), 1_024);
    } catch {
      // Fall through to the CDP preview description.
    }
  }
  return boundedUtf8(object.description ?? object.unserializableValue, 1_024);
};

const optionalInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(10_000_000, value)
    : undefined;

const optionalStatus = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

const optionalText = (value: unknown, maximumBytes: number): string | undefined =>
  typeof value === "string" && value ? boundedUtf8(value, maximumBytes) || undefined : undefined;

const params = (value: unknown): Params | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Params) : undefined;

/** CDP's console timestamps: milliseconds since the epoch. */
const cdpTime = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value < 8.64e15
    ? value
    : undefined;

/**
 * A URL path can carry a credential (a Slack webhook, a JWT or an API key segment). Query values
 * are gone already (`boundedUrl`), so only the part before them goes through the shared rules.
 */
const redactedUrl = (url: string): string => {
  const query = url.indexOf("?");
  return query < 0
    ? redactDiagnosticText(url)
    : `${redactDiagnosticText(url.slice(0, query))}${url.slice(query)}`;
};

/** Console text and URLs are the page's own; the shared rules still take out tokens, keys and credentials. */
const redactedEntry = (entry: BrowserDiagnosticEntry): BrowserDiagnosticEntry =>
  entry.kind === "console"
    ? {
        ...entry,
        text: redactDiagnosticText(entry.text),
        ...(entry.url === undefined ? {} : { url: redactedUrl(entry.url) }),
      }
    : { ...entry, url: redactedUrl(entry.url) };

/** Where a console message came from: V8 (console API and exceptions) or Blink's Log domain. */
type ConsoleSource = "runtime" | "log";

/**
 * Bounded console and network diagnostics of one tab, fed by its CDP events. It stores no headers,
 * cookies, post data, bodies, initiators or raw CDP payloads. URLs lose credentials, fragments and
 * query values; console text goes through the shared diagnostic redaction when it is read. Pure
 * data: no Electron, no timers.
 */
export class BrowserTabDiagnostics {
  private readonly now: () => number;
  private readonly entries: BrowserDiagnosticEntry[] = [];
  private readonly requests = new Map<string, TrackedRequest>();
  private readonly dropped = { console: 0, network: 0 };
  private startedAt = new Date().toISOString();
  private lastNetworkActivityAt: number;
  /** The newest console timestamp captured per source. */
  private newest: Record<ConsoleSource, number> = { runtime: -Infinity, log: -Infinity };
  /**
   * A new session's Runtime.enable and Log.enable replay every message the page still stores, with
   * its original timestamp; those up to here were captured on an earlier session.
   */
  private replayedUntil: Record<ConsoleSource, number> = { runtime: -Infinity, log: -Infinity };

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.lastNetworkActivityAt = now();
  }

  onMessage(method: string, raw: Params): void {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const timestamp = this.consoleTimestamp("runtime", raw.timestamp);
        if (timestamp === null) return;
        const frames = params(raw.stackTrace)?.callFrames;
        const frame = Array.isArray(frames) ? params(frames[0]) : undefined;
        const args = Array.isArray(raw.args) ? raw.args : [];
        const lineNumber = optionalInteger(frame?.lineNumber);
        const columnNumber = optionalInteger(frame?.columnNumber);
        this.push({
          kind: "console",
          timestamp,
          level: consoleLevel(raw.type),
          text: boundedUtf8(args.map(remoteObjectText).filter(Boolean).join(" "), 4_096),
          ...(typeof frame?.url === "string" && frame.url ? { url: boundedUrl(frame.url) } : {}),
          ...(lineNumber === undefined ? {} : { lineNumber }),
          ...(columnNumber === undefined ? {} : { columnNumber }),
        });
        return;
      }
      case "Runtime.exceptionThrown": {
        const timestamp = this.consoleTimestamp("runtime", raw.timestamp);
        if (timestamp === null) return;
        const details = params(raw.exceptionDetails);
        const exception = params(details?.exception);
        const lineNumber = optionalInteger(details?.lineNumber);
        const columnNumber = optionalInteger(details?.columnNumber);
        this.push({
          kind: "console",
          timestamp,
          level: "exception",
          text: boundedUtf8(exception?.description ?? details?.text ?? "Page exception", 4_096),
          ...(typeof details?.url === "string" && details.url
            ? { url: boundedUrl(details.url) }
            : {}),
          ...(lineNumber === undefined ? {} : { lineNumber }),
          ...(columnNumber === undefined ? {} : { columnNumber }),
        });
        return;
      }
      case "Log.entryAdded": {
        const entry = params(raw.entry);
        if (!entry) return;
        const timestamp = this.consoleTimestamp("log", entry.timestamp);
        if (timestamp === null) return;
        const lineNumber = optionalInteger(entry.lineNumber);
        this.push({
          kind: "console",
          timestamp,
          level: consoleLevel(entry.level),
          text: boundedUtf8(entry.text, 4_096),
          ...(typeof entry.url === "string" && entry.url ? { url: boundedUrl(entry.url) } : {}),
          ...(lineNumber === undefined ? {} : { lineNumber }),
        });
        return;
      }
      case "Network.requestWillBeSent": {
        const requestId = boundedUtf8(raw.requestId, 256);
        const request = params(raw.request);
        if (!requestId || !request) return;
        const resourceType = optionalText(raw.type, 64);
        const tracked: TrackedRequest = {
          url: boundedUrl(request.url),
          method: boundedMethod(request.method),
          startedAt: this.now(),
          loaderId: optionalText(raw.loaderId, 256),
          resourceType,
          counts: resourceType !== "WebSocket" && resourceType !== "EventSource",
        };
        // A redirect reuses the request id: the newest hop replaces the old one.
        this.requests.delete(requestId);
        this.requests.set(requestId, tracked);
        while (this.requests.size > MAX_TRACKED_REQUESTS)
          this.requests.delete(this.requests.keys().next().value!);
        if (tracked.counts) this.lastNetworkActivityAt = tracked.startedAt;
        this.push({
          kind: "network",
          timestamp: new Date().toISOString(),
          phase: "request",
          requestId,
          url: tracked.url,
          method: tracked.method,
          ...(resourceType === undefined ? {} : { resourceType }),
        });
        return;
      }
      case "Network.responseReceived": {
        const requestId = boundedUtf8(raw.requestId, 256);
        const response = params(raw.response);
        if (!requestId || !response) return;
        const tracked = this.requests.get(requestId);
        const status = optionalStatus(response.status);
        const mimeType = optionalText(response.mimeType, 256);
        const resourceType = tracked?.resourceType ?? optionalText(raw.type, 64);
        this.push({
          kind: "network",
          timestamp: new Date().toISOString(),
          phase: "response",
          requestId,
          url: boundedUrl(response.url ?? tracked?.url),
          method: boundedMethod(tracked?.method),
          ...(resourceType === undefined ? {} : { resourceType }),
          ...(status === undefined ? {} : { status }),
          ...(mimeType === undefined ? {} : { mimeType }),
          ...this.duration(tracked),
        });
        return;
      }
      case "Network.loadingFailed": {
        const requestId = boundedUtf8(raw.requestId, 256);
        if (!requestId) return;
        const tracked = this.requests.get(requestId);
        this.push({
          kind: "network",
          timestamp: new Date().toISOString(),
          phase: "failure",
          requestId,
          url: boundedUrl(tracked?.url),
          method: boundedMethod(tracked?.method),
          ...(tracked?.resourceType === undefined ? {} : { resourceType: tracked.resourceType }),
          errorText: boundedUtf8(raw.errorText, 1_024, "Network request failed"),
          ...this.duration(tracked),
        });
        this.finish(requestId);
        return;
      }
      case "Network.loadingFinished": {
        const requestId = boundedUtf8(raw.requestId, 256);
        if (requestId) this.finish(requestId);
        return;
      }
      case "Page.frameNavigated": {
        const frame = params(raw.frame);
        if (!frame || frame.parentId) return;
        // A new main document invalidates unfinished requests of the previous loader; Chromium
        // does not report a failure for each of them.
        const loaderId = typeof frame.loaderId === "string" ? frame.loaderId : undefined;
        let discarded = false;
        for (const [requestId, request] of this.requests) {
          if (loaderId && request.loaderId === loaderId) continue;
          this.requests.delete(requestId);
          discarded ||= request.counts;
        }
        if (discarded) this.lastNetworkActivityAt = this.now();
        return;
      }
    }
  }

  /** The newest `limit` entries of `kind`, trimmed (oldest first) to at most 64 KiB of JSON. */
  read(kind: "console" | "network", limit: number): BrowserDiagnosticsRead {
    const matching = this.entries.filter((entry) => entry.kind === kind);
    // Redacted here, for at most `limit` entries, rather than for every message a busy page logs.
    let entries = matching.slice(-Math.max(1, Math.trunc(limit))).map(redactedEntry);
    let truncated = this.dropped[kind] > 0 || matching.length > entries.length;
    const base = {
      startedAt: this.startedAt,
      capturedAt: new Date().toISOString(),
      droppedCount: this.dropped[kind],
    };
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
    if (
      entries.length > 0 &&
      size({ ...base, truncated, entries }) > DIAGNOSTICS_OUTPUT_MAX_BYTES
    ) {
      truncated = true;
      let bytes = size({ ...base, truncated, entries: [] });
      let first = entries.length;
      // JSON arrays only add commas between independently serialized entries, so count the newest
      // suffix once instead of encoding the shrinking result again and again. An oversized result
      // always drops at least its oldest entry.
      for (let index = entries.length - 1; index > 0; index -= 1) {
        const next = bytes + size(entries[index]) + (first < entries.length ? 1 : 0);
        if (next > DIAGNOSTICS_OUTPUT_MAX_BYTES) break;
        bytes = next;
        first = index;
      }
      entries = entries.slice(first);
    }
    return { ...base, truncated, entries };
  }

  /** In flight: tracked requests not finished or failed. Quiet: since the last start or finish. */
  networkIdle(loading: boolean): { idle: boolean; inFlight: number; quietMs: number } {
    let inFlight = 0;
    for (const request of this.requests.values()) if (request.counts) inFlight += 1;
    const quietMs = Math.max(0, this.now() - this.lastNetworkActivityAt);
    return {
      idle: inFlight === 0 && quietMs >= NETWORK_IDLE_WINDOW_MS && !loading,
      inFlight,
      quietMs,
    };
  }

  /**
   * A new debugger session (or Network enabled again): no finish events will come for earlier
   * requests, and the console messages it replays that were captured before are skipped. Entries
   * stay.
   */
  resetSession(): void {
    this.requests.clear();
    this.lastNetworkActivityAt = this.now();
    this.beforeConsoleReplay();
  }

  /** Runtime.enable or Log.enable is about to replay the page's stored console messages. */
  beforeConsoleReplay(): void {
    this.replayedUntil = { ...this.newest };
  }

  clear(): void {
    this.entries.length = 0;
    this.requests.clear();
    this.dropped.console = 0;
    this.dropped.network = 0;
    this.startedAt = new Date().toISOString();
    this.lastNetworkActivityAt = this.now();
    this.newest = { runtime: -Infinity, log: -Infinity };
    this.replayedUntil = { runtime: -Infinity, log: -Infinity };
  }

  /**
   * The entry's ISO time from the message's own timestamp (replayed messages keep theirs), or null
   * for a replay of a message an earlier session already captured. Messages without a timestamp
   * are always new.
   */
  private consoleTimestamp(source: ConsoleSource, raw: unknown): string | null {
    const time = cdpTime(raw);
    if (time === undefined) return new Date().toISOString();
    if (time <= this.replayedUntil[source]) return null;
    if (time > this.newest[source]) this.newest[source] = time;
    return new Date(time).toISOString();
  }

  private push(entry: BrowserDiagnosticEntry): void {
    this.entries.push(entry);
    if (this.entries.length <= MAX_DIAGNOSTIC_ENTRIES) return;
    for (const removed of this.entries.splice(0, this.entries.length - MAX_DIAGNOSTIC_ENTRIES))
      this.dropped[removed.kind] = Math.min(1_000_000_000, this.dropped[removed.kind] + 1);
  }

  private finish(requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);
    if (request.counts) this.lastNetworkActivityAt = this.now();
  }

  private duration(tracked: TrackedRequest | undefined): { durationMs?: number } {
    return tracked
      ? { durationMs: Math.min(3_600_000, Math.max(0, Math.round(this.now() - tracked.startedAt))) }
      : {};
  }
}
