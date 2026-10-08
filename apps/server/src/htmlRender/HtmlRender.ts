/**
 * HtmlRender - Prepares agent HTML pages for inline display in a thread and
 * drives Ryco's own headless browser to measure and screenshot them.
 *
 * `prepare` produces the self-contained page that gets stored: the theme
 * bootstrap injected and allowed local images inlined. `measure` reports the
 * page's height at each client width and takes its thumbnails, but only when
 * the preview browser is already installed; publishing never waits on an
 * install. `preview` renders a
 * page in that browser (installing it on first use) and returns a screenshot
 * plus console output so the agent can check its work.
 *
 * Storage and timeline delivery belong to the `ryco_html_render` tool, which
 * stores the prepared page as a message attachment like `ryco_attach_file`.
 *
 * @module HtmlRender
 */
import { HTML_RENDER_MAX_HEIGHT, type HtmlRenderThumbnails } from "@ryco/shared/htmlRender";
import type { ThemeAppearance } from "@ryco/shared/themePalettes";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

const MIB = 1024 * 1024;
const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

/**
 * Why a page without measured heights needs a generous `height`: clients size
 * its frame from the page's own reports, capped at the agent's height.
 */
export const HTML_RENDER_UNMEASURED_FRAME =
  "an unmeasured frame shrinks to the page but never grows past height";

/** The closing advice of every message saying a preview is unavailable. */
export const HTML_RENDER_WITHOUT_PREVIEW = `ryco_html_render still works without a preview; pass it height ${HTML_RENDER_MAX_HEIGHT}, since ${HTML_RENDER_UNMEASURED_FRAME}.`;

/** Why a local image was not inlined. */
export const HtmlRenderImageRefusal = Schema.Literals([
  "not-found",
  "outside-roots",
  "not-a-file",
  "hard-link",
  "not-an-image",
  "unreadable",
]);
export type HtmlRenderImageRefusal = typeof HtmlRenderImageRefusal.Type;

const IMAGE_REFUSALS: Readonly<Record<HtmlRenderImageRefusal, string>> = {
  "not-found": "not found",
  "outside-roots": "outside this thread's workspace and the system temp directory",
  "not-a-file": "not a regular file",
  "hard-link":
    "a hard link; hard-linked files are refused, so copy it into the temp directory first",
  "not-an-image": "not image data; use PNG, JPEG, GIF, WebP, AVIF, SVG, BMP or ICO",
  unreadable: "could not be read",
};

/** Why an image was refused, told to the agent. */
export const describeHtmlRenderImageRefusal = (reason: HtmlRenderImageRefusal) =>
  IMAGE_REFUSALS[reason];

/** A local image reference, as written in the page, that was not inlined. */
export interface HtmlRenderMissingImage {
  readonly path: string;
  readonly reason: HtmlRenderImageRefusal;
}

export class HtmlRenderImagesNotFoundError extends Schema.TaggedError<HtmlRenderImagesNotFoundError>()(
  "HtmlRenderImagesNotFoundError",
  {
    paths: Schema.Array(Schema.String),
    /** Why each of `paths` was refused, in the same order. */
    reasons: Schema.optional(Schema.Array(HtmlRenderImageRefusal)),
  },
) {
  override get message(): string {
    const images = this.paths.map((path, index) => {
      const reason = this.reasons?.[index];
      return reason === undefined ? path : `${path} (${describeHtmlRenderImageRefusal(reason)})`;
    });
    return `These local images could not be read: ${images.join(", ")}. Use absolute paths to image files inside this thread's workspace or the system temp directory, or remove them.`;
  }
}

export class HtmlRenderImageTooLargeError extends Schema.TaggedError<HtmlRenderImageTooLargeError>()(
  "HtmlRenderImageTooLargeError",
  { path: Schema.String, sizeBytes: Schema.Number, limitBytes: Schema.Number },
) {
  override get message(): string {
    return `${this.path} is ${formatMib(this.sizeBytes)}; each local image must be at most ${formatMib(this.limitBytes)}.`;
  }
}

export class HtmlRenderPageTooLargeError extends Schema.TaggedError<HtmlRenderPageTooLargeError>()(
  "HtmlRenderPageTooLargeError",
  { sizeBytes: Schema.Number, limitBytes: Schema.Number },
) {
  override get message(): string {
    return `With its images inlined the page is ${formatMib(this.sizeBytes)}; the limit is ${formatMib(this.limitBytes)}. Use smaller images.`;
  }
}

/**
 * The preview browser could not run the page. Every reason is written for the
 * agent and says what to do next (retry later, simplify the page, or publish
 * without a preview).
 */
export class HtmlPreviewError extends Schema.TaggedError<HtmlPreviewError>()("HtmlPreviewError", {
  reason: Schema.String,
  /** Whether calling `ryco_html_preview` again shortly is expected to succeed (e.g. still installing). */
  retryable: Schema.Boolean,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

export type HtmlRenderPrepareError =
  | HtmlRenderImagesNotFoundError
  | HtmlRenderImageTooLargeError
  | HtmlRenderPageTooLargeError;

export interface HtmlRenderConsoleMessage {
  readonly level: "log" | "info" | "warning" | "error";
  readonly text: string;
}

export interface HtmlRenderPrepareInput {
  readonly html: string;
  /**
   * Directories local images may be read from (the thread's workspace, the
   * system temp directory). A path whose real location is outside all of them
   * counts as unreadable.
   */
  readonly imageRoots: ReadonlyArray<string>;
}

export interface HtmlPreviewInput extends HtmlRenderPrepareInput {
  /** Viewport width in CSS pixels; clamped to 240-1600, default HTML_RENDER_COLUMN_WIDTH. */
  readonly width?: number | undefined;
  /** Default "dark". */
  readonly appearance?: ThemeAppearance | undefined;
}

export interface HtmlPreview {
  /** Base64 PNG of the top `capturedHeight` CSS pixels. */
  readonly png: string;
  readonly width: number;
  /** Height the page needs to show without scrolling. */
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly consoleMessages: ReadonlyArray<HtmlRenderConsoleMessage>;
  /** Local images that could not be read, and why; they show as broken images. */
  readonly missingImages?: ReadonlyArray<HtmlRenderMissingImage>;
}

/** What publishing learns about a prepared page in the preview browser. */
export interface HtmlRenderMeasurement {
  /** `[width, contentHeight]` for each `HTML_RENDER_MEASURE_WIDTHS` entry, ascending. */
  readonly heights: ReadonlyArray<readonly [number, number]>;
  /**
   * The page's top in Ryco's default dark and light themes, as thumbnail data
   * URLs. Each is left out when it could not be taken in time.
   */
  readonly thumbnails?: HtmlRenderThumbnails;
}

export interface HtmlRenderShape {
  /** The self-contained page that gets stored; fails when any local image is unreadable. */
  readonly prepare: (
    input: HtmlRenderPrepareInput,
  ) => Effect.Effect<string, HtmlRenderPrepareError>;
  /**
   * Heights and thumbnails for an already prepared page. Never installs the
   * browser and never fails: undefined when the browser is not installed,
   * cannot start, or does not measure the page within a few seconds.
   */
  readonly measure: (preparedHtml: string) => Effect.Effect<HtmlRenderMeasurement | undefined>;
  /** Screenshots a page, tolerating unreadable local images (reported in `missingImages`). */
  readonly preview: (
    input: HtmlPreviewInput,
  ) => Effect.Effect<
    HtmlPreview,
    Exclude<HtmlRenderPrepareError, HtmlRenderImagesNotFoundError> | HtmlPreviewError
  >;
}

export class HtmlRender extends Context.Service<HtmlRender, HtmlRenderShape>()(
  "ryco/htmlRender/HtmlRender",
) {}
