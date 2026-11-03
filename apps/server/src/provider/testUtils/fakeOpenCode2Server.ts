/**
 * An OpenCode 2.x server in process for tests of the 2.x facade (`openCodeV2Client.ts`) and of
 * what runs on it: a `fetch` that answers from routes keyed by `METHOD /path` and records every
 * call, and an `/api/event` stream the test writes to.
 */

export interface OpenCode2Call {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly headers: Headers;
}

export type OpenCode2Route = (
  call: OpenCode2Call,
  signal: AbortSignal | undefined,
) => Response | Promise<Response>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const noContent = () => new Response(null, { status: 204 });

/** Answers from `routes`, which the caller may change between requests; an unknown route fails. */
export function fakeOpenCode2Server(routes: Readonly<Record<string, OpenCode2Route>>) {
  const calls: Array<OpenCode2Call> = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    if (init.signal?.aborted) throw init.signal.reason;
    const url = new URL(String(input));
    const call: OpenCode2Call = {
      method: init.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init.headers),
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (!route) throw new Error(`Unexpected request: ${call.method} ${call.path}`);
    return route(call, init.signal ?? undefined);
  };
  return {
    calls,
    requests: () => calls.map((call) => `${call.method} ${call.path}`),
    fetch: fetch as typeof globalThis.fetch,
  };
}

/**
 * One `/api/event` response the test writes to. Like undici's, its body errors once the request's
 * signal aborts.
 */
export function openCode2EventStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { aborted: false, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start: (streamController) => {
      controller = streamController;
    },
    cancel: () => {
      state.cancelled = true;
    },
  });
  const write = (chunk: string | Uint8Array) =>
    controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
  const route: OpenCode2Route = (_call, signal) => {
    signal?.addEventListener(
      "abort",
      () => {
        state.aborted = true;
        controller.error(signal.reason);
      },
      { once: true },
    );
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  return {
    route,
    write,
    emit: (event: unknown) => write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => controller.close(),
    state,
  };
}
