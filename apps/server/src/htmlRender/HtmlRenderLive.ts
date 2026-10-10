/**
 * HtmlRenderLive - The `HtmlRender` service: page preparation (theme
 * bootstrap, local images inlined from allowed roots) plus measurement,
 * thumbnails, and previews in Ryco's pinned headless browser.
 *
 * Requires `ServerConfig`, `FileSystem`, `Path`, `ChildProcessSpawner`, and
 * `HttpClient`.
 *
 * @module HtmlRenderLive
 */
import {
  defaultHtmlRenderTheme,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MEASURE_FONTS,
  HTML_RENDER_MEASURE_WIDTHS,
  htmlRenderThemeFragment,
  injectHtmlRenderBootstrap,
} from "@ryco/shared/htmlRender";
import type { ThemeAppearance } from "@ryco/shared/themePalettes";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Semaphore,
} from "effect";
import type { Duration } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  HTML_RENDER_WITHOUT_PREVIEW,
  HtmlPreviewError,
  HtmlRender,
  HtmlRenderImagesNotFoundError,
  type HtmlPreview,
  type HtmlPreviewInput,
  type HtmlRenderMeasurement,
  type HtmlRenderPrepareInput,
} from "./HtmlRender.ts";
import * as HeadlessChrome from "./headlessChrome.ts";
import { inlineLocalImages } from "./localImages.ts";
import { PreviewBrowser, PreviewBrowserLive, type PreviewBrowserError } from "./PreviewBrowser.ts";
import { encodeHtmlRenderThumbnail, HTML_RENDER_THUMBNAIL_CAPTURE_HEIGHT } from "./thumbnails.ts";

const MIN_PREVIEW_WIDTH = 240;
const MAX_PREVIEW_WIDTH = 1_600;
// Each preview or measurement runs its own browser; more at once mostly costs memory.
const MAX_CONCURRENT_BROWSERS = 2;
// Publishing waits this long at most for heights and thumbnails before
// storing the page with what it has.
const MEASURE_TIMEOUT = "6 seconds";
// Once the heights are in, publishing waits this much longer at most for the
// thumbnails. They usually follow within milliseconds, but a page that keeps
// its main thread busy after load holds its screenshot back.
const THUMBNAIL_WAIT = "1 second";
// A preview waits this long for a browser slot. With the install wait and the
// capture timeout it stays inside the agent's 60 s tool-call limit.
const BROWSER_SLOT_WAIT = "8 seconds";

/** Operators set this to run previews without Chrome's sandbox, e.g. in a container as root. */
export const HTML_PREVIEW_NO_SANDBOX_ENV = "RYCO_HTML_PREVIEW_NO_SANDBOX";

const WITHOUT_PREVIEW = HTML_RENDER_WITHOUT_PREVIEW;

const themeFor = (appearance: ThemeAppearance): HeadlessChrome.HtmlPageTheme => ({
  urlFragment: htmlRenderThemeFragment(
    defaultHtmlRenderTheme(appearance, HTML_RENDER_MEASURE_FONTS),
  ),
  colorScheme: appearance,
});
// Measured in the dark theme with Arial-metric fonts, so text wraps close to
// how clients show it. Its load at the column width is the dark thumbnail.
const MEASURE_THEME = themeFor("dark");
const LIGHT_THUMBNAIL_THEME = themeFor("light");

/** What a measurement has found so far. */
interface MeasuredPage {
  heights: ReadonlyArray<readonly [number, number]> | undefined;
  readonly thumbnails: { dark?: string; light?: string };
}

/** Whether the operator turned Chrome's sandbox off for HTML previews. */
export const previewSandboxDisabled = (env: Readonly<Record<string, string | undefined>>) =>
  ["1", "true", "yes"].includes(env[HTML_PREVIEW_NO_SANDBOX_ENV]?.trim().toLowerCase() ?? "");

const rootWithoutSandbox = () =>
  new HtmlPreviewError({
    reason: `Chrome cannot use its sandbox while the Ryco server runs as root, so HTML previews are off on this host. Run Ryco as a regular user, or set ${HTML_PREVIEW_NO_SANDBOX_ENV}=1 for the Ryco server to preview without Chrome's sandbox. ${WITHOUT_PREVIEW}`,
    retryable: false,
  });

const browserBusy = () =>
  new HtmlPreviewError({
    reason:
      "Ryco is already running as many HTML previews as it allows at once. Call ryco_html_preview again shortly.",
    retryable: true,
  });

/** The preview browser's install state, told to the agent. */
export const previewErrorFromInstall = (error: PreviewBrowserError) =>
  new HtmlPreviewError({
    reason: error.message,
    // An install in progress finishes on its own and a failed one is retried by the next call.
    retryable: error._tag !== "PreviewBrowserUnsupportedError",
    cause: error,
  });

const lastLine = (output: string) =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line !== "")
    ?.slice(0, 300);

/**
 * A browser failure, told to the agent. A browser that dies at startup gets
 * the host setup it needs instead of its raw output.
 */
export const previewErrorFromBrowser = (error: HeadlessChrome.HtmlRenderBrowserError) => {
  const output = error.output;
  const preview = (reason: string, retryable = false) =>
    new HtmlPreviewError({ reason, retryable, cause: error });
  if (output !== undefined) {
    const library = /error while loading shared libraries: ([^:\s]+)/.exec(output)?.[1];
    if (library !== undefined) {
      return preview(
        `The HTML preview browser cannot start on this host: the system library ${library} is missing. Install Chrome's runtime libraries (on Debian or Ubuntu, for example: apt-get install libnss3 libatk-bridge2.0-0 libgbm1 libasound2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libcups2), then call ryco_html_preview again. ${WITHOUT_PREVIEW}`,
      );
    }
    if (
      /No usable sandbox|Running as root without --no-sandbox|Failed to move to new namespace/i.test(
        output,
      )
    ) {
      return preview(
        `The HTML preview browser cannot start because this host gives Chrome no usable sandbox (on Linux, unprivileged user namespaces are often restricted). Allow them for Chrome, or set ${HTML_PREVIEW_NO_SANDBOX_ENV}=1 for the Ryco server to preview without Chrome's sandbox. ${WITHOUT_PREVIEW}`,
      );
    }
    const detail = lastLine(output);
    return preview(
      `The HTML preview browser exited unexpectedly${detail ? ` (${detail})` : ""}. Call ryco_html_preview again, or publish without a preview; ${WITHOUT_PREVIEW}`,
      true,
    );
  }
  if (error.navigatedTo !== undefined) {
    return preview(
      `The page navigated away from itself to ${error.navigatedTo}, so the preview has nothing of it to show, and readers would see the same. Remove the navigation (such as a history.back() call), then call ryco_html_preview again.`,
    );
  }
  if (error.reason.startsWith("the page did not finish loading")) {
    return preview(
      `The page did not finish loading in the preview browser within ${HeadlessChrome.CAPTURE_TIMEOUT}. Check for scripts that never finish or resources that never load, then call ryco_html_preview again.`,
    );
  }
  if (error.reason === "the browser could not be started") {
    return preview(
      `The HTML preview browser could not be started on this host. ${WITHOUT_PREVIEW}`,
    );
  }
  return preview(`Could not preview the page: ${error.reason}. ${WITHOUT_PREVIEW}`, true);
};

export interface HtmlRenderOptions {
  /** The server's environment, for the sandbox opt-out. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Whether the server runs as root, where Chrome refuses its sandbox. */
  readonly isRoot?: boolean;
  /** How long a preview waits for a browser slot. */
  readonly browserSlotWait?: Duration.Input;
  /** How long publishing waits for heights. */
  readonly measureTimeout?: Duration.Input;
  /** How much longer publishing waits for thumbnails once the heights are in. */
  readonly thumbnailWait?: Duration.Input;
}

export const makeHtmlRender = Effect.fn("HtmlRender.make")(function* (
  options: HtmlRenderOptions = {},
) {
  const previewBrowser = yield* PreviewBrowser;
  const serviceScope = yield* Effect.scope;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const browsers = yield* Semaphore.make(MAX_CONCURRENT_BROWSERS);
  // Chrome's sandbox stays on unless the operator explicitly turns it off.
  // Chrome also refuses it as root, where that opt-out is the only way to run.
  const noSandbox = previewSandboxDisabled(options.env ?? process.env);
  const isRoot = options.isRoot ?? (typeof process.getuid === "function" && process.getuid() === 0);
  const sandboxUnavailable = isRoot && !noSandbox;
  const slotWait = options.browserSlotWait ?? BROWSER_SLOT_WAIT;
  const measureTimeout = options.measureTimeout ?? MEASURE_TIMEOUT;
  const thumbnailWait = options.thumbnailWait ?? THUMBNAIL_WAIT;

  /** Runs one browser launch once a slot frees up, or fails when none does in time. */
  const withBrowserSlot = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      restore(
        browsers
          .take(1)
          .pipe(
            Effect.timeoutOrElse({ duration: slotWait, orElse: () => Effect.fail(browserBusy()) }),
          ),
      ).pipe(Effect.andThen(restore(effect).pipe(Effect.ensuring(browsers.release(1))))),
    );

  // The bootstrap goes in first so its head scan never runs over inlined image data.
  const inline = (input: HtmlRenderPrepareInput) =>
    inlineLocalImages(injectHtmlRenderBootstrap(input.html), input.imageRoots);

  const prepare = Effect.fn("HtmlRender.prepare")(function* (input: HtmlRenderPrepareInput) {
    const inlined = yield* inline(input);
    if (inlined.missing.length > 0) {
      return yield* new HtmlRenderImagesNotFoundError({
        paths: inlined.missing.map((image) => image.path),
        reasons: inlined.missing.map((image) => image.reason),
      });
    }
    return inlined.html;
  });

  /** Encodes a thumbnail; one that fails or fits no encoding is only missing. */
  const thumbnail = (png: string) =>
    Effect.tryPromise(() => encodeHtmlRenderThumbnail(png)).pipe(
      Effect.catch((cause) =>
        Effect.logDebug("Could not encode an HTML render thumbnail.", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  /**
   * Measures into `found` as results arrive, so a caller that stops waiting
   * keeps them, and runs `onHeights` once the heights are in.
   */
  const measurePage = (
    preparedHtml: string,
    found: MeasuredPage,
    onHeights: Effect.Effect<unknown>,
  ) =>
    Effect.gen(function* () {
      if (sandboxUnavailable) return;
      const executable = yield* previewBrowser.installed;
      if (Option.isNone(executable)) return;
      yield* withBrowserSlot(
        HeadlessChrome.measureHtmlPage({
          executable: executable.value,
          noSandbox,
          html: preparedHtml,
          widths: HTML_RENDER_MEASURE_WIDTHS,
          theme: MEASURE_THEME,
          screenshots: {
            width: HTML_RENDER_COLUMN_WIDTH,
            height: HTML_RENDER_THUMBNAIL_CAPTURE_HEIGHT,
            alsoIn: LIGHT_THUMBNAIL_THEME,
            onScreenshot: (appearance, png) =>
              thumbnail(png).pipe(
                Effect.map((url) => {
                  if (url !== undefined) found.thumbnails[appearance] = url;
                }),
              ),
          },
          onHeights: (heights) =>
            Effect.sync(() => {
              found.heights = heights.toSorted(([left], [right]) => left - right);
            }).pipe(Effect.andThen(onHeights)),
        }).pipe(Effect.provideContext(services)),
      );
    });

  const unmeasured = (cause: Cause.Cause<unknown>) =>
    Effect.logWarning("Could not measure an HTML render; storing it without heights.", {
      cause: Cause.pretty(cause),
    }).pipe(Effect.as(undefined));

  // Never installs the browser: publishing must not depend on it. The browser
  // runs in the service's scope, so the caller gets its answer within the
  // bound while a stopped browser's cleanup finishes in the background,
  // holding its slot until then. Thumbnails are extra: publishing waits for
  // them only briefly once the heights are in, and keeps whatever arrived.
  const measure = (preparedHtml: string) =>
    Effect.gen(function* () {
      const found: MeasuredPage = { heights: undefined, thumbnails: {} };
      // Done once the heights are in, or once measuring ended without them.
      const settled = yield* Deferred.make<void>();
      const measuring = yield* measurePage(
        preparedHtml,
        found,
        Deferred.succeed(settled, undefined),
      ).pipe(Effect.ensuring(Deferred.succeed(settled, undefined)), Effect.forkIn(serviceScope));
      const stop = Fiber.interrupt(measuring).pipe(Effect.forkIn(serviceScope), Effect.asVoid);
      const exit = yield* Deferred.await(settled).pipe(
        Effect.andThen(Fiber.await(measuring).pipe(Effect.timeoutOption(thumbnailWait))),
        Effect.timeoutOption(measureTimeout),
        Effect.map(Option.flatten),
        Effect.onInterrupt(() => stop),
      );
      if (Option.isNone(exit)) yield* stop;
      const thumbnails = { ...found.thumbnails };
      const heights = found.heights;
      if (heights === undefined) {
        if (Option.isNone(exit)) {
          return yield* unmeasured(Cause.fail("measuring took longer than its bound"));
        }
        // Anything else, defects included, stores the page unmeasured.
        return Exit.isSuccess(exit.value) ? undefined : yield* unmeasured(exit.value.cause);
      }
      return {
        heights,
        ...(thumbnails.dark === undefined && thumbnails.light === undefined ? {} : { thumbnails }),
      } satisfies HtmlRenderMeasurement;
    }).pipe(Effect.withSpan("HtmlRender.measure"));

  const preview = Effect.fn("HtmlRender.preview")(function* (input: HtmlPreviewInput) {
    const requestedWidth =
      input.width !== undefined && Number.isFinite(input.width)
        ? Math.round(input.width)
        : HTML_RENDER_COLUMN_WIDTH;
    const width = Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, requestedWidth));
    const appearance = input.appearance ?? "dark";
    const inlined = yield* inline(input);
    if (sandboxUnavailable) return yield* rootWithoutSandbox();
    const executable = yield* previewBrowser.executable.pipe(
      Effect.mapError(previewErrorFromInstall),
    );
    const screenshot = yield* withBrowserSlot(
      HeadlessChrome.captureHtmlScreenshot({
        executable,
        noSandbox,
        html: inlined.html,
        width,
        ...themeFor(appearance),
      }).pipe(
        Effect.provideContext(services),
        Effect.tapError((error) =>
          error.output === undefined
            ? Effect.void
            : Effect.logWarning("The HTML preview browser exited.", { output: error.output }),
        ),
        Effect.mapError(previewErrorFromBrowser),
      ),
    );
    return {
      ...screenshot,
      width,
      ...(inlined.missing.length === 0 ? {} : { missingImages: inlined.missing }),
    } satisfies HtmlPreview;
  });

  return HtmlRender.of({ prepare, measure, preview });
});

/** `HtmlRender` over a provided `PreviewBrowser`; tests swap the browser. */
export const HtmlRenderLayer = (options?: HtmlRenderOptions) =>
  Layer.effect(HtmlRender, makeHtmlRender(options));

/**
 * The server's `HtmlRender`, with the pinned preview browser installed under
 * `ServerConfig.baseDir`. Requires `ServerConfig`, `FileSystem`, `Path`,
 * `ChildProcessSpawner`, and `HttpClient`.
 */
export const HtmlRenderLive = HtmlRenderLayer().pipe(Layer.provide(PreviewBrowserLive));
