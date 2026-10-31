/**
 * `ryco service status --ready`: whether this home's node answers as itself.
 *
 * Loaded through `import()` from the CLI, so it takes everything it needs as
 * input and imports no server value: the boot bundle stays as it is.
 *
 * Steps (Synara's `server status`, adapted to Ryco's runtime file and identity):
 * the runtime file names a server, that server's pid is alive and its port
 * accepts connections, its unauthenticated environment descriptor answers
 * within 3 s, and the descriptor names this home's environment id. Any other
 * answer is not ready, with the step that failed.
 */

export const SERVER_READINESS_TIMEOUT_MS = 3_000;

/** The unauthenticated descriptor route (`http.ts` SERVER_ENVIRONMENT_DESCRIPTOR_PATH). */
const ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/ryco/environment";

export type ServerReadinessReason =
  /** No runtime file: no server of this home has started. */
  | "not-running"
  /** The runtime file names a server whose pid is gone or whose port is closed. */
  | "stale-runtime-file"
  /** The server runs but does not answer yet (startup gate, timeout, 503). */
  | "starting"
  /** Something answers on the port, but not this home's node. */
  | "other-node"
  /** The request failed, or the answer was not a descriptor. */
  | "unreachable";

export type ServerReadiness =
  | { readonly ready: true; readonly reason: null; readonly origin: string }
  | {
      readonly ready: false;
      readonly reason: ServerReadinessReason;
      readonly origin: string | null;
    };

export interface ServerReadinessRuntime {
  readonly pid: number;
  readonly port: number;
  readonly origin: string;
}

export type ReadinessFetch = (url: URL, init: RequestInit) => Promise<Response>;

export async function probeServerReadiness(input: {
  /** The parsed `server-runtime.json`, or undefined when it is absent or unreadable. */
  readonly runtime: ServerReadinessRuntime | undefined;
  /** The trimmed contents of this home's `environment-id`, when it exists. */
  readonly environmentId: string | undefined;
  /** `isPersistedServerRunning` (pid alive and port accepting). */
  readonly isRunning: (runtime: ServerReadinessRuntime) => Promise<boolean>;
  readonly fetch?: ReadinessFetch;
  readonly timeoutMs?: number;
}): Promise<ServerReadiness> {
  const { runtime } = input;
  if (!runtime) return { ready: false, reason: "not-running", origin: null };
  const notReady = (reason: ServerReadinessReason): ServerReadiness => ({
    ready: false,
    reason,
    origin: runtime.origin,
  });
  if (!(await input.isRunning(runtime))) return notReady("stale-runtime-file");

  let url: URL;
  try {
    url = new URL(ENVIRONMENT_DESCRIPTOR_PATH, runtime.origin);
  } catch {
    return notReady("unreachable");
  }
  // The origin comes from the owner-only runtime file; still, never send a request
  // anywhere but plain http(s) without credentials.
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    return notReady("unreachable");
  }

  let response: Response;
  try {
    response = await (input.fetch ?? ((target, init) => globalThis.fetch(target, init)))(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(input.timeoutMs ?? SERVER_READINESS_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return notReady(name === "TimeoutError" || name === "AbortError" ? "starting" : "unreachable");
  }
  if (response.status === 503) return notReady("starting");
  if (response.status !== 200) return notReady("unreachable");

  let environmentId: unknown;
  try {
    const body: unknown = await response.json();
    environmentId =
      typeof body === "object" && body !== null
        ? (body as { readonly environmentId?: unknown }).environmentId
        : undefined;
  } catch {
    return notReady("unreachable");
  }
  if (typeof environmentId !== "string" || environmentId.length === 0) {
    return notReady("unreachable");
  }
  const expected = input.environmentId?.trim();
  if (!expected || environmentId !== expected) return notReady("other-node");
  return { ready: true, reason: null, origin: runtime.origin };
}

export function describeServerReadiness(readiness: ServerReadiness): string {
  switch (readiness.reason) {
    case null:
      return "ready";
    case "not-running":
      return "not ready: no server of this home is running";
    case "stale-runtime-file":
      return "not ready: the server this home last started is gone";
    case "starting":
      return "not ready: the server is running but does not answer yet";
    case "other-node":
      return "not ready: another node answers on this home's port";
    case "unreachable":
      return "not ready: the server did not answer as a Ryco node";
  }
}
