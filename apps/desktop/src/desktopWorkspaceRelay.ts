import * as Crypto from "node:crypto";

import type { DesktopWorkspaceTransportEvent, EnvironmentId } from "@ryco/contracts";
import type { WorkspaceNativeTrustState } from "@ryco/client-runtime/state/workspace";
import {
  HostedRelayEngine,
  probeStreamRelayPayloadInflater,
  type HostedRelaySocketCallbacks,
  type RelayE2eeProvider,
  type RelaySocket,
} from "@ryco/client-runtime/relay";
import {
  makeRelayE2eeInitiator,
  type RelayE2eeInitiatorAttempt,
} from "@ryco/client-runtime/relay/e2ee";
import WebSocket, { type RawData } from "ws";

import type {
  DesktopNativeE2eeHandshakeService,
  DesktopNativeE2eePreparation,
} from "./desktopNativeE2eeHandshake.ts";

const MAX_TRANSPORTS = 8;
const MAX_APPLICATION_FRAME_BYTES = 16 * 1024 * 1024;
const PREPARED_LIFETIME_MS = 30_000;
/**
 * How long an environment's relay attempts run without payload compression
 * after one ended on a compressed payload it could not deliver. Long enough to
 * stop a reconnect loop; bounded so a transient fault does not cost the
 * compression until the app restarts.
 */
export const RELAY_COMPRESSION_RETRY_AFTER_MS = 10 * 60_000;
/**
 * Relay payload compression: the main process inflates with the same
 * `DecompressionStream("deflate-raw")` path the browser uses (Node ships it).
 */
const RELAY_PAYLOAD_INFLATER = probeStreamRelayPayloadInflater(
  () => new DecompressionStream("deflate-raw"),
);

export type { DesktopWorkspaceTransportEvent } from "@ryco/contracts";

export interface DesktopWorkspaceRelayTarget {
  readonly accountId: string;
  readonly nodeId: string;
  readonly environmentId: EnvironmentId;
  readonly relayUrl: string;
  readonly nativeTrust: WorkspaceNativeTrustState;
}

export interface DesktopWorkspaceRelayAuthority {
  readonly resolveTarget: (
    environmentId: EnvironmentId,
    pairingOnly: boolean,
  ) => Promise<DesktopWorkspaceRelayTarget | null>;
  readonly prepareE2ee: (
    target: DesktopWorkspaceRelayTarget,
    pairingOnly: boolean,
  ) => Promise<DesktopNativeE2eePreparation>;
  readonly handshake: () => Promise<DesktopNativeE2eeHandshakeService>;
  readonly issueTicket: (
    target: DesktopWorkspaceRelayTarget,
  ) => Promise<{ readonly ticket: string; readonly expiresAt: number }>;
  readonly authorizeUpgrade: (
    target: DesktopWorkspaceRelayTarget,
  ) => Promise<Readonly<Record<string, string>>>;
  readonly onAccountAuthorizationRevoked?: () => void;
}

interface DesktopWorkspaceRelayConnection {
  readonly send: (bytes: Uint8Array) => void;
  readonly close: () => void;
}

interface PreparedTransport {
  readonly environmentId: EnvironmentId;
  readonly pairingOnly: boolean;
  readonly expiresAt: number;
  active: DesktopWorkspaceRelayConnection | null;
  activating: boolean;
  cleanup: () => void;
}

function opaqueTransportId(): string {
  return Crypto.randomBytes(24).toString("base64url");
}

/**
 * One inbound frame as bytes, or null when it is too large.
 *
 * The socket asks `ws` for `arraybuffer`, which hands the listener an
 * ArrayBuffer nothing else references, so it is wrapped as is: the relay engine
 * owns it from here and wipes it once decoded. A Buffer (only delivered if the
 * binary type ever changes) can be a window onto a chunk shared with later
 * frames, so it is copied out before the engine can wipe it.
 */
export function bytesFromRawData(data: RawData): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const total = data.reduce((sum, part) => sum + part.byteLength, 0);
    if (total > MAX_APPLICATION_FRAME_BYTES) return null;
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const part of data) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    return combined;
  }
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return view.byteLength <= MAX_APPLICATION_FRAME_BYTES ? Uint8Array.from(view) : null;
}

function nativeAttempt(input: {
  readonly target: DesktopWorkspaceRelayTarget;
  readonly preparation: Extract<DesktopNativeE2eePreparation, { readonly kind: "native" }>;
  readonly handshake: DesktopNativeE2eeHandshakeService;
}): RelayE2eeInitiatorAttempt {
  return {
    hubOrigin: new URL(input.target.relayUrl).origin.replace(/^ws/u, "http"),
    selectionClass: "latched",
    legacyPermitted: false,
    pairingOnly: input.preparation.pairingOnly,
    localSuitePreference: [input.preparation.suiteId],
    credentials: input.preparation.credentials,
    ...(input.preparation.verifiedPin === undefined
      ? {}
      : { verifiedPin: input.preparation.verifiedPin }),
    accountId: input.target.accountId,
    ...(input.preparation.acceptedPolicyGeneration === undefined
      ? {}
      : {
          acceptedPolicyGeneration: input.preparation.acceptedPolicyGeneration,
        }),
    nativeHandshake: {
      start: (startInput) => input.handshake.start(input.preparation.attemptHandle, startInput),
      finish: (handle, payload) => Promise.resolve(input.handshake.finish(handle, payload)),
      destroy: (handle) => input.handshake.destroy(handle),
    },
  };
}

class DesktopWorkspaceRelaySocket {
  readonly #socket: WebSocket;
  readonly #engine: HostedRelayEngine;

  constructor(input: {
    readonly target: DesktopWorkspaceRelayTarget;
    readonly ticket: string;
    readonly ticketExpiresAt: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly e2ee: RelayE2eeProvider;
    /** §4.6: `false` after an earlier attempt for this environment failed on compression. */
    readonly relayCompression: boolean;
    readonly callbacks: HostedRelaySocketCallbacks;
    readonly events: {
      readonly open: () => void;
      readonly message: (bytes: Uint8Array) => void;
      readonly error: () => void;
      readonly close: (code: number, reason: string) => void;
    };
  }) {
    const socket = new WebSocket(input.target.relayUrl, {
      headers: input.headers,
    });
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    const openListeners: Array<() => void> = [];
    const messageListeners: Array<(bytes: Uint8Array) => void> = [];
    const closeListeners: Array<(reason?: string) => void> = [];
    const errorListeners: Array<() => void> = [];
    const relaySocket: RelaySocket = {
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      get readyState() {
        return socket.readyState;
      },
      // The engine wipes its frame as soon as this returns, while `ws` can keep
      // the buffer past that (compression, write queue), so `ws` gets its own.
      send: (bytes) => socket.send(Buffer.from(bytes)),
      close: (code, reason) => socket.close(code, reason),
      onOpen: (listener) => openListeners.push(listener),
      onBinaryMessage: (listener) => messageListeners.push(listener),
      onClose: (listener) => closeListeners.push(listener),
      onError: (listener) => errorListeners.push(listener),
    };
    this.#engine = new HostedRelayEngine({
      ticket: input.ticket,
      ticketExpiresAt: input.ticketExpiresAt,
      socket: relaySocket,
      callbacks: input.callbacks,
      e2ee: input.e2ee,
      ...(input.relayCompression && RELAY_PAYLOAD_INFLATER !== undefined
        ? { inflater: RELAY_PAYLOAD_INFLATER }
        : {}),
      timers: {
        now: Date.now,
        setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
        clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
        queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
      },
      events: {
        onOpen: input.events.open,
        onData: input.events.message,
        onError: input.events.error,
        onClose: input.events.close,
      },
    });
    socket.on("open", () => {
      for (const listener of openListeners) listener();
    });
    socket.on("message", (data, isBinary) => {
      const bytes = isBinary ? bytesFromRawData(data) : null;
      if (bytes === null) {
        this.#engine.reportUndecodableMessage("frame_too_large");
        return;
      }
      for (const listener of messageListeners) listener(bytes);
    });
    socket.on("close", (_code, reason) => {
      for (const listener of closeListeners) listener(reason.toString());
    });
    socket.on("error", () => {
      for (const listener of errorListeners) listener();
    });
  }

  send(bytes: Uint8Array): void {
    if (bytes.byteLength > MAX_APPLICATION_FRAME_BYTES) {
      throw new Error("Desktop workspace RPC frame is too large.");
    }
    // The engine copies whatever it keeps, so the caller's bytes are sent as is.
    this.#engine.send(bytes);
  }

  close(): void {
    this.#engine.close(1000, "");
  }
}

type DesktopWorkspaceRelaySocketInput = ConstructorParameters<
  typeof DesktopWorkspaceRelaySocket
>[0];
type DesktopWorkspaceRelaySocketFactory = (
  input: DesktopWorkspaceRelaySocketInput,
) => DesktopWorkspaceRelayConnection;

/** Main-process owner for authenticated, E2EE relay sockets addressed by opaque handles. */
export class DesktopWorkspaceRelayManager {
  readonly #authority: DesktopWorkspaceRelayAuthority;
  readonly #emit: (event: DesktopWorkspaceTransportEvent) => void;
  readonly #now: () => number;
  readonly #socketFactory: DesktopWorkspaceRelaySocketFactory;
  readonly #transports = new Map<string, PreparedTransport>();
  /**
   * Environments whose relay attempts run without payload compression, because
   * one ended on a compressed payload it could not deliver (§4.6.5), and until
   * when. Cleared on `dispose` (an account or session change).
   */
  readonly #compressionDisabledUntil = new Map<EnvironmentId, number>();

  constructor(input: {
    readonly authority: DesktopWorkspaceRelayAuthority;
    readonly emit: (event: DesktopWorkspaceTransportEvent) => void;
    readonly now?: () => number;
    readonly socketFactory?: DesktopWorkspaceRelaySocketFactory;
  }) {
    this.#authority = input.authority;
    this.#emit = input.emit;
    this.#now = input.now ?? Date.now;
    this.#socketFactory =
      input.socketFactory ?? ((socketInput) => new DesktopWorkspaceRelaySocket(socketInput));
  }

  prepare(environmentId: EnvironmentId): string {
    return this.#prepare(environmentId, false);
  }

  prepareVerification(environmentId: EnvironmentId): string {
    return this.#prepare(environmentId, true);
  }

  #prepare(environmentId: EnvironmentId, pairingOnly: boolean): string {
    this.#prune();
    if (this.#transports.size >= MAX_TRANSPORTS) {
      throw new Error("Desktop workspace transport capacity is unavailable.");
    }
    const transportId = opaqueTransportId();
    this.#transports.set(transportId, {
      environmentId,
      pairingOnly,
      expiresAt: this.#now() + PREPARED_LIFETIME_MS,
      active: null,
      activating: false,
      cleanup: () => undefined,
    });
    return transportId;
  }

  async activate(transportId: string): Promise<void> {
    this.#prune();
    const prepared = this.#transports.get(transportId);
    if (
      !prepared ||
      prepared.active !== null ||
      prepared.activating ||
      prepared.expiresAt <= this.#now()
    ) {
      throw new Error("Desktop workspace transport is unavailable.");
    }
    prepared.activating = true;
    const isCurrent = () => this.#transports.get(transportId) === prepared;
    let preparation: Extract<DesktopNativeE2eePreparation, { readonly kind: "native" }> | undefined;
    let handshake: DesktopNativeE2eeHandshakeService | undefined;
    let destroyed = false;
    const cleanup = () => {
      if (preparation && handshake && !destroyed) {
        destroyed = true;
        handshake.destroy(preparation.attemptHandle);
      }
    };
    prepared.cleanup = cleanup;
    let failureCode = 4401;
    let retryable = true;
    let retryAfterMs: number | undefined;
    let failureReason = "Relay unavailable";
    try {
      const target = await this.#authority.resolveTarget(
        prepared.environmentId,
        prepared.pairingOnly,
      );
      if (!isCurrent()) return;
      if (!target || target.environmentId !== prepared.environmentId) {
        throw new Error("Desktop workspace target is unavailable.");
      }
      // Obtain the cleanup owner before allocating a native handshake. Capture
      // preparation independently so a sibling request failure cannot leak it.
      handshake = await this.#authority.handshake();
      if (!isCurrent()) return;
      let preparationFailed = false;
      const [resolvedPreparation, ticket, headers] = await Promise.all([
        this.#authority.prepareE2ee(target, prepared.pairingOnly).then((value) => {
          if (value.kind === "native") preparation = value;
          if (!isCurrent() || preparationFailed) cleanup();
          return value;
        }),
        target.nativeTrust === "account-trusted" && !prepared.pairingOnly
          ? Promise.resolve(null)
          : this.#authority.issueTicket(target),
        this.#authority.authorizeUpgrade(target),
      ]).catch((error: unknown) => {
        preparationFailed = true;
        cleanup();
        throw error;
      });
      if (!isCurrent()) {
        cleanup();
        return;
      }
      if (resolvedPreparation.kind !== "native") {
        retryable = false;
        if (resolvedPreparation.kind === "update-required") {
          failureCode = 4406;
          failureReason = "Update required";
        }
        throw new Error("Desktop workspace target is not natively verified.");
      }
      preparation = resolvedPreparation;
      if (preparation.pairingOnly !== prepared.pairingOnly) {
        throw new Error("Desktop workspace target verification state changed.");
      }
      const relayTicket = preparation.relayTicket ?? ticket;
      if (
        relayTicket === null ||
        (target.nativeTrust === "account-trusted" && !prepared.pairingOnly) !==
          (preparation.relayTicket !== undefined)
      ) {
        throw new Error("Desktop workspace target trust state changed.");
      }
      const attempt = nativeAttempt({ target, preparation, handshake });
      const active = this.#socketFactory({
        target,
        ticket: relayTicket.ticket,
        ticketExpiresAt: relayTicket.expiresAt,
        headers,
        e2ee: (host) => makeRelayE2eeInitiator({ host, attempt }),
        relayCompression: this.#compressionAllowed(prepared.environmentId),
        callbacks: {
          onTransportStatus: () => undefined,
          onSessionStatus: () => undefined,
          onRole: () => undefined,
          onFailure: (failure) => {
            if (!isCurrent()) return;
            retryable = failure.retryable;
            retryAfterMs = failure.retryAfterMs;
            if (failure.compressionFailed === true) {
              this.#compressionDisabledUntil.set(
                prepared.environmentId,
                this.#now() + RELAY_COMPRESSION_RETRY_AFTER_MS,
              );
            }
            if (
              failure.enrollmentRevoked !== undefined &&
              target.nativeTrust === "account-trusted"
            ) {
              globalThis.queueMicrotask(() => {
                // The close event normally retires this handle first. Account
                // revocation is authoritative even after that normal retirement.
                this.#authority.onAccountAuthorizationRevoked?.();
                this.dispose();
              });
            }
          },
        },
        events: {
          open: () => {
            if (isCurrent()) this.#emit({ type: "open", transportId });
          },
          message: (data) => {
            if (isCurrent()) this.#emit({ type: "message", transportId, data });
          },
          // Publish the classified close as the terminal event. An earlier
          // generic error can make Effect close IPC before its retry policy arrives.
          error: () => undefined,
          close: (code, reason) => {
            cleanup();
            if (!isCurrent()) return;
            this.#transports.delete(transportId);
            this.#emit({
              type: "close",
              transportId,
              code,
              reason,
              retryable,
              ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            });
          },
        },
      });
      if (!isCurrent()) {
        active.close();
        cleanup();
        return;
      }
      prepared.active = active;
    } catch {
      cleanup();
      if (!isCurrent()) return;
      this.#transports.delete(transportId);
      this.#emit({
        type: "close",
        transportId,
        code: failureCode,
        reason: failureReason,
        retryable,
      });
      throw new Error("Desktop workspace relay activation failed.");
    }
  }

  send(transportId: string, bytes: Uint8Array): void {
    const transport = this.#transports.get(transportId)?.active;
    if (!transport) throw new Error("Desktop workspace transport is unavailable.");
    transport.send(bytes);
  }

  close(transportId: string): void {
    const prepared = this.#transports.get(transportId);
    if (!prepared) return;
    this.#transports.delete(transportId);
    try {
      prepared.active?.close();
    } finally {
      prepared.cleanup();
      // Main can close independently (sign-out, revocation, expiry). The
      // renderer must settle even when this handle never owned a socket.
      this.#emit({
        type: "close",
        transportId,
        code: 1000,
        reason: "Workspace closed",
        retryable: false,
      });
    }
  }

  dispose(): void {
    // Closing publishes an event; snapshot ownership before reentrant listeners run.
    const transportIds = Array.from(this.#transports.keys());
    for (const transportId of transportIds) this.close(transportId);
    this.#compressionDisabledUntil.clear();
  }

  #compressionAllowed(environmentId: EnvironmentId): boolean {
    const until = this.#compressionDisabledUntil.get(environmentId);
    if (until === undefined) return true;
    if (until > this.#now()) return false;
    this.#compressionDisabledUntil.delete(environmentId);
    return true;
  }

  #prune(): void {
    const now = this.#now();
    for (const [transportId, transport] of this.#transports) {
      if (transport.active === null && transport.expiresAt <= now) {
        this.close(transportId);
      }
    }
  }
}

export const DESKTOP_WORKSPACE_MAX_RPC_FRAME_BYTES = MAX_APPLICATION_FRAME_BYTES;
