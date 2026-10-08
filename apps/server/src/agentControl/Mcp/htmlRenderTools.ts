/**
 * `ryco_html_preview` and `ryco_html_render`: private, exact-turn tools that
 * let an agent check a self-contained HTML page in Ryco's headless browser
 * and then show it inline in its own thread, above its final reply.
 *
 * A render is stored like a delivered file: a `text/html` attachment carrying
 * `htmlRender` metadata on its own assistant message in the current turn, so
 * thread deletion, revert pruning and authorized chunk reads treat it as any
 * other message attachment. Clients never load it from the app origin; they
 * read the bytes and show them in a sandboxed `srcdoc` frame.
 *
 * Never installed on the external Agent Control endpoint.
 *
 * @module agentControl/Mcp/htmlRenderTools
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";

import {
  AGENT_CONTROL_CAPABILITIES,
  type ChatFileAttachment,
  CommandId,
  MessageId,
} from "@ryco/contracts";
import {
  clampHtmlRenderHeight,
  HTML_PREVIEW_TOOL_NAME,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_HTML_CHARS,
  HTML_RENDER_MAX_PAGE_BYTES,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_PAGE_RULES,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
  htmlRenderFileName,
  normalizeHtmlRenderTitle,
} from "@ryco/shared/htmlRender";
import { Data, Effect, Exit, Option, Schema } from "effect";
import sharp from "sharp";

import {
  persistGeneratedAssistantAttachment,
  type PublishedAssistantAttachment,
} from "../../assistantAttachments.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  describeHtmlRenderImageRefusal,
  type HtmlPreview,
  HTML_RENDER_UNMEASURED_FRAME,
  HtmlRenderPageTooLargeError,
  type HtmlRenderShape,
} from "../../htmlRender/HtmlRender.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { WorkspaceAccessPolicyShape } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
} from "../Services/AgentControlSessionRegistry.ts";
import type {
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
} from "./tools.ts";
import { AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES } from "./transportGuard.ts";
import {
  makeTurnAttachmentDelivery,
  type TurnAttachmentDelivery,
} from "./turnAttachmentDelivery.ts";

// The preview browser clamps the viewport to this range (see `HtmlPreviewInput`).
const PREVIEW_MIN_WIDTH = 240;
const PREVIEW_MAX_WIDTH = 1_600;

const htmlProperty = {
  type: "string",
  minLength: 1,
  maxLength: HTML_RENDER_MAX_HTML_CHARS,
  description: "A complete, self-contained HTML document.",
} as const;

const PREVIEW_DESCRIPTOR: AgentControlMcpToolDescriptor = {
  name: HTML_PREVIEW_TOOL_NAME,
  description: `Render an HTML page in Ryco's headless browser and get back a screenshot, contentHeight (the height the page needs at this width), and its console output: log, info, warning, error, and uncaught exceptions, with stack traces pointing into page.html. console.log is a fine way to report your own checks. Use it to check and iterate on a page before ${HTML_RENDER_TOOL_NAME}. The first preview on a machine can report that Ryco is still installing its preview browser; call again a minute later. ${HTML_RENDER_PAGE_RULES} The page gets the theme variables and layout described in ${HTML_RENDER_TOOL_NAME}.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["html"],
    properties: {
      html: htmlProperty,
      width: {
        type: "integer",
        minimum: PREVIEW_MIN_WIDTH,
        maximum: PREVIEW_MAX_WIDTH,
        description: `Viewport width in CSS pixels, ${PREVIEW_MIN_WIDTH}-${PREVIEW_MAX_WIDTH}. Defaults to ${HTML_RENDER_COLUMN_WIDTH}, the reply column; use about 350 (320 for small phones) to check phones.`,
      },
      appearance: {
        type: "string",
        enum: ["dark", "light"],
        description: "Theme to preview. Defaults to dark.",
      },
    },
  },
};

const RENDER_DESCRIPTOR: AgentControlMcpToolDescriptor = {
  name: HTML_RENDER_TOOL_NAME,
  description: `Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this thread, above your final text reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say. Preview with ${HTML_PREVIEW_TOOL_NAME} first. Ryco fits the frame to the page's height at each reader's width when it could measure the page. A height below the page's contentHeight caps the frame there, and the rest scrolls inside it. Each page counts toward this turn's attachment budget (8 attachments, 50 MiB). ${HTML_RENDER_PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["html", "title", "height"],
    properties: {
      html: htmlProperty,
      title: {
        type: "string",
        minLength: 1,
        maxLength: HTML_RENDER_MAX_TITLE_LENGTH,
        description: "Short name for the page.",
      },
      height: {
        type: "integer",
        description: `The frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. Use ${HTML_PREVIEW_TOOL_NAME}'s contentHeight, or less to make long content scroll inside the frame. Without a contentHeight from a preview at the default width, pass ${HTML_RENDER_MAX_HEIGHT}: ${HTML_RENDER_UNMEASURED_FRAME}.`,
      },
    },
  },
};

const RENDERED_TEXT =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";
/** Whether Ryco measured the stored page, so the agent knows how its height is used. */
const measuredText = (heights: ReadonlyArray<unknown> | undefined) =>
  heights === undefined
    ? " Not measured: the frame shrinks to the page but never grows past your height."
    : ` Measured at ${heights.length} widths.`;
const ALREADY_RENDERED_TEXT =
  "This page is already shown to the reader above your reply. Don't publish it again or describe it.";

/**
 * The stored page as the agent gets it back, without its card thumbnails:
 * base64 images that Codex would put whole into the model's context (it shows
 * the model a tool's structured content in place of its text) and that every
 * provider would keep in the turn's tool activity.
 */
const withoutThumbnails = (attachment: ChatFileAttachment): ChatFileAttachment => {
  if (attachment.htmlRender?.thumbnails === undefined) return attachment;
  const { thumbnails: _thumbnails, ...htmlRender } = attachment.htmlRender;
  return { ...attachment, htmlRender };
};

/** Invalid tool arguments; `reason` tells the agent what to send instead. */
class HtmlToolInputError extends Data.TaggedError("HtmlToolInputError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

/** A failure without an agent-facing cause of its own (storage, image encoding). */
class HtmlToolFailure extends Data.TaggedError("HtmlToolFailure")<{ readonly reason: string }> {
  override get message(): string {
    return this.reason;
  }
}

const RenderArguments = Schema.Struct({
  html: Schema.String,
  title: Schema.String,
  height: Schema.Finite,
});
const PreviewArguments = Schema.Struct({
  html: Schema.String,
  width: Schema.optional(Schema.Finite),
  appearance: Schema.optional(Schema.Literals(["dark", "light"])),
});

const invalid = (reason: string) => Effect.fail(new HtmlToolInputError({ reason }));

const checkHtml = (html: string) =>
  html.trim().length === 0
    ? invalid("html must be a complete HTML document; it was empty.")
    : html.length > HTML_RENDER_MAX_HTML_CHARS
      ? invalid(
          `html is ${html.length.toLocaleString("en-US")} characters; the limit is ${HTML_RENDER_MAX_HTML_CHARS.toLocaleString("en-US")}. Simplify the page, or load bulky data and libraries from public URLs.`,
        )
      : Effect.void;

const readRenderArguments = (args: unknown) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(RenderArguments)(args).pipe(
      Effect.mapError(
        () =>
          new HtmlToolInputError({
            reason:
              "Arguments must be { html: string, title: string, height: number of CSS pixels }.",
          }),
      ),
    );
    yield* checkHtml(input.html);
    if (input.title.trim().length === 0 || input.title.length > HTML_RENDER_MAX_TITLE_LENGTH)
      return yield* invalid(`title must be 1-${HTML_RENDER_MAX_TITLE_LENGTH} characters.`);
    return input;
  });

const readPreviewArguments = (args: unknown) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(PreviewArguments)(args).pipe(
      Effect.mapError(
        () =>
          new HtmlToolInputError({
            reason: `Arguments must be { html: string, width?: ${PREVIEW_MIN_WIDTH}-${PREVIEW_MAX_WIDTH}, appearance?: "dark" | "light" }.`,
          }),
      ),
    );
    yield* checkHtml(input.html);
    return input;
  });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

const errorResult = (text: string): AgentControlMcpToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

/** Base64 characters a preview screenshot may use, leaving the rest of the response cap for its summary. */
export const HTML_PREVIEW_SCREENSHOT_MAX_BASE64_CHARS = 360_000;

export interface HtmlPreviewScreenshot {
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
}

// Full resolution matters more to an agent checking a layout than JPEG detail,
// so quality drops once before the screenshot is scaled down.
const JPEG_QUALITIES = [80, 60] as const;
const MAX_FIT_ATTEMPTS = 6;

/**
 * Fits a preview screenshot into `maxBase64Chars`: the PNG as captured when it
 * fits, else a JPEG at full size, else a JPEG scaled down until it does.
 */
export async function fitHtmlPreviewScreenshot(
  pngBase64: string,
  maxBase64Chars: number,
): Promise<HtmlPreviewScreenshot> {
  const png = Buffer.from(pngBase64, "base64");
  const { width = 0, height = 0 } = await sharp(png).metadata();
  if (pngBase64.length <= maxBase64Chars) {
    return { data: pngBase64, mimeType: "image/png", width, height };
  }
  const maxBytes = Math.floor(maxBase64Chars / 4) * 3;
  let targetWidth = width;
  for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS && targetWidth >= 1; attempt += 1) {
    const quality = JPEG_QUALITIES[Math.min(attempt, JPEG_QUALITIES.length - 1)];
    const pipeline = sharp(png);
    if (targetWidth < width) pipeline.resize({ width: targetWidth });
    const jpeg = await pipeline.jpeg({ quality }).toBuffer({ resolveWithObject: true });
    if (jpeg.data.byteLength <= maxBytes) {
      return {
        data: jpeg.data.toString("base64"),
        mimeType: "image/jpeg",
        width: jpeg.info.width,
        height: jpeg.info.height,
      };
    }
    if (attempt + 1 < JPEG_QUALITIES.length) continue;
    // Encoded size tracks pixel count, so scale the width by the square root, with margin.
    const scale = Math.min(0.9, Math.sqrt(maxBytes / jpeg.data.byteLength) * 0.95);
    targetWidth = Math.floor(jpeg.info.width * scale);
  }
  throw new Error("The screenshot does not fit the response.");
}

const MAX_REPORTED_MISSING_IMAGES = 20;
const MAX_REPORTED_PATH_CHARS = 300;

/** The preview summary sent beside the screenshot; bounded so the screenshot keeps its budget. */
const previewSummary = (preview: HtmlPreview) => {
  const missing = preview.missingImages ?? [];
  const missingImages = missing
    .slice(0, MAX_REPORTED_MISSING_IMAGES)
    .map(
      ({ path, reason }) =>
        `${path.length > MAX_REPORTED_PATH_CHARS ? `${path.slice(0, MAX_REPORTED_PATH_CHARS - 1)}…` : path} (${describeHtmlRenderImageRefusal(reason)})`,
    );
  if (missing.length > MAX_REPORTED_MISSING_IMAGES)
    missingImages.push(`${missing.length - MAX_REPORTED_MISSING_IMAGES} more omitted`);
  return {
    width: preview.width,
    contentHeight: preview.contentHeight,
    capturedHeight: preview.capturedHeight,
    consoleMessages: preview.consoleMessages,
    ...(missingImages.length > 0 ? { missingImages } : {}),
  };
};

// Room for the JSON-RPC envelope and the image block's own keys.
const PREVIEW_RESPONSE_OVERHEAD_BYTES = 2 * 1024;

export interface HtmlRenderToolDeps {
  readonly htmlRender: HtmlRenderShape;
  readonly attachmentsDir: string;
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly policy: Pick<AgentControlPolicyShape, "authorize">;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    "listThreadMessagesByTurn" | "getThreadCheckpointContext"
  >;
  readonly workspaceAccess: Pick<WorkspaceAccessPolicyShape, "assertExistingPath">;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  /** Shared with `ryco_attach_file` so both draw on one serialized per-turn budget. */
  readonly delivery?: TurnAttachmentDelivery;
  /** System temp directories local images may come from. Defaults to `defaultHtmlRenderTempDirectories()`. */
  readonly tempDirectories?: ReadonlyArray<string>;
}

/**
 * The system temp directories local images may come from: `os.tmpdir()`, and
 * `/tmp` on POSIX hosts. Windows has no `/tmp`; it would name a folder at the
 * current drive's root.
 */
export const defaultHtmlRenderTempDirectories = (
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<string> => (platform === "win32" ? [os.tmpdir()] : [os.tmpdir(), "/tmp"]);

/** Private, exact-turn tools only. Never installed on the external Agent Control endpoint. */
export const withHtmlRenderTools = (
  base: AgentControlMcpTools,
  deps: HtmlRenderToolDeps,
): Effect.Effect<AgentControlMcpTools> =>
  Effect.gen(function* () {
    const delivery = deps.delivery ?? (yield* makeTurnAttachmentDelivery(deps));
    const capability = AGENT_CONTROL_CAPABILITIES.renderHtml;
    const descriptors = [PREVIEW_DESCRIPTOR, RENDER_DESCRIPTOR];
    const isHtmlTool = (name: string) =>
      name === HTML_RENDER_TOOL_NAME || name === HTML_PREVIEW_TOOL_NAME;
    const tempDirectories = deps.tempDirectories ?? defaultHtmlRenderTempDirectories();

    /**
     * Where local images may be read from: the thread's own workspace (as the
     * workspace policy admits it) and the system temp directories. A root that
     * cannot be resolved is left out rather than failing the call; a page that
     * needs it reports the unreadable images.
     */
    const imageRoots = (session: AgentControlSessionRecord) =>
      Effect.gen(function* () {
        const context = yield* deps.projections.getThreadCheckpointContext(session.threadId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
        const cwd = context?.worktreePath ?? context?.workspaceRoot;
        const workspace =
          cwd === undefined || cwd === null
            ? undefined
            : yield* deps.workspaceAccess
                .assertExistingPath({ path: cwd, operation: "HTML render images" })
                .pipe(Effect.orElseSucceed(() => undefined));
        const temp = yield* Effect.promise(() =>
          Promise.all(tempDirectories.map((directory) => fs.realpath(directory).catch(() => null))),
        );
        return [
          ...new Set([
            ...(workspace === undefined ? [] : [workspace]),
            ...temp.filter((root) => root !== null),
          ]),
        ];
      });

    const removeStored = (stored: PublishedAssistantAttachment) =>
      Effect.promise(async () => {
        const destination = resolveAttachmentPath({
          attachmentsDir: deps.attachmentsDir,
          attachment: stored.attachment,
        });
        if (destination) await fs.rm(destination, { force: true });
      }).pipe(Effect.ignore);

    const render = (session: AgentControlSessionRecord, args: unknown) =>
      Effect.gen(function* () {
        const authority = yield* delivery.authorize(session, {
          capability,
          operation: `mcp:${HTML_RENDER_TOOL_NAME}`,
        });
        const input = yield* readRenderArguments(args);
        const title = normalizeHtmlRenderTitle(input.title);
        const height = clampHtmlRenderHeight(input.height);
        const digest = sha256(
          JSON.stringify([session.sessionId, authority.turnId, sha256(input.html), title, height]),
        );
        const messageId = MessageId.make(`html-render-${digest}`);
        const alreadyShown = {
          content: [{ type: "text", text: ALREADY_RENDERED_TEXT }],
        } satisfies AgentControlMcpToolResult;
        // A cheap early answer before the page is prepared and measured; the
        // serialized check below is the authoritative one.
        if ((yield* delivery.budget(session, authority, messageId)).delivered) return alreadyShown;

        const prepared = yield* deps.htmlRender.prepare({
          html: input.html,
          imageRoots: yield* imageRoots(session),
        });
        const bytes = Buffer.from(prepared, "utf8");
        if (bytes.byteLength > HTML_RENDER_MAX_PAGE_BYTES)
          return yield* new HtmlRenderPageTooLargeError({
            sizeBytes: bytes.byteLength,
            limitBytes: HTML_RENDER_MAX_PAGE_BYTES,
          });
        const measured = yield* deps.htmlRender.measure(prepared);

        return yield* delivery.serialized(
          Effect.gen(function* () {
            const budget = yield* delivery.budget(session, authority, messageId);
            if (budget.delivered) return alreadyShown;
            if (bytes.byteLength > budget.remainingBytes)
              return yield* new HtmlToolFailure({
                reason: `The page is ${formatBytes(bytes.byteLength)}, but only ${formatBytes(Math.max(0, budget.remainingBytes))} of this turn's 50 MiB attachment budget is left. Use smaller images.`,
              });
            let dispatching = false;
            const attachment = yield* Effect.acquireUseRelease(
              Effect.tryPromise({
                try: (signal) =>
                  persistGeneratedAssistantAttachment({
                    attachmentsDir: deps.attachmentsDir,
                    threadId: session.threadId,
                    deliveryId: messageId,
                    name: htmlRenderFileName(title),
                    mimeType: "text/html",
                    extensionSegment: "html",
                    bytes,
                    htmlRender: {
                      title,
                      height,
                      ...(measured === undefined ? {} : { heights: measured.heights }),
                      ...(measured?.thumbnails === undefined
                        ? {}
                        : { thumbnails: measured.thumbnails }),
                    },
                    remainingBytes: budget.remainingBytes,
                    signal,
                  }),
                catch: () =>
                  new HtmlToolFailure({ reason: "The page could not be stored. Try again." }),
              }),
              (stored) =>
                delivery
                  .publish(session, authority, {
                    messageId,
                    commandId: CommandId.make(`render-html-${digest}`),
                    attachment: stored.attachment,
                    onDispatch: () => {
                      dispatching = true;
                    },
                  })
                  .pipe(Effect.as(stored.attachment)),
              // Until the message exists nothing references a newly stored
              // page, so a failed or interrupted publication removes it.
              (stored, exit) =>
                Exit.isFailure(exit) && stored.created && !dispatching
                  ? removeStored(stored)
                  : Effect.void,
            );
            const message = `${RENDERED_TEXT}${measuredText(measured?.heights)}`;
            return {
              content: [{ type: "text", text: message }],
              // Codex shows the model the structured content instead of the
              // text, so the advice travels in both.
              structuredContent: { messageId, attachment: withoutThumbnails(attachment), message },
            } satisfies AgentControlMcpToolResult;
          }),
        );
      });

    // Not serialized with renders: a preview stores nothing and may take a while.
    const preview = (session: AgentControlSessionRecord, args: unknown) =>
      Effect.gen(function* () {
        yield* delivery.authorize(session, {
          capability,
          operation: `mcp:${HTML_PREVIEW_TOOL_NAME}`,
        });
        const input = yield* readPreviewArguments(args);
        const result = yield* deps.htmlRender.preview({
          html: input.html,
          imageRoots: yield* imageRoots(session),
          width: input.width,
          appearance: input.appearance,
        });
        const summary = previewSummary(result);
        // Sized with the largest screenshot fields it can carry, so the budget is never short.
        const reserved = Buffer.byteLength(
          JSON.stringify(
            JSON.stringify({
              ...summary,
              screenshot: { mimeType: "image/jpeg", width: 99_999, height: 99_999 },
            }),
          ),
          "utf8",
        );
        const budget = Math.min(
          HTML_PREVIEW_SCREENSHOT_MAX_BASE64_CHARS,
          AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES - reserved - PREVIEW_RESPONSE_OVERHEAD_BYTES,
        );
        const screenshot = yield* Effect.tryPromise({
          try: () => fitHtmlPreviewScreenshot(result.png, budget),
          catch: () =>
            new HtmlToolFailure({
              reason:
                "The screenshot could not be encoded small enough to return. Preview a narrower width or a shorter page.",
            }),
        });
        return {
          content: [
            {
              type: "image",
              data: screenshot.data,
              mimeType: screenshot.mimeType,
            } as AgentControlMcpToolResult["content"][number],
            {
              type: "text",
              text: JSON.stringify({
                ...summary,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              }),
            },
          ],
        } satisfies AgentControlMcpToolResult;
      });

    const run = (effect: Effect.Effect<AgentControlMcpToolResult, { readonly message: string }>) =>
      effect.pipe(
        // Every failure here carries a message written for the agent.
        Effect.catch((error) => Effect.succeed(errorResult(error.message))),
        Effect.catchDefect(() =>
          Effect.succeed(errorResult("The HTML tool failed unexpectedly. Try again.")),
        ),
      );

    return {
      ...base,
      descriptors: [...base.descriptors, ...descriptors],
      descriptorsFor: (session) =>
        base
          .descriptorsFor(session)
          .pipe(
            Effect.map((tools) =>
              session.grantedCapabilities.includes(capability) ? tools.concat(descriptors) : tools,
            ),
          ),
      hasTool: (name) => isHtmlTool(name) || base.hasTool(name),
      // Both are turn-bound: a render writes into the thread, and a preview
      // runs a networked browser on the host that can read local images.
      isWriteTool: (name) => isHtmlTool(name) || base.isWriteTool(name),
      callTool: (session, name, args) =>
        name === HTML_RENDER_TOOL_NAME
          ? run(render(session, args))
          : name === HTML_PREVIEW_TOOL_NAME
            ? run(preview(session, args))
            : base.callTool(session, name, args),
    } satisfies AgentControlMcpTools;
  });
