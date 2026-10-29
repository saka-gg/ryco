/**
 * The OpenCode 2.x facade: an `OpenCodeApi` (the 1.x SDK surface Ryco's adapter, provider probe and
 * text generation call) answered by the 2.x API, so none of them has to change for 2.x. Responses
 * keep the 1.x `{ data }` envelope and shapes (`openCodeV2Mapping.ts`), and the event stream yields
 * 1.x events (`openCodeV2Events.ts`). Adapted from Synara (`openCodeV2Client.ts`).
 *
 * `createOpenCodeSdkClient` detects the server's generation before it creates a client, so a
 * facade only ever talks to a 2.x server: it is a separate object (the 1.x SDK client is never
 * patched), and a failed request is never retried on the 1.x API. Requests go through the official
 * promise client (`@opencode/client`), which needs neither effect nor the protocol schemas. The
 * event stream has its own reader, because that client ends the stream on the first frame it
 * cannot parse: this one skips such frames, still ends a turn from an execution end it cannot
 * fully read (T3 `OpenCode2Client.ts`), and fails a stream that goes silent.
 *
 * Model `settings` (2.x model lists carry provider keys there) never leave the mapping, and nothing
 * here calls `/api/credential` or `/api/integration`. Loaded through `import()`, so none of it is
 * in the boot chunk.
 */
import {
  OpenCode,
  type FormInfo,
  type OpenCodeEvent,
  type SessionInfo,
  type SessionMessageAssistant,
  type SessionMessageIdle,
} from "@opencode/client";
import type { McpStatus, OpencodeClient, Session } from "@opencode-ai/sdk/v2";

import type { OpenCodeApi } from "./openCodeApi.ts";
import {
  OPENCODE_REJECTED_PASSWORD_MESSAGE,
  openCodeBasicAuthorization,
} from "./openCodeProtocol.ts";
import {
  createOpenCodeV2EventMapper,
  openCodeV2AssistantMessage,
  openCodeV2Message,
  type OpenCodeV1Event,
  type OpenCodeV1Message,
} from "./openCodeV2Events.ts";
import {
  openCodeV2Agent,
  openCodeV2DefaultAgent,
  openCodeV2FormResponse,
  openCodeV2McpConfig,
  openCodeV2ModelRef,
  openCodeV2Permission,
  openCodeV2Prompt,
  openCodeV2ProviderList,
  openCodeV2Question,
  openCodeV2Rules,
  openCodeV2Session,
  type OpenCodeV2Form,
} from "./openCodeV2Mapping.ts";

/** A stream gets this long for its first event, as the adapter allows a 1.x stream. */
const STREAM_OPEN_TIMEOUT_MS = 10_000;
/** Heartbeats arrive every 10-15 seconds; a longer silence means a stuck server, not an idle one. */
const STREAM_SILENCE_TIMEOUT_MS = 45_000;
/** The largest event the reader buffers (in UTF-16 code units), as `@opencode/client` allows. */
const MAX_SSE_EVENT_LENGTH = 16 * 1024 * 1024;

const MCP_POLL_INTERVAL_MS = 100;
const MCP_CONNECT_TIMEOUT_MS = 9_000;
/**
 * 2.x reports an MCP server connected before its tool registry reloads (debounced by 100 ms in
 * 2.0.25, with no catalog-ready API), so the first prompt waits this long (Synara).
 */
const MCP_SETTLE_MS = 200;

const SESSION_PAGE_SIZE = 100;
/** The most `message.list` returns per page. */
const MESSAGE_PAGE_SIZE = 200;

/** Bound on each per-session or per-form memo; the oldest entry goes first. */
const MEMO_LIMIT = 256;

export const OPENCODE_V2_STREAM_OPEN_TIMEOUT_MESSAGE = "Timed out opening OpenCode event stream.";
export const OPENCODE_V2_SILENT_STREAM_MESSAGE = "The OpenCode server stopped sending events.";
export const OPENCODE_V2_CLOSED_STREAM_MESSAGE = "The OpenCode server closed its event stream.";

export interface OpenCodeV2ApiInput {
  readonly baseUrl: string;
  /** The project directory every location-scoped call (lists, session and MCP creation) names. */
  readonly directory: string;
  readonly serverPassword?: string | undefined;
  /** Replaces the network; tests answer from an in-process server. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

type CallOptions = { readonly signal?: AbortSignal | null | undefined } | undefined;

const requestOptions = (options: CallOptions) =>
  options?.signal ? { signal: options.signal } : undefined;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** Sets `key` as the newest entry, dropping the oldest past {@link MEMO_LIMIT}. */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MEMO_LIMIT) map.delete(map.keys().next().value!);
}

/**
 * 2.x answers a missing session, message or form with a tagged error that has no status, while
 * Ryco tells a missing session apart by the 404 the 1.x SDK reported (`isOpenCodeNotFound` reads
 * `cause.status`).
 */
function withNotFoundStatus(error: unknown): unknown {
  const tag = isRecord(error) ? error._tag : undefined;
  if (typeof tag !== "string" || !tag.endsWith("NotFoundError")) return error;
  return new Error(error instanceof Error && error.message ? error.message : tag, {
    cause: { status: 404, error },
  });
}

type V1Method = (...args: never[]) => unknown;
/** What a 1.x SDK method resolves with under `data`. */
type V1Data<F extends V1Method> = Exclude<
  Awaited<ReturnType<F>> extends { readonly data: infer D } ? D : never,
  undefined
>;

/**
 * A 1.x SDK method answered by `run`, whose result becomes `data`. The SDK's methods are generic
 * over `ThrowOnError`, which this cannot be, hence the one cast; like the 1.x client Ryco creates
 * (`throwOnError: true`), it rejects on failure.
 */
function v1<F extends V1Method>(
  run: (params: Parameters<F>[0], options: CallOptions) => Promise<V1Data<F>>,
): F {
  return (async (params: Parameters<F>[0], options: CallOptions) => {
    try {
      return { data: await run(params, options) };
    } catch (error) {
      throw withNotFoundStatus(error);
    }
  }) as unknown as F;
}

/**
 * Every item of a paged list, following `cursor.next`. A cursor seen before would loop forever, so
 * it fails instead.
 */
async function allPages<T>(
  name: string,
  page: (cursor: string | undefined) => Promise<{
    readonly data: ReadonlyArray<T>;
    readonly cursor: { readonly next?: string | null | undefined };
  }>,
): Promise<Array<T>> {
  const items: Array<T> = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await page(cursor);
    items.push(...result.data);
    cursor = result.data.length > 0 ? (result.cursor.next ?? undefined) : undefined;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error(`OpenCode returned a repeated ${name} cursor.`);
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return items;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The data of one event block (its `data` lines joined); undefined for comments and the like. */
function sseEventData(block: string): string | undefined {
  let data: Array<string> | undefined;
  for (const line of block.split("\n")) {
    if (line === "data") (data ??= []).push("");
    else if (line.startsWith("data:")) {
      (data ??= []).push(line.charCodeAt(5) === 0x20 ? line.slice(6) : line.slice(5));
    }
  }
  return data?.join("\n");
}

/**
 * The `data` of each event in a server-sent event stream. `onActivity` runs for every chunk,
 * keepalive comments included. Aborting `signal` ends it quietly (the caller tells why), and so
 * does a stream that ends; an event cut off by the end is dropped, as the SSE spec has it.
 */
export async function* readOpenCodeSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onActivity: () => void = () => undefined,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let searchFrom = 0;
  // A chunk ending in CR may be the first half of a CRLF.
  let pendingCR = false;
  try {
    while (!signal.aborted) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        if (signal.aborted) return;
        throw new Error("The OpenCode event stream failed.", { cause });
      }
      if (signal.aborted) return;
      let text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (!chunk.done) onActivity();
      if (pendingCR) text = `\r${text}`;
      pendingCR = !chunk.done && text.endsWith("\r");
      if (pendingCR) text = text.slice(0, -1);
      // CRLF, LF and CR each end a line.
      buffer += text.replace(/\r\n?/g, "\n");
      let end = buffer.indexOf("\n\n", searchFrom);
      while (end >= 0) {
        const data = sseEventData(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (data !== undefined) yield data;
        end = buffer.indexOf("\n\n");
      }
      if (chunk.done) return;
      if (buffer.length > MAX_SSE_EVENT_LENGTH) {
        throw new Error("The OpenCode server sent an event larger than 16 MiB.");
      }
      searchFrom = Math.max(0, buffer.length - 1);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

type EventStream = Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>;
type PromptParams = NonNullable<Parameters<OpenCodeApi["session"]["promptAsync"]>[0]>;

/** The model a session runs, as a comparable key; an unset variant is the default one. */
const modelKey = (model: { readonly providerID: string; readonly id: string; variant?: string }) =>
  JSON.stringify([model.providerID, model.id, model.variant ?? "default"]);

/** An `OpenCodeApi` answered by the OpenCode 2.x server at `baseUrl`. */
export function makeOpenCodeV2Api(input: OpenCodeV2ApiInput): OpenCodeApi {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = input.serverPassword
    ? { Authorization: openCodeBasicAuthorization(input.serverPassword) }
    : {};
  const native = OpenCode.make({ baseUrl: input.baseUrl, headers, fetch: fetchImpl });
  const { directory } = input;
  const location = { directory };

  /**
   * Pending forms by ID, from `form.list` and `form.created`: a 1.x question reply names only the
   * request, and a `form.replied` event needs the form's fields to show its answer.
   */
  const forms = new Map<string, OpenCodeV2Form>();
  /**
   * The agent (null for the server's default) and model each session last ran with, as far as this
   * facade saw (session reads and its own switches). A 2.x session keeps both until switched, while
   * a 1.x prompt names them each time, so a prompt switches only what changed.
   */
  const agents = new Map<string, string | null>();
  const models = new Map<string, string>();
  /**
   * The agent a prompt without one runs on ({@link openCodeV2DefaultAgent}), read once, when a
   * prompt first leaves another agent. Only `default_agent` is taken from the configuration
   * documents, which can hold provider keys.
   */
  let defaultAgent: string | undefined;

  const observe = (info: SessionInfo): Session => {
    remember(agents, info.id, info.agent ?? null);
    if (info.model) remember(models, info.id, modelKey(info.model));
    else models.delete(info.id);
    return openCodeV2Session(info);
  };

  const getSession = (sessionID: string, options: CallOptions) =>
    native.session.get({ sessionID }, requestOptions(options)).then(observe);

  /** A session's stored 2.x messages, oldest first. */
  const storedMessages = (sessionID: string, options: CallOptions) =>
    // Only the first page names an order: 2.x rejects a cursor page that does (T3 `paginate`).
    allPages("message", (cursor) =>
      native.message.list(
        cursor === undefined
          ? { sessionID, order: "asc", limit: MESSAGE_PAGE_SIZE }
          : { sessionID, cursor, limit: MESSAGE_PAGE_SIZE },
        requestOptions(options),
      ),
    );

  const messages = async (
    sessionID: string,
    options: CallOptions,
  ): Promise<Array<OpenCodeV1Message>> =>
    (await storedMessages(sessionID, options)).flatMap((message) => {
      const mapped = openCodeV2Message(sessionID, message, directory);
      return mapped ? [mapped] : [];
    });

  const resolveDefaultAgent = async (request: ReturnType<typeof requestOptions>) => {
    if (defaultAgent === undefined) {
      const [config, listed] = await Promise.all([
        native.config.get({ location }, request),
        native.agent.list({ location }, request),
      ]);
      defaultAgent = openCodeV2DefaultAgent(config, listed.data);
    }
    return defaultAgent;
  };

  /**
   * Submits a 1.x prompt: switches the session's agent and model where they differ from what it
   * last ran with, then queues the text as steering input (it runs at once on an idle session).
   * Without an agent a prompt runs on the default one, so a session this facade saw on another
   * agent (Ryco's plan mode) switches back to it: the user's configured `default_agent`, as on 1.x.
   */
  const submit = async (params: PromptParams, options: CallOptions) => {
    const { sessionID } = params;
    const request = requestOptions(options);
    const known = agents.get(sessionID);
    const agent =
      params.agent ??
      (known === undefined || known === null ? undefined : await resolveDefaultAgent(request));
    if (agent !== undefined && agent !== known) {
      await native.session.switchAgent({ sessionID, agent }, request);
      remember(agents, sessionID, agent);
      // An agent can bring its own model; the next model check must not trust the old one.
      models.delete(sessionID);
    }
    if (params.model) {
      const model = openCodeV2ModelRef(params.model, params.variant);
      const key = modelKey(model);
      if (models.get(sessionID) !== key) {
        await native.session.switchModel({ sessionID, model }, request);
        remember(models, sessionID, key);
      }
    }
    return native.session.prompt(
      {
        sessionID,
        ...(params.messageID ? { id: params.messageID } : {}),
        ...openCodeV2Prompt(params.parts),
        delivery: "steer",
      },
      request,
    );
  };

  const rememberForm = (form: OpenCodeV2Form) => {
    remember(forms, form.id, form);
    return openCodeV2Question(form);
  };

  /**
   * Waits until 2.x has finished connecting an MCP server it accepted (its PUT returns before the
   * handshake), within {@link MCP_CONNECT_TIMEOUT_MS}. Returns every server's status.
   */
  const awaitMcpServer = async (name: string, options: CallOptions) => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), MCP_CONNECT_TIMEOUT_MS);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    try {
      while (true) {
        const servers = (await native.mcp.list({ location }, { signal })).data;
        const status = servers.find((server) => server.name === name)?.status;
        if (status !== undefined && status.status !== "pending") {
          if (status.status === "connected") await sleep(MCP_SETTLE_MS, signal);
          return Object.fromEntries(
            servers.map((server) => [server.name, server.status as McpStatus]),
          );
        }
        await sleep(MCP_POLL_INTERVAL_MS, signal);
      }
    } catch (cause) {
      if (deadline.signal.aborted && !options?.signal?.aborted) {
        throw new Error(`Timed out waiting for OpenCode to connect the MCP server '${name}'.`, {
          cause,
        });
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * The 2.x events at `/api/event` that parse as JSON objects with a `type`; anything else is
   * skipped. Whether an event decodes as its type is the mapper's concern. Ends quietly once
   * `signal` aborts.
   */
  async function* readEvents(
    signal: AbortSignal,
    onActivity: () => void,
  ): AsyncGenerator<OpenCodeEvent, void, undefined> {
    const url = new URL(input.baseUrl);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    let response: Response;
    try {
      response = await fetchImpl(new URL("api/event", url), {
        headers: { ...headers, accept: "text/event-stream" },
        signal,
      });
    } catch (cause) {
      if (signal.aborted) return;
      // Fixed text: the underlying error can carry the URL.
      throw new Error("Couldn't open the OpenCode event stream.", { cause });
    }
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (response.status !== 200 || mediaType !== "text/event-stream" || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) {
        throw new Error(OPENCODE_REJECTED_PASSWORD_MESSAGE);
      }
      throw new Error(
        response.status === 200
          ? "The OpenCode server did not answer with an event stream."
          : `The OpenCode event stream returned HTTP ${response.status}.`,
      );
    }
    for await (const data of readOpenCodeSseData(response.body, signal, onActivity)) {
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (isRecord(event) && typeof event.type === "string") yield event as OpenCodeEvent;
    }
  }

  /**
   * `event.subscribe`: resolves once the first event arrived (2.x sends `server.connected` at
   * once), so the subscription is proven before the caller reads history or starts work, and the
   * stream starts with that event. Fails the stream when the server goes silent or closes it (2.x
   * may drop a slow reader; a quiet end would leave a running turn waiting forever), and ends it
   * quietly when `options.signal` aborts or the caller stops reading.
   */
  async function subscribe(options: CallOptions): Promise<EventStream> {
    const controller = new AbortController();
    const caller = options?.signal ?? undefined;
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
    let failure: Error | undefined;
    // Runs only while the stream waits on the server: the time a caller spends on an event (the
    // adapter reads history after its first one) is not the server's silence.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, message: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        failure = new Error(message);
        controller.abort(failure);
      }, ms);
      timer.unref?.();
    };
    const disarm = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    let connected = false;
    // Any chunk (keepalive comments too) restarts the silence deadline, but the first event must
    // still arrive in time.
    const onActivity = () => {
      if (connected) timer?.refresh();
    };
    const close = () => {
      disarm();
      controller.abort();
    };
    signal.addEventListener("abort", disarm, { once: true });
    arm(STREAM_OPEN_TIMEOUT_MS, OPENCODE_V2_STREAM_OPEN_TIMEOUT_MESSAGE);
    const events = readEvents(signal, onActivity);
    let first: IteratorResult<OpenCodeEvent, void>;
    try {
      first = await events.next();
    } catch (cause) {
      close();
      throw failure ?? cause;
    }
    if (first.done) {
      close();
      throw (
        failure ??
        (caller?.aborted
          ? caller.reason
          : new Error("The OpenCode event stream closed before it connected."))
      );
    }
    connected = true;
    disarm();

    const mapper = createOpenCodeV2EventMapper(directory, (id) => forms.get(id));
    const translate = (event: OpenCodeEvent): Array<OpenCodeV1Event> => {
      const mapped = mapper(event);
      const data: unknown = event.data;
      if (event.type === "form.created" && mapped.length > 0) rememberForm(event.data.form);
      else if (
        (event.type === "form.replied" || event.type === "form.cancelled") &&
        isRecord(data) &&
        typeof data.id === "string"
      ) {
        forms.delete(data.id);
      }
      return mapped;
    };
    const opening = first.value;

    async function* stream(): AsyncGenerator<OpenCodeV1Event, void, unknown> {
      try {
        const initial = translate(opening);
        // The caller's first read proves the subscription, so it never waits on a later event.
        yield* initial.length > 0
          ? initial
          : [{ id: opening.id ?? "", type: "server.connected", properties: {} }];
        while (true) {
          arm(STREAM_SILENCE_TIMEOUT_MS, OPENCODE_V2_SILENT_STREAM_MESSAGE);
          const next = await events.next();
          disarm();
          if (next.done) {
            if (failure) throw failure;
            if (caller?.aborted) return;
            throw new Error(OPENCODE_V2_CLOSED_STREAM_MESSAGE);
          }
          yield* translate(next.value);
        }
      } finally {
        close();
        await events.return();
      }
    }
    return { stream: stream() };
  }

  const api: OpenCodeApi = {
    generation: "v2",
    global: {
      health: v1<OpenCodeApi["global"]["health"]>(async (options) => ({
        healthy: true,
        version: (await native.server.info(requestOptions(options))).version,
      })),
    },
    provider: {
      list: v1<OpenCodeApi["provider"]["list"]>(async (_params, options) => {
        // A cold server fills its provider list on the first model lookup.
        const listed = await native.model.list({ location }, requestOptions(options));
        const providers = await native.provider.list({ location }, requestOptions(options));
        return openCodeV2ProviderList(providers.data, listed.data);
      }),
    },
    app: {
      agents: v1<OpenCodeApi["app"]["agents"]>(async (_params, options) =>
        (await native.agent.list({ location }, requestOptions(options))).data.map(openCodeV2Agent),
      ),
    },
    session: {
      create: v1<OpenCodeApi["session"]["create"]>(async (params, options) =>
        observe(
          await native.session.create(
            {
              location,
              title: params?.title,
              parentID: params?.parentID,
              permissions: params?.permission ? openCodeV2Rules(params.permission) : undefined,
            },
            requestOptions(options),
          ),
        ),
      ),
      get: v1<OpenCodeApi["session"]["get"]>(async ({ sessionID }, options) =>
        getSession(sessionID, options),
      ),
      update: v1<OpenCodeApi["session"]["update"]>(async (params, options) => {
        await native.session.update(
          {
            sessionID: params.sessionID,
            title: params.title,
            permissions: params.permission ? openCodeV2Rules(params.permission) : undefined,
          },
          requestOptions(options),
        );
        return getSession(params.sessionID, options);
      }),
      children: v1<OpenCodeApi["session"]["children"]>(async ({ sessionID }, options) =>
        (
          await allPages("session", (cursor) =>
            native.session.list(
              { parentID: sessionID, limit: SESSION_PAGE_SIZE, cursor },
              requestOptions(options),
            ),
          )
        ).map(openCodeV2Session),
      ),
      messages: v1<OpenCodeApi["session"]["messages"]>(async ({ sessionID }, options) =>
        messages(sessionID, options),
      ),
      promptAsync: v1<OpenCodeApi["session"]["promptAsync"]>(async (params, options) => {
        await submit(params, options);
      }),
      /**
       * Text generation: the reply to the prompt, once the execution it started ended. As on 1.x,
       * a failed reply is returned with its `error` for the caller to show; a failure without one
       * (before any reply) throws the execution's own error.
       */
      prompt: v1<OpenCodeApi["session"]["prompt"]>(async (params, options) => {
        const { sessionID } = params;
        const receipt = await submit(params, options);
        await native.session.wait({ sessionID }, requestOptions(options));
        const info = await native.session.get({ sessionID }, requestOptions(options));
        observe(info);
        if (info.outcome !== "succeeded" && info.outcome !== "failed") {
          throw new Error(`OpenCode execution ${info.outcome ?? "did not finish"}.`);
        }
        const stored = await storedMessages(sessionID, options);
        const start = stored.findIndex((message) => message.id === receipt.id);
        const after = start < 0 ? [] : stored.slice(start + 1);
        const reply = after.findLast(
          (message): message is SessionMessageAssistant => message.type === "assistant",
        );
        if (info.outcome === "failed" && reply?.error === undefined) {
          // The execution's end is stored as an idle message carrying its error.
          const idle = after.findLast(
            (message): message is SessionMessageIdle => message.type === "idle",
          );
          throw new Error(idle?.error?.message || "OpenCode execution failed.");
        }
        if (!reply) throw new Error("OpenCode finished without an assistant reply.");
        return openCodeV2AssistantMessage(sessionID, reply, directory);
      }),
      abort: v1<OpenCodeApi["session"]["abort"]>(async ({ sessionID }, options) => {
        await native.session.interrupt({ sessionID }, requestOptions(options));
        return true;
      }),
      // A fork copies history before the message and never touches files; Ryco owns checkpoints,
      // so 2.x `revert.*` is never used.
      fork: v1<OpenCodeApi["session"]["fork"]>(async ({ sessionID, messageID }, options) =>
        observe(
          await native.session.fork(
            { sessionID, ...(messageID ? { before: messageID } : {}) },
            requestOptions(options),
          ),
        ),
      ),
    },
    permission: {
      list: v1<OpenCodeApi["permission"]["list"]>(async (_params, options) =>
        (await native.permission.request.list({ location }, requestOptions(options))).data.map(
          openCodeV2Permission,
        ),
      ),
      // The 1.x call names the session, which 2.x replies need.
      respond: v1<OpenCodeApi["permission"]["respond"]>(async (params, options) => {
        await native.permission.reply(
          {
            sessionID: params.sessionID,
            requestID: params.permissionID,
            decision: params.response ?? "reject",
          },
          requestOptions(options),
        );
        return true;
      }),
    },
    question: {
      list: v1<OpenCodeApi["question"]["list"]>(async (_params, options) =>
        (await native.form.list({ location }, requestOptions(options))).data.map((form: FormInfo) =>
          rememberForm(form),
        ),
      ),
      reply: v1<OpenCodeApi["question"]["reply"]>(async ({ requestID, answers }, options) => {
        const form = forms.get(requestID);
        if (!form) throw new Error("OpenCode form is no longer pending; refresh the session.");
        const response = openCodeV2FormResponse(form, answers ?? []);
        const target = { sessionID: form.sessionID, formID: form.id };
        if (response.type === "cancel") {
          await native.session.form.cancel(target, requestOptions(options));
          forms.delete(form.id);
        } else {
          // Kept until `form.replied`, which can arrive after this returns and needs the form.
          await native.session.form.reply(
            { ...target, answer: response.answer },
            requestOptions(options),
          );
        }
        return true;
      }),
    },
    event: {
      subscribe: ((_params: unknown, options: CallOptions) =>
        subscribe(options)) as unknown as OpenCodeApi["event"]["subscribe"],
    },
    mcp: {
      add: v1<OpenCodeApi["mcp"]["add"]>(async (params, options) => {
        if (!params?.name || !params.config) {
          throw new Error("OpenCode MCP registration needs a name and a configuration.");
        }
        await native.mcp.add(
          { server: params.name, location, config: openCodeV2McpConfig(params.config) },
          requestOptions(options),
        );
        return awaitMcpServer(params.name, options);
      }),
    },
  };
  return api;
}
