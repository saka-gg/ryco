import net from "node:net";
import { performance } from "node:perf_hooks";

/**
 * Byte-level TCP proxy that adds a fixed one-way delay to every chunk, in both
 * directions, without parsing anything. HTTP and WebSocket traffic pass
 * through unchanged, so a browser talking to a local Hub through it sees a
 * round trip of `2 * delayMs` on top of the loopback cost.
 *
 * Order is preserved: a chunk is written only after every earlier chunk of the
 * same direction, and never earlier than `delayMs` after it was read. A
 * half-close is forwarded in order after the data that preceded it.
 */

export interface DelayProxy {
  /** The port the proxy listens on (the OS-assigned one when `listenPort` was 0). */
  readonly port: number;
  /** Stops listening and destroys every open connection pair. */
  readonly close: () => Promise<void>;
}

export interface DelayProxyOptions {
  readonly listenPort: number;
  readonly targetHost?: string;
  readonly targetPort: number;
  readonly delayMs: number;
}

/** A chunk waiting for its due time; `null` marks the end of the stream. */
interface PendingChunk {
  readonly dueAt: number;
  readonly chunk: Buffer | null;
}

interface DelayedPipe {
  readonly pendingCount: () => number;
  readonly cancel: () => void;
}

/** Forwards `from` to `to` after `delayMs`; calls `onDrained` whenever the queue empties. */
function pipeWithDelay(
  from: net.Socket,
  to: net.Socket,
  delayMs: number,
  onDrained: () => void,
): DelayedPipe {
  const pending: PendingChunk[] = [];
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    timer = null;
    const now = performance.now();
    // Re-check against the clock: a timer may fire a hair before its due time.
    while (pending.length > 0 && pending[0]!.dueAt <= now) {
      const { chunk } = pending.shift()!;
      if (to.destroyed) continue;
      if (chunk === null) to.end();
      else to.write(chunk);
    }
    if (pending.length > 0) {
      timer = setTimeout(flush, Math.max(0, pending[0]!.dueAt - performance.now()));
    } else {
      onDrained();
    }
  };
  const enqueue = (chunk: Buffer | null) => {
    pending.push({ dueAt: performance.now() + delayMs, chunk });
    if (timer === null) timer = setTimeout(flush, delayMs);
  };

  from.on("data", (chunk: Buffer) => enqueue(chunk));
  from.on("end", () => enqueue(null));
  return {
    pendingCount: () => pending.length,
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.length = 0;
    },
  };
}

export async function startDelayProxy(options: DelayProxyOptions): Promise<DelayProxy> {
  const targetHost = options.targetHost ?? "127.0.0.1";
  const delayMs = Math.max(0, options.delayMs);
  const open = new Set<() => void>();

  // Half-open sockets let one side finish sending while the other still answers.
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({
      host: targetHost,
      port: options.targetPort,
      allowHalfOpen: true,
    });
    client.setNoDelay(true);
    upstream.setNoDelay(true);

    const destroyPair = () => {
      forward.cancel();
      backward.cancel();
      client.destroy();
      upstream.destroy();
      open.delete(destroyPair);
    };
    // Tear the pair down once a side closed and nothing is left in flight, so
    // the tail of a conversation is still delivered after its sender is gone.
    // Data written to the surviving side may still sit in Node's write buffer:
    // end it and destroy only after it finished flushing.
    let settling = false;
    const destroyWhenDrained = () => {
      const closed = client.closed || upstream.closed;
      if (settling || !closed) return;
      if (forward.pendingCount() > 0 || backward.pendingCount() > 0) return;
      settling = true;
      let unfinished = 0;
      const finished = () => {
        unfinished -= 1;
        if (unfinished === 0) destroyPair();
      };
      for (const socket of [client, upstream]) {
        if (socket.destroyed) continue;
        unfinished += 1;
        socket.end(finished);
      }
      if (unfinished === 0) destroyPair();
    };
    const forward = pipeWithDelay(client, upstream, delayMs, destroyWhenDrained);
    const backward = pipeWithDelay(upstream, client, delayMs, destroyWhenDrained);
    open.add(destroyPair);

    client.on("error", destroyPair);
    upstream.on("error", destroyPair);
    client.on("close", destroyWhenDrained);
    upstream.on("close", destroyWhenDrained);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listenPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The delay proxy did not report a listening port.");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const destroyPair of open) destroyPair();
        server.close(() => resolve());
      }),
  };
}
