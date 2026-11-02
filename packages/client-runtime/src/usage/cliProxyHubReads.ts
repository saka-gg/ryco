// @effect-diagnostics globalDate:off
/**
 * How every client reads a node's CLIProxyAPI hubs: the web composer and Limits page, the
 * phone's Limits tab, and later its widgets. One policy, so the surfaces cannot drift.
 *
 * @module usage/cliProxyHubReads
 */
import type {
  CliProxyHubSnapshot,
  CliProxyReadHubsInput,
  CliProxyReadHubsResult,
  EnvironmentId,
  ServerConfig,
} from "@ryco/contracts";
import { isTagged } from "effect/Predicate";

import { isUnsupportedRpcError } from "../errors/transportError.ts";
import { SharedRequests } from "./sharedRequests.ts";

/**
 * How long a successful read answers again, so reopening a view does not ask the node. The
 * node caches hub reads and floors upstream quota calls further.
 */
export const CLI_PROXY_HUB_READ_REUSE_MS = 30_000;

/** How often a view that stays open (the web Limits page, phone widgets) reads hubs again. */
export const CLI_PROXY_HUB_POLL_INTERVAL_MS = 5 * 60_000;

export const CLI_PROXY_HUBS_UNSUPPORTED_MESSAGE =
  "Update Ryco on this node to read CLIProxyAPI hubs.";

/** Whether to ask a node for hubs. A node whose config is not known yet is asked. */
export function cliProxyHubsSupported(
  config: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return config == null || config.environment.capabilities.cliProxyHubs === true;
}

/** The node refuses this session hub reads (it is not the node's owner). */
export function isCliProxyHubReadRefused(cause: unknown): boolean {
  return isTagged(cause, "AuthRpcError");
}

/** One node's answer to a hub read. */
export interface CliProxyHubRead {
  /**
   * - `ok`: the node answered. A node that refuses this session hub reads answers `ok` with
   *   no hubs: there is nothing this session may show.
   * - `unsupported`: the node predates hubs, so it is not asked (or did not know the call).
   * - `failed`: the read failed; `message` says why. A later read asks again.
   */
  readonly status: "ok" | "failed" | "unsupported";
  readonly hubs: ReadonlyArray<CliProxyHubSnapshot>;
  readonly message?: string;
  /** When the answer arrived, in epoch ms. Hub snapshot times are never later than this. */
  readonly receivedAtMs: number;
}

const NO_HUBS: ReadonlyArray<CliProxyHubSnapshot> = [];

function unsupportedRead(receivedAtMs: number): CliProxyHubRead {
  return {
    status: "unsupported",
    hubs: NO_HUBS,
    message: CLI_PROXY_HUBS_UNSUPPORTED_MESSAGE,
    receivedAtMs,
  };
}

/** Run one hub read and classify its outcome by the shared policy. Never rejects. */
export async function readCliProxyHubsOutcome(
  read: () => Promise<CliProxyReadHubsResult>,
  now: () => number = Date.now,
): Promise<CliProxyHubRead> {
  try {
    const result = await read();
    return { status: "ok", hubs: result.hubs, receivedAtMs: now() };
  } catch (cause) {
    if (isCliProxyHubReadRefused(cause))
      return { status: "ok", hubs: NO_HUBS, receivedAtMs: now() };
    if (isUnsupportedRpcError(cause)) return unsupportedRead(now());
    return {
      status: "failed",
      hubs: NO_HUBS,
      message: cause instanceof Error ? cause.message : String(cause),
      receivedAtMs: now(),
    };
  }
}

/** How an app reaches its nodes' hubs. */
export interface CliProxyHubReader {
  /** Ask the node. Rejects when the node cannot be reached. */
  readonly readHubs: (
    environmentId: EnvironmentId,
    input: CliProxyReadHubsInput,
  ) => Promise<CliProxyReadHubsResult>;
  /** Whether the node can answer (`cliProxyHubsSupported` of its config). Defaults to asking. */
  readonly supportsHubs?: (environmentId: EnvironmentId) => boolean;
}

export interface CliProxyHubReadOptions {
  /** An explicit refresh: never reuse an earlier answer, and ask the node to bypass its caches. */
  readonly refresh?: boolean | undefined;
}

/**
 * A client's hub reads per node. A successful read answers again for
 * {@link CLI_PROXY_HUB_READ_REUSE_MS}; identical reads in flight share one request; a failure is
 * asked again by the next read. The last successful read of each node stays readable through
 * {@link snapshot} and {@link subscribe}, for views that follow hubs without asking for them.
 */
export class CliProxyHubReads {
  readonly #reader: CliProxyHubReader;
  readonly #reuseMs: number;
  readonly #now: () => number;
  readonly #requests: SharedRequests<CliProxyHubRead>;
  #reads: ReadonlyMap<EnvironmentId, CliProxyHubRead> = new Map();
  readonly #listeners = new Set<() => void>();
  /** Bumped by {@link forget}: a read started before keeps its answer to itself. */
  readonly #generations = new Map<EnvironmentId, number>();
  /** Bumped by {@link clear}, likewise for every node. */
  #clears = 0;

  constructor(
    reader: CliProxyHubReader,
    options: { readonly reuseMs?: number; readonly now?: () => number } = {},
  ) {
    this.#reader = reader;
    this.#reuseMs = options.reuseMs ?? CLI_PROXY_HUB_READ_REUSE_MS;
    this.#now = options.now ?? Date.now;
    this.#requests = new SharedRequests({ now: this.#now });
  }

  /** The node's hubs by the shared policy. Never rejects. */
  read(
    environmentId: EnvironmentId,
    options: CliProxyHubReadOptions = {},
  ): Promise<CliProxyHubRead> {
    if (this.#reader.supportsHubs?.(environmentId) === false) {
      return Promise.resolve(unsupportedRead(this.#now()));
    }
    const refresh = options.refresh === true;
    const last = this.#reads.get(environmentId);
    if (!refresh && last !== undefined && this.#now() - last.receivedAtMs <= this.#reuseMs) {
      return Promise.resolve(last);
    }
    // A refresh never joins a plain read: it asks the node for something else.
    const key = `${environmentId}\0${refresh ? "refresh" : "read"}`;
    // Without a signal the flight runs to the end: the node cannot withdraw a hub read.
    return this.#requests.request(key, () => this.#read(environmentId, refresh));
  }

  /** Every node's last successful read; a new map whenever one changes. */
  snapshot(): ReadonlyMap<EnvironmentId, CliProxyHubRead> {
    return this.#reads;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Drop one node's answers, e.g. when the client stops speaking for it. */
  forget(environmentId: EnvironmentId): void {
    this.#generations.set(environmentId, (this.#generations.get(environmentId) ?? 0) + 1);
    const prefix = `${environmentId}\0`;
    this.#requests.forgetMatching((key) => key.startsWith(prefix));
    if (!this.#reads.has(environmentId)) return;
    const next = new Map(this.#reads);
    next.delete(environmentId);
    this.#publish(next);
  }

  /** Drop every answer (account teardown). */
  clear(): void {
    this.#clears += 1;
    this.#requests.clear();
    if (this.#reads.size > 0) this.#publish(new Map());
  }

  #generation(environmentId: EnvironmentId): string {
    return `${this.#clears}\0${this.#generations.get(environmentId) ?? 0}`;
  }

  async #read(environmentId: EnvironmentId, refresh: boolean): Promise<CliProxyHubRead> {
    const generation = this.#generation(environmentId);
    const result = await readCliProxyHubsOutcome(
      () => this.#reader.readHubs(environmentId, refresh ? { refresh: true } : {}),
      this.#now,
    );
    if (result.status === "ok" && this.#generation(environmentId) === generation) {
      this.#publish(new Map(this.#reads).set(environmentId, result));
    }
    return result;
  }

  #publish(next: ReadonlyMap<EnvironmentId, CliProxyHubRead>): void {
    this.#reads = next;
    for (const listener of this.#listeners) listener();
  }
}
