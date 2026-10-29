/**
 * "Update everything" on the phone: the plan for every connected machine and
 * the one run that carries it out. Planning, running and wording live in
 * `@ryco/client-runtime/updates`, shared with web and desktop; this module
 * feeds them this app's connections, roles, chats and node update states, and
 * keeps the run outside React so it survives leaving the screen. The phone has
 * no Ryco of its own to update.
 */
import { createNodeUpdateStore } from "@ryco/client-runtime/state/nodeUpdate";
import {
  assembleUpdateEverythingInputs,
  createNodeUpdateWiring,
  createUpdateEverythingRunner,
  type UpdateEverythingEnvironmentInput,
  type UpdateEverythingEnvironmentSource,
  type UpdateEverythingIo,
  type UpdateEverythingResultDescription,
} from "@ryco/client-runtime/updates";
import type { EnvironmentTurnActivity } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";

import { readRpcClient } from "../../../connection/environmentApi";
import { uuidv4 } from "../../../lib/uuid";
import { createMobileConnectionRegistry } from "../../../runtime/bootstrap";
import {
  readEnvironmentServerConfig,
  subscribeEnvironmentServerConfigs,
} from "../../../state/environmentServerConfigs";

/** What the Updates screen last read about every machine; the run reads it at the tap. */
export interface MobileUpdateSources {
  readonly environments: ReadonlyArray<UpdateEverythingEnvironmentSource>;
  readonly activity: ReadonlyMap<EnvironmentId, EnvironmentTurnActivity>;
}

let sources: MobileUpdateSources = { environments: [], activity: new Map() };

export function setMobileUpdateSources(next: MobileUpdateSources): void {
  sources = next;
}

/** The planner's view of `from`; the phone hosts no node of its own. */
export function assembleMobileUpdateInputs(
  from: MobileUpdateSources,
): ReadonlyArray<UpdateEverythingEnvironmentInput> {
  return assembleUpdateEverythingInputs({
    environments: from.environments,
    activity: from.activity,
    primaryEnvironmentId: null,
    isElectron: false,
  });
}

const supervisor = () => createMobileConnectionRegistry().driver.supervisor;

export const mobileNodeUpdateStore = createNodeUpdateStore();

const mayMutate = (environmentId: EnvironmentId) =>
  sources.environments.some(
    (environment) => environment.environmentId === environmentId && environment.canMutate,
  );

const wiring = createNodeUpdateWiring(mobileNodeUpdateStore, {
  listConnections: () => supervisor().list(),
  // Any role may follow a node's update stream; the node checks every call.
  canFollow: (environmentId) =>
    readEnvironmentServerConfig(environmentId)?.environment?.capabilities?.nodeSelfUpdate === true,
  subscriptions: [
    (listener) => supervisor().subscribe(listener),
    subscribeEnvironmentServerConfigs,
  ],
});

/** Follows every connected machine that can update itself until the returned stop runs. */
export function startMobileNodeUpdateWiring(): () => void {
  return wiring.start();
}

const io: UpdateEverythingIo = {
  updateProvider: async (environmentId, input) => {
    const client = readRpcClient(environmentId);
    if (!client) throw new Error("This machine is not connected.");
    return client.server.updateProvider({ provider: input.provider, instanceId: input.instanceId });
  },
  updateNode: (environmentId, input) => mobileNodeUpdateStore.update(environmentId, input),
  waitForNodeOutcome: (environmentId, input) =>
    mobileNodeUpdateStore.waitForOutcome(environmentId, input),
  nodeUpdates: mobileNodeUpdateStore,
  isStillAllowed: (environmentId) =>
    supervisor().read(environmentId) !== null && mayMutate(environmentId),
  installThisApp: async () => false,
  newRequestId: uuidv4,
};

/** How long "check for updates" waits for any one answer before it stops showing progress. */
const CHECK_TIMEOUT_MS = 60_000;

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Every connected machine this phone may update checks for a release and
 * re-reads its providers. Each failure stays with its own machine.
 */
async function checkEverything(): Promise<void> {
  const checks: Array<Promise<unknown>> = [];
  for (const environmentId of wiring.attachedEnvironmentIds()) {
    if (!mayMutate(environmentId)) continue;
    checks.push(mobileNodeUpdateStore.check(environmentId));
  }
  for (const environment of sources.environments) {
    if (!environment.live || !environment.canMutate) continue;
    const client = readRpcClient(environment.environmentId);
    if (client) checks.push(Promise.resolve().then(() => client.server.refreshProviders({})));
  }
  await Promise.allSettled(checks.map((check) => settleWithin(check, CHECK_TIMEOUT_MS)));
}

let showResult: (description: UpdateEverythingResultDescription) => void = () => undefined;

/** The screen shows the finished run's notice while it is open. */
export function setMobileUpdateResultPresenter(
  present: (description: UpdateEverythingResultDescription) => void,
): () => void {
  showResult = present;
  return () => {
    if (showResult === present) showResult = () => undefined;
  };
}

/** The app's one run; module-level, so it outlives the screen that starts it. */
export const mobileUpdateRunner = createUpdateEverythingRunner({
  readInputs: () => ({ environments: assembleMobileUpdateInputs(sources), localApp: null }),
  io,
  showResult: (description) => showResult(description),
  checkAll: checkEverything,
});
