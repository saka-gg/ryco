# Relay frame tunnel

A hosted client reaches a node only through its relay channel, so it cannot open the node's
device frame socket (`/ws/device-frames`). The relay frame tunnel carries that socket inside the
channel instead: the same binary H.264 envelopes node to client, the same live input text both
ways (`@ryco/shared/deviceLiveInput`), with no Hub change.

Reference implementation: `packages/shared/src/relayFrameTunnel.ts` (wire format),
`packages/client-runtime/src/relay/relayFrameTunnel.ts` and `relayEngine.ts`
(`bindFrameTunnel`), `packages/client-runtime/src/connection/hostedDeviceFrameSource.ts` (the
hosted `openFrameSource`), and `apps/server/src/hubConnector/relayFrameTunnelHost.ts` with
`relayFrameTunnelChannel.ts` (the node).

## Layering

Each tunnel message is the body of an ordinary RPC inner record on an `e2ee` channel
([relay E2EE protocol](./relay-e2ee-protocol.md) §3.4, `0x01`), exactly like a §4.6 compressed
frame. The Hub forwards ciphertext and sees only record lengths. A body starting `0xFE` is a
tunnel message: `0xFE` never begins UTF-8 JSON and differs from the compression magic `0xFF`.

Only `e2ee` channels carry it. A `legacy` channel is plaintext to the Hub and its post-strip
discrimination admits JSON alone, so a node hands `0xFE` bytes on a legacy channel to its parser as
before and a client never sends them there; hosted viewers on such a channel keep the screenshot
sampler.

## Negotiation

The client opens every stream, so a node only ever sends tunnel messages to a client that asked.
The client asks only a node whose `ThreadDeviceState.relayFrameTunnel` is at least the version it
speaks; an older node would hand the bytes to its JSON parser.

## Messages

| Offset | Bytes | Field                                       |
| ------ | ----- | ------------------------------------------- |
| 0      | 1     | magic `0xFE`                                |
| 1      | 1     | version `0x01`                              |
| 2      | 1     | kind                                        |
| 3      | 4     | stream id, big-endian, `1..2^32-1` (client) |
| 7      | rest  | body                                        |

| Kind | Name     | Direction      | Body                                                   |
| ---- | -------- | -------------- | ------------------------------------------------------ |
| 0x01 | `open`   | client to node | UTF-8 JSON `{"target":"device-frames","udid":"…"}`     |
| 0x02 | `close`  | both           | empty, or uint16 close code then a UTF-8 reason        |
| 0x03 | `text`   | both           | UTF-8 text: resync requests and live input             |
| 0x04 | `binary` | node to client | one device frame envelope (`@ryco/shared/deviceFrame`) |
| 0x05 | `ack`    | client to node | uint32 count of `binary` messages received, mod 2^32   |

A channel holds at most four streams. The node answers a refused open with `close` code 4400 and
an unavailable device with 4404. Messages for unknown stream ids are ignored on both sides; they
are a stream's last frames racing its close.

## Flow control

The Hub pauses a whole connection when its queue to the client passes its high-water mark and ends
a channel that keeps sending after a pause, so video must never fill that queue. The client
acknowledges every `binary` message as it arrives, before it decodes it. The node keeps at most
768 KiB unacknowledged per stream (`RELAY_FRAME_TUNNEL_WINDOW_BYTES`) and otherwise applies the
direct socket's policy (`deviceFrameTransport.ts`): a bounded queue, then dropping until the next
keyframe. A frame the encrypted send path refuses is dropped the same way, and the node asks the
encoder for a keyframe at most once a second. RPC responses share the channel, so at most one window
of video can sit ahead of them.

The relay also counts every byte a channel carries against a per-channel transfer budget
([capacity assessment](./relay-capacity-assessment-3b.md)) and ends an overspending channel with
`transfer_limit`, RPC included. Full-resolution video during a drag runs at several MB/s, so the
node spends at most 16 MiB of video per channel up front and then 768 KiB/s across the channel's
streams (`relayFrameTunnelHost.ts`). A frame over that budget is dropped like a refused one, and the
keyframe that resumes the stream is requested once the budget can carry one: a long drag lowers
the frame rate instead of closing the channel.

## Lifecycle

A stream belongs to its relay channel and ends with it. The client opens one only on the current
attempt's relay socket (never a replaced attempt or a direct route) and only while the
environment's session is adoptable: the generation is current and it accepted a current shell
snapshot (`hostedEnvironmentResumeReadiness`). When readiness ends the client closes the stream;
the frame source then retries with backoff and opens a new stream on whatever channel is current.
Whether the stream may drive the device is the node's decision, from the channel's effective role
(owner only, as for the input RPC), announced with `device.input.ready` like the direct socket.
