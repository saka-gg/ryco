import type { EnvironmentId, ServerLifecycleWelcomePayload, ThreadId } from "@ryco/contracts";

import type { PresentationTier } from "../lib/presentationTier";

export function resolveCanonicalPrimaryEnvironmentId(input: {
  readonly hosted: boolean;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly serverEnvironmentId: EnvironmentId;
}): EnvironmentId | null {
  return input.hosted ? input.primaryEnvironmentId : input.serverEnvironmentId;
}

/**
 * Whether the welcome payload's bootstrap thread should replace the logical
 * root route. Desktop keeps its last-thread redirect; the phone tier lands on
 * Home (the thread list) instead, which is the phone default surface after a
 * session is established.
 */
export function shouldApplyBootstrapThreadRedirect(input: {
  readonly pathname: string;
  readonly tier: PresentationTier;
  readonly hostedHome?: boolean;
}): boolean {
  return input.pathname === "/" && input.tier !== "phone" && !input.hostedHome;
}

/**
 * Whether this boot will paint a primary shell, which decides how long the
 * speculative preloads may wait for it: a standard session always does, and
 * so does a hosted session opened on a routed node (its shell arrives over
 * the relay, the slowest path). Hosted-static and a hosted session without a
 * node (the directory) may never paint one.
 */
export function expectsPrimaryShellPaint(input: {
  readonly status: "authenticated" | "hosted-static" | "hosted-hub" | "hosted-cached";
  readonly routedHostedNodeId: string | null;
}): boolean {
  if (input.status === "authenticated") return true;
  return input.status === "hosted-hub" && input.routedHostedNodeId !== null;
}

/**
 * Warms the welcome's bootstrap thread while the shell is still loading, when
 * the shell will redirect to it (the same gate as the redirect, so the frozen
 * phone tier stays on demand): its route chunk follows the shell graph, never
 * competing with it, and its detail stream opens now. Both are idempotent with
 * the shell's own warm-up. Returns whether it warmed.
 */
export function warmBootstrapThread(
  payload: ServerLifecycleWelcomePayload,
  input: {
    readonly pathname: string;
    readonly tier: PresentationTier;
    /** The shell graph's download; never rejects. */
    readonly preloadShell: () => Promise<unknown>;
    readonly preloadThreadRoute: () => unknown;
    readonly prewarmThreadDetail: (environmentId: EnvironmentId, threadId: ThreadId) => unknown;
  },
): boolean {
  const threadId = payload.bootstrapThreadId;
  if (
    !threadId ||
    !shouldApplyBootstrapThreadRedirect({ pathname: input.pathname, tier: input.tier })
  ) {
    return false;
  }
  void input.preloadShell().then(() => input.preloadThreadRoute());
  input.prewarmThreadDetail(payload.environment.environmentId, threadId);
  return true;
}
