import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  ExecutionEnvironmentDescriptor,
} from "@ryco/contracts";

import type { HttpClientService } from "../platform/index.ts";
import { fetchWithDeadline, REMOTE_CONTROL_PLANE_REQUEST_TIMEOUT_MS } from "./fetchWithDeadline.ts";

export class RemoteEnvironmentAuthHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteEnvironmentAuthHttpError";
    this.status = status;
  }
}

export function isRemoteEnvironmentAuthHttpError(
  error: unknown,
): error is RemoteEnvironmentAuthHttpError {
  return error instanceof RemoteEnvironmentAuthHttpError;
}

function remoteEndpointUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  return url.toString();
}

async function readRemoteAuthErrorMessage(
  response: Awaited<ReturnType<HttpClientService["fetch"]>>,
  fallbackMessage: string,
): Promise<string> {
  const text = await response.text();
  if (!text) return fallbackMessage;
  try {
    const parsed = JSON.parse(text) as { readonly error?: string };
    if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
  } catch {
    // Fall back to raw text below.
  }
  return text;
}

async function fetchRemoteJson<T>(
  httpClient: HttpClientService,
  input: {
    readonly httpBaseUrl: string;
    readonly pathname: string;
    readonly method?: "GET" | "POST";
    readonly bearerToken?: string;
    readonly body?: unknown;
    readonly signal?: AbortSignal;
  },
): Promise<T> {
  const requestUrl = remoteEndpointUrl(input.httpBaseUrl, input.pathname);
  let response: Awaited<ReturnType<HttpClientService["fetch"]>>;
  try {
    response = await fetchWithDeadline(
      httpClient,
      requestUrl,
      {
        method: input.method ?? "GET",
        headers: {
          ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
        },
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      REMOTE_CONTROL_PLANE_REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    throw new Error(
      `Failed to fetch remote auth endpoint ${requestUrl} (${(error as Error).message}).`,
      {
        cause: error,
      },
    );
  }
  if (!response.ok) {
    throw new RemoteEnvironmentAuthHttpError(
      await readRemoteAuthErrorMessage(
        response,
        `Remote auth request failed (${response.status}).`,
      ),
      response.status,
    );
  }
  return (await response.json()) as T;
}

export function createRemoteEnvironmentApi(httpClient: HttpClientService, baseOrigin: string) {
  return {
    bootstrapRemoteBearerSession: async (input: {
      readonly httpBaseUrl: string;
      readonly credential: string;
    }) =>
      fetchRemoteJson<AuthBearerBootstrapResult>(httpClient, {
        httpBaseUrl: input.httpBaseUrl,
        pathname: "/api/auth/bootstrap/bearer",
        method: "POST",
        body: { credential: input.credential },
      }),
    fetchRemoteSessionState: async (input: {
      readonly httpBaseUrl: string;
      readonly bearerToken: string;
      /** Abandons the request when its connect attempt is given up. */
      readonly signal?: AbortSignal;
    }) =>
      fetchRemoteJson<AuthSessionState>(httpClient, {
        httpBaseUrl: input.httpBaseUrl,
        pathname: "/api/auth/session",
        bearerToken: input.bearerToken,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    /**
     * Renews a direct pairing's bearer: the node answers with its successor,
     * which supersedes the presented bearer once first used.
     */
    rotateRemoteBearerSession: async (input: {
      readonly httpBaseUrl: string;
      readonly bearerToken: string;
      readonly signal?: AbortSignal;
    }) =>
      fetchRemoteJson<AuthBearerBootstrapResult>(httpClient, {
        httpBaseUrl: input.httpBaseUrl,
        pathname: "/api/auth/bearer/rotate",
        method: "POST",
        bearerToken: input.bearerToken,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    fetchRemoteEnvironmentDescriptor: async (input: { readonly httpBaseUrl: string }) =>
      fetchRemoteJson<ExecutionEnvironmentDescriptor>(httpClient, {
        httpBaseUrl: input.httpBaseUrl,
        pathname: "/.well-known/ryco/environment",
      }),
    issueRemoteWebSocketToken: async (input: {
      readonly httpBaseUrl: string;
      readonly bearerToken: string;
    }) =>
      fetchRemoteJson<AuthWebSocketTokenResult>(httpClient, {
        httpBaseUrl: input.httpBaseUrl,
        pathname: "/api/auth/ws-token",
        method: "POST",
        bearerToken: input.bearerToken,
      }),
    resolveRemoteWebSocketConnectionUrl: async (input: {
      readonly wsBaseUrl: string;
      readonly httpBaseUrl: string;
      readonly bearerToken: string;
      /** Abandons the token request when its connect attempt gives up. */
      readonly signal?: AbortSignal;
    }) => {
      const issued = await fetchRemoteJson<AuthWebSocketTokenResult>(httpClient, {
        httpBaseUrl: input.httpBaseUrl,
        pathname: "/api/auth/ws-token",
        method: "POST",
        bearerToken: input.bearerToken,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const url = new URL(input.wsBaseUrl, baseOrigin);
      url.searchParams.set("wsToken", issued.token);
      return url.toString();
    },
  };
}
