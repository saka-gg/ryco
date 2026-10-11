import type { Plugin } from "vite";
import {
  ACCOUNT_E2EE_DEVICES_PATH,
  ACCOUNT_E2EE_DEVICE_PATH_PREFIX,
  NATIVE_ACCOUNT_GRANT_RELAY_TICKET_PATH,
  NATIVE_E2EE_CURRENT_DEVICE_PATH,
  NATIVE_E2EE_GRANT_KEYS_PATH,
} from "@ryco/contracts/native-e2ee";

import { renderHostedPwaOfflineDocument } from "./offlineDocument";

export interface HostedPwaBundleEntry {
  readonly dynamicImports?: ReadonlyArray<string>;
  readonly fileName: string;
  readonly importedAssets?: ReadonlyArray<string>;
  readonly importedCss?: ReadonlyArray<string>;
  readonly imports?: ReadonlyArray<string>;
  readonly isEntry?: boolean;
  readonly referencedFiles?: ReadonlyArray<string>;
}

export interface HostedPwaPrecache {
  readonly cacheName: string;
  readonly urls: ReadonlyArray<string>;
}

const IMMUTABLE_ASSET_PATTERN =
  /(?:^|\/)[^/]+-[A-Za-z0-9_-]{8,}\.(?:css|gif|jpe?g|js|mjs|png|svg|ttf|webp|woff2?)$/i;
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

export function resolveHostedPwaPrecache(input: {
  readonly base: string;
  readonly entries: ReadonlyArray<HostedPwaBundleEntry>;
  readonly offlineDocument: string;
}): HostedPwaPrecache {
  const entriesByFileName = new Map(input.entries.map((entry) => [entry.fileName, entry]));
  const pendingFileNames = input.entries
    .filter((entry) => entry.isEntry)
    .map((entry) => entry.fileName);
  const reachableFileNames = new Set<string>();

  for (let index = 0; index < pendingFileNames.length; index += 1) {
    const fileName = pendingFileNames[index];
    if (!fileName || reachableFileNames.has(fileName)) continue;
    reachableFileNames.add(fileName);
    const entry = entriesByFileName.get(fileName);
    if (!entry) continue;
    pendingFileNames.push(
      ...(entry.dynamicImports ?? []),
      ...(entry.imports ?? []),
      ...(entry.importedCss ?? []),
      ...(entry.importedAssets ?? []),
      ...(entry.referencedFiles ?? []),
    );
  }

  const urls = [
    ...new Set(
      [...reachableFileNames]
        .filter((fileName) => IMMUTABLE_ASSET_PATTERN.test(fileName))
        .map((fileName) => pathAtBase(input.base, fileName)),
    ),
    pathAtBase(input.base, "offline.html"),
  ].toSorted();

  return {
    cacheName: `${CACHE_NAME_PREFIX}${stableDigest(
      `${urls.join("\n")}\noffline:${stableDigest(input.offlineDocument)}`,
    )}`,
    urls,
  };
}

export const HOSTED_PWA_CACHE_NAME_PREFIX = CACHE_NAME_PREFIX;

export function renderHostedPwaServiceWorker(input: HostedPwaPrecache): string {
  return `"use strict";
const CACHE_NAME = ${JSON.stringify(input.cacheName)};
const CACHE_PREFIX = ${JSON.stringify(CACHE_NAME_PREFIX)};
const PRECACHE_URLS = ${JSON.stringify(input.urls)};
const NETWORK_ONLY_PATH_PREFIXES = ${JSON.stringify(NETWORK_ONLY_PATH_PREFIXES)};
const NETWORK_ONLY_PATHS = ${JSON.stringify(HOSTED_E2EE_NETWORK_ONLY_PATHS)};
const NETWORK_ONLY_PATH_SUBTREES = ${JSON.stringify(NETWORK_ONLY_PATH_SUBTREES)};
const ACTIVATION_MESSAGE = "ryco:pwa:activate:v1";
const absolutePrecacheUrls = new Set(PRECACHE_URLS.map((url) => new URL(url, self.registration.scope).href));
const offlineUrl = new URL(PRECACHE_URLS.find((url) => url.endsWith("/offline.html")), self.registration.scope).href;

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

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
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

  if (!absolutePrecacheUrls.has(url.href)) return;
  // Only fingerprinted, same-origin build assets reach here. Their bytes do not
  // vary with request headers; module requests can add Origin unlike precaching.
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => (await cache.match(request, { ignoreVary: true })) ?? fetch(request)));
});
`;
}

function entriesFromBundle(
  bundle: Readonly<Record<string, { readonly fileName: string }>>,
): ReadonlyArray<HostedPwaBundleEntry> {
  return Object.values(bundle).map((entry) => {
    const output = entry as typeof entry & {
      readonly dynamicImports?: ReadonlyArray<string>;
      readonly imports?: ReadonlyArray<string>;
      readonly isEntry?: boolean;
      readonly referencedFiles?: ReadonlyArray<string>;
      readonly viteMetadata?: {
        readonly importedAssets?: ReadonlySet<string>;
        readonly importedCss?: ReadonlySet<string>;
      };
    };
    return {
      dynamicImports: output.dynamicImports ?? [],
      fileName: output.fileName,
      imports: output.imports ?? [],
      isEntry: output.isEntry ?? false,
      referencedFiles: output.referencedFiles ?? [],
      importedAssets: [...(output.viteMetadata?.importedAssets ?? [])],
      importedCss: [...(output.viteMetadata?.importedCss ?? [])],
    };
  });
}

export function createHostedPwaBuildPlugin(): Plugin {
  let publicBase = "/";
  return {
    name: "ryco-hosted-pwa",
    apply: "build",
    configResolved(config) {
      publicBase = config.base;
    },
    generateBundle(_outputOptions, bundle) {
      const entries = entriesFromBundle(bundle);
      const offlineDocument = renderHostedPwaOfflineDocument({
        startUrl: normalizeBase(publicBase),
        scripts: entries
          .filter((entry) => entry.isEntry && IMMUTABLE_ASSET_PATTERN.test(entry.fileName))
          .map((entry) => pathAtBase(publicBase, entry.fileName)),
        styles: [
          ...new Set(
            entries.filter((entry) => entry.isEntry).flatMap((entry) => entry.importedCss ?? []),
          ),
        ]
          .filter((fileName) => IMMUTABLE_ASSET_PATTERN.test(fileName))
          .map((fileName) => pathAtBase(publicBase, fileName)),
      });
      const precache = resolveHostedPwaPrecache({
        base: publicBase,
        entries,
        offlineDocument,
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
  };
}
