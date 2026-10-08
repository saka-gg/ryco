import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGENT_CONTROL_CAPABILITIES,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  ChatFileAttachment,
  type OrchestrationCommand,
  type OrchestrationMessage,
} from "@ryco/contracts";
import { HTML_RENDER_MAX_HTML_CHARS } from "@ryco/shared/htmlRender";
import { Deferred, Effect, Option, Schema } from "effect";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  HtmlPreviewError,
  type HtmlPreview,
  HtmlRenderImagesNotFoundError,
  type HtmlRenderShape,
} from "../../htmlRender/HtmlRender.ts";
import type {
  AgentControlSessionRecord,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";
import {
  defaultHtmlRenderTempDirectories,
  fitHtmlPreviewScreenshot,
  HTML_PREVIEW_SCREENSHOT_MAX_BASE64_CHARS,
  withHtmlRenderTools,
} from "./htmlRenderTools.ts";
import { jsonRpcResult } from "./jsonRpc.ts";
import type { AgentControlMcpToolResult, AgentControlMcpTools } from "./tools.ts";
import { AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES } from "./transportGuard.ts";
import { withAssistantAttachmentTools } from "./attachmentTools.ts";
import { makeTurnAttachmentDelivery } from "./turnAttachmentDelivery.ts";

const session: AgentControlSessionRecord = {
  sessionId: "session",
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  runtimeSessionId: RuntimeSessionId.make("runtime"),
  grantedCapabilities: [AGENT_CONTROL_CAPABILITIES.renderHtml],
  issuedAt: "2026-10-07T00:00:00Z",
  injectionMode: "claude-http",
};
const base: AgentControlMcpTools = {
  descriptors: [],
  descriptorsFor: () => Effect.succeed([]),
  hasTool: () => false,
  isWriteTool: () => false,
  callTool: () => Effect.succeed({ content: [] }),
};
const page = "<!doctype html><html><head></head><body><p>Revenue</p></body></html>";
const renderArgs = { html: page, title: "  Revenue by quarter ", height: 420 };

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const textOf = (result: AgentControlMcpToolResult) =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

async function noisePng(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#202020",
      noise: { type: "gaussian", mean: 128, sigma: 60 },
    },
  })
    .png()
    .toBuffer();
}

async function fixture(options: { readonly previewPng?: Buffer } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-mcp-html-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  const temp = path.join(root, "temp");
  const attachmentsDir = path.join(root, "attachments");
  await fs.mkdir(cwd);
  await fs.mkdir(temp);
  let authority: Option.Option<AgentControlTurnAuthority> = Option.some({
    sessionId: session.sessionId,
    threadId: session.threadId,
    turnId: TurnId.make("turn"),
    boundAt: session.issuedAt,
  });
  const messages: OrchestrationMessage[] = [];
  const dispatch = vi.fn((command: OrchestrationCommand) =>
    Effect.sync(() => {
      if (command.type === "thread.message.assistant.complete")
        messages.push({
          id: command.messageId,
          role: "assistant",
          text: command.text ?? "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
          attachments: [...(command.attachments ?? [])],
        });
      return { sequence: messages.length };
    }),
  );
  const authorize = vi.fn(() => Effect.void);
  const previewPng =
    options.previewPng ??
    (await sharp({ create: { width: 760, height: 300, channels: 3, background: "#101010" } })
      .png()
      .toBuffer());
  const preview: HtmlPreview = {
    png: previewPng.toString("base64"),
    width: 760,
    contentHeight: 300,
    capturedHeight: 300,
    consoleMessages: [{ level: "log", text: "drawn" }],
  };
  const htmlRender = {
    prepare: vi.fn<HtmlRenderShape["prepare"]>((input) =>
      Effect.succeed(input.html.replace("<head>", "<head><style id=ryco-theme></style>")),
    ),
    measure: vi.fn<HtmlRenderShape["measure"]>(() =>
      Effect.succeed({
        heights: [
          [320, 610],
          [760, 380],
        ] as const,
      }),
    ),
    preview: vi.fn<HtmlRenderShape["preview"]>(() => Effect.succeed(preview)),
  };
  const deps = {
    attachmentsDir,
    registry: { getTurnAuthority: () => Effect.sync(() => authority) },
    policy: { authorize },
    engine: { dispatch },
    workspaceAccess: { assertExistingPath: () => Effect.succeed(cwd) },
    projections: {
      listThreadMessagesByTurn: () => Effect.sync(() => [...messages]),
      getThreadCheckpointContext: () =>
        Effect.succeed(
          Option.some({
            threadId: session.threadId,
            projectId: ProjectId.make("project"),
            workspaceRoot: cwd,
            worktreePath: null,
            checkpoints: [],
          }),
        ),
    },
  };
  const tools = await Effect.runPromise(
    withHtmlRenderTools(base, { ...deps, htmlRender, tempDirectories: [temp, "/missing-ryco"] }),
  );
  const call = (name: string, args: unknown, as: AgentControlSessionRecord = session) =>
    Effect.runPromise(tools.callTool(as, name, args));
  return {
    root,
    cwd,
    temp,
    attachmentsDir,
    deps,
    tools,
    call,
    htmlRender,
    dispatch,
    messages,
    authorize,
    setAuthority: (next: Option.Option<AgentControlTurnAuthority>) => {
      authority = next;
    },
    storedFiles: () => fs.readdir(attachmentsDir).catch(() => [] as string[]),
  };
}

const htmlAttachment = (attachment: ChatAttachment): ChatFileAttachment => {
  if (!Schema.is(ChatFileAttachment)(attachment)) throw new Error("expected a file attachment");
  return attachment;
};

describe("ryco_html_render", () => {
  it("is discoverable only with the html.render grant, and both tools are turn-bound", async () => {
    const { tools } = await fixture();
    expect(
      (await Effect.runPromise(tools.descriptorsFor(session))).map((tool) => tool.name),
    ).toEqual(["ryco_html_preview", "ryco_html_render"]);
    expect(
      await Effect.runPromise(
        tools.descriptorsFor({
          ...session,
          grantedCapabilities: [AGENT_CONTROL_CAPABILITIES.attachFile],
        }),
      ),
    ).toEqual([]);
    for (const name of ["ryco_html_render", "ryco_html_preview"]) {
      expect(tools.hasTool(name)).toBe(true);
      expect(tools.isWriteTool(name)).toBe(true);
    }
    expect(tools.hasTool("ryco_attach_file")).toBe(false);
  });

  it("stores the prepared page as an html render attachment on a message in the turn", async () => {
    const { call, dispatch, htmlRender, attachmentsDir, messages } = await fixture();
    const result = await call("ryco_html_render", { ...renderArgs, threadId: "other-thread" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(
      "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say. Measured at 2 widths.",
    );
    expect(htmlRender.measure).toHaveBeenCalledWith(
      page.replace("<head>", "<head><style id=ryco-theme></style>"),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    const command = dispatch.mock.calls[0]![0];
    expect(command).toMatchObject({
      type: "thread.message.assistant.complete",
      threadId: session.threadId,
      turnId: "turn",
      text: " ",
    });
    const attachment = htmlAttachment(messages[0]!.attachments![0]!);
    expect(attachment).toMatchObject({
      type: "file",
      name: "Revenue by quarter.html",
      mimeType: "text/html",
      htmlRender: {
        title: "Revenue by quarter",
        height: 420,
        heights: [
          [320, 610],
          [760, 380],
        ],
      },
    });
    expect(attachment.id).toMatch(/^thread-[0-9a-f-]{36}-html$/);
    const stored = await fs.readFile(resolveAttachmentPath({ attachmentsDir, attachment })!);
    expect(stored.toString("utf8")).toBe(
      page.replace("<head>", "<head><style id=ryco-theme></style>"),
    );
    expect(attachment.sizeBytes).toBe(stored.byteLength);
    expect(result.structuredContent).toEqual({
      messageId: messages[0]!.id,
      attachment,
      message: textOf(result),
    });
    expect(textOf(result)).toMatch(/^Shown to the reader above your reply\. Don't mention/);
  });

  it("clamps the height, and stores the page unmeasured when the browser is missing", async () => {
    const { call, htmlRender, messages } = await fixture();
    htmlRender.measure.mockImplementation(() => Effect.succeed(undefined));
    const result = await call("ryco_html_render", { ...renderArgs, height: 9000.4 });
    expect(htmlAttachment(messages[0]!.attachments![0]!).htmlRender).toEqual({
      title: "Revenue by quarter",
      height: 2000,
    });
    // The agent learns its height is the frame's cap.
    expect(textOf(result)).toMatch(
      / Not measured: the frame shrinks to the page but never grows past your height\.$/,
    );
  });

  it("stores the thumbnails taken at publish with the page's sizes", async () => {
    const { call, htmlRender, messages } = await fixture();
    const thumbnails = {
      dark: "data:image/webp;base64,UklGRg==",
      light: "data:image/jpeg;base64,/9j/4A==",
    };
    htmlRender.measure.mockImplementation(() =>
      Effect.succeed({ heights: [[760, 380]] as const, thumbnails }),
    );
    const result = await call("ryco_html_render", renderArgs);
    const attachment = htmlAttachment(messages[0]!.attachments![0]!);
    expect(attachment.htmlRender).toEqual({
      title: "Revenue by quarter",
      height: 420,
      heights: [[760, 380]],
      thumbnails,
    });
    // The agent never gets them back: Codex shows the model a tool's whole
    // structured content, and providers keep the result in the work log.
    expect(JSON.stringify(result)).not.toContain("data:image/");
    expect(result.structuredContent).toEqual({
      messageId: messages[0]!.id,
      attachment: {
        ...attachment,
        htmlRender: { title: "Revenue by quarter", height: 420, heights: [[760, 380]] },
      },
      message: textOf(result),
    });
  });

  it("tells the agent how to size a page and check it on phones", async () => {
    const { tools } = await fixture();
    const [preview, render] = await Effect.runPromise(tools.descriptorsFor(session));
    const property = (tool: typeof preview, name: string) =>
      (tool!.inputSchema.properties as Record<string, { readonly description: string }>)[name]!
        .description;
    expect(property(preview, "width")).toContain(
      "use about 350 (320 for small phones) to check phones.",
    );
    expect(render!.description).toContain(
      "Ryco fits the frame to the page's height at each reader's width when it could measure the page.",
    );
    expect(property(render, "height")).toContain(
      "Without a contentHeight from a preview at the default width, pass 2000: an unmeasured frame shrinks to the page but never grows past height.",
    );
  });

  it("reads images from /tmp only where it is the system's own temp directory", () => {
    expect(defaultHtmlRenderTempDirectories("linux")).toEqual([os.tmpdir(), "/tmp"]);
    expect(defaultHtmlRenderTempDirectories("darwin")).toEqual([os.tmpdir(), "/tmp"]);
    expect(defaultHtmlRenderTempDirectories("win32")).toEqual([os.tmpdir()]);
  });

  it("answers an identical repeat in the same turn without storing it again", async () => {
    const { call, htmlRender, messages, storedFiles } = await fixture();
    await call("ryco_html_render", renderArgs);
    const repeat = await call("ryco_html_render", renderArgs);
    expect(repeat.isError).toBeUndefined();
    expect(textOf(repeat)).toContain("already shown");
    expect(htmlRender.prepare).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
    expect(await storedFiles()).toHaveLength(1);
    await call("ryco_html_render", { ...renderArgs, height: 300 });
    expect(messages).toHaveLength(2);
  });

  it("requires an exact active turn of the session's own thread", async () => {
    const { call, dispatch, htmlRender, setAuthority } = await fixture();
    setAuthority(Option.none());
    const result = await call("ryco_html_render", renderArgs);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("An exact active turn is required");
    setAuthority(
      Option.some({
        sessionId: session.sessionId,
        threadId: ThreadId.make("another-thread"),
        turnId: TurnId.make("turn"),
        boundAt: session.issuedAt,
      }),
    );
    expect((await call("ryco_html_render", renderArgs)).isError).toBe(true);
    expect(htmlRender.prepare).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("checks the capability through the Agent Control policy", async () => {
    const { call, authorize, dispatch } = await fixture();
    const { AgentControlCapabilityDeniedError } = await import("../Errors.ts");
    authorize.mockImplementation(
      () =>
        Effect.fail(
          new AgentControlCapabilityDeniedError({
            operation: "mcp:ryco_html_render",
            capability: "html.render",
          }),
        ) as never,
    );
    const result = await call("ryco_html_render", renderArgs);
    expect(textOf(result)).toBe("This session is not permitted to use ryco_html_render.");
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredCapability: AGENT_CONTROL_CAPABILITIES.renderHtml,
        operation: "mcp:ryco_html_render",
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("explains invalid arguments", async () => {
    const { call, htmlRender } = await fixture();
    expect(
      textOf(
        await call("ryco_html_render", {
          ...renderArgs,
          html: "x".repeat(HTML_RENDER_MAX_HTML_CHARS + 1),
        }),
      ),
    ).toContain("the limit is 512,000");
    expect(textOf(await call("ryco_html_render", { ...renderArgs, title: "t".repeat(201) }))).toBe(
      "title must be 1-200 characters.",
    );
    expect(textOf(await call("ryco_html_render", { html: page, title: "T" }))).toContain(
      "height: number",
    );
    expect(textOf(await call("ryco_html_render", { ...renderArgs, html: "   " }))).toContain(
      "empty",
    );
    expect(htmlRender.prepare).not.toHaveBeenCalled();
  });

  it("reads local images only from the thread workspace and the temp directories", async () => {
    const { call, htmlRender, cwd, temp, dispatch, storedFiles } = await fixture();
    await call("ryco_html_render", renderArgs);
    expect(htmlRender.prepare).toHaveBeenCalledWith({
      html: page,
      imageRoots: [cwd, await fs.realpath(temp)],
    });
    htmlRender.prepare.mockImplementation(() =>
      Effect.fail(new HtmlRenderImagesNotFoundError({ paths: ["/etc/secret.png"] })),
    );
    const refused = await call("ryco_html_render", { ...renderArgs, title: "Other" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("These local images could not be read: /etc/secret.png");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await storedFiles()).toHaveLength(1);
  });

  it("enforces the per-turn attachment count and byte budget shared with file delivery", async () => {
    const { call, messages, dispatch, storedFiles } = await fixture();
    const prior = (index: number, sizeBytes: number): OrchestrationMessage => ({
      id: `prior-${index}` as OrchestrationMessage["id"],
      role: "assistant",
      text: " ",
      turnId: TurnId.make("turn"),
      streaming: false,
      createdAt: session.issuedAt,
      updatedAt: session.issuedAt,
      attachments: [
        {
          type: "file",
          id: `thread-00000000-0000-0000-0000-00000000000${index}-bin`,
          name: "a.bin",
          mimeType: "application/octet-stream",
          sizeBytes,
        },
      ],
    });
    messages.push(prior(0, 50 * 1024 * 1024 - 10));
    const overBudget = await call("ryco_html_render", renderArgs);
    expect(textOf(overBudget)).toMatch(
      /^The page is \d+ bytes, but only 10 bytes of this turn's 50 MiB attachment budget is left\./,
    );
    messages.splice(0, 1, ...Array.from({ length: 8 }, (_, index) => prior(index, 1)));
    const overCount = await call("ryco_html_render", renderArgs);
    expect(textOf(overCount)).toContain("already delivered 8 attachments");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await storedFiles()).toEqual([]);
  });

  it("serializes the budget with ryco_attach_file through one shared delivery", async () => {
    const { deps, cwd } = await fixture();
    await fs.writeFile(path.join(cwd, "report.pdf"), "%PDF-report");
    const delivery = await Effect.runPromise(makeTurnAttachmentDelivery(deps));
    const shared = {
      ...session,
      grantedCapabilities: [
        AGENT_CONTROL_CAPABILITIES.attachFile,
        AGENT_CONTROL_CAPABILITIES.renderHtml,
      ],
    };
    const tools = await Effect.runPromise(
      Effect.flatMap(withAssistantAttachmentTools(base, { ...deps, delivery }), (fileTools) =>
        withHtmlRenderTools(fileTools, {
          ...deps,
          delivery,
          htmlRender: {
            prepare: (input) => Effect.succeed(input.html),
            measure: () => Effect.succeed(undefined),
            preview: () => Effect.die("unused"),
          },
          tempDirectories: [],
        }),
      ),
    );
    const results = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        Effect.runPromise(
          index % 2 === 0
            ? tools.callTool(shared, "ryco_attach_file", {
                path: "report.pdf",
                name: `report-${index}.pdf`,
              })
            : tools.callTool(shared, "ryco_html_render", { ...renderArgs, title: `Page ${index}` }),
        ),
      ),
    );
    expect(results.filter((result) => result.isError)).toHaveLength(1);
    expect(deps.engine.dispatch).toHaveBeenCalledTimes(8);
  });

  it("removes a newly stored page when the turn ends before it is shown", async () => {
    const { call, htmlRender, setAuthority, dispatch, storedFiles } = await fixture();
    htmlRender.measure.mockImplementation(() =>
      Effect.sync(() => {
        setAuthority(
          Option.some({
            sessionId: session.sessionId,
            threadId: session.threadId,
            turnId: TurnId.make("turn"),
            boundAt: "2026-10-07T00:00:01Z",
          }),
        );
        return undefined;
      }),
    );
    const result = await call("ryco_html_render", renderArgs);
    expect(textOf(result)).toBe("The turn ended before the attachment could be shown.");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await storedFiles()).toEqual([]);
  });

  it("never removes a snapshot an earlier delivery already stored", async () => {
    const { call, messages, setAuthority, htmlRender, storedFiles } = await fixture();
    await call("ryco_html_render", renderArgs);
    const [file] = await storedFiles();
    // The earlier message is gone from the read (e.g. a stale projection) and the turn changes mid-call.
    messages.splice(0);
    htmlRender.measure.mockImplementation(() =>
      Effect.sync(() => {
        setAuthority(
          Option.some({
            sessionId: session.sessionId,
            threadId: session.threadId,
            turnId: TurnId.make("turn"),
            boundAt: "2026-10-07T00:00:01Z",
          }),
        );
        return undefined;
      }),
    );
    expect((await call("ryco_html_render", renderArgs)).isError).toBe(true);
    expect(await storedFiles()).toEqual([file]);
  });

  it("keeps the page once the message was handed to the engine", async () => {
    const { call, dispatch, storedFiles } = await fixture();
    dispatch.mockImplementation(() => Effect.die("engine unavailable") as never);
    expect((await call("ryco_html_render", renderArgs)).isError).toBe(true);
    expect(await storedFiles()).toHaveLength(1);
  });
});

describe("ryco_html_preview", () => {
  it("returns the screenshot as an image block and a summary without base64", async () => {
    const { call, htmlRender, cwd, temp } = await fixture();
    const result = await call("ryco_html_preview", {
      html: page,
      width: 390,
      appearance: "light",
    });
    expect(result.isError).toBeUndefined();
    expect(htmlRender.preview).toHaveBeenCalledWith({
      html: page,
      imageRoots: [cwd, await fs.realpath(temp)],
      width: 390,
      appearance: "light",
    });
    expect(result.structuredContent).toBeUndefined();
    const [image, text] = result.content;
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(JSON.parse((text as { text: string }).text)).toEqual({
      width: 760,
      contentHeight: 300,
      capturedHeight: 300,
      consoleMessages: [{ level: "log", text: "drawn" }],
      screenshot: { mimeType: "image/png", width: 760, height: 300 },
    });
    expect((text as { text: string }).text).not.toContain((image as { data: string }).data);
  });

  it("fits a large screenshot into the private listener's response cap", async () => {
    const png = await noisePng(760, 1600);
    expect(png.toString("base64").length).toBeGreaterThan(HTML_PREVIEW_SCREENSHOT_MAX_BASE64_CHARS);
    const { call, htmlRender } = await fixture({ previewPng: png });
    htmlRender.preview.mockImplementation(() =>
      Effect.succeed({
        png: png.toString("base64"),
        width: 760,
        contentHeight: 5200,
        capturedHeight: 1600,
        consoleMessages: Array.from({ length: 21 }, (_, index) => ({
          level: "error" as const,
          text: `"\u0001${"e".repeat(480)}${index}`,
        })),
        missingImages: Array.from({ length: 40 }, (_, index) => ({
          path: `/tmp/${"p".repeat(500)}-${index}.png`,
          reason: "hard-link" as const,
        })),
      }),
    );
    const result = await call("ryco_html_preview", { html: page });
    expect(result.isError).toBeUndefined();
    const [image, text] = result.content as [
      { type: "image"; data: string; mimeType: string },
      { type: "text"; text: string },
    ];
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.data.length).toBeLessThanOrEqual(HTML_PREVIEW_SCREENSHOT_MAX_BASE64_CHARS);
    const summary = JSON.parse(text.text) as {
      screenshot: { mimeType: string; width: number; height: number };
      missingImages: string[];
    };
    const metadata = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect(summary.screenshot).toEqual({
      mimeType: "image/jpeg",
      width: metadata.width,
      height: metadata.height,
    });
    expect(summary.missingImages).toHaveLength(21);
    expect(summary.missingImages[0]).toMatch(/^\/tmp\/p+… \(a hard link; .+\)$/);
    expect(summary.missingImages.at(-1)).toBe("20 more omitted");
    const response = JSON.stringify(jsonRpcResult(1, result));
    expect(Buffer.byteLength(response, "utf8")).toBeLessThanOrEqual(
      AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES,
    );
  });

  it("says why each local image was left out", async () => {
    const { call, htmlRender } = await fixture();
    const preview = await Effect.runPromise(htmlRender.preview({ html: page, imageRoots: [] }));
    htmlRender.preview.mockImplementation(() =>
      Effect.succeed({
        ...preview,
        missingImages: [
          { path: "/work/linked.png", reason: "hard-link" },
          { path: "/etc/photo.png", reason: "outside-roots" },
          { path: "/work/notes.png", reason: "not-an-image" },
        ],
      }),
    );
    const result = await call("ryco_html_preview", { html: page });
    const summary = JSON.parse(textOf(result)) as { missingImages: string[] };
    expect(summary.missingImages).toEqual([
      "/work/linked.png (a hard link; hard-linked files are refused, so copy it into the temp directory first)",
      "/etc/photo.png (outside this thread's workspace and the system temp directory)",
      "/work/notes.png (not image data; use PNG, JPEG, GIF, WebP, AVIF, SVG, BMP or ICO)",
    ]);
  });

  it("passes the preview browser's guidance through as the tool error", async () => {
    const { call, htmlRender } = await fixture();
    htmlRender.preview.mockImplementation(() =>
      Effect.fail(
        new HtmlPreviewError({
          reason:
            "Ryco is installing its HTML preview browser (12 of 98 MB). Call ryco_html_preview again in a minute.",
          retryable: true,
        }),
      ),
    );
    const result = await call("ryco_html_preview", { html: page });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Ryco is installing its HTML preview browser (12 of 98 MB). Call ryco_html_preview again in a minute.",
        },
      ],
    });
  });

  it("runs while a render holds the delivery lock", async () => {
    const { call, dispatch } = await fixture();
    const release = await Effect.runPromise(Deferred.make<void>());
    dispatch.mockImplementationOnce(() => Deferred.await(release).pipe(Effect.as({ sequence: 1 })));
    const rendering = call("ryco_html_render", renderArgs);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const preview = await call("ryco_html_preview", { html: page });
    expect(preview.isError).toBeUndefined();
    await Effect.runPromise(Deferred.succeed(release, undefined));
    expect((await rendering).isError).toBeUndefined();
  });

  it("requires an exact active turn", async () => {
    const { call, htmlRender, setAuthority } = await fixture();
    setAuthority(Option.none());
    expect((await call("ryco_html_preview", { html: page })).isError).toBe(true);
    expect(htmlRender.preview).not.toHaveBeenCalled();
  });
});

describe("fitHtmlPreviewScreenshot", () => {
  it("keeps a small PNG as captured", async () => {
    const png = (
      await sharp({ create: { width: 40, height: 20, channels: 3, background: "#fff" } })
        .png()
        .toBuffer()
    ).toString("base64");
    expect(await fitHtmlPreviewScreenshot(png, 10_000)).toEqual({
      data: png,
      mimeType: "image/png",
      width: 40,
      height: 20,
    });
  });

  it("scales a screenshot down until it fits a tight budget", async () => {
    const png = (await noisePng(1600, 2000)).toString("base64");
    const fitted = await fitHtmlPreviewScreenshot(png, 60_000);
    expect(fitted.mimeType).toBe("image/jpeg");
    expect(fitted.data.length).toBeLessThanOrEqual(60_000);
    expect(fitted.width).toBeLessThan(1600);
    expect(fitted.height / fitted.width).toBeCloseTo(2000 / 1600, 1);
  });
});
