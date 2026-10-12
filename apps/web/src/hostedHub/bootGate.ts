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
 * `hostedRoot` is the hosted root surface's own load, started by the caller;
 * the gate resolves once it and, when the account or a remembered preview needs
 * it, the workspace shell are loaded, so the root match commits the surface
 * directly instead of suspending on it.
 */
export async function runHostedBootGate(input: {
  readonly pathname: string;
  readonly hostedRoot: Promise<void>;
}): Promise<void> {
  // Code-only prefetches: fetching a chunk starts no session, ticket, relay or
  // store work, so the workspace-owner module and the workspace shell download
  // while the access check is on the wire instead of after it. Each failure is
  // settled here, so a chunk that fails to load while the gate is still
  // waiting is left for the route's own lazy load to report.
  const hostedRootAppShell = import("../components/hostedHub/hostedRootAppShell").catch(
    () => undefined,
  );
  const workspaceOwners = import("./hostedWorkspaceOwners").catch(() => undefined);
  ensureWebHostedRuntimeConfigured();
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
  const needsWorkspaceShell =
    hostedHubStore.getState().accountStatus === "authenticated" || canShowHostedReadPreview();
  await Promise.all([
    input.hostedRoot,
    needsWorkspaceShell
      ? hostedRootAppShell.then((shell) =>
          shell?.preloadHostedRootAppShell().catch(() => undefined),
        )
      : undefined,
  ]);
}
