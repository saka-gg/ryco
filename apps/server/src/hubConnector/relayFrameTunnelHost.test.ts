import { describe, expect, it } from "vitest";

import { decodeDeviceFrame } from "@ryco/shared/deviceFrame";
import { NODE_BROWSER_FRAME_ACK } from "@ryco/shared/nodeBrowserFrame";
import {
  RELAY_FRAME_TUNNEL_CLOSE,
  RELAY_FRAME_TUNNEL_DEVICE_FRAMES,
  RELAY_FRAME_TUNNEL_MAX_STREAMS,
  RELAY_FRAME_TUNNEL_NODE_BROWSER_FRAMES,
  RELAY_FRAME_TUNNEL_WINDOW_BYTES,
  decodeRelayFrameTunnelMessage,
  encodeRelayFrameTunnelAck,
  encodeRelayFrameTunnelClose,
  encodeRelayFrameTunnelOpen,
  encodeRelayFrameTunnelText,
  type RelayFrameTunnelMessage,
  type RelayFrameTunnelNodeBrowserTarget,
} from "@ryco/shared/relayFrameTunnel";
import { Effect, Exit, Fiber, Queue } from "effect";
import { Socket } from "effect/socket";

import type {
  DeviceKeyEvent,
  DeviceStreamFrame,
  DeviceTouchPhase,
} from "../device/DeviceBackend.ts";
import { DeviceFrameTransport, type DeviceFrameSink } from "../device/deviceFrameTransport.ts";
import type { DeviceFrameViewerTarget } from "../device/deviceFrameViewer.ts";
import {
  readViewerClient,
  serveViewerSocket,
  type ViewerOutput,
  type ViewerSocket,
} from "../nodeBrowser/nodeBrowserViewerSocket.ts";
import { relayRpcPrincipal } from "../ws/RpcPrincipal.ts";
import type { NodeE2eeEmitResult } from "./NodeE2eeChannelSession.ts";
import { relayFrameTunnelCanDrive } from "./relayFrameTunnelChannel.ts";
import {
  RELAY_FRAME_TUNNEL_BURST_BYTES,
  RELAY_FRAME_TUNNEL_KEYFRAME_REQUEST_MS,
  RELAY_FRAME_TUNNEL_RATE_BYTES_PER_SECOND,
  makeRelayFrameTunnelHost,
  type RelayFrameTunnelNodeBrowserFrames,
} from "./relayFrameTunnelHost.ts";

const UDID = "SIM-0001";

class FakeDevices implements DeviceFrameViewerTarget {
  readonly transport = new DeviceFrameTransport();
  keyframeRequests = 0;
  readonly touches: Array<{ phase: DeviceTouchPhase; x: number; y: number }> = [];
  readonly keys: DeviceKeyEvent[] = [];
  subscribeFrames(udid: string, sink: DeviceFrameSink): () => void {
    return this.transport.subscribe(udid, sink);
  }
  async requestKeyframe(): Promise<void> {
    this.keyframeRequests += 1;
  }
  async touch(_udid: string, phase: DeviceTouchPhase, x: number, y: number): Promise<void> {
    this.touches.push({ phase, x, y });
  }
  async keyEvent(_udid: string, event: DeviceKeyEvent): Promise<void> {
    this.keys.push(event);
  }
  async paste(): Promise<void> {}
  inputFence(): () => boolean {
    return () => true;
  }
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

let nextSequence = 0;
function frame(overrides: Partial<DeviceStreamFrame> & { size?: number } = {}): DeviceStreamFrame {
  nextSequence += 1;
  return {
    sequence: overrides.sequence ?? nextSequence,
    timestampMs: nextSequence,
    keyframe: overrides.keyframe ?? false,
    codecConfig: overrides.codecConfig ?? false,
    data: overrides.data ?? new Uint8Array(overrides.size ?? 16),
  };
}

function harness(
  options: {
    readonly canDrive?: boolean;
    readonly supported?: boolean;
    readonly nodeBrowserFrames?: RelayFrameTunnelNodeBrowserFrames;
  } = {},
) {
  const devices = new FakeDevices();
  const sent: RelayFrameTunnelMessage[] = [];
  let result: NodeE2eeEmitResult = "sent";
  let clock = 0;
  const timers: Array<{ at: number; task: () => void; cancelled: boolean }> = [];
  const host = makeRelayFrameTunnelHost({
    emit: async (bytes) => {
      const decoded = decodeRelayFrameTunnelMessage(bytes);
      if (decoded === null) throw new Error("the host emitted a malformed tunnel message");
      if (result === "sent") sent.push(decoded);
      return result;
    },
    canDrive: options.canDrive ?? true,
    devices: { supported: options.supported ?? true, manager: devices },
    ...(options.nodeBrowserFrames ? { nodeBrowserFrames: options.nodeBrowserFrames } : {}),
    now: () => clock,
    schedule: (task, delayMs) => {
      const timer = { at: clock + delayMs, task, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  return {
    host,
    devices,
    sent,
    setResult: (next: NodeE2eeEmitResult) => {
      result = next;
    },
    advance: (ms: number) => {
      clock += ms;
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) continue;
        if (timer.at <= clock) timer.task();
        else timers.push(timer);
      }
    },
    open: (streamId: number, udid = UDID) =>
      host.receive(
        encodeRelayFrameTunnelOpen(streamId, { target: RELAY_FRAME_TUNNEL_DEVICE_FRAMES, udid }),
      ),
    publish: (value: DeviceStreamFrame) => devices.transport.publish(UDID, value),
    ack: (streamId: number, received: number) =>
      host.receive(encodeRelayFrameTunnelAck(streamId, received)),
    binarySequences: (streamId: number) =>
      sent.flatMap((message) => {
        if (message.kind !== "binary" || message.streamId !== streamId) return [];
        const decoded = decodeDeviceFrame(message.bytes);
        return decoded.ok ? [decoded.frame.header.sequence] : [];
      }),
    texts: (streamId: number) =>
      sent.flatMap((message) =>
        message.kind === "text" && message.streamId === streamId
          ? [JSON.parse(message.text) as unknown]
          : [],
      ),
    closes: () =>
      sent.flatMap((message) =>
        message.kind === "close" ? [{ streamId: message.streamId, code: message.code }] : [],
      ),
  };
}

describe("relay frame tunnel host streams", () => {
  it("opens a viewer that announces input and wraps frames in binary messages", async () => {
    const tunnel = harness();
    tunnel.publish(frame({ sequence: 1, codecConfig: true }));
    tunnel.publish(frame({ sequence: 2, keyframe: true }));

    tunnel.open(7);
    await settle();
    tunnel.publish(frame({ sequence: 3 }));
    await settle();

    // Primed with the codec config and the last keyframe, like the direct socket.
    expect(tunnel.binarySequences(7)).toEqual([1, 2, 3]);
    expect(tunnel.texts(7)).toEqual([{ type: "device.input.ready", input: true }]);
    expect(tunnel.host.streamCount()).toBe(1);
  });

  it("tells a watch-only channel it may not drive and ignores its input", async () => {
    const tunnel = harness({ canDrive: false });
    tunnel.open(1);
    tunnel.host.receive(
      encodeRelayFrameTunnelText(
        1,
        JSON.stringify({ type: "device.touch", phase: "down", x: 1, y: 2 }),
      ),
    );
    await settle();

    expect(tunnel.texts(1)).toEqual([{ type: "device.input.ready", input: false }]);
    expect(tunnel.devices.touches).toEqual([]);
  });

  it("hands live input and resync requests to the device", async () => {
    const tunnel = harness();
    tunnel.open(1);
    tunnel.host.receive(
      encodeRelayFrameTunnelText(
        1,
        JSON.stringify({ type: "device.touch", phase: "down", x: 5, y: 6 }),
      ),
    );
    tunnel.host.receive(
      encodeRelayFrameTunnelText(1, JSON.stringify({ type: "device.frame.resync" })),
    );
    await settle();

    expect(tunnel.devices.touches).toEqual([{ phase: "down", x: 5, y: 6 }]);
    expect(tunnel.devices.keyframeRequests).toBe(1);
  });

  it("refuses streams beyond the limit and duplicate ids", async () => {
    const tunnel = harness();
    for (let id = 1; id <= RELAY_FRAME_TUNNEL_MAX_STREAMS; id += 1) tunnel.open(id);
    tunnel.open(99);
    await settle();
    expect(tunnel.closes()).toEqual([{ streamId: 99, code: RELAY_FRAME_TUNNEL_CLOSE.refused }]);
    expect(tunnel.host.streamCount()).toBe(RELAY_FRAME_TUNNEL_MAX_STREAMS);

    tunnel.open(2);
    await settle();
    // The one close names the id for both ends: the original stream is gone too.
    expect(tunnel.closes().at(-1)).toEqual({ streamId: 2, code: RELAY_FRAME_TUNNEL_CLOSE.refused });
    expect(tunnel.host.streamCount()).toBe(RELAY_FRAME_TUNNEL_MAX_STREAMS - 1);
  });

  it("answers unavailable where the node streams no devices", async () => {
    const tunnel = harness({ supported: false });
    tunnel.open(3);
    await settle();

    expect(tunnel.closes()).toEqual([{ streamId: 3, code: RELAY_FRAME_TUNNEL_CLOSE.unavailable }]);
    expect(tunnel.host.streamCount()).toBe(0);
  });

  it("ignores malformed messages and unknown stream ids", async () => {
    const tunnel = harness();
    tunnel.host.receive(new Uint8Array([0xfe, 0x01, 0x7f, 0, 0, 0, 1]));
    tunnel.host.receive(encodeRelayFrameTunnelText(42, "{}"));
    tunnel.ack(42, 3);
    tunnel.host.receive(encodeRelayFrameTunnelClose(42));
    await settle();

    expect(tunnel.sent).toEqual([]);
  });

  it("stops the frames when the client closes the stream", async () => {
    const tunnel = harness();
    tunnel.open(1);
    tunnel.publish(frame({ keyframe: true }));
    tunnel.host.receive(encodeRelayFrameTunnelClose(1));
    tunnel.publish(frame({ keyframe: true }));
    await settle();

    expect(tunnel.binarySequences(1)).toHaveLength(1);
    expect(tunnel.devices.transport.subscriberCount).toBe(0);
    expect(tunnel.host.streamCount()).toBe(0);
  });

  it("lifts a held finger and releases held keys when the channel ends", async () => {
    const tunnel = harness();
    tunnel.open(1);
    tunnel.host.receive(
      encodeRelayFrameTunnelText(
        1,
        JSON.stringify({ type: "device.touch", phase: "down", x: 9, y: 9 }),
      ),
    );
    tunnel.host.receive(
      encodeRelayFrameTunnelText(
        1,
        JSON.stringify({ type: "device.key", usage: 0x04, phase: "down" }),
      ),
    );
    await settle();

    tunnel.host.close();
    await settle();

    expect(tunnel.devices.touches.at(-1)?.phase).toBe("up");
    expect(tunnel.devices.keys.at(-1)).toMatchObject({ keyCode: 0x04, direction: "up" });
    expect(tunnel.devices.transport.subscriberCount).toBe(0);
    expect(tunnel.host.streamCount()).toBe(0);
  });
});

describe("relay frame tunnel host flow control", () => {
  const big = Math.floor(RELAY_FRAME_TUNNEL_WINDOW_BYTES / 2);

  it("holds frames past the window and sends them as acknowledgements arrive", async () => {
    const tunnel = harness();
    tunnel.open(1);
    tunnel.publish(frame({ sequence: 1, keyframe: true, size: big }));
    tunnel.publish(frame({ sequence: 2, size: big }));
    tunnel.publish(frame({ sequence: 3, size: big }));
    tunnel.publish(frame({ sequence: 4, size: 16 }));
    await settle();
    // The third would leave more than a window outstanding.
    expect(tunnel.binarySequences(1)).toEqual([1, 2]);

    // A still screen publishes nothing more: the acknowledgements alone drain,
    // each as far as the window it opens.
    tunnel.ack(1, 1);
    await settle();
    expect(tunnel.binarySequences(1)).toEqual([1, 2, 3]);
    tunnel.ack(1, 2);
    await settle();
    expect(tunnel.binarySequences(1)).toEqual([1, 2, 3, 4]);
  });

  it("drops to the next keyframe when the window stays shut", async () => {
    const tunnel = harness();
    tunnel.open(1);
    tunnel.publish(frame({ sequence: 1, keyframe: true, size: RELAY_FRAME_TUNNEL_WINDOW_BYTES }));
    for (let sequence = 2; sequence <= 20; sequence += 1) {
      tunnel.publish(frame({ sequence }));
    }
    await settle();
    expect(tunnel.binarySequences(1)).toEqual([1]);

    tunnel.ack(1, 1);
    tunnel.publish(frame({ sequence: 21 }));
    tunnel.publish(frame({ sequence: 22, keyframe: true }));
    tunnel.publish(frame({ sequence: 23 }));
    await settle();

    // Nothing between the overflow and the keyframe, then a clean resume.
    expect(tunnel.binarySequences(1)).toEqual([1, 22, 23]);
  });

  it("frees only what was sent for an acknowledgement that overshoots", async () => {
    const tunnel = harness();
    tunnel.open(1);
    tunnel.publish(frame({ sequence: 1, keyframe: true, size: RELAY_FRAME_TUNNEL_WINDOW_BYTES }));
    tunnel.ack(1, 1_000);
    tunnel.publish(frame({ sequence: 2, size: RELAY_FRAME_TUNNEL_WINDOW_BYTES }));
    tunnel.publish(frame({ sequence: 3 }));
    await settle();

    expect(tunnel.binarySequences(1)).toEqual([1, 2]);
  });

  it("resumes at a keyframe it asks for after the channel refuses a frame", async () => {
    const tunnel = harness();
    tunnel.open(1);
    tunnel.publish(frame({ sequence: 1, keyframe: true }));
    await settle();

    tunnel.setResult("backpressure");
    tunnel.publish(frame({ sequence: 2 }));
    await settle();
    tunnel.setResult("sent");
    tunnel.publish(frame({ sequence: 3 }));
    tunnel.publish(frame({ sequence: 4, codecConfig: true }));
    tunnel.publish(frame({ sequence: 5, keyframe: true }));
    tunnel.publish(frame({ sequence: 6 }));
    await settle();

    // 3 references the lost 2; codec config is never held back.
    expect(tunnel.binarySequences(1)).toEqual([1, 4, 5, 6]);
    expect(tunnel.devices.keyframeRequests).toBe(1);
  });

  it("asks for keyframes at most once a second", async () => {
    const tunnel = harness();
    tunnel.open(1);
    tunnel.setResult("too_large");
    tunnel.publish(frame({ sequence: 1, keyframe: true }));
    await settle();
    expect(tunnel.devices.keyframeRequests).toBe(1);

    tunnel.publish(frame({ sequence: 2, keyframe: true }));
    await settle();
    tunnel.publish(frame({ sequence: 3, keyframe: true }));
    await settle();
    expect(tunnel.devices.keyframeRequests).toBe(1);

    tunnel.advance(RELAY_FRAME_TUNNEL_KEYFRAME_REQUEST_MS);
    await settle();
    expect(tunnel.devices.keyframeRequests).toBe(2);
  });

  it("closes the stream silently when the channel can carry nothing more", async () => {
    const tunnel = harness();
    tunnel.open(1);
    await settle();
    tunnel.setResult("unavailable");
    tunnel.publish(frame({ keyframe: true }));
    await settle();

    expect(tunnel.host.streamCount()).toBe(0);
    expect(tunnel.devices.transport.subscriberCount).toBe(0);
    expect(tunnel.closes()).toEqual([]);
  });
});

describe("relay frame tunnel live input authority", () => {
  it("lets owner channels drive and others only watch", () => {
    expect(relayFrameTunnelCanDrive(relayRpcPrincipal("owner", "channel"))).toBe(true);
    expect(relayFrameTunnelCanDrive(relayRpcPrincipal("operator", "channel"))).toBe(false);
    expect(relayFrameTunnelCanDrive(relayRpcPrincipal("viewer", "channel"))).toBe(false);
  });
});

describe("relay frame tunnel host rate", () => {
  it("spends the burst, then drops to a keyframe it asks for once the budget can carry one", async () => {
    const tunnel = harness();
    tunnel.open(1);
    await settle();
    const size = 512 * 1_024;
    let sequence = 0;
    let received = 0;
    const send = (keyframe: boolean) => {
      sequence += 1;
      tunnel.publish(frame({ sequence, keyframe, codecConfig: sequence === 1, size }));
    };
    send(false); // codec config
    send(true);
    await settle();
    // Keep the ack window open so only the budget limits the stream.
    const burstFrames = Math.floor(RELAY_FRAME_TUNNEL_BURST_BYTES / size) + 4;
    for (let index = 0; index < burstFrames; index += 1) {
      send(false);
      await settle();
      received = tunnel.binarySequences(1).length;
      tunnel.ack(1, received);
      await settle();
    }
    const delivered = tunnel.binarySequences(1).length;
    expect(delivered).toBeLessThan(burstFrames + 2);
    expect(delivered * size).toBeLessThanOrEqual(RELAY_FRAME_TUNNEL_BURST_BYTES + 2 * size);
    // Over budget: the stream asked for a keyframe, and P-frames are dropped.
    expect(tunnel.devices.keyframeRequests).toBeGreaterThanOrEqual(1);
    send(false);
    await settle();
    expect(tunnel.binarySequences(1).length).toBe(delivered);

    // A keyframe the budget cannot carry yet is dropped too.
    send(true);
    await settle();
    expect(tunnel.binarySequences(1).length).toBe(delivered);
    tunnel.advance(
      Math.ceil((2 * size * 1_000) / RELAY_FRAME_TUNNEL_RATE_BYTES_PER_SECOND) +
        RELAY_FRAME_TUNNEL_KEYFRAME_REQUEST_MS,
    );

    // The budget refilled for one keyframe: the stream resumes with it.
    send(true);
    await settle();
    expect(tunnel.binarySequences(1).at(-1)).toBe(sequence);
  });
});

const HANDOFF_TAB = `handoff-${"ab".repeat(16)}`;

/** Node browser viewers the host handed out, with what became of them. */
function viewers(canView = true) {
  const served: Array<{
    tabId: string;
    target: RelayFrameTunnelNodeBrowserTarget;
    socket: ViewerSocket;
    cancelled: number;
  }> = [];
  const nodeBrowserFrames: RelayFrameTunnelNodeBrowserFrames = {
    canView,
    serve: (target, socket) => {
      const entry = { tabId: target.tabId, target, socket, cancelled: 0 };
      served.push(entry);
      return () => {
        entry.cancelled += 1;
      };
    },
  };
  return { served, nodeBrowserFrames };
}

function nodeBrowserHarness(canView = true) {
  const { served, nodeBrowserFrames } = viewers(canView);
  const tunnel = harness({ nodeBrowserFrames });
  return {
    ...tunnel,
    served,
    openTab: (streamId: number, tabId = HANDOFF_TAB) =>
      tunnel.host.receive(
        encodeRelayFrameTunnelOpen(streamId, {
          target: RELAY_FRAME_TUNNEL_NODE_BROWSER_FRAMES,
          tabId,
        }),
      ),
    socket: () => {
      const entry = served.at(-1);
      if (!entry) throw new Error("no viewer was served");
      return entry.socket;
    },
    binaries: (streamId: number) =>
      tunnel.sent.flatMap((message) =>
        message.kind === "binary" && message.streamId === streamId ? [message.bytes] : [],
      ),
    clientText: (streamId: number, text: string) =>
      tunnel.host.receive(encodeRelayFrameTunnelText(streamId, text)),
  };
}

/** Lets the viewer's fibers run, which take more than microtasks. */
const flush = async () => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
  }
};

const track = <A, E>(effect: Effect.Effect<A, E>) => {
  const state: { exit: Exit.Exit<A, E> | null } = { exit: null };
  void Effect.runPromiseExit(effect).then((exit) => {
    state.exit = exit;
  });
  return state;
};

describe("relay frame tunnel host node browser streams", () => {
  it("answers unavailable where the node serves no handed-off tabs", async () => {
    const tunnel = harness();
    tunnel.host.receive(
      encodeRelayFrameTunnelOpen(3, {
        target: RELAY_FRAME_TUNNEL_NODE_BROWSER_FRAMES,
        tabId: HANDOFF_TAB,
      }),
    );
    await settle();

    expect(tunnel.closes()).toEqual([{ streamId: 3, code: RELAY_FRAME_TUNNEL_CLOSE.unavailable }]);
    expect(tunnel.host.streamCount()).toBe(0);
  });

  it("refuses a channel that is not the owner's", async () => {
    const tunnel = nodeBrowserHarness(false);
    tunnel.openTab(1);
    await settle();

    expect(tunnel.closes()).toEqual([{ streamId: 1, code: RELAY_FRAME_TUNNEL_CLOSE.forbidden }]);
    expect(tunnel.served).toEqual([]);
    expect(tunnel.host.streamCount()).toBe(0);
  });

  it("sends the viewer's frames and hands it the client's acks", async () => {
    const tunnel = nodeBrowserHarness();
    tunnel.openTab(4);
    expect(tunnel.served.map((entry) => entry.tabId)).toEqual([HANDOFF_TAB]);
    const socket = tunnel.socket();

    await Effect.runPromise(socket.write(Uint8Array.of(1, 2, 3)));
    await settle();
    expect(tunnel.binaries(4).map((bytes) => [...bytes])).toEqual([[1, 2, 3]]);
    expect(socket.bufferedBytes()).toBeGreaterThan(0);

    const pulled = track(socket.pull);
    await settle();
    expect(pulled.exit).toBeNull();
    tunnel.ack(4, 1);
    tunnel.clientText(4, NODE_BROWSER_FRAME_ACK);
    await settle();
    expect(pulled.exit).toEqual(Exit.succeed([NODE_BROWSER_FRAME_ACK]));
    expect(socket.bufferedBytes()).toBe(0);
  });

  it("shares the stream limit with device streams", async () => {
    const tunnel = nodeBrowserHarness();
    for (let id = 1; id < RELAY_FRAME_TUNNEL_MAX_STREAMS; id += 1) tunnel.open(id);
    tunnel.openTab(10);
    tunnel.openTab(11);
    await settle();

    expect(tunnel.served).toHaveLength(1);
    expect(tunnel.closes()).toEqual([{ streamId: 11, code: RELAY_FRAME_TUNNEL_CLOSE.refused }]);
  });

  it("waits for the channel's budget instead of dropping a frame", async () => {
    const tunnel = nodeBrowserHarness();
    tunnel.openTab(1);
    const socket = tunnel.socket();
    // The whole burst in one frame; an empty window takes it.
    await Effect.runPromise(socket.write(new Uint8Array(RELAY_FRAME_TUNNEL_BURST_BYTES)));
    await settle();
    expect(tunnel.binaries(1)).toHaveLength(1);
    tunnel.ack(1, 1);

    const size = 512 * 1_024;
    const write = track(socket.write(new Uint8Array(size)));
    await settle();
    expect(write.exit).toBeNull();
    expect(tunnel.binaries(1)).toHaveLength(1);
    expect(socket.bufferedBytes()).toBeGreaterThanOrEqual(size);

    tunnel.advance(Math.ceil(((size + 64) * 1_000) / RELAY_FRAME_TUNNEL_RATE_BYTES_PER_SECOND));
    await settle();
    expect(write.exit).toEqual(Exit.void);
    expect(tunnel.binaries(1).map((bytes) => bytes.byteLength)).toEqual([
      RELAY_FRAME_TUNNEL_BURST_BYTES,
      size,
    ]);
  });

  it("holds a frame past the window until an acknowledgement opens it", async () => {
    const tunnel = nodeBrowserHarness();
    tunnel.openTab(1);
    const socket = tunnel.socket();
    const half = Math.floor(RELAY_FRAME_TUNNEL_WINDOW_BYTES / 2) + 1;
    await Effect.runPromise(socket.write(new Uint8Array(half)));
    const second = track(socket.write(new Uint8Array(half)));
    await settle();
    expect(second.exit).toBeNull();
    expect(tunnel.binaries(1)).toHaveLength(1);

    tunnel.ack(1, 1);
    await settle();
    expect(second.exit).toEqual(Exit.void);
    expect(tunnel.binaries(1)).toHaveLength(2);
  });

  it("acknowledges a frame the channel refused on the client's behalf", async () => {
    const tunnel = nodeBrowserHarness();
    tunnel.openTab(1);
    const socket = tunnel.socket();
    const pulled = track(socket.pull);
    tunnel.setResult("backpressure");
    await Effect.runPromise(socket.write(Uint8Array.of(9)));
    await settle();

    expect(pulled.exit).toEqual(Exit.succeed([NODE_BROWSER_FRAME_ACK]));
    expect(socket.bufferedBytes()).toBe(0);
    expect(tunnel.host.streamCount()).toBe(1);
  });

  it("ends the viewer when the client closes the stream", async () => {
    const tunnel = nodeBrowserHarness();
    tunnel.openTab(1);
    const socket = tunnel.socket();
    const pulled = track(socket.pull);
    tunnel.host.receive(encodeRelayFrameTunnelClose(1));
    await settle();

    expect(pulled.exit !== null && Exit.isFailure(pulled.exit)).toBe(true);
    const again = await Effect.runPromiseExit(socket.pull);
    expect(Exit.isFailure(again)).toBe(true);
    expect(tunnel.served[0]?.cancelled).toBe(1);
    expect(tunnel.host.streamCount()).toBe(0);
    // Nothing goes out for a stream the client closed.
    expect(Exit.isFailure(await Effect.runPromiseExit(socket.write(Uint8Array.of(1))))).toBe(true);
    expect(tunnel.binaries(1)).toEqual([]);
  });

  it("ends every viewer, and a write waiting for budget, when the channel ends", async () => {
    const tunnel = nodeBrowserHarness();
    tunnel.openTab(1);
    tunnel.openTab(2);
    const [first, second] = tunnel.served;
    await Effect.runPromise(first!.socket.write(new Uint8Array(RELAY_FRAME_TUNNEL_BURST_BYTES)));
    tunnel.ack(1, 1);
    const waiting = track(first!.socket.write(new Uint8Array(1_024)));
    const pulled = track(second!.socket.pull);
    await settle();
    expect(waiting.exit).toBeNull();

    tunnel.host.close();
    await settle();

    expect(waiting.exit !== null && Exit.isFailure(waiting.exit)).toBe(true);
    expect(pulled.exit !== null && Exit.isFailure(pulled.exit)).toBe(true);
    expect(tunnel.served.map((entry) => entry.cancelled)).toEqual([1, 1]);
    expect(tunnel.host.streamCount()).toBe(0);
  });

  it("passes the viewer's close to the client and ends the stream", async () => {
    const tunnel = nodeBrowserHarness();
    tunnel.openTab(6);
    await Effect.runPromise(tunnel.socket().write(new Socket.CloseEvent(4404, "tab gone")));
    await settle();

    expect(tunnel.closes()).toEqual([{ streamId: 6, code: 4404 }]);
    expect(tunnel.served[0]?.cancelled).toBe(1);
    expect(tunnel.host.streamCount()).toBe(0);
  });

  it("tells the client when the viewer cuts a stream that fell behind", async () => {
    const tunnel = nodeBrowserHarness();
    tunnel.openTab(2);
    await Effect.runPromise(tunnel.socket().cut);
    await settle();

    expect(tunnel.closes()).toEqual([{ streamId: 2, code: RELAY_FRAME_TUNNEL_CLOSE.normal }]);
    expect(tunnel.host.streamCount()).toBe(0);
  });

  it("closes silently when the channel can carry nothing more", async () => {
    const tunnel = nodeBrowserHarness();
    tunnel.openTab(1);
    tunnel.setResult("unavailable");
    await Effect.runPromise(tunnel.socket().write(Uint8Array.of(1)));
    await settle();

    expect(tunnel.host.streamCount()).toBe(0);
    expect(tunnel.served[0]?.cancelled).toBe(1);
    expect(tunnel.closes()).toEqual([]);
  });

  it("cancels a viewer that ended the stream before serve returned", async () => {
    const cancels: number[] = [];
    const tunnel = harness({
      nodeBrowserFrames: {
        canView: true,
        serve: (_tabId, socket) => {
          Effect.runSync(socket.write(new Socket.CloseEvent(4503, "unavailable")));
          return () => cancels.push(1);
        },
      },
    });
    tunnel.host.receive(
      encodeRelayFrameTunnelOpen(1, {
        target: RELAY_FRAME_TUNNEL_NODE_BROWSER_FRAMES,
        tabId: HANDOFF_TAB,
      }),
    );
    await settle();

    expect(cancels).toEqual([1]);
    expect(tunnel.closes()).toEqual([{ streamId: 1, code: 4503 }]);
    expect(tunnel.host.streamCount()).toBe(0);
  });

  it("keeps the real viewer going frame by frame, through a refused frame too", async () => {
    const tunnel = nodeBrowserHarness();
    tunnel.openTab(1);
    const socket = tunnel.socket();
    const released: number[] = [];
    const output = Effect.runSync(Queue.unbounded<ViewerOutput>());
    const frameOut = (seq: number): ViewerOutput => ({
      _tag: "frame",
      data: Uint8Array.of(seq),
      ack: Effect.sync(() => released.push(seq)),
    });
    const viewer = Effect.runFork(
      Effect.scoped(
        Effect.flatMap(readViewerClient(socket.pull), (client) =>
          serveViewerSocket(socket, client, output),
        ),
      ),
    );
    const sentSeqs = () => tunnel.binaries(1).map((bytes) => bytes[0]);

    Queue.offerUnsafe(output, frameOut(1));
    Queue.offerUnsafe(output, frameOut(2));
    await flush();
    // One frame out until the client acknowledges it.
    expect(sentSeqs()).toEqual([1]);
    tunnel.ack(1, 1);
    tunnel.clientText(1, NODE_BROWSER_FRAME_ACK);
    await flush();
    expect(sentSeqs()).toEqual([1, 2]);
    expect(released).toContain(1);

    // The channel refuses 3: the host answers for the client, so 4 follows.
    tunnel.ack(1, 2);
    tunnel.clientText(1, NODE_BROWSER_FRAME_ACK);
    tunnel.setResult("backpressure");
    Queue.offerUnsafe(output, frameOut(3));
    await flush();
    tunnel.setResult("sent");
    Queue.offerUnsafe(output, frameOut(4));
    await flush();
    expect(sentSeqs()).toEqual([1, 2, 4]);
    expect(released).toEqual(expect.arrayContaining([1, 2, 3]));

    tunnel.host.receive(encodeRelayFrameTunnelClose(1));
    await flush();
    // The viewer notices the client left and ends.
    await Effect.runPromise(Fiber.await(viewer));
    expect(tunnel.served[0]?.cancelled).toBe(1);
  });
});
