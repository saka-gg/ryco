/**
 * Page titles for a thread's local servers (Synara's local server monitor, with its numbers).
 *
 * Only listeners the scan attributed to a thread are probed: a listener alone does not identify
 * its protocol, and HTTP sent to another app's binary listener can crash it. A probe is one
 * `GET /` over loopback with no credentials, follows a redirect only to the same loopback port,
 * reads at most a 128 KiB prefix and gives up after 650 ms. Results are cached per process and
 * port: 30 s for a title, 10 s for none.
 *
 * @module localServerTitles
 */
import { request } from "node:http";

import { THREAD_LOCAL_SERVER_TITLE_MAX_CHARS } from "@ryco/contracts";
import { sanitizeUntrustedLine } from "@ryco/shared/untrustedText";

export const TITLE_TIMEOUT_MS = 650;
export const TITLE_MAX_BYTES = 128 * 1024;
export const TITLE_REDIRECT_LIMIT = 3;
export const TITLE_TTL_OK_MS = 30_000;
export const TITLE_TTL_FAIL_MS = 10_000;
export const TITLE_CACHE_MAX = 250;
export const TITLE_CONCURRENCY = 4;

/** Servers that never speak HTTP: probing them only fills their logs. */
const NON_HTTP_PROCESS_NAMES = new Set([
  "postgres",
  "mysqld",
  "mariadbd",
  "redis-server",
  "valkey-server",
  "mongod",
  "memcached",
]);

export function allowsTitleProbe(processName: string | null): boolean {
  return processName === null || !NON_HTTP_PROCESS_NAMES.has(processName.toLowerCase());
}

/**
 * Page text is cut to this many characters before it is cleaned: the title is at most 200, and
 * every pattern below then runs on a bounded string.
 */
export const TITLE_SOURCE_MAX_CHARS = 1024;
/** Meta tags looked at per page, and the characters of each one. */
const META_TAGS_MAX = 64;
const META_TAG_MAX_CHARS = 1024;

const ENTITY = /&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|apos|gt|lt|nbsp|quot);/giu;

function decodeEntity(match: string, entity: string): string {
  const normalized = entity.toLowerCase();
  if (normalized === "amp") return "&";
  if (normalized === "apos") return "'";
  if (normalized === "gt") return ">";
  if (normalized === "lt") return "<";
  if (normalized === "nbsp") return " ";
  if (normalized === "quot") return '"';
  const codePoint = normalized.startsWith("#x")
    ? Number.parseInt(normalized.slice(2), 16)
    : Number.parseInt(normalized.slice(1), 10);
  // A surrogate code point alone is not a character.
  const surrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
  return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff && !surrogate
    ? String.fromCodePoint(codePoint)
    : match;
}

/** One line of page text: tags dropped, entities decoded, then `sanitizeUntrustedLine`. */
export function normalizePageTitle(input: string): string | null {
  const text = input
    .slice(0, TITLE_SOURCE_MAX_CHARS)
    .replace(/<[^<>]*>/gu, " ")
    .replace(ENTITY, decodeEntity);
  return sanitizeUntrustedLine(text, THREAD_LOCAL_SERVER_TITLE_MAX_CHARS) || null;
}

function metaContent(html: string, names: ReadonlyArray<string>): string | null {
  let seen = 0;
  for (const tag of html.matchAll(/<meta\b[^<>]*>/giu)) {
    if (++seen > META_TAGS_MAX) break;
    const raw = tag[0].slice(0, META_TAG_MAX_CHARS);
    const name = /\b(?:name|property)=["']?([^"'\s<>]+)/iu.exec(raw)?.[1]?.toLowerCase();
    if (name === undefined || !names.includes(name)) continue;
    const content =
      /\bcontent="([^"<>]*)"/iu.exec(raw) ??
      /\bcontent='([^'<>]*)'/iu.exec(raw) ??
      /\bcontent=([^"'\s<>]+)/iu.exec(raw);
    const title = normalizePageTitle(content?.[1] ?? "");
    if (title) return title;
  }
  return null;
}

/**
 * A page's name from a prefix of its HTML, without a DOM: `application-name`, `og:title` or
 * `twitter:title`, else `<title>`. Linear in the page's length: tag patterns stop at the next
 * `<` or `>`, and the title's end is found with `indexOf`.
 */
export function extractPageTitle(html: string): string | null {
  const meta = metaContent(html, ["application-name", "og:title", "twitter:title"]);
  if (meta) return meta;
  const open = /<title\b[^<>]*>/iu.exec(html);
  if (open === null) return null;
  const start = open.index + open[0].length;
  const end = html.toLowerCase().indexOf("</title", start);
  return end < 0
    ? null
    : normalizePageTitle(html.slice(start, Math.min(end, start + TITLE_SOURCE_MAX_CHARS)));
}

/** The loopback address to reach a listener on `host` (`*`, `127.0.0.1`, `[::1]`, ...). */
export function probeAddress(host: string): string {
  return host === "[::1]" || host === "::1" || host === "[::]" || host === "::"
    ? "::1"
    : "127.0.0.1";
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches `path` from `address:port` and returns its title. Redirects are followed only within
 * the same address and port. Never throws.
 */
export function fetchPageTitle(address: string, port: number): Promise<string | null> {
  const deadline = Date.now() + TITLE_TIMEOUT_MS;
  const get = (path: string, redirects: number): Promise<string | null> =>
    new Promise((resolve) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (title: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        resolve(title);
      };
      const req = request(
        {
          host: address,
          family: address.includes(":") ? 6 : 4,
          port,
          path,
          method: "GET",
          agent: false,
          maxHeaderSize: 16 * 1024,
          headers: {
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            "User-Agent": "RycoThreadServers/1.0",
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (REDIRECT_STATUSES.has(status)) {
            response.resume();
            const next = sameOriginRedirect(response.headers.location, address, port);
            if (next === null || redirects >= TITLE_REDIRECT_LIMIT) {
              finish(null);
              return;
            }
            settled = true;
            clearTimeout(timer);
            req.destroy();
            void get(next, redirects + 1).then(resolve);
            return;
          }
          const type = response.headers["content-type"]?.toLowerCase() ?? "";
          if (status < 200 || status >= 300 || (type && !/text\/html|xhtml\+xml/u.test(type))) {
            finish(null);
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          const done = () => finish(extractPageTitle(Buffer.concat(chunks).toString("utf8")));
          response.on("data", (chunk: Buffer) => {
            const room = TITLE_MAX_BYTES - bytes;
            chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
            bytes += Math.min(chunk.length, room);
            if (bytes >= TITLE_MAX_BYTES) done();
          });
          response.on("end", done);
          response.on("error", () => finish(null));
        },
      );
      const timer = setTimeout(() => finish(null), remaining);
      timer.unref?.();
      req.on("error", () => finish(null));
      req.end();
    });
  return get("/", 0);
}

/** The path of a redirect that stays on the same loopback origin, or null. */
export function sameOriginRedirect(
  location: string | undefined,
  address: string,
  port: number,
): string | null {
  if (!location) return null;
  const host = address.includes(":") ? `[${address}]` : address;
  const origin = `http://${host}:${port}`;
  try {
    const next = new URL(location, `${origin}/`);
    if (next.protocol !== "http:" || next.username || next.password) return null;
    const sameHost =
      next.hostname === host || next.hostname === "localhost" || next.hostname === address;
    const nextPort = next.port === "" ? 80 : Number(next.port);
    return sameHost && nextPort === port ? `${next.pathname}${next.search}` : null;
  } catch {
    return null;
  }
}

export interface TitleProbe {
  /** The cached or probed title of the server `key` names (its pid, start time and port). */
  readonly title: (
    key: string,
    target: { readonly host: string; readonly port: number },
  ) => Promise<string | null>;
  readonly clear: () => void;
}

/** A title cache with Synara's lifetimes and bound, and one probe in flight per server. */
export function makeTitleProbe(
  options: {
    readonly fetch?: (address: string, port: number) => Promise<string | null>;
    readonly now?: () => number;
  } = {},
): TitleProbe {
  const fetchTitle = options.fetch ?? fetchPageTitle;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readonly title: string | null; readonly expiresAt: number }>();
  const inFlight = new Map<string, Promise<string | null>>();
  /** Bumped by `clear`: a probe that started before it never refills the cache. */
  let generation = 0;
  return {
    title: (key, target) => {
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.title);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const started = generation;
      const probe = fetchTitle(probeAddress(target.host), target.port)
        .catch(() => null)
        .then((title) => {
          if (started !== generation) return title;
          cache.delete(key);
          cache.set(key, {
            title,
            expiresAt: now() + (title ? TITLE_TTL_OK_MS : TITLE_TTL_FAIL_MS),
          });
          while (cache.size > TITLE_CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
          return title;
        })
        .finally(() => {
          if (inFlight.get(key) === probe) inFlight.delete(key);
        });
      inFlight.set(key, probe);
      return probe;
    },
    clear: () => {
      generation += 1;
      cache.clear();
      inFlight.clear();
    },
  };
}
