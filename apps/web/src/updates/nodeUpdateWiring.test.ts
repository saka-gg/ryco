import type { NodeUpdateClient } from "@ryco/client-runtime/state/nodeUpdate";
import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { createNodeUpdateWiring, type NodeUpdateWiringConnection } from "./nodeUpdateWiring";

const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");

const client = (name: string) => ({ name }) as unknown as NodeUpdateClient;

function harness() {
  const events: string[] = [];
  const attached = new Map<EnvironmentId, NodeUpdateClient>();
  const store = {
    attach: (environmentId: EnvironmentId, attachedClient: NodeUpdateClient) => {
      const name = (attachedClient as unknown as { name: string }).name;
      events.push(`attach ${environmentId} ${name}`);
      attached.set(environmentId, attachedClient);
      return () => {
        events.push(`detach ${environmentId} ${name}`);
        if (attached.get(environmentId) === attachedClient) attached.delete(environmentId);
      };
    },
  };
  let connections: NodeUpdateWiringConnection[] = [];
  const supported = new Set<EnvironmentId>();
  const listeners = new Set<() => void>();
  const wiring = createNodeUpdateWiring(store, {
    listConnections: () => connections,
    canFollow: (environmentId) => supported.has(environmentId),
    subscriptions: [
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    ],
  });
  return {
    events,
    attached,
    wiring,
    listeners,
    supported,
    setConnections: (next: NodeUpdateWiringConnection[]) => {
      connections = next;
      for (const listener of Array.from(listeners)) listener();
    },
    notify: () => {
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

describe("createNodeUpdateWiring", () => {
  it("attaches every connection whose node can update itself, once per environment", () => {
    const h = harness();
    h.supported.add(A);
    const clientA = client("a1");
    h.setConnections([
      { environmentId: A, client: clientA },
      { environmentId: A, client: client("a-duplicate") },
      { environmentId: B, client: client("b1") },
    ]);
    const stop = h.wiring.start();
    expect(h.events).toEqual(["attach env-a a1"]);
    expect(h.wiring.attachedEnvironmentIds()).toEqual([A]);
    stop();
  });

  it("follows the capability and the connection list as they change", () => {
    const h = harness();
    const stop = h.wiring.start();
    h.setConnections([{ environmentId: B, client: client("b1") }]);
    expect(h.events).toEqual([]);

    h.supported.add(B);
    h.notify();
    expect(h.events).toEqual(["attach env-b b1"]);

    h.supported.delete(B);
    h.notify();
    expect(h.events).toEqual(["attach env-b b1", "detach env-b b1"]);

    h.supported.add(B);
    h.notify();
    h.setConnections([]);
    expect(h.events.slice(2)).toEqual(["attach env-b b1", "detach env-b b1"]);
    expect(h.attached.size).toBe(0);
    stop();
  });

  it("hands a replaced connection's stream to its new client before letting go of the old", () => {
    const h = harness();
    h.supported.add(A);
    h.setConnections([{ environmentId: A, client: client("a1") }]);
    const stop = h.wiring.start();
    h.setConnections([{ environmentId: A, client: client("a2") }]);
    expect(h.events).toEqual(["attach env-a a1", "attach env-a a2", "detach env-a a1"]);
    stop();
    expect(h.events.at(-1)).toBe("detach env-a a2");
  });

  it("is idempotent: only the last stop detaches and unsubscribes", () => {
    const h = harness();
    h.supported.add(A);
    h.setConnections([{ environmentId: A, client: client("a1") }]);
    const first = h.wiring.start();
    const second = h.wiring.start();
    expect(h.events).toEqual(["attach env-a a1"]);
    expect(h.listeners.size).toBe(1);

    first();
    first();
    expect(h.events).toEqual(["attach env-a a1"]);
    second();
    expect(h.events).toEqual(["attach env-a a1", "detach env-a a1"]);
    expect(h.listeners.size).toBe(0);

    // Stopped: changes are ignored until started again.
    h.setConnections([{ environmentId: A, client: client("a2") }]);
    expect(h.events).toHaveLength(2);
  });
});
