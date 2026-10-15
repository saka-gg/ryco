import {
  getWsConnectionStatusForEnvironment,
  getWsConnectionUiState,
} from "@ryco/client-runtime/rpc";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  requestProviderSessionPrewarm,
  resolveProviderSessionPrewarmRequest,
  selectProviderSessionPrewarmSupported,
} from "@ryco/client-runtime/state/composer";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { DEFAULT_AGENT_TOKEN_MODE, type ModelSelection } from "@ryco/contracts/orchestration";

import { readEnvironmentApi } from "../../connection/environmentApi";
import { readEnvironmentServerConfig } from "../../state/environmentServerConfigs";
import {
  selectEnvironmentShellLive,
  selectThreadByRef,
  useStore,
} from "../../state/threadsRuntime";

/**
 * Composer focus or the first keystroke: asks the node to start the provider
 * session this thread's next send would start, so the send does not wait for
 * the provider to boot. The gating policy is shared with the web composer
 * (`resolveProviderSessionPrewarmRequest`), and the request is throttled per
 * thread by `requestProviderSessionPrewarm`. Mobile thread sends never create a
 * worktree first, so there is no worktree plan to consult.
 *
 * Everything is read from the stores when the intent fires, not from a render.
 * Returns whether a request was sent.
 */
export function prewarmThreadProviderSession(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The model the next send would use (a staged pick, else the thread's). */
  readonly modelSelection: ModelSelection | null;
  /**
   * The environment's shared mutation readiness (connection, API and role):
   * a hosted viewer cannot start sessions, so it sends nothing.
   */
  readonly mutationReady: boolean;
}): boolean {
  if (!input.mutationReady) return false;
  const state = useStore.getState();
  const thread = selectThreadByRef(state, scopeThreadRef(input.environmentId, input.threadId));
  if (!thread) return false;
  // A row from the snapshot cache is last-known state: its stopped session may
  // be running on the node, and the socket may not carry mutations yet. Both
  // are read now, not from the render that passed `mutationReady`.
  const dispatchAllowed =
    selectEnvironmentShellLive(state, input.environmentId) &&
    getWsConnectionUiState(getWsConnectionStatusForEnvironment(input.environmentId)) ===
      "connected";
  const request = resolveProviderSessionPrewarmRequest({
    thread,
    isServerThread: true,
    dispatchAllowed,
    modelSelection: input.modelSelection ?? thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    tokenMode: thread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
  });
  if (request === null) return false;
  return requestProviderSessionPrewarm({
    api: readEnvironmentApi(input.environmentId),
    supported: selectProviderSessionPrewarmSupported(
      readEnvironmentServerConfig(input.environmentId),
    ),
    request,
  });
}
