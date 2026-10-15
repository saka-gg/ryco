/**
 * Which renderer V8 code-cache entries a new app version leaves stale.
 *
 * The web build names its scripts by content hash and keeps the vendor chunks
 * byte-stable across app-only releases, so after an update most of the boot
 * graph is the same URLs with the same bytes. Their code-cache entries stay
 * valid (Chromium checks the cached response time and V8 its source hash and
 * flags before using one), so only the entries of scripts the new version no
 * longer ships are dead weight. An Electron (V8) change or an unknown history
 * still clears everything.
 */

/** What the previous launch recorded about the code cache it left behind. */
export interface RendererCodeCacheMarker {
  readonly version: string;
  /** `null` for a marker written before this record existed. */
  readonly electron: string | null;
  /** Content-hashed scripts under `assets/` that version shipped. */
  readonly assets: ReadonlyArray<string> | null;
  /** Renderer origins that cached them, most recent first. */
  readonly origins: ReadonlyArray<string>;
}

export type RendererCodeCachePrune =
  | { readonly kind: "none" }
  | { readonly kind: "all" }
  | { readonly kind: "urls"; readonly urls: ReadonlyArray<string> };

/** Origins remembered per marker; the port rarely moves, and only for a launch. */
export const RENDERER_CODE_CACHE_MAX_ORIGINS = 4;

const MARKER_FORMAT = 1;

/** Files under `assets/` that V8 keeps a code cache for. */
export function isCodeCachedAsset(name: string): boolean {
  return /\.(?:m?js|wasm)$/u.test(name);
}

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

export function parseRendererCodeCacheMarker(raw: string | null): RendererCodeCacheMarker | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  if (!text.startsWith("{")) {
    // The plain version string earlier builds wrote.
    return { version: text, electron: null, assets: null, origins: [] };
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (
      parsed.format !== MARKER_FORMAT ||
      typeof parsed.version !== "string" ||
      typeof parsed.electron !== "string" ||
      !isStringArray(parsed.assets) ||
      !isStringArray(parsed.origins)
    ) {
      return null;
    }
    return {
      version: parsed.version,
      electron: parsed.electron,
      assets: parsed.assets,
      origins: parsed.origins,
    };
  } catch {
    return null;
  }
}

export function serializeRendererCodeCacheMarker(marker: RendererCodeCacheMarker): string {
  return `${JSON.stringify({
    format: MARKER_FORMAT,
    version: marker.version,
    electron: marker.electron,
    assets: marker.assets,
    origins: marker.origins,
  })}\n`;
}

function sameStrings(left: ReadonlyArray<string> | null, right: ReadonlyArray<string>): boolean {
  return left !== null && left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * Decide what to clear for this launch, and the marker to write afterwards
 * (`null`: the current one already says everything).
 */
export function planRendererCodeCachePrune(
  previous: RendererCodeCacheMarker | null,
  current: {
    readonly version: string;
    readonly electron: string;
    /** `null` when the shipped assets could not be listed. */
    readonly assets: ReadonlyArray<string> | null;
    readonly origin: string;
  },
): { readonly prune: RendererCodeCachePrune; readonly marker: RendererCodeCacheMarker | null } {
  const assets = current.assets === null ? null : current.assets.toSorted();
  const origins = [
    current.origin,
    ...(previous?.origins ?? []).filter((origin) => origin !== current.origin),
  ].slice(0, RENDERER_CODE_CACHE_MAX_ORIGINS);
  const next: RendererCodeCacheMarker = {
    version: current.version,
    electron: current.electron,
    assets,
    origins,
  };
  // Assets that cannot be listed are recorded as unknown, which makes the next
  // version change clear everything.
  const fresh = (prune: RendererCodeCachePrune) => ({
    prune,
    marker: { ...next, origins: prune.kind === "all" ? [current.origin] : origins },
  });

  if (previous === null) return fresh({ kind: "all" });
  if (previous.electron !== null && previous.electron !== current.electron) {
    return fresh({ kind: "all" });
  }
  if (previous.version === current.version) {
    // Same build: only a new origin (or a legacy marker) needs recording. A
    // failed listing keeps what the previous launch of this build listed.
    const sameBuild = { ...next, assets: assets ?? previous.assets };
    const unchanged =
      previous.electron === current.electron &&
      sameBuild.assets !== null &&
      sameStrings(previous.assets, sameBuild.assets) &&
      sameStrings(previous.origins, origins);
    return { prune: { kind: "none" }, marker: unchanged ? null : sameBuild };
  }
  if (previous.assets === null || assets === null || previous.origins.length === 0) {
    return fresh({ kind: "all" });
  }
  const shipped = new Set(assets);
  const removed = previous.assets.filter((name) => !shipped.has(name));
  const urls = previous.origins.flatMap((origin) =>
    removed.map((name) => `${origin}/assets/${name}`),
  );
  return fresh(urls.length === 0 ? { kind: "none" } : { kind: "urls", urls });
}
