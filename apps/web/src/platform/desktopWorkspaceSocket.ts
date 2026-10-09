import type { DesktopBridge, DesktopWorkspaceTransportEvent, EnvironmentId } from "@ryco/contracts";

import { HostedReconnectPolicy } from "@ryco/client-runtime/relay";
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
        await input.bridge.activateDesktopWorkspaceTransport?.(input.transportId);
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
    this.#bridge.sendDesktopWorkspaceTransport?.(this.#transportId, Uint8Array.from(bytes));
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
        this.#emit({ type: "message", data: Uint8Array.from(event.data) });
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

export class DesktopWorkspaceIpcSocketFactory {
  readonly #environmentId: EnvironmentId;
  readonly #bridge: DesktopWorkspaceTransportBridge;
  #pendingTransportId: string | null = null;
  #generation = 0;
  #disposed = false;
  #retryable = true;
  #retryAfterMs: number | undefined;
  #currentSocket: DesktopWorkspaceIpcSocket | null = null;
  readonly #policy = new HostedReconnectPolicy();

  readonly lifecycleHandlers: WsProtocolLifecycleHandlers = {
    persistentReconnect: true,
    recordGlobalConnectionState: false,
    shouldReconnect: () => !this.#disposed && this.#retryable,
    getReconnectDelayMs: () => this.#policy.nextDelay(this.#retryAfterMs),
    onOpen: () => {
      this.#retryAfterMs = undefined;
      this.#policy.opened();
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
    if (this.#pendingTransportId) {
      this.#bridge.closeDesktopWorkspaceTransport?.(this.#pendingTransportId);
      this.#pendingTransportId = null;
    }
  }

  constructor(environmentId: EnvironmentId, bridge: DesktopWorkspaceTransportBridge) {
    this.#environmentId = environmentId;
    this.#bridge = bridge;
  }

  async nextUrl(): Promise<string> {
    if (this.#disposed || !this.#retryable)
      throw new Error("Desktop workspace requires attention.");
    const generation = this.#generation;
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

  createSocket(url: string): DesktopWorkspaceIpcSocket {
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
        this.#retryAfterMs = event.retryAfterMs;
      },
    });
    this.#currentSocket = socket;
    return socket;
  }
}
