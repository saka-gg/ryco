import { assert, describe, it } from "vite-plus/test";

import type { CrownEvent } from "./crownAlerts.logic";
import {
  EMPTY_CROWN_ALERT_QUEUE,
  advanceCrownAlert,
  clearCrownAlerts,
  crownAlertDwellMs,
  enqueueCrownAlerts,
  type CrownAlertQueueState,
} from "./crownAlertQueue.logic";
import {
  CROWN_ALERT_DWELL_MS,
  CROWN_ALERT_DWELL_QUEUED_MS,
  CROWN_ALERT_QUEUE_MAX,
  CROWN_ALERT_RECENT_MAX,
} from "./crownLayout";

function event(name: string, overrides: Partial<CrownEvent> = {}): CrownEvent {
  return {
    id: `${name}@1`,
    section: "checks",
    railKey: "checks",
    tone: "danger",
    kind: "checks",
    title: name,
    icon: "x",
    loud: true,
    dedupeKey: name,
    ...overrides,
  };
}

const OPEN = { cardOpen: false };
const titles = (state: CrownAlertQueueState) => ({
  current: state.current?.title ?? null,
  queue: state.queue.map((entry) => entry.title),
});

describe("enqueueCrownAlerts", () => {
  it("shows the first alert at once and queues the rest", () => {
    const state = enqueueCrownAlerts(EMPTY_CROWN_ALERT_QUEUE, [event("a"), event("b")], OPEN);
    assert.deepEqual(titles(state), { current: "a", queue: ["b"] });
  });

  it("queues behind a showing alert", () => {
    const showing = enqueueCrownAlerts(EMPTY_CROWN_ALERT_QUEUE, [event("a")], OPEN);
    const state = enqueueCrownAlerts(showing, [event("b")], OPEN);
    assert.deepEqual(titles(state), { current: "a", queue: ["b"] });
  });

  it("caps the queue and drops the oldest waiting alert", () => {
    const names = ["a", "b", "c", "d", "e"];
    const state = enqueueCrownAlerts(
      EMPTY_CROWN_ALERT_QUEUE,
      names.map((name) => event(name)),
      OPEN,
    );
    assert.equal(state.queue.length, CROWN_ALERT_QUEUE_MAX);
    assert.deepEqual(titles(state), { current: "a", queue: ["c", "d", "e"] });
  });

  it("skips quiet events", () => {
    const state = enqueueCrownAlerts(
      EMPTY_CROWN_ALERT_QUEUE,
      [event("quiet", { loud: false })],
      OPEN,
    );
    assert.equal(state, EMPTY_CROWN_ALERT_QUEUE);
  });

  it("drops everything while the card is open", () => {
    const state = enqueueCrownAlerts(EMPTY_CROWN_ALERT_QUEUE, [event("a")], { cardOpen: true });
    assert.equal(state, EMPTY_CROWN_ALERT_QUEUE);
  });

  it("dedupes repeats of a recent transition, even after it was shown", () => {
    let state = enqueueCrownAlerts(EMPTY_CROWN_ALERT_QUEUE, [event("a"), event("a")], OPEN);
    assert.deepEqual(titles(state), { current: "a", queue: [] });
    state = advanceCrownAlert(state);
    state = enqueueCrownAlerts(state, [event("a")], OPEN);
    assert.equal(state.current, null);
  });

  it("remembers only the last 50 keys", () => {
    const many = Array.from({ length: CROWN_ALERT_RECENT_MAX + 1 }, (_, i) => event(`e${i}`));
    let state = enqueueCrownAlerts(EMPTY_CROWN_ALERT_QUEUE, many, OPEN);
    assert.equal(state.recent.length, CROWN_ALERT_RECENT_MAX);
    assert.equal(state.recent.includes("e0"), false);
    state = clearCrownAlerts(state);
    state = enqueueCrownAlerts(state, [event("e0"), event("e50")], OPEN);
    assert.deepEqual(titles(state), { current: "e0", queue: [] });
  });
});

describe("advanceCrownAlert", () => {
  it("moves through the queue and then empties", () => {
    let state = enqueueCrownAlerts(EMPTY_CROWN_ALERT_QUEUE, [event("a"), event("b")], OPEN);
    state = advanceCrownAlert(state);
    assert.deepEqual(titles(state), { current: "b", queue: [] });
    state = advanceCrownAlert(state);
    assert.deepEqual(titles(state), { current: null, queue: [] });
    assert.equal(advanceCrownAlert(state), state);
  });
});

describe("clearCrownAlerts", () => {
  it("drops the shown and waiting alerts but keeps dedupe memory", () => {
    const state = clearCrownAlerts(
      enqueueCrownAlerts(EMPTY_CROWN_ALERT_QUEUE, [event("a"), event("b")], OPEN),
    );
    assert.deepEqual(titles(state), { current: null, queue: [] });
    assert.deepEqual(state.recent, ["a", "b"]);
    assert.equal(clearCrownAlerts(state), state);
  });
});

describe("crownAlertDwellMs", () => {
  it("shortens the dwell while more alerts wait", () => {
    const one = enqueueCrownAlerts(EMPTY_CROWN_ALERT_QUEUE, [event("a")], OPEN);
    assert.equal(crownAlertDwellMs(one), CROWN_ALERT_DWELL_MS);
    const two = enqueueCrownAlerts(one, [event("b")], OPEN);
    assert.equal(crownAlertDwellMs(two), CROWN_ALERT_DWELL_QUEUED_MS);
  });
});
