/**
 * automationHookView - What the owner's editor shows of a webhook schedule's hook: its URLs, its
 * secret, where the Hub stands with it and its last request (`AutomationHookView`). Loaded with
 * the first read.
 *
 * @module automationHooks/automationHookView
 */
import {
  AUTOMATION_HOOK_HUB_PATH_PREFIX,
  AUTOMATION_HOOK_NODE_PATH_PREFIX,
} from "@ryco/contracts/automation-hooks";
import {
  AgentControlRpcError,
  type AgentControlAutomation,
  type AutomationHookInput,
  type AutomationHookView,
} from "@ryco/contracts";
import { Effect, Option } from "effect";

import type {
  AutomationHookStoreError,
  AutomationHookStoreShape,
} from "./Services/AutomationHookStore.ts";

const conflict = (message: string) =>
  Effect.fail(new AgentControlRpcError({ code: "conflict", message }));

export const automationHookView = (input: {
  readonly store: AutomationHookStoreShape;
  readonly automation: AgentControlAutomation;
  readonly action: AutomationHookInput["action"];
  /** The Hub this node connects to, when it has one. */
  readonly hubOrigin: string | null;
}): Effect.Effect<AutomationHookView, AgentControlRpcError | AutomationHookStoreError> =>
  Effect.gen(function* () {
    const { store, automation } = input;
    if (automation.cancelled || automation.definition.schedule.kind !== "webhook") {
      return yield* conflict("This schedule does not run on a webhook.");
    }
    // A hook the lifecycle could not create (or a lost secret) is created on this read.
    const ensured = yield* store.reconcile(automation);
    const record =
      input.action === "regenerate" ? yield* store.regenerate(automation.automationId) : ensured;
    if (Option.isNone(record)) return yield* conflict("The webhook is unavailable.");
    const secret = yield* store.secret(record.value);
    if (Option.isNone(secret)) return yield* conflict("The webhook's secret is unavailable.");
    const hubOrigin = input.hubOrigin?.replace(/\/+$/u, "") ?? null;
    const registered = hubOrigin === null ? [] : yield* store.hubRegistered;
    const cloudState =
      hubOrigin === null
        ? ("none" as const)
        : !automation.enabled
          ? ("paused" as const)
          : store.hubSyncState() === "unsupported"
            ? ("unsupported" as const)
            : registered.includes(record.value.hookId)
              ? ("registered" as const)
              : ("pending" as const);
    return {
      automationId: automation.automationId,
      hookId: record.value.hookId,
      secret: secret.value,
      directPath: `${AUTOMATION_HOOK_NODE_PATH_PREFIX}${record.value.hookId}`,
      cloudUrl:
        hubOrigin === null || cloudState === "unsupported"
          ? null
          : `${hubOrigin}${AUTOMATION_HOOK_HUB_PATH_PREFIX}${record.value.hookId}`,
      cloudState,
      createdAt: record.value.createdAt,
      secretUpdatedAt: record.value.secretUpdatedAt,
      lastRequest: record.value.lastRequest,
    };
  });
