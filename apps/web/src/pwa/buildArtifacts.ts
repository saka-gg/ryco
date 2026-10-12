import type { Plugin } from "vite";
import {
  ACCOUNT_E2EE_DEVICES_PATH,
  ACCOUNT_E2EE_DEVICE_PATH_PREFIX,
  NATIVE_ACCOUNT_GRANT_RELAY_TICKET_PATH,
  NATIVE_E2EE_CURRENT_DEVICE_PATH,
  NATIVE_E2EE_GRANT_KEYS_PATH,
} from "@ryco/contracts/native-e2ee";

import { findBootFontAsset } from "../viteBuild/bootFontPreload";
import {
  APP_ENTRY_MODULE,
  bundleGraphEntries,
  isChunkOfModule,
  reachableFiles,
  resolveBootAssets,
  type BundleGraphEntry,
} from "../viteBuild/bundleGraph";
import { renderHostedPwaBootDocument, renderHostedPwaOfflineDocument } from "./offlineDocument";

export type HostedPwaBundleEntry = BundleGraphEntry;

export interface HostedPwaPrecache {
  readonly cacheName: string;
  /**
   * What the worker installs before it activates: the boot closure, the hosted
   * root and the workspace and thread-route closures, plus the boot document —
   * everything a remembered browser needs to start offline. Fonts and images
   * are left to the runtime cache, except the ones the boot document paints
   * with.
   */
  readonly urls: ReadonlyArray<string>;
  /**
   * Every fingerprinted asset this build can load. The worker caches one of
   * these the first time it is fetched, and carries an unchanged one over from
   * the previous version's cache instead of downloading it again. Nothing
   * outside this exact list is ever cached.
   */
  readonly cacheableUrls: ReadonlyArray<string>;
}

/**
 * Source modules whose chunks are precached with their static imports. Every
 * other lazily loaded chunk is cached on first use instead of downloading all
 * of them — about 7 MiB — while a first visit is still loading.
 *
 * `main.tsx` is here because the built entry is `index.html`'s inline module
 * script, which imports the app dynamically; the rest are what the hosted boot
 * gate loads, what the workspace renders first, and the relay handshake every
 * node connection loads (kept off the boot path, but not off the shell cache).
 */
export const HOSTED_PWA_PRECACHE_MODULES = [
  APP_ENTRY_MODULE,
  "src/hostedHub/state.ts",
  "src/hostedHub/readCache.ts",
  "src/hostedHub/e2eeRuntime.ts",
  "src/components/PreviewFileNavigationGuard.tsx",
  "src/hostedHub/hostedWorkspaceOwners.ts",
  "src/components/hostedHub/HostedHubRoot.tsx",
  "src/components/hostedHub/hostedRootAppShell.tsx",
  "src/components/RootAppShell.tsx",
  "src/components/routeViews/ChatThreadRouteView.tsx",
  "src/components/routeViews/DraftChatThreadRouteView.tsx",
  "src/components/shell/phone/PhoneHome.tsx",
] as const;

const IMMUTABLE_ASSET_PATTERN =
  /(?:^|\/)[^/]+-[A-Za-z0-9_-]{8,}\.(?:css|gif|jpe?g|js|mjs|png|svg|ttf|webp|woff2?)$/i;
/**
 * Assets the precache leaves to the runtime cache. Every user-selectable font
 * family and every editor logo the stylesheet references is reachable from the
 * boot closure (about 600 KiB, a third of the install); a page that paints
 * with one fetches it once and the worker keeps it from then on, and an offline
 * start without it falls back to the system face.
 */
const RUNTIME_CACHED_ASSET_PATTERN = /\.(?:gif|jpe?g|png|svg|ttf|webp|woff2?)$/i;
const CACHE_NAME_PREFIX = "ryco-pwa-shell-";
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;
const NETWORK_ONLY_PATH_PREFIXES = ["/.well-known", "/api", "/attachments", "/v1/relay"];

/**
 * Security-sensitive native E2EE routes called out independently of the `/api`
 * catch-all. Rendering them into the worker makes a future API namespace move
 * keep credentials out of the shell cache instead of silently making them
 * cache-eligible.
 */
export const HOSTED_E2EE_NETWORK_ONLY_PATHS = [
  NATIVE_E2EE_CURRENT_DEVICE_PATH,
  NATIVE_E2EE_GRANT_KEYS_PATH,
  NATIVE_ACCOUNT_GRANT_RELAY_TICKET_PATH,
  ACCOUNT_E2EE_DEVICES_PATH,
] as const;
const NETWORK_ONLY_PATH_SUBTREES = [ACCOUNT_E2EE_DEVICE_PATH_PREFIX];

function normalizeBase(base: string): string {
  const withLeadingSlash = base.startsWith("/") ? base : `/${base}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

function pathAtBase(base: string, fileName: string): string {
  return `${normalizeBase(base)}${fileName.replace(/^\/+/, "")}`;
}

function stableDigest(value: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function immutableUrls(base: string, fileNames: Iterable<string>): string[] {
  return [
    ...new Set(
      [...fileNames]
        .filter((fileName) => IMMUTABLE_ASSET_PATTERN.test(fileName))
        .map((fileName) => pathAtBase(base, fileName)),
    ),
  ];
}

/**
 * The fingerprinted files the boot document should preload: the entry and the
 * app module's static closure, JavaScript only. Without them a SW-served boot
 * discovers its ~75-module graph one import level at a time.
 */
export function resolveHostedPwaBootModules(input: {
  readonly base: string;
  readonly entries: ReadonlyArray<HostedPwaBundleEntry>;
}): ReadonlyArray<string> {
  return immutableUrls(input.base, resolveBootAssets(input.entries).modules).toSorted();
}

export function resolveHostedPwaPrecache(input: {
  readonly base: string;
  readonly entries: ReadonlyArray<HostedPwaBundleEntry>;
  readonly offlineDocument: string;
  /** Defaults to {@link HOSTED_PWA_PRECACHE_MODULES}. */
  readonly precacheModules?: ReadonlyArray<string>;
  /**
   * Fonts or images the boot document paints with (the default UI face), which
   * are installed up front although assets are otherwise runtime-cached.
   */
  readonly bootDocumentAssets?: ReadonlyArray<string>;
}): HostedPwaPrecache {
  const entriesByFileName = new Map(input.entries.map((entry) => [entry.fileName, entry]));
  const entryFileNames = input.entries
    .filter((entry) => entry.isEntry)
    .map((entry) => entry.fileName);
  const precacheModules = input.precacheModules ?? HOSTED_PWA_PRECACHE_MODULES;
  const precacheRoots = [
    ...entryFileNames,
    ...input.entries
      .filter((entry) => isChunkOfModule(entry.facadeModuleId, precacheModules))
      .map((entry) => entry.fileName),
  ];
  const bootDocumentAssets = new Set(input.bootDocumentAssets ?? []);
  const offlineUrl = pathAtBase(input.base, "offline.html");
  const cacheableUrls = immutableUrls(
    input.base,
    reachableFiles(entriesByFileName, entryFileNames, { followDynamic: true }),
  ).toSorted();
  const cacheable = new Set(cacheableUrls);
  const precachedFiles = [
    ...reachableFiles(entriesByFileName, precacheRoots, { followDynamic: false }),
  ].filter(
    (fileName) => !RUNTIME_CACHED_ASSET_PATTERN.test(fileName) || bootDocumentAssets.has(fileName),
  );
  const urls = [
    // Only what this build can load: a precache root outside the reachable
    // graph is not an asset of this app.
    ...immutableUrls(input.base, precachedFiles).filter((url) => cacheable.has(url)),
    offlineUrl,
  ].toSorted();

  return {
    cacheName: `${CACHE_NAME_PREFIX}${stableDigest(
      `${urls.join("\n")}\n${cacheableUrls.join("\n")}\noffline:${stableDigest(input.offlineDocument)}`,
    )}`,
    urls,
    cacheableUrls,
  };
}

export const HOSTED_PWA_CACHE_NAME_PREFIX = CACHE_NAME_PREFIX;

export function renderHostedPwaServiceWorker(input: HostedPwaPrecache): string {
  return `"use strict";
const CACHE_NAME = ${JSON.stringify(input.cacheName)};
const CACHE_PREFIX = ${JSON.stringify(CACHE_NAME_PREFIX)};
const PRECACHE_URLS = ${JSON.stringify(input.urls)};
const CACHEABLE_URLS = ${JSON.stringify(input.cacheableUrls)};
const NETWORK_ONLY_PATH_PREFIXES = ${JSON.stringify(NETWORK_ONLY_PATH_PREFIXES)};
const NETWORK_ONLY_PATHS = ${JSON.stringify(HOSTED_E2EE_NETWORK_ONLY_PATHS)};
const NETWORK_ONLY_PATH_SUBTREES = ${JSON.stringify(NETWORK_ONLY_PATH_SUBTREES)};
const ACTIVATION_MESSAGE = "ryco:pwa:activate:v1";
const absoluteUrl = (url) => new URL(url, self.registration.scope).href;
const offlineUrl = absoluteUrl(PRECACHE_URLS.find((url) => url.endsWith("/offline.html")));
// Fingerprinted build assets only: their bytes never change under a URL. The
// boot document is not one of them, so it is never carried between versions.
const absoluteCacheableUrls = new Set(CACHEABLE_URLS.map(absoluteUrl));

function hasPathPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

function isNetworkOnlyPath(pathname) {
  return (
    NETWORK_ONLY_PATHS.includes(pathname) ||
    NETWORK_ONLY_PATH_SUBTREES.some((prefix) => pathname.startsWith(prefix + "/")) ||
    NETWORK_ONLY_PATH_PREFIXES.some((prefix) => hasPathPrefix(pathname, prefix))
  );
}

// Copying from an older version is an optimization: a cache that cannot be
// read is treated as empty, so the asset is fetched instead.
async function previousShellCaches() {
  try {
    const names = await caches.keys();
    return await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.open(name)),
    );
  } catch {
    return [];
  }
}

async function previousCopy(previous, url) {
  for (const cache of previous) {
    const response = await cache.match(url, { ignoreVary: true }).catch(() => undefined);
    if (response) return response;
  }
  return undefined;
}

// A complete copy of PRECACHE_URLS or no activation: an unchanged fingerprinted
// asset is copied from the previous version's cache, everything else (and the
// boot document always) is fetched. Any failure rejects the install, as
// cache.addAll would, and the previous worker stays in control.
async function install() {
  const cache = await caches.open(CACHE_NAME);
  const previous = await previousShellCaches();
  await Promise.all(
    PRECACHE_URLS.map(async (url) => {
      const href = absoluteUrl(url);
      if (absoluteCacheableUrls.has(href)) {
        if (await cache.match(href, { ignoreVary: true })) return;
        const copy = await previousCopy(previous, href);
        if (copy) return cache.put(href, copy);
        // Held to the runtime cache's rule: an HTML fallback for a chunk the
        // origin no longer serves fails the install rather than being kept.
        const asset = await fetch(new Request(href));
        if (!cacheableResponse(asset)) throw new TypeError("Precache request failed.");
        return cache.put(href, asset);
      }
      const response = await fetch(new Request(href, { cache: "no-cache" }));
      if (!response.ok) throw new TypeError("Precache request failed.");
      return cache.put(href, response);
    }),
  );
}

// Carry every runtime-cached asset this version still loads into its cache,
// then drop the previous versions. Fetches from controlled pages wait for
// activation, so the copies run concurrently, and a failed carry-over only
// costs a later network fetch: it never keeps old caches or skips the claim.
async function activate() {
  const names = (await caches.keys()).filter(
    (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,
  );
  try {
    const cache = await caches.open(CACHE_NAME);
    const carried = new Set();
    for (const name of names) {
      const previous = await caches.open(name);
      const requests = (await previous.keys()).filter(
        (request) => absoluteCacheableUrls.has(request.url) && !carried.has(request.url),
      );
      for (const request of requests) carried.add(request.url);
      await Promise.all(
        requests.map(async (request) => {
          if (await cache.match(request.url, { ignoreVary: true })) return;
          const response = await previous.match(request, { ignoreVary: true });
          if (response) await cache.put(request.url, response);
        }).map((copy) => copy.catch(() => undefined)),
      );
    }
  } catch {
    // Carrying assets forward is an optimization only.
  }
  await Promise.all(names.map((name) => caches.delete(name)));
  await self.clients.claim();
}

function cacheableResponse(response) {
  if (!response || !response.ok || response.status !== 200 || response.type !== "basic") return false;
  // A missing chunk answered with an HTML fallback must never be kept under a
  // fingerprinted URL.
  return !(response.headers.get("content-type") || "").toLowerCase().includes("text/html");
}

self.addEventListener("install", (event) => {
  event.waitUntil(install());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activate());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === ACTIVATION_MESSAGE) {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== self.location.origin) return;
  if (request.headers.has("range")) return;
  if (request.headers.get("accept")?.toLowerCase().includes("text/event-stream")) return;
  if (isNetworkOnlyPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(caches.open(CACHE_NAME).then(async (cache) => (await cache.match(offlineUrl)) ?? fetch(request)));
    return;
  }

  if (!absoluteCacheableUrls.has(url.href)) return;
  // Only fingerprinted, same-origin build assets reach here. Their bytes do not
  // vary with request headers; module requests can add Origin unlike precaching.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request, { ignoreVary: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (cacheableResponse(response)) {
        const stored = cache.put(url.href, response.clone()).catch(() => undefined);
        if (typeof event.waitUntil === "function") event.waitUntil(stored);
      }
      return response;
    }),
  );
});
`;
}

export function createHostedPwaBuildPlugin(): Plugin {
  let publicBase = "/";
  return {
    name: "ryco-hosted-pwa",
    apply: "build",
    configResolved(config) {
      publicBase = config.base;
    },
    // After the HTML plugin, so the built `index.html` — its inline theme
    // script and boot shell — is in the bundle to derive the boot document from.
    generateBundle: {
      order: "post",
      handler(_outputOptions, bundle) {
        const entries = bundleGraphEntries(bundle);
        const startUrl = normalizeBase(publicBase);
        const indexHtml = bundle["index.html"];
        const builtDocument =
          indexHtml?.type === "asset" && typeof indexHtml.source === "string"
            ? renderHostedPwaBootDocument({
                indexHtml: indexHtml.source,
                modulePreloads: resolveHostedPwaBootModules({ base: publicBase, entries }),
              })
            : null;
        const offlineDocument =
          builtDocument ??
          renderHostedPwaOfflineDocument({
            startUrl,
            scripts: entries
              .filter((entry) => entry.isEntry && IMMUTABLE_ASSET_PATTERN.test(entry.fileName))
              .map((entry) => pathAtBase(publicBase, entry.fileName)),
            styles: [
              ...new Set(
                entries
                  .filter((entry) => entry.isEntry)
                  .flatMap((entry) => entry.importedCss ?? []),
              ),
            ]
              .filter((fileName) => IMMUTABLE_ASSET_PATTERN.test(fileName))
              .map((fileName) => pathAtBase(publicBase, fileName)),
          });
        const bootFont = findBootFontAsset(bundle);
        const precache = resolveHostedPwaPrecache({
          base: publicBase,
          entries,
          offlineDocument,
          ...(bootFont ? { bootDocumentAssets: [bootFont] } : {}),
        });
        this.emitFile({
          type: "asset",
          fileName: "offline.html",
          source: offlineDocument,
        });
        this.emitFile({
          type: "asset",
          fileName: "service-worker.js",
          source: renderHostedPwaServiceWorker(precache),
        });
      },
    },
  };
}
