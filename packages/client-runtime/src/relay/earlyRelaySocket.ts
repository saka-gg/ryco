import { RELAY_AUTHENTICATION_DEADLINE_MS } from "@ryco/contracts/relay";

import type { HostedEarlyRelaySocket } from "../authorization/types.ts";

/**
 * How long an opened early socket waits for its ticket. The Hub closes a socket
 * that has not authenticated within {@link RELAY_AUTHENTICATION_DEADLINE_MS} of
 * opening; this lets go of it well before, and the attempt continues in the
 * serial order with a fresh socket.
 */
export const EARLY_RELAY_SOCKET_TICKET_WAIT_MS = RELAY_AUTHENTICATION_DEADLINE_MS - 1_500;

const CLOSING = 2;
const CLOSED = 3;

/** The minimum of a platform WebSocket the early socket depends on. */
export interface EarlySocketLike {
  binaryType: string;
  readonly readyState: number;
  close: (code?: number, reason?: string) => void;
  addEventListener: (type: string, listener: (event: never) => void) => void;
}

/** Where an adopted early socket delivers its events, including those it held. */
export interface EarlyRelaySocketSink {
  readonly open: () => void;
  readonly message: (data: unknown) => void;
  readonly close: (reason?: string) => void;
  readonly error: () => void;
}

export interface EarlyRelaySocketPorts<Socket extends EarlySocketLike = EarlySocketLike> {
  readonly url: string;
  /** The upgrade's authorization (for example a bearer token and its DPoP proof). */
  readonly prepareUpgradeHeaders: () => Promise<Readonly<Record<string, string>>>;
  readonly createSocket: (url: string, headers: Readonly<Record<string, string>>) => Socket;
  readonly ticketWaitMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
}

export interface AdoptedEarlyRelaySocket<Socket extends EarlySocketLike = EarlySocketLike> {
  readonly socket: Socket;
  /** Deliver what happened before adoption, then every later event, to `sink`. */
  readonly attach: (sink: EarlyRelaySocketSink) => void;
}

type HeldEvent =
  | { readonly type: "message"; readonly data: unknown }
  | { readonly type: "close"; readonly reason: string | undefined }
  | { readonly type: "error" };

/**
 * The relay upgrade, started before the attempt has its ticket.
 *
 * A platform whose upgrade is authorized without the ticket (the ticket only
 * travels in the first frame) opens the socket beside the ticket request, which
 * hides the ticket's round trip under the socket's TCP, TLS and upgrade. The
 * socket carries no authority until the ticket-bearing auth frame, and is used
 * by at most one attempt: the one relay socket that adopts it. One that opened
 * and waited {@link EARLY_RELAY_SOCKET_TICKET_WAIT_MS} for its ticket, closed,
 * failed, or could not prepare its upgrade headers is discarded, and the
 * attempt opens a fresh socket after its ticket instead.
 */
export class EarlyRelaySocket<
  Socket extends EarlySocketLike = EarlySocketLike,
> implements HostedEarlyRelaySocket {
  readonly #ports: EarlyRelaySocketPorts<Socket>;
  readonly #ready: Promise<Socket | null>;
  #socket: Socket | null = null;
  #opened = false;
  #unusable = false;
  #adopted = false;
  #timer: unknown = null;
  #sink: EarlyRelaySocketSink | null = null;
  readonly #held: HeldEvent[] = [];

  constructor(ports: EarlyRelaySocketPorts<Socket>) {
    this.#ports = ports;
    this.#ready = this.#start();
  }

  async #start(): Promise<Socket | null> {
    try {
      // Nothing that can fail runs before the first await, so the constructor
      // never throws.
      await Promise.resolve();
      const headers = await this.#ports.prepareUpgradeHeaders();
      if (this.#unusable) return null;
      const socket = this.#ports.createSocket(this.#ports.url, headers);
      socket.binaryType = "arraybuffer";
      this.#socket = socket;
      socket.addEventListener("open", () => {
        if (this.#sink) return this.#sink.open();
        this.#opened = true;
        if (this.#adopted) return;
        const setTimer =
          this.#ports.setTimeout ??
          ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs));
        this.#timer = setTimer(() => {
          this.#timer = null;
          this.discard();
        }, this.#ports.ticketWaitMs ?? EARLY_RELAY_SOCKET_TICKET_WAIT_MS);
      });
      socket.addEventListener("message", (event: never) => {
        const data = (event as { readonly data?: unknown }).data;
        if (this.#sink) this.#sink.message(data);
        else this.#held.push({ type: "message", data });
      });
      socket.addEventListener("close", (event: never) => {
        const reason = (event as { readonly reason?: string }).reason;
        if (this.#sink) return this.#sink.close(reason);
        if (this.#adopted) this.#held.push({ type: "close", reason });
        else this.discard();
      });
      socket.addEventListener("error", () => {
        if (this.#sink) return this.#sink.error();
        if (this.#adopted) this.#held.push({ type: "error" });
        else this.discard();
      });
      return socket;
    } catch {
      this.#unusable = true;
      return null;
    }
  }

  /**
   * Hand the socket to the one attempt that holds its ticket, or `null` when it
   * is no longer usable (then it is closed). `attach` replays what happened
   * before adoption once the caller has stored the socket.
   */
  async adopt(): Promise<AdoptedEarlyRelaySocket<Socket> | null> {
    const socket = await this.#ready;
    if (socket === null || this.#unusable || this.#adopted) {
      this.discard();
      return null;
    }
    this.#adopted = true;
    this.#clearTimer();
    return {
      socket,
      attach: (sink) => {
        if (this.#sink) return;
        this.#sink = sink;
        const held = this.#held.splice(0);
        if (this.#opened) sink.open();
        for (const event of held) {
          if (event.type === "message") sink.message(event.data);
          else if (event.type === "close") sink.close(event.reason);
          else sink.error();
        }
      },
    };
  }

  /** Let go of a socket no attempt adopted. Has no effect once one has. */
  discard(): void {
    if (this.#adopted) return;
    this.#unusable = true;
    this.#clearTimer();
    this.#held.length = 0;
    const socket = this.#socket;
    if (socket && socket.readyState !== CLOSING && socket.readyState !== CLOSED) {
      try {
        socket.close(1000, "closed");
      } catch {
        // Already gone.
      }
    }
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    const clearTimer =
      this.#ports.clearTimeout ??
      ((timer: unknown) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
    clearTimer(this.#timer);
    this.#timer = null;
  }
}
