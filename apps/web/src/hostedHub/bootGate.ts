import {
  readHostedSignedInHint,
  recordHostedSignedInHint,
  trackHostedSignedInHint,
} from "./bootHints";
import { openWebHubSessionBesideAccessCheck } from "./hubSession";
import { bootstrapWithHostedReadCache, canShowHostedReadPreview } from "./readCache";
import { ensureWebHostedRuntimeConfigured, hostedHubController, hostedHubStore } from "./state";

/** The access check {@link startHostedAccessCheck} sent, until a boot gate takes it. */
let sentAccessCheck: Promise<void> | null = null;

/**
 * Send the hosted access check — the session restore, with the directory read
 * beside it — for this page load.
 *
 * The entry module calls this before it creates the router, so both requests
 * leave ahead of every route and shell chunk instead of queueing behind them
 * on the connection pool; the root `beforeLoad` then waits for this same check
 * in {@link runHostedBootGate}. Idempotent until a gate takes the check, so a
 * boot sends exactly one.
 *
 * Never throws: a failure to send the check is kept for the gate, so the root
 * `beforeLoad` rejects with it and the root error surface offers a retry,
 * instead of the entry module stopping before anything renders.
 */
export function startHostedAccessCheck(): void {
  if (sentAccessCheck) return;
  try {
    sentAccessCheck = sendAccessCheck();
  } catch (error) {
    const failed = Promise.reject(error);
    // Handled here so it is not reported as unhandled before the gate awaits it.
    failed.catch(() => undefined);
    sentAccessCheck = failed;
  }
}

/**
 * The access check, settling once its answer is published (or a remembered
 * read cache can paint). `ensureWebHostedRuntimeConfigured` installs the
 * fail-closed console boundary before any hosted runtime code runs.
 *
 * A browser that was signed in at its last access check most likely still is,
 * so its account socket opens beside the check too: bound to nobody, granted
 * nothing and opening no stream until the answer names the account, and
 * closed by any other answer.
 */
function sendAccessCheck(): Promise<void> {
  ensureWebHostedRuntimeConfigured();
  trackHostedSignedInHint(hostedHubStore);
  const accessCheck = hostedHubController.bootstrapAccess();
  if (readHostedSignedInHint()) openWebHubSessionBesideAccessCheck(accessCheck);
  return bootstrapWithHostedReadCache(() => accessCheck);
}

/**
 * The hosted root `beforeLoad`: the access check and the code the first hosted
 * surface needs.
 *
 * The root route imports this statically (standard builds resolve it to an
 * inert sibling through `src/clientModeSeams.ts`), so the hosted state and the
 * remembered-browser read cache are part of the boot chunk. The access check
 * is the one {@link startHostedAccessCheck} sent, or starts here when nothing
 * has; either way it is on the wire before any prefetch this gate starts, so
 * its answer never waits for those chunk downloads. A check sent here (a gate
 * run nothing sent one for, such as a retry of a failed root load) does follow
 * the caller's own `hostedRoot` load, which starts before this gate runs.
 *
 * `hostedRoot` is the hosted root surface's own load, started by the caller,
 * or null on a path that renders no hosted root (pairing, a native app's
 * sign-in handoff). With a root, the gate resolves once it and, when the
 * account or a remembered preview needs it, the workspace shell are loaded, so
 * the root match commits the surface directly instead of suspending on it.
 * Without one, it waits for the access check alone: those pages never render
 * either surface, and their own route loads what they need.
 *
 * `preloadSignIn` is the page's own sign-in surface (the native handoff's):
 * a browser last seen signed out starts its download beside the access check
 * instead of after the route learns it is needed. Code only; never awaited.
 */
export async function runHostedBootGate(input: {
  readonly pathname: string;
  readonly hostedRoot: Promise<void> | null;
  readonly preloadSignIn?: () => Promise<unknown>;
}): Promise<void> {
  const accessAnswered = sentAccessCheck ?? sendAccessCheck();
  // Taken: a later gate run (a retry of a failed root load) checks access again.
  sentAccessCheck = null;
  const rendersHostedRoot = input.hostedRoot !== null;
  // Code-only prefetches: fetching a chunk starts no session, ticket, relay or
  // store work. Each failure is settled here, so a chunk that fails to load
  // while the gate is still waiting is left for the route's own lazy load to
  // report.
  const hostedRootAppShell = rendersHostedRoot
    ? import("../components/hostedHub/hostedRootAppShell").catch(() => undefined)
    : Promise.resolve(undefined);
  const preloadWorkspaceShell = () =>
    hostedRootAppShell.then((shell) => shell?.preloadHostedRootAppShell().catch(() => undefined));
  const workspaceOwners = import("./hostedWorkspaceOwners").catch(() => undefined);
  // A browser that was signed in at its last access check most likely still
  // is: its workspace shell downloads while the access check is on the wire
  // instead of after it. Everyone else (first visits, signed-out browsers)
  // fetches it only once the answer says it is needed. The access check alone
  // decides what renders either way.
  const signedInHint = readHostedSignedInHint();
  const earlyWorkspaceShell =
    rendersHostedRoot && (signedInHint || canShowHostedReadPreview())
      ? preloadWorkspaceShell()
      : null;
  if (!signedInHint && input.preloadSignIn) {
    void input.preloadSignIn().catch(() => undefined);
  }
  // Start the routed-node orchestrator, workspace coordinator and browser
  // lifecycle now, so route-derived demand reaches `selectNode` as soon as the
  // directory is ready rather than once the hosted root has mounted. They only
  // call into the hosted controller, which stays the one owner; the root
  // retains them as well, so a failed load here changes nothing.
  void workspaceOwners.then((owners) => {
    owners?.retainHostedWorkspaceOwners();
    owners?.prefetchHostedRouteCode(input.pathname);
  });
  // The gate waits for the account answer only. The directory has its own
  // loading and stale surfaces, and waiting for it held a stalled network on
  // the boot surface for a second request deadline.
  await accessAnswered;
  const accountStatus = hostedHubStore.getState().accountStatus;
  recordHostedSignedInHint(accountStatus);
  if (!rendersHostedRoot) return;
  const needsWorkspaceShell = accountStatus === "authenticated" || canShowHostedReadPreview();
  await Promise.all([
    input.hostedRoot,
    needsWorkspaceShell ? (earlyWorkspaceShell ?? preloadWorkspaceShell()) : undefined,
  ]);
}
