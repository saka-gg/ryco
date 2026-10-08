// @effect-diagnostics nodeBuiltinImport:off - plain local servers stand in for LAN services.
import * as NodeDgram from "node:dgram";
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  defaultHtmlRenderTheme,
  HTML_RENDER_MAX_IMAGE_BYTES,
  HTML_RENDER_MEASURE_FONTS,
  HTML_RENDER_MEASURE_WIDTHS,
  HTML_RENDER_THEME_STYLE_ID,
  readHtmlRenderMetadata,
} from "@ryco/shared/htmlRender";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import sharp from "sharp";

import type { ThemeAppearance } from "@ryco/shared/themePalettes";

import { HtmlPreviewError, HtmlRender, HtmlRenderImagesNotFoundError } from "./HtmlRender.ts";
import {
  HTML_PREVIEW_NO_SANDBOX_ENV,
  HtmlRenderLayer,
  previewSandboxDisabled,
  type HtmlRenderOptions,
} from "./HtmlRenderLive.ts";
import {
  PreviewBrowser,
  PreviewBrowserInstallingError,
  PreviewBrowserUnsupportedError,
  type PreviewBrowserShape,
} from "./PreviewBrowser.ts";

// Real-browser tests run only when this names a chrome-headless-shell, for
// example one Ryco installed under <baseDir>/tools/chrome-headless-shell.
const TEST_BROWSER_ENV = "RYCO_TEST_HEADLESS_SHELL";
const liveBrowser = process.env[TEST_BROWSER_ENV];
const posix = process.platform !== "win32";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const fakeBrowser = (browser: Partial<PreviewBrowserShape>) =>
  Layer.succeed(
    PreviewBrowser,
    PreviewBrowser.of({
      executable: browser.executable ?? Effect.die("This test must not install a browser."),
      installed: browser.installed ?? Effect.succeedNone,
    }),
  );

const htmlRenderLayer = (
  browser: Partial<PreviewBrowserShape> = {},
  options: HtmlRenderOptions = { env: {}, isRoot: false },
) =>
  HtmlRenderLayer(options).pipe(
    Layer.provide(fakeBrowser(browser)),
    Layer.provideMerge(NodeServices.layer),
  );

/** A stand-in browser executable: a shell script that does what a broken host's browser does. */
const fakeExecutable = (script: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-fake-browser-" });
    const executable = path.join(directory, "chrome-headless-shell");
    yield* fs.writeFileString(executable, `#!/bin/sh\n${script}\n`);
    yield* fs.chmod(executable, 0o755);
    return executable;
  }).pipe(Effect.provide(NodeServices.layer));

describe("HtmlRender.prepare", () => {
  it.effect("injects the theme bootstrap first, then inlines images from the allowed roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-html-render-" });
      const png = path.join(root, "shot.png");
      yield* fs.writeFile(png, PNG_BYTES);

      const prepared = yield* htmlRender.prepare({
        html: `<!doctype html><html><head><title>Shots</title></head><body><img src="${png}"></body></html>`,
        imageRoots: [root],
      });

      const style = `<style id="${HTML_RENDER_THEME_STYLE_ID}">`;
      expect(prepared.indexOf("<head>")).toBeLessThan(prepared.indexOf(style));
      expect(prepared.indexOf(style)).toBeLessThan(prepared.indexOf("<title>"));
      expect(prepared).toContain(
        `<img src="data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}">`,
      );
      expect(prepared).not.toContain(root);
    }).pipe(Effect.scoped, Effect.provide(htmlRenderLayer())),
  );

  it.effect("refuses a page with an image it cannot read", () =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender;
      const error = yield* htmlRender
        .prepare({ html: '<img src="/nonexistent/ryco-missing.png">', imageRoots: ["/tmp"] })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(HtmlRenderImagesNotFoundError);
      expect(error.message).toBe(
        "These local images could not be read: /nonexistent/ryco-missing.png (outside this thread's workspace and the system temp directory). Use absolute paths to image files inside this thread's workspace or the system temp directory, or remove them.",
      );
    }).pipe(Effect.provide(htmlRenderLayer())),
  );

  it.effect.skipIf(!posix)("says why each image was refused, so the agent can fix it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-html-render-" });
      const original = path.join(root, "original.png");
      yield* fs.writeFile(original, PNG_BYTES);
      // Package managers and build tools hard-link files into workspaces.
      const linked = path.join(root, "linked.png");
      yield* fs.link(original, linked);
      const absent = path.join(root, "absent.png");

      const error = yield* htmlRender
        .prepare({ html: `<img src="${linked}"><img src="${absent}">`, imageRoots: [root] })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "HtmlRenderImagesNotFoundError",
        paths: [linked, absent],
        reasons: ["hard-link", "not-found"],
      });
      expect(error.message).toContain(
        `${linked} (a hard link; hard-linked files are refused, so copy it into the temp directory first), ${absent} (not found).`,
      );
    }).pipe(Effect.scoped, Effect.provide(htmlRenderLayer())),
  );
});

/** What a stand-in browser that speaks just enough CDP to measure a page does. */
interface FakeCdpBrowser {
  /** The content height every load measures. */
  readonly contentHeight: number;
  /** Themes whose screenshots never come, as a page busy after load holds them back. */
  readonly stuckScreenshots?: ReadonlyArray<ThemeAppearance>;
  /** Themes whose loads never finish. */
  readonly stuckLoads?: ReadonlyArray<ThemeAppearance>;
}

/** A screenshot the stand-in browser was asked for. */
interface FakeScreenshotRequest {
  readonly colorScheme: ThemeAppearance;
  readonly width: number;
  readonly clip: { readonly width: number; readonly height: number };
}

// Answers each command over the debugging pipe like the headless shell, with
// a fixed height for every load and one PNG for every screenshot, and logs
// each screenshot request.
const FAKE_CDP_BROWSER = String.raw`
const fs = require("node:fs");
const config = JSON.parse(process.argv[2]);
const out = fs.createWriteStream(null, { fd: 4 });
const sessions = new Map();
let targets = 0;
const send = (message) => out.write(JSON.stringify(message) + "\0");
const reply = (command, result) => send({ id: command.id, result, ...(command.sessionId ? { sessionId: command.sessionId } : {}) });
const handle = (command) => {
  const page = sessions.get(command.sessionId);
  switch (command.method) {
    case "Target.createTarget":
      return reply(command, { targetId: "target-" + ++targets });
    case "Target.attachToTarget": {
      const sessionId = "session-" + command.params.targetId;
      sessions.set(sessionId, { width: 0, colorScheme: "light" });
      return reply(command, { sessionId });
    }
    case "Emulation.setDeviceMetricsOverride":
      page.width = command.params.width;
      return reply(command, {});
    case "Emulation.setEmulatedMedia":
      page.colorScheme = command.params.features[0].value;
      return reply(command, {});
    case "Page.navigate":
      reply(command, { frameId: "frame" });
      if (!config.stuckLoads.includes(page.colorScheme)) {
        send({ method: "Page.loadEventFired", params: { timestamp: 0 }, sessionId: command.sessionId });
      }
      return;
    case "Runtime.evaluate":
      return reply(command, command.params.returnByValue
        ? { result: { type: "number", value: config.contentHeight } }
        : { result: { type: "boolean", value: true } });
    case "Page.captureScreenshot":
      fs.appendFileSync(config.log, JSON.stringify({ colorScheme: page.colorScheme, width: page.width, clip: command.params.clip }) + "\n");
      return config.stuckScreenshots.includes(page.colorScheme) ? undefined : reply(command, { data: config.png });
    default:
      return reply(command, {});
  }
};
let buffered = "";
fs.createReadStream(null, { fd: 3, encoding: "utf8" })
  .on("data", (text) => {
    buffered += text;
    for (let end = buffered.indexOf("\0"); end !== -1; end = buffered.indexOf("\0")) {
      handle(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  })
  .on("end", () => process.exit(0));
`;

/** A stand-in browser for `measure`, and the screenshot requests it got. */
const fakeCdpBrowser = (browser: FakeCdpBrowser) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-fake-cdp-" });
    const script = path.join(directory, "browser.cjs");
    const log = path.join(directory, "screenshots.log");
    yield* fs.writeFileString(script, FAKE_CDP_BROWSER);
    yield* fs.writeFileString(log, "");
    const png = yield* Effect.promise(() =>
      sharp({
        create: { width: 760, height: 475, channels: 3, background: "#3060d0" },
      })
        .png()
        .toBuffer(),
    );
    const config = {
      contentHeight: browser.contentHeight,
      stuckScreenshots: browser.stuckScreenshots ?? [],
      stuckLoads: browser.stuckLoads ?? [],
      png: png.toString("base64"),
      log,
    };
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    const executable = yield* fakeExecutable(
      `exec ${quote(process.execPath)} ${quote(script)} ${quote(JSON.stringify(config))}`,
    );
    const screenshots = fs.readFileString(log).pipe(
      Effect.map((text) =>
        text
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as FakeScreenshotRequest)
          .toSorted((left, right) => left.colorScheme.localeCompare(right.colorScheme)),
      ),
    );
    return { executable, screenshots };
  }).pipe(Effect.provide(NodeServices.layer));

/** Measures `html` in a stand-in browser; how long it took, and what it found. */
const measureIn = (executable: string, html = "<p>x</p>") =>
  Effect.gen(function* () {
    const htmlRender = yield* HtmlRender;
    const started = Date.now();
    const measured = yield* htmlRender.measure(html);
    return { measured, elapsed: Date.now() - started };
  }).pipe(
    Effect.provide(
      htmlRenderLayer(
        { installed: Effect.succeed(Option.some(executable)) },
        { env: {}, isRoot: false, measureTimeout: "5 seconds" },
      ),
    ),
  );

describe.skipIf(!posix)("HtmlRender.measure in a stand-in browser", () => {
  const measuredAt = (height: number) => HTML_RENDER_MEASURE_WIDTHS.map((width) => [width, height]);

  it.live(
    "measures every width and takes a thumbnail of the page's top in each default theme",
    () =>
      Effect.gen(function* () {
        const browser = yield* fakeCdpBrowser({ contentHeight: 21 });

        const { measured } = yield* measureIn(browser.executable);

        expect(measured?.heights).toEqual(measuredAt(21));
        expect(measured?.thumbnails?.dark).toMatch(/^data:image\/webp;base64,/);
        expect(measured?.thumbnails?.light).toMatch(/^data:image\/webp;base64,/);
        // At the reply column's width, and always the thumbnail's whole shape,
        // so a card never crops the sides of a page shorter than that.
        const clip = { x: 0, y: 0, width: 760, height: 475, scale: 1 };
        expect(yield* browser.screenshots).toEqual([
          { colorScheme: "dark", width: 760, clip },
          { colorScheme: "light", width: 760, clip },
        ]);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "keeps the heights, promptly, when a screenshot never comes",
    () =>
      Effect.gen(function* () {
        const browser = yield* fakeCdpBrowser({ contentHeight: 300, stuckScreenshots: ["dark"] });

        const { measured, elapsed } = yield* measureIn(browser.executable);

        expect(measured?.heights).toEqual(measuredAt(300));
        expect(measured?.thumbnails).toEqual({ light: expect.stringMatching(/^data:image\/webp/) });
        // The heights never wait on a screenshot; the thumbnails get a moment after them.
        expect(elapsed).toBeLessThan(3_000);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "keeps the heights and the dark thumbnail, promptly, when the light load never finishes",
    () =>
      Effect.gen(function* () {
        const browser = yield* fakeCdpBrowser({ contentHeight: 300, stuckLoads: ["light"] });

        const { measured, elapsed } = yield* measureIn(browser.executable);

        expect(measured?.heights).toEqual(measuredAt(300));
        expect(measured?.thumbnails).toEqual({ dark: expect.stringMatching(/^data:image\/webp/) });
        expect(elapsed).toBeLessThan(3_000);
      }).pipe(Effect.scoped),
    20_000,
  );
});

describe("HtmlRender.measure", () => {
  it.effect("returns nothing, without installing, when the browser is not installed", () =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender;
      expect(yield* htmlRender.measure("<p>x</p>")).toBeUndefined();
    }).pipe(Effect.provide(htmlRenderLayer())),
  );

  it.effect("returns nothing when Chrome would have no sandbox as root", () =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender;
      expect(yield* htmlRender.measure("<p>x</p>")).toBeUndefined();
    }).pipe(
      Effect.provide(
        htmlRenderLayer(
          { installed: Effect.die("Measuring as root must not look for the browser.") },
          { env: {}, isRoot: true },
        ),
      ),
    ),
  );

  it.live.skipIf(!posix)("never fails, even when the browser cannot start or hangs", () =>
    Effect.gen(function* () {
      for (const script of ['echo "boom" >&2; exit 3', "exec sleep 30"]) {
        const executable = yield* fakeExecutable(script);
        const started = Date.now();
        const heights = yield* Effect.gen(function* () {
          const htmlRender = yield* HtmlRender;
          return yield* htmlRender.measure("<p>x</p>");
        }).pipe(
          Effect.provide(
            htmlRenderLayer(
              { installed: Effect.succeed(Option.some(executable)) },
              { env: {}, isRoot: false, measureTimeout: "1 second" },
            ),
          ),
        );
        expect(heights).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(5_000);
      }
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(!posix)("answers within its bound while a stopped browser is cleaned up", () =>
    Effect.gen(function* () {
      // Ignores SIGTERM, so stopping it takes the two seconds before SIGKILL.
      const executable = yield* fakeExecutable("trap '' TERM; exec sleep 30");
      const elapsed = yield* Effect.gen(function* () {
        const htmlRender = yield* HtmlRender;
        const started = Date.now();
        expect(yield* htmlRender.measure("<p>x</p>")).toBeUndefined();
        return Date.now() - started;
      }).pipe(
        Effect.provide(
          htmlRenderLayer(
            { installed: Effect.succeed(Option.some(executable)) },
            { env: {}, isRoot: false, measureTimeout: "1 second" },
          ),
        ),
      );
      expect(elapsed).toBeGreaterThanOrEqual(950);
      expect(elapsed).toBeLessThan(1_800);
    }).pipe(Effect.scoped),
  );
});

describe("HtmlRender.preview", () => {
  it.effect("refuses to run Chrome without its sandbox as root unless the operator opted out", () =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender;
      const error = yield* htmlRender
        .preview({ html: "<p>x</p>", imageRoots: [] })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(HtmlPreviewError);
      expect(error).toMatchObject({ retryable: false });
      expect(error.message).toContain(`${HTML_PREVIEW_NO_SANDBOX_ENV}=1`);
    }).pipe(Effect.provide(htmlRenderLayer({}, { env: {}, isRoot: true }))),
  );

  it.effect.each([
    {
      name: "an install in progress",
      error: new PreviewBrowserInstallingError({
        downloadedBytes: 37_000_000,
        totalBytes: 99_221_129,
        unpacking: false,
      }),
      retryable: true,
      message:
        "Ryco is installing its HTML preview browser (37 of 99 MB downloaded). Call ryco_html_preview again in a minute.",
    },
    {
      name: "an unsupported host",
      error: new PreviewBrowserUnsupportedError({ platform: "freebsd", arch: "x64" }),
      retryable: false,
      message:
        "HTML previews are not available on freebsd-x64: Chrome for Testing has no headless shell for it. ryco_html_render still works without a preview; pass it height 2000, since an unmeasured frame shrinks to the page but never grows past height.",
    },
  ])("tells the agent about $name", (testCase) =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender;
      const error = yield* htmlRender
        .preview({ html: "<p>x</p>", imageRoots: [] })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "HtmlPreviewError", retryable: testCase.retryable });
      expect(error.message).toBe(testCase.message);
    }).pipe(Effect.provide(htmlRenderLayer({ executable: Effect.fail(testCase.error) }))),
  );

  it.effect("fails on an oversized image before starting the browser", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-html-render-" });
      const huge = path.join(root, "huge.png");
      yield* fs.writeFile(huge, PNG_BYTES);
      yield* fs.truncate(huge, HTML_RENDER_MAX_IMAGE_BYTES + 1);
      const error = yield* htmlRender
        .preview({ html: `<img src="${huge}">`, imageRoots: [root] })
        .pipe(Effect.flip);
      expect(error._tag).toBe("HtmlRenderImageTooLargeError");
    }).pipe(Effect.scoped, Effect.provide(htmlRenderLayer())),
  );
});

describe.skipIf(!posix)("HtmlRender.preview with a browser that cannot start", () => {
  it.live.each([
    {
      name: "a missing system library",
      script:
        'echo "chrome-headless-shell: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory" >&2; exit 127',
      expected: "the system library libnss3.so is missing",
      retryable: false,
    },
    {
      name: "a host without a usable sandbox",
      script:
        'echo "[0101/000000.000000:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! Update your kernel" >&2; exit 1',
      expected: `set ${HTML_PREVIEW_NO_SANDBOX_ENV}=1`,
      retryable: false,
    },
    {
      name: "an unexplained exit",
      script: 'echo "first line" >&2; echo "Trace/breakpoint trap" >&2; exit 5',
      expected: "exited unexpectedly (Trace/breakpoint trap)",
      retryable: true,
    },
  ])("diagnoses a browser that dies at startup: $name", (testCase) =>
    Effect.gen(function* () {
      const executable = yield* fakeExecutable(testCase.script);
      const error = yield* Effect.gen(function* () {
        const htmlRender = yield* HtmlRender;
        return yield* htmlRender.preview({ html: "<p>x</p>", imageRoots: [] }).pipe(Effect.flip);
      }).pipe(Effect.provide(htmlRenderLayer({ executable: Effect.succeed(executable) })));
      expect(error).toMatchObject({ _tag: "HtmlPreviewError", retryable: testCase.retryable });
      expect(error.message).toContain(testCase.expected);
    }).pipe(Effect.scoped),
  );
});

it("reads the operator's sandbox opt-out", () => {
  expect(previewSandboxDisabled({})).toBe(false);
  expect(previewSandboxDisabled({ [HTML_PREVIEW_NO_SANDBOX_ENV]: "0" })).toBe(false);
  expect(previewSandboxDisabled({ [HTML_PREVIEW_NO_SANDBOX_ENV]: "1" })).toBe(true);
  expect(previewSandboxDisabled({ [HTML_PREVIEW_NO_SANDBOX_ENV]: " TRUE " })).toBe(true);
});

// Everything below drives a real headless shell.
const liveLayer = () =>
  htmlRenderLayer({
    executable: Effect.succeed(liveBrowser ?? ""),
    installed: Effect.succeed(Option.fromUndefinedOr(liveBrowser)),
  });

/** The sRGB color of one pixel of a PNG screenshot, as `#rrggbb`. */
const pixel = (png: string, x: number, y: number) =>
  Effect.promise(async () => {
    const { data, info } = await sharp(Buffer.from(png, "base64"))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const at = (y * info.width + x) * info.channels;
    return `#${[data[at]!, data[at + 1]!, data[at + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  });

/** Whether one pixel of an image is within a lossy encoding's reach of `#rrggbb`. */
const nearPixel = (image: string, x: number, y: number, expected: string) =>
  Effect.map(pixel(image, x, y), (actual) =>
    [1, 3, 5].every(
      (at) =>
        Math.abs(
          Number.parseInt(actual.slice(at, at + 2), 16) -
            Number.parseInt(expected.slice(at, at + 2), 16),
        ) <= 12,
    ),
  );

describe.skipIf(liveBrowser === undefined)("HtmlRender with a real browser", () => {
  it.live(
    "screenshots the page in the requested theme with every console level",
    () =>
      Effect.gen(function* () {
        const htmlRender = yield* HtmlRender;
        for (const appearance of ["dark", "light"] as const) {
          const preview = yield* htmlRender.preview({
            html: [
              '<!doctype html><html><head></head><body><div style="height:300px"></div>',
              '<img src="/nonexistent/ryco-missing.png" hidden>',
              "<script>",
              "const root = getComputedStyle(document.documentElement);",
              'console.log("ready", 3); console.info(root.getPropertyValue("--font-sans"));',
              'console.warn(root.getPropertyValue("--background")); console.error("boom");',
              'alert("dialogs never stall a preview");',
              "</script>",
              '<script>throw new Error("broken chart");</script>',
              "</body></html>",
            ].join(""),
            imageRoots: [],
            width: 400,
            appearance,
          });

          const png = Buffer.from(preview.png, "base64");
          expect(png.readUInt32BE(0)).toBe(0x89504e47);
          expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([400, 300]);
          expect(preview).toMatchObject({
            width: 400,
            contentHeight: 300,
            capturedHeight: 300,
            missingImages: [{ path: "/nonexistent/ryco-missing.png", reason: "outside-roots" }],
          });
          const background = defaultHtmlRenderTheme(appearance).variables["--background"];
          // The page paints the theme's own background, not the browser's default white.
          expect(yield* pixel(preview.png, 10, 10)).toBe(background);
          expect(preview.consoleMessages).toEqual(
            expect.arrayContaining([
              { level: "log", text: "ready 3" },
              { level: "info", text: HTML_RENDER_MEASURE_FONTS.sans },
              { level: "warning", text: background },
              { level: "error", text: "boom" },
              {
                level: "error",
                text: expect.stringMatching(/^Error: broken chart\n\s+at page\.html:1:\d+$/),
              },
            ]),
          );
        }
      }).pipe(Effect.provide(liveLayer())),
    30_000,
  );

  it.live(
    "keeps every local file but the page itself out of the browser",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const htmlRender = yield* HtmlRender;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-html-files-" });
        const secret = path.join(directory, "secret.js");
        yield* fs.writeFileString(secret, 'window.secret = "abc123";');
        const secretUrl = NodeURL.pathToFileURL(secret).href;

        const preview = yield* htmlRender.preview({
          html: [
            `<script src="${secretUrl}"></script>`,
            `<iframe src="${secretUrl}" onload="console.log('frame loaded')"></iframe>`,
            '<script>addEventListener("load", () => console.log("secret:", window.secret ?? "none"));</script>',
          ].join(""),
          imageRoots: [],
        });

        const texts = preview.consoleMessages.map((message) => message.text);
        expect(texts).toContain("secret: none");
        expect(texts.join(" ")).not.toContain("abc123");
      }).pipe(Effect.scoped, Effect.provide(liveLayer())),
    30_000,
  );

  it.live(
    "keeps the page off this machine's local network and on its own page",
    () =>
      Effect.gen(function* () {
        // The page's connections go through a proxy that only reaches public
        // addresses, and WebRTC is gone. Each line below is a way out that
        // Chrome's own Local Network Access does not stop on its own.
        const requests: Array<string> = [];
        const server = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server>((resume) => {
            const listening = NodeHttp.createServer((request, response) => {
              requests.push(`${request.url} ${request.headers["sec-purpose"] ?? ""}`);
              response.end("<p>LOCAL</p>");
            });
            listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
          }),
          (listening) =>
            Effect.callback<void>((resume) => {
              listening.close(() => resume(Effect.void));
            }),
        );
        const datagrams: Array<string> = [];
        const udp = yield* Effect.acquireRelease(
          Effect.callback<NodeDgram.Socket>((resume) => {
            const socket = NodeDgram.createSocket("udp4");
            socket.on("message", (message) => datagrams.push(message.toString("hex")));
            socket.bind(0, "127.0.0.1", () => resume(Effect.succeed(socket)));
          }),
          (socket) =>
            Effect.callback<void>((resume) => {
              socket.close(() => resume(Effect.void));
            }),
        );
        const address = server.address();
        const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        const stun = `stun:127.0.0.1:${udp.address().port}`;
        const preview = yield* Effect.gen(function* () {
          const htmlRender = yield* HtmlRender;
          return yield* htmlRender.preview({
            html: [
              '<div style="height:120px">pinned</div>',
              `<img src="${origin}/x.png"><iframe src="${origin}/"></iframe>`,
              `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${origin}/prefetch"]}]}</script>`,
              `<script>fetch("${origin}/").catch(() => {}); new WebSocket("ws${origin.slice(4)}/socket");`,
              `try { const peer = new RTCPeerConnection({ iceServers: [{ urls: "${stun}" }] });`,
              `peer.createDataChannel("x"); peer.createOffer().then((offer) => peer.setLocalDescription(offer));`,
              `} catch {}`,
              `window.open("${origin}/popup"); location.href = "${origin}/navigate";</script>`,
            ].join(""),
            imageRoots: [],
          });
        }).pipe(Effect.provide(liveLayer()));
        yield* Effect.sleep("500 millis");
        expect(requests).toEqual([]);
        expect(datagrams).toEqual([]);
        // The main frame stayed on the page instead of showing an error page.
        expect(preview.contentHeight).toBeGreaterThan(120);
        expect(preview.contentHeight).toBeLessThan(800);
        expect(preview.consoleMessages[0]?.text).toContain(
          `The page tried to navigate to ${origin}/navigate.`,
        );
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "keeps a page that tries to navigate away whole, says so, and measures it",
    () =>
      Effect.gen(function* () {
        const htmlRender = yield* HtmlRender;
        // A navigation that started would stop the parser; one started in
        // <head> would leave a page Chrome never renders.
        for (const [name, html] of [
          [
            "a script in <head>",
            '<!doctype html><html><head><script>location.href = "https://example.com/";</script></head><body><div style="height:640px"></div></body></html>',
          ],
          [
            "a link clicked mid-body",
            '<!doctype html><div style="height:20px"></div><a id="out" href="https://example.com/">out</a><script>document.getElementById("out").click();</script><div style="height:620px"></div>',
          ],
          [
            "a meta refresh",
            '<!doctype html><meta http-equiv="refresh" content="0;url=https://example.com/"><div style="height:640px"></div>',
          ],
        ] as const) {
          const started = Date.now();
          const preview = yield* htmlRender.preview({ html, imageRoots: [], width: 400 });
          expect(Date.now() - started, name).toBeLessThan(5_000);
          expect(preview.contentHeight, name).toBeGreaterThanOrEqual(640);
          expect(preview.consoleMessages[0], name).toEqual({
            level: "warning",
            text: expect.stringContaining("The page tried to navigate to https://example.com/."),
          });
          const measured = yield* htmlRender.measure(
            yield* htmlRender.prepare({ html, imageRoots: [] }),
          );
          expect(measured?.heights.length, name).toBe(HTML_RENDER_MEASURE_WIDTHS.length);
          expect(
            measured?.heights.every(([, height]) => height >= 640),
            name,
          ).toBe(true);
        }
      }).pipe(Effect.provide(liveLayer())),
    60_000,
  );

  it.live(
    "throws for storage and cookies as readers' sandbox does, and warns about plain http",
    () =>
      Effect.gen(function* () {
        const htmlRender = yield* HtmlRender;
        const sandboxed = "The document is sandboxed and lacks the 'allow-same-origin' flag.";
        const preview = yield* htmlRender.preview({
          html: [
            "<script>",
            'for (const [name, use] of [["localStorage", () => localStorage.setItem("a", "1")], ["sessionStorage", () => sessionStorage.length], ["cookie", () => { document.cookie = "a=b"; }], ["indexedDB", () => indexedDB.open("db")]]) {',
            '  try { use(); console.log(name, "works"); } catch (error) { console.log(name, `${error.name}: ${error.message}`); }',
            "}",
            "</script>",
            // Plain http, twice from one origin; loopback, which the proxy refuses.
            '<script src="http://127.0.0.1:8081/chart.js"></script><img src="http://127.0.0.1:8081/a.png">',
            "<script>localStorage.getItem('state');</script>",
          ].join(""),
          imageRoots: [],
        });

        const texts = preview.consoleMessages.map((message) => message.text);
        expect(texts).toEqual(
          expect.arrayContaining([
            `localStorage SecurityError: Failed to read the 'localStorage' property from 'Window': ${sandboxed}`,
            `sessionStorage SecurityError: Failed to read the 'sessionStorage' property from 'Window': ${sandboxed}`,
            `cookie SecurityError: Failed to set the 'cookie' property on 'Document': ${sandboxed}`,
            "indexedDB SecurityError: Failed to execute 'open' on 'IDBFactory': access to the Indexed Database API is denied in this context.",
            "The page loads http://127.0.0.1:8081/chart.js over plain http; readers on HTTPS clients block it. Use https.",
          ]),
        );
        expect(texts.filter((text) => text.includes("over plain http"))).toHaveLength(1);
        // An uncaught use stops the script for readers, and the agent sees it.
        expect(preview.consoleMessages).toContainEqual({
          level: "error",
          text: expect.stringContaining(
            "SecurityError: Failed to read the 'localStorage' property from 'Window'",
          ),
        });
      }).pipe(Effect.provide(liveLayer())),
    30_000,
  );

  it.live(
    "fails clearly when a history traversal takes the page away",
    () =>
      Effect.gen(function* () {
        const htmlRender = yield* HtmlRender;
        const error = yield* htmlRender
          .preview({
            html: '<div style="height:200px"></div><script>history.back();</script>',
            imageRoots: [],
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "HtmlPreviewError", retryable: false });
        expect(error.message).toContain("The page navigated away from itself to about:blank");
      }).pipe(Effect.provide(liveLayer())),
    30_000,
  );

  it.live(
    "counts console output past its limits instead of reading it",
    () =>
      Effect.gen(function* () {
        const htmlRender = yield* HtmlRender;
        const preview = yield* htmlRender.preview({
          html: [
            '<script>const big = "x".repeat(20 * 1024 * 1024);',
            'console.log(big); console.error(big, big); console.log("small");',
            'for (let i = 0; i < 25; i++) console.info("line " + i);</script>',
            "<script>throw new Error(big);</script>",
          ].join(""),
          imageRoots: [],
        });
        // The three huge messages and the huge exception are dropped unread,
        // and nothing past the first twenty messages is parsed at all.
        expect(preview.consoleMessages).toEqual([
          { level: "log", text: "small" },
          ...Array.from({ length: 19 }, (_, index) => ({ level: "info", text: `line ${index}` })),
          { level: "warning", text: "9 more console messages were omitted." },
        ]);
      }).pipe(Effect.provide(liveLayer())),
    30_000,
  );

  it.live(
    "measures within its bound while the page floods its console",
    () =>
      Effect.gen(function* () {
        const htmlRender = yield* HtmlRender;
        const flood = (lines: number) =>
          htmlRender.prepare({
            html: `<div style="height:300px"></div><script>const line = "x".repeat(2_000_000); for (let i = 0; i < ${lines}; i++) console.log(line);</script>`,
            imageRoots: [],
          });
        const expected = HTML_RENDER_MEASURE_WIDTHS.map((width) => [width, 300]);
        // Measuring never listens to the console, so a flood costs only the page's own time.
        let started = Date.now();
        expect((yield* htmlRender.measure(yield* flood(100)))?.heights).toEqual(expected);
        expect(Date.now() - started).toBeLessThan(6_000);
        // This page alone runs past the bound; the answer still comes on time.
        const longFlood = yield* flood(1_500);
        started = Date.now();
        const measured = yield* htmlRender.measure(longFlood);
        expect(Date.now() - started).toBeLessThan(6_500);
        expect(
          measured === undefined || measured.heights.every(([, height]) => height === 300),
        ).toBe(true);
      }).pipe(Effect.provide(liveLayer())),
    60_000,
  );

  it.live(
    "takes a thumbnail of the page's top in each default theme while it measures",
    () =>
      Effect.gen(function* () {
        const htmlRender = yield* HtmlRender;
        const prepared = yield* htmlRender.prepare({
          html: '<!doctype html><html><head></head><body><div style="position:absolute;inset:0 0 auto 0;height:40px;background:#d03030"></div><div style="height:1200px"></div></body></html>',
          imageRoots: [],
        });

        const measured = yield* htmlRender.measure(prepared);

        expect(measured?.heights).toEqual(HTML_RENDER_MEASURE_WIDTHS.map((width) => [width, 1200]));
        for (const appearance of ["dark", "light"] as const) {
          const url = measured?.thumbnails?.[appearance];
          expect(url, appearance).toMatch(/^data:image\/webp;base64,/);
          // Clients accept it as stored.
          expect(
            readHtmlRenderMetadata({ title: "t", height: 80, thumbnails: { [appearance]: url } })
              ?.thumbnails?.[appearance],
          ).toBe(url);
          const thumbnail = url!.slice(url!.indexOf(",") + 1);
          const { width, height } = yield* Effect.promise(() =>
            sharp(Buffer.from(thumbnail, "base64")).metadata(),
          );
          expect([width, height], appearance).toEqual([480, 300]);
          // The top of the page, then the theme's own background below it.
          expect(yield* nearPixel(thumbnail, 10, 5, "#d03030"), appearance).toBe(true);
          expect(
            yield* nearPixel(
              thumbnail,
              10,
              200,
              defaultHtmlRenderTheme(appearance).variables["--background"]!,
            ),
            appearance,
          ).toBe(true);
        }
      }).pipe(Effect.provide(liveLayer())),
    30_000,
  );

  it.live(
    "keeps the heights and the dark thumbnail when the light one never finishes",
    () =>
      Effect.gen(function* () {
        const htmlRender = yield* HtmlRender;
        const prepared = yield* htmlRender.prepare({
          html: '<div style="height:300px"></div><script>if (matchMedia("(prefers-color-scheme: light)").matches) { while (true) {} }</script>',
          imageRoots: [],
        });

        const started = Date.now();
        const measured = yield* htmlRender.measure(prepared);

        // The heights and the dark thumbnail, then only a moment for the light one.
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(measured?.heights).toEqual(HTML_RENDER_MEASURE_WIDTHS.map((width) => [width, 300]));
        expect(measured?.thumbnails?.dark).toMatch(/^data:image\/webp;base64,/);
        expect(measured?.thumbnails?.light).toBeUndefined();
        // A page shorter than the thumbnail still fills its shape, over its own background.
        const dark = measured!.thumbnails!.dark!;
        const thumbnail = dark.slice(dark.indexOf(",") + 1);
        const { width, height } = yield* Effect.promise(() =>
          sharp(Buffer.from(thumbnail, "base64")).metadata(),
        );
        expect([width, height]).toEqual([480, 300]);
        expect(
          yield* nearPixel(
            thumbnail,
            240,
            290,
            defaultHtmlRenderTheme("dark").variables["--background"]!,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(liveLayer())),
    30_000,
  );

  it.live(
    "measures a prepared page at every client width with a fresh load each",
    () =>
      Effect.gen(function* () {
        const htmlRender = yield* HtmlRender;
        // Like a D3 chart, the page sizes itself from the width once, at load.
        const prepared = yield* htmlRender.prepare({
          html: '<div id="chart"></div><script>document.getElementById("chart").style.height = innerWidth / 2 + "px";</script>',
          imageRoots: [],
        });
        expect((yield* htmlRender.measure(prepared))?.heights).toEqual(
          HTML_RENDER_MEASURE_WIDTHS.map((width) => [width, Math.ceil(width / 2)]),
        );
      }).pipe(Effect.provide(liveLayer())),
    30_000,
  );
});
