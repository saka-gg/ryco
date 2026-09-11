import type { EnvironmentApi, EnvironmentId } from "@ryco/contracts";
import { createEnvironmentApi, createEnvironmentApiLookup } from "@ryco/client-runtime/connection";
import type { WsRpcClient } from "@ryco/client-runtime/rpc";
import type { ServerSettingsPatch } from "@ryco/contracts/settings";

import { createMobileConnectionRegistry } from "../runtime/bootstrap";
import { patchEnvironmentServerSettings } from "../state/environmentServerConfigs";

// Mobile analog of apps/web/src/environmentApi.ts. The single seam that turns an
// EnvironmentId into the typed RPC surface the send pipeline, approvals/user-input
// wrappers, and the checkpoint-diff cache dispatch through. Bound to the app's
// single-homed connection registry (bootstrap singletons); the supervisor owns
// the live client per environment, so this stays a thin lookup with no state.
export { createEnvironmentApi };

// Resolve the registry lazily (not at module load): the checkpoint-diff cache
// (§6) imports this module and is itself imported by the driver, so eager
// construction here would close a module-load cycle (driver -> cache ->
// environmentApi -> bootstrap -> driver) and trip a TDZ. Deferring to first call
// keeps the static import edge but runs after all modules initialize.
let cachedRegistry: ReturnType<typeof createMobileConnectionRegistry> | null = null;
function registry() {
  return (cachedRegistry ??= createMobileConnectionRegistry());
}
const environmentApiOverridesForTests = new Map<EnvironmentId, EnvironmentApi>();

function readClientForEnvironment(environmentId: EnvironmentId): WsRpcClient | null {
  return registry().driver.supervisor.read(environmentId)?.client ?? null;
}

const lookup = createEnvironmentApiLookup({
  canReadConnections: () => true,
  readClient: readClientForEnvironment,
});

const rpcClientOverridesForTests = new Map<EnvironmentId, WsRpcClient>();

/**
 * The raw RPC client, for methods the typed `EnvironmentApi` facade omits.
 *
 * `EnvironmentApi.sourceControl` (contracts/src/ipc.ts) exposes only
 * lookupRepository / searchRepositories / cloneRepository / publishRepository,
 * while the live client also carries the source-control CHECK family —
 * `sourceControl.getChangeRequestDetail`, `.listWorkflowRuns`,
 * `.getWorkflowRunJobs`. apps/web reaches those off the same live client rather
 * than through the facade, and this is mobile doing the same thing, so no shared
 * package has to change to read CI state.
 *
 * Prefer `readEnvironmentApi()` for anything the facade already covers.
 */
export function readRpcClient(environmentId: EnvironmentId): WsRpcClient | null {
  return rpcClientOverridesForTests.get(environmentId) ?? readClientForEnvironment(environmentId);
}

export function __setRpcClientOverrideForTests(
  environmentId: EnvironmentId,
  client: WsRpcClient,
): void {
  rpcClientOverridesForTests.set(environmentId, client);
}

export function __resetRpcClientOverridesForTests(): void {
  rpcClientOverridesForTests.clear();
}

export function readEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi | undefined {
  return environmentApiOverridesForTests.get(environmentId) ?? lookup.read(environmentId);
}

export function ensureEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error(`Environment API not found for environment ${environmentId}`);
  return api;
}

/** Updates one environment without changing the active environment or opening a connection. */
export async function updateEnvironmentServerSettings(
  environmentId: EnvironmentId,
  patch: ServerSettingsPatch,
): Promise<void> {
  const client = readRpcClient(environmentId);
  if (!client) throw new Error("Connect this device before changing its settings.");
  const settings = await client.server.updateSettings(patch);
  patchEnvironmentServerSettings(environmentId, settings);
}

export function __setEnvironmentApiOverrideForTests(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
): void {
  environmentApiOverridesForTests.set(environmentId, api);
}

export function __resetEnvironmentApiOverridesForTests(): void {
  environmentApiOverridesForTests.clear();
}

export type { WsRpcClient };
