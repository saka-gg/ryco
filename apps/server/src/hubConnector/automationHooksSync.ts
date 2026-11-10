/**
 * automationHooksSync - Keeps the Hub's copy of this node's webhook hooks current and collects
 * the requests it holds for them (`docs/automation-webhooks.md`, "The Hub path").
 *
 * - Syncs when the connector comes online, when the set of enabled hooks changes, when the Hub
 *   sends `node.automation-hooks.pending`, and every 10 minutes while the node has hooks.
 * - One sync at a time; a trigger during a sync starts another after it. While an answer says
 *   `more`, or handed out requests that still need their outcomes, it syncs again at once.
 * - Each sync sends the complete list of enabled hooks (an empty list once, after the last hook
 *   goes) and the outcomes of the previous answer's requests.
 * - A Hub that answers 404 predates hooks (or no longer knows the node): no sync until the next
 *   connect, or a nudge, which only a Hub with hooks sends. A failed sync (a 429 included) is
 *   tried again later with backoff, keeping its outcomes for the next one.
 *
 * @module hubConnector/automationHooksSync
 */
import type {
  NodeAutomationHookAck,
  NodeAutomationHookDelivery,
  NodeAutomationHooksSyncResult,
} from "@ryco/contracts/automation-hooks";

export type AutomationHooksSyncOutcome =
  | { readonly kind: "answered"; readonly result: NodeAutomationHooksSyncResult }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed" };

/** What the node did with a handed-out request: an outcome to send, or none (lease runs out). */
export type AutomationHookDeliveryOutcome = NodeAutomationHookAck["outcome"] | "retry";

export type AutomationHooksSyncTrigger = "online" | "changed" | "nudge";

export const AUTOMATION_HOOKS_SYNC_PERIOD_MS = 10 * 60_000;
/** The sync after a connect waits up to this long: nodes reconnecting together spread out. */
export const AUTOMATION_HOOKS_SYNC_CONNECT_JITTER_MS = 5_000;
export const AUTOMATION_HOOKS_SYNC_RETRY_MS = 60_000;
/** Rounds one sync run makes while answers say `more`, before it yields to a timer. */
export const AUTOMATION_HOOKS_SYNC_MAX_ROUNDS = 20;

export interface AutomationHooksSyncDeps {
  readonly listHookIds: () => Promise<ReadonlyArray<string>>;
  readonly hubRegistered: () => Promise<ReadonlyArray<string>>;
  readonly setHubRegistered: (hookIds: ReadonlyArray<string>) => Promise<void>;
  readonly sync: (input: {
    readonly hookIds: ReadonlyArray<string>;
    readonly acks: ReadonlyArray<NodeAutomationHookAck>;
  }) => Promise<AutomationHooksSyncOutcome>;
  readonly deliver: (
    delivery: NodeAutomationHookDelivery,
  ) => Promise<AutomationHookDeliveryOutcome>;
  readonly onState?: (state: "synced" | "unsupported") => void;
  readonly isOnline: () => boolean;
  readonly random: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly onError?: (error: unknown) => void;
}

export interface AutomationHooksSync {
  readonly request: (trigger: AutomationHooksSyncTrigger) => void;
  readonly stop: () => void;
  /** Settles once no sync is running (tests). */
  readonly idle: () => Promise<void>;
}

export function startAutomationHooksSync(deps: AutomationHooksSyncDeps): AutomationHooksSync {
  let stopped = false;
  let unsupported = false;
  let running: Promise<void> | null = null;
  // A trigger that arrived during a sync: its change may postdate the list sent.
  let dirty = false;
  // Counts connects, so a sync from an earlier connection cannot mark the Hub unsupported.
  let connection = 0;
  let failures = 0;
  // Outcomes of handed-out requests the Hub has not received yet.
  let pendingAcks: ReadonlyArray<NodeAutomationHookAck> = [];
  let timer: unknown;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    if (timer !== undefined) deps.clearTimeout(timer);
    timer = deps.setTimeout(
      () => {
        timer = undefined;
        start();
      },
      Math.max(0, delayMs),
    );
  };
  const cancelTimer = () => {
    if (timer !== undefined) deps.clearTimeout(timer);
    timer = undefined;
  };

  type RunEnd = "idle" | "periodic" | "retry" | "unsupported" | "continue";

  const run = async (startedOn: number): Promise<RunEnd> => {
    let hookIds = await deps.listHookIds();
    const registered = await deps.hubRegistered();
    // Nothing for the Hub to hold or forget, and no outcome to send: no request at all.
    if (hookIds.length === 0 && registered.length === 0 && pendingAcks.length === 0) return "idle";
    for (let round = 0; round < AUTOMATION_HOOKS_SYNC_MAX_ROUNDS; round += 1) {
      if (stopped || !deps.isOnline()) return "retry";
      const acks = pendingAcks;
      const outcome = await deps.sync({ hookIds, acks });
      if (outcome.kind === "unsupported") {
        if (startedOn === connection) unsupported = true;
        return "unsupported";
      }
      if (outcome.kind === "failed") return "retry";
      failures = 0;
      // The Hub took these outcomes and this list.
      pendingAcks = pendingAcks.slice(acks.length);
      await deps.setHubRegistered(hookIds);
      deps.onState?.("synced");
      const next: Array<NodeAutomationHookAck> = [];
      for (const delivery of outcome.result.deliveries) {
        if (stopped) break;
        const handled = await deps.deliver(delivery);
        if (handled !== "retry") next.push({ deliveryId: delivery.deliveryId, outcome: handled });
      }
      pendingAcks = [...pendingAcks, ...next];
      if (!outcome.result.more && pendingAcks.length === 0) {
        return hookIds.length > 0 ? "periodic" : "idle";
      }
      hookIds = await deps.listHookIds();
    }
    return "continue";
  };

  const start = () => {
    if (stopped || unsupported || !deps.isOnline()) return;
    if (running !== null) {
      dirty = true;
      return;
    }
    dirty = false;
    cancelTimer();
    running = run(connection)
      .catch((error: unknown) => {
        deps.onError?.(error);
        return "retry" as const;
      })
      .then((end) => {
        running = null;
        if (stopped) return;
        if (end === "unsupported") {
          deps.onState?.("unsupported");
          return;
        }
        if (dirty) {
          schedule(0);
          return;
        }
        switch (end) {
          case "continue":
            schedule(1_000);
            return;
          case "retry":
            failures += 1;
            schedule(
              Math.min(
                AUTOMATION_HOOKS_SYNC_PERIOD_MS,
                AUTOMATION_HOOKS_SYNC_RETRY_MS * 2 ** Math.min(failures - 1, 4),
              ),
            );
            return;
          case "periodic":
            schedule(AUTOMATION_HOOKS_SYNC_PERIOD_MS * (0.9 + 0.2 * deps.random()));
            return;
          case "idle":
            return;
        }
      });
  };

  return {
    request: (trigger) => {
      if (stopped) return;
      if (trigger === "online") {
        // A new connection may reach a Hub that gained hooks.
        connection += 1;
        unsupported = false;
        failures = 0;
        schedule(deps.random() * AUTOMATION_HOOKS_SYNC_CONNECT_JITTER_MS);
        return;
      }
      // Only a Hub with hooks nudges; a change waits out an unsupported Hub.
      if (trigger === "nudge") unsupported = false;
      else if (unsupported) return;
      if (running !== null) {
        dirty = true;
        return;
      }
      schedule(0);
    },
    stop: () => {
      stopped = true;
      cancelTimer();
    },
    idle: async () => {
      while (running !== null) await running;
    },
  };
}
