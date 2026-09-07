import { Data, Effect, FileSystem, Option, Path, Stream } from "effect";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  Multipart,
} from "effect/unstable/http";
import { open, rename, unlink } from "node:fs/promises";
import * as Schema from "effect/Schema";
import { OtlpTracer } from "effect/unstable/observability";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import {
  probeAttachmentMediaDimensions,
  probeAttachmentMediaForServing,
} from "./attachmentMedia.ts";
import { attachmentIdExtensionSegment, resolveAttachmentPathById } from "./attachmentStore.ts";
import {
  ChatAttachmentUploadError,
  ChatAttachmentUploads,
  type ChatAttachmentUploadLease,
} from "./attachmentUpload.ts";
import { resolveStaticDir, ServerConfig } from "./config.ts";
import { decodeOtlpTraceRecords } from "./observability/TraceRecord.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";
import { ProjectAvatarStore } from "./project/Services/ProjectAvatarStore.ts";
import type { ProjectId } from "@ryco/contracts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./auth/http.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";

const PROJECT_FAVICON_CACHE_CONTROL = "private, max-age=3600";
const PROJECT_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const PROJECT_AVATAR_CACHE_CONTROL = "private, max-age=0, must-revalidate";
const STATIC_INDEX_CACHE_CONTROL = "no-cache";
const STATIC_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
export const SERVER_ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/ryco/environment";
export const LEGACY_SERVER_ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/s3/environment";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const DOWNLOAD_CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";
const INLINE_ATTACHMENT_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);
const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

export const browserApiCorsLayer = HttpRouter.cors({
  allowedMethods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["authorization", "b3", "traceparent", "content-type"],
  maxAge: 600,
});

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

export function resolveStaticCacheControl(staticRelativePath: string): string {
  const normalized = staticRelativePath.replace(/\\/g, "/");
  if (normalized === "index.html" || normalized.endsWith("/index.html")) {
    return STATIC_INDEX_CACHE_CONTROL;
  }

  const basename = normalized.split("/").at(-1) ?? normalized;
  const hasBuildHash = /(?:^|[-.])[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/u.test(basename);
  return hasBuildHash ? STATIC_IMMUTABLE_CACHE_CONTROL : STATIC_INDEX_CACHE_CONTROL;
}

/**
 * Weak, metadata-derived ETag for a static file (size + mtime). Weak because
 * metadata-derived tags do not prove byte-for-byte identity; comparison is
 * opaque per RFC 9110 §8.8.3.
 */
export function staticFileEtag(fileInfo: {
  readonly size: bigint;
  readonly mtime: Option.Option<Date>;
}): string | null {
  const mtimeMs = Option.match(fileInfo.mtime, {
    onNone: () => null,
    onSome: (date) => (Number.isFinite(date.getTime()) ? date.getTime() : null),
  });
  if (mtimeMs === null) {
    return null;
  }
  return `W/"${fileInfo.size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
}

/**
 * RFC 9110 §13.1.2 If-None-Match evaluation for cache revalidation. Weak
 * comparison (ignores the `W/` prefix), `*` matches any representation.
 */
export function ifNoneMatchSatisfies(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed === "*") {
    return true;
  }
  const target = etag.replace(/^W\//i, "");
  return trimmed.split(",").some((candidate) => candidate.trim().replace(/^W\//i, "") === target);
}

/** Build a download disposition with a safe ASCII fallback and UTF-8 filename. */
export function downloadContentDisposition(fileName?: string): string {
  if (fileName === undefined) {
    return "attachment";
  }

  // encodeURIComponent rejects unpaired surrogates, and control characters,
  // quotes, and backslashes are unsafe in the quoted fallback parameter.
  // eslint-disable-next-line no-control-regex
  const sanitized = fileName.toWellFormed().replace(/[\u0000-\u001f"\\]/g, "_");
  const asciiFallback = sanitized.replace(/[^\u0020-\u007e]/g, "_");
  const extendedName = encodeURIComponent(sanitized).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"${
    asciiFallback === sanitized ? "" : `; filename*=UTF-8''${extendedName}`
  }`;
}

export function userAssetResponseHeaders(
  filePath: string,
  path: Pick<Path.Path, "basename" | "extname">,
): Record<string, string> {
  const extension = path.extname(filePath).toLowerCase();
  const download = !INLINE_ATTACHMENT_EXTENSIONS.has(extension);

  return {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...(download
      ? {
          "Content-Disposition": downloadContentDisposition(path.basename(filePath)),
          "Content-Security-Policy": DOWNLOAD_CONTENT_SECURITY_POLICY,
          "Content-Type": "application/octet-stream",
        }
      : extension === ".svg"
        ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
        : {}),
  };
}

export function inlineImageResponseHeaders(filePath: string): Record<string, string> {
  return {
    "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
    ...(filePath.toLowerCase().endsWith(".svg")
      ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
      : {}),
  };
}

function resolveStaticContentType(filePath: string, path: Path.Path): string {
  return STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

const staticFileResponse = (input: {
  readonly filePath: string;
  readonly staticRelativePath: string;
  readonly fileInfo: FileSystem.File.Info;
  readonly ifNoneMatch?: string | undefined;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const cacheControl = resolveStaticCacheControl(input.staticRelativePath);
    const etag = staticFileEtag(input.fileInfo);
    const headers: Record<string, string> = { "Cache-Control": cacheControl };
    if (etag) {
      // Revalidation hit: no body is produced and the platform never opens
      // the file, so a repeat visit to a hot asset costs one stat + one 304.
      if (ifNoneMatchSatisfies(input.ifNoneMatch, etag)) {
        return HttpServerResponse.empty({ status: 304, headers: { ...headers, ETag: etag } });
      }
      headers.ETag = etag;
    }
    // File bodies stream from the platform (`HttpServerResponse.file` is a
    // lazy platform file response) — never a whole-file memory buffer.
    return yield* HttpServerResponse.file(input.filePath, {
      status: 200,
      contentType: resolveStaticContentType(input.filePath, path),
      headers,
    }).pipe(
      // The platform generates its own ETag; restore the validator used above.
      Effect.map(HttpServerResponse.setHeaders(headers)),
    );
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
    ),
  );

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

const serverEnvironmentRouteHandler = Effect.gen(function* () {
  const descriptor = yield* Effect.service(ServerEnvironment).pipe(
    Effect.flatMap((serverEnvironment) => serverEnvironment.getDescriptor),
  );
  return HttpServerResponse.jsonUnsafe(descriptor, { status: 200 });
});

export const serverEnvironmentRouteLayer = HttpRouter.add(
  "GET",
  SERVER_ENVIRONMENT_DESCRIPTOR_PATH,
  serverEnvironmentRouteHandler,
);

export const legacyServerEnvironmentRouteLayer = HttpRouter.add(
  "GET",
  LEGACY_SERVER_ENVIRONMENT_DESCRIPTOR_PATH,
  serverEnvironmentRouteHandler,
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Trace export failed.", { status: 502 })),
        ),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const INLINE_MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
};

/** A single byte range; malformed or multipart ranges are served in full. */
export function parseAttachmentByteRange(
  range: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const match = range?.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size
  ) {
    return "unsatisfiable";
  }
  return { start, end };
}

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const downloadName = url.value.searchParams.get("download");
    if (
      downloadName !== null &&
      (downloadName.length === 0 || downloadName.length > 255 || /[/\\\p{Cc}]/u.test(downloadName))
    ) {
      return HttpServerResponse.text("Invalid download name", { status: 400 });
    }
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const extension =
      path.extname(filePath) ||
      (isIdLookup ? attachmentIdExtensionSegment(normalizedRelativePath) : null) ||
      "";
    const mediaContentType = INLINE_MEDIA_CONTENT_TYPES[extension.toLowerCase()];
    const size = Number(fileInfo.size);
    // If-Range validators are not compared here: sending the complete response
    // is the safe fallback instead of returning a potentially mismatched slice.
    const range =
      mediaContentType && !request.headers["if-range"]
        ? parseAttachmentByteRange(request.headers.range, size)
        : null;
    if (range === "unsatisfiable") {
      return HttpServerResponse.empty({
        status: 416,
        headers: {
          "Content-Range": `bytes */${size}`,
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
    const mediaDimensions = yield* probeAttachmentMediaForServing(filePath, extension);
    const mediaHeaders = mediaDimensions
      ? {
          "X-Attachment-Width": String(mediaDimensions.width),
          "X-Attachment-Height": String(mediaDimensions.height),
        }
      : {};

    return yield* HttpServerResponse.file(filePath, {
      status: range ? 206 : 200,
      ...(range ? { offset: range.start, bytesToRead: range.end - range.start + 1 } : {}),
      headers: {
        ...(mediaContentType
          ? {
              "Content-Type": mediaContentType,
              "Cache-Control": "private, max-age=3600",
              "X-Content-Type-Options": "nosniff",
              "Accept-Ranges": "bytes",
            }
          : userAssetResponseHeaders(filePath, path)),
        ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
        ...mediaHeaders,
        ...(downloadName !== null
          ? { "Content-Disposition": downloadContentDisposition(downloadName) }
          : {}),
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const UPLOAD_BODY_TOO_LARGE_STATUS = 413;

class UploadBodyTooLargeError extends Data.TaggedError("UploadBodyTooLargeError")<{}> {}

/**
 * Streams the upload request body to the `<final>.part` staging file without
 * buffering it in memory. The staging file lives outside the attachment id
 * namespace so orphan sweeps can never touch a mid-upload file, and it is
 * removed on every failure path.
 */
const streamUploadBodyToPartFile = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly lease: ChatAttachmentUploadLease;
}) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => open(input.lease.partPath, "w")),
    (handle) =>
      Effect.gen(function* () {
        let written = 0;
        yield* Stream.runForEach(input.stream, (chunk) =>
          Effect.gen(function* () {
            written += chunk.byteLength;
            if (written > input.lease.maxBytes) {
              return yield* Effect.fail(new UploadBodyTooLargeError());
            }
            yield* Effect.tryPromise(() => handle.writeFile(chunk));
          }),
        );
        if (written !== input.lease.sizeBytes) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "invalid-request",
              status: 400,
              message: "File upload ended before the declared size was received.",
            }),
          );
        }
        yield* Effect.tryPromise(() => handle.sync());
      }),
    (handle, exit) =>
      Effect.tryPromise(() => handle.close()).pipe(
        Effect.ignore,
        Effect.andThen(
          exit._tag === "Failure"
            ? Effect.tryPromise(() => unlink(input.lease.partPath)).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
  );

const removePartFile = (partPath: string) =>
  Effect.tryPromise(() => unlink(partPath)).pipe(Effect.ignore);

export const attachmentUploadRouteLayer = HttpRouter.add(
  "POST",
  `${ATTACHMENTS_ROUTE_PREFIX}/upload`,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const uploadToken = url.value.searchParams.get("token");
    if (!uploadToken) {
      return HttpServerResponse.text("Missing upload token", { status: 400 });
    }

    const uploads = yield* ChatAttachmentUploads;
    const beginResult = yield* Effect.result(uploads.beginUpload(uploadToken));
    if (beginResult._tag === "Failure") {
      return HttpServerResponse.text(beginResult.failure.message, {
        status: beginResult.failure.status,
      });
    }
    const lease = beginResult.success;

    return yield* Effect.gen(function* () {
      const contentLength = Number(request.headers["content-length"] ?? "0");
      if (Number.isFinite(contentLength) && contentLength > lease.maxBytes) {
        yield* uploads.abortUpload(uploadToken).pipe(Effect.ignore);
        return HttpServerResponse.text("Upload exceeds the declared attachment size.", {
          status: UPLOAD_BODY_TOO_LARGE_STATUS,
        });
      }

      const streamResult = yield* Effect.result(
        streamUploadBodyToPartFile({ stream: request.stream, lease }).pipe(
          Effect.catchTag("UploadBodyTooLargeError", () =>
            Effect.fail(
              new ChatAttachmentUploadError({
                reason: "invalid-request",
                status: UPLOAD_BODY_TOO_LARGE_STATUS,
                message: "Upload exceeds the declared attachment size.",
              }),
            ),
          ),
          Effect.mapError((cause) =>
            cause instanceof ChatAttachmentUploadError
              ? cause
              : new ChatAttachmentUploadError({
                  reason: "invalid-request",
                  status: 400,
                  message: "File upload stream failed before completion.",
                }),
          ),
        ),
      );
      if (streamResult._tag === "Failure") {
        yield* uploads.abortUpload(uploadToken).pipe(Effect.ignore);
        yield* removePartFile(lease.partPath);
        return HttpServerResponse.text(streamResult.failure.message, {
          status: streamResult.failure.status,
        });
      }

      const renameResult = yield* Effect.result(
        Effect.tryPromise(() => rename(lease.partPath, lease.finalPath)),
      );
      if (renameResult._tag === "Failure") {
        yield* uploads.abortUpload(uploadToken).pipe(Effect.ignore);
        yield* removePartFile(lease.partPath);
        return HttpServerResponse.text("Failed to persist the uploaded attachment.", {
          status: 500,
        });
      }

      const mediaDimensions = yield* probeAttachmentMediaDimensions(
        lease.finalPath,
        lease.mimeType,
      );
      const completeResult = yield* Effect.result(
        uploads.completeUpload(uploadToken, mediaDimensions),
      );
      if (completeResult._tag === "Failure") {
        yield* Effect.tryPromise(() => unlink(lease.finalPath)).pipe(Effect.ignore);
        return HttpServerResponse.text(completeResult.failure.message, {
          status: completeResult.failure.status,
        });
      }

      return HttpServerResponse.jsonUnsafe({
        attachmentTokenRef: uploadToken,
        id: lease.attachmentId,
        name: lease.name,
        mimeType: lease.mimeType,
        sizeBytes: lease.sizeBytes,
        ...(mediaDimensions
          ? { width: mediaDimensions.width, height: mediaDimensions.height }
          : {}),
      });
    }).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          yield* uploads.abortUpload(uploadToken);
          yield* removePartFile(lease.partPath);
          yield* removePartFile(lease.finalPath);
        }),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: inlineImageResponseHeaders("fallback.svg"),
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: inlineImageResponseHeaders(faviconFilePath),
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const AvatarFormSchema = Schema.Struct({
  avatar: Multipart.SingleFileSchema,
});

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const projectAvatarUploadRouteLayer = HttpRouter.add(
  "POST",
  "/api/project-avatar/upload",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const projectId = url.value.searchParams.get("projectId");
    if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) {
      return HttpServerResponse.text("Invalid projectId", { status: 400 });
    }

    const contentLength = Number(request.headers["content-length"] ?? "0");
    if (contentLength > PROJECT_AVATAR_MAX_BYTES) {
      return HttpServerResponse.text("Payload too large", { status: 413 });
    }

    const form = yield* HttpServerRequest.schemaBodyForm(AvatarFormSchema).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!form) return HttpServerResponse.text("Bad Request", { status: 400 });

    const file = form.avatar;
    const fileSystem = yield* FileSystem.FileSystem;
    const fileBytes = yield* fileSystem.readFile(file.path);
    if (fileBytes.length > PROJECT_AVATAR_MAX_BYTES) {
      return HttpServerResponse.text("Payload too large", { status: 413 });
    }

    const store = yield* ProjectAvatarStore;
    const writeResult = yield* Effect.result(
      store.write({
        projectId: projectId as ProjectId,
        bytes: Buffer.from(fileBytes),
        contentType: file.contentType,
      }),
    );
    if (writeResult._tag === "Failure") {
      return HttpServerResponse.text(writeResult.failure.message, { status: 400 });
    }
    return HttpServerResponse.jsonUnsafe(writeResult.success);
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const projectAvatarServeRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-avatar",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const projectId = url.value.searchParams.get("projectId");
    if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) {
      return HttpServerResponse.text("Invalid projectId", { status: 400 });
    }

    const store = yield* ProjectAvatarStore;
    const stored = yield* store.read(projectId as ProjectId);
    if (!stored) return HttpServerResponse.text("Not Found", { status: 404 });
    return HttpServerResponse.uint8Array(stored.bytes, {
      status: 200,
      contentType: "image/png",
      headers: {
        "Cache-Control": PROJECT_AVATAR_CACHE_CONTROL,
        ETag: `"${stored.contentHash}"`,
      },
    });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir = config.staticDir ?? (config.devUrl ? yield* resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexInfo = yield* fileSystem
        .stat(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexInfo || indexInfo.type !== "File") {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return yield* staticFileResponse({
        filePath: indexPath,
        staticRelativePath: "index.html",
        fileInfo: indexInfo,
        ifNoneMatch: request.headers["if-none-match"],
      });
    }

    return yield* staticFileResponse({
      filePath,
      staticRelativePath,
      fileInfo,
      ifNoneMatch: request.headers["if-none-match"],
    });
  }),
);
