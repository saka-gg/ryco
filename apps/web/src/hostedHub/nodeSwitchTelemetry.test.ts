import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readNodeSwitchTimeline,
  readNodeSwitchTimelines,
  resetNodeSwitchInstrumentationForTests,
  type NodeSwitchPhase,
} from "../perf/nodeSwitchInstrumentation";

const fakes = vi.hoisted(() => {
  type Listener = () => void;
  interface FakeState {
    selectedNode: { id: string; environmentId: string } | null;
    nodes: Array<{ id: string; environmentId: string }>;
    transportStatus: string;
    sessionStatus: string;
    sessionEstablished: boolean;
    browserStatus: string;
  }
  const initialState = (): FakeState => ({
    selectedNode: null,
    nodes: [],
    transportStatus: "idle",
    sessionStatus: "closed",
    sessionEstablished: false,
    browserStatus: "current",
  });
  let state = initialState();
  let routedNodeId: string | null = null;
  const storeListeners = new Set<Listener>();
  const routeListeners = new Set<Listener>();
  return {
    sessionVersion2: { value: false },
    store: {
      getState: () => state,
      subscribe: (listener: Listener) => {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
    },
    patch(next: Partial<FakeState>) {
      state = { ...state, ...next };
      for (const listener of storeListeners) listener();
    },
    route(nodeId: string | null) {
      routedNodeId = nodeId;
      for (const listener of routeListeners) listener();
    },
    getRoutedHostedNode: () => ({ nodeId: routedNodeId, malformed: false, logicalPathname: "/" }),
    subscribeRoutedHostedNode: (listener: Listener) => {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
    listenerCounts: () => ({ store: storeListeners.size, route: routeListeners.size }),
    reset() {
      state = initialState();
      routedNodeId = null;
      storeListeners.clear();
      routeListeners.clear();
      this.sessionVersion2.value = false;
    },
  };
});

vi.mock("./state", () => ({ hostedHubStore: fakes.store }));
vi.mock("./nodeRoutes", () => ({
  getRoutedHostedNode: fakes.getRoutedHostedNode,
  subscribeRoutedHostedNode: fakes.subscribeRoutedHostedNode,
}));
vi.mock("./hubSession", () => ({
  isWebHubServerAuthenticatedRelayAvailable: () => fakes.sessionVersion2.value,
}));

import { installNodeSwitchTelemetry } from "./nodeSwitchTelemetry";

const nodeA = { id: "node_a", environmentId: "env_a" };
const nodeB = { id: "node_b", environmentId: "env_b" };

const READY_STATE = {
  transportStatus: "online",
  sessionStatus: "ready",
  sessionEstablished: true,
  browserStatus: "current",
} as const;

function phasesInOrder(): NodeSwitchPhase[] {
  const phases = readNodeSwitchTimeline()?.phases ?? {};
  return (Object.entries(phases) as Array<[NodeSwitchPhase, number]>)
    .toSorted((left, right) => left[1] - right[1])
    .map(([phase]) => phase);
}

describe("node switch telemetry", () => {
  let clock = 0;
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    fakes.reset();
    resetNodeSwitchInstrumentationForTests();
    performance.clearMarks();
    performance.clearMeasures();
    clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 10));
    fakes.patch({ nodes: [nodeA, nodeB] });
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    vi.restoreAllMocks();
  });

  it("records the phases of a cold switch in order", () => {
    fakes.patch({ selectedNode: nodeA, ...READY_STATE });
    dispose = installNodeSwitchTelemetry();

    fakes.route("node_b");
    fakes.patch({
      selectedNode: nodeB,
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
    });
    for (const transportStatus of [
      "requesting-ticket",
      "connecting",
      "authenticating",
      "opening-channel",
      "online",
    ]) {
      fakes.patch({ transportStatus });
    }
    fakes.patch({ sessionEstablished: true });
    fakes.patch({ sessionStatus: "ready" });

    expect(phasesInOrder()).toEqual([
      "intent",
      "route",
      "requesting-ticket",
      "connecting",
      "authenticating",
      "opening-channel",
      "online",
      "shell-accepted",
      "mutation-ready",
    ]);
    expect(readNodeSwitchTimeline()).toMatchObject({ n: 1, origin: "route", warm: false });
    expect(
      performance
        .getEntriesByType("measure")
        .some((entry) => entry.name.startsWith("ryco:node-switch:mutation-ready:")),
    ).toBe(true);
  });

  it("does not mark mutation readiness before the session is ready and current", () => {
    dispose = installNodeSwitchTelemetry();
    fakes.route("node_b");
    fakes.patch({
      selectedNode: nodeB,
      transportStatus: "online",
      sessionStatus: "synchronizing",
      sessionEstablished: true,
      browserStatus: "synchronizing",
    });
    expect(phasesInOrder()).not.toContain("mutation-ready");

    fakes.patch({ sessionStatus: "ready" });
    expect(phasesInOrder()).not.toContain("mutation-ready");

    fakes.patch({ browserStatus: "current" });
    expect(phasesInOrder()).toContain("mutation-ready");
  });

  it("records only intent, route and mutation-ready when the selection lands ready", () => {
    fakes.patch({ selectedNode: nodeA, ...READY_STATE });
    dispose = installNodeSwitchTelemetry();

    fakes.route("node_b");
    fakes.patch({ selectedNode: nodeB, ...READY_STATE });

    expect(phasesInOrder()).toEqual(["intent", "route", "mutation-ready"]);
  });

  it("marks a route to the already selected, ready node without a store patch", () => {
    fakes.patch({ selectedNode: nodeA, ...READY_STATE });
    dispose = installNodeSwitchTelemetry();

    fakes.route("node_a");

    expect(phasesInOrder()).toEqual(["intent", "route", "mutation-ready"]);
    expect(readNodeSwitchTimeline()?.warm).toBe(true);
  });

  it("does not add a later reconnect to a completed warm switch", () => {
    fakes.patch({ selectedNode: nodeA, ...READY_STATE });
    dispose = installNodeSwitchTelemetry();
    fakes.route("node_a");
    expect(phasesInOrder()).toEqual(["intent", "route", "mutation-ready"]);

    fakes.patch({ transportStatus: "reconnecting", sessionStatus: "synchronizing" });
    fakes.patch({ sessionEstablished: false });
    for (const transportStatus of [
      "requesting-ticket",
      "connecting",
      "authenticating",
      "opening-channel",
      "online",
    ]) {
      fakes.patch({ transportStatus });
    }
    fakes.patch({ sessionEstablished: true });
    fakes.patch({ sessionStatus: "ready" });

    expect(phasesInOrder()).toEqual(["intent", "route", "mutation-ready"]);
    expect(
      performance
        .getEntriesByType("measure")
        .map((entry) => entry.name)
        .filter((name) => name.startsWith("ryco:node-switch:")),
    ).toEqual(["ryco:node-switch:route:1", "ryco:node-switch:mutation-ready:1"]);
  });

  it("starts the switch when the directory lists a node that was routed before it loaded", () => {
    fakes.patch({ nodes: [] });
    dispose = installNodeSwitchTelemetry();

    fakes.route("node_a");
    expect(readNodeSwitchTimeline()).toBeNull();

    fakes.patch({ nodes: [nodeA, nodeB] });
    expect(phasesInOrder()).toEqual(["intent", "route"]);
    expect(readNodeSwitchTimeline()).toMatchObject({ n: 1, origin: "route" });

    fakes.patch({ selectedNode: nodeA, transportStatus: "connecting" });
    expect(phasesInOrder()).toEqual(["intent", "route", "connecting"]);

    // The listing happens once: later directory patches start nothing else.
    fakes.patch({ nodes: [nodeA, nodeB] });
    expect(readNodeSwitchTimelines()).toHaveLength(1);
  });

  it("marks a pending node that lands ready with the directory as warm", () => {
    fakes.patch({ nodes: [], selectedNode: nodeA, ...READY_STATE });
    dispose = installNodeSwitchTelemetry();

    fakes.route("node_a");
    fakes.patch({ nodes: [nodeA] });

    expect(phasesInOrder()).toEqual(["intent", "route", "mutation-ready"]);
    expect(readNodeSwitchTimeline()?.warm).toBe(true);
  });

  it("drops a pending node once the route moves on", () => {
    fakes.patch({ nodes: [] });
    dispose = installNodeSwitchTelemetry();

    fakes.route("node_a");
    fakes.route("node_b");
    fakes.patch({ nodes: [nodeA, nodeB] });
    expect(readNodeSwitchTimelines()).toHaveLength(1);
    fakes.patch({ selectedNode: nodeB, transportStatus: "connecting" });
    expect(phasesInOrder()).toEqual(["intent", "route", "connecting"]);

    fakes.patch({ nodes: [] });
    fakes.route("node_a");
    fakes.route(null);
    fakes.patch({ nodes: [nodeA, nodeB] });
    expect(readNodeSwitchTimelines()).toHaveLength(1);
  });

  it("annotates the switch with the Hub session version", () => {
    dispose = installNodeSwitchTelemetry();
    fakes.sessionVersion2.value = true;
    fakes.route("node_a");
    expect(readNodeSwitchTimeline()?.hubSessionVersion).toBe(2);

    fakes.sessionVersion2.value = false;
    fakes.route("node_b");
    expect(readNodeSwitchTimeline()).toMatchObject({ n: 2, hubSessionVersion: 1, warm: false });
  });

  it("starts a switch only when the routed node changes to a known node", () => {
    dispose = installNodeSwitchTelemetry();

    fakes.route("node_unknown");
    fakes.route(null);
    expect(readNodeSwitchTimeline()).toBeNull();

    fakes.route("node_a");
    fakes.route("node_a");
    expect(readNodeSwitchTimeline()?.n).toBe(1);

    fakes.route(null);
    expect(readNodeSwitchTimeline()?.n).toBe(1);
  });

  it("starts no switch for a thread on the same node opened after a page that names no node", () => {
    dispose = installNodeSwitchTelemetry();
    fakes.route("node_a");
    expect(readNodeSwitchTimeline()?.n).toBe(1);

    // Home and settings name no node, and the cursor stays where it was.
    fakes.route(null);
    fakes.route("node_a");
    expect(readNodeSwitchTimeline()?.n).toBe(1);

    fakes.route(null);
    fakes.route("node_b");
    expect(readNodeSwitchTimeline()?.n).toBe(2);
  });

  it("records a cursor moved on a page that names no node, and a thread on the node it left", () => {
    dispose = installNodeSwitchTelemetry();
    fakes.route("node_a");
    fakes.patch({ selectedNode: nodeA, ...READY_STATE });
    expect(readNodeSwitchTimeline()).toMatchObject({ n: 1, origin: "route" });

    // Settings' device switcher moves the cursor to B; the address names no node.
    fakes.route(null);
    fakes.patch({
      selectedNode: nodeB,
      transportStatus: "connecting",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
    });
    expect(readNodeSwitchTimeline()).toMatchObject({ n: 2, origin: "press", warm: false });
    expect(phasesInOrder()).toEqual(["intent", "connecting"]);
    fakes.patch(READY_STATE);
    expect(phasesInOrder()).toEqual([
      "intent",
      "connecting",
      "online",
      "shell-accepted",
      "mutation-ready",
    ]);

    // A thread on A moves the cursor back from B.
    fakes.route("node_a");
    expect(readNodeSwitchTimeline()).toMatchObject({ n: 3, origin: "route" });

    // The same node chosen again, or the cursor cleared, starts nothing.
    fakes.route(null);
    fakes.patch({ selectedNode: { ...nodeA } });
    fakes.patch({ selectedNode: null });
    expect(readNodeSwitchTimeline()?.n).toBe(3);
    // Cleared, the cursor is on no node: a thread on A, later, is a switch again.
    clock += 2_000;
    fakes.route("node_a");
    expect(readNodeSwitchTimeline()?.n).toBe(4);
  });

  it("does not treat the node routed at install time as a switch", () => {
    fakes.route("node_a");
    dispose = installNodeSwitchTelemetry();

    fakes.route("node_a");
    expect(readNodeSwitchTimeline()).toBeNull();

    fakes.route("node_b");
    expect(readNodeSwitchTimeline()?.n).toBe(1);
  });

  it("ignores store changes of an environment other than the switch target", () => {
    dispose = installNodeSwitchTelemetry();
    fakes.route("node_b");

    fakes.patch({ selectedNode: nodeA, transportStatus: "connecting" });
    fakes.patch({ transportStatus: "online" });
    fakes.patch({ sessionStatus: "ready", sessionEstablished: true });

    expect(phasesInOrder()).toEqual(["intent", "route"]);
  });

  it("subscribes once however often it is installed and stops on dispose", () => {
    dispose = installNodeSwitchTelemetry();
    const again = installNodeSwitchTelemetry();
    expect(again).toBe(dispose);
    expect(fakes.listenerCounts()).toEqual({ store: 1, route: 1 });

    dispose();
    expect(fakes.listenerCounts()).toEqual({ store: 0, route: 0 });
    fakes.route("node_a");
    expect(readNodeSwitchTimeline()).toBeNull();

    dispose = installNodeSwitchTelemetry();
    expect(dispose).not.toBe(again);
    expect(fakes.listenerCounts()).toEqual({ store: 1, route: 1 });
  });
});
