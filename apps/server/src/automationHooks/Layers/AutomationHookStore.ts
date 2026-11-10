/**
 * The hook store: listeners and the Hub sync state live here; the queries and secret handling
 * load with the first hook operation (`automationHookStoreSql.ts`), so a node without webhook
 * schedules never loads them.
 *
 * @module automationHooks/Layers/AutomationHookStore
 */
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import type { AutomationHookStoreOps } from "../automationHookStoreSql.ts";
import {
  AutomationHookStore,
  type AutomationHookHubSyncState,
  type AutomationHookStoreShape,
} from "../Services/AutomationHookStore.ts";

export const AutomationHookStoreLive = Layer.effect(
  AutomationHookStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secrets = yield* ServerSecretStore;
    const listeners = new Set<() => void>();
    let hubSyncState: AutomationHookHubSyncState = "unknown";
    let loaded: Promise<AutomationHookStoreOps> | undefined;
    const ops = Effect.promise(() => {
      loaded ??= import("../automationHookStoreSql.ts").then((module) =>
        module.makeAutomationHookStoreOps(sql, secrets),
      );
      return loaded;
    });
    const withOps = <A, E>(
      run: (loadedOps: AutomationHookStoreOps) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E> => ops.pipe(Effect.flatMap(run));
    const notifyChanged = () => {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A listener's failure is its own.
        }
      }
    };
    const shape: AutomationHookStoreShape = {
      reconcile: (automation) =>
        withOps((o) => o.reconcile(automation)).pipe(Effect.ensuring(Effect.sync(notifyChanged))),
      get: (automationId) => withOps((o) => o.get(automationId)),
      findByHookId: (hookId) => withOps((o) => o.findByHookId(hookId)),
      secret: (hook) => withOps((o) => o.secret(hook)),
      regenerate: (automationId) => withOps((o) => o.regenerate(automationId)),
      recordRequest: (input) => withOps((o) => o.recordRequest(input)),
      seenDelivery: (input) => withOps((o) => o.seenDelivery(input)),
      rememberDelivery: (input) => withOps((o) => o.rememberDelivery(input)),
      forgetDelivery: (input) => withOps((o) => o.forgetDelivery(input)),
      startedSince: (input) => withOps((o) => o.startedSince(input)),
      enabledHookIds: withOps((o) => o.enabledHookIds),
      hubRegistered: withOps((o) => o.hubRegistered),
      setHubRegistered: (hookIds) => withOps((o) => o.setHubRegistered(hookIds)),
      hubSyncState: () => hubSyncState,
      setHubSyncState: (state) => {
        hubSyncState = state;
      },
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      notifyChanged,
    };
    return shape;
  }),
);
