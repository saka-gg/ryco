import { describe, expect, it } from "vite-plus/test";

import { TRANSPORT_ERROR_PATTERNS } from "../errors/transportError.ts";
import { WS_CONNECTION_ERROR_MESSAGE } from "./protocol.ts";
import {
  isSubscriptionStreamDoneError,
  SUBSCRIPTION_STREAM_DONE_SCHEMA_ERROR_FRAGMENT,
  THREAD_NOT_FOUND_ERROR_RE,
} from "./wsTransport.ts";

describe("transport error string pins", () => {
  it("preserves the exact reconnect classification patterns", () => {
    expect(TRANSPORT_ERROR_PATTERNS.map((pattern) => pattern.source)).toEqual([
      "\\bSocketCloseError\\b",
      "\\bSocketOpenError\\b",
      "\\bSocketReadError\\b",
      "Unable to connect to the Ryco server WebSocket\\.",
      "\\bping timeout\\b",
    ]);
  });

  it("preserves the protocol, thread-not-found, and done-stream fragments", () => {
    expect(WS_CONNECTION_ERROR_MESSAGE).toBe("Unable to connect to the Ryco server WebSocket.");
    expect(THREAD_NOT_FOUND_ERROR_RE.source).toBe("^Thread\\s.+\\swas not found$");
    expect(SUBSCRIPTION_STREAM_DONE_SCHEMA_ERROR_FRAGMENT).toBe("SchemaError(Expected array");
    expect(
      isSubscriptionStreamDoneError(
        'SchemaError(Expected array {"_tag":"Done"} ~effect/Cause/Done',
      ),
    ).toBe(true);
  });
});
