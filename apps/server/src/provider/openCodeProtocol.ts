/**
 * Talking to an OpenCode server before the first mutation: which API generation a URL speaks
 * (detected with read-only GETs before Ryco creates a client for it, so no mutation ever reaches a
 * server on the wrong API), the client for it, and the version check every caller runs next.
 *
 * Each generation identifies itself on its own route: 1.x on `/global/health`, 2.x on `/api/info`
 * (`{ version, pid }`, which the 2.x CLI decodes too). The other generation's route lands in that
 * server's catch-all for unknown paths, which serves the web app or, with the embedded app
 * disabled, proxies the request to app.opencode.ai with its Authorization header (and answers 500
 * while offline). Both generations have such a catch-all, so whichever route goes first, a server
 * of the other generation gets one request that can carry the password off the machine.
 * Detection therefore asks first for the route of the generation it last detected at the same URL
 * in this process, and `/global/health` when it has none: that is the request Ryco always sent,
 * so a 1.x server never sees a new path. The memo only orders the requests; every answer is
 * checked again, so a server that changed generation costs one extra request. What remains is the
 * first detection of a 2.x server in a process, which still sends one `/global/health`. Once Ryco
 * spawns 2.x servers, an owned server's generation (known from its verified binary) should set the
 * order (`likelyGeneration`) instead.
 *
 * Detection failures carry fixed text: underlying fetch errors can include the URL or its
 * credentials. Both read-only checks fail a session start when they expire, so they run on
 * stall-tolerant deadlines (`timeoutWhileResponsiveOption`). Loaded through `import()` by
 * `opencodeRuntime.ts`, so none of it is in the boot chunk.
 */
import { timeoutWhileResponsiveOption } from "@ryco/shared/responsiveDeadline";
import { Effect, Option } from "effect";

import type { OpenCodeApi } from "./openCodeApi.ts";
import {
  lazyOpenCodeModule,
  OpenCodeRuntimeError,
  runOpenCodeSdk,
  type OpenCodeRuntimeShape,
} from "./opencodeRuntime.ts";
import {
  classifyOpenCodeGeneration,
  describeUnsupportedOpenCodeVersion,
  normalizeOpenCodeVersion,
  OPENCODE_NON_JSON_HEALTH_MESSAGE,
  OPENCODE_V2_ADVISORY_MESSAGE,
  type OpenCodeGeneration,
} from "./openCodeVersion.ts";

export type OpenCodeApiDetection =
  | { readonly generation: "v1" }
  | { readonly generation: "v2"; readonly version: string };

/** Budget for API detection and for the version check, each. */
const VERSION_CHECK_TIMEOUT_MS = 5_000;

export const OPENCODE_VERSION_CHECK_TIMEOUT_MESSAGE =
  "Timed out while checking the OpenCode server version.";

export const OPENCODE_REJECTED_PASSWORD_MESSAGE =
  "401 Unauthorized: the OpenCode server rejected the password.";

const HEALTH_PATH = "/global/health";
const INFO_PATH = "/api/info";

interface ProbeResponse {
  readonly status: number;
  /** The parsed body of a 200 `application/json` response; otherwise undefined. */
  readonly json: unknown;
}

/**
 * The `Authorization` header for a server password (both generations take Basic auth as user
 * `opencode`). UTF-8, as the 1.x SDK client sends it; `btoa` is Latin-1 and throws on other
 * characters.
 */
export const openCodeBasicAuthorization = (password: string) =>
  `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Fixed text for a failed request: the underlying error can carry the URL or its credentials. */
function requestFailure(cause: unknown): Error {
  // Node's fetch refuses `http://user:pass@host` URLs.
  if (cause instanceof TypeError && cause.message.includes("includes credentials")) {
    return new Error(
      "The OpenCode server URL includes credentials. Remove them and set the server password instead.",
    );
  }
  return new Error("Couldn't reach the OpenCode server.");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** True for a healthy `/global/health` answer that reports a 1.x version. */
const isV1Health = (json: unknown): boolean =>
  isRecord(json) &&
  json.healthy === true &&
  typeof json.version === "string" &&
  classifyOpenCodeGeneration(json.version) === "v1";

/** The version in a `/api/info` answer (`{ version, pid }`); otherwise undefined. */
const infoVersion = (json: unknown): string | undefined =>
  isRecord(json) && typeof json.version === "string" && Number.isInteger(json.pid)
    ? json.version
    : undefined;

/**
 * Resolves the server's API generation; rejects with an `Error` whose message is fixed text (a
 * rejected password, an unreachable server, an unexpected status or a version this build
 * refuses). 1.x is returned whenever the server does not identify itself as 2.x: the 1.x client's
 * first request is the strict `/global/health` check, which names the problem. Has no deadline of
 * its own: `detectOpenCodeServerApi` applies one and aborts `signal`.
 */
export async function detectOpenCodeApi(input: {
  readonly baseUrl: string;
  readonly serverPassword?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetch?: ((url: URL, init: RequestInit) => Promise<Response>) | undefined;
  /**
   * Asks this generation's route first (see the module comment). Orders the requests only: the
   * answer decides, never this hint.
   */
  readonly likelyGeneration?: OpenCodeGeneration | undefined;
}): Promise<OpenCodeApiDetection> {
  const base = URL.parse(input.baseUrl.trim());
  if (base === null || (base.protocol !== "http:" && base.protocol !== "https:")) {
    throw new Error("The OpenCode server URL is not a valid http:// or https:// URL.");
  }
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = input.serverPassword
    ? { Authorization: openCodeBasicAuthorization(input.serverPassword) }
    : {};

  const get = async (path: string): Promise<ProbeResponse> => {
    const url = new URL(base);
    // Keeps a path prefix: `http://host/proxy/` → `http://host/proxy/api/info`.
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
    let status: number;
    let body: string | undefined;
    try {
      const response = await fetchImpl(url, { headers, signal: input.signal ?? null });
      status = response.status;
      const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (status === 200 && mediaType === "application/json") {
        body = await response.text();
      } else {
        // A web app shell or an error page: release the connection without reading it.
        await response.body?.cancel().catch(() => undefined);
      }
    } catch (cause) {
      throw requestFailure(cause);
    }
    // Both generations answer a missing or wrong password with 401 on every path.
    if (status === 401 || status === 403) {
      throw new Error(OPENCODE_REJECTED_PASSWORD_MESSAGE);
    }
    return { status, json: body === undefined ? undefined : parseJson(body) };
  };

  const order =
    input.likelyGeneration === "v2" ? [INFO_PATH, HEALTH_PATH] : [HEALTH_PATH, INFO_PATH];
  let infoStatus = 0;
  for (const path of order) {
    const { status, json } = await get(path);
    if (path === HEALTH_PATH) {
      if (isV1Health(json)) {
        return { generation: "v1" };
      }
      continue;
    }
    infoStatus = status;
    const version = infoVersion(json);
    if (version === undefined) {
      continue;
    }
    const generation = classifyOpenCodeGeneration(version);
    if (generation === "v2") {
      return { generation, version: normalizeOpenCodeVersion(version) };
    }
    if (generation === "v1") {
      return { generation };
    }
    // Fails closed: 3.x and later, 0.x and unparseable versions.
    throw new Error(
      describeUnsupportedOpenCodeVersion(version, "server") ??
        "The OpenCode server reported a version this Ryco release does not support.",
    );
  }
  // 1.x serves its web app (or a 404) for unknown paths.
  if (infoStatus === 404 || infoStatus === 405 || (infoStatus >= 200 && infoStatus < 300)) {
    return { generation: "v1" };
  }
  throw new Error(`The OpenCode server returned HTTP ${infoStatus}.`);
}

/** URLs whose last detection found 2.x, oldest first; they only order the next detection. */
const detectedV2Urls = new Set<string>();
const DETECTED_V2_URL_LIMIT = 64;

/** The memo key: origin and path prefix, without credentials, query or trailing slashes. */
function detectionKey(baseUrl: string): string | undefined {
  const url = URL.parse(baseUrl.trim());
  return url === null ? undefined : `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function rememberDetection(key: string | undefined, generation: OpenCodeGeneration): void {
  if (key === undefined) {
    return;
  }
  detectedV2Urls.delete(key);
  if (generation !== "v2") {
    return;
  }
  detectedV2Urls.add(key);
  if (detectedV2Urls.size > DETECTED_V2_URL_LIMIT) {
    detectedV2Urls.delete(detectedV2Urls.values().next().value!);
  }
}

/**
 * `detectOpenCodeApi` within its stall-tolerant deadline, ordered by the generation last detected
 * at the same URL (see the module comment).
 */
export const detectOpenCodeServerApi = (
  input: Omit<Parameters<typeof detectOpenCodeApi>[0], "signal" | "likelyGeneration">,
): Effect.Effect<OpenCodeApiDetection, OpenCodeRuntimeError> => {
  const key = detectionKey(input.baseUrl);
  return runOpenCodeSdk("api.detect", (signal) =>
    detectOpenCodeApi({
      ...input,
      signal,
      ...(key !== undefined && detectedV2Urls.has(key) ? { likelyGeneration: "v2" } : {}),
    }),
  ).pipe(
    timeoutWhileResponsiveOption(VERSION_CHECK_TIMEOUT_MS),
    Effect.flatMap((result) => {
      if (Option.isNone(result)) {
        return Effect.fail(
          new OpenCodeRuntimeError({
            operation: "api.detect",
            detail: OPENCODE_VERSION_CHECK_TIMEOUT_MESSAGE,
          }),
        );
      }
      rememberDetection(key, result.value.generation);
      return Effect.succeed(result.value);
    }),
  );
};

const loadOpenCodeSdk = lazyOpenCodeModule("SDK", () => import("@opencode-ai/sdk/v2"));

/** `OpenCodeRuntimeShape.createOpenCodeSdkClient`: detects the API before returning a client. */
export const createOpenCodeApi = (
  input: Parameters<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>[0],
): Effect.Effect<OpenCodeApi, OpenCodeRuntimeError> =>
  Effect.gen(function* () {
    const api = yield* detectOpenCodeServerApi({
      baseUrl: input.baseUrl,
      serverPassword: input.serverPassword,
    });
    // Refused before any client exists; the 2.x facade loads here once
    // `OPENCODE_V2_RUNTIME_SUPPORTED` is on.
    if (api.generation === "v2") {
      return yield* new OpenCodeRuntimeError({
        operation: "createOpenCodeSdkClient",
        detail:
          describeUnsupportedOpenCodeVersion(api.version, "server") ?? OPENCODE_V2_ADVISORY_MESSAGE,
      });
    }
    const { createOpencodeClient } = yield* loadOpenCodeSdk;
    return createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      ...(input.serverPassword
        ? { headers: { Authorization: openCodeBasicAuthorization(input.serverPassword) } }
        : {}),
      throwOnError: true,
    });
  });

/** The body of `verifyOpenCodeServerVersion` (`opencodeRuntime.ts`), which callers import. */
export const checkOpenCodeServerVersion = (
  client: OpenCodeApi,
): Effect.Effect<string, OpenCodeRuntimeError> =>
  runOpenCodeSdk("global.health", (signal) => client.global.health({ signal })).pipe(
    timeoutWhileResponsiveOption(VERSION_CHECK_TIMEOUT_MS),
    Effect.flatMap((result) => {
      if (Option.isNone(result)) {
        return Effect.fail(
          new OpenCodeRuntimeError({
            operation: "global.health",
            detail: OPENCODE_VERSION_CHECK_TIMEOUT_MESSAGE,
          }),
        );
      }
      // The SDK parses `text/*` responses as text, so an HTML page (a proxy or a sign-in page)
      // arrives here as a string rather than a health object.
      const raw: unknown = result.value.data;
      if (typeof raw === "string") {
        return Effect.fail(
          new OpenCodeRuntimeError({
            operation: "global.health",
            detail: OPENCODE_NON_JSON_HEALTH_MESSAGE,
          }),
        );
      }
      const health = result.value.data;
      if (!health?.healthy || typeof health.version !== "string" || health.version.length === 0) {
        return Effect.fail(
          new OpenCodeRuntimeError({
            operation: "global.health",
            detail: "OpenCode server health check returned an invalid response.",
          }),
        );
      }
      // Fails closed: an unparseable or unsupported version is refused, never compared as a
      // string. The reported generation must match the client's API: a server that did not
      // identify itself as OpenCode 2 at detection but reports 2.x here gets no mutation.
      const version = normalizeOpenCodeVersion(health.version);
      const problem =
        describeUnsupportedOpenCodeVersion(version, "server") ??
        (classifyOpenCodeGeneration(version) === (client.generation ?? "v1")
          ? null
          : `The OpenCode server reports v${version} but did not identify itself as OpenCode ${Number.parseInt(version, 10)}.`);
      return problem === null
        ? Effect.succeed(version)
        : Effect.fail(new OpenCodeRuntimeError({ operation: "global.health", detail: problem }));
    }),
  );
