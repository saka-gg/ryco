import { Effect, Option, Schema } from "effect";
import { ThreadReadCacheBeginResponse } from "@ryco/contracts/thread-read-cache";
import { RELAY_PROTOCOL_MAJOR, RELAY_PROTOCOL_MINOR } from "@ryco/contracts/relay";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import type { HubConnector } from "./HubConnector.ts";
import { fetchBoundedJson } from "../hubIdentity/BoundedHttp.ts";
import {
  createThreadReadCachePublisher,
  THREAD_READ_CACHE_PUBLISH_INTERVAL_MS,
} from "./ThreadReadCachePublisher.ts";

class ThreadReadCacheHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Cloud thread history synchronization failed.");
    this.status = status;
  }
}

export const THREAD_READ_CACHE_CHANGE_COALESCE_MS = 250;
export const THREAD_READ_CACHE_MIN_PUBLISH_INTERVAL_MS = 1_000;

/** Opt-in content synchronization, independent of relay channel and heartbeat work. */
export function startThreadReadCacheSync(deps: {
  readonly hubOrigin: string;
  readonly identity: HubIdentityRuntimeShape;
  readonly connector: HubConnector;
  readonly query: ProjectionSnapshotQueryShape;
  readonly reportFailure: () => void;
}) {
  let stopped = false;
  let currentNodeId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let failures = 0;
  let changed = false;
  let scheduledAt = Infinity;
  let lastStartedAt = -Infinity;
  const abort = new AbortController();
  // Identity/key-store operations do not expose cancellation. Detach their
  // result on shutdown so they cannot hold the server's scope open; the post
  // fence below still prevents a late proof from publishing anything.
  const untilStopped = <T>(operation: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const cancelled = () => {
        abort.signal.removeEventListener("abort", cancelled);
        reject(new ThreadReadCacheHttpError(0));
      };
      if (stopped) {
        cancelled();
        return;
      }
      abort.signal.addEventListener("abort", cancelled, { once: true });
      void Promise.resolve()
        .then(() => {
          if (stopped) throw new ThreadReadCacheHttpError(0);
          return operation();
        })
        .then(
          (value) => {
            abort.signal.removeEventListener("abort", cancelled);
            resolve(value);
          },
          (error: unknown) => {
            abort.signal.removeEventListener("abort", cancelled);
            reject(error);
          },
        );
    });
  const post = async (action: "begin" | "snapshot", body: Record<string, unknown>) => {
    const expectedNode = currentNodeId;
    const proof = await untilStopped(() =>
      deps.connector.asIdentityOwner(() => {
        if (stopped) throw new ThreadReadCacheHttpError(0);
        return deps.identity.createRelayAuthenticationFrame(deps.hubOrigin, {
          protocolMajor: RELAY_PROTOCOL_MAJOR,
          protocolMinor: RELAY_PROTOCOL_MINOR,
        });
      }),
    );
    if (
      stopped ||
      expectedNode === null ||
      proof.nodeId !== expectedNode ||
      deps.connector.status().state !== "online"
    ) {
      throw new ThreadReadCacheHttpError(0);
    }
    const response = await fetchBoundedJson(
      fetch,
      `${deps.hubOrigin}/api/node/thread-cache/${action}`,
      {
        method: "POST",
        redirect: "error",
        signal: abort.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          proof: {
            nodeId: proof.nodeId,
            protocolMajor: proof.protocolMajor,
            protocolMinor: proof.protocolMinor,
            nonce: Buffer.from(proof.nonce).toString("base64url"),
            signature: Buffer.from(proof.signature).toString("base64url"),
          },
        }),
      },
      (failure) => {
        throw new ThreadReadCacheHttpError(
          failure.kind === "invalid_response" ? failure.status : 0,
        );
      },
    );
    if (!response.ok) throw new ThreadReadCacheHttpError(response.status);
    return response.value;
  };
  const publisher = createThreadReadCachePublisher({
    nodeId: () => (stopped || deps.connector.status().state !== "online" ? null : currentNodeId),
    now: Date.now,
    readSequence: async () =>
      (await Effect.runPromise(deps.query.getSnapshotSequence(), { signal: abort.signal }))
        .snapshotSequence,
    readShell: () => Effect.runPromise(deps.query.getShellSnapshot(), { signal: abort.signal }),
    readThread: async (threadId) => {
      // Never load the full history merely to populate a bounded cloud preview.
      if (!deps.query.getThreadWindow) return null;
      const result = await Effect.runPromise(
        deps.query
          .getThreadWindow({
            threadId,
            limits: { messages: 150, proposedPlans: 1, activities: 1, checkpoints: 1 },
          })
          .pipe(Effect.option),
        { signal: abort.signal },
      );
      return Option.isNone(result)
        ? null
        : {
            revision: result.value.snapshotSequence,
            messages: result.value.thread.messages,
          };
    },
    begin: async () => {
      const value = await post("begin", {});
      const decoded = Schema.decodeUnknownOption(ThreadReadCacheBeginResponse)(value);
      if (Option.isNone(decoded)) throw new ThreadReadCacheHttpError(0);
      return decoded.value.generation;
    },
    upload: async (generation, items) => {
      await post("snapshot", { generation, items });
    },
  });
  const tick = async () => {
    let delay = THREAD_READ_CACHE_PUBLISH_INTERVAL_MS;
    try {
      if (deps.connector.status().state === "online") {
        const state = await untilStopped(() => deps.identity.readState());
        currentNodeId =
          state.activeNode?.hubOrigin === deps.hubOrigin ? state.activeNode.nodeId : null;
        await publisher.synchronize();
        failures = 0;
      } else {
        currentNodeId = null;
      }
    } catch (error) {
      failures++;
      if (error instanceof ThreadReadCacheHttpError && error.status === 409) publisher.reset();
      delay = Math.min(60_000, THREAD_READ_CACHE_PUBLISH_INTERVAL_MS * 2 ** Math.min(failures, 4));
      if (error instanceof ThreadReadCacheHttpError && [401, 403, 404].includes(error.status))
        delay = 60_000;
      if (!stopped && failures === 1) {
        try {
          deps.reportFailure();
        } catch {
          /* Diagnostics cannot interrupt synchronization. */
        }
      }
    }
    return delay;
  };
  const schedule = (delay: number) => {
    if (stopped) return;
    const due = Date.now() + delay;
    if (timer !== undefined && scheduledAt <= due) return;
    if (timer !== undefined) clearTimeout(timer);
    scheduledAt = due;
    timer = setTimeout(run, delay);
  };
  const changeDelay = () =>
    Math.max(
      THREAD_READ_CACHE_CHANGE_COALESCE_MS,
      lastStartedAt + THREAD_READ_CACHE_MIN_PUBLISH_INTERVAL_MS - Date.now(),
    );
  const run = () => {
    timer = undefined;
    scheduledAt = Infinity;
    if (stopped || inFlight !== null) return;
    changed = false;
    lastStartedAt = Date.now();
    inFlight = tick().then((delay) => {
      inFlight = null;
      schedule(changed && failures === 0 ? changeDelay() : delay);
    });
  };
  const notifyChanged = () => {
    if (stopped) return;
    changed = true;
    // A domain-event storm must never bypass the failed upload's retry budget.
    if (inFlight === null && failures === 0) schedule(changeDelay());
  };
  schedule(THREAD_READ_CACHE_PUBLISH_INTERVAL_MS);
  const stop = async () => {
    stopped = true;
    publisher.stop();
    abort.abort();
    if (timer !== undefined) clearTimeout(timer);
    await inFlight;
  };
  return Object.assign(stop, { notifyChanged });
}
