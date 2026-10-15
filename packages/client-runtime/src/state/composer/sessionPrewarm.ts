import type {
  AgentTokenMode,
  EnvironmentApi,
  ModelSelection,
  OrchestrationSessionStatus,
  ProjectId,
  ProviderSessionPrewarmInput,
  ProviderSessionPrewarmResult,
  RuntimeMode,
  ServerConfig,
  ThreadId,
} from "@ryco/contracts";

/** A repeat of the same request within this window is not sent again. */
export const SESSION_PREWARM_REPEAT_MS = 30_000;
/** Any request for one thread at most this often (a changed model may ask again sooner). */
export const SESSION_PREWARM_MIN_INTERVAL_MS = 3_000;

interface LastRequest {
  readonly key: string;
  readonly atMs: number;
}

const lastRequests = new WeakMap<EnvironmentApi, Map<string, LastRequest>>();

function requestKey(input: ProviderSessionPrewarmInput): string {
  return JSON.stringify([
    input.projectId ?? null,
    input.modelSelection ?? null,
    input.runtimeMode ?? null,
    input.tokenMode ?? null,
  ]);
}

/**
 * Asks the node to start the provider session the composer's next send would start (on
 * composer focus or the first keystroke), so the send does not wait for the provider to boot.
 * Fire and forget: throttled per environment and thread, never throws, and a no-op unless
 * `supported` (the node advertises `providerSessionPrewarm`) and the transport has the method.
 * Returns whether a request was sent.
 */
export function requestProviderSessionPrewarm(input: {
  readonly api: EnvironmentApi | undefined;
  readonly supported: boolean;
  readonly request: ProviderSessionPrewarmInput;
  readonly nowMs?: number;
  readonly onResult?: (result: ProviderSessionPrewarmResult) => void;
}): boolean {
  const call = input.api?.server?.prewarmProviderSession;
  if (!input.supported || !input.api || !call) return false;
  const nowMs = input.nowMs ?? Date.now();
  let byThread = lastRequests.get(input.api);
  if (!byThread) {
    byThread = new Map();
    lastRequests.set(input.api, byThread);
  }
  const key = requestKey(input.request);
  const last = byThread.get(input.request.threadId);
  if (
    last !== undefined &&
    (nowMs - last.atMs < SESSION_PREWARM_MIN_INTERVAL_MS ||
      (last.key === key && nowMs - last.atMs < SESSION_PREWARM_REPEAT_MS))
  ) {
    return false;
  }
  byThread.set(input.request.threadId, { key, atMs: nowMs });
  void call(input.request).then(
    (result) => input.onResult?.(result),
    () => {
      // Best effort: the send starts the session itself.
    },
  );
  return true;
}

/** Whether the node advertises `provider.prewarmSession`. */
export function selectProviderSessionPrewarmSupported(config: ServerConfig | null): boolean {
  return config?.environment.capabilities.providerSessionPrewarm === true;
}

export interface ProviderSessionPrewarmContext {
  /** The composer's thread: a server thread, or a draft that has none yet. */
  readonly thread:
    | {
        readonly id: ThreadId;
        readonly projectId: ProjectId;
        readonly session: { readonly orchestrationStatus: OrchestrationSessionStatus } | null;
      }
    | null
    | undefined;
  readonly isServerThread: boolean;
  /** A chat whose folder its first send creates: there is no directory to start in yet. */
  readonly isPendingChat?: boolean;
  /** Whether this client may send to the thread now (connection, role, readiness). */
  readonly dispatchAllowed: boolean;
  /** A hosted draft whose target node is still being chosen. */
  readonly hostedTargetPending?: boolean;
  /**
   * The send's worktree plan. A send that first creates a worktree, or materializes a
   * legacy branch worktree, starts in a directory that does not exist yet.
   */
  readonly worktreePlan?: {
    readonly shouldCreateWorktree: boolean;
    readonly shouldMaterializeLegacyBranchWorktree: boolean;
  };
  /** What the composer would send with; the thread's settings when absent. */
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly tokenMode: AgentTokenMode;
}

/**
 * The prewarm request for the session the composer's next send would start, or null
 * when there is nothing to start: no thread, sending is not allowed now, the thread's
 * session is already live (anything but stopped), or the send first creates the
 * directory it runs in (a pending chat folder or a new worktree). Pure; pass the result
 * to {@link requestProviderSessionPrewarm}, which throttles and sends it.
 */
export function resolveProviderSessionPrewarmRequest(
  context: ProviderSessionPrewarmContext,
): ProviderSessionPrewarmInput | null {
  const thread = context.thread;
  if (
    !thread ||
    context.isPendingChat === true ||
    !context.dispatchAllowed ||
    context.hostedTargetPending === true ||
    (thread.session !== null && thread.session.orchestrationStatus !== "stopped")
  ) {
    return null;
  }
  if (
    context.worktreePlan?.shouldCreateWorktree === true ||
    context.worktreePlan?.shouldMaterializeLegacyBranchWorktree === true
  ) {
    return null;
  }
  return {
    threadId: thread.id,
    ...(context.isServerThread ? {} : { projectId: thread.projectId }),
    ...(context.modelSelection ? { modelSelection: context.modelSelection } : {}),
    runtimeMode: context.runtimeMode,
    tokenMode: context.tokenMode,
  };
}
