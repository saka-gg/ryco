import { TurnId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { assertTurnIdsOnly, makeRetentionProbe } from "./adapterRetention.ts";

// Plain helper so no test frame keeps the tracked object alive (rule 1 of the probe).
function holdTracked(probe: ReturnType<typeof makeRetentionProbe>, holder: Array<object>): void {
  holder.push(probe.track({ body: probe.payload(1_000) }));
}

describe("adapterRetention probe", () => {
  it("counts an object while it is held and stops counting it once released", async () => {
    const probe = makeRetentionProbe();
    const holder: Array<object> = [];
    holdTracked(probe, holder);

    expect(probe.tracked).toBe(1);
    expect(await probe.reachable()).toBe(1);

    holder.length = 0;
    expect(await probe.reachable()).toBe(0);
  });

  it("makes unique payloads of the requested length", () => {
    const probe = makeRetentionProbe();
    const first = probe.payload(20_000);
    const second = probe.payload(20_000);

    expect(first).toHaveLength(20_000);
    expect(probe.payload(7)).toHaveLength(7);
    expect(first).not.toBe(second);
  });

  it("accepts only snapshots with the expected ids and empty items", () => {
    const threadId = ThreadId.make("retention-self-test");
    const turnId = TurnId.make("turn-1");

    assertTurnIdsOnly({ threadId, turns: [{ id: turnId, items: [] }] }, [turnId]);
    expect(() =>
      assertTurnIdsOnly({ threadId, turns: [{ id: turnId, items: [{ body: "kept" }] }] }, [turnId]),
    ).toThrow();
    expect(() => assertTurnIdsOnly({ threadId, turns: [] }, [turnId])).toThrow();
  });
});
