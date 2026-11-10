import type {
  NodeAutomationHookAck,
  NodeAutomationHookDelivery,
} from "@ryco/contracts/automation-hooks";
import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATION_HOOKS_SYNC_PERIOD_MS,
  AUTOMATION_HOOKS_SYNC_RETRY_MS,
  startAutomationHooksSync,
  type AutomationHookDeliveryOutcome,
  type AutomationHooksSyncOutcome,
} from "./automationHooksSync.ts";
import {
  automationHookDeliveryOutcome,
  automationHookRequestOfDelivery,
} from "./automationHooksSyncHttp.ts";

const hook = (fill: string) => fill.repeat(22);
const delivery = (id: string, hookId = hook("a")): NodeAutomationHookDelivery => ({
  deliveryId: id,
  hookId,
  receivedAt: "2026-11-09T12:00:00.000Z",
  headers: { "content-type": "application/json" },
  bodyBase64: Buffer.from("{}").toString("base64"),
});

interface SyncCall {
  readonly hookIds: ReadonlyArray<string>;
  readonly acks: ReadonlyArray<NodeAutomationHookAck>;
}

/** A fake Hub and a timer queue the test advances by hand. */
function harness(input: {
  hookIds: ReadonlyArray<string>;
  registered?: ReadonlyArray<string>;
  answer: (call: SyncCall) => AutomationHooksSyncOutcome | Promise<AutomationHooksSyncOutcome>;
  deliver?: (delivery: NodeAutomationHookDelivery) => AutomationHookDeliveryOutcome;
}) {
  let now = 0;
  let online = true;
  let registered = input.registered ?? [];
  const timers: Array<{ at: number; callback: () => void; id: number }> = [];
  let nextId = 1;
  const calls: Array<SyncCall> = [];
  const delivered: Array<string> = [];
  const states: Array<string> = [];
  const state = { hookIds: input.hookIds };
  const sync = startAutomationHooksSync({
    listHookIds: async () => state.hookIds,
    hubRegistered: async () => registered,
    setHubRegistered: async (ids) => {
      registered = ids;
    },
    sync: async (call) => {
      calls.push({ hookIds: [...call.hookIds], acks: [...call.acks] });
      return input.answer(call);
    },
    deliver: async (item) => {
      delivered.push(item.deliveryId);
      return input.deliver?.(item) ?? "accepted";
    },
    onState: (value) => states.push(value),
    isOnline: () => online,
    random: () => 0.5,
    setTimeout: (callback, delayMs) => {
      const id = nextId++;
      timers.push({ at: now + delayMs, callback, id });
      return id;
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      timers.sort((left, right) => left.at - right.at);
      const next = timers[0];
      if (next === undefined || next.at > until) break;
      timers.shift();
      now = next.at;
      next.callback();
      await sync.idle();
    }
    now = until;
    await sync.idle();
  };
  /** Fires the timers due now without waiting for the sync they start. */
  const fire = async () => {
    for (const timer of timers.splice(0).filter((item) => item.at <= now)) timer.callback();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  };
  return {
    sync,
    fire,
    calls,
    delivered,
    states,
    state,
    advance,
    registered: () => registered,
    pendingTimers: () => timers.length,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

const answered = (
  deliveries: ReadonlyArray<NodeAutomationHookDelivery> = [],
  more = false,
): AutomationHooksSyncOutcome => ({
  kind: "answered",
  result: { protocolVersion: 1, deliveries, more },
});

describe("automation hooks sync", () => {
  it("syncs after a connect and then every 10 minutes while it has hooks", async () => {
    const h = harness({ hookIds: [hook("a")], answer: () => answered() });
    h.sync.request("online");
    await h.advance(5_000);
    expect(h.calls).toEqual([{ hookIds: [hook("a")], acks: [] }]);
    expect(h.registered()).toEqual([hook("a")]);
    expect(h.states).toEqual(["synced"]);
    await h.advance(AUTOMATION_HOOKS_SYNC_PERIOD_MS * 1.1);
    expect(h.calls).toHaveLength(2);
  });

  it("asks nothing of the Hub while the node has no hooks and the Hub holds none", async () => {
    const h = harness({ hookIds: [], answer: () => answered() });
    h.sync.request("online");
    h.sync.request("changed");
    await h.advance(AUTOMATION_HOOKS_SYNC_PERIOD_MS * 3);
    expect(h.calls).toEqual([]);
    expect(h.pendingTimers()).toBe(0);
  });

  it("sends an empty list once after the last hook goes", async () => {
    const h = harness({ hookIds: [hook("a")], answer: () => answered() });
    h.sync.request("online");
    await h.advance(5_000);
    h.state.hookIds = [];
    h.sync.request("changed");
    await h.advance(0);
    expect(h.calls.at(-1)).toEqual({ hookIds: [], acks: [] });
    // Then quiet: no periodic sync, and a later change with nothing to say sends nothing.
    h.sync.request("changed");
    await h.advance(AUTOMATION_HOOKS_SYNC_PERIOD_MS * 3);
    expect(h.calls).toHaveLength(2);
  });

  it("tells the Hub once on connect when its last hook went while offline", async () => {
    const h = harness({ hookIds: [], registered: [hook("a")], answer: () => answered() });
    h.sync.request("online");
    await h.advance(5_000);
    expect(h.calls).toEqual([{ hookIds: [], acks: [] }]);
    expect(h.registered()).toEqual([]);
  });

  it("hands requests over, acknowledges them in the next sync, and loops while more wait", async () => {
    const answers: Array<AutomationHooksSyncOutcome> = [
      answered([delivery("d1"), delivery("d2")], true),
      answered([delivery("d3")], false),
      answered(),
    ];
    const h = harness({
      hookIds: [hook("a")],
      answer: () => answers.shift() ?? answered(),
      deliver: (item) => (item.deliveryId === "d2" ? "rejected" : "accepted"),
    });
    h.sync.request("nudge");
    await h.advance(0);
    expect(h.delivered).toEqual(["d1", "d2", "d3"]);
    expect(h.calls.map((call) => call.acks)).toEqual([
      [],
      [
        { deliveryId: "d1", outcome: "accepted" },
        { deliveryId: "d2", outcome: "rejected" },
      ],
      [{ deliveryId: "d3", outcome: "accepted" }],
    ]);
  });

  it("leaves a request it could not take unacknowledged, so the Hub hands it out again", async () => {
    const h = harness({
      hookIds: [hook("a")],
      answer: (call) => (call.acks.length === 0 ? answered([delivery("d1")]) : answered()),
      deliver: () => "retry",
    });
    h.sync.request("nudge");
    await h.advance(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.acks).toEqual([]);
  });

  it("runs one sync at a time and once more after a trigger that arrived during it", async () => {
    let release: () => void = () => undefined;
    let first = true;
    const h = harness({
      hookIds: [hook("a")],
      answer: () => {
        if (!first) return answered();
        first = false;
        return new Promise((resolve) => {
          release = () => resolve(answered());
        });
      },
    });
    h.sync.request("nudge");
    await h.fire();
    expect(h.calls).toHaveLength(1);
    h.sync.request("changed");
    h.sync.request("nudge");
    expect(h.calls).toHaveLength(1);
    release();
    await h.sync.idle();
    await h.advance(0);
    expect(h.calls).toHaveLength(2);
  });

  it("stops after a 404 until the next connect, or a nudge", async () => {
    let supported = false;
    const h = harness({
      hookIds: [hook("a")],
      answer: () => (supported ? answered() : { kind: "unsupported" }),
    });
    h.sync.request("online");
    await h.advance(5_000);
    expect(h.states).toEqual(["unsupported"]);
    h.sync.request("changed");
    await h.advance(AUTOMATION_HOOKS_SYNC_PERIOD_MS * 3);
    expect(h.calls).toHaveLength(1);
    supported = true;
    h.sync.request("online");
    await h.advance(5_000);
    expect(h.calls).toHaveLength(2);
    expect(h.states.at(-1)).toBe("synced");
  });

  it("tries a failed sync (a 429 included) again later, keeping its outcomes", async () => {
    let fail = true;
    const answers: Array<AutomationHooksSyncOutcome> = [answered([delivery("d1")])];
    const h = harness({
      hookIds: [hook("a")],
      answer: (call) => {
        if (call.acks.length > 0 && fail) return { kind: "failed" };
        return answers.shift() ?? answered();
      },
    });
    h.sync.request("nudge");
    await h.advance(0);
    expect(h.calls).toHaveLength(2);
    fail = false;
    await h.advance(AUTOMATION_HOOKS_SYNC_RETRY_MS);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.acks).toEqual([{ deliveryId: "d1", outcome: "accepted" }]);
  });

  it("does nothing while offline, and nothing at all once stopped", async () => {
    const h = harness({ hookIds: [hook("a")], answer: () => answered() });
    h.setOnline(false);
    h.sync.request("nudge");
    await h.advance(AUTOMATION_HOOKS_SYNC_PERIOD_MS);
    expect(h.calls).toHaveLength(0);
    h.setOnline(true);
    h.sync.stop();
    h.sync.request("online");
    await h.advance(AUTOMATION_HOOKS_SYNC_PERIOD_MS);
    expect(h.calls).toHaveLength(0);
  });
});

describe("Hub deliveries", () => {
  it("keeps only the forwarded headers and the raw body", () => {
    const request = automationHookRequestOfDelivery(
      {
        ...delivery("d1"),
        headers: {
          "X-GitHub-Event": "push",
          authorization: "Bearer leaked",
          cookie: "a=b",
          "x-hub-signature-256": "sha256=00",
        },
      },
      new Date("2026-11-10T00:00:00.000Z"),
    );
    expect(request.headers).toEqual({
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=00",
    });
    expect(Buffer.from(request.body).toString()).toBe("{}");
    expect(request.via).toBe("cloud");
    expect(request.receivedAt.toISOString()).toBe("2026-11-09T12:00:00.000Z");
  });

  it("acknowledges what the node decided for good, and nothing it may take later", () => {
    expect(automationHookDeliveryOutcome({ kind: "accepted", outcome: "duplicate" })).toBe(
      "accepted",
    );
    expect(automationHookDeliveryOutcome({ kind: "refused", error: "unauthorized" })).toBe(
      "rejected",
    );
    expect(automationHookDeliveryOutcome({ kind: "refused", error: "not_accepting" })).toBe(
      "rejected",
    );
    expect(
      automationHookDeliveryOutcome({
        kind: "refused",
        error: "rate_limited",
        retryAfterSeconds: 9,
      }),
    ).toBe("retry");
    expect(automationHookDeliveryOutcome({ kind: "failed" })).toBe("retry");
  });
});
