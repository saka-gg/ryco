import { Cause, Effect, Exit, Queue, Scope } from "effect";
import {
  AGENT_CONTROL_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
} from "@ryco/contracts";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc";

type BrowserWsClient = {
  send: (data: string) => void;
};

interface BrowserWsConnection {
  readonly client: BrowserWsClient;
  readonly closed: { value: boolean };
  readonly incoming: Queue.Queue<unknown>;
  readonly scope: Scope.Closeable;
  readonly serverReady: Promise<void>;
}

export type NormalizedWsRpcRequestBody = {
  _tag: string;
  [key: string]: unknown;
};

type UnaryResolverResult = unknown | Promise<unknown>;

interface BrowserWsRpcHarnessOptions {
  readonly resolveUnary?: (request: NormalizedWsRpcRequestBody) => UnaryResolverResult;
  readonly getInitialStreamValues?: (
    request: NormalizedWsRpcRequestBody,
  ) => ReadonlyArray<unknown> | undefined;
}

// RpcGroup does not expose stream metadata through its request keys. Every
// streaming method must be listed here or the harness will return a unary
// response into the stream and trigger the client's reconnect path.
const STREAM_METHODS = new Set<string>([
  ORCHESTRATION_WS_METHODS.subscribeShell,
  ORCHESTRATION_WS_METHODS.subscribeThread,
  ORCHESTRATION_WS_METHODS.subscribeThreadWindow,
  AGENT_CONTROL_WS_METHODS.subscribeProposals,
  WS_METHODS.gitRunStackedAction,
  WS_METHODS.subscribeVcsStatus,
  WS_METHODS.subscribeTerminalEvents,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
]);

const ALL_RPC_METHODS = Array.from(WsRpcGroup.requests.keys());

function normalizeRequest(tag: string, payload: unknown): NormalizedWsRpcRequestBody {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      _tag: tag,
      ...(payload as Record<string, unknown>),
    };
  }
  return { _tag: tag, payload };
}

const RPC_FAILURE = Symbol("wsRpcHarness.failure");

/** A unary answer that fails the RPC with one of its typed errors; see `rpcFailure`. */
export interface WsRpcFailure {
  readonly [RPC_FAILURE]: Cause.YieldableError;
}

/**
 * Answers a unary RPC with one of its typed errors (an `OrchestrationDispatchCommandError`
 * refusal, say) instead of a success. Return it from a resolver.
 */
export function rpcFailure(error: Cause.YieldableError): WsRpcFailure {
  return { [RPC_FAILURE]: error };
}

function isRpcFailure(result: unknown): result is WsRpcFailure {
  return typeof result === "object" && result !== null && RPC_FAILURE in result;
}

function asEffect(result: UnaryResolverResult): Effect.Effect<unknown, Cause.YieldableError> {
  if (isRpcFailure(result)) {
    return Effect.fail(result[RPC_FAILURE]);
  }
  if (result instanceof Promise) {
    return Effect.promise(() => result);
  }
  return Effect.succeed(result);
}

export class BrowserWsRpcHarness {
  readonly requests: Array<NormalizedWsRpcRequestBody> = [];

  private readonly parser = RpcSerialization.json.makeUnsafe();
  private connections = new WeakMap<BrowserWsClient, BrowserWsConnection>();
  private activeConnections = new Set<BrowserWsConnection>();
  private latestConnection: BrowserWsConnection | null = null;
  private resolveUnary: NonNullable<BrowserWsRpcHarnessOptions["resolveUnary"]> = () => ({});
  private getInitialStreamValues: NonNullable<
    BrowserWsRpcHarnessOptions["getInitialStreamValues"]
  > = () => [];
  private streamQueues = new Map<string, Set<Queue.Queue<unknown>>>();

  async reset(options?: BrowserWsRpcHarnessOptions): Promise<void> {
    await this.disconnect();
    this.requests.length = 0;
    this.resolveUnary = options?.resolveUnary ?? (() => ({}));
    this.getInitialStreamValues = options?.getInitialStreamValues ?? (() => []);
    this.initializeStreamQueues();
  }

  connect(client: BrowserWsClient): void {
    if (this.streamQueues.size === 0) {
      this.initializeStreamQueues();
    }

    const scope = Effect.runSync(Scope.make());
    const closed = { value: false };
    const incoming = Effect.runSync(Queue.unbounded<unknown>());
    const disconnects = Effect.runSync(Queue.unbounded<number>());
    const protocol = {
      run: (writeRequest: (clientId: number, message: never) => Effect.Effect<void>) =>
        Queue.take(incoming).pipe(
          Effect.flatMap((message) => writeRequest(0, message as never)),
          Effect.forever,
        ),
      disconnects,
      send: (_clientId: number, response: unknown) =>
        Effect.sync(() => {
          if (closed.value) return;
          const encoded = this.parser.encode(response);
          if (typeof encoded === "string") {
            client.send(encoded);
          }
        }),
      end: () => Effect.void,
      clientIds: Effect.succeed(new Set([0]) as ReadonlySet<number>),
      initialMessage: Effect.succeedNone,
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: true,
    } satisfies RpcServer.Protocol["Service"];
    const connection: BrowserWsConnection = {
      client,
      closed,
      incoming,
      scope,
      serverReady: Effect.runPromise(
        Scope.provide(scope)(
          RpcServer.make(WsRpcGroup).pipe(
            Effect.provideService(RpcServer.Protocol, protocol),
            Effect.provide(this.makeLayer()),
            Effect.forkScoped,
            Effect.asVoid,
          ),
        ),
      ),
    };
    this.connections.set(client, connection);
    this.activeConnections.add(connection);
    this.latestConnection = connection;
  }

  async disconnectClient(client: BrowserWsClient): Promise<void> {
    const connection = this.connections.get(client);
    if (!connection) {
      return;
    }
    this.connections.delete(client);
    this.activeConnections.delete(connection);
    if (this.latestConnection === connection) {
      this.latestConnection = Array.from(this.activeConnections).at(-1) ?? null;
    }
    connection.closed.value = true;
    await Effect.runPromise(Scope.close(connection.scope, Exit.void)).catch(() => undefined);
  }

  async disconnect(): Promise<void> {
    const connections = Array.from(this.activeConnections);
    this.connections = new WeakMap();
    this.activeConnections.clear();
    this.latestConnection = null;

    for (const connection of connections) {
      connection.closed.value = true;
    }

    await Promise.all(
      connections.map((connection) =>
        Effect.runPromise(Scope.close(connection.scope, Exit.void)).catch(() => undefined),
      ),
    );
    for (const queues of this.streamQueues.values()) {
      for (const queue of queues) {
        Effect.runSync(Queue.shutdown(queue));
      }
    }
    this.streamQueues.clear();
  }

  private initializeStreamQueues(): void {
    this.streamQueues = new Map(Array.from(STREAM_METHODS, (method) => [method, new Set()]));
  }

  async onMessage(rawData: string, client?: BrowserWsClient): Promise<void> {
    const connection = client ? this.connections.get(client) : this.latestConnection;
    if (!connection) {
      return;
    }
    await connection.serverReady;
    const messages = this.parser.decode(rawData);
    for (const message of messages) {
      if (message && typeof message === "object" && "_tag" in message && message._tag === "Ping") {
        const encoded = this.parser.encode(RpcMessage.constPong);
        if (typeof encoded === "string") {
          connection.client.send(encoded);
        }
        continue;
      }
      await Effect.runPromise(Queue.offer(connection.incoming, message));
    }
  }

  emitStreamValue(method: string, value: unknown): void {
    const queues = this.streamQueues.get(method);
    if (!queues) {
      throw new Error(`No stream registered for ${method}`);
    }
    for (const queue of queues) {
      Queue.offerUnsafe(queue, value);
    }
  }

  private makeLayer() {
    const handlers: Record<string, (payload: unknown) => unknown> = {};
    for (const method of ALL_RPC_METHODS) {
      handlers[method] = STREAM_METHODS.has(method)
        ? (payload) => this.handleStream(method, payload)
        : (payload) => this.handleUnary(method, payload);
    }
    return WsRpcGroup.toLayer(handlers as never);
  }

  private handleUnary(method: string, payload: unknown) {
    const request = normalizeRequest(method, payload);
    this.requests.push(request);
    return asEffect(this.resolveUnary(request));
  }

  private handleStream(method: string, payload: unknown) {
    const request = normalizeRequest(method, payload);
    this.requests.push(request);
    const queues = this.streamQueues.get(method);
    if (!queues) {
      throw new Error(`No stream registered for ${method}`);
    }
    const initialValues = this.getInitialStreamValues(request) ?? [];
    return Effect.acquireRelease(
      Queue.unbounded<unknown>().pipe(
        Effect.tap((queue) => Queue.offerAll(queue, initialValues)),
        Effect.tap((queue) =>
          Effect.sync(() => {
            queues.add(queue);
          }),
        ),
      ),
      (queue) =>
        Effect.sync(() => {
          queues.delete(queue);
        }).pipe(Effect.andThen(Queue.shutdown(queue))),
    );
  }
}
