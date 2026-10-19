import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createHostedMultiNodeHarness,
  formatHostedNodeOpen,
  type HostedMultiNodeHarness,
  type HostedNodeOpenResult,
} from "./testUtils/hostedMultiNodeHarness.ts";

// What opening a hosted node costs, counted on the real browser and node relay
// stacks over a Hub that only forwards frames, with virtual per-hop delay (see
// the harness for what is real and what is modelled).
//
// A cold open is three relay round trips:
//   1. `openNode` out, relay `ready` and `channel.open` back to both ends, the
//      node's `channel.accept` and E2EE carrier back to the browser;
//   2. the NX hello out, the node's accept back;
//   3. the buffered first RPCs out, the first shell message back.
// Every further shell message costs one more, because the node sends the next
// page only after the browser acknowledges the last.
//
// The channels are end to end encrypted (NX), so the handshake round trip is
// part of every number here.
//
// These are channel-level counts. The harness drives a plain web transport that
// holds one selection and closes the active session itself on every switch; the
// web runtime's node selection and connection coordination are not loaded. What
// a switch costs here is therefore a property of the harness, not of the
// product's selection logic, and a change to that logic does not move it.

/** Relay round trips from `openNode` to the shell accepted, for a one-message shell. */
export const COLD_OPEN_RELAY_ROUND_TRIPS = 3;

const HOP_DELAY_MS = 10;
const TEST_TIMEOUT_MS = 30_000;

const harnesses: HostedMultiNodeHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
  vi.unstubAllGlobals();
});

async function createHarness(
  options: Parameters<typeof createHostedMultiNodeHarness>[0],
): Promise<HostedMultiNodeHarness> {
  const harness = await createHostedMultiNodeHarness(options);
  harnesses.push(harness);
  return harness;
}

/** Frames per direction and type; sizes vary with request ids, and so can the interleaving. */
function frameCounts(hub: HostedMultiNodeHarness): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const frame of hub.wire()) {
    const key = `${frame.direction} ${frame.type}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function report(result: HostedNodeOpenResult): void {
  console.info(`[hosted node open] ${formatHostedNodeOpen(result)}`);
}

describe("hosted multi-node open cost", () => {
  it(
    "cold open of node B costs 3 relay round trips before shell accepted",
    async () => {
      const hub = await createHarness({ nodes: 3, hopDelayMs: HOP_DELAY_MS });
      expect(new Set(hub.nodeIds).size).toBe(3);

      const opens = [await hub.openNode(0), await hub.switchTo(1), await hub.switchTo(2)];

      for (const open of opens) {
        report(open);
        expect(open.e2ee).toBe("nx");
        // Each node serves its own shell, and the whole shell fits one message.
        expect(open.shell).toEqual({
          projectIds: [`project-node-${open.nodeIndex}`],
          threadCount: 50,
        });
        expect(open.shellPages).toBe(1);
        expect(open.relayRoundTrips).toBe(COLD_OPEN_RELAY_ROUND_TRIPS + open.shellPages - 1);
        expect(open.shellAcceptedMs).toBe(open.relayRoundTrips! * 4 * HOP_DELAY_MS);
        // The Hub authenticated the channel itself: one stream open, no ticket.
        expect(open.traffic.openNodeFrames).toBe(1);
        expect(open.traffic.channelsOpened).toBe(1);
        expect(open.frames).toBeGreaterThan(0);
        expect(open.bytes).toBeGreaterThan(0);
        // The channel's milestones follow the handshake in order.
        expect(open.milestonesMs.relayReady).toBe(2 * HOP_DELAY_MS);
        expect(open.milestonesMs.channelAccept).toBe(4 * HOP_DELAY_MS);
        expect(open.milestonesMs.firstData).toBe(open.milestonesMs.channelAccept);
        expect(open.milestonesMs.firstThreadWindowItem).toBeGreaterThanOrEqual(
          open.milestonesMs.shellAccepted,
        );
      }
      const counters = hub.counters();
      expect(counters.ticketRequests).toBe(0);
      expect(counters.nodeErrors).toEqual([]);
      expect(counters.accountSocketsOpened).toBe(0);

      // Every relay frame on the Hub-to-node legs belongs to one of the three
      // channels, and each channel carried traffic in all four directions.
      expect(counters.channels).toHaveLength(3);
      const channelFrames = (direction: "fromBrowser" | "toNode" | "fromNode" | "toBrowser") =>
        counters.channels.reduce((sum, channel) => sum + channel[direction].frames, 0);
      expect(channelFrames("toNode")).toBe(counters.hubToNode.frames);
      expect(channelFrames("fromNode")).toBe(counters.nodeToHub.frames);
      for (const channel of counters.channels) {
        expect(channel.fromBrowser.frames).toBeGreaterThan(0);
        expect(channel.toNode.frames).toBeGreaterThan(0);
        expect(channel.fromNode.frames).toBeGreaterThan(0);
        expect(channel.toBrowser.frames).toBeGreaterThan(0);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "costs one more relay round trip for every further shell message",
    async () => {
      const hub = await createHarness({
        nodes: 1,
        hopDelayMs: HOP_DELAY_MS,
        threadsPerNode: 120,
        shellPageMaxBytes: 16 * 1_024,
      });

      const open = await hub.openNode(0);
      report(open);

      expect(open.shellPages).toBeGreaterThan(2);
      expect(open.shell.threadCount).toBe(120);
      expect(open.relayRoundTrips).toBe(COLD_OPEN_RELAY_ROUND_TRIPS + open.shellPages - 1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "puts the same frames on the wire whatever the hop delay",
    async () => {
      const instant = await createHarness({ nodes: 1, hopDelayMs: 0 });
      const withoutDelay = await instant.openNode(0);
      const framesWithoutDelay = frameCounts(instant);
      await instant.dispose();

      const delayed = await createHarness({ nodes: 1, hopDelayMs: 25 });
      const withDelay = await delayed.openNode(0);

      expect(withoutDelay.relayRoundTrips).toBeNull();
      expect(withoutDelay.shellAcceptedMs).toBe(0);
      expect(withDelay.shellAcceptedMs).toBe(COLD_OPEN_RELAY_ROUND_TRIPS * 4 * 25);
      expect(frameCounts(delayed)).toEqual(framesWithoutDelay);
      expect(withDelay.frames).toBe(withoutDelay.frames);
      expect(withDelay.shellPages).toBe(withoutDelay.shellPages);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "switching A→B→A reopens A (channel-level counts: the harness tears down the single-selection transport; the web runtime is not loaded)",
    async () => {
      const hub = await createHarness({ nodes: 2, hopDelayMs: HOP_DELAY_MS });

      const firstA = await hub.openNode(0);
      hub.reset();
      expect(hub.counters()).toMatchObject({
        total: { frames: 0, bytes: 0 },
        openNodeFrames: 0,
        channelsOpened: 0,
      });
      expect(hub.counters().channels).toHaveLength(1);
      const toB = await hub.switchTo(1);
      const secondA = await hub.switchTo(0);
      report(firstA);
      report(toB);
      report(secondA);

      // The harness closes A's session before it opens B, so nothing about A
      // survives the switch: the second visit is a full cold open on a new
      // stream and a new channel, with the teardown on top. This holds by the
      // harness's construction; it does not describe the web runtime's
      // selection logic.
      expect(secondA.frames).toBeGreaterThan(0);
      expect(secondA.traffic.openNodeFrames).toBe(1);
      expect(secondA.traffic.channelsOpened).toBe(1);
      expect(secondA.relayRoundTrips).toBe(firstA.relayRoundTrips);
      expect(secondA.frames).toBeGreaterThanOrEqual(firstA.frames);
      expect(secondA.trace.channelId).not.toBe(firstA.trace.channelId);
      expect(secondA.shell).toEqual(firstA.shell);
      expect(toB.shell.projectIds).toEqual(["project-node-1"]);
      expect(hub.counters().nodeErrors).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a relay drop costs exactly one replacement channel",
    async () => {
      const hub = await createHarness({ nodes: 1, hopDelayMs: HOP_DELAY_MS });
      const first = await hub.openNode(0);

      // The client logs the dropped subscription; the drop is the point here.
      const disconnectLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const replacement = await hub.dropChannel().finally(() => disconnectLog.mockRestore());
      report(replacement);

      // One stream, one channel and one shell for the one drop: the client
      // adopts the replacement instead of rebuilding itself, and the account
      // socket and its tickets stay out of it.
      expect(replacement.traffic.openNodeFrames).toBe(1);
      expect(replacement.traffic.channelsOpened).toBe(1);
      expect(replacement.relayRoundTrips).toBe(COLD_OPEN_RELAY_ROUND_TRIPS);
      expect(replacement.trace.channelId).not.toBe(first.trace.channelId);
      expect(replacement.shell).toEqual(first.shell);
      const counters = hub.counters();
      expect(counters.openNodeFrames).toBe(2);
      expect(counters.channelsOpened).toBe(2);
      expect(counters.accountSocketsOpened).toBe(0);
      expect(counters.ticketRequests).toBe(0);
      expect(counters.nodeErrors).toEqual([]);
      expect(counters.channels.filter((trace) => trace.closedAt === null)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "measures the same cost when the platform's inflation runs late",
    async () => {
      // The platform inflater finishes on a thread pool, after an arbitrary
      // amount of real time. The harness stands in for it, so even a very slow
      // one does not move a single virtual millisecond.
      const NativeDecompressionStream = globalThis.DecompressionStream;
      vi.stubGlobal(
        "DecompressionStream",
        class SlowDecompressionStream {
          readonly writable: WritableStream<Uint8Array<ArrayBuffer>>;
          readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
          constructor(format: ConstructorParameters<typeof NativeDecompressionStream>[0]) {
            const native = new NativeDecompressionStream(format);
            this.writable = native.writable;
            this.readable = native.readable.pipeThrough(
              new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
                transform: async (chunk, controller) => {
                  await new Promise((resolve) => setTimeout(resolve, 40));
                  controller.enqueue(chunk);
                },
              }),
            );
          }
        },
      );

      const hub = await createHarness({ nodes: 2, hopDelayMs: HOP_DELAY_MS });
      const opens = [await hub.openNode(0), await hub.switchTo(1)];

      for (const open of opens) {
        expect(open.relayRoundTrips).toBe(COLD_OPEN_RELAY_ROUND_TRIPS);
        expect(open.shellAcceptedMs).toBe(COLD_OPEN_RELAY_ROUND_TRIPS * 4 * HOP_DELAY_MS);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it("allows one harness at a time", async () => {
    const first = await createHarness({ nodes: 1 });
    await expect(createHostedMultiNodeHarness({ nodes: 1 })).rejects.toThrow(/already live/);

    // The refused attempt left the first one untouched, and a disposed one
    // makes room for the next.
    expect((await first.openNode(0)).e2ee).toBe("nx");
    await first.dispose();
    await (await createHarness({ nodes: 1 })).dispose();
  });

  it("wires only the NX handshake", async () => {
    await expect(
      createHostedMultiNodeHarness({ nodes: 1, e2ee: "legacy" as unknown as "nx" }),
    ).rejects.toThrow(/NX handshake/);
    // The refusal does not leave a harness behind.
    await (await createHarness({ nodes: 1 })).dispose();
  });
});
