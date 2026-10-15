import {
  readHostedSignedInHint,
  recordHostedSignedInHint,
  trackHostedSignedInHint,
} from "./bootHints";
import { bootstrapWithHostedReadCache, canShowHostedReadPreview } from "./readCache";
import { ensureWebHostedRuntimeConfigured, hostedHubController, hostedHubStore } from "./state";

/**
 * The hosted root `beforeLoad`: the access check and the code the first hosted
 * surface needs.
 *
 * The root route imports this statically (standard builds resolve it to an
 * inert sibling through `src/clientModeSeams.ts`), so the hosted state and the
 * remembered-browser read cache are part of the boot chunk and the access check
 * starts without a chunk round trip. `ensureWebHostedRuntimeConfigured`
 * installs the fail-closed console boundary before any hosted runtime code runs.
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
  ensureWebHostedRuntimeConfigured();
  trackHostedSignedInHint(hostedHubStore);
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
  await bootstrapWithHostedReadCache(() => hostedHubController.bootstrapAccess());
  const accountStatus = hostedHubStore.getState().accountStatus;
  recordHostedSignedInHint(accountStatus);
  if (!rendersHostedRoot) return;
  const needsWorkspaceShell = accountStatus === "authenticated" || canShowHostedReadPreview();
  await Promise.all([
    input.hostedRoot,
    needsWorkspaceShell ? (earlyWorkspaceShell ?? preloadWorkspaceShell()) : undefined,
  ]);
}
