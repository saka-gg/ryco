import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ACCOUNT_E2EE_DEVICES_PATH,
  NATIVE_ACCOUNT_GRANT_RELAY_TICKET_PATH,
  NATIVE_E2EE_CURRENT_DEVICE_PATH,
  NATIVE_E2EE_GRANT_KEYS_PATH,
} from "@ryco/contracts/native-e2ee";

import {
  HOSTED_E2EE_NETWORK_ONLY_PATHS,
  renderHostedPwaServiceWorker,
  resolveHostedPwaBootModules,
  resolveHostedPwaPrecache,
} from "./buildArtifacts";
import { renderHostedPwaBootDocument, renderHostedPwaOfflineDocument } from "./offlineDocument";

describe("hosted PWA build artifacts", () => {
  const offlineDocument = renderHostedPwaOfflineDocument({ startUrl: "/" });
  const entries = [
    {
      fileName: "assets/main-AbCd1234.js",
      isEntry: true,
      dynamicImports: ["assets/lazy-UvWx1234.js"],
      imports: ["assets/vendor-QrSt7890.js"],
      importedCss: ["assets/main-EfGh5678.css"],
      importedAssets: ["assets/mono-IjKl9012.woff2", "assets/logo-MnOp3456.png"],
    },
    { fileName: "assets/vendor-QrSt7890.js" },
    { fileName: "assets/main-EfGh5678.css" },
    { fileName: "assets/mono-IjKl9012.woff2" },
    { fileName: "assets/logo-MnOp3456.png" },
    { fileName: "assets/main-AbCd1234.js.map" },
    { fileName: "index.html" },
    { fileName: "site.webmanifest" },
    { fileName: "favicon-96x96.png" },
    { fileName: "assets/unversioned.js" },
    { fileName: "assets/readme-QrSt7890.txt" },
    {
      fileName: "assets/lazy-UvWx1234.js",
      imports: ["assets/lazy-dependency-YzAb5678.js"],
    },
    { fileName: "assets/lazy-dependency-YzAb5678.js" },
  ] as const;

  it("allows only fingerprinted immutable shell assets plus the offline document", () => {
    const precache = resolveHostedPwaPrecache({ base: "/", entries, offlineDocument });
    // Installed up front: the entry's static closure and the boot document.
    expect(precache.urls).toEqual([
      "/assets/logo-MnOp3456.png",
      "/assets/main-AbCd1234.js",
      "/assets/main-EfGh5678.css",
      "/assets/mono-IjKl9012.woff2",
      "/assets/vendor-QrSt7890.js",
      "/offline.html",
    ]);
    // Cached on first use: everything else this build can load, and nothing more.
    expect(precache.cacheableUrls).toEqual([
      "/assets/lazy-UvWx1234.js",
      "/assets/lazy-dependency-YzAb5678.js",
      "/assets/logo-MnOp3456.png",
      "/assets/main-AbCd1234.js",
      "/assets/main-EfGh5678.css",
      "/assets/mono-IjKl9012.woff2",
      "/assets/vendor-QrSt7890.js",
    ]);
  });

  it("precaches the static closure of the boot-critical lazy modules", () => {
    const precache = resolveHostedPwaPrecache({
      base: "/",
      entries: entries.map((entry) =>
        entry.fileName === "assets/lazy-UvWx1234.js"
          ? {
              ...entry,
              facadeModuleId: "/repo/apps/web/src/components/hostedHub/HostedHubRoot.tsx",
            }
          : entry,
      ),
      offlineDocument,
    });
    expect(precache.urls).toContain("/assets/lazy-UvWx1234.js");
    expect(precache.urls).toContain("/assets/lazy-dependency-YzAb5678.js");
    // A boot-critical name on a chunk the build cannot reach is not precached.
    const unreachable = resolveHostedPwaPrecache({
      base: "/",
      entries: [
        ...entries,
        {
          fileName: "assets/orphan-Orph1234.js",
          facadeModuleId: "/repo/apps/web/src/components/RootAppShell.tsx",
        },
      ],
      offlineDocument,
    });
    expect(unreachable.urls).not.toContain("/assets/orphan-Orph1234.js");
    expect(unreachable.cacheableUrls).not.toContain("/assets/orphan-Orph1234.js");
  });

  it("respects a configured public base path", () => {
    const precache = resolveHostedPwaPrecache({ base: "/ryco/", entries, offlineDocument });
    expect(precache.urls).toEqual([
      "/ryco/assets/logo-MnOp3456.png",
      "/ryco/assets/main-AbCd1234.js",
      "/ryco/assets/main-EfGh5678.css",
      "/ryco/assets/mono-IjKl9012.woff2",
      "/ryco/assets/vendor-QrSt7890.js",
      "/ryco/offline.html",
    ]);
    expect(precache.cacheableUrls).toContain("/ryco/assets/lazy-UvWx1234.js");
  });

  it("derives a deterministic cache key from immutable output and offline revisions", () => {
    const first = resolveHostedPwaPrecache({ base: "/", entries, offlineDocument });
    const reordered = resolveHostedPwaPrecache({
      base: "/",
      entries: entries.toReversed(),
      offlineDocument,
    });
    const changed = resolveHostedPwaPrecache({
      base: "/",
      entries: entries.map((entry) =>
        entry.fileName === "assets/main-AbCd1234.js"
          ? { fileName: "assets/main-ZyXw9876.js" }
          : entry,
      ),
      offlineDocument,
    });
    const changedOfflineDocument = resolveHostedPwaPrecache({
      base: "/",
      entries,
      offlineDocument: `${offlineDocument}\n<!-- revised -->`,
    });

    expect(first.cacheName).toMatch(/^ryco-pwa-shell-[a-f0-9]{16}$/);
    expect(reordered).toEqual(first);
    expect(changed.cacheName).not.toBe(first.cacheName);
    expect(changedOfflineDocument.cacheName).not.toBe(first.cacheName);
  });

  it("renders a bounded worker that caches only the resolved allowlist", () => {
    const precache = resolveHostedPwaPrecache({ base: "/", entries, offlineDocument });
    const source = renderHostedPwaServiceWorker(precache);

    expect(source).toContain(JSON.stringify(precache.cacheName));
    expect(source).toContain(JSON.stringify(precache.urls));
    expect(source).toContain(JSON.stringify(precache.cacheableUrls));
    expect(source).toContain('request.mode === "navigate"');
    expect(source).toContain('request.headers.has("range")');
    expect(source).toContain("event.data?.type === ACTIVATION_MESSAGE");
    expect(source).not.toContain("index.html");
    expect(source).not.toContain('skipWaiting();\n});\n\nself.addEventListener("activate"');
  });

  it("renders a self-contained offline document without application data hooks", () => {
    const source = renderHostedPwaOfflineDocument({ startUrl: "/ryco/" });

    expect(source).toContain('href="/ryco/"');
    expect(source).toContain("No project or conversation data is stored");
    expect(source).not.toContain("<script");
    expect(source).not.toContain("/api/");
    expect(source).not.toContain("localStorage");
  });

  it("serves immutable module scripts offline when Origin differs from the precache request", async () => {
    const origin = "https://ryco.example";
    const cached = new Response("export default 'static shell'", {
      headers: { Vary: "Origin", "Content-Type": "text/javascript" },
    });
    const network = vi.fn(() => Promise.reject(new Error("offline")));
    const handlers = new Map<string, (event: unknown) => void>();
    runInNewContext(
      renderHostedPwaServiceWorker(
        resolveHostedPwaPrecache({ base: "/", entries, offlineDocument }),
      ),
      {
        URL,
        self: {
          registration: { scope: `${origin}/` },
          location: { origin },
          addEventListener: (type: string, handler: (event: unknown) => void) =>
            handlers.set(type, handler),
        },
        caches: {
          open: async () => ({
            // Cache.addAll uses no Origin; a module request includes it.
            match: async (request: Request, options?: CacheQueryOptions) =>
              options?.ignoreVary || !request.headers.has("Origin") ? cached : undefined,
          }),
        },
        fetch: network,
      },
    );
    let response: Promise<Response> | undefined;
    handlers.get("fetch")!({
      request: new Request(`${origin}/assets/main-AbCd1234.js`, {
        headers: { Origin: origin },
        mode: "cors",
      }),
      respondWith: (result: Promise<Response>) => {
        response = result;
      },
    });
    expect(await (await response)!.text()).toBe("export default 'static shell'");
    expect(network).not.toHaveBeenCalled();
  });

  it("boots the remembered-browser app from only build-generated entry points", () => {
    const source = renderHostedPwaOfflineDocument({
      startUrl: "/",
      scripts: ["/assets/index-abcdefgh.js"],
      styles: ["/assets/index-abcdefgh.css"],
    });
    expect(source).toContain('<div id="root"></div>');
    expect(source).toContain('src="/assets/index-abcdefgh.js"');
    expect(source).not.toContain("/api/");
    expect(source).not.toContain("localStorage");
    const worker = renderHostedPwaServiceWorker(
      resolveHostedPwaPrecache({ base: "/", entries, offlineDocument: source }),
    );
    expect(worker).toContain("(await cache.match(offlineUrl)) ?? fetch(request)");
  });

  it("derives the boot document from the built shell with preloads for the boot modules", () => {
    const indexHtml =
      '<!doctype html><html><head><style>#boot-shell{}</style><script type="module" crossorigin src="/assets/main-AbCd1234.js"></script></head><body><div id="root"><div id="boot-shell"></div></div></body></html>';
    const modulePreloads = resolveHostedPwaBootModules({ base: "/", entries });
    expect(modulePreloads).toEqual(["/assets/main-AbCd1234.js", "/assets/vendor-QrSt7890.js"]);
    const document = renderHostedPwaBootDocument({ indexHtml, modulePreloads });
    expect(document).toContain('<div id="boot-shell">');
    expect(document).toContain(
      '<link rel="modulepreload" crossorigin href="/assets/vendor-QrSt7890.js"></head>',
    );
    // The entry script already loads itself; it is not preloaded twice.
    expect(document).not.toContain('modulepreload" crossorigin href="/assets/main-AbCd1234.js"');
    expect(document).not.toContain("/api/");
    // Something that is not the app shell falls back to the minimal document.
    expect(renderHostedPwaBootDocument({ indexHtml: "<html></html>", modulePreloads })).toBe(null);
  });

  describe("rendered worker caching", () => {
    const origin = "https://ryco.example";

    class MemoryCache {
      readonly entries = new Map<string, Response>();
      async match(request: Request | string) {
        const key = typeof request === "string" ? request : request.url;
        return this.entries.get(key)?.clone();
      }
      async put(request: Request | string, response: Response) {
        this.entries.set(typeof request === "string" ? request : request.url, response);
      }
      async add(request: string) {
        this.entries.set(request, await network(request));
      }
      async keys() {
        return [...this.entries.keys()].map((url) => new Request(url));
      }
    }

    let network: (request: Request | string) => Promise<Response>;

    /** A worker's same-origin fetch answers with a `basic` response. */
    const sameOrigin = (response: Response) =>
      Object.defineProperty(response, "type", { value: "basic" });

    function runWorker(stores: Map<string, MemoryCache>) {
      const handlers = new Map<string, (event: unknown) => void>();
      const fetchCalls: string[] = [];
      network = async (request) => {
        const url = typeof request === "string" ? request : request.url;
        fetchCalls.push(url);
        return sameOrigin(
          new Response(`network ${url}`, {
            headers: { "content-type": url.endsWith(".html") ? "text/html" : "text/javascript" },
          }),
        );
      };
      const precache = resolveHostedPwaPrecache({ base: "/", entries, offlineDocument });
      runInNewContext(renderHostedPwaServiceWorker(precache), {
        URL,
        Request,
        TypeError,
        self: {
          registration: { scope: `${origin}/` },
          location: { origin },
          clients: { claim: async () => undefined },
          addEventListener: (type: string, handler: (event: unknown) => void) =>
            handlers.set(type, handler),
        },
        caches: {
          open: async (name: string) => {
            if (!stores.has(name)) stores.set(name, new MemoryCache());
            return stores.get(name)!;
          },
          keys: async () => [...stores.keys()],
          delete: async (name: string) => stores.delete(name),
        },
        fetch: (request: Request | string) => network(request),
      });
      const lifecycle = async (type: "install" | "activate") => {
        let done: Promise<unknown> = Promise.resolve();
        handlers.get(type)!({ waitUntil: (promise: Promise<unknown>) => (done = promise) });
        await done;
      };
      const get = async (path: string) => {
        let response: Promise<Response> | undefined;
        const pending: Promise<unknown>[] = [];
        handlers.get("fetch")!({
          request: new Request(`${origin}${path}`),
          respondWith: (result: Promise<Response>) => {
            response = result;
          },
          waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        });
        const result = response ? await response : undefined;
        await Promise.all(pending);
        return result;
      };
      return { precache, fetchCalls, lifecycle, get };
    }

    it("installs from the previous version's cache and fetches only what is new", async () => {
      const stores = new Map<string, MemoryCache>();
      const previous = new MemoryCache();
      previous.entries.set(`${origin}/assets/vendor-QrSt7890.js`, new Response("old vendor"));
      previous.entries.set(`${origin}/offline.html`, new Response("old boot document"));
      previous.entries.set(`${origin}/assets/lazy-UvWx1234.js`, new Response("old lazy"));
      previous.entries.set(`${origin}/assets/gone-Gone1234.js`, new Response("removed"));
      stores.set("ryco-pwa-shell-0000000000000000", previous);
      const worker = runWorker(stores);

      await worker.lifecycle("install");
      const current = stores.get(worker.precache.cacheName)!;
      expect(await (await current.match(`${origin}/assets/vendor-QrSt7890.js`))!.text()).toBe(
        "old vendor",
      );
      // The boot document is never carried over; it is always fetched.
      expect(await (await current.match(`${origin}/offline.html`))!.text()).toBe(
        `network ${origin}/offline.html`,
      );
      expect(worker.fetchCalls).not.toContain(`${origin}/assets/vendor-QrSt7890.js`);
      expect(worker.fetchCalls).toContain(`${origin}/assets/main-AbCd1234.js`);

      await worker.lifecycle("activate");
      // A runtime-cached asset this build still loads survives the update;
      // one it no longer loads does not, and the old cache is gone.
      expect(await (await current.match(`${origin}/assets/lazy-UvWx1234.js`))!.text()).toBe(
        "old lazy",
      );
      expect(await current.match(`${origin}/assets/gone-Gone1234.js`)).toBeUndefined();
      expect([...stores.keys()]).toEqual([worker.precache.cacheName]);
    });

    it("fails the install rather than precache an HTML fallback for a missing chunk", async () => {
      const stores = new Map<string, MemoryCache>();
      const worker = runWorker(stores);
      const assetNetwork = network;
      network = async (request) => {
        const url = typeof request === "string" ? request : request.url;
        return url.endsWith(".js")
          ? sameOrigin(
              new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
            )
          : assetNetwork(request);
      };
      await expect(worker.lifecycle("install")).rejects.toThrow("Precache request failed.");
      expect(
        await stores.get(worker.precache.cacheName)?.match(`${origin}/assets/main-AbCd1234.js`),
      ).toBeUndefined();
    });

    it("still drops the previous versions when carrying assets forward fails", async () => {
      const stores = new Map<string, MemoryCache>();
      const previous = new MemoryCache();
      previous.entries.set(`${origin}/assets/lazy-UvWx1234.js`, new Response("old lazy"));
      previous.match = async () => {
        throw new TypeError("cache unavailable");
      };
      stores.set("ryco-pwa-shell-0000000000000000", previous);
      const worker = runWorker(stores);
      await worker.lifecycle("install");
      await worker.lifecycle("activate");
      expect([...stores.keys()]).toEqual([worker.precache.cacheName]);
    });

    it("caches an allowlisted lazy chunk on first use and serves it from cache afterwards", async () => {
      const stores = new Map<string, MemoryCache>();
      const worker = runWorker(stores);
      await worker.lifecycle("install");
      const before = worker.fetchCalls.length;
      expect(await (await worker.get("/assets/lazy-UvWx1234.js"))!.text()).toBe(
        `network ${origin}/assets/lazy-UvWx1234.js`,
      );
      expect(await (await worker.get("/assets/lazy-UvWx1234.js"))!.text()).toBe(
        `network ${origin}/assets/lazy-UvWx1234.js`,
      );
      expect(worker.fetchCalls.length).toBe(before + 1);
      // Never anything outside the build's own asset list.
      expect(await worker.get("/api/nodes")).toBeUndefined();
      expect(await worker.get("/assets/unknown-Unkn1234.js")).toBeUndefined();
    });

    it("never keeps an HTML fallback under a fingerprinted URL", async () => {
      const stores = new Map<string, MemoryCache>();
      const worker = runWorker(stores);
      await worker.lifecycle("install");
      network = async () =>
        sameOrigin(new Response("<!doctype html>", { headers: { "content-type": "text/html" } }));
      await worker.get("/assets/lazy-UvWx1234.js");
      expect(
        await stores.get(worker.precache.cacheName)!.match(`${origin}/assets/lazy-UvWx1234.js`),
      ).toBeUndefined();
    });
  });

  describe("rendered worker request policy", () => {
    const origin = "https://ryco.example";
    const OFFLINE_BODY = "offline shell";
    const ASSET_BODY = "cached asset";

    /**
     * Runs the shipped worker source and reports what its fetch handler does
     * with one request: leave it to the network, answer a navigation with the
     * static boot document, or answer from the immutable shell cache.
     */
    async function classify(input: {
      readonly url: string;
      readonly method?: string;
      readonly mode?: string;
      readonly headers?: Readonly<Record<string, string>>;
    }): Promise<"navigation" | "network-only" | "precache"> {
      const handlers = new Map<string, (event: unknown) => void>();
      runInNewContext(
        renderHostedPwaServiceWorker(
          resolveHostedPwaPrecache({ base: "/", entries, offlineDocument }),
        ),
        {
          URL,
          self: {
            registration: { scope: `${origin}/` },
            location: { origin },
            addEventListener: (type: string, handler: (event: unknown) => void) =>
              handlers.set(type, handler),
          },
          caches: {
            open: async () => ({
              match: async (key: unknown) =>
                new Response(typeof key === "string" ? OFFLINE_BODY : ASSET_BODY),
            }),
          },
          fetch: () => Promise.reject(new Error("network must not be used")),
        },
      );
      let response: Promise<Response> | undefined;
      handlers.get("fetch")!({
        request: {
          method: input.method ?? "GET",
          mode: input.mode ?? "cors",
          headers: new Headers(input.headers ?? {}),
          url: input.url,
        },
        respondWith: (result: Promise<Response>) => {
          response = result;
        },
      });
      if (response === undefined) return "network-only";
      return (await (await response).text()) === OFFLINE_BODY ? "navigation" : "precache";
    }

    it("serves exact immutable allowlist matches from the shell cache", async () => {
      expect(await classify({ url: `${origin}/assets/main-AbCd1234.js` })).toBe("precache");
    });

    it("uses the static boot document only for same-origin document navigation", async () => {
      expect(await classify({ url: `${origin}/thread/1`, mode: "navigate" })).toBe("navigation");
    });

    it.each([
      ["unknown same-origin GET", { url: `${origin}/unknown.js` }],
      ["unversioned same-origin asset", { url: `${origin}/assets/unversioned.js` }],
      ["cross-origin GET", { url: "https://cdn.example/assets/main-AbCd1234.js" }],
      ["non-GET", { url: `${origin}/assets/main-AbCd1234.js`, method: "POST" }],
      ["non-GET navigation", { url: `${origin}/thread/1`, method: "POST", mode: "navigate" }],
      [
        "range request",
        { url: `${origin}/assets/main-AbCd1234.js`, headers: { range: "bytes=0-10" } },
      ],
      ["authentication API", { url: `${origin}/api/auth/session` }],
      ["generic API", { url: `${origin}/api/projects` }],
      ["attachment", { url: `${origin}/attachments/example` }],
      ["well-known", { url: `${origin}/.well-known/ryco` }],
      ["relay", { url: `${origin}/v1/relay/client` }],
      ["WebSocket", { url: "wss://ryco.example/v1/relay/client" }],
      ["event stream", { url: `${origin}/events`, headers: { accept: "text/event-stream" } }],
    ])("keeps %s network-only", async (_label, request) => {
      expect(await classify(request)).toBe("network-only");
    });

    it("checks dynamic exclusions before navigation fallback", async () => {
      for (const path of [
        "/api/auth/session",
        "/attachments/example",
        "/.well-known/ryco",
        "/v1/relay/client",
      ]) {
        expect(await classify({ url: `${origin}${path}`, mode: "navigate" }), path).toBe(
          "network-only",
        );
      }
      expect(
        await classify({
          url: `${origin}/thread/1`,
          mode: "navigate",
          headers: { accept: "text/event-stream" },
        }),
      ).toBe("network-only");
    });

    it("keeps native enrollment, grant, ticket, and device-management routes out of caches", async () => {
      expect(HOSTED_E2EE_NETWORK_ONLY_PATHS).toEqual([
        NATIVE_E2EE_CURRENT_DEVICE_PATH,
        NATIVE_E2EE_GRANT_KEYS_PATH,
        NATIVE_ACCOUNT_GRANT_RELAY_TICKET_PATH,
        ACCOUNT_E2EE_DEVICES_PATH,
      ]);
      // Listed explicitly in the worker, independent of the `/api` catch-all.
      expect(
        renderHostedPwaServiceWorker(
          resolveHostedPwaPrecache({ base: "/", entries, offlineDocument }),
        ),
      ).toContain(`const NETWORK_ONLY_PATHS = ${JSON.stringify(HOSTED_E2EE_NETWORK_ONLY_PATHS)};`);
      for (const path of [
        ...HOSTED_E2EE_NETWORK_ONLY_PATHS,
        `${ACCOUNT_E2EE_DEVICES_PATH}/enr_example/rename`,
        `${ACCOUNT_E2EE_DEVICES_PATH}/enr_example/revoke`,
      ]) {
        expect(await classify({ url: `${origin}${path}`, mode: "navigate" }), path).toBe(
          "network-only",
        );
        expect(await classify({ url: `${origin}${path}` }), path).toBe("network-only");
      }
    });
  });
});
