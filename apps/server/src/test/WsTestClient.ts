import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Effect, Layer, Option, type Scope, Stream, SubscriptionRef } from "effect";
import {
  RpcClient,
  RpcSerialization,
  type Rpc,
  type RpcClientError,
  type RpcGroup,
} from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import {
  WS_METHODS,
  WsRpcGroup,
  type ServerLifecycleStreamEvent,
  type ServerLifecycleStreamWelcomeEvent,
} from "@ryco/contracts";
import { UnknownUnionMember } from "@ryco/contracts/base-schemas";

/**
 * `WsTestClient` is a thin, reusable harness around the websocket RPC client
 * used by server integration tests. It replaces the ad-hoc per-test socket
 * wiring (manual `RpcClient.make` + protocol layer + cookie/origin parsing) with
 * a single `connect()` entry point plus a handful of ergonomic combinators:
 *
 * - `rpc(method, input)` — invoke a request/response RPC method.
 * - `awaitPush(channel, predicate, input?)` — open a streaming subscription and
 *   resolve with the first push that matches `predicate`.
 * - `trackPushSequence(channel, input?)` — start recording every push from a
 *   subscription in order, returning a handle that can be queried later.
 * - `awaitWelcome(predicate?)` — wait for the lifecycle `welcome` event.
 *
 * The connection is scoped: the underlying socket and any background recorders
 * are released when the surrounding `Scope` closes (e.g. `Effect.scoped`).
 */

const parseSessionCookieFromWsUrl = (
  wsUrl: string,
): { readonly cookie: string | null; readonly origin: string | null; readonly url: string } => {
  const next = new URL(wsUrl);
  const hashParams = new URLSearchParams(next.hash.startsWith("#") ? next.hash.slice(1) : "");
  const cookie = hashParams.get("cookie");
  const origin = hashParams.get("origin");
  next.hash = "";
  return {
    cookie,
    origin,
    url: next.toString(),
  };
};

/**
 * Builds the websocket RPC protocol layer for a given URL. Authentication is
 * carried either through the URL query string (e.g. `?wsToken=...`) or, for
 * cookie/origin based scenarios, through a `#cookie=...&origin=...` hash that the
 * caller appends to the URL. The hash is stripped before connecting and the
 * values are forwarded as upgrade-request headers.
 */
export const wsRpcProtocolLayer = (
  wsUrl: string,
): Layer.Layer<RpcClient.Protocol, never, never> => {
  const { cookie, origin, url } = parseSessionCookieFromWsUrl(wsUrl);
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, options) =>
      new NodeSocket.NodeWS.WebSocket(
        socketUrl,
        typeof options === "string" || Array.isArray(options) ? options : undefined,
        cookie || origin
          ? {
              headers: {
                ...(cookie ? { cookie } : {}),
                ...(origin ? { origin } : {}),
              },
            }
          : undefined,
      ) as unknown as globalThis.WebSocket,
  );

  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

type ReturnOf<Client, K extends keyof Client> = Client[K] extends (...args: any[]) => infer R
  ? R
  : never;

type InputOf<Client, K extends keyof Client> = Client[K] extends (
  input: infer I,
  ...rest: any[]
) => any
  ? I
  : never;

type StreamChannelKeys<Client> = {
  [K in keyof Client]: ReturnOf<Client, K> extends Stream.Stream<any, any, any> ? K : never;
}[keyof Client];

type RpcMethodKeys<Client> = {
  [K in keyof Client]: ReturnOf<Client, K> extends Stream.Stream<any, any, any>
    ? never
    : ReturnOf<Client, K> extends Effect.Effect<any, any, any>
      ? K
      : never;
}[keyof Client];

type ChannelEvent<Client, K extends keyof Client> =
  ReturnOf<Client, K> extends Stream.Stream<infer A, any, any> ? A : never;

type ChannelError<Client, K extends keyof Client> =
  ReturnOf<Client, K> extends Stream.Stream<any, infer E, any> ? E : never;

type RpcSuccess<Client, K extends keyof Client> =
  ReturnOf<Client, K> extends Stream.Stream<any, any, any>
    ? never
    : ReturnOf<Client, K> extends Effect.Effect<infer A, any, any>
      ? A
      : never;

type RpcError<Client, K extends keyof Client> =
  ReturnOf<Client, K> extends Stream.Stream<any, any, any>
    ? never
    : ReturnOf<Client, K> extends Effect.Effect<any, infer E, any>
      ? E
      : never;

// --- Group-derived type helpers -------------------------------------------
//
// The Effect RPC client exposes each method as a *generic* function whose
// return type is a deeply nested conditional. Inferring stream/effect shapes
// from those signatures collapses to `never`, so the production-facing helpers
// below derive their types straight from the RPC group's `Rpc` union instead,
// which is far more robust.

type RpcTags<Rpcs extends Rpc.Any> = Rpcs["_tag"];
type RpcFor<Rpcs extends Rpc.Any, Tag extends string> = Rpc.ExtractTag<Rpcs, Tag>;

type GroupInputOf<Rpcs extends Rpc.Any, Tag extends RpcTags<Rpcs>> = Rpc.PayloadConstructor<
  RpcFor<Rpcs, Tag>
>;

// `Rpc.IsStream` matches the success *schema* structurally and is too loose
// (it reports plain result schemas as streams). Checking the resolved success
// *value* type against `Stream` is reliable instead.
type IsStreamRpc<Rpcs extends Rpc.Any, Tag extends RpcTags<Rpcs>> = [
  Rpc.Success<RpcFor<Rpcs, Tag>>,
] extends [Stream.Stream<any, any, any>]
  ? true
  : false;

type GroupStreamKeys<Rpcs extends Rpc.Any> = {
  [Tag in RpcTags<Rpcs>]: IsStreamRpc<Rpcs, Tag> extends true ? Tag : never;
}[RpcTags<Rpcs>];

type GroupMethodKeys<Rpcs extends Rpc.Any> = {
  [Tag in RpcTags<Rpcs>]: IsStreamRpc<Rpcs, Tag> extends true ? never : Tag;
}[RpcTags<Rpcs>];

/**
 * The server under test is as new as the contract it is tested with, so a push
 * it sends never decodes as a member this build does not know: the combinators
 * fail on one and leave it out of the type.
 */
type GroupChannelEvent<Rpcs extends Rpc.Any, Tag extends RpcTags<Rpcs>> = Exclude<
  Rpc.SuccessChunk<RpcFor<Rpcs, Tag>>,
  UnknownUnionMember
>;

type GroupChannelError<Rpcs extends Rpc.Any, Tag extends RpcTags<Rpcs>, E> =
  | Rpc.ErrorExit<RpcFor<Rpcs, Tag>>
  | E;

type GroupRpcSuccess<Rpcs extends Rpc.Any, Tag extends RpcTags<Rpcs>> = Rpc.Success<
  RpcFor<Rpcs, Tag>
>;

type GroupRpcError<Rpcs extends Rpc.Any, Tag extends RpcTags<Rpcs>, E> =
  | Rpc.Error<RpcFor<Rpcs, Tag>>
  | E;

/**
 * Handle returned by {@link ConnectedWsTestClient.trackPushSequence}. A
 * background fiber records every push from the subscription in arrival order;
 * the methods below let a test inspect or await that recorded sequence.
 */
export interface PushSequence<Event> {
  /** Snapshot of all pushes recorded so far, in order. */
  readonly snapshot: Effect.Effect<ReadonlyArray<Event>>;
  /** Resolves once at least `count` pushes have been recorded. */
  readonly waitForCount: (count: number) => Effect.Effect<ReadonlyArray<Event>>;
  /** Resolves with the first recorded push matching `predicate`. */
  readonly waitFor: (predicate: (event: Event) => boolean) => Effect.Effect<Event>;
}

/**
 * Structural connected-client view derived from a concrete client object's
 * method signatures. Used by {@link makeConnectedWsTestClient} so the helper's
 * combinators can be unit-tested against a lightweight in-memory client whose
 * methods are non-generic (and therefore infer cleanly).
 */
export interface StructuralConnectedWsTestClient<Client> {
  /** The raw RPC client, for cases the helpers do not cover. */
  readonly client: Client;
  /** Invoke a request/response RPC method. */
  readonly rpc: <K extends RpcMethodKeys<Client>>(
    method: K,
    input: InputOf<Client, K>,
  ) => Effect.Effect<RpcSuccess<Client, K>, RpcError<Client, K>>;
  /** Open a subscription and resolve with the first push matching `predicate`. */
  readonly awaitPush: <K extends StreamChannelKeys<Client>>(
    channel: K,
    predicate: (event: ChannelEvent<Client, K>) => boolean,
    input?: InputOf<Client, K>,
  ) => Effect.Effect<ChannelEvent<Client, K>, ChannelError<Client, K>>;
  /** Start recording every push from a subscription in order. */
  readonly trackPushSequence: <K extends StreamChannelKeys<Client>>(
    channel: K,
    input?: InputOf<Client, K>,
  ) => Effect.Effect<PushSequence<ChannelEvent<Client, K>>, never, Scope.Scope>;
}

/**
 * A connected websocket RPC test client bound to an RPC group. Obtain one via
 * {@link makeWsTestClientConnector} (generic) or {@link connect} (bound to the
 * production `WsRpcGroup`). Types are derived from the group's `Rpc` union.
 */
export interface ConnectedWsTestClient<Rpcs extends Rpc.Any, E> {
  /** The raw RPC client, for cases the helpers do not cover. */
  readonly client: RpcClient.RpcClient<Rpcs, E>;
  /** Invoke a request/response RPC method. */
  readonly rpc: <Tag extends GroupMethodKeys<Rpcs>>(
    method: Tag,
    input: GroupInputOf<Rpcs, Tag>,
  ) => Effect.Effect<GroupRpcSuccess<Rpcs, Tag>, GroupRpcError<Rpcs, Tag, E>>;
  /** Open a subscription and resolve with the first push matching `predicate`. */
  readonly awaitPush: <Tag extends GroupStreamKeys<Rpcs>>(
    channel: Tag,
    predicate: (event: GroupChannelEvent<Rpcs, Tag>) => boolean,
    input?: GroupInputOf<Rpcs, Tag>,
  ) => Effect.Effect<GroupChannelEvent<Rpcs, Tag>, GroupChannelError<Rpcs, Tag, E>>;
  /** Start recording every push from a subscription in order. */
  readonly trackPushSequence: <Tag extends GroupStreamKeys<Rpcs>>(
    channel: Tag,
    input?: GroupInputOf<Rpcs, Tag>,
  ) => Effect.Effect<PushSequence<GroupChannelEvent<Rpcs, Tag>>, never, Scope.Scope>;
}

// Internal, runtime-only view of a client. Concrete error types are restored by
// the public interfaces (which cast onto this implementation), so the loose
// channels here use `never` rather than `unknown` to avoid leaking an
// unspecified error type through the combinators.
type LooseRpcClient = Record<
  string,
  (
    input: unknown,
    options?: unknown,
  ) => Effect.Effect<unknown, never> | Stream.Stream<unknown, never>
>;

/**
 * Wraps an already-constructed RPC client object with the {@link
 * ConnectedWsTestClient} combinators. Exposed primarily so the helper's logic
 * can be unit-tested against a lightweight in-memory client without standing up
 * a websocket server; production tests should prefer {@link connect}.
 */
export const makeConnectedWsTestClient = <Client>(
  client: Client,
): StructuralConnectedWsTestClient<Client> => {
  const looseClient = client as unknown as LooseRpcClient;

  const callStream = (channel: string, input: unknown) =>
    (looseClient[channel]!(input ?? {}) as Stream.Stream<unknown, never>).pipe(
      Stream.tap((event) =>
        event instanceof UnknownUnionMember
          ? Effect.die(
              new Error(
                `WsTestClient: "${channel}" pushed ${event.tag} "${event.value}", which its contract does not know`,
              ),
            )
          : Effect.void,
      ),
    );

  const rpc = ((method: string, input: unknown) =>
    looseClient[method]!(input)) as StructuralConnectedWsTestClient<Client>["rpc"];

  const awaitPush = ((channel: string, predicate: (event: unknown) => boolean, input?: unknown) =>
    callStream(channel, input).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.die(
              new Error(
                `WsTestClient.awaitPush("${channel}") stream ended before a matching push arrived`,
              ),
            ),
          onSome: (event: unknown) => Effect.succeed(event),
        }),
      ),
    )) as StructuralConnectedWsTestClient<Client>["awaitPush"];

  const trackPushSequence = ((channel: string, input?: unknown) =>
    Effect.gen(function* () {
      const recorded = yield* SubscriptionRef.make<ReadonlyArray<unknown>>([]);

      yield* callStream(channel, input).pipe(
        Stream.runForEach((event) =>
          SubscriptionRef.update(recorded, (events) => [...events, event]),
        ),
        Effect.forkScoped,
      );

      const handle: PushSequence<unknown> = {
        snapshot: SubscriptionRef.get(recorded),
        waitForCount: (count: number) =>
          SubscriptionRef.changes(recorded).pipe(
            Stream.filter((events) => events.length >= count),
            Stream.runHead,
            Effect.map(Option.getOrElse((): ReadonlyArray<unknown> => [])),
          ),
        waitFor: (predicate: (event: unknown) => boolean) =>
          SubscriptionRef.changes(recorded).pipe(
            Stream.map((events) => events.find(predicate)),
            Stream.filter((event): event is NonNullable<typeof event> => event !== undefined),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.die(
                    new Error(
                      `WsTestClient.trackPushSequence("${channel}") stream ended before a matching push arrived`,
                    ),
                  ),
                onSome: (event: unknown) => Effect.succeed(event),
              }),
            ),
          ),
      };
      return handle;
    })) as StructuralConnectedWsTestClient<Client>["trackPushSequence"];

  return { client, rpc, awaitPush, trackPushSequence };
};

/**
 * Creates a connector for an arbitrary RPC group. Useful for exercising the
 * helper in isolation (see `WsTestClient.test.ts`) and for any future websocket
 * RPC groups.
 */
export const makeWsTestClientConnector = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
): {
  readonly connect: (
    wsUrl: string,
  ) => Effect.Effect<
    ConnectedWsTestClient<Rpcs, RpcClientError.RpcClientError>,
    never,
    Scope.Scope | Rpc.MiddlewareClient<Rpcs>
  >;
} => {
  const makeClient = RpcClient.make(group);
  return {
    connect: (wsUrl: string) =>
      Effect.gen(function* () {
        // Build the socket/protocol into the caller's `Scope` so it stays open
        // for the lifetime of the connection rather than being torn down as soon
        // as the client is constructed.
        const protocolContext = yield* Layer.build(wsRpcProtocolLayer(wsUrl));
        const client = yield* makeClient.pipe(Effect.provideContext(protocolContext));
        return makeConnectedWsTestClient(client) as unknown as ConnectedWsTestClient<
          Rpcs,
          RpcClientError.RpcClientError
        >;
      }),
  };
};

type WsRpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;

/**
 * Connected client bound to the production {@link WsRpcGroup}, adding
 * websocket-lifecycle conveniences on top of the generic surface.
 */
export interface WsTestClient extends ConnectedWsTestClient<WsRpcs, RpcClientError.RpcClientError> {
  /**
   * Resolves with the first lifecycle `welcome` event. An optional `predicate`
   * can further constrain which welcome event to accept.
   */
  readonly awaitWelcome: (
    predicate?: (event: ServerLifecycleStreamEvent) => boolean,
  ) => Effect.Effect<
    ServerLifecycleStreamWelcomeEvent,
    GroupChannelError<WsRpcs, "subscribeServerLifecycle", RpcClientError.RpcClientError>
  >;
}

const wsConnector = makeWsTestClientConnector(WsRpcGroup);

/**
 * Connects a {@link WsTestClient} to the given websocket URL. The URL is
 * expected to already carry whatever authentication the server requires (e.g.
 * `?wsToken=...`). The connection is bound to the current `Scope`.
 */
export const connect = (wsUrl: string): Effect.Effect<WsTestClient, never, Scope.Scope> =>
  Effect.map(wsConnector.connect(wsUrl), (base): WsTestClient => {
    const awaitWelcome = (predicate?: (event: ServerLifecycleStreamEvent) => boolean) =>
      base
        .awaitPush(
          WS_METHODS.subscribeServerLifecycle,
          (event) => event.type === "welcome" && (predicate ? predicate(event) : true),
        )
        .pipe(Effect.map((event) => event as ServerLifecycleStreamWelcomeEvent));
    return {
      client: base.client,
      rpc: base.rpc,
      awaitPush: base.awaitPush,
      trackPushSequence: base.trackPushSequence,
      awaitWelcome,
    };
  });
