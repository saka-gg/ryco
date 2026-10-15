import { describe, expect, it, vi } from "vite-plus/test";

import { SharedRequests } from "./sharedRequests.ts";
import { SupersedingLoads } from "./supersedingLoads.ts";

/** Loads whose answers the test releases, through shared flights like the usage cache. */
function controllableLoads() {
  const requests = new SharedRequests<string>();
  const settle = new Map<string, (value: string) => void>();
  const signals = new Map<string, AbortSignal>();
  const start = vi.fn(
    (key: string, signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        signals.set(key, signal);
        settle.set(key, resolve);
        signal.addEventListener("abort", () => resolve(`${key}:aborted`), { once: true });
      }),
  );
  const load = (key: string, signal: AbortSignal) =>
    requests.request(key, (flight) => start(key, flight), { signal });
  return { load, start, settle, signals };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("superseding loads", () => {
  it("delivers each target's answer as it settles, so a slow target hides nothing", async () => {
    const loads = new SupersedingLoads();
    const requests = controllableLoads();
    const answers: string[] = [];
    loads.run(["fast", "slow"], requests.load, (_target, result) => answers.push(result));
    requests.settle.get("fast")?.("fast:answer");
    await flush();
    expect(answers).toEqual(["fast:answer"]);
    requests.settle.get("slow")?.("slow:answer");
    await flush();
    expect(answers).toEqual(["fast:answer", "slow:answer"]);
  });

  it("withdraws superseded requests only, after joining the ones the new run wants", async () => {
    const loads = new SupersedingLoads();
    const requests = controllableLoads();
    const answers: string[] = [];
    const onAnswer = (_target: string, result: string) => answers.push(result);
    loads.run(["node-a:7d", "node-b:7d"], requests.load, onAnswer);
    // A range switch on node A; node B's request stays wanted and is joined.
    loads.run(["node-a:30d", "node-b:7d"], requests.load, onAnswer);
    expect(requests.signals.get("node-a:7d")?.aborted).toBe(true);
    expect(requests.signals.get("node-b:7d")?.aborted).toBe(false);
    expect(requests.start).toHaveBeenCalledTimes(3);
    requests.settle.get("node-b:7d")?.("node-b:answer");
    requests.settle.get("node-a:30d")?.("node-a:30d:answer");
    await flush();
    // The superseded run's answers are dropped, even for the joined request.
    expect(answers.toSorted()).toEqual(["node-a:30d:answer", "node-b:answer"]);
  });

  it("keeps the last run's requests alive when nothing supersedes them", async () => {
    const loads = new SupersedingLoads();
    const requests = controllableLoads();
    loads.run(["node-a:7d"], requests.load, () => {});
    await flush();
    // A view that goes away releases nothing: its request still fills the cache.
    expect(requests.signals.get("node-a:7d")?.aborted).toBe(false);
  });
});
