import { ORCHESTRATION_WS_METHODS, WsRpcGroup } from "@ryco/contracts";
import { decodeDeviceFrame } from "@ryco/shared/deviceFrame";
import { E2EE_INNER_TYPE_RPC } from "@ryco/shared/relayE2eeWire";
import {
  RELAY_FRAME_TUNNEL_DEVICE_FRAMES,
  decodeRelayFrameTunnelMessage,
  encodeRelayFrameTunnelOpen,
  type RelayFrameTunnelMessage,
} from "@ryco/shared/relayFrameTunnel";
import { RelayMessageAssembler } from "@ryco/shared/relayMessageChunks";
import { Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DeviceKeyEvent, DeviceTouchPhase } from "../device/DeviceBackend.ts";
import { DeviceFrameTransport, type DeviceFrameSink } from "../device/deviceFrameTransport.ts";
import type { DeviceFrameViewerTarget } from "../device/deviceFrameViewer.ts";
import {
  makeRpcByteSession,
  type RpcInboundDisposition,
  type RpcInboundInterceptor,
} from "../ws/RpcByteSession.ts";
import { nodeE2eeRpcInterceptor, nodeE2eeRpcSink } from "./NodeE2eeRelayChannel.ts";
import {
  makeLazyRelayFrameTunnel,
  withRelayFrameTunnel,
  type RelayFrameTunnelEndpoint,
} from "./relayFrameTunnelChannel.ts";
import { makeRelayFrameTunnelHost } from "./relayFrameTunnelHost.ts";
import { clientSend, establish, harness } from "./testUtils/nodeE2eeChannelHarness.ts";

const UDID = "SIM-0001";
const tunnelOpen = encodeRelayFrameTunnelOpen(1, {
  target: RELAY_FRAME_TUNNEL_DEVICE_FRAMES,
  udid: UDID,
});
const json = new TextEncoder().encode(JSON.stringify({ _tag: "Ping" }));

function recordingTunnel() {
  const received: Uint8Array[] = [];
  let closes = 0;
  const tunnel: RelayFrameTunnelEndpoint = {
    receive: (message) => received.push(message),
    close: () => {
      closes += 1;
    },
  };
  return { tunnel, received, closes: () => closes };
}

const passThrough: RpcInboundInterceptor = (message) => Effect.succeed({ kind: "rpc", message });

const run = (interceptor: RpcInboundInterceptor, message: Uint8Array) =>
  Effect.runPromise(interceptor(message)) as Promise<RpcInboundDisposition>;

describe("relay frame tunnel interceptor", () => {
  it("claims a tunnel message on an end-to-end encrypted channel", async () => {
    const { tunnel, received } = recordingTunnel();
    const interceptor = withRelayFrameTunnel(passThrough, {
      endToEndEncrypted: () => true,
      tunnel,
    });

    expect(await run(interceptor, tunnelOpen)).toEqual({ kind: "claimed" });
    expect(received).toEqual([tunnelOpen]);
  });

  it("leaves the same bytes to the parser on a legacy channel", async () => {
    const { tunnel, received } = recordingTunnel();
    const interceptor = withRelayFrameTunnel(passThrough, {
      endToEndEncrypted: () => false,
      tunnel,
    });

    expect(await run(interceptor, tunnelOpen)).toEqual({ kind: "rpc", message: tunnelOpen });
    expect(received).toEqual([]);
  });

  it("passes JSON RPC and the inner interceptor's own claims through", async () => {
    const { tunnel, received } = recordingTunnel();
    const claiming: RpcInboundInterceptor = () => Effect.succeed({ kind: "claimed" });
    const encrypted = { endToEndEncrypted: () => true, tunnel };

    expect(await run(withRelayFrameTunnel(passThrough, encrypted), json)).toEqual({
      kind: "rpc",
      message: json,
    });
    expect(await run(withRelayFrameTunnel(claiming, encrypted), tunnelOpen)).toEqual({
      kind: "claimed",
    });
    expect(received).toEqual([]);
  });
});

describe("lazily loaded relay frame tunnel", () => {
  it("loads once and delivers what arrived meanwhile, in order", async () => {
    const { tunnel, received } = recordingTunnel();
    let release = (_value: RelayFrameTunnelEndpoint) => {};
    let loads = 0;
    const lazy = makeLazyRelayFrameTunnel(() => {
      loads += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const first = new Uint8Array([0xfe, 1]);
    const second = new Uint8Array([0xfe, 2]);
    lazy.receive(first);
    lazy.receive(second);
    expect(lazy.loaded()).toBe(false);

    release(tunnel);
    await vi.waitFor(() => expect(lazy.loaded()).toBe(true));
    const third = new Uint8Array([0xfe, 3]);
    lazy.receive(third);

    expect(loads).toBe(1);
    expect(received).toEqual([first, second, third]);
  });

  it("closes a host that finished loading after the channel ended", async () => {
    const { tunnel, received, closes } = recordingTunnel();
    let release = (_value: RelayFrameTunnelEndpoint) => {};
    const lazy = makeLazyRelayFrameTunnel(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    lazy.receive(tunnelOpen);
    lazy.close();
    release(tunnel);

    await vi.waitFor(() => expect(closes()).toBe(1));
    expect(received).toEqual([]);
  });

  it("tries again after a failed load", async () => {
    const { tunnel, received } = recordingTunnel();
    const errors: unknown[] = [];
    let loads = 0;
    const lazy = makeLazyRelayFrameTunnel(
      async () => {
        loads += 1;
        if (loads === 1) throw new Error("chunk missing");
        return tunnel;
      },
      { onError: (error) => errors.push(error) },
    );
    lazy.receive(new Uint8Array([0xfe, 1]));
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    const retry = new Uint8Array([0xfe, 2]);
    lazy.receive(retry);
    await vi.waitFor(() => expect(lazy.loaded()).toBe(true));

    expect(received).toEqual([retry]);
  });
});

class StillDevice implements DeviceFrameViewerTarget {
  readonly transport = new DeviceFrameTransport();
  subscribeFrames(udid: string, sink: DeviceFrameSink): () => void {
    return this.transport.subscribe(udid, sink);
  }
  async requestKeyframe(): Promise<void> {}
  async touch(_udid: string, _phase: DeviceTouchPhase): Promise<void> {}
  async keyEvent(_udid: string, _event: DeviceKeyEvent): Promise<void> {}
  async paste(): Promise<void> {}
  inputFence(): () => boolean {
    return () => true;
  }
}

describe("relay frame tunnel on a real E2EE channel", () => {
  it("opens a stream and delivers a frame inside encrypted records", async () => {
    const device = new StillDevice();
    // A keyframe from before the stream opened primes it, like a late pane.
    device.transport.publish(UDID, {
      sequence: 41,
      timestampMs: 1,
      keyframe: true,
      codecConfig: false,
      data: new Uint8Array([9, 9, 9]),
    });
    let host: ReturnType<typeof makeRelayFrameTunnelHost> | undefined;
    let parsed = 0;
    const node = await harness({
      rpc: async (e2ee) => {
        const scope = await Effect.runPromise(Scope.make("sequential"));
        host = makeRelayFrameTunnelHost({
          emit: (bytes) => e2ee.emit(bytes),
          canDrive: true,
          devices: { supported: true, manager: device },
        });
        const interceptor = withRelayFrameTunnel(nodeE2eeRpcInterceptor(e2ee), {
          endToEndEncrypted: () => e2ee.mode() === "e2ee",
          tunnel: host,
        });
        // The byte session consumes on its own fiber; `receive` resolves once
        // the payload it accepted has been through the interceptor.
        let accepted = 0;
        let intercepted = 0;
        const session = await Effect.runPromise(
          makeRpcByteSession(
            WsRpcGroup,
            WsRpcGroup.toLayer(
              Effect.succeed(
                WsRpcGroup.of({
                  [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.empty,
                } as never),
              ),
            ),
            nodeE2eeRpcSink(e2ee),
            {
              queueCapacity: 64,
              interceptor: (message) =>
                interceptor(message).pipe(
                  Effect.tap((disposition) =>
                    Effect.sync(() => {
                      if (disposition.kind === "rpc") parsed += 1;
                    }),
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      intercepted += 1;
                    }),
                  ),
                ),
              onOutputFailure: () => e2ee.abandon(),
            },
          ).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        return {
          session: {
            receive: async (bytes) => {
              const ok = await Effect.runPromise(session.receive(bytes));
              if (ok) accepted += 1;
              for (let turn = 0; turn < 200 && intercepted < accepted; turn += 1) {
                await new Promise((resolve) => setTimeout(resolve, 0));
              }
              return ok;
            },
            queuedBytes: () => Effect.runPromise(session.queuedBytes),
            supportsChunkedMessages: session.supportsChunkedMessages,
            incompleteReassembly: session.incompleteReassembly,
          },
          release: async () => {
            host?.close();
            await Effect.runPromise(Scope.close(scope, Exit.void));
          },
        };
      },
    });
    const advertisement = await node.open();
    const client = await establish(node, "web", advertisement);
    const cursor = node.dataPayloads().length;

    await clientSend(node, client, E2EE_INNER_TYPE_RPC, tunnelOpen);

    const assembler = new RelayMessageAssembler();
    const messages: RelayFrameTunnelMessage[] = [];
    let read = cursor;
    await vi.waitFor(
      () => {
        node.flush();
        for (const payload of node.dataPayloads().slice(read)) {
          read += 1;
          const assembled = assembler.push(payload);
          if (assembled.kind === "error") throw new Error(assembled.reason);
          if (assembled.kind === "pending") continue;
          const opened = client.record.unprotect(assembled.message);
          if (opened.kind !== "authenticated") throw new Error(JSON.stringify(opened));
          const message = decodeRelayFrameTunnelMessage(opened.body);
          if (message) messages.push(message);
        }
        expect(messages.map((message) => message.kind)).toEqual(["binary", "text"]);
      },
      { timeout: 5_000 },
    );

    const binary = messages[0];
    if (binary?.kind !== "binary") throw new Error("expected a binary message first");
    const decoded = decodeDeviceFrame(binary.bytes);
    expect(decoded.ok && decoded.frame.header.sequence).toBe(41);
    expect(binary.streamId).toBe(1);
    // The open never reached the JSON parser, and the channel stayed up.
    expect(parsed).toBe(0);
    expect(node.closeReasons()).toEqual([]);
    expect(host?.streamCount()).toBe(1);

    await node.closeFromPeer();
    expect(host?.streamCount()).toBe(0);
    expect(device.transport.subscriberCount).toBe(0);
  });
});
