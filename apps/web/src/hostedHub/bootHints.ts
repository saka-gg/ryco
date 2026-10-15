import type { HostedHubState } from "./state";

/**
 * A non-secret boot hint: whether this browser's last settled hosted access
 * check was signed in. It only decides how early the boot gate starts
 * downloading the workspace shell code (beside the access check rather than
 * after it); it never grants, skips or delays access, which the access check
 * alone decides. A stale hint costs one unneeded (or one later) code download.
 *
 * It is kept regardless of "Remember this browser": that preference governs
 * the offline read cache (conversation content and workspace metadata), while
 * this flag holds no account, node or content data, only whether the last
 * access check here was signed in, and is cleared by a sign-out, an expiry or
 * the next access check that finds the browser signed out. Gating it on the
 * preference (off by default) would drop the early shell download for most
 * browsers.
 */
const SIGNED_IN_HINT_KEY = "ryco:hosted-signed-in:v1";

export function readHostedSignedInHint(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIGNED_IN_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Records the hint from a settled account status. Transitional states
 * (`authenticating`, `unavailable`) leave it as it was.
 */
export function recordHostedSignedInHint(accountStatus: HostedHubState["accountStatus"]): void {
  try {
    if (accountStatus === "authenticated") {
      globalThis.localStorage?.setItem(SIGNED_IN_HINT_KEY, "1");
    } else if (
      accountStatus === "signed-out" ||
      accountStatus === "signing-out" ||
      accountStatus === "session-expired"
    ) {
      globalThis.localStorage?.removeItem(SIGNED_IN_HINT_KEY);
    }
  } catch {
    // Storage can be disabled; the hint is an optimization only.
  }
}

let tracking = false;

/** Keeps the hint current as the account signs in or out on this page. Idempotent. */
export function trackHostedSignedInHint(store: {
  readonly getState: () => Pick<HostedHubState, "accountStatus">;
  readonly subscribe: (listener: () => void) => () => void;
}): void {
  if (tracking) return;
  tracking = true;
  let last = store.getState().accountStatus;
  store.subscribe(() => {
    const next = store.getState().accountStatus;
    if (next === last) return;
    last = next;
    recordHostedSignedInHint(next);
  });
}

export function resetHostedBootHintsForTests(): void {
  tracking = false;
  try {
    globalThis.localStorage?.removeItem(SIGNED_IN_HINT_KEY);
  } catch {
    // Storage can be disabled.
  }
}
