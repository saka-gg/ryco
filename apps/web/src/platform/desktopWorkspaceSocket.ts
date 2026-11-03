import type { DesktopBridge, DesktopWorkspaceTransportEvent, EnvironmentId } from "@ryco/contracts";

import { HostedReconnectPolicy } from "@ryco/client-runtime/relay/reconnectPolicy";
import type { WsProtocolLifecycleHandlers } from "@ryco/client-runtime/rpc";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

interface SocketEvent {
  readonly type: string;
  readonly data?: Uint8Array;
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
}

type SocketListener = (event: SocketEvent) => void;

interface ListenerRegistration {
  readonly listener: SocketListener;
  readonly once: boolean;
}

/**
 * The bytes to hand to IPC. Electron serializes them before the call returns,
 * so a caller can reuse its buffer right away and bytes that span their whole
 * buffer go as is. A view onto part of a larger buffer is copied out so that
 * only its own bytes cross the process boundary.
 */
function spanningBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
}

type DesktopWorkspaceTransportBridge = Pick<
  DesktopBridge,
  | "prepareDesktopWorkspaceTransport"
  | "activateDesktopWorkspaceTransport"
  | "sendDesktopWorkspaceTransport"
  | "closeDesktopWorkspaceTransport"
  | "onDesktopWorkspaceTransportEvent"
>;

export class DesktopWorkspaceIpcSocket {
  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  binaryType = "arraybuffer";
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;
  onopen: SocketListener | null = null;
  onmessage: SocketListener | null = null;
  onerror: SocketListener | null = null;
  onclose: SocketListener | null = null;

  readonly #bridge: DesktopWorkspaceTransportBridge;
  readonly #transportId: string;
  readonly #listeners = new Map<string, Set<ListenerRegistration>>();
  readonly #onClose:
    | ((event: Extract<DesktopWorkspaceTransportEvent, { type: "close" }>) => void)
    | undefined;
  readonly #unsubscribe: (() => void) | undefined;
  #state = CONNECTING;

  constructor(input: {
    readonly url: string;
    readonly transportId: string;
    readonly bridge: DesktopWorkspaceTransportBridge;
    readonly onClose?: (event: Extract<DesktopWorkspaceTransportEvent, { type: "close" }>) => void;
  }) {
    this.#onClose = input.onClose;
    this.url = input.url;
    this.#transportId = input.transportId;
    this.#bridge = input.bridge;
    this.#unsubscribe = input.bridge.onDesktopWorkspaceTransportEvent?.((event) =>
      this.#accept(event),
    );
    // The Effect socket layer registers listeners synchronously after the
    // constructor returns. Activate on the next microtask so a fast main-side
    // refusal cannot settle before those listeners exist.
    void Promise.resolve().then(async () => {
      if (this.#state !== CONNECTING) return;
      try {
        const activation = await input.bridge.activateDesktopWorkspaceTransport?.(
          input.transportId,
        );
        // A refusal arrives as a value (Electron would log a thrown one); the
        // reconnect policy backs off from the resulting close.
        if (activation?.ok === false) this.#failClosed();
      } catch {
        this.#failClosed();
      }
    });
  }

  get readyState(): number {
    return this.#state;
  }

  get bufferedAmount(): number {
    return 0;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.#state !== OPEN) throw new Error("Desktop workspace transport is not open.");
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : null;
    if (bytes === null) throw new Error("Desktop workspace transport payload is invalid.");
    this.#bridge.sendDesktopWorkspaceTransport?.(this.#transportId, spanningBytes(bytes));
  }

  close(): void {
    if (this.#state === CLOSING || this.#state === CLOSED) return;
    this.#state = CLOSING;
    try {
      this.#bridge.closeDesktopWorkspaceTransport?.(this.#transportId);
    } finally {
      // Prepared handles and failed activations may have no main-side socket
      // left to acknowledge closure. Always release the renderer listener.
      this.#accept({ type: "close", transportId: this.#transportId, code: 1000, reason: "" });
    }
  }

  addEventListener(
    type: string,
    listener: SocketListener,
    options?: { readonly once?: boolean },
  ): void {
    const registrations = this.#listeners.get(type) ?? new Set<ListenerRegistration>();
    registrations.add({ listener, once: options?.once ?? false });
    this.#listeners.set(type, registrations);
  }

  removeEventListener(type: string, listener: SocketListener): void {
    const registrations = this.#listeners.get(type);
    if (!registrations) return;
    for (const registration of [...registrations]) {
      if (registration.listener === listener) registrations.delete(registration);
    }
  }

  #accept(event: DesktopWorkspaceTransportEvent): void {
    if (event.transportId !== this.#transportId || this.#state === CLOSED) return;
    switch (event.type) {
      case "open":
        if (this.#state !== CONNECTING) return;
        this.#state = OPEN;
        this.#emit({ type: "open" });
        return;
      case "message":
        if (this.#state !== OPEN) return;
        // IPC delivered these bytes to this socket alone; hand them on as is.
        this.#emit({ type: "message", data: event.data });
        return;
      case "error":
        this.#emit({ type: "error" });
        return;
      case "close":
        this.#onClose?.(event);
        this.#state = CLOSED;
        this.#emit({
          type: "close",
          code: event.code,
          reason: event.reason,
          wasClean: event.code === 1000,
        });
        this.#unsubscribe?.();
    }
  }

  #failClosed(): void {
    if (this.#state === CLOSED) return;
    this.#emit({ type: "error" });
    this.#state = CLOSED;
    this.#emit({ type: "close", code: 4401, reason: "Relay unavailable", wasClean: false });
    this.#unsubscribe?.();
  }

  #emit(event: SocketEvent): void {
    const registrations = this.#listeners.get(event.type);
    if (registrations) {
      for (const registration of [...registrations]) {
        if (registration.once) registrations.delete(registration);
        registration.listener(event);
      }
    }
    const handler = (
      {
        open: this.onopen,
        message: this.onmessage,
        error: this.onerror,
        close: this.onclose,
      } as Record<string, SocketListener | null>
    )[event.type];
    handler?.(event);
  }
}

/**
 * The direct route an attempt may take instead of the relay: the socket URL of
 * the best linked address that answered as this machine, or null for the
 * relay. Asked once per attempt (`docs/environment-routes.md`).
 */
export interface DesktopWorkspaceDirectRoutes {
  readonly resolve: (
    signal: AbortSignal,
  ) => Promise<{ readonly routeKey: string; readonly url: string } | null>;
}

/** The route the current attempt took: a direct route's key, or `"relay"`. */
export type DesktopWorkspaceActiveRoute = string;

export class DesktopWorkspaceIpcSocketFactory {
  readonly #environmentId: EnvironmentId;
  readonly #bridge: DesktopWorkspaceTransportBridge;
  readonly #directRoutes: DesktopWorkspaceDirectRoutes | null;
  #pendingTransportId: string | null = null;
  #pendingDirect: { readonly routeKey: string; readonly url: string } | null = null;
  #pendingRouteCheck: AbortController | null = null;
  #activeRoute: DesktopWorkspaceActiveRoute | null = null;
  /**
   * The relay ended this machine for good (authorization withdrawn, not
   * verified, update required). Until a relay socket opens again, no attempt
   * may take a direct route around that verdict, and no upgrade may start one.
   */
  #relayRefused = false;
  #generation = 0;
  #disposed = false;
  #retryable = true;
  #retryAfterMs: number | undefined;
  #currentSocket: DesktopWorkspaceIpcSocket | WebSocket | null = null;
  readonly #policy = new HostedReconnectPolicy();

  readonly lifecycleHandlers: WsProtocolLifecycleHandlers = {
    persistentReconnect: true,
    recordGlobalConnectionState: false,
    shouldReconnect: () => !this.#disposed && this.#retryable,
    getReconnectDelayMs: () => this.#policy.nextDelay(this.#retryAfterMs),
    onOpen: () => {
      this.#retryAfterMs = undefined;
      this.#policy.opened();
      if (this.#activeRoute === "relay") this.#relayRefused = false;
    },
    onClose: () => this.#policy.closed(),
    isSocketCurrent: (socket) => socket === (this.#currentSocket as unknown),
    onSessionStart: () => {
      this.#invalidatePending();
      this.#retryable = true;
      this.#retryAfterMs = undefined;
    },
    onDispose: () => {
      this.#disposed = true;
      this.#invalidatePending();
    },
    isTerminalUrlError: () => this.#disposed || !this.#retryable,
  };

  #invalidatePending(): void {
    this.#generation += 1;
    this.#currentSocket = null;
    this.#pendingDirect = null;
    this.#pendingRouteCheck?.abort();
    this.#pendingRouteCheck = null;
    if (this.#pendingTransportId) {
      this.#bridge.closeDesktopWorkspaceTransport?.(this.#pendingTransportId);
      this.#pendingTransportId = null;
    }
  }

  constructor(
    environmentId: EnvironmentId,
    bridge: DesktopWorkspaceTransportBridge,
    directRoutes?: DesktopWorkspaceDirectRoutes,
  ) {
    this.#environmentId = environmentId;
    this.#bridge = bridge;
    this.#directRoutes = directRoutes ?? null;
  }

  /** The route the open (or opening) socket took, or null before the first attempt. */
  get activeRoute(): DesktopWorkspaceActiveRoute | null {
    return this.#activeRoute;
  }

  /** Whether a better route may be tried now: never past the relay's own refusal. */
  get mayUpgrade(): boolean {
    return !this.#disposed && this.#retryable && !this.#relayRefused;
  }

  async nextUrl(): Promise<string> {
    if (this.#disposed || !this.#retryable)
      throw new Error("Desktop workspace requires attention.");
    const generation = this.#generation;
    this.#pendingDirect = null;
    if (this.#directRoutes && !this.#relayRefused) {
      // Each attempt walks the routes again: a direct route that answers as
      // this machine wins, otherwise the relay below. The walk belongs to this
      // attempt; a newer one or a dispose abandons it.
      this.#pendingRouteCheck?.abort();
      const check = new AbortController();
      this.#pendingRouteCheck = check;
      const direct = await this.#directRoutes.resolve(check.signal).catch(() => null);
      if (this.#pendingRouteCheck === check) this.#pendingRouteCheck = null;
      if (this.#disposed || generation !== this.#generation || check.signal.aborted) {
        throw new Error("Desktop workspace transport was cancelled.");
      }
      if (direct !== null) {
        if (this.#pendingTransportId) {
          this.#bridge.closeDesktopWorkspaceTransport?.(this.#pendingTransportId);
          this.#pendingTransportId = null;
        }
        this.#pendingDirect = direct;
        return direct.url;
      }
    }
    if (!this.#bridge.prepareDesktopWorkspaceTransport) {
      throw new Error("Desktop workspace transport is unavailable.");
    }
    const prepared = await this.#bridge.prepareDesktopWorkspaceTransport(this.#environmentId);
    if (this.#disposed || generation !== this.#generation) {
      this.#bridge.closeDesktopWorkspaceTransport?.(prepared.transportId);
      throw new Error("Desktop workspace transport was cancelled.");
    }
    if (this.#pendingTransportId)
      this.#bridge.closeDesktopWorkspaceTransport?.(this.#pendingTransportId);
    this.#pendingTransportId = prepared.transportId;
    return `ws://desktop-workspace.invalid/${prepared.transportId}`;
  }

  createSocket(url: string): DesktopWorkspaceIpcSocket | WebSocket {
    const direct = this.#pendingDirect;
    this.#pendingDirect = null;
    if (direct !== null) {
      if (url !== direct.url) throw new Error("Desktop workspace route changed under the attempt.");
      // The node's own socket, authenticated by the linked bearer's one-time
      // token in the URL; the relay's credentials never reach it.
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      this.#currentSocket = socket;
      this.#activeRoute = direct.routeKey;
      return socket;
    }
    const transportId = this.#pendingTransportId;
    this.#pendingTransportId = null;
    if (!transportId || !url.endsWith(`/${transportId}`)) {
      throw new Error("Desktop workspace transport requires a fresh opaque handle.");
    }
    const socket = new DesktopWorkspaceIpcSocket({
      url,
      transportId,
      bridge: this.#bridge,
      onClose: (event) => {
        if (this.#currentSocket !== socket) return;
        this.#retryable = event.retryable ?? true;
        if (event.retryable === false) this.#relayRefused = true;
        this.#retryAfterMs = event.retryAfterMs;
      },
    });
    this.#currentSocket = socket;
    this.#activeRoute = "relay";
    return socket;
  }
}
