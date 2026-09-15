import { LRUCache } from "./lruCache";
import { isSupportedMermaidSource, MERMAID_LIMITS } from "./mermaidPolicy";

export type MermaidTheme = "light" | "dark";
export interface MermaidImage {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

const cache = new LRUCache<MermaidImage | false>(
  MERMAID_LIMITS.cacheEntries,
  MERMAID_LIMITS.cacheBytes,
);
const pending = new Map<
  string,
  { promise: Promise<MermaidImage | null>; consumers: Set<() => boolean> }
>();
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

function keyFor(source: string, theme: MermaidTheme): string {
  return JSON.stringify([theme, source]);
}

export function cachedMermaid(source: string, theme: MermaidTheme): MermaidImage | null {
  return cache.get(keyFor(source, theme)) || null;
}

/** One owner for Mermaid's global configuration. Rejected jobs cannot poison the queue. */
export function renderMermaid(
  source: string,
  theme: MermaidTheme,
  active: () => boolean,
): Promise<MermaidImage | null> {
  if (!active() || !isSupportedMermaidSource(source)) return Promise.resolve(null);
  const key = keyFor(source, theme);
  const cached = cache.get(key);
  if (cached !== null) return Promise.resolve(cached || null);
  const existing = pending.get(key);
  if (existing) {
    existing.consumers.add(active);
    return existing.promise;
  }
  if (pending.size >= MERMAID_LIMITS.pending) return Promise.resolve(null);
  const consumers = new Set([active]);
  const hasConsumer = () => [...consumers].some((consumer) => consumer());
  const promise = queue
    .then(async () => {
      if (!hasConsumer()) return null;
      // A promise queue alone can monopolize the microtask queue across many
      // diagrams. Give input/paint a task boundary before each layout.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!hasConsumer()) return null;
      const { renderMermaidImage } = await import("./mermaidEngine");
      if (!hasConsumer()) return null;
      let result: MermaidImage;
      try {
        result = await renderMermaidImage(source, theme, `ryco-mermaid-${++nextId}`);
      } catch (cause) {
        // Bound repeated parse/layout failures on virtualized row remounts.
        // Import failures remain retryable and never enter this cache.
        if (hasConsumer()) cache.set(key, false, 2 * key.length);
        throw cause;
      }
      if (!hasConsumer()) return null;
      const bytes = 2 * (key.length + result.src.length);
      // LRUCache intentionally permits one oversized entry. This consumer doesn't.
      if (bytes <= MERMAID_LIMITS.cacheBytes) cache.set(key, result, bytes);
      return result;
    })
    .finally(() => pending.delete(key));
  pending.set(key, { promise, consumers });
  queue = promise.catch(() => undefined);
  return promise;
}
