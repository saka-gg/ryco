import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  allowsTitleProbe,
  extractPageTitle,
  fetchPageTitle,
  makeTitleProbe,
  sameOriginRedirect,
  TITLE_MAX_BYTES,
  TITLE_TTL_FAIL_MS,
  TITLE_TTL_OK_MS,
} from "./localServerTitles.ts";

describe("extractPageTitle", () => {
  it("prefers the app's name over the document title, and decodes entities", () => {
    expect(
      extractPageTitle(
        '<head><meta property="og:title" content="Shop &amp; Co"><title>Ignored</title></head>',
      ),
    ).toBe("Shop & Co");
    expect(extractPageTitle("<title>\n  Vite +\tReact  </title>")).toBe("Vite + React");
    expect(extractPageTitle("<title>&#x1F680; Launch</title>")).toBe("🚀 Launch");
    expect(extractPageTitle("<p>no title</p>")).toBeNull();
  });

  it("removes bidi overrides and cuts long titles", () => {
    expect(extractPageTitle("<title>abc\u202eevil</title>")).toBe("abc evil");
    const long = extractPageTitle(`<title>${"x".repeat(300)}</title>`);
    expect(long).toHaveLength(200);
    expect(long?.endsWith("...")).toBe(true);
  });
});

describe("extractPageTitle on hostile pages", () => {
  // Each fills the 128 KiB prefix a probe reads; the parse runs on the node's event loop.
  const fill = (unit: string) => unit.repeat(Math.floor(TITLE_MAX_BYTES / unit.length));
  const pages = {
    "a title full of tag openers": `<title>${fill("<").slice(16)}</title>`,
    "unclosed meta tags": fill("<meta "),
    "unclosed title tags": fill("<title "),
    "a meta tag of unclosed content quotes": `<meta name="og:title" ${fill('content="')}>`,
    "a title that never closes": `<title>${fill("a<b ")}`,
  };

  for (const [name, html] of Object.entries(pages)) {
    it(`parses ${name} in linear time`, () => {
      const started = performance.now();
      extractPageTitle(html);
      expect(performance.now() - started).toBeLessThan(200);
    });
  }

  it("still reads a title that is long or carries tags", () => {
    expect(extractPageTitle(`<title>${"Dashboard ".repeat(500)}</title>`)).toHaveLength(200);
    expect(extractPageTitle("<TITLE data-x='1'>My <b>App</b></TITLE>")).toBe("My App");
    expect(extractPageTitle("<title>&#xD800;Lone&#x1F680;</title>")).toBe("&#xD800;Lone🚀");
  });

  it("drops invisible characters and keeps a surrogate pair whole at the cut", () => {
    expect(extractPageTitle("<title>a\u200bb\ufeffc\u{e0041}d</title>")).toBe("abcd");
    const cut = extractPageTitle(`<title>${"x".repeat(196)}🚀🚀🚀</title>`);
    expect(cut).toBe(`${"x".repeat(196)}...`);
  });
});

describe("sameOriginRedirect", () => {
  it("follows a redirect only within the same loopback address and port", () => {
    expect(sameOriginRedirect("/app/?x=1", "127.0.0.1", 5173)).toBe("/app/?x=1");
    expect(sameOriginRedirect("http://localhost:5173/login", "127.0.0.1", 5173)).toBe("/login");
    expect(sameOriginRedirect("http://127.0.0.1:5174/", "127.0.0.1", 5173)).toBeNull();
    expect(sameOriginRedirect("https://example.com/", "127.0.0.1", 5173)).toBeNull();
    expect(sameOriginRedirect("http://user:pw@127.0.0.1:5173/", "127.0.0.1", 5173)).toBeNull();
    expect(sameOriginRedirect("http://[::1]:5173/a", "::1", 5173)).toBe("/a");
    expect(sameOriginRedirect(undefined, "127.0.0.1", 5173)).toBeNull();
  });
});

describe("fetchPageTitle", () => {
  let server: Server | null = null;
  const requests: Array<{ readonly url: string; readonly cookie: string | undefined }> = [];

  afterEach(async () => {
    requests.length = 0;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    server = createServer((request, response) => {
      requests.push({ url: request.url ?? "", cookie: request.headers.cookie });
      handler!(request, response);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  };

  it("reads the title of an HTML page after a same-origin redirect, without credentials", async () => {
    const port = await serve((request, response) => {
      if (request.url === "/") {
        response.writeHead(302, { location: "/app/" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><head><title>Dashboard</title></head></html>");
    });
    await expect(fetchPageTitle("127.0.0.1", port)).resolves.toBe("Dashboard");
    expect(requests).toEqual([
      { url: "/", cookie: undefined },
      { url: "/app/", cookie: undefined },
    ]);
  });

  it("does not follow a redirect to another port or host", async () => {
    const port = await serve((_request, response) => {
      response.writeHead(302, { location: "http://127.0.0.1:1/" });
      response.end();
    });
    await expect(fetchPageTitle("127.0.0.1", port)).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("ignores a response that is not HTML", async () => {
    const port = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"title":"<title>nope</title>"}');
    });
    await expect(fetchPageTitle("127.0.0.1", port)).resolves.toBeNull();
  });

  it("reads at most the prefix", async () => {
    const port = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.write(" ".repeat(TITLE_MAX_BYTES));
      response.end("<title>Too late</title>");
    });
    await expect(fetchPageTitle("127.0.0.1", port)).resolves.toBeNull();
  });

  it("gives up on a server that never answers", async () => {
    const port = await serve(() => undefined);
    const started = Date.now();
    await expect(fetchPageTitle("127.0.0.1", port)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("makeTitleProbe", () => {
  it("caches a title for 30 s and a miss for 10 s, one probe per server at a time", async () => {
    let now = 0;
    const fetched: Array<string> = [];
    let next: string | null = "First";
    const probe = makeTitleProbe({
      now: () => now,
      fetch: async (address, port) => {
        fetched.push(`${address}:${port}`);
        return next;
      },
    });
    const target = { host: "*", port: 5173 };
    const [a, b] = await Promise.all([
      probe.title("1:1:5173", target),
      probe.title("1:1:5173", target),
    ]);
    expect([a, b]).toEqual(["First", "First"]);
    expect(fetched).toEqual(["127.0.0.1:5173"]);
    next = null;
    now = TITLE_TTL_OK_MS - 1;
    await expect(probe.title("1:1:5173", target)).resolves.toBe("First");
    now = TITLE_TTL_OK_MS + 1;
    await expect(probe.title("1:1:5173", target)).resolves.toBeNull();
    next = "Second";
    now += TITLE_TTL_FAIL_MS - 1;
    await expect(probe.title("1:1:5173", target)).resolves.toBeNull();
    now += 2;
    await expect(probe.title("1:1:5173", target)).resolves.toBe("Second");
    // An IPv6-only listener is reached over ::1.
    await probe.title("2:2:3000", { host: "[::1]", port: 3000 });
    expect(fetched.at(-1)).toBe("::1:3000");
  });

  it("does not let a probe that finishes after clear refill the cache", async () => {
    let finish: (title: string | null) => void = () => undefined;
    let fetches = 0;
    const probe = makeTitleProbe({
      fetch: () => {
        fetches += 1;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const target = { host: "127.0.0.1", port: 5173 };
    const late = probe.title("1:1:5173", target);
    probe.clear();
    finish("Stale");
    await expect(late).resolves.toBe("Stale");
    void probe.title("1:1:5173", target);
    expect(fetches).toBe(2);
  });

  it("never probes a database", () => {
    expect(allowsTitleProbe("postgres")).toBe(false);
    expect(allowsTitleProbe("node")).toBe(true);
    expect(allowsTitleProbe(null)).toBe(true);
  });
});
